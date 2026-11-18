"""Persistence for jobs, companies, settings and crawl runs (replaces the old JSON-file store).

Job dicts returned here have the same shape the frontend always used:
normalized fields + description + app + active/dream/manual/match/firstSeen/lastSeen."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from .companies import SEED_COMPANIES, company_key

AsyncConn = AsyncConnection

# normalized-job keys that live in their own columns instead of `data`
_COLS = {"id", "companyKey", "company", "title", "description", "app", "active", "dream", "manual", "match", "firstSeen", "lastSeen", "review"}
JOB_SELECT = "id, company_key, company, title, data, description, app, active, dream, manual, match, first_seen, last_seen, review"


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return _iso(datetime.now(timezone.utc))


def row_to_job(r: dict, with_description: bool = True) -> dict:
    j = dict(r["data"])
    j.update(
        id=r["id"], companyKey=r["company_key"], company=r["company"], title=r["title"], app=r["app"],
        active=r["active"], dream=r["dream"], manual=r["manual"], match=r["match"],
        firstSeen=_iso(r["first_seen"]), lastSeen=_iso(r["last_seen"]), review=r["review"],
    )
    if with_description:
        j["description"] = r["description"]
    return j


# ---------------- jobs ----------------
async def list_jobs(conn: AsyncConn, with_description: bool = False, review: str = "") -> list[dict]:
    """Jobs in the hub (review ''), or the dream-company roles waiting for review ('pending')."""
    cols = JOB_SELECT if with_description else JOB_SELECT.replace("description", "left(description, 280) AS description")
    rows = await (await conn.execute(f"SELECT {cols} FROM jobs WHERE review = %s", (review,))).fetchall()
    return [row_to_job(r) for r in rows]


async def list_jobs_any_review(conn: AsyncConn) -> list[dict]:
    """Every stored posting (in the hub, waiting for review, or dismissed), without descriptions."""
    cols = JOB_SELECT.replace("description", "'' AS description")
    return [row_to_job(r) for r in await (await conn.execute(f"SELECT {cols} FROM jobs")).fetchall()]


async def get_job(conn: AsyncConn, job_id: str) -> dict | None:
    r = await (await conn.execute(f"SELECT {JOB_SELECT} FROM jobs WHERE id = %s", (job_id,))).fetchone()
    return row_to_job(r) if r else None


async def upsert_job(conn: AsyncConn, job: dict, app: dict | None = None) -> None:
    """Insert or refresh a crawled job while preserving the user's tracking data."""
    data = {k: v for k, v in job.items() if k not in _COLS}
    default_app = app or job.get("app") or {"status": "none", "notes": "", "deadline": job.get("deadline") or ""}
    await conn.execute(
        # A role already in the hub (or dismissed) keeps that state when it's found again; a pending one
        # joins the hub if it's re-added another way (e.g. imported by hand).
        """INSERT INTO jobs (id, company_key, company, title, data, description, app, active, dream, manual, review)
           VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s, %s, %s)
           ON CONFLICT (id) DO UPDATE SET
             company_key = EXCLUDED.company_key, company = EXCLUDED.company, title = EXCLUDED.title,
             data = EXCLUDED.data, description = EXCLUDED.description, active = true, last_seen = now(),
             dream = jobs.dream OR EXCLUDED.dream, manual = jobs.manual OR EXCLUDED.manual,
             review = CASE WHEN jobs.review = 'pending' THEN EXCLUDED.review ELSE jobs.review END""",
        (job["id"], job.get("companyKey") or "", job.get("company") or "", job.get("title") or "", Jsonb(data),
         job.get("description") or "", Jsonb(default_app), bool(job.get("dream")), bool(job.get("manual")),
         job.get("review") or ""),
    )


async def update_app(conn: AsyncConn, job_id: str, patch: dict) -> dict | None:
    r = await (await conn.execute("SELECT app FROM jobs WHERE id = %s", (job_id,))).fetchone()
    if not r:
        return None
    app = {**(r["app"] or {}), **patch, "updatedAt": now_iso()}
    if patch.get("status") == "applied" and not app.get("appliedAt"):
        app["appliedAt"] = now_iso()[:10]
    await conn.execute("UPDATE jobs SET app = %s WHERE id = %s", (Jsonb(app), job_id))
    return await get_job(conn, job_id)


async def delete_job(conn: AsyncConn, job_id: str) -> None:
    await conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


async def mark_inactive(conn: AsyncConn, ckey: str, seen_ids: set[str]) -> None:
    """After a full crawl of a company, drop jobs no longer listed (kept as closed if you're tracking them)."""
    seen = list(seen_ids)
    await conn.execute(
        "UPDATE jobs SET active = false WHERE company_key = %s AND NOT (id = ANY(%s)) AND coalesce(app->>'status', 'none') <> 'none'",
        (ckey, seen),
    )
    await conn.execute(
        "DELETE FROM jobs WHERE company_key = %s AND NOT (id = ANY(%s)) AND coalesce(app->>'status', 'none') = 'none'",
        (ckey, seen),
    )


async def count_jobs(conn: AsyncConn, review: str = "") -> int:
    return (await (await conn.execute("SELECT count(*) AS n FROM jobs WHERE review = %s", (review,))).fetchone())["n"]


