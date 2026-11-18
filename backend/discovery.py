"""Dream-company discovery: given a company name or careers URL, find which ATS job board(s)
it uses (probe board APIs, then crawl its website/careers pages), fall back to schema.org
JobPosting data, crawl what was found and save the board for future refreshes."""
from __future__ import annotations

import asyncio
import unicodedata
from urllib.parse import unquote, urljoin, urlparse

from . import store
from .companies import company_key
from .crawl import RunLog, crawl_one, finalize
from .http_client import get_json, map_limit, request
from .jsre import rx
from .normalize import decode_entities, html_to_text, js_trim, normalize_job, parse_locations
from .sources import extract_json_ld_jobs, wanted
from .store import AsyncConn


def _d(m, i):
    return decodeURIComponent(m.group(i))


def decodeURIComponent(s: str) -> str:  # noqa: N802 - mirrors JS name
    return unquote(s, errors="strict")


ATS_PATTERNS = [
    (rx(r"greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)", "i"), lambda m: {"ats": "greenhouse", "slug": m.group(1)}),
    (rx(r"(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)", "i"), lambda m: {"ats": "greenhouse", "slug": m.group(1)}),
    (rx(r"jobs(\.eu)?\.lever\.co\/([\w.-]+)", "i"), lambda m: {"ats": "lever", "slug": m.group(2), **({"region": "eu"} if m.group(1) else {})}),
    (rx(r"jobs\.ashbyhq\.com\/([\w.%-]+)", "i"), lambda m: {"ats": "ashby", "slug": _d(m, 1)}),
    (rx(r"(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)", "i"), lambda m: {"ats": "smartrecruiters", "slug": m.group(1)}),
    (rx(r"([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)", "i"), lambda m: {"ats": "workday", "slug": f"{m.group(1)}.{m.group(2)}", "site": m.group(3)}),
    (rx(r"apply\.workable\.com\/([\w-]+)", "i"), lambda m: {"ats": "workable", "slug": m.group(1)}),
    (rx(r"https?:\/\/([\w.-]+\/(?:[a-z]{2}_[A-Z]{2}\/)?[\w-]+)\/(?:SearchJobs|SearchCareer|JobDetail)\b"), lambda m: {"ats": "avature", "slug": m.group(1)}),
]
BAD_SLUGS = {"embed", "v1", "api", "j", "jobs", "job", "wday", "login", "apply", "static", "assets", "cxs", "en-us", "favicon.ico", "search"}
_EN = rx(r"en_(US|CA)")


def detect_boards(text: str) -> list[dict]:
    found: dict[str, dict] = {}
    for r, fn in ATS_PATTERNS:
        for m in r.finditer(str(text)):
            try:
                b = fn(m)
            except Exception:
                continue
            if not b.get("slug") or b["slug"].lower() in BAD_SLUGS or (b.get("site") and b["site"].lower() in BAD_SLUGS):
                continue
            if b["ats"] == "avature":
                # same portal appears with and without a locale; prefer the English one
                host = f"avature:{b['slug'].split('/')[0]}"
                prev = found.get(host)
                if not prev or (_EN.search(b["slug"]) and not _EN.search(prev["slug"])):
                    found[host] = b
                continue
            found[company_key(b)] = b
    return list(found.values())


def dedupe_boards(lst: list[dict]) -> list[dict]:
    out: dict[str, dict] = {}
    for b in lst:
        key = f"avature:{b['slug'].split('/')[0]}" if b["ats"] == "avature" else company_key(b)
        prev = out.get(key)
        if not prev or (b["ats"] == "avature" and _EN.search(b["slug"]) and not _EN.search(prev["slug"])):
            out[key] = b
    return list(out.values())


_CORP = rx(r"\b(inc|ltd|llc|corp|corporation|co|company|canada|group|limited)\b\.?")
_NONWORD = rx(r"[^\w\s-]")


def slugify(s: str) -> str:
    s = _CORP.sub("", s.lower())
    s = unicodedata.normalize("NFKD", s)
    return js_trim(_NONWORD.sub("", s))


