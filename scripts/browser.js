// LinkedIn + Indeed helper using your own Chrome and your own login.
//
//   npm run browser               → CAPTURE mode (default, lower risk):
//                                   you browse normally; every job posting you open is saved to the hub.
//   npm run browser -- search     → SEARCH mode: after you sign in, runs your saved searches
//                                   slowly (random 4–9 s pauses, capped per search).
//
// ⚠ LinkedIn's User Agreement prohibits automated access (even when logged in), and both
//   sites may restrict accounts they flag. Capture mode only reads pages you open yourself.
//   Search mode is automated: keep volumes low and use it at your own risk.
//
// Requires the hub to be reachable (`npm run dev` locally, or your Vercel URL in HUB_URL) and Google Chrome.
// For a deployed hub set HUB_URL=https://<app>.vercel.app and HUB_TOKEN=<same as the Vercel env var> in .env.local.
import { chromium } from 'playwright-core';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = (process.env.HUB_URL || `http://localhost:${process.env.PORT || 3000}`).replace(//$/, '');
const AUTH = process.env.HUB_TOKEN ? { Authorization: `Bearer ${process.env.HUB_TOKEN}` } : {};
const MODE = process.argv.includes('search') ? 'search' : 'capture';
const MAX_PER_SEARCH = Number((process.argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 20;
const SITES = (process.argv.find((a) => a.startsWith('--sites=')) || '--sites=linkedin,indeed').split('=')[1].split(',');
const QUERIES = (process.env.SEARCH_QUERIES || 'marketing intern|content creator intern|social media co-op|UX UI design intern|graphic design co-op|digital marketing co-op').split('|');
const LOCATION = process.env.SEARCH_LOCATION || 'Ontario, Canada';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ---- check hub is up ----
let hubStatus = 0;
try {
  const r = await fetch(`${HUB}/api/task`, { headers: AUTH });
  hubStatus = r.status;
  if (!r.ok) throw new Error();
} catch {
  if (hubStatus === 401) {
    console.error(`✗ The hub at ${HUB} needs a token. Set HUB_TOKEN in .env.local (same value as in Vercel).`);
    process.exit(1);
  }
  console.error(`✗ Can't reach the hub at ${HUB}. Start it first with:  npm run dev  (or set HUB_URL)`);
  process.exit(1);
}

function idFromUrl(url) {
  let m = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/) || url.match(/linkedin\.com\/jobs\/.*[?&]currentJobId=(\d+)/);
  if (m) return { site: 'linkedin', id: m[1] };
  m = url.match(/indeed\.com\/.*[?&](?:jk|vjk)=([a-f0-9]{8,})/i);
  if (m) return { site: 'indeed', id: m[1] };
  return null;
}

// Runs inside the page. Selectors change often, so each field has fallbacks.
function extractInPage(site) {
  const txt = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el?.innerText?.trim();
      if (t) return t;
    }
    return '';
  };
  if (site === 'linkedin') {
    const [tTitle, tCompany] = document.title.replace(/^\(\d+\)\s*/, '').split(' | ');
    const top = txt(['.job-details-jobs-unified-top-card__primary-description-container', '.job-details-jobs-unified-top-card__tertiary-description-container', '.jobs-unified-top-card__primary-description', '.jobs-unified-top-card__subtitle-primary-grouping']);
    const prefs = txt(['.job-details-fit-level-preferences', '.job-details-preferences-and-skills', '.jobs-unified-top-card__workplace-type', '.job-details-jobs-unified-top-card__job-insight']);
    return {
      title: txt(['.job-details-jobs-unified-top-card__job-title h1', '.job-details-jobs-unified-top-card__job-title', '.jobs-unified-top-card__job-title', '.top-card-layout__title', 'h1']) || tTitle || '',
      company: txt(['.job-details-jobs-unified-top-card__company-name a', '.job-details-jobs-unified-top-card__company-name', '.jobs-unified-top-card__company-name a', '.topcard__org-name-link']) || tCompany || '',
      location: (top.split('·')[0] || '').trim(),
      workMode: prefs,
      salaryText: prefs,
      description: txt(['#job-details', '.jobs-description__content', '.jobs-box__html-content', '.jobs-description-content__text', '.description__text']),
    };
  }
  return {
    title: txt(['h1[data-testid="jobsearch-JobInfoHeader-title"]', '.jobsearch-JobInfoHeader-title', 'h1']).replace(/\s*-\s*job post\s*$/i, ''),
    company: txt(['[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]', '.jobsearch-CompanyInfoContainer a']),
    location: txt(['[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]', '[data-testid="jobsearch-JobInfoHeader-companyLocation"]', '#jobLocationText']),
    workMode: txt(['[data-testid="inlineHeader-companyLocation"]', '#jobLocationText']),
    salaryText: txt(['#salaryInfoAndJobType', '[data-testid="jobsearch-OtherJobDetailsContainer"]', '#jobDetailsSection']),
    description: txt(['#jobDescriptionText', '.jobsearch-jobDescriptionText', '.jobsearch-JobComponent-description']),
  };
}

