// Crawl orchestration: full refresh of saved companies, dream-company discovery,
// and single-posting import (pasted URL/text or captured from the browser helper).
import { fetchCompanyJobs, extractJsonLdJobs, ADAPTERS, wanted } from './sources.js';
import { normalizeJob, htmlToText, decodeEntities, parseLocations } from './normalize.js';
import { store, companyKey, saveDb } from './store.js';
import { ensureEmbeddings, refreshMatchScores } from './rag.js';
import { request, getJSON, mapLimit, sleep } from './http.js';

// ---------- background task tracking (one at a time) ----------
export const task = { running: false, kind: '', label: '', log: [], startedAt: null, finishedAt: null, result: null, error: null };
function startTask(kind, label) {
  if (task.running) throw new Error(`Busy: ${task.label}`);
  Object.assign(task, { running: true, kind, label, log: [], startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null });
}
const log = (msg) => {
  task.log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (task.log.length > 400) task.log.shift();
  console.log(msg);
};
function endTask(result, error) {
  Object.assign(task, { running: false, finishedAt: new Date().toISOString(), result, error: error ? String(error.message || error) : null });
}

async function finalize() {
  try {
    await ensureEmbeddings(store.jobs(), log);
  } catch (e) {
    log(`⚠ Embeddings failed, keyword search still works: ${e.message}`);
  }
  await refreshMatchScores().catch((e) => log(`⚠ Match scoring: ${e.message}`));
  saveDb();
}

async function crawlOne(c, opts) {
  const raws = await fetchCompanyJobs(c, { ...opts, log });
  const seen = new Set();
  let kept = 0;
  for (const r of raws) {
    const j = normalizeJob(r);
    if (opts.studentOnly !== false && !j.student) continue;
    if (!opts.keepNonCanada && j.location.nonCanadaOnly) continue;
    if (opts.dream) j.dream = true;
    store.upsertJob(j);
    seen.add(j.id);
    kept++;
  }
  if (!opts.noPrune) store.markInactive(companyKey(c), seen);
  return { kept, ids: [...seen] };
}

// ---------- full crawl ----------
export function crawlAll() {
  startTask('crawl', 'Refreshing all companies');
  (async () => {
    const companies = store.companies();
    log(`Crawling ${companies.length} company job boards for student roles…`);
    const wd = companies.filter((c) => c.ats === 'workday');
    const rest = companies.filter((c) => c.ats !== 'workday');
    let total = 0;
    const run = async (c) => {
      try {
        const { kept } = await crawlOne(c, { studentOnly: true, keepNonCanada: false, noPrune: c.dream });
        total += kept;
        log(`✓ ${c.name}: ${kept} student role(s) in Canada`);
      } catch (e) {
        log(`✗ ${c.name}: ${e.message}`);
      }
    };
    await Promise.all([
      mapLimit(rest, 5, run),
      (async () => {
        for (const c of wd) {
          await run(c);
          await sleep(500);
        }
      })(),
    ]);
    await finalize();
    store.db.meta.lastCrawl = new Date().toISOString();
    saveDb();
    log(`Done: ${total} student roles in Canada across ${companies.length} companies.`);
    return { total };
  })().then((r) => endTask(r), (e) => endTask(null, e));
}

// ---------- dream company discovery ----------
const ATS_PATTERNS = [
  [/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([\w-]+)/gi, (m) => ({ ats: 'greenhouse', slug: m[1] })],
  [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)/gi, (m) => ({ ats: 'greenhouse', slug: m[1] })],
  [/jobs(\.eu)?\.lever\.co\/([\w.-]+)/gi, (m) => ({ ats: 'lever', slug: m[2], ...(m[1] ? { region: 'eu' } : {}) })],
  [/jobs\.ashbyhq\.com\/([\w.%-]+)/gi, (m) => ({ ats: 'ashby', slug: decodeURIComponent(m[1]) })],
  [/(?:careers|jobs)\.smartrecruiters\.com\/([\w-]+)/gi, (m) => ({ ats: 'smartrecruiters', slug: m[1] })],
  [/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/gi, (m) => ({ ats: 'workday', slug: `${m[1]}.${m[2]}`, site: m[3] })],
  [/apply\.workable\.com\/([\w-]+)/gi, (m) => ({ ats: 'workable', slug: m[1] })],
  [/https?:\/\/([\w.-]+\/(?:[a-z]{2}_[A-Z]{2}\/)?[\w-]+)\/(?:SearchJobs|SearchCareer|JobDetail)\b/g, (m) => ({ ats: 'avature', slug: m[1] })],
];
const BAD_SLUGS = new Set(['embed', 'v1', 'api', 'j', 'jobs', 'job', 'wday', 'login', 'apply', 'static', 'assets', 'cxs', 'en-us', 'favicon.ico', 'search']);

