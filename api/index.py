"""Vercel Python function entrypoint: every /api/* request is rewritten here (see next.config.ts)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.main import app  # noqa: E402,F401
