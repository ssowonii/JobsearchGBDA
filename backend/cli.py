"""Command line helpers (run via npm scripts, which load .env.local):

  npm run db:migrate                     create tables (also happens automatically on first request)
  npm run crawl                          full refresh of every saved company board
  npm run crawl -- "Shopify" [--all]     dream-company search
  node scripts/py.mjs -m backend.cli import-json [data/]   import the old app's data/db.json + embeddings.json
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from psycopg.types.json import Jsonb

from . import crawl, discovery, store
from .db import connect, migrate


async def cmd_migrate() -> None:
    async with connect() as conn:
        await migrate(conn)
        await store.ensure_seeded(conn)
    print("Schema is up to date.")


async def cmd_crawl(args: list[str]) -> int:
    target = next((a for a in args if not a.startswith("--")), None)
    async with connect() as conn:
        await migrate(conn)
        if target:
            run = await discovery.crawl_dream_company(conn, target, include_all="--all" in args)
        else:
            run = await crawl.start_crawl(conn)
            while run["status"] == "running":
                run = await crawl.crawl_step(conn, run["id"], budget_s=10_000)
                if run.get("busy"):
                    print("Another step is running this crawl; try again in a few minutes.")
                    return 1
        if run.get("error"):
            print("Failed:", run["error"])
            return 1
    return 0


async def cmd_import_json(folder: str) -> None:
    """One-off import from the original Express app's ./data folder."""
    d = Path(folder)
    db = json.loads((d / "db.json").read_text(encoding="utf-8"))
    emb_file = d / "embeddings.json"
    emb = json.loads(emb_file.read_text(encoding="utf-8")) if emb_file.exists() else {}
    async with connect() as conn:
        await migrate(conn)
        for c in db.get("companies") or []:
            await store.add_company(conn, c)
        await store.set_meta(conn, "seeded", True)
        meta = db.get("meta") or {}
        if meta.get("profileText"):
            await store.set_meta(conn, "profileText", meta["profileText"])
        if meta.get("lastCrawl"):
            await store.set_meta(conn, "lastCrawl", meta["lastCrawl"])
        n = 0
        for j in (db.get("jobs") or {}).values():
            await store.upsert_job(conn, j, app=j.get("app"))
            await conn.execute(
                "UPDATE jobs SET app = %s, active = %s, match = %s, first_seen = coalesce(%s::timestamptz, first_seen), last_seen = coalesce(%s::timestamptz, last_seen) WHERE id = %s",
                (Jsonb(j.get("app") or {"status": "none", "notes": "", "deadline": ""}), j.get("active", True) is not False, j.get("match"), j.get("firstSeen"), j.get("lastSeen"), j["id"]),
            )
            e = emb.get(j["id"])
            if e and e.get("t") and e.get("v") and len(e["t"]) == 512:
                # stored hash came from the JS text builder; the Python one is identical, so no re-embed
                await conn.execute("UPDATE jobs SET title_vec = %s::vector, body_vec = %s::vector, emb_hash = %s WHERE id = %s",
                                   (str(e["t"]), str(e["v"]), e.get("h"), j["id"]))
            n += 1
        await crawl.finalize(conn, print)
    print(f"Imported {n} job(s) and {len(db.get('companies') or [])} companies from {d}.")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd, args = sys.argv[1], sys.argv[2:]
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    if cmd == "migrate":
        asyncio.run(cmd_migrate(), loop_factory=loop_factory)
    elif cmd == "crawl":
        return asyncio.run(cmd_crawl(args), loop_factory=loop_factory)
    elif cmd == "import-json":
        asyncio.run(cmd_import_json(args[0] if args else "data"), loop_factory=loop_factory)
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
