"""FastAPI backend. Runs as a Vercel Python function (api/index.py) in production and with
uvicorn locally (`npm run dev`). Same routes and JSON shapes as the original Express server."""
from __future__ import annotations

import asyncio
import os
import time

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import auth, crawl, discovery, rag, store
from .companies import company_key
from .db import connect, migrate
from .profile import DEFAULT_PROFILE

app = FastAPI(title="Internship Hub API", docs_url=None, redoc_url=None, openapi_url=None)
_migrated = False


async def db():
    """One connection per request; the schema is created on the first request after a cold start."""
    global _migrated
    async with connect() as conn:
        if not _migrated:
            await migrate(conn)
            _migrated = True
        yield conn


@app.exception_handler(HTTPException)
async def http_error(_req: Request, e: HTTPException):
    return JSONResponse({"error": e.detail}, status_code=e.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_req: Request, e: RequestValidationError):
    return JSONResponse({"error": "Invalid request"}, status_code=400)


@app.exception_handler(Exception)
async def server_error(_req: Request, e: Exception):
    return JSONResponse({"error": str(e) or type(e).__name__}, status_code=500)


Auth = Depends(auth.require_auth)


def public_job(j: dict) -> dict:
    out = {k: v for k, v in j.items() if k not in ("description", "textHash")}
    out["rank"] = rag.rank_score(j)
    out["snippet"] = (j.get("description") or "")[:280]
    return out


async def _body(request: Request) -> dict:
    try:
        b = await request.json()
    except Exception:
        return {}
    return b if isinstance(b, dict) else {}


# ---------------- auth ----------------
@app.post("/api/auth/login")
async def login(request: Request):
    body = await _body(request)
    if not auth.auth_enabled():
        return {"ok": True, "authDisabled": True}
    if not await auth.check_password(str(body.get("password") or "")):
        raise HTTPException(401, "Wrong password")
    res = JSONResponse({"ok": True})
    res.set_cookie(auth.COOKIE, auth.new_cookie_value(), max_age=auth.MAX_AGE, httponly=True,
                   secure=request.url.scheme == "https" or bool(os.environ.get("VERCEL")), samesite="lax", path="/")
    return res


@app.post("/api/auth/logout")
async def logout():
    res = JSONResponse({"ok": True})
    res.delete_cookie(auth.COOKIE, path="/")
    return res


@app.get("/api/auth/me", dependencies=[Auth])
async def me():
    return {"ok": True}


# ---------------- jobs ----------------
@app.get("/api/jobs", dependencies=[Auth])
async def jobs(conn=Depends(db)):
    jobs = await store.list_jobs(conn)
    embedded = (await (await conn.execute("SELECT EXISTS (SELECT 1 FROM jobs WHERE title_vec IS NOT NULL) AS e")).fetchone())["e"]
    err = await rag.openai_error(conn)
    return {
        "jobs": [public_job(j) for j in jobs],
        "meta": {
            "lastCrawl": await store.get_meta(conn, "lastCrawl"),
            "hasOpenAI": rag.has_key() and not err and embedded,
            "hasKey": rag.has_key(),
            "openaiError": err,
            "companies": len(await store.list_companies(conn)),
            "pendingReview": await store.count_jobs(conn, "pending"),
        },
    }


# ---------------- dream-company review list ----------------
@app.get("/api/review", dependencies=[Auth])
async def review_list(conn=Depends(db)):
    """Dream-company roles found by a search or refresh that haven't been added to the hub yet."""
    jobs = await store.list_jobs(conn, review="pending")
    return {"jobs": [public_job(j) for j in sorted(jobs, key=lambda j: -(j.get("match") or 0))]}


@app.post("/api/review", dependencies=[Auth])
async def review_apply(request: Request, conn=Depends(db)):
    """{"add": [ids], "dismiss": [ids]}: add the ticked roles to the hub, pass on the others."""
    body = await _body(request)
    ids = lambda k: [str(x) for x in (body.get(k) or []) if isinstance(x, str)][:500]  # noqa: E731
    added = await store.set_review(conn, ids("add"), "")
    dismissed = await store.set_review(conn, [i for i in ids("dismiss") if i not in set(ids("add"))], "dismissed")
    return {"added": added, "dismissed": dismissed}


@app.patch("/api/jobs/{job_id:path}/app", dependencies=[Auth])
async def update_app(job_id: str, request: Request, conn=Depends(db)):
    body = await _body(request)
    patch = {k: v for k, v in body.items() if k in ("status", "notes", "deadline")}
    j = await store.update_app(conn, job_id, patch)
    if not j:
        raise HTTPException(404, "Not found")
    return public_job(j)


