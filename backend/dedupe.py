"""Merge the same role found on several sites (e.g. a company's Greenhouse board and LinkedIn).

Two postings are the same role when the company and title match (ignoring case, punctuation, legal
suffixes and "Remote"/"Hybrid" tags), they come from different sources, and their locations overlap.
Postings from the same source are never merged: an ATS that lists one title twice (RBC branch roles,
two Manulife requisitions) has two real postings with their own application links.

The copy that stays is the company's own careers site when there is one, otherwise the oldest.
Your status, notes, deadline and review choice carry over to it.
"""
from __future__ import annotations

import re
from typing import Any

# The company's own applicant-tracking system (or careers site) beats a job board's copy.
ATS_SOURCES = {"greenhouse", "lever", "ashby", "workday", "smartrecruiters", "workable", "avature", "web"}
BOARD_SOURCES = {
    "linkedin", "indeed", "glassdoor", "eluta", "talent", "jobbank", "charityvillage", "weworkremotely",
    "remotive", "himalayas", "jobicy", "remoteok", "workingnomads", "wellfound", "dribbble",
}

_LEGAL = re.compile(r"\b(incorporated|inc|ltd|limited|llc|llp|corp|corporation|co|company|plc|gmbh|lp)\b\.?", re.I)
_MODE_TAG = re.compile(r"\b(remote|hybrid|on-?site|in-?person|work from home|wfh)\b", re.I)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def company_norm(name: str) -> str:
    return _NON_ALNUM.sub("", _LEGAL.sub(" ", (name or "").lower()))


def title_norm(title: str) -> str:
    return _NON_ALNUM.sub("", _MODE_TAG.sub(" ", (title or "").lower()))


def source_rank(source: str) -> int:
    s = (source or "").lower()
    if s in ATS_SOURCES:
        return 3
    if s in BOARD_SOURCES:
        return 1
    return 2 if s and s != "manual" else 1


def _cities(j: dict) -> set[str]:
    loc = j.get("location") or {}
    return {str(c).strip().lower() for c in (loc.get("cities") or []) if str(c).strip()}


def locations_overlap(a: dict, b: dict) -> bool:
    """Unknown or remote-only locations overlap anything; otherwise the cities must share one."""
    ca, cb = _cities(a), _cities(b)
    if not ca or not cb:
        return True
    if ca & cb:
        return True
    return a.get("workMode") == "remote" and b.get("workMode") == "remote"


_REVIEW_ORDER = {"": 0, "dismissed": 1, "pending": 2}  # in the hub > passed on > waiting


def merged_state(keep: dict, others: list[dict]) -> dict[str, Any]:
    """The survivor's tracking data after absorbing the duplicates."""
    app = dict(keep.get("app") or {})
    for o in others:
        oa = o.get("app") or {}
        if (app.get("status") or "none") == "none" and (oa.get("status") or "none") != "none":
            app = {**oa, "notes": app.get("notes") or oa.get("notes") or ""}
        elif oa.get("notes") and oa.get("notes") not in (app.get("notes") or ""):
            app["notes"] = "\n".join(x for x in (app.get("notes"), oa.get("notes")) if x)
        if not app.get("deadline") and oa.get("deadline"):
            app["deadline"] = oa["deadline"]
    reviews = [keep.get("review") or "", *(o.get("review") or "" for o in others)]
    return {
        "app": app,
        "review": min(reviews, key=lambda r: _REVIEW_ORDER.get(r, 2)),
        "dream": any(bool(x.get("dream")) for x in [keep, *others]),
        "manual": any(bool(x.get("manual")) for x in [keep, *others]),
        "active": any(x.get("active") is not False for x in [keep, *others]),
    }


def plan_merges(jobs: list[dict]) -> list[tuple[dict, list[dict]]]:
    """Group duplicate postings. Returns (survivor, [duplicates to fold into it]) for each group that has any."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for j in jobs:
        key = (company_norm(j.get("company", "")), title_norm(j.get("title", "")))
        if key[0] and key[1]:
            groups.setdefault(key, []).append(j)
    plans = []
    for group in groups.values():
        if len({(g.get("source") or "") for g in group}) < 2:
            continue
        # best source first, then the posting you're tracking, then the oldest
        group.sort(key=lambda g: (
            -source_rank(g.get("source", "")),
            (g.get("app") or {}).get("status", "none") == "none",
            g.get("firstSeen") or "",
        ))
        survivors: list[tuple[dict, list[dict]]] = []
        for j in group:
            home = next((s for s in survivors
                         if s[0].get("source") != j.get("source")
                         and all(d.get("source") != j.get("source") for d in s[1])
                         and locations_overlap(s[0], j)), None)
            if home:
                home[1].append(j)
            else:
                survivors.append((j, []))
        plans += [s for s in survivors if s[1]]
    return plans
