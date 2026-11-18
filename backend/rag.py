"""Retrieval layer: OpenAI embeddings (text-embedding-3-small, 512 dims) in pgvector +
Postgres full-text search for keywords.
- Every job is embedded once (re-embedded only when its text changes).
- "Match %" = resume profile vs job: skills vs description (60%) + target roles vs title (40%).
- Search = hybrid (75% semantic + 25% keyword); keyword-only if no API key / OpenAI is down.
"""
from __future__ import annotations

import os
import re
import time
from typing import Callable

import httpx

from . import store
from .http_client import _SSL
from .jsre import js_round, rx
from .normalize import hash_text, js_trim
from .profile import DEFAULT_PROFILE, PREFERENCES, TARGET_ROLES
from .store import AsyncConn

DIMS = 512
OPENAI_RETRY_S = 10 * 60
# Calibrated on real postings (Nov 2026): raw ≈0.35 for unrelated roles, ≈0.50–0.56 for a strong fit.
MATCH_LO, MATCH_HI = 0.35, 0.55


def model() -> str:
    return os.environ.get("OPENAI_EMBED_MODEL") or "text-embedding-3-small"


def has_key() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY"))


async def openai_error(conn: AsyncConn) -> str | None:
    st = await store.get_meta(conn, "openai_error")
    if st and time.time() - st.get("at", 0) < OPENAI_RETRY_S:
        return st.get("error")
    return None


async def has_openai(conn: AsyncConn) -> bool:
    return has_key() and not await openai_error(conn)


async def profile_text(conn: AsyncConn) -> str:
    return await store.get_meta(conn, "profileText") or DEFAULT_PROFILE


# ---------- what gets embedded ----------
# Company boilerplate ("About Manulife…", EEO statements) repeats across a company's postings and
# would make every posting from that company look alike, so repeated paragraphs are stripped.
_NONALNUM = rx(r"[^a-z0-9]+")
_NL = rx(r"\n+")


def _para_key(p: str) -> str:
    return js_trim(_NONALNUM.sub(" ", p.lower()))[:160]


def boilerplate_sets(jobs: list[dict]) -> Callable[[dict, str], bool]:
    per_company: dict[str, dict[str, int]] = {}
    glob: dict[str, int] = {}
    for j in jobs:
        keys = {_para_key(p) for p in (js_trim(x) for x in _NL.split(j.get("description") or "")) if len(p) > 40}
        m = per_company.setdefault(j.get("companyKey") or "", {})
        for k in keys:
            m[k] = m.get(k, 0) + 1
            glob[k] = glob.get(k, 0) + 1
    return lambda j, key: per_company.get(j.get("companyKey") or "", {}).get(key, 0) >= 3 or glob.get(key, 0) >= 5


CAT_NAME = {"content": "content creation", "marketing": "marketing", "ux": "UX/UI design"}
_ROLE_NOISE = rx(r"\b(winter|summer|fall|spring|autumn)\b|\b20\d\d\b|\b(co-?op|internships?|interns?|students?|work term)\b|\(?\b\d+\s*(-|–)?\s*months?\)?|[–—|]", "i")
_ROLE_SEP = rx(r"[\s,/-]+")


def role_only(t: str) -> str:
    """The role itself, without "Winter Co-op 2027 – … (8 months)" noise every posting shares."""
    return js_trim(_ROLE_SEP.sub(" ", _ROLE_NOISE.sub(" ", t)))


def title_text(j: dict) -> str:
    cats = j.get("categories") or []
    suffix = f" ({', '.join(CAT_NAME[c] for c in cats)})" if cats else ""
    return f"{role_only(j['title']) or j['title']}{suffix}"


def body_text(j: dict, is_boiler) -> str:
    paras = [p for p in (js_trim(x) for x in _NL.split(j.get("description") or "")) if p]
    kept = [p for p in paras if len(p) <= 40 or not is_boiler(j, _para_key(p))]
    return (f"{j['title']}\n" + "\n".join(kept if len(kept) >= 3 else paras))[:5000]


async def embed(conn: AsyncConn, texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    async with httpx.AsyncClient(verify=_SSL, timeout=60) as client:
        for i in range(0, len(texts), 96):
            batch = [t[:8000] or " " for t in texts[i : i + 96]]
            r = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', '')}"},
                json={"model": model(), "input": batch, "dimensions": DIMS},
            )
            if r.status_code >= 300:
                msg = r.text[:200]
                try:
                    msg = r.json().get("error", {}).get("message") or msg
                except Exception:
                    pass
                err = f"OpenAI {r.status_code}: {msg}"
                await store.set_meta(conn, "openai_error", {"error": err, "at": time.time()})
                raise RuntimeError(err)
            data = sorted(r.json()["data"], key=lambda d: d["index"])
            out.extend(d["embedding"] for d in data)
    await store.set_meta(conn, "openai_error", None)
    return out


