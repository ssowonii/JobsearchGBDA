"""Turns raw postings from any source into one normalized shape, and derives:
location (Ontario/Canada), work mode, salary, co-op term, category, student level,
and work-authorization eligibility for a study-permit + co-op-permit holder.

Line-for-line port of the original server/normalize.js; tests/test_parity.py checks it
against outputs recorded from the JS version.
"""
from __future__ import annotations

import math
import re
from typing import Any

from .jsre import js_num, js_round, num, parse_float, rx

# ---------- text ----------
ENTITIES = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "ndash": "–", "mdash": "—",
    "rsquo": "’", "lsquo": "‘", "rdquo": "”", "ldquo": "“", "hellip": "…", "bull": "•", "middot": "·",
}
_ENTITY_RE = rx(r"&(#x?[0-9a-f]+|[a-z]+);", "i")


def _parse_int(s: str, base: int):
    digits = "0123456789abcdef"[:base]
    m = re.match(f"[{digits}]+", s, re.IGNORECASE)
    return int(m.group(0), base) if m else None


def decode_entities(s: str = "") -> str:
    def rep(m: re.Match) -> str:
        e = m.group(1)
        if e[0] == "#":
            code = _parse_int(e[2:], 16) if len(e) > 1 and e[1] in "xX" else _parse_int(e[1:], 10)
            if code is None or code > 0x10FFFF or 0xD800 <= code <= 0xDFFF:
                return m.group(0)
            return chr(code)
        return ENTITIES.get(e.lower(), m.group(0))

    return _ENTITY_RE.sub(rep, s or "")


_DOUBLE_ENC = rx(r"&lt;\/?[a-z]", "i")
_HAS_TAG = rx(r"<\/?[a-z]", "i")
_H2T = [
    (rx(r"<(script|style|noscript)[\s\S]*?<\/\1>", "i"), " "),
    (rx(r"<br\s*\/?>", "i"), "\n"),
    (rx(r"<li[^>]*>", "i"), "\n• "),
    (rx(r"<\/(p|div|h[1-6]|li|ul|ol|tr|section|article)>", "i"), "\n"),
    (rx(r"<[^>]+>"), " "),
]
_H2T_POST = [
    (rx("[ \t ]+"), " "),
    (rx(r" *\n *"), "\n"),
    (rx(r"\n{3,}"), "\n\n"),
]


def js_trim(s: str) -> str:
    return s.strip(" \t\n\r\v\f                 　﻿")


def html_to_text(html: Any = "") -> str:
    if not html:
        return ""
    s = str(html)
    if _DOUBLE_ENC.search(s) and not _HAS_TAG.search(s):
        s = decode_entities(s)
    for r, v in _H2T:
        s = r.sub(v, s)
    s = decode_entities(s)
    for r, v in _H2T_POST:
        s = r.sub(v, s)
    return js_trim(s)