@app.get("/api/jobs/{job_id:path}", dependencies=[Auth])
async def get_job(job_id: str, conn=Depends(db)):
    j = await store.get_job(conn, job_id)
    if not j:
        raise HTTPException(404, "Not found")
    return {**j, "rank": rag.rank_score(j)}


@app.delete("/api/jobs/{job_id:path}", dependencies=[Auth])
async def delete_job(job_id: str, conn=Depends(db)):
    await store.delete_job(conn, job_id)
    return {"ok": True}


@app.get("/api/search", dependencies=[Auth])
async def search(q: str = "", conn=Depends(db)):
    return await rag.search(conn, q[:500])


@app.get("/api/similar/{job_id:path}", dependencies=[Auth])
async def similar(job_id: str, conn=Depends(db)):
    return await rag.similar(conn, job_id)


# ---------------- crawling ----------------
@app.post("/api/crawl", dependencies=[Auth])
async def start_crawl(conn=Depends(db)):
    return store.run_to_task(await crawl.start_crawl(conn))


@app.post("/api/crawl/step", dependencies=[Auth])
async def crawl_step(request: Request, conn=Depends(db)):
    body = await _body(request)
    run_id = body.get("id")
    if not isinstance(run_id, int):
        run = await store.active_crawl(conn)
        if not run:
            return store.run_to_task(await store.latest_run(conn))
        run_id = run["id"]
    run = await crawl.crawl_step(conn, run_id)
    return {**store.run_to_task(run if run.get("id") else None), "busy": bool(run.get("busy"))}


@app.post("/api/dream", dependencies=[Auth])
async def dream(request: Request, conn=Depends(db)):
    body = await _body(request)
    try:
        run = await discovery.crawl_dream_company(conn, body.get("company"), include_all=bool(body.get("includeAll")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return store.run_to_task(run)


@app.get("/api/task", dependencies=[Auth])
async def task(conn=Depends(db)):
    return store.run_to_task(await store.latest_run(conn))


@app.post("/api/import", dependencies=[Auth])
async def import_posting(request: Request, conn=Depends(db)):
    try:
        return public_job(await crawl.import_posting(conn, await _body(request)))
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------- companies & profile ----------------
@app.get("/api/companies", dependencies=[Auth])
async def companies(conn=Depends(db)):
    return [{**c, "key": company_key(c)} for c in await store.list_companies(conn)]


@app.delete("/api/companies/{key:path}", dependencies=[Auth])
async def remove_company(key: str, conn=Depends(db)):
    await store.remove_company(conn, key)
    return {"ok": True}


@app.get("/api/profile", dependencies=[Auth])
async def get_profile(conn=Depends(db)):
    custom = await store.get_meta(conn, "profileText")
    return {"text": custom or DEFAULT_PROFILE, "isDefault": not custom}


@app.put("/api/profile", dependencies=[Auth])
async def put_profile(request: Request, conn=Depends(db)):
    text = str((await _body(request)).get("text") or "").strip()
    await store.set_meta(conn, "profileText", text if text and text != DEFAULT_PROFILE else None)
    await rag.refresh_match_scores(conn)
    return {"ok": True}


# ---------------- cron ----------------
CRON_BUDGET_S = 200
MAX_HOPS = 12


@app.get("/api/cron/crawl", dependencies=[Depends(auth.require_cron)])
async def cron_crawl(hop: int = 0, conn=Depends(db)):
    """Daily full refresh. Works the queue for ~200 s, then re-invokes itself until done."""
    t0 = time.monotonic()
    run = await crawl.start_crawl(conn)
    while run.get("status") == "running" and run.get("queue") and time.monotonic() - t0 < CRON_BUDGET_S:
        run = await crawl.crawl_step(conn, run["id"], budget_s=min(crawl.STEP_BUDGET_S, CRON_BUDGET_S - (time.monotonic() - t0)))
        if run.get("busy"):
            break  # a browser tab is driving this run right now
    if run.get("status") == "running" and run.get("queue") and not run.get("busy") and hop < MAX_HOPS:
        await _chain(hop + 1)
    return {"hop": hop, **store.run_to_task(run if run.get("id") else None)}


async def _chain(hop: int) -> None:
    host = os.environ.get("VERCEL_PROJECT_PRODUCTION_URL") or os.environ.get("VERCEL_URL")
    if not host:
        return
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            await c.get(f"https://{host}/api/cron/crawl?hop={hop}", headers={"Authorization": f"Bearer {os.environ.get('CRON_SECRET', '')}"})
    except (httpx.TimeoutException, asyncio.TimeoutError):
        pass  # expected: the next invocation keeps running on its own
    except httpx.HTTPError:
        pass