export function detectBoards(text) {
  const found = new Map();
  for (const [re, fn] of ATS_PATTERNS) {
    for (const m of String(text).matchAll(re)) {
      const b = fn(m);
      if (!b.slug || BAD_SLUGS.has(b.slug.toLowerCase()) || (b.site && BAD_SLUGS.has(b.site.toLowerCase()))) continue;
      if (b.ats === 'avature') {
        // same portal appears with and without a locale; prefer the English one
        const host = `avature:${b.slug.split('/')[0]}`;
        const prev = found.get(host);
        if (!prev || (/en_(US|CA)/.test(b.slug) && !/en_(US|CA)/.test(prev.slug))) found.set(host, b);
        continue;
      }
      found.set(companyKey(b), b);
    }
  }
  return [...found.values()];
}

// One board per Avature host (the same portal is linked once per locale).
function dedupeBoards(list) {
  const out = new Map();
  for (const b of list) {
    const key = b.ats === 'avature' ? `avature:${b.slug.split('/')[0]}` : companyKey(b);
    const prev = out.get(key);
    if (!prev || (b.ats === 'avature' && /en_(US|CA)/.test(b.slug) && !/en_(US|CA)/.test(prev.slug))) out.set(key, b);
  }
  return [...out.values()];
}

const slugify = (s) => s.toLowerCase().replace(/\b(inc|ltd|llc|corp|corporation|co|company|canada|group|limited)\b\.?/g, '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim();

async function probeSlugs(name) {
  const base = slugify(name);
  const slugs = [...new Set([base.replace(/[\s-]+/g, ''), base.replace(/\s+/g, '-'), base.split(/\s+/)[0]].filter((s) => s.length > 1))];
  const probes = [];
  for (const slug of slugs) {
    probes.push(
      getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}`).then((d) => ({ ats: 'greenhouse', slug, name: d.name })),
      getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`).then((d) => (Array.isArray(d) && d.length ? { ats: 'lever', slug } : null)),
      getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`).then((d) => (d.jobs?.length ? { ats: 'ashby', slug } : null)),
      getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`).then((d) => (d.totalFound > 0 ? { ats: 'smartrecruiters', slug, name: d.content?.[0]?.company?.name } : null)),
    );
  }
  const res = await Promise.allSettled(probes);
  return res.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

// Search engines block automated lookups, so guess the company's domains instead.
function guessWebsites(name) {
  const slug = slugify(name).replace(/[\s-]+/g, '');
  return [`https://careers.${slug}.com`, `https://jobs.${slug}.com`, `https://www.${slug}.com/careers`, `https://www.${slug}.com`, `https://www.${slug}.ca/careers`, `https://www.${slug}.ca`];
}