# ---------- location ----------
ON_CITIES = ["toronto", "waterloo", "kitchener", "cambridge", "guelph", "mississauga", "brampton", "markham", "vaughan", "richmond hill", "oakville", "burlington", "hamilton", "ottawa", "kingston", "windsor", "oshawa", "barrie", "scarborough", "north york", "etobicoke", "pickering", "ajax", "whitby", "milton", "st. catharines", "niagara", "sudbury", "thunder bay", "peterborough", "concord", "thornhill", "newmarket", "aurora", "london, on"]
CA_CITIES = ["vancouver", "montreal", "montréal", "calgary", "edmonton", "winnipeg", "halifax", "quebec city", "québec", "victoria", "saskatoon", "regina", "burnaby", "surrey", "laval", "gatineau", "moncton", "fredericton", "st. john's", "charlottetown", "kelowna", "richmond, bc"]
CA_PROV_NAMES = rx(r"\b(ontario|british columbia|quebec|québec|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|nunavut|northwest territories)\b", "i")
CA_PROV_ABBR = rx(r"(?:^|[,\s(/-])(ON|BC|QC|AB|MB|SK|NS|NB|NL|PE|PEI|YT|NT|NU)(?=\Z|[,\s)/-])")
US_STATES = rx(r"\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b", "i")
US_ABBR = rx(r"(?:,\s*|\s)(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?=\Z|[,\s)])")
US_WORDS = rx(r"\b(united states|usa|u\.s\.a?\.?|us-remote|remote[\s-]*us|us only|san francisco|new york|seattle|chicago|austin|boston|los angeles|denver|atlanta|miami|houston|dallas|palo alto|menlo park|mountain view|sunnyvale|san jose|brooklyn|nyc|sf bay)\b", "i")
OTHER_COUNTRIES = rx(r"\b(united kingdom|uk|england|london(?!,?\s*(on|ontario))|ireland|dublin|germany|berlin|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|india|bangalore|bengaluru|japan|tokyo|singapore|australia|sydney|melbourne|brazil|mexico|korea|seoul|china|shanghai|hong kong|philippines|manila|sweden|stockholm|denmark|finland|norway|italy|portugal|lisbon|israel|uae|dubai|bulgaria|romania|ukraine|argentina|colombia|chile|new zealand|switzerland|zurich|belgium|austria|czech|vietnam|indonesia|malaysia|thailand|taiwan|emea|apac|latam|europe)\b", "i")
_REMOTE = rx(r"\b(remote|anywhere|work from home|wfh|distributed)\b")
# Remote regions that include Canada.
_OPEN_REGION = rx(r"\b(americas|north america|worldwide|world-?wide|global(ly)?|anywhere|international|any country|all countries)\b", "i")
# Description says a remote role can be done from Canada.
_CANADA_OK_TEXT = rx(
    r"\b(remote|work from|based)\b[^.\n]{0,80}\b(canada|north america|the americas|worldwide|anywhere in the world)\b"
    r"|\b(canada|canadian)\b[^.\n]{0,60}\b(remote|eligible|welcome|considered|encouraged to apply)\b"
    r"|\b(us|u\.s\.|usa|united states)\s*(or|and|/|&)\s*canada\b|\bcanada\s*(or|and|/|&)\s*(the\s+)?(us|u\.s\.|usa|united states)\b",
    "i",
)
# Description restricts the role to people in / authorized for the US.
_US_ONLY_TEXT = rx(
    r"\b(must|required to|need to)\s+(be\s+)?(reside|located|live|based|residing)\b[^.\n]{0,40}\b(united states|u\.s\.|usa|us)\b"
    r"|\bauthori[sz]ed to work in the (united states|u\.s\.|us)\b|\bus work authori[sz]ation\b|\b(us|u\.s\.) (citizens?|residents?) only\b"
    r"|\bonly (open|available) to (candidates|applicants|residents) (in|of|based in) the (us|u\.s\.|united states)\b",
    "i",
)
_ONTARIO = rx(r"\bontario\b")
_ON_ABBR = rx(r"(^|[,\s(])ON(\Z|[,\s)])")
_CANADA = rx(r"\bcanada\b|\bcan\b|canadian", "i")
_WORD_START = rx(r"\b\w")


def title_case(s: str) -> str:
    return _WORD_START.sub(lambda m: m.group(0).upper(), s)


def _prov_abbr(p: str) -> str:
    m = {"ontario": "ON", "british columbia": "BC", "quebec": "QC", "québec": "QC", "alberta": "AB", "manitoba": "MB", "saskatchewan": "SK", "nova scotia": "NS", "new brunswick": "NB", "newfoundland": "NL", "prince edward island": "PE"}
    return m.get(str(p).lower(), str(p).upper())


def _classify_loc(raw: Any) -> dict:
    s = js_trim(str(raw or ""))
    l = s.lower()
    remote = bool(_REMOTE.search(l))
    on_city = next((c for c in ON_CITIES if c in l), None)
    if on_city or _ONTARIO.search(l) or _ON_ABBR.search(s):
        return {"raw": s, "country": "CA", "province": "ON", "city": title_case(on_city.replace(", on", "")) if on_city else "", "remote": remote}
    ca_city = next((c for c in CA_CITIES if c in l), None)
    if ca_city or _CANADA.search(l) or CA_PROV_NAMES.search(l) or CA_PROV_ABBR.search(s):
        m1 = CA_PROV_ABBR.search(s)
        m2 = CA_PROV_NAMES.search(l)
        prov = (m1.group(1) if m1 else None) or (m2.group(1) if m2 else None) or ""
        return {"raw": s, "country": "CA", "province": _prov_abbr(prov), "city": title_case(ca_city) if ca_city else "", "remote": remote}
    if US_WORDS.search(l) or US_STATES.search(l) or US_ABBR.search(s):
        return {"raw": s, "country": "US", "province": "", "city": "", "remote": remote}
    if OTHER_COUNTRIES.search(l):
        return {"raw": s, "country": "OTHER", "province": "", "city": "", "remote": remote}
    return {"raw": s, "country": "REMOTE?" if remote else "UNKNOWN", "province": "", "city": "", "remote": remote}


