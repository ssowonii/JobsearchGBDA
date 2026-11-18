"""Crawl orchestration for serverless: a full refresh is a `crawl_runs` row with a queue of
company keys, worked off in short steps (each well under Vercel's function time limit).
Steps are driven by the open browser tab (POST /api/crawl/step in a loop) and by the daily
Vercel Cron, which chains itself until the queue is empty."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Callable
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from . import rag, store
from .dedupe import merged_state, plan_merges
from .companies import company_key
from .http_client import request
from .jsre import rx
from .normalize import decode_entities, html_to_text, is_student_role, normalize_job
from .sources import extract_json_ld_jobs, fetch_company_jobs
from .store import AsyncConn

TZ = ZoneInfo("America/Toronto")
COMPANY_TIMEOUT_S = 150   # one company's board (Workday boards are the slow ones)
STEP_BUDGET_S = 90        # don't start a new batch after this much time in a step
LEASE_S = 290             # a step holds the run for at most this long


class RunLog:
    def __init__(self, lines: list[str] | None = None):
        self.lines = list(lines or [])

    def __call__(self, msg: str) -> None:
        t = datetime.now(TZ)
        stamp = f"{(t.hour % 12) or 12}:{t.minute:02d}:{t.second:02d} {'AM' if t.hour < 12 else 'PM'}"
        self.lines.append(f"{stamp}  {msg}")
        if len(self.lines) > 400:
            self.lines.pop(0)
        # Console output is best-effort: a non-UTF-8 or detached stdout must never fail a crawl.
        try:
            print(msg, flush=True)
        except Exception:  # noqa: BLE001
            try:
                print(msg.encode("ascii", "replace").decode(), flush=True)
            except Exception:  # noqa: BLE001
                pass


# Dream companies list every opening on their board (engineering, payroll, …). Keep only postings
# that semantically fit the resume: Match % (resume vs. posting embeddings) of at least
# DREAM_MIN_MATCH, or a focus-area posting (marketing / content / UX) of at least DREAM_MIN_MATCH_FOCUS.
DREAM_MIN_MATCH = 40
DREAM_MIN_MATCH_FOCUS = 25


async def prune_irrelevant_dream(conn: AsyncConn, log: Callable[[str], None]) -> set[str]:
    """Delete dream-company postings that don't fit the resume or are outside Canada.
    Jobs you're tracking (any status) and manually added postings are never removed."""
    rows = await (await conn.execute(
        """DELETE FROM jobs
           WHERE dream AND NOT manual AND coalesce(app->>'status', 'none') = 'none'
             AND (
               coalesce(data->'location'->>'nonCanadaOnly', 'false') = 'true'
               OR (match IS NOT NULL AND match < %s
                   AND NOT (jsonb_array_length(coalesce(data->'categories', '[]'::jsonb)) > 0 AND match >= %s))
             )
           RETURNING id""",
        (DREAM_MIN_MATCH, DREAM_MIN_MATCH_FOCUS),
    )).fetchall()
    removed = {r["id"] for r in rows}
    if removed:
        log(f"Filtered out {len(removed)} dream-company posting(s) that don't fit the resume or are outside Canada.")
    return removed


async def merge_duplicates(conn: AsyncConn, log: Callable[[str], None]) -> dict[str, str]:
    """Fold the same role found on several sites into one posting. Returns {removed id: id it merged into}."""
    jobs = await store.list_jobs_any_review(conn)
    moved: dict[str, str] = {}
    for keep, dups in plan_merges(jobs):
        st = merged_state(keep, dups)
        await conn.execute(
            "UPDATE jobs SET app = %s, review = %s, dream = %s, manual = %s, active = %s WHERE id = %s",
            (Jsonb(st["app"]), st["review"], st["dream"], st["manual"], st["active"], keep["id"]),
        )
        ids = [d["id"] for d in dups]
        await conn.execute("DELETE FROM jobs WHERE id = ANY(%s)", (ids,))
        moved.update({i: keep["id"] for i in ids})
    if moved:
        log(f"Merged {len(moved)} duplicate posting(s) found on more than one site.")
    return moved


async def finalize(conn: AsyncConn, log: Callable[[str], None], merged: dict[str, str] | None = None) -> set[str]:
    """Embed, score, merge cross-site duplicates, then drop non-student and irrelevant dream-company postings.
    Returns the ids removed; `merged` (if given) collects {duplicate id: the posting it was merged into}."""
    try:
        await rag.ensure_embeddings(conn, log)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ Embeddings failed, keyword search still works: {e}")
    try:
        await rag.refresh_match_scores(conn)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ Match scoring: {e}")
        return set()
    removed: set[str] = set()
    try:
        moved = await merge_duplicates(conn, log)
        if merged is not None:
            merged.update(moved)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ Duplicate merge: {e}")
    try:
        removed |= await prune_non_student(conn, log)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ Student filter: {e}")
    try:
        removed |= await prune_irrelevant_dream(conn, log)
    except Exception as e:  # noqa: BLE001
        log(f"⚠ Relevance filter: {e}")
    return removed