// Best-effort reading of a plain HTML job page (no structured data).
function genericJobPage(html, url, fallbackTitle) {
  const meta = (prop) => decodeEntities((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)`, 'i')) || [])[1] || '');
  const h1 = htmlToText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const main = htmlToText((html.match(/<main[\s\S]*<\/main>/i) || html.match(/<body[\s\S]*<\/body>/i) || [''])[0]);
  // a short line that names a place, e.g. "Toronto, ON" / "Remote - Canada"
  const title = h1 || meta('og:title') || fallbackTitle;
  const locLine = main.split('\n').map((x) => x.trim()).find((x) => x.length < 90 && x !== title && !title.includes(x) && parseLocations([x]).country !== 'UNKNOWN' && !/[.!?]$/.test(x));
  return { source: 'web', company: meta('og:site_name'), extId: url, title, url, applyUrl: url, locations: locLine ? [locLine] : [], description: main.slice(0, 15000) };
}

// attribute-aware: tolerates ">" inside quoted attributes (e.g. Tailwind classes)
const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
function careerLinks(html, base) {
  const out = new Map();
  for (const m of html.matchAll(ANCHOR)) {
    const href = (m[1].match(/\bhref\s*=\s*["']([^"'#]+)["']/i) || [])[1];
    if (!href) continue;
    const inner = html.slice(m.index + m[0].length, m.index + m[0].length + 4000).split(/<\/a>/i)[0];
    const label = htmlToText(inner).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
    if (/career|jobs|join (us|our team)|work with us|opportunit|students|internship|early talent|university|campus|co-?op/i.test(href + ' ' + label)) {
      try {
        const u = new URL(decodeEntities(href), base).toString();
        if (!out.has(u) || label.length > out.get(u).length) out.set(u, label);
      } catch {}
    }
  }
  return [...out];
}

async function scanSite(startUrls, maxPages = 10, includeAll = false) {
  const boards = new Map();
  const ldJobs = [];
  const visited = new Set();
  const queue = [...startUrls];
  const jobLinks = new Map(); // url -> link text
  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    let res;
    try {
      res = await request(url, { timeout: 12000, headers: { Accept: 'text/html' } });
    } catch {
      continue;
    }
    if (!res.ok || !/<html|<!doctype/i.test(res.text.slice(0, 2000))) continue;
    log(`  scanned ${url}`);
    for (const b of detectBoards(res.text + ' ' + res.url)) boards.set(companyKey(b), b);
    ldJobs.push(...extractJsonLdJobs(res.text, res.url));
    const host = new URL(res.url).hostname.replace(/^www\./, '');
    for (const [l, label] of careerLinks(res.text, res.url)) {
      if (detectBoards(l).length) {
        for (const b of detectBoards(l)) boards.set(companyKey(b), b);
        continue;
      }
      try {
        const lh = new URL(l).hostname.replace(/^www\./, '');
        if (lh.endsWith(host) || host.endsWith(lh) || /career|jobs/.test(lh)) {
          if (/\/(jobs?|positions?|openings?|careers?)\/[\w-]*\d|\/job\/|jobid|requisition/i.test(l)) jobLinks.set(l, label);
          else queue.push(l);
        }
      } catch {}
    }
  }
  // Generic fallback (custom careers sites): follow job links whose title looks relevant,
  // then read schema.org JobPosting markup, or failing that the page's own HTML.
  if (!boards.size && jobLinks.size) {
    const titleOf = (u, label) => label || decodeURIComponent(new URL(u).pathname.split('/').pop()).replace(/[_-][0-9a-f-]{8,}$/i, '').replace(/[-_]+/g, ' ');
    const picks = [...jobLinks].filter(([u, label]) => wanted(titleOf(u, label), [], { studentOnly: !includeAll })).slice(0, 40);
    log(`  no ATS detected; ${jobLinks.size} job links on the site, ${picks.length} look relevant. Reading them…`);
    await mapLimit(picks, 3, async ([l, label]) => {
      try {
        const r = await request(l, { timeout: 15000, headers: { Accept: 'text/html' } });
        if (!r.ok) return;
        const ld = extractJsonLdJobs(r.text, r.url);
        ldJobs.push(...(ld.length ? ld : [genericJobPage(r.text, r.url, titleOf(l, label))]));
      } catch {}
    });
  }
  return { boards: [...boards.values()], ldJobs, pagesScanned: visited.size };
}

export function crawlDreamCompany(input, { includeAll = false, save = true } = {}) {
  input = String(input || '').trim();
  if (!input) throw new Error('Enter a company name or careers URL');
  startTask('dream', `Searching ${input}`);
  (async () => {
    const isUrl = /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(input);
    const url = isUrl ? (/^https?:/i.test(input) ? input : `https://${input}`) : null;
    const name = isUrl ? new URL(url).hostname.replace(/^(www|careers|jobs)\./, '').split('.')[0] : input;
    const displayName = isUrl ? name.charAt(0).toUpperCase() + name.slice(1) : input;

    const boards = new Map();
    for (const b of detectBoards(url || '')) boards.set(companyKey(b), b);

    log(`Checking public job boards (Greenhouse, Lever, Ashby, SmartRecruiters) for "${name}"…`);
    for (const b of await probeSlugs(name)) boards.set(companyKey(b), b);

    log(`Crawling the company website for its careers page…`);
    const sites = url ? [url] : guessWebsites(input);
    const starts = [];
    for (const s of sites) {
      starts.push(s);
      if (url && !/career|job/i.test(s)) {
        try {
          const o = new URL(s).origin;
          starts.push(`${o}/careers`, `${o}/jobs`);
        } catch {}
      }
    }
    const scan = await scanSite(starts, url ? 12 : 14, includeAll);
    for (const b of scan.boards) boards.set(companyKey(b), b);

    const boardList = dedupeBoards([...boards.values()]).map((b) => ({ ...b, name: b.name || displayName, dream: true }));
    log(boardList.length ? `Found job board(s): ${boardList.map((b) => `${b.ats}/${b.slug}${b.site ? '/' + b.site : ''}`).join(', ')}` : 'No ATS job board detected.');

    const ids = [];
    const opts = { studentOnly: !includeAll, relevantOnly: true, keepNonCanada: true, dream: true, noPrune: true };
    for (const b of boardList) {
      try {
        const { kept, ids: got } = await crawlOne(b, opts);
        ids.push(...got);
        log(`✓ ${b.ats}/${b.slug}: ${kept} ${includeAll ? 'relevant' : 'student'} role(s)`);
        if (save && kept >= 0) store.addCompany({ name: b.name, ats: b.ats, slug: b.slug, ...(b.site ? { site: b.site } : {}), ...(b.region ? { region: b.region } : {}), dream: true });
      } catch (e) {
        log(`✗ ${b.ats}/${b.slug}: ${e.message}`);
      }
    }
    if (!boardList.length && scan.ldJobs.length) {
      log(`Using ${scan.ldJobs.length} posting(s) found via structured data on the website.`);
      for (const r of scan.ldJobs) {
        const j = normalizeJob({ ...r, company: r.company || displayName, companyKey: `web:${name}` });
        if (!includeAll && !j.student) continue;
        j.dream = true;
        store.upsertJob(j);
        ids.push(j.id);
      }
    }
    await finalize();
    const msg = ids.length
      ? `Done: ${ids.length} matching role(s) at ${displayName}.`
      : boardList.length
        ? `${displayName}'s job board has no ${includeAll ? 'relevant' : 'intern/co-op'} roles right now. ${includeAll ? '' : 'Try ticking "include non-intern roles".'} It has been saved, so future refreshes will catch new postings.`
        : `Couldn't find a crawlable job board for ${displayName}. Paste their careers page URL instead (e.g. https://company.com/careers), or add a posting manually.`;
    log(msg);
    return { company: displayName, boards: boardList, ids, message: msg };
  })().then((r) => endTask(r), (e) => endTask(null, e));
}