def parse_locations(lst) -> dict:
    present = [x for x in (lst or []) if x]
    items = [_classify_loc(x) for x in present]
    ca = [i for i in items if i["country"] == "CA"]
    if ca:
        country = "CA"
    elif any(i["country"] == "US" for i in items):
        country = "US"
    elif any(i["country"] == "OTHER" for i in items):
        country = "OTHER"
    elif any(i["country"] == "REMOTE?" for i in items):
        country = "REMOTE?"
    else:
        country = "UNKNOWN"
    on = [i for i in ca if i["province"] == "ON"]
    cities = list(dict.fromkeys(i["city"] for i in ca if i["city"]))
    display = " · ".join(str(x) for x in present) or "Location not listed"
    return {
        "display": display[:137] + "…" if len(display) > 140 else display,
        "country": country,
        "isCanada": len(ca) > 0,
        "isOntario": len(on) > 0,
        "province": "ON" if on else (ca[0]["province"] if ca else ""),
        "cities": cities,
        "anyRemote": any(i["remote"] for i in items),
        "nonCanadaOnly": not ca and any(i["country"] in ("US", "OTHER") for i in items),
    }


def with_remote_from_canada(loc: dict, locations, work_mode: str, text: str = "") -> dict:
    """Flag remote roles that can be done from Canada (Remote – Americas/North America/Worldwide,
    "US or Canada", …) so they aren't dropped as non-Canada. US-only remote roles stay excluded."""
    t = (text or "")[:15000]
    # Hybrid/on-site roles need someone nearby, even if one listed location says "Remote".
    remote = work_mode == "remote" or (work_mode == "unknown" and loc.get("anyRemote"))
    us_only = bool(_US_ONLY_TEXT.search(t))
    open_region = any(_REMOTE.search(str(x).lower()) and _OPEN_REGION.search(str(x)) for x in locations if x)
    stated = bool(_CANADA_OK_TEXT.search(t))
    # US remote roles that don't say "US only" are kept (with a warning in eligibility): many US
    # employers can hire in Canada through an employer-of-record. Remote roles limited to other
    # regions (UK, EMEA, …) are only kept when the posting says Canada is OK.
    ok = bool(remote) and not us_only and (
        loc["isCanada"] or open_region or stated or loc["country"] in ("US", "REMOTE?", "UNKNOWN")
    )
    out = {**loc, "remoteFromCanada": ok, "remoteCanadaStated": bool(ok and (loc["isCanada"] or open_region or stated))}
    if ok:
        out["nonCanadaOnly"] = False
    return out


# ---------- work mode ----------
_WM_HYBRID = rx(r"hybrid")
_WM_REMOTE = rx(r"remote")
_WM_ONSITE = rx(r"on-?site|office|in.?person")
_WM_T_HYBRID = [
    rx(r"\bhybrid\b"),
    rx(r"\b(\d|two|three|four)\s*(?:days?)\s*(?:per|a|\/|each)\s*week\b[^.]{0,40}\b(office|on-?site|in[- ]person)"),
    rx(r"\b(office|on-?site|in[- ]person)\b[^.]{0,30}\b(\d|two|three|four)\s*days?\s*(?:per|a|\/|each)\s*week"),
]
_WM_LOC_REMOTE = rx(r"\b(remote|anywhere|work from home)\b")
_WM_T_REMOTE = rx(r"\b(fully remote|100% remote|remote[- ]first|this (is a |role is |position is )?(fully )?remote|remote (role|position|opportunity|internship|co-?op))\b")
_WM_T_ONSITE = rx(r"\b(on-?site|in[- ]office|in[- ]person)\b")


def _jsdot(p: re.Pattern, s: str) -> bool:
    # JS `.` also refuses \r,  ,  ; close enough for [^.] classes used here.
    return bool(p.search(s))


