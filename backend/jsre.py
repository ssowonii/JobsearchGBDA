"""Helpers that make Python's `re` and number formatting behave like JavaScript's.

The crawler's parsing rules were written as JS regexes. To keep behaviour identical we
compile them with ASCII semantics (JS `\\b`, `\\w`, `\\d` are ASCII-only) while widening
`\\s` to JS's Unicode whitespace set.
"""
from __future__ import annotations

import math
import re

_WS = "\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _translate(p: str) -> str:
    out = []
    i = 0
    in_class = False
    while i < len(p):
        c = p[i]
        if c == "\\" and i + 1 < len(p):
            n = p[i + 1]
            if n == "s":
                out.append(_WS if in_class else f"[{_WS}]")
            elif n == "S":
                out.append(f"[^{_WS}]" if not in_class else "\\S")
            else:
                out.append(p[i : i + 2])
            i += 2
            continue
        if c == "[" and not in_class:
            in_class = True
        elif c == "]" and in_class:
            in_class = False
        out.append(c)
        i += 1
    return "".join(out)


def rx(pattern: str, flags: str = "") -> re.Pattern:
    """Compile a JS-style regex. flags: any of 'i', 'm', 's'."""
    f = re.ASCII
    if "i" in flags:
        f |= re.IGNORECASE
    if "m" in flags:
        f |= re.MULTILINE
    if "s" in flags:
        f |= re.DOTALL
    return re.compile(_translate(pattern), f)


def js_round(x: float) -> float:
    """Math.round: halves round toward +infinity."""
    return math.floor(x + 0.5)


def js_num(v) -> str:
    """String(number) as JS prints it (25.0 -> '25', 52.5 -> '52.5')."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isfinite(v) and v.is_integer():
            return str(int(v))
        return repr(v)
    return str(v)


def num(v):
    """Collapse integral floats to int so JSON output matches JS (25 not 25.0)."""
    if isinstance(v, float) and math.isfinite(v) and v.is_integer():
        return int(v)
    return v


def parse_float(s: str) -> float:
    """parseFloat: leading numeric prefix, NaN if none."""
    m = re.match(r"\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)", s)
    return float(m.group(1)) if m else float("nan")