async def set_review(conn: AsyncConn, ids: list[str], review: str) -> int:
    """Move roles between the review list and the hub ('' = add to hub, 'dismissed', 'pending')."""
    if not ids:
        return 0
    rows = await (await conn.execute("UPDATE jobs SET review = %s WHERE id = ANY(%s) RETURNING id", (review, ids))).fetchall()
    return len(rows)


async def review_states(conn: AsyncConn, ids: list[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = await (await conn.execute("SELECT id, review FROM jobs WHERE id = ANY(%s)", (ids,))).fetchall()
    return {r["id"]: r["review"] for r in rows}


# ---------------- companies ----------------
def _company_row(r: dict) -> dict:
    c = {"name": r["name"], "ats": r["ats"], "slug": r["slug"]}
    if r.get("site"):
        c["site"] = r["site"]
    if r.get("region"):
        c["region"] = r["region"]
    if r.get("dream"):
        c["dream"] = True
    return c


async def ensure_seeded(conn: AsyncConn) -> None:
    if await get_meta(conn, "seeded"):
        return
    for c in SEED_COMPANIES:
        await add_company(conn, c)
    await set_meta(conn, "seeded", True)


async def list_companies(conn: AsyncConn) -> list[dict]:
    await ensure_seeded(conn)
    rows = await (await conn.execute("SELECT * FROM companies ORDER BY position")).fetchall()
    return [_company_row(r) for r in rows]


async def get_company(conn: AsyncConn, key: str) -> dict | None:
    r = await (await conn.execute("SELECT * FROM companies WHERE key = %s", (key,))).fetchone()
    return _company_row(r) if r else None


async def add_company(conn: AsyncConn, c: dict) -> None:
    await conn.execute(
        "INSERT INTO companies (key, name, ats, slug, site, region, dream) VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (key) DO NOTHING",
        (company_key(c), c["name"], c["ats"], c["slug"], c.get("site"), c.get("region"), bool(c.get("dream"))),
    )


async def remove_company(conn: AsyncConn, key: str) -> None:
    await conn.execute("DELETE FROM companies WHERE key = %s", (key,))


async def mark_company_crawled(conn: AsyncConn, key: str, error: str | None) -> None:
    await conn.execute("UPDATE companies SET last_crawled_at = now(), last_error = %s WHERE key = %s", (error, key))


# ---------------- meta ----------------
async def get_meta(conn: AsyncConn, key: str, default: Any = None) -> Any:
    r = await (await conn.execute("SELECT value FROM meta WHERE key = %s", (key,))).fetchone()
    return default if r is None or r["value"] is None else r["value"]


async def set_meta(conn: AsyncConn, key: str, value: Any) -> None:
    if value is None:
        await conn.execute("DELETE FROM meta WHERE key = %s", (key,))
        return
    await conn.execute(
        "INSERT INTO meta (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (key, Jsonb(value)),
    )


# ---------------- crawl runs ----------------
def run_to_task(r: dict | None) -> dict:
    """Shape the frontend (and browser.js) expect from /api/task."""
    if not r:
        return {"running": False, "kind": "", "label": "", "log": [], "startedAt": None, "finishedAt": None, "result": None, "error": None, "done": 0, "total": 0}
    queue = r["queue"] or []
    return {
        "id": r["id"], "running": r["status"] == "running", "kind": r["kind"], "label": r["label"], "log": r["log"] or [],
        "startedAt": _iso(r["started_at"]), "finishedAt": _iso(r["finished_at"]), "result": r["result"], "error": r["error"],
        "done": r["total"] - len(queue), "total": r["total"],
    }


async def latest_run(conn: AsyncConn) -> dict | None:
    return await (await conn.execute("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1")).fetchone()


async def active_crawl(conn: AsyncConn) -> dict | None:
    return await (await conn.execute("SELECT * FROM crawl_runs WHERE kind = 'crawl' AND status = 'running' ORDER BY id DESC LIMIT 1")).fetchone()


async def create_run(conn: AsyncConn, kind: str, label: str, queue: list[str], status: str = "running") -> dict:
    return await (await conn.execute(
        "INSERT INTO crawl_runs (kind, label, status, queue, total) VALUES (%s, %s, %s, %s, %s) RETURNING *",
        (kind, label, status, Jsonb(queue), len(queue)),
    )).fetchone()


async def lease_run(conn: AsyncConn, run_id: int, seconds: int) -> dict | None:
    """Claim a running crawl for one step. Returns None if another step holds it."""
    return await (await conn.execute(
        """UPDATE crawl_runs SET lease_until = now() + make_interval(secs => %s)
           WHERE id = %s AND status = 'running' AND (lease_until IS NULL OR lease_until < now()) RETURNING *""",
        (seconds, run_id),
    )).fetchone()


async def save_run(conn: AsyncConn, run_id: int, *, queue: list[str], log: list[str], found_delta: int = 0,
                   status: str = "running", result: Any = None, error: str | None = None) -> dict:
    return await (await conn.execute(
        """UPDATE crawl_runs SET queue = %s, log = %s, found = found + %s, status = %s, result = coalesce(%s, result), error = %s,
             lease_until = NULL, finished_at = CASE WHEN %s <> 'running' THEN now() ELSE NULL END
           WHERE id = %s RETURNING *""",
        (Jsonb(queue), Jsonb(log[-400:]), found_delta, status, Jsonb(result) if result is not None else None, error, status, run_id),
    )).fetchone()


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