def detect_work_mode(hint: Any = None, locations=None, text: str = "") -> str:
    h = str(hint or "").lower()
    if _WM_HYBRID.search(h):
        return "hybrid"
    if _WM_REMOTE.search(h):
        return "remote"
    if _WM_ONSITE.search(h):
        return "onsite"
    loc = " ".join(str(x) for x in (locations or []) if x is not None).lower()
    if _WM_HYBRID.search(loc):
        return "hybrid"
    t = (text or "")[:8000].lower()
    if any(_jsdot(p, t) for p in _WM_T_HYBRID):
        return "hybrid"
    if _WM_LOC_REMOTE.search(loc):
        return "remote"
    if _WM_T_REMOTE.search(t):
        return "remote"
    if _WM_T_ONSITE.search(t):
        return "onsite"
    return "unknown"


# ---------- salary ----------
USD_TO_CAD = 1.38
HOURS = {"hour": 1, "week": 40, "month": 173.33, "year": 2080}


def _to_num(n, dec=None, k=None) -> float:
    v = parse_float(re.sub(r"[,\s]", "", str(n)) + ("." + dec if dec else ""))
    if k:
        v *= 1000
    return v


_IW = [(rx(r"hour|hr\b|hourly"), "hour"), (rx(r"week"), "week"), (rx(r"month"), "month"), (rx(r"year|annual|annum|yr\b|salary"), "year")]


def _interval_from_words(s) -> str:
    l = str(s or "").lower()
    for r, v in _IW:
        if r.search(l):
            return v
    return ""