async def probe_slugs(name: str) -> list[dict]:
    base = slugify(name)
    cands = [rx(r"[\s-]+").sub("", base), rx(r"\s+").sub("-", base), rx(r"\s+").split(base)[0]]
    slugs = list(dict.fromkeys(s for s in cands if len(s) > 1))

    async def gh(slug):
        d = await get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}")
        return {"ats": "greenhouse", "slug": slug, "name": d.get("name")}

    async def lv(slug):
        d = await get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json&limit=1")
        return {"ats": "lever", "slug": slug} if isinstance(d, list) and d else None

    async def ab(slug):
        d = await get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")
        return {"ats": "ashby", "slug": slug} if d.get("jobs") else None

    async def sr(slug):
        d = await get_json(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=1")
        if (d.get("totalFound") or 0) > 0:
            content = d.get("content") or [{}]
            return {"ats": "smartrecruiters", "slug": slug, "name": (content[0].get("company") or {}).get("name")}
        return None

    probes = [f(s) for s in slugs for f in (gh, lv, ab, sr)]
    res = await asyncio.gather(*probes, return_exceptions=True)
    return [r for r in res if isinstance(r, dict) and r]


def guess_websites(name: str) -> list[str]:
    """Search engines block automated lookups, so guess the company's domains instead."""
    slug = rx(r"[\s-]+").sub("", slugify(name))
    return [f"https://careers.{slug}.com", f"https://jobs.{slug}.com", f"https://www.{slug}.com/careers", f"https://www.{slug}.com", f"https://www.{slug}.ca/careers", f"https://www.{slug}.ca"]


_H1 = rx(r"<h1[^>]*>([\s\S]*?)<\/h1>", "i")
_MAIN = rx(r"<main[\s\S]*<\/main>", "i")
_BODY = rx(r"<body[\s\S]*<\/body>", "i")
_SENT_END = rx(r"[.!?]\Z")


def _meta(html: str, prop: str) -> str:
    m = rx(f"<meta[^>]+(?:property|name)=[\"']{prop}[\"'][^>]+content=[\"']([^\"']*)", "i").search(html)
    return decode_entities(m.group(1) if m else "")


def generic_job_page(html: str, url: str, fallback_title: str) -> dict:
    """Best-effort reading of a plain HTML job page (no structured data)."""
    h1m = _H1.search(html)
    h1 = html_to_text(h1m.group(1) if h1m else "")
    mm = _MAIN.search(html) or _BODY.search(html)
    main = html_to_text(mm.group(0) if mm else "")
    title = h1 or _meta(html, "og:title") or fallback_title
    loc_line = next((x for x in (js_trim(y) for y in main.split("\n"))
                     if len(x) < 90 and x != title and x not in title and parse_locations([x])["country"] != "UNKNOWN" and not _SENT_END.search(x)), None)
    return {"source": "web", "company": _meta(html, "og:site_name"), "extId": url, "title": title, "url": url, "applyUrl": url,
            "locations": [loc_line] if loc_line else [], "description": main[:15000]}


# attribute-aware: tolerates ">" inside quoted attributes (e.g. Tailwind classes)
ANCHOR = rx(r"<a\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>", "i")
_HREF = rx(r"\bhref\s*=\s*[\"']([^\"'#]+)[\"']", "i")
_CLOSE_A = rx(r"<\/a>", "i")
_CAREER = rx(r"career|jobs|join (us|our team)|work with us|opportunit|students|internship|early talent|university|campus|co-?op", "i")
_WS = rx(r"\s+")


def career_links(html: str, base: str) -> list[tuple[str, str]]:
    out: dict[str, str] = {}
    for m in ANCHOR.finditer(html):
        hm = _HREF.search(m.group(1))
        if not hm:
            continue
        href = hm.group(1)
        inner = _CLOSE_A.split(html[m.end() : m.end() + 4000])[0]
        label = js_trim(_WS.sub(" ", html_to_text(inner))).lower()[:200]
        if _CAREER.search(href + " " + label):
            try:
                u = urljoin(base, decode_entities(href))
                if not urlparse(u).scheme.startswith("http"):
                    continue
                if u not in out or len(label) > len(out[u]):
                    out[u] = label
            except Exception:
                pass
    return list(out.items())


_HTMLDOC = rx(r"<html|<!doctype", "i")
_JOBLINK = rx(r"\/(jobs?|positions?|openings?|careers?)\/[\w-]*\d|\/job\/|jobid|requisition", "i")
_CAREER_HOST = rx(r"career|jobs")
_TRAIL_ID = rx(r"[_-][0-9a-f-]{8,}\Z", "i")
_DASHES = rx(r"[-_]+")


def _host(u: str) -> str:
    h = urlparse(u).hostname or ""
    return h[4:] if h.startswith("www.") else h


async def scan_site(start_urls: list[str], log, max_pages: int = 10, include_all: bool = False) -> dict:
    boards: dict[str, dict] = {}
    ld_jobs: list[dict] = []
    visited: set[str] = set()
    queue = list(start_urls)
    job_links: dict[str, str] = {}
    while queue and len(visited) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        try:
            res = await request(url, timeout=12, headers={"Accept": "text/html"})
        except Exception:
            continue
        if not res.ok or not _HTMLDOC.search(res.text[:2000]):
            continue
        log(f"  scanned {url}")
        for b in detect_boards(res.text + " " + res.url):
            boards[company_key(b)] = b
        ld_jobs.extend(extract_json_ld_jobs(res.text, res.url))
        host = _host(res.url)
        for l, label in career_links(res.text, res.url):
            found = detect_boards(l)
            if found:
                for b in found:
                    boards[company_key(b)] = b
                continue
            try:
                lh = _host(l)
                if lh.endswith(host) or host.endswith(lh) or _CAREER_HOST.search(lh):
                    if _JOBLINK.search(l):
                        job_links[l] = label
                    else:
                        queue.append(l)
            except Exception:
                pass
    # Generic fallback (custom careers sites): follow job links whose title looks relevant,
    # then read schema.org JobPosting markup, or failing that the page's own HTML.
    if not boards and job_links:
        def title_of(u, label):
            if label:
                return label
            last = unquote(urlparse(u).path.split("/")[-1])
            return _DASHES.sub(" ", _TRAIL_ID.sub("", last))

        picks = [(u, label) for u, label in job_links.items() if wanted(title_of(u, label), [], {"studentOnly": not include_all})][:40]
        log(f"  no ATS detected; {len(job_links)} job links on the site, {len(picks)} look relevant. Reading them…")

        async def read(pick):
            l, label = pick
            try:
                r = await request(l, timeout=15, headers={"Accept": "text/html"})
                if not r.ok:
                    return
                ld = extract_json_ld_jobs(r.text, r.url)
                ld_jobs.extend(ld if ld else [generic_job_page(r.text, r.url, title_of(l, label))])
            except Exception:
                pass

        await map_limit(picks, 3, read)
    return {"boards": list(boards.values()), "ldJobs": ld_jobs, "pagesScanned": len(visited)}


_IS_URL = rx(r"^https?:\/\/", "i")
_IS_DOMAIN = rx(r"^[\w-]+(\.[\w-]+)+(\/|\Z)")
_HOST_PREFIX = rx(r"^(www|careers|jobs)\.")
_CAREER_PATH = rx(r"career|job", "i")


async def crawl_dream_company(conn: AsyncConn, inp: str, include_all: bool = False, save: bool = True) -> dict:
    inp = js_trim(str(inp or ""))
    if not inp:
        raise ValueError("Enter a company name or careers URL")
    run = await store.create_run(conn, "dream", f"Searching {inp}", [])
    log = RunLog()
    try:
        result = await _dream(conn, inp, include_all, save, log)
        return await store.save_run(conn, run["id"], queue=[], log=log.lines, status="done", result=result)
    except Exception as e:  # noqa: BLE001
        log(f"✗ {e}")
        return await store.save_run(conn, run["id"], queue=[], log=log.lines, status="failed", error=str(e))


async def _dream(conn: AsyncConn, inp: str, include_all: bool, save: bool, log: RunLog) -> dict:
    is_url = bool(_IS_URL.search(inp) or _IS_DOMAIN.search(inp))
    url = (inp if _IS_URL.search(inp) else f"https://{inp}") if is_url else None
    name = _HOST_PREFIX.sub("", urlparse(url).hostname or "").split(".")[0] if url else inp
    display = name[:1].upper() + name[1:] if is_url else inp

    boards: dict[str, dict] = {}
    for b in detect_boards(url or ""):
        boards[company_key(b)] = b

    log(f'Checking public job boards (Greenhouse, Lever, Ashby, SmartRecruiters) for "{name}"…')
    for b in await probe_slugs(name):
        boards[company_key(b)] = b

    log("Crawling the company website for its careers page…")
    sites = [url] if url else guess_websites(inp)
    starts: list[str] = []
    for s in sites:
        starts.append(s)
        if url and not _CAREER_PATH.search(s):
            p = urlparse(s)
            o = f"{p.scheme}://{p.netloc}"
            starts += [f"{o}/careers", f"{o}/jobs"]
    scan = await scan_site(starts, log, 12 if url else 14, include_all)
    for b in scan["boards"]:
        boards[company_key(b)] = b

    board_list = [{**b, "name": b.get("name") or display, "dream": True} for b in dedupe_boards(list(boards.values()))]
    if board_list:
        log("Found job board(s): " + ", ".join(f"{b['ats']}/{b['slug']}{'/' + b['site'] if b.get('site') else ''}" for b in board_list))
    else:
        log("No ATS job board detected.")

    ids: list[str] = []
    opts = {"studentOnly": not include_all, "relevantOnly": True, "keepNonCanada": False, "dream": True, "noPrune": True}
    for b in board_list:
        try:
            kept, got = await crawl_one(conn, b, opts, log)
            ids += got
            log(f"✓ {b['ats']}/{b['slug']}: {kept} {'relevant' if include_all else 'student'} role(s)")
            if save:
                c = {"name": b["name"], "ats": b["ats"], "slug": b["slug"], "dream": True}
                if b.get("site"):
                    c["site"] = b["site"]
                if b.get("region"):
                    c["region"] = b["region"]
                await store.add_company(conn, c)
        except Exception as e:  # noqa: BLE001
            log(f"✗ {b['ats']}/{b['slug']}: {e}")
    if not board_list and scan["ldJobs"]:
        log(f"Using {len(scan['ldJobs'])} posting(s) found via structured data on the website.")
        for r in scan["ldJobs"]:
            j = normalize_job({**r, "company": r.get("company") or display, "companyKey": f"web:{name}"})
            if not include_all and not j["student"]:
                continue
            j["dream"] = True
            j["review"] = "pending"
            await store.upsert_job(conn, j)
            ids.append(j["id"])
    found = len(ids)
    merged: dict[str, str] = {}
    removed = await finalize(conn, log, merged)
    ids = list(dict.fromkeys(merged.get(i, i) for i in ids if merged.get(i, i) not in removed))
    # You searched for this company on purpose, so roles you passed on before come back for review.
    states = await store.review_states(conn, ids)
    await store.set_review(conn, [i for i in ids if states.get(i) == "dismissed"], "pending")
    pending = [i for i in ids if states.get(i) in ("pending", "dismissed")]
    in_hub = len(ids) - len(pending)
    if ids:
        filtered = f" ({found - len(ids)} unrelated filtered out)" if found > len(ids) else ""
        if pending:
            msg = f"Found {len(ids)} role(s) at {display} that fit the resume{filtered}. Tick the ones to add to your hub." + (f" {in_hub} already in your hub." if in_hub else "")
        else:
            msg = f"Found {len(ids)} role(s) at {display} that fit the resume{filtered}; all are already in your hub."
    elif found:
        msg = f"{display} has {found} {'open' if include_all else 'intern/co-op'} role(s), but none fit the resume closely enough. It has been saved, so future refreshes will catch new postings."
    elif board_list:
        hint = "" if include_all else 'Try ticking "include non-intern roles".'
        msg = f"{display}'s job board has no {'relevant' if include_all else 'intern/co-op'} roles right now. {hint} It has been saved, so future refreshes will catch new postings."
    else:
        msg = f"Couldn't find a crawlable job board for {display}. Paste their careers page URL instead (e.g. https://company.com/careers), or add a posting manually."
    log(msg)
    return {"company": display, "boards": board_list, "ids": ids, "pending": pending if ids else [], "message": msg}