async def ensure_embeddings(conn: AsyncConn, log: Callable[[str], None] = lambda m: None) -> int:
    """Embed new/changed jobs: a title vector and a cleaned-description vector."""
    if not await has_openai(conn):
        return 0
    rows = await (await conn.execute(
        "SELECT id, company_key, title, data->'categories' AS categories, description, emb_hash, title_vec IS NOT NULL AS has_vec FROM jobs"
    )).fetchall()
    jobs = [{"id": r["id"], "companyKey": r["company_key"], "title": r["title"], "categories": r["categories"] or [], "description": r["description"], "h": r["emb_hash"], "has": r["has_vec"]} for r in rows]
    is_boiler = boilerplate_sets(jobs)
    work = []
    for j in jobs:
        tt = title_text(j)
        bt = body_text(j, is_boiler)
        h = hash_text(f"{model()}|{tt}|{bt}")
        if j["h"] != h or not j["has"]:
            work.append((j["id"], tt, bt, h))
    if work:
        log(f"Embedding {len(work)} job(s) with {model()}…")
        vecs = await embed(conn, [x for w in work for x in (w[1], w[2])])
        async with conn.cursor() as cur:
            await cur.executemany(
                "UPDATE jobs SET title_vec = %s::vector, body_vec = %s::vector, emb_hash = %s WHERE id = %s",
                [(str(vecs[2 * i]), str(vecs[2 * i + 1]), w[3], w[0]) for i, w in enumerate(work)],
            )
    return len(work)


# Two profile vectors: skills/experience (generic co-op & school words removed, since every co-op
# posting shares them) and target roles (compared against job titles).
_ROLES_LINE = rx(r"^target roles?:(.*)$", "im")
_SKIP_LINE = rx(r"^(education|target roles?)\s*:", "i")
_GENERIC = rx(r"\b(undergraduate|co-?op|internships?|interns?|university|student)\b", "i")


def _profile_parts(text: str) -> tuple[str, str]:
    m = _ROLES_LINE.search(text)
    roles_line = m.group(1) if m else TARGET_ROLES
    skills = _GENERIC.sub("", "\n".join(l for l in text.split("\n") if not _SKIP_LINE.search(js_trim(l))))
    return skills, f"{roles_line}. {TARGET_ROLES}"


async def profile_vectors(conn: AsyncConn) -> dict:
    skills, roles = _profile_parts(await profile_text(conn))
    h = hash_text(f"{model()}|{skills}|{roles}")
    p = await store.get_meta(conn, "profile_emb")
    if not p or p.get("h") != h or not p.get("r"):
        sv, rv = await embed(conn, [skills, roles])
        p = {"h": h, "v": sv, "r": rv}
        await store.set_meta(conn, "profile_emb", p)
    return p


# ---------- keyword search (Postgres FTS) ----------
STOP = set("a an the and or of to in for on with at by from as is are be this that you your we our will it its their they".split())
_TOK_CLEAN = rx(r"[^a-z0-9+#/ ]+")
_TOK_SPLIT = rx(r"[\s/]+")


def tokenize(s: str) -> list[str]:
    import unicodedata

    t = unicodedata.normalize("NFKD", str(s or "").lower())
    return [x for x in _TOK_SPLIT.split(_TOK_CLEAN.sub(" ", t)) if len(x) > 1 and x not in STOP]


def or_query(text: str, limit: int = 120) -> str:
    """tsquery source: OR of the (deduped, sanitized) query tokens."""
    toks = []
    for t in tokenize(text):
        t = re.sub(r"[^a-z0-9]", "", t)
        if len(t) > 1 and t not in toks:
            toks.append(t)
    return " | ".join(toks[:limit])


async def lexical_scores(conn: AsyncConn, query: str) -> dict[str, float]:
    q = or_query(query)
    if not q:
        return {}
    rows = await (await conn.execute(
        "SELECT id, ts_rank_cd(fts, to_tsquery('english', %s), 1) AS s FROM jobs WHERE fts @@ to_tsquery('english', %s)",
        (q, q),
    )).fetchall()
    return {r["id"]: float(r["s"]) for r in rows if r["s"] > 0}


def _normalize_map(m: dict[str, float]) -> dict[str, float]:
    mx = max([0.0, *m.values()])
    return {k: (v / mx if mx else 0.0) for k, v in m.items()}