def _interval_from_magnitude(mx: float) -> str:
    if mx <= 200:
        return "hour"
    if 1000 <= mx < 15000:
        return "month"
    if mx >= 15000:
        return "year"
    return ""


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _float(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def _gt0(v) -> bool:
    if isinstance(v, str):
        try:
            v = float(v)
        except ValueError:
            return False
    return _is_num(v) and not math.isnan(v) and v > 0


def format_salary(mn, mx, currency, interval) -> str:
    def f(v):
        if v >= 1000:
            return "$" + js_num(js_round(v / 100) / 10) + "k"
        return "$" + (js_num(v) if float(v).is_integer() else f"{v:.2f}")

    per = {"hour": "/hr", "week": "/wk", "month": "/mo", "year": "/yr"}.get(interval, "")
    rng = "–" + f(mx) if mx and mx != mn else ""
    cur = " " + currency if currency and currency != "CAD" else ""
    return f"{f(mn)}{rng}{per}{cur}"


def make_salary(min=None, max=None, currency=None, interval=None, text=None, **_) -> dict | None:
    mn, mx = min, max
    if mn is None and mx is None:
        return None
    mn = mx if mn is None else mn
    mx = mn if mx is None else mx
    if not _gt0(mn):
        return None
    mn, mx = _float(mn), _float(mx)
    if math.isnan(mx):
        return None
    interval = interval or _interval_from_magnitude(mx)
    if not interval:
        return None
    currency = (currency or "CAD").upper()
    fx = USD_TO_CAD if currency == "USD" else 1
    hmin = js_round(((mn * fx) / HOURS[interval]) * 100) / 100
    hmax = js_round(((mx * fx) / HOURS[interval]) * 100) / 100
    if hmax > 400 or hmin < 8:
        return None
    return {"min": num(mn), "max": num(mx), "currency": currency, "interval": interval, "hourlyMin": num(hmin), "hourlyMax": num(hmax), "text": format_salary(mn, mx, currency, interval), "raw": text or ""}


NUM = r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?"
CUR = r"(CA\$|C\$|CAD\s?\$?|US\$|USD\s?\$?|\$)"
RANGE_RE = rx(f"{CUR}\\s?{NUM}\\s*(CAD|USD)?\\s*(?:(?:\\/|per\\s)\\s*(?:hour|hr|h|year|yr|annum|month)\\b)?\\s*(?:-|–|—|to|and)\\s*(?:{CUR})?\\s?{NUM}\\s*(CAD|USD)?")
SINGLE_RE = rx(f"{CUR}\\s?{NUM}\\s*(CAD|USD)?\\s*(?:\\/|per|an|a)\\s*(hour|hr|year|yr|annum|month|week)", "i")
PAY_CONTEXT = rx(r"(salary|pay|compensation|wage|hourly|rate|range|base|per hour|\/hour|\/hr|annual|stipend|earn)", "i")
_FUNDING = rx(r"^\s*(million|billion|m\b|b\b|in funding|raised)", "i")
_LEADING_NONDIGITS = rx(r"^\D+")
_US = rx(r"US")
_CA = rx(r"CA|C\$")
_WS_RUN = rx(r"\s+")


def _g(m: re.Match, i: int) -> str:
    return m.group(i) or ""


def parse_salary_from_text(text: str = "", default_currency: str = "CAD") -> dict | None:
    if not text or "$" not in text:
        return None
    cands = []
    for m in RANGE_RE.finditer(text):
        after = text[m.end() : m.end() + 60]
        if _FUNDING.search(after):
            continue
        before = text[max(0, m.start() - 140) : m.start()]
        if _US.search(m.group(1) + _g(m, 5) + _g(m, 6) + _g(m, 10)):
            cur = "USD"
        elif _CA.search(m.group(1) + _g(m, 5) + _g(m, 10)):
            cur = "CAD"
        else:
            cur = default_currency
        mn = _to_num(m.group(2), m.group(3), m.group(4))
        k2 = m.group(9) or (m.group(4) if (m.group(4) and not m.group(9) and _to_num(m.group(7)) < 1000) else "")
        mx = _to_num(m.group(7), m.group(8), k2)
        interval = _interval_from_words(_LEADING_NONDIGITS.sub("", m.group(0), count=1)) or _interval_from_words(after[:30]) or _interval_from_words(before[-60:]) or ""
        ctx = bool(PAY_CONTEXT.search(before + after))
        cands.append({"min": mn, "max": mx, "currency": cur, "interval": interval, "score": (2 if ctx else 0) + (2 if interval else 0) + 0.5, "text": js_trim(m.group(0))})
    for m in SINGLE_RE.finditer(text):
        before = text[max(0, m.start() - 140) : m.start()]
        if _US.search(m.group(1) + _g(m, 5)):
            cur = "USD"
        elif _CA.search(m.group(1) + _g(m, 5)):
            cur = "CAD"
        else:
            cur = default_currency
        v = _to_num(m.group(2), m.group(3), m.group(4))
        cands.append({"min": v, "max": v, "currency": cur, "interval": _interval_from_words(m.group(6)), "score": 2 + (2 if PAY_CONTEXT.search(before) else 0), "text": js_trim(m.group(0))})
    cands.sort(key=lambda c: -c["score"])  # stable, like Array.prototype.sort
    for c in cands:
        if c["score"] < 2:
            continue
        s = make_salary(c["min"], c["max"], c["currency"], c["interval"], c["text"])
        if s:
            return {**s, "raw": _WS_RUN.sub(" ", c["text"])}
    return None


# ---------- co-op term ----------
SEASON = {"winter": "Winter", "spring": "Summer", "summer": "Summer", "fall": "Fall", "autumn": "Fall"}
MONTH_TERM = {"jan": "Winter", "feb": "Winter", "mar": "Winter", "apr": "Winter", "may": "Summer", "jun": "Summer", "jul": "Summer", "aug": "Summer", "sep": "Fall", "oct": "Fall", "nov": "Fall", "dec": "Fall"}
_T1 = rx(r"\b(winter|spring|summer|fall|autumn)\b(?:[\s,/&()–-]+[a-z][a-z/-]*){0,3}?[\s,(–-]+(20(?:2[6-8]))\b", "i")
_T2 = rx(r"\b(20(?:2[6-8]))\s*(winter|spring|summer|fall|autumn)\b", "i")
_T3 = rx(r"\b(?:start(?:ing|s)?|begin(?:ning|s)?|commenc\w*|from|term|period|duration)\b[^.\n]{0,40}?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(20(?:2[6-8]))", "i")
# Month ranges such as "Jan - Apr 2027", "January to August 2027", "May–Aug 2027".
_MONTHS = list(MONTH_TERM)
_MON = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
_T4 = rx(rf"\b{_MON}\s*(?:20(?:2[6-8])\s*)?(?:-|–|—|to|through|until)\s*{_MON}\s*,?\s*(20(?:2[6-8]))\b", "i")
# A bare "Month YYYY" in the title, e.g. "Software Engineering Intern (January 2027)".
_T5 = rx(rf"\b{_MON}\s+(20(?:2[6-8]))\b", "i")
_DUR = rx(r"\b(4|8|12|16|four|eight|twelve|sixteen)[- ]?months?\b", "i")


def detect_terms(title: str = "", text: str = "") -> dict:
    t = f"{title}\n{(text or '')[:6000]}"
    terms: dict[str, None] = {}
    for m in _T1.finditer(t):
        terms[f"{SEASON[m.group(1).lower()]} {m.group(2)}"] = None
    for m in _T2.finditer(t):
        terms[f"{SEASON[m.group(2).lower()]} {m.group(1)}"] = None
    for m in _T3.finditer(t):
        terms[f"{MONTH_TERM[m.group(1).lower()[:3]]} {m.group(2)}"] = None
    for m in _T4.finditer(t):
        s, e, year = m.group(1).lower()[:3], m.group(2).lower()[:3], m.group(3)
        si, ei = _MONTHS.index(s), _MONTHS.index(e)
        # "April–August" is a Summer role: a range starting in a term's last month (Apr/Aug) and
        # running on belongs to the next term. (Dec would roll into next year's Winter; skip that.)
        start = _MONTHS[si + 1] if s in ("apr", "aug") and ei - si >= 2 else s
        terms[f"{MONTH_TERM[start]} {year}"] = None
        # Only a range of ~8 months (e.g. Jan–Aug) counts as two terms; Jan–Jun is one Winter co-op.
        if _MONTHS.index(e) - _MONTHS.index(s) >= 6:
            terms[f"{MONTH_TERM[e]} {year}"] = None
    for m in _T5.finditer(title or ""):
        terms[f"{MONTH_TERM[m.group(1).lower()[:3]]} {m.group(2)}"] = None
    dur = _DUR.search(t)
    dur_map = {"four": 4, "eight": 8, "twelve": 12, "sixteen": 16}
    months = (dur_map.get(dur.group(1).lower()) or int(dur.group(1))) if dur else None
    eight = months == 8 or ("Winter 2027" in terms and "Summer 2027" in terms)
    return {"terms": list(terms), "durationMonths": months, "eightMonth": eight}


# ---------- student level ----------
STUDENT_TITLE = rx(r"\b(interns?|internships?|co-?op|co-?operative|student|summer (analyst|associate)|work term|placement|apprentice(ship)?|trainee)\b", "i")
_STUDENT_HINT = rx(r"intern|co-?op|student", "i")


def _js_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return js_num(v) if isinstance(v, (int, float)) else str(v)


_SENIOR_TITLE = rx(r"\b(director|manager|senior|sr\.?|lead|head|principal|chief|vp|vice president|specialist|officer|coordinator|advisor|administrator|professor|lecturer)\b", "i")
# A word that really means "this job is for a student" (not "Co-operative Education" in a staff title).
_STUDENT_WORD = rx(r"\b(interns?|internships?|co-?op(?!erative)|student|work term|apprentice(ship)?|trainee)\b", "i")


def is_student_role(title: str = "", hints=None) -> bool:
    # Staff titles ("Director, Co-operative Education", "Student Mental Health Project Coordinator")
    # only count when the title also names an intern / co-op / student position.
    if _SENIOR_TITLE.search(title or "") and not re.search(
        r"\b(interns?|internships?|co-?op(?!erative)|work term)\b|^\s*student\s*[,:–-]|\bstudent\s+(position|role|job|opportunity|program)\b|\(\s*student\b|\b(winter|summer|fall|spring) 20\d\d\b", title or "", re.I
    ):
        return False
    if STUDENT_TITLE.search(title or ""):
        return True
    return any(_STUDENT_HINT.search(_js_str(h)) for h in (hints or []))


# ---------- category ----------
CAT_TITLE = {
    "ux": rx(r"\b(ux|ui|ux\/ui|ui\/ux|user experience|user interface|product design(er)?|interaction design(er)?|visual design(er)?|graphic design(er)?|web design(er)?|designer|design|figma)\b", "i"),
    "marketing": rx(r"\b(marketing|marketer|brand(ing)?|growth|communications?|comms|public relations|social media|digital media|campaigns?|advertising|e-?commerce|events?|community|partnerships|merchandis\w*|seo|crm|lifecycle)\b", "i"),
    "content": rx(r"\b(content|video|editor|editorial|creative|copywrit\w*|writer|writing|storytell\w*|multimedia|media|production|photograph\w*|motion|animation|creator|social media|localization|translation|journalis\w*)\b", "i"),
}
NOT_DESIGN = rx(r"\b(engineer(ing)?|hardware|circuit|asic|mechanical|electrical|chip|silicon|systems design|structural|civil|software design)\b", "i")
CAT_DESC = {
    "ux": rx(r"\b(figma|wireframe|prototype|prototyping|user research|usability|design system|adobe xd|user flows?|ux|ui)\b", "i"),
    "marketing": rx(r"\b(marketing campaigns?|digital marketing|social media marketing|brand awareness|marketing team|go-to-market|newsletter|seo|marketing materials)\b", "i"),
    "content": rx(r"\b(content creation|video editing|premiere|capcut|copywriting|storytelling|short-form|photo|editorial|content calendar|tiktok|instagram|youtube)\b", "i"),
}


def categorize(title: str = "", text: str = "") -> dict:
    cats: list[str] = []
    for k, r in CAT_TITLE.items():
        if r.search(title) and not (k == "ux" and NOT_DESIGN.search(title)):
            cats.append(k)
    source = "title" if cats else ""
    if not cats:
        sample = (text or "")[:6000]
        for k, r in CAT_DESC.items():
            if sum(1 for _ in r.finditer(sample)) >= 3:
                cats.append(k)
        if cats:
            source = "description"
    return {"categories": cats, "categorySource": source}


# ---------- eligibility ----------
_CIT = rx(r"\b(must be|you are|be) (a )?(canadian citizen|citizen of canada)\b|\bcanadian citizens?,? (and|or|\/) permanent residents?\b|\bcitizenship (is )?required\b|\bopen (only )?to canadian citizens\b|\bpermanent residents? only\b|\bmust (hold|have) (canadian )?(citizenship|permanent residen(ce|cy))\b", "i")
_E_PERMIT_OK = rx(r"work permit|international students?|study permit|legally (eligible|entitled)|protected person|refugee", "i")
_E_SUBSIDY_CTX = rx(r"(swpp|wage subsid|canada summer jobs)", "i")
_E_PRIORITY = rx(r"(priority|preference|preferred)", "i")
_E_PRIORITY2 = rx(r"(priority|preference|preferred|given priority)", "i")
_E_SUBSIDY = rx(r"\b(swpp|student work placement program|canada summer jobs|wage subsid(y|ies|ized)|career launcher|youth employment and skills strategy|yess)\b", "i")
_E_US = rx(r"\b(u\.?s\.? citizen(ship)?|us person|itar|export[- ]control(led)?|green card)\b", "i")
_E_CLEAR = rx(r"\b(secret|top secret|security) clearance\b", "i")
_E_FED = rx(r"\bfswep\b|\bfederal student work experience program\b|\bgovernment of canada\b", "i")
_E_SPONSOR = rx(r"\b(no|not able to|unable to|cannot|will not|won['’]t) (provide |offer )?(visa |immigration )?sponsor(ship)?\b", "i")
_E_USUNI = rx(r"\b(must be|currently) (enrolled|registered) in (a |an )?(accredited )?(u\.?s\.?|american) (university|college)\b", "i")


def check_eligibility(loc: dict, work_mode: str, text: str = "", company: str = "") -> dict:
    reasons: list[str] = []
    status = "ok"

    def block(r):
        nonlocal status
        status = "blocked"
        reasons.append(r)

    def warn(r):
        nonlocal status
        if status == "ok":
            status = "warn"
        reasons.append(r)

    t = (text or "")[:15000]
    if loc["nonCanadaOnly"]:
        block("Located outside Canada. A Canadian co-op work permit does not authorize work there (US roles need a J-1/other US visa).")
    for m in _CIT.finditer(t):
        ctx = t[max(0, m.start() - 200) : m.end() + 200]
        if _E_PERMIT_OK.search(ctx) and not _E_SUBSIDY_CTX.search(ctx):
            if _E_PRIORITY.search(ctx):
                warn("Gives priority to citizens/PRs, but work-permit holders can apply.")
            continue
        if _E_PRIORITY2.search(ctx):
            warn("Gives preference to Canadian citizens/PRs. You can apply, but you may be ranked lower.")
        else:
            block("Posting requires Canadian citizenship or permanent residence.")
        break
    if _E_SUBSIDY.search(t):
        warn("Mentions a government wage subsidy (SWPP / Canada Summer Jobs / YESS). These programs only cover citizens, PRs and refugees, so ask whether the role still accepts international students.")
    if _E_US.search(t) and not loc["isCanada"]:
        block("Requires US citizenship/US-person status.")
    elif work_mode == "remote" and not loc["isCanada"] and _US_ONLY_TEXT.search(t):
        block("Remote, but only for people living in or authorized to work in the US.")
    if _E_CLEAR.search(t):
        warn("Mentions a security clearance. These usually require several years of residence in Canada, so check eligibility.")
    if _E_FED.search(t):
        warn("Federal student programs give preference to Canadian citizens/PRs. You can apply, but you may be ranked lower.")
    if _E_SPONSOR.search(t) and loc["isCanada"]:
        reasons.append('Says "no sponsorship". That\'s fine for you: your co-op work permit covers co-op terms.')
    if work_mode == "remote" and not loc["isCanada"]:
        if loc.get("remoteFromCanada") and loc["country"] in ("US", "OTHER"):
            if loc.get("remoteCanadaStated"):
                warn("Remote role open to Canada with an employer based outside Canada. Confirm how they pay people in Canada (Canadian payroll or an employer-of-record), and that Waterloo approves it as a co-op term.")
            else:
                warn("US remote role that doesn't say whether Canada is OK. Ask the recruiter if they can hire someone working from Canada (many use an employer-of-record), and check that Waterloo approves it as a co-op term.")
        else:
            warn("Remote role but the country isn't stated. Confirm it can be done from Canada.")
    if loc["country"] == "UNKNOWN" and work_mode != "remote":
        warn("Location not stated. Check that it is in Canada.")
    if _E_USUNI.search(t):
        block("Requires enrollment at a US university.")
    return {"status": status, "reasons": reasons}


# ---------- assemble ----------
def hash_text(s: str) -> str:
    """32-bit FNV-1a over UTF-16 code units, base-36 (same as the JS version)."""
    h = 2166136261
    b = (s or "").encode("utf-16-le", "surrogatepass")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 16777619) & 0xFFFFFFFF
    if h == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while h:
        h, r = divmod(h, 36)
        out = digits[r] + out
    return out


