"""Single-password access control.

- POST /api/auth/login with the APP_PASSWORD sets a signed, HttpOnly session cookie.
- Scripts (browser.js) send `Authorization: Bearer $HUB_TOKEN` instead.
- Vercel Cron sends `Authorization: Bearer $CRON_SECRET` (cron route only).
Cookie format: "<expiry unix>.<hex HMAC-SHA256(SESSION_SECRET, 'v1.<expiry>')>" — the Next.js
middleware verifies the same signature to decide whether to show the login page.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import time

from fastapi import HTTPException, Request

COOKIE = "ih_session"
MAX_AGE = 30 * 24 * 3600


def _secret() -> bytes:
    s = os.environ.get("SESSION_SECRET")
    if not s:
        raise HTTPException(500, "SESSION_SECRET is not set")
    return s.encode()


def auth_enabled() -> bool:
    """Locally, auth is off until APP_PASSWORD is set. On Vercel it is mandatory."""
    if os.environ.get("APP_PASSWORD"):
        return True
    if os.environ.get("VERCEL"):
        raise HTTPException(500, "APP_PASSWORD is not set in the Vercel project settings")
    return False


def sign(exp: int) -> str:
    return f"{exp}.{hmac.new(_secret(), f'v1.{exp}'.encode(), hashlib.sha256).hexdigest()}"


def valid_cookie(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    exp_s, _ = value.split(".", 1)
    try:
        exp = int(exp_s)
    except ValueError:
        return False
    return exp > time.time() and hmac.compare_digest(sign(exp), value)


def _bearer(request: Request) -> str:
    h = request.headers.get("authorization", "")
    return h[7:].strip() if h.lower().startswith("bearer ") else ""


def require_auth(request: Request) -> None:
    if not auth_enabled():
        return
    if valid_cookie(request.cookies.get(COOKIE)):
        return
    token = os.environ.get("HUB_TOKEN")
    if token and hmac.compare_digest(_bearer(request), token):
        return
    raise HTTPException(401, "Not signed in")


def require_cron(request: Request) -> None:
    secret = os.environ.get("CRON_SECRET")
    if not secret or not hmac.compare_digest(_bearer(request), secret):
        raise HTTPException(401, "Bad cron secret")


async def check_password(pw: str) -> bool:
    expected = os.environ.get("APP_PASSWORD", "")
    ok = bool(expected) and hmac.compare_digest(pw.encode(), expected.encode())
    if not ok:
        await asyncio.sleep(0.8)  # slow down guessing
    return ok


def new_cookie_value() -> str:
    return sign(int(time.time()) + MAX_AGE)