# ---------- scoring ----------
async def refresh_match_scores(conn: AsyncConn) -> None:
    """Match % of each job to the resume profile, stored in jobs.match (0–100)."""
    p = None
    if await has_openai(conn):
        try:
            p = await profile_vectors(conn)
        except Exception:
            p = None
    if p:
        await conn.execute(
            """UPDATE jobs SET match = floor(greatest(0, least(1,
                 (0.6 * -(body_vec <#> %s::vector) + 0.4 * -(title_vec <#> %s::vector) - %s) / %s)) * 100 + 0.5)
               WHERE title_vec IS NOT NULL""",
            (str(p["v"]), str(p["r"]), MATCH_LO, MATCH_HI - MATCH_LO),
        )
    missing = await (await conn.execute(
        "SELECT id FROM jobs" + ("" if not p else " WHERE title_vec IS NULL")
    )).fetchall()
    if missing:
        lex = _normalize_map(await lexical_scores(conn, await profile_text(conn)))
        async with conn.cursor() as cur:
            await cur.executemany("UPDATE jobs SET match = %s WHERE id = %s",
                                  [(int(js_round(lex.get(r["id"], 0) * 85)), r["id"]) for r in missing])


def rank_score(j: dict) -> int:
    """Overall ranking used for "Best match" sort: resume fit + your preferences."""
    s = j.get("match") or 0
    L = j.get("location") or {}
    cities = [c.lower() for c in (L.get("cities") or [])]
    if L.get("isOntario"):
        s += 10
    if any(c in PREFERENCES["homeCities"] for c in cities):
        s += 6
    elif any(c in PREFERENCES["gtaCities"] for c in cities):
        s += 4
    if j.get("workMode") == "remote" and (L.get("isCanada") or L.get("remoteFromCanada")):
        s += 3
    if j.get("categories"):
        s += 6
    term = j.get("term") or {}
    if term.get("eightMonth") or any(t in ("Winter 2027", "Summer 2027") for t in (term.get("terms") or [])):
        s += 4
    st = (j.get("eligibility") or {}).get("status")
    if st == "blocked":
        s -= 40
    elif st == "warn":
        s -= 4
    if j.get("active") is False:
        s -= 20
    return int(js_round(s))


_qcache: dict[str, list[float]] = {}


async def _query_vector(conn: AsyncConn, q: str) -> list[float] | None:
    if q in _qcache:
        return _qcache[q]
    try:
        [v] = await embed(conn, [q])
    except Exception:
        return None
    _qcache[q] = v
    if len(_qcache) > 200:
        _qcache.pop(next(iter(_qcache)))
    return v


async def search(conn: AsyncConn, query: str, limit: int = 300) -> dict:
    """Hybrid semantic + keyword search. Returns {mode, results: [{id, score}]} sorted desc."""
    lex = _normalize_map(await lexical_scores(conn, query))
    combined = dict(lex)
    mode = "keyword"
    qv = await _query_vector(conn, query) if await has_openai(conn) else None
    if qv:
        rows = await (await conn.execute(
            "SELECT id, 0.5 * -(title_vec <#> %s::vector) + 0.5 * -(body_vec <#> %s::vector) AS s FROM jobs WHERE title_vec IS NOT NULL",
            (str(qv), str(qv)),
        )).fetchall()
        sem = _normalize_map({r["id"]: max(0.0, float(r["s"]) - 0.2) for r in rows})
        combined = {i: 0.75 * sem.get(i, 0) + 0.25 * lex.get(i, 0) for i in {*sem, *lex}}
        mode = "hybrid"
    res = sorted(((i, s) for i, s in combined.items() if s > 0.05), key=lambda x: -x[1])[:limit]
    return {"mode": mode, "results": [{"id": i, "score": int(js_round(s * 100))} for i, s in res]}


async def similar(conn: AsyncConn, job_id: str, limit: int = 12) -> dict:
    """Nearest neighbours of a job (by embedding, or keywords as fallback)."""
    j = await store.get_job(conn, job_id)
    if not j:
        return {"mode": "none", "results": []}
    rows = await (await conn.execute(
        """SELECT o.id, 0.65 * -(o.title_vec <#> j.title_vec) + 0.35 * -(o.body_vec <#> j.body_vec) AS s
           FROM jobs j JOIN jobs o ON o.id <> j.id AND o.title_vec IS NOT NULL
           WHERE j.id = %s AND j.title_vec IS NOT NULL ORDER BY s DESC LIMIT %s""",
        (job_id, limit),
    )).fetchall()
    if rows:
        return {"mode": "semantic", "results": [{"id": r["id"], "score": int(js_round(float(r["s"]) * 100))} for r in rows]}
    res = await search(conn, f"{j['title']} {j['title']} {(j.get('description') or '')[:400]}", limit + 1)
    return {"mode": "keyword", "results": [r for r in res["results"] if r["id"] != job_id][:limit]}