const captured = new Set();
async function capture(page, hit) {
  const key = `${hit.site}:${hit.id}`;
  if (captured.has(key)) return false;
  await sleep(1800); // let the description render
  let data;
  try {
    data = await page.evaluate(extractInPage, hit.site);
  } catch {
    return false;
  }
  if (!data.title || (data.description || '').length < 80) return false;
  captured.add(key);
  const url = hit.site === 'linkedin' ? `https://www.linkedin.com/jobs/view/${hit.id}/` : `https://ca.indeed.com/viewjob?jk=${hit.id}`;
  try {
    const r = await fetch(`${HUB}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ ...data, source: hit.site, extId: hit.id, url }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const elig = j.eligibility?.status === 'blocked' ? '  ⛔ not eligible' : j.eligibility?.status === 'warn' ? '  ⚠ check eligibility' : '';
    console.log(`  ✓ ${hit.site}: ${j.title} @ ${j.company}  [${j.location?.display}]${elig}`);
    return true;
  } catch (e) {
    console.log(`  ✗ failed to save ${key}: ${e.message}`);
    captured.delete(key);
    return false;
  }
}

function looksBlocked(page) {
  const u = page.url();
  return /checkpoint|authwall|captcha|challenge|login|signin|uas\/login/i.test(u);
}

// ---- launch ----
const ctx = await chromium.launchPersistentContext(path.join(ROOT, 'data', 'browser-profile'), {
  channel: 'chrome',
  headless: false,
  viewport: null,
});
ctx.on('close', () => {
  console.log(`\nBrowser closed. Captured ${captured.size} posting(s). Open ${HUB} to see them.`);
  process.exit(0);
});

const first = ctx.pages()[0] || (await ctx.newPage());
if (SITES.includes('linkedin')) await first.goto('https://www.linkedin.com/jobs/').catch(() => {});
if (SITES.includes('indeed')) {
  const p2 = SITES.includes('linkedin') ? await ctx.newPage() : first;
  await p2.goto('https://ca.indeed.com/').catch(() => {});
}

if (MODE === 'capture') {
  console.log(`\nCAPTURE mode: sign in if needed, then browse jobs as usual.`);
  console.log(`Every LinkedIn/Indeed posting you open is saved to ${HUB}. Close the browser when you're done.\n`);
  for (;;) {
    for (const page of ctx.pages()) {
      const hit = idFromUrl(page.url());
      if (hit) await capture(page, hit);
    }
    await sleep(2500);
  }
}

// ---- search mode ----
console.log(`\nSEARCH mode: up to ${MAX_PER_SEARCH} postings per search, ${QUERIES.length} searches, in ${LOCATION}.`);
console.log('⚠ This is automated browsing. LinkedIn forbids it in its terms, and your account could be restricted.');
await rl.question('Sign in to the sites in the Chrome window, then press Enter here to start (Ctrl+C to cancel)… ');
const page = first;

async function ensureNotBlocked() {
  if (looksBlocked(page)) {
    await rl.question('  ⏸ The site is asking you to sign in or verify. Handle it in the browser, then press Enter… ');
  }
}

if (SITES.includes('linkedin')) {
  for (const q of QUERIES) {
    console.log(`\nLinkedIn: "${q}"`);
    await page.goto(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(LOCATION)}&f_E=1&f_TPR=r2592000`);
    await jitter(3000, 5000);
    await ensureNotBlocked();
    const ids = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-job-id],[data-occludable-job-id]')].map((e) => e.getAttribute('data-job-id') || e.getAttribute('data-occludable-job-id')).concat([...document.querySelectorAll('a[href*="/jobs/view/"]')].map((a) => (a.href.match(/\/jobs\/view\/(\d+)/) || [])[1])).filter(Boolean))]);
    for (const id of ids.slice(0, MAX_PER_SEARCH)) {
      if (captured.has(`linkedin:${id}`)) continue;
      await page.goto(`https://www.linkedin.com/jobs/view/${id}/`);
      await ensureNotBlocked();
      await capture(page, { site: 'linkedin', id });
      await jitter(4000, 9000);
    }
  }
}

if (SITES.includes('indeed')) {
  for (const q of QUERIES) {
    console.log(`\nIndeed: "${q}"`);
    await page.goto(`https://ca.indeed.com/jobs?q=${encodeURIComponent(q)}&l=${encodeURIComponent(LOCATION.split(',')[0])}&fromage=30`);
    await jitter(3000, 5000);
    await ensureNotBlocked();
    const jks = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-jk]')].map((e) => e.getAttribute('data-jk')).filter(Boolean))]);
    for (const jk of jks.slice(0, MAX_PER_SEARCH)) {
      if (captured.has(`indeed:${jk}`)) continue;
      await page.goto(`https://ca.indeed.com/viewjob?jk=${jk}`);
      await ensureNotBlocked();
      await capture(page, { site: 'indeed', id: jk });
      await jitter(4000, 9000);
    }
  }
}

console.log(`\nDone. Captured ${captured.size} posting(s). You can keep browsing (capture stays on) or close the browser.`);
for (;;) {
  for (const p of ctx.pages()) {
    const hit = idFromUrl(p.url());
    if (hit) await capture(p, hit);
  }
  await sleep(2500);
}
