"""Local-dev helper: psycopg's async mode needs a selector event loop, but uvicorn defaults to
the Proactor loop on Windows. Used via `uvicorn --loop backend.devloop:selector_loop`."""
import asyncio


def selector_loop(*_args, **_kwargs) -> asyncio.AbstractEventLoop:
    return asyncio.SelectorEventLoop()
