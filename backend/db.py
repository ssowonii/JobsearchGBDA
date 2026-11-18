"""Postgres access (Neon). One short-lived async connection per request: serverless-friendly
and works with Neon's pooled connection string."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import psycopg
from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row


def database_url() -> str:
    url = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set. Add Neon from the Vercel Marketplace (or put it in .env.local).")
    return url


@asynccontextmanager
async def connect() -> AsyncIterator[psycopg.AsyncConnection]:
    conn = await psycopg.AsyncConnection.connect(database_url(), autocommit=True, row_factory=dict_row, prepare_threshold=None)
    try:
        try:
            await register_vector_async(conn)
        except psycopg.ProgrammingError:
            pass  # extension not created yet (first run before migrate)
        yield conn
    finally:
        await conn.close()


SCHEMA = (Path(__file__).parent / "schema.sql").read_text(encoding="utf-8")


async def migrate(conn: psycopg.AsyncConnection) -> None:
    await conn.execute(SCHEMA)
    await register_vector_async(conn)