_WS_ALL = rx(r"\s+")


def normalize_job(raw: dict) -> dict:
    description = (raw.get("description") or html_to_text(raw.get("descriptionHtml") or ""))[:20000]
    title = decode_entities(js_trim(_js_str(raw.get("title"))))
    loc = parse_locations(raw.get("locations"))
    work_mode = detect_work_mode(raw.get("workModeHint"), raw.get("locations") or [], description)
    loc = with_remote_from_canada(loc, raw.get("locations") or [], work_mode, description)
    def_cur = "CAD" if loc["isCanada"] else ("USD" if loc["country"] == "US" else "CAD")
    rs = raw.get("salary")
    salary = (
        (rs and make_salary(**{**rs, "currency": rs.get("currency") or def_cur}))
        or parse_salary_from_text(raw.get("salaryText") or "", def_cur)
        or parse_salary_from_text(description, def_cur)
    )
    term = detect_terms(title, description)
    cat = categorize(title, description)
    student = is_student_role(title, [raw.get("employmentType"), *(raw.get("hints") or [])])
    elig = check_eligibility(loc, work_mode, description, raw.get("company") or "")
    ck = raw.get("companyKey")
    ext = _js_str(raw.get("extId")) if raw.get("extId") is not None else "undefined"
    jid = f"{ck}:{ext}" if ck else f"{raw.get('source')}:{raw.get('company')}:{ext}"
    return {
        "id": _WS_ALL.sub("-", jid.lower()),
        "source": raw.get("source"),
        "companyKey": ck or "",
        "company": decode_entities(raw.get("company") or ""),
        "title": title,
        "url": raw.get("url"),
        "applyUrl": raw.get("applyUrl") or raw.get("url"),
        "location": loc,
        "workMode": work_mode,
        "salary": salary or None,
        "term": term,
        "categories": cat["categories"],
        "categorySource": cat["categorySource"],
        "student": student,
        "eligibility": elig,
        "employmentType": raw.get("employmentType") or "",
        "postedAt": raw.get("postedAt") or "",
        "deadline": raw.get("deadline") or "",
        "description": description,
        "textHash": hash_text(title + description[:6000]),
    }