_TERM_END_MONTH = {"winter": 4, "spring": 6, "summer": 8, "fall": 12, "autumn": 12}


def past_terms_only(terms, today: datetime | None = None) -> bool:
    """Every term the posting names has already ended (e.g. a leftover "Summer 2026" co-op)."""
    now = today or datetime.now()
    ends = []
    for t in terms or []:
        parts = str(t).split()
        if len(parts) != 2 or parts[0].lower() not in _TERM_END_MONTH or not parts[1].isdigit():
            return False  # unknown format: keep the posting
        ends.append((int(parts[1]), _TERM_END_MONTH[parts[0].lower()]))
    return bool(ends) and max(ends) < (now.year, now.month)


async def prune_non_student(conn: AsyncConn, log: Callable[[str], None]) -> set[str]:
    """The hub is student-only: delete postings that aren't intern / co-op / student roles.
    Jobs you're tracking (any status) and postings you added by hand are kept."""
    # Re-check titles with the current rule; the stored flag may predate it.
    cands = await (await conn.execute(
        """SELECT id, title, data->>'employmentType' AS et, data->'term'->'terms' AS terms FROM jobs
           WHERE NOT manual AND coalesce(app->>'status', 'none') = 'none'""",
    )).fetchall()
    drop = [r["id"] for r in cands if not is_student_role(r["title"], [r["et"]]) or past_terms_only(r["terms"])]
    removed: set[str] = set()
    if drop:
        rows = await (await conn.execute("DELETE FROM jobs WHERE id = ANY(%s) RETURNING id", (drop,))).fetchall()
        removed = {r["id"] for r in rows}
    if removed:
        log(f"Removed {len(removed)} posting(s) that aren't student roles or are for a past term.")
    return removed


async def crawl_one(conn: AsyncConn, c: dict, opts: dict, log: Callable[[str], None]) -> tuple[int, list[str]]:
    raws = await fetch_company_jobs(c, {**opts, "log": log})
    seen: list[str] = []
    for r in raws:
        j = normalize_job(r)
        if opts.get("studentOnly") is not False and not j["student"]:
            continue
        if past_terms_only(j["term"]["terms"]):
            continue
        if not opts.get("keepNonCanada") and j["location"]["nonCanadaOnly"]:
            continue
        if opts.get("dream"):
            j["dream"] = True
        if opts.get("dream") or c.get("dream"):
            j["review"] = "pending"  # dream-company roles wait until you pick them (already-added ones stay added)
        await store.upsert_job(conn, j)
        if j["id"] not in seen:
            seen.append(j["id"])
    if not opts.get("noPrune"):
        await store.mark_inactive(conn, company_key(c), set(seen))
    return len(seen), seen


# ---------- full crawl ----------
async def start_crawl(conn: AsyncConn) -> dict:
    """Start a full refresh, or return the one already in progress."""
    run = await store.active_crawl(conn)
    if run:
        return run
    companies = await store.list_companies(conn)
    # Workday boards are slow; queue them last so each batch can pair one with fast boards.
    keys = [company_key(c) for c in companies if c["ats"] != "workday"] + [company_key(c) for c in companies if c["ats"] == "workday"]
    run = await store.create_run(conn, "crawl", "Refreshing all companies", keys)
    log = RunLog()
    log(f"Crawling {len(keys)} company job boards for student roles…")
    return await store.save_run(conn, run["id"], queue=keys, log=log.lines)


def _next_batch(queue: list[str]) -> list[str]:
    """Up to 5 fast boards plus at most one Workday board."""
    fast = [k for k in queue if not k.startswith("workday:")][:5]
    wd = [k for k in queue if k.startswith("workday:")][:1]
    return fast + wd


async def _crawl_company(conn: AsyncConn, key: str, log: RunLog) -> int:
    c = await store.get_company(conn, key)
    if not c:
        return 0
    try:
        kept, _ = await asyncio.wait_for(
            crawl_one(conn, c, {"studentOnly": True, "keepNonCanada": False, "noPrune": bool(c.get("dream"))}, log),
            COMPANY_TIMEOUT_S,
        )
        log(f"✓ {c['name']}: {kept} student role(s) in Canada")
        await store.mark_company_crawled(conn, key, None)
        return kept
    except Exception as e:  # noqa: BLE001
        msg = "timed out" if isinstance(e, asyncio.TimeoutError) else str(e)
        log(f"✗ {c['name']}: {msg}")
        await store.mark_company_crawled(conn, key, msg)
        return 0