// ---------- single posting import ----------
export async function importPosting(p) {
  let raw = { source: p.source || 'manual', company: p.company || '', title: p.title || '', url: p.url || '', locations: p.location ? [p.location] : [], description: p.description || '', salaryText: p.salaryText || '', workModeHint: p.workMode || '', extId: p.extId || p.url || `${Date.now()}`, deadline: p.deadline || '' };
  if (p.url && !p.description) {
    // Exact ATS job URLs: use the official API for clean data.
    const res = await request(p.url, { timeout: 15000 }).catch(() => null);
    if (res?.ok) {
      const ld = extractJsonLdJobs(res.text, res.url)[0];
      if (ld) raw = { ...raw, ...ld, source: raw.source, title: raw.title || ld.title, company: raw.company || ld.company };
      else {
        const meta = (prop) => (res.text.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)`, 'i')) || [])[1] || '';
        const body = htmlToText((res.text.match(/<body[\s\S]*<\/body>/i) || [res.text])[0]);
        raw.title ||= decodeEntities(meta('og:title') || (res.text.match(/<title>([^<]*)/i) || [])[1] || 'Untitled posting');
        raw.description = body.slice(0, 15000) || decodeEntities(meta('og:description'));
      }
    } else if (!raw.title) {
      throw new Error('Could not fetch that page (it may need a login). Paste the job description text instead.');
    }
  }
  if (!raw.title) throw new Error('A title is required');
  raw.companyKey = `${raw.source}:${(raw.company || 'unknown').toLowerCase()}`;
  const j = normalizeJob(raw);
  j.manual = raw.source === 'manual';
  const saved = store.upsertJob(j);
  if (p.status) store.updateApp(saved.id, { status: p.status });
  await finalize();
  return saved;
}

export { ADAPTERS };
