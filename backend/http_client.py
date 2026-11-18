"""Minimal async HTTP client for job-board APIs and careers pages.

Sends the same browser-like headers as the original Node client (some boards, notably
Workday, reject unusual client fingerprints). TLS uses the OS trust store plus certifi,
so it works behind antivirus/corporate TLS inspection locally and on Vercel.
"""
from __future__ import annotations

import asyncio
import json
import ssl
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, TypeVar

import httpx

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
BASE_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    "Accept-Language": "en-CA,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
}


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()  # loads the OS store (Windows cert store / system CA paths)
    try:
        import certifi

        ctx.load_verify_locations(certifi.where())
    except Exception:
        pass
    return ctx


_SSL = _ssl_context()


class HTTPError(Exception):
    def __init__(self, msg: str, status: int = 0):
        super().__init__(msg)
        self.status = status


@dataclass
class Resp:
    status: int
    url: str
    text: str
    headers: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


_clients: dict[int, httpx.AsyncClient] = {}


def _client() -> httpx.AsyncClient:
    """One pooled client per event loop (connection reuse; safe across loops in tests/serverless)."""
    loop = asyncio.get_running_loop()
    c = _clients.get(id(loop))
    if c is None or c.is_closed:
        c = httpx.AsyncClient(verify=_SSL, follow_redirects=True, max_redirects=5, headers=BASE_HEADERS,
                              limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
        _clients.clear()  # drop clients bound to dead loops
        _clients[id(loop)] = c
    return c


async def request(url: str, method: str = "GET", headers: dict | None = None, body: Any = None, timeout: float = 45) -> Resp:
    try:
        httpx.URL(url)
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError
    except Exception:
        raise HTTPError(f"Invalid URL: {url}")
    content = None
    h = dict(headers or {})
    if body is not None:
        content = body if isinstance(body, str) else json.dumps(body, separators=(",", ":"))
        h.setdefault("Content-Type", "application/json")
    try:
        r = await _client().request(method, url, headers=h, content=content, timeout=timeout)
    except httpx.TimeoutException:
        raise HTTPError(f"Timeout after {int(timeout * 1000)}ms: {url}")
    except httpx.HTTPError as e:
        raise HTTPError(f"{type(e).__name__}: {e} ({url})")
    return Resp(status=r.status_code, url=str(r.url), text=r.content.decode("utf-8", "replace"), headers=dict(r.headers))


async def get_json(url: str, **kw) -> Any:
    h = {"Accept": "application/json", **(kw.pop("headers", None) or {})}
    r = await request(url, headers=h, **kw)
    if not r.ok:
        raise HTTPError(f"HTTP {r.status} for {url}", r.status)
    try:
        return json.loads(r.text)
    except ValueError:
        raise HTTPError(f"Non-JSON response from {url}")


T = TypeVar("T")
R = TypeVar("R")


async def map_limit(items: Iterable[T], limit: int, fn: Callable[[T], Awaitable[R]]) -> list[R | dict]:
    """Run fn over items with limited concurrency; failures become {"error": exc}."""
    items = list(items)
    sem = asyncio.Semaphore(max(1, limit))

    async def run(x):
        async with sem:
            try:
                return await fn(x)
            except Exception as e:  # noqa: BLE001 - mirror JS mapLimit
                return {"error": e}

    return list(await asyncio.gather(*(run(x) for x in items)))


sleep = asyncio.sleep
