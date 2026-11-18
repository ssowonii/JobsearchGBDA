"""Adapters for public applicant-tracking-system (ATS) job APIs + a generic schema.org
JobPosting (JSON-LD) extractor. Each adapter returns "raw" jobs for normalize_job()."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import quote

from .companies import company_key
from .http_client import HTTPError, get_json, map_limit, request, sleep
from .jsre import rx
from .normalize import html_to_text, is_student_role, js_trim

RELEVANT_TITLE = rx(r"\b(market\w*|brand\w*|content|social|media|design\w*|ux|ui|creative|communicat\w*|video|growth|community|events?|copy\w*|writer|editor\w*|digital (marketing|media|content|design)|e-?commerce|public relations|campaigns?|graphic|visual|storytell\w*|partnerships?)\b", "i")
NOT_RELEVANT = rx(r"\b(engineer\w*|developer|devops|software|accountant|accounting|legal|counsel|finance|financial|data scien\w*|machine learning|sales associate|educator|store|warehouse|driver)\b", "i")
SENIOR = rx(r"\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|vice president|chief|executive)\b", "i")


def wanted(title: Any, hints: list, opts: dict) -> bool:
    """Decide whether to keep a listing before fetching its (expensive) details."""
    title = "" if title is None else str(title)
    if is_student_role(title, hints):
        return True
    # "include non-intern roles": entry-level roles in your fields only
    if opts.get("studentOnly") is False:
        return bool(RELEVANT_TITLE.search(title)) and not NOT_RELEVANT.search(title) and not SENIOR.search(title)
    return False


def interval_map(s: Any = "") -> str:
    s = str(s if s is not None else "undefined").lower()
    if "hour" in s:
        return "hour"
    if "month" in s:
        return "month"
    if "week" in s:
        return "week"
    if rx("year|annual|salary").search(s):
        return "year"
    return ""


def _get(d: Any, *path, default=None):
    for p in path:
        if not isinstance(d, dict):
            return default
        d = d.get(p)
        if d is None:
            return default
    return d


def _uniq(xs):
    return list(dict.fromkeys(xs))


def _iso_ms(ms) -> str:
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


Log = Callable[[str], None]


# ---------------- Greenhouse ----------------
async def greenhouse(c: dict, opts: dict):
    base = f"https://boards-api.greenhouse.io/v1/boards/{c['slug']}"
    data = await get_json(f"{base}/jobs?content=true")
    lst = [j for j in (data.get("jobs") or []) if wanted(j.get("title"), [], opts)]

    async def one(j):
        salary = None
        try:
            d = await get_json(f"{base}/jobs/{j['id']}?pay_transparency=true")
            r = (d.get("pay_input_ranges") or [None])[0]
            if r:
                salary = {"min": r["min_cents"] / 100, "max": r["max_cents"] / 100, "currency": r.get("currency_type"), "interval": interval_map(r.get("title")) or ""}
        except Exception:
            pass
        locs = [x for x in [_get(j, "location", "name"), *[(o.get("location") or o.get("name")) for o in (j.get("offices") or [])]] if x]
        return {
            "source": "greenhouse", "companyKey": company_key(c), "company": c["name"], "extId": j["id"], "title": j.get("title"),
            "url": j.get("absolute_url"), "applyUrl": j.get("absolute_url"), "locations": _uniq(locs),
            "descriptionHtml": j.get("content"), "salary": salary, "postedAt": j.get("first_published") or j.get("updated_at"),
        }

    return await map_limit(lst, 4, one)


# ---------------- Lever ----------------
async def lever(c: dict, opts: dict):
    host = "api.eu.lever.co" if c.get("region") == "eu" else "api.lever.co"
    data = await get_json(f"https://{host}/v0/postings/{c['slug']}?mode=json")
    out = []
    for j in data:
        cats = j.get("categories") or {}
        if not wanted(j.get("text"), [cats.get("commitment")], opts):
            continue
        lists = "\n\n".join(f"{l.get('text')}\n{html_to_text(l.get('content'))}" for l in (j.get("lists") or []))
        sr = j.get("salaryRange")
        out.append({
            "source": "lever", "companyKey": company_key(c), "company": c["name"], "extId": j.get("id"), "title": j.get("text"),
            "url": j.get("hostedUrl"), "applyUrl": j.get("applyUrl") or j.get("hostedUrl"),
            "locations": cats.get("allLocations") if cats.get("allLocations") else [cats.get("location")],
            "workModeHint": j.get("workplaceType"), "employmentType": cats.get("commitment"),
            "description": "\n\n".join(x for x in [j.get("descriptionPlain"), lists, j.get("additionalPlain")] if x),
            "salary": {"min": sr.get("min"), "max": sr.get("max"), "currency": sr.get("currency"), "interval": interval_map(sr.get("interval"))} if sr else None,
            "salaryText": j.get("salaryDescriptionPlain") or "",
            "postedAt": _iso_ms(j["createdAt"]) if j.get("createdAt") else "",
        })
    return out


# ---------------- Ashby ----------------
_COMP_TYPE = rx(r"salary|hourly|wage", "i")


async def ashby(c: dict, opts: dict):
    data = await get_json(f"https://api.ashbyhq.com/posting-api/job-board/{c['slug']}?includeCompensation=true")
    out = []
    for j in data.get("jobs") or []:
        if j.get("isListed") is False or not wanted(j.get("title"), [j.get("employmentType")], opts):
            continue
        comps = _get(j, "compensation", "summaryComponents", default=[]) or []
        comp = next((x for x in comps if _COMP_TYPE.search(str(x.get("compensationType"))) and (x.get("minValue") or x.get("maxValue"))), None)
        out.append({
            "source": "ashby", "companyKey": company_key(c), "company": c["name"], "extId": j.get("id"), "title": j.get("title"),
            "url": j.get("jobUrl"), "applyUrl": j.get("applyUrl") or j.get("jobUrl"),
            "locations": [j.get("location"), *[s.get("location") for s in (j.get("secondaryLocations") or [])]],
            "workModeHint": j.get("workplaceType") or ("remote" if j.get("isRemote") else ""), "employmentType": j.get("employmentType"),
            "description": j.get("descriptionPlain") or html_to_text(j.get("descriptionHtml")),
            "salary": {"min": comp.get("minValue"), "max": comp.get("maxValue"), "currency": comp.get("currencyCode"), "interval": interval_map(comp.get("interval"))} if comp else None,
            "salaryText": _get(j, "compensation", "scrapeableCompensationSalarySummary") or "",
            "postedAt": j.get("publishedAt"),
        })
    return out


# ---------------- SmartRecruiters ----------------
async def smartrecruiters(c: dict, opts: dict):
    slug = c["slug"]
    allp: list = []
    for offset in range(0, 1000, 100):
        d = await get_json(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset={offset}")
        allp.extend(d.get("content") or [])
        if not d.get("content") or len(allp) >= (d.get("totalFound") or 0):
            break
    lst = [j for j in allp if wanted(j.get("name"), [_get(j, "experienceLevel", "id"), _get(j, "typeOfEmployment", "label")], opts)]

    async def one(j):
        desc, apply_url = "", ""
        url = f"https://jobs.smartrecruiters.com/{slug}/{j['id']}"
        try:
            d = await get_json(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{j['id']}")
            s = _get(d, "jobAd", "sections", default={}) or {}
            desc = "\n\n".join(x for x in (html_to_text(_get(s, k, "text") or "") for k in ["jobDescription", "qualifications", "additionalInformation", "companyDescription"]) if x)
            apply_url = d.get("applyUrl")
            url = d.get("postingUrl") or url
        except Exception:
            pass
        L = j.get("location") or {}
        country = L.get("country")
        loc = L.get("fullLocation") or ", ".join(str(x) for x in [L.get("city"), L.get("region"), "Canada" if str(country or "").upper() == "CA" else country] if x)
        return {
            "source": "smartrecruiters", "companyKey": company_key(c), "company": _get(j, "company", "name") or c["name"], "extId": j.get("id"), "title": j.get("name"),
            "url": url, "applyUrl": apply_url or url, "locations": [loc],
            "workModeHint": "hybrid" if L.get("hybrid") else ("remote" if L.get("remote") else ""),
            "employmentType": _get(j, "typeOfEmployment", "label"), "hints": [_get(j, "experienceLevel", "id")],
            "description": desc, "postedAt": j.get("releasedDate"),
        }

    return await map_limit(lst, 4, one)


# ---------------- Workday ----------------
_CAN_USA = rx(r"\bCAN\b|\bUSA\b")


async def workday(c: dict, opts: dict):
    host = f"{c['slug']}.myworkdayjobs.com"
    tenant = c["slug"].split(".")[0]
    api = f"https://{host}/wday/cxs/{tenant}/{c['site']}"
    queries = (["intern", "co-op", "student", "marketing", "content", "design", "communications", "social media"]
               if opts.get("studentOnly") is False else ["intern", "co-op", "student", "summer 2027", "winter 2027"])
    seen: dict[str, dict] = {}
    for q in queries:
        for offset in range(0, 200, 20):
            res = await request(f"{api}/jobs", method="POST", body={"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": q})
            if not res.ok:
                raise HTTPError(f"Workday HTTP {res.status}", res.status)
            d = json.loads(res.text)
            for p in d.get("jobPostings") or []:
                if p.get("externalPath") and p["externalPath"] not in seen:
                    seen[p["externalPath"]] = p
            if not d.get("jobPostings") or offset + 20 >= (d.get("total") or 0):
                break
            await sleep(0.35)
    lst = [p for p in seen.values() if wanted(p.get("title"), [], opts)]
    if opts.get("log"):
        opts["log"](f"  {c['name']}: {len(lst)} matching postings, fetching details…")
    out = []
    for p in lst:
        try:
            res = await request(f"{api}{p['externalPath']}")
            if res.ok:
                info = json.loads(res.text).get("jobPostingInfo") or {}
                ext = info.get("externalUrl") or f"https://{host}/{c['site']}{p['externalPath']}"
                out.append({
                    "source": "workday", "companyKey": company_key(c), "company": c["name"], "extId": info.get("jobReqId") or p["externalPath"], "title": info.get("title") or p.get("title"),
                    "url": ext, "applyUrl": ext + "/apply",
                    "locations": [x for x in [info.get("location"), *(info.get("additionalLocations") or [])] if x],
                    "workModeHint": info.get("remoteType") or "", "employmentType": info.get("timeType"),
                    "descriptionHtml": info.get("jobDescription"), "postedAt": info.get("startDate"), "deadline": info.get("endDate") or "",
                    "countryHint": _get(info, "country", "descriptor"),
                })
        except Exception:
            pass
        await sleep(0.3)
    # Workday city strings often lack the country; append it so location parsing works.
    for j in out:
        ch = j.pop("countryHint", None)
        if ch and j["locations"] and ch.lower() not in j["locations"][0].lower() and not _CAN_USA.search(j["locations"][0]):
            j["locations"][0] += f", {ch}"
    return out


# ---------------- Workable ----------------
async def workable(c: dict, opts: dict):
    slug = c["slug"]
    res = await request(f"https://apply.workable.com/api/v3/accounts/{slug}/jobs", method="POST", body={"query": "", "location": [], "department": [], "worktype": [], "remote": []})
    if not res.ok:
        raise HTTPError(f"Workable HTTP {res.status}", res.status)
    lst = [j for j in (json.loads(res.text).get("results") or []) if wanted(j.get("title"), [j.get("type")], opts)]

    async def one(j):
        desc = ""
        try:
            d = await get_json(f"https://apply.workable.com/api/v2/accounts/{slug}/jobs/{j['shortcode']}")
            desc = html_to_text("\n".join(x for x in [d.get("description"), d.get("requirements"), d.get("benefits")] if x))
        except Exception:
            pass
        L = j.get("location") or {}
        url = f"https://apply.workable.com/{slug}/j/{j['shortcode']}/"
        return {
            "source": "workable", "companyKey": company_key(c), "company": c["name"], "extId": j["shortcode"], "title": j.get("title"),
            "url": url, "applyUrl": url + "apply/", "locations": [", ".join(str(x) for x in [L.get("city"), L.get("region"), L.get("country")] if x)],
            "workModeHint": j.get("workplace") or ("remote" if j.get("remote") else ""), "description": desc, "postedAt": j.get("published"),
        }

    return await map_limit(lst, 3, one)


# ---------------- Avature (many big consumer brands, e.g. lululemon) ----------------
_AV_LINK = rx(r'href="(https?:\/\/[^"]+\/JobDetail\/[^"]+\/(\d+))"[^>]*>([^<]{3,})<')
_MAIN = rx(r"<main[\s\S]*<\/main>", "i")
_BODY = rx(r"<body[\s\S]*<\/body>", "i")
_DESC_START = rx(r"Description|Who We Are|About (the|this) (role|job)", "i")


def _enc(s: str) -> str:
    return quote(s, safe="-_.!~*'()")


async def avature(c: dict, opts: dict):
    base = f"https://{c['slug']}"
    queries = (["intern", "co-op", "student", "marketing", "content", "design", "social media", "brand", "creative"]
               if opts.get("studentOnly") is False else ["intern", "internship", "co-op", "student"])
    found: dict[str, dict] = {}
    for q in queries:
        for offset in range(0, 60, 10):
            r = await request(f"{base}/SearchJobs/{_enc(q)}?jobRecordsPerPage=10&jobOffset={offset}", headers={"Accept": "text/html"})
            if not r.ok:
                raise HTTPError(f"Avature HTTP {r.status}", r.status)
            n = 0
            for m in _AV_LINK.finditer(r.text):
                n += 1
                if m.group(2) not in found:
                    found[m.group(2)] = {"url": m.group(1), "id": m.group(2), "title": html_to_text(m.group(3))}
            if n < 10:
                break
            await sleep(0.3)
    lst = [j for j in found.values() if wanted(j["title"], [], opts)][:80]
    if opts.get("log"):
        opts["log"](f"  {c['name']}: {len(lst)} matching postings, fetching details…")

    async def one(j):
        r = await request(j["url"], headers={"Accept": "text/html"})
        lds = extract_json_ld_jobs(r.text, j["url"])
        ld = lds[0] if lds else None
        mm = _MAIN.search(r.text) or _BODY.search(r.text)
        text = html_to_text(mm.group(0) if mm else "")

        def field(label):
            m = rx(f"(?:^|\\n){label}:?\\s*\\n+([^\\n]{{2,80}})", "i").search(text)
            return js_trim(m.group(1)) if m else ""

        loc = [x for x in [field("City"), field("State/Province/City") or field("State"), field("Location") or field("Country")] if x]
        ds = _DESC_START.search(text)
        parts = j["title"].split("|")
        return {
            "source": "avature", "companyKey": company_key(c), "company": c["name"], "extId": j["id"], "title": j["title"],
            "url": j["url"], "applyUrl": j["url"],
            "locations": ld["locations"] if ld and ld.get("locations") else [", ".join(_uniq(loc)) or js_trim(parts[1] if len(parts) > 1 else "")],
            "description": html_to_text(ld.get("descriptionHtml")) if ld else text[(ds.start() if ds else 0):][:15000],
            "salary": ld.get("salary") if ld else None, "postedAt": (ld.get("postedAt") if ld else "") or "",
        }

    return await map_limit(lst, 3, one)


ADAPTERS = {"greenhouse": greenhouse, "lever": lever, "ashby": ashby, "smartrecruiters": smartrecruiters, "workday": workday, "workable": workable, "avature": avature}


async def fetch_company_jobs(c: dict, opts: dict | None = None) -> list[dict]:
    fn = ADAPTERS.get(c.get("ats"))
    if not fn:
        raise ValueError(f"Unknown ATS: {c.get('ats')}")
    return [x for x in await fn(c, opts or {}) if x and not (isinstance(x, dict) and x.get("error"))]


# ---------------- Generic JSON-LD JobPosting ----------------
_LDJSON = rx(r"<script[^>]+type=[\"']application\/ld\+json[\"'][^>]*>([\s\S]*?)<\/script>", "i")
_TELE = rx(r"telecommute", "i")


def _arr(v) -> list:
    if v is None or v == "" or v is False or v == 0:
        return []
    return v if isinstance(v, list) else [v]


def extract_json_ld_jobs(html: str, page_url: str) -> list[dict]:
    out = []
    for m in _LDJSON.finditer(html or ""):
        try:
            data = json.loads(js_trim(m.group(1)))
        except ValueError:
            continue
        stack = list(data) if isinstance(data, list) else [data]
        while stack:
            n = stack.pop()
            if not isinstance(n, dict):
                continue
            if isinstance(n.get("@graph"), list):
                stack.extend(n["@graph"])
            if "JobPosting" in _arr(n.get("@type")):
                out.append(_from_json_ld(n, page_url))
    return out


def _from_json_ld(n: dict, page_url: str) -> dict:
    locs = []
    for l in _arr(n.get("jobLocation")):
        a = (l.get("address") if isinstance(l, dict) else None) or {}
        if isinstance(a, str):
            locs.append(a)
        else:
            ac = a.get("addressCountry")
            locs.append(", ".join(str(x) for x in [a.get("addressLocality"), a.get("addressRegion"), ac.get("name") if isinstance(ac, dict) else ac] if x))
    jlt = str(n.get("jobLocationType") or "")
    if _TELE.search(jlt):
        req = _get(n, "applicantLocationRequirements", "name")
        locs.append(f"Remote{' - ' + req if req else ''}")
    bs = n.get("baseSalary")
    v = (bs.get("value") if isinstance(bs, dict) else None) or {}
    if not isinstance(v, dict):
        v = {"value": v}
    salary = None
    if bs:
        salary = {"min": v["minValue"] if v.get("minValue") is not None else v.get("value"),
                  "max": v["maxValue"] if v.get("maxValue") is not None else v.get("value"),
                  "currency": bs.get("currency") if isinstance(bs, dict) else None, "interval": interval_map(v.get("unitText"))}
    ho = n.get("hiringOrganization")
    org = ho.get("name") if isinstance(ho, dict) else ho
    url = n.get("url") or page_url
    ident = n.get("identifier")
    ext = (ident.get("value") if isinstance(ident, dict) else None) or ident or url
    return {
        "source": "web", "company": org or "", "extId": ext if not isinstance(ext, dict) else url, "title": n.get("title"),
        "url": url, "applyUrl": url, "locations": locs, "workModeHint": "remote" if _TELE.search(jlt) else "",
        "descriptionHtml": n.get("description"), "salary": salary, "employmentType": ", ".join(str(x) for x in _arr(n.get("employmentType"))),
        "postedAt": n.get("datePosted"), "deadline": n.get("validThrough") or "",
    }
