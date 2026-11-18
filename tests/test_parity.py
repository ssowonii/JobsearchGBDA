"""Checks the Python port against outputs recorded from the original JS implementation
(tests/fixtures/js_parity.json: live postings from Greenhouse/Lever/Ashby/Workday + edge cases)."""
import json
import math
from pathlib import Path

import pytest

from backend import normalize as N
from backend.discovery import detect_boards

FX = json.loads((Path(__file__).parent / "fixtures" / "js_parity.json").read_text(encoding="utf-8"))


def same(a, b, path="$"):
    """Deep equality where 25 == 25.0 and floats compare approximately."""
    if isinstance(a, bool) or isinstance(b, bool):
        assert a == b, f"{path}: {a!r} != {b!r}"
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        assert math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9), f"{path}: {a!r} != {b!r}"
    elif isinstance(a, dict) and isinstance(b, dict):
        assert set(a) == set(b), f"{path}: keys {sorted(set(a) ^ set(b))}"
        for k in a:
            same(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), f"{path}: len {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            same(x, y, f"{path}[{i}]")
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


@pytest.mark.parametrize("i", range(len(FX["raws"])))
def test_normalize_job(i):
    same(N.normalize_job(FX["raws"][i]), FX["normalized"][i])


@pytest.mark.parametrize("case", FX["locations"] + FX["locationLists"], ids=lambda c: repr(c["in"]))
def test_locations(case):
    lst = case["in"] if isinstance(case["in"], list) else [case["in"]]
    same(N.parse_locations(lst), case["out"])


@pytest.mark.parametrize("case", FX["salaries"], ids=lambda c: c["in"][:40])
def test_salary(case):
    same(N.parse_salary_from_text(case["in"], "CAD"), case["out"])


@pytest.mark.parametrize("case", FX["terms"], ids=lambda c: c["in"][0])
def test_terms(case):
    same(N.detect_terms(*case["in"]), case["out"])


@pytest.mark.parametrize("case", FX["eligibility"], ids=lambda c: c["in"][:40])
def test_eligibility_ca(case):
    same(N.check_eligibility(N.parse_locations(["Toronto, ON"]), "onsite", case["in"]), case["out"])


@pytest.mark.parametrize("case", FX["eligibilityUS"], ids=lambda c: c["in"][:40])
def test_eligibility_us(case):
    same(N.check_eligibility(N.parse_locations(["Seattle, WA"]), "remote", case["in"]), case["out"])


@pytest.mark.parametrize("case", FX["html"], ids=lambda c: c["in"][:30])
def test_html_to_text(case):
    assert N.html_to_text(case["in"]) == case["out"]


@pytest.mark.parametrize("case", FX["hashes"], ids=lambda c: c["in"][:20])
def test_hash(case):
    assert N.hash_text(case["in"]) == case["out"]


@pytest.mark.parametrize("case", FX["workModes"], ids=lambda c: str(c["in"])[:40])
def test_work_mode(case):
    i = case["in"]
    assert N.detect_work_mode(i["hint"], i["locations"], i["text"]) == case["out"]


@pytest.mark.parametrize("case", FX["boards"], ids=lambda c: c["in"])
def test_detect_boards(case):
    same(detect_boards(case["in"]), case["out"])