async def crawl_step(conn: AsyncConn, run_id: int, budget_s: float = STEP_BUDGET_S) -> dict:
    """Work off part of a crawl's queue. Returns the run (busy=True if another step holds it)."""
    run = await store.lease_run(conn, run_id, LEASE_S)
    if not run:
        cur = await (await conn.execute("SELECT * FROM crawl_runs WHERE id = %s", (run_id,))).fetchone()
        return {**(cur or {}), "busy": True}
    log = RunLog(run["log"])
    queue: list[str] = list(run["queue"] or [])
    found = 0
    t0 = time.monotonic()
    try:
        while queue and time.monotonic() - t0 < budget_s:
            batch = _next_batch(queue)
            counts = await asyncio.gather(*(_crawl_company(conn, k, log) for k in batch))
            found += sum(counts)
            queue = [k for k in queue if k not in batch]
            run = await store.save_run(conn, run_id, queue=queue, log=log.lines, found_delta=sum(counts))
            await store.lease_run(conn, run_id, LEASE_S)
            found = 0
        await finalize(conn, log)
        if queue:
            return await store.save_run(conn, run_id, queue=queue, log=log.lines, found_delta=found)
        total = run["found"] + found
        await store.set_meta(conn, "lastCrawl", store.now_iso())
        log(f"Done: {total} student roles in Canada across {run['total']} companies.")
        return await store.save_run(conn, run_id, queue=[], log=log.lines, found_delta=found, status="done", result={"total": total})
    except Exception as e:  # noqa: BLE001
        log(f"✗ {e}")
        return await store.save_run(conn, run_id, queue=queue, log=log.lines, status="failed", error=str(e))
    finally:
        # never leave the run locked (save_run clears the lease; this covers failures inside it)
        await conn.execute("UPDATE crawl_runs SET lease_until = NULL WHERE id = %s AND lease_until IS NOT NULL", (run_id,))


# ---------- single posting import ----------
_BODY = rx(r"<body[\s\S]*<\/body>", "i")
_TITLE = rx(r"<title>([^<]*)", "i")


def _meta(html: str, prop: str) -> str:
    m = rx(f"<meta[^>]+(?:property|name)=[\"']{prop}[\"'][^>]+content=[\"']([^\"']*)", "i").search(html)
    return m.group(1) if m else ""


async def import_posting(conn: AsyncConn, p: dict) -> dict:
    """Manual add (pasted URL or description text); also used by the browser helper."""
    loc = p.get("location")
    raw = {
        "source": p.get("source") or "manual", "company": p.get("company") or "", "title": p.get("title") or "", "url": p.get("url") or "",
        "locations": [loc] if loc else [], "description": p.get("description") or "", "salaryText": p.get("salaryText") or "",
        "workModeHint": p.get("workMode") or "", "extId": p.get("extId") or p.get("url") or str(int(time.time() * 1000)), "deadline": p.get("deadline") or "",
    }
    if p.get("url") and not p.get("description"):
        try:
            res = await request(p["url"], timeout=15)
        except Exception:
            res = None
        if res is not None and res.ok:
            lds = extract_json_ld_jobs(res.text, res.url)
            if lds:
                ld = lds[0]
                raw = {**raw, **ld, "source": raw["source"], "title": raw["title"] or ld.get("title"), "company": raw["company"] or ld.get("company")}
            else:
                bm = _BODY.search(res.text)
                body = html_to_text(bm.group(0) if bm else res.text)
                tm = _TITLE.search(res.text)
                raw["title"] = raw["title"] or decode_entities(_meta(res.text, "og:title") or (tm.group(1) if tm else "") or "Untitled posting")
                raw["description"] = body[:15000] or decode_entities(_meta(res.text, "og:description"))
        elif not raw["title"]:
            raise ValueError("Could not fetch that page (it may need a login). Paste the job description text instead.")
    if not raw["title"]:
        raise ValueError("A title is required")
    raw["companyKey"] = f"{raw['source']}:{(raw['company'] or 'unknown').lower()}"
    j = normalize_job(raw)
    j["manual"] = raw["source"] == "manual"
    if not j["manual"] and not j["student"]:
        raise ValueError("Not a student role (no intern / co-op / student in the title); skipped.")
    await store.upsert_job(conn, j)
    if p.get("status"):
        await store.update_app(conn, j["id"], {"status": p["status"]})
    merged: dict[str, str] = {}
    await finalize(conn, lambda m: None, merged)
    return await store.get_job(conn, merged.get(j["id"], j["id"]))
