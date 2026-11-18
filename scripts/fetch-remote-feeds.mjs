// Pulls entry-level marketing / content / design roles from public remote-job feeds
// (Remotive, Himalayas, Jobicy, Remote OK) that can be done from Canada, and writes them
// in the format scripts/import-captures.mjs expects.
//
// Usage: node scripts/fetch-remote-feeds.mjs [out.json]
//        node scripts/import-captures.mjs data/remote-feeds-<date>.json
//
// Each feed asks that its jobs be credited and link back to the original posting; the hub keeps
// the source name and the original URL for every job.
import { writeFileSync, mkdirSync } from 'node:fs';

const UA = { 'User-Agent': 'internship-hub/2.0 (personal job search)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Roles that fit the resume (marketing, content, social, video, graphic/UX design, communications).
const FIELD = /\b(marketing|content|social media|community|brand|creative|graphic|visual|motion|video|editor|copy ?writ|communications?|ux|ui|user experience|product design|web design|designer|growth|influencer|seo|campaign|media)\b/i;
// Student roles only (the hub is student-only).
const LEVEL = /\b(interns?|internships?|co-?op|student|apprentice(ship)?|trainee)\b/i;
const TOO_SENIOR = /\b(senior|sr\.?|lead|principal|staff|head|director|manager|vp|vice president|chief|architect|expert)\b/i;
// Location strings that include Canada; US-only or other regions are excluded.
const CANADA_OK = /\b(canada|north america|americas|worldwide|world-?wide|anywhere|global|international)\b/i;
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function keep(title, locText, levelText = '') {
  if (!FIELD.test(title)) return false;
  if (TOO_SENIOR.test(title)) return false;
  if (!LEVEL.test(title)) return false;
  return !locText || CANADA_OK.test(locText);
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function remotive() {
  const out = [];
  for (const cat of ['marketing', 'design', 'writing']) {
    const j = await getJson(`https://remotive.com/api/remote-jobs?category=${cat}`);
    for (const x of j.jobs || []) {
      if (!keep(x.title, x.candidate_required_location || 'Worldwide')) continue;
      out.push({ source: 'remotive', extId: String(x.id), url: x.url, title: x.title, company: x.company_name,
        location: `Remote - ${x.candidate_required_location || 'Worldwide'}`, workMode: 'remote',
        salaryText: x.salary || '', description: strip(x.description).slice(0, 15000), postedAt: (x.publication_date || '').slice(0, 10) });
    }
    await sleep(1500);
  }
  return out;
}

async function himalayas() {
  const out = [];
  for (const q of ['marketing intern', 'marketing coordinator', 'content creator', 'social media', 'graphic designer', 'ux designer', 'video editor', 'junior designer', 'marketing assistant']) {
    for (let page = 1; page <= 3; page++) {
      const j = await getJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&page=${page}`);
      const jobs = j.jobs || [];
      for (const x of jobs) {
        const locs = x.locationRestrictions || [];
        const locText = locs.length ? locs.join(', ') : 'Worldwide';
        if (!keep(x.title, locText, (x.seniority || []).join(' ') + ' ' + (x.employmentType || ''))) continue;
        out.push({ source: 'himalayas', extId: x.guid || x.applicationLink, url: x.applicationLink || x.guid, title: x.title, company: x.companyName,
          location: `Remote - ${locText}`, workMode: 'remote',
          salaryText: x.minSalary ? `${x.currency || ''} ${x.minSalary}–${x.maxSalary || x.minSalary} per ${x.salaryPeriod || 'year'}` : '',
          description: strip(x.description).slice(0, 15000), postedAt: x.pubDate ? new Date(x.pubDate * 1000).toISOString().slice(0, 10) : '' });
      }
      if (jobs.length < 20) break;
      await sleep(1200);
    }
  }
  return out;
}

async function jobicy() {
  const out = [];
  for (const geo of ['canada', 'usa-canada', 'anywhere']) {
    for (const ind of ['marketing', 'design-multimedia', 'copywriting']) {
      let j;
      try { j = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&industry=${ind}`); } catch { continue; }
      for (const x of j.jobs || []) {
        const locText = String(x.jobGeo || '');
        if (!keep(x.jobTitle, locText, x.jobLevel || '')) continue;
        out.push({ source: 'jobicy', extId: String(x.id), url: x.url, title: strip(x.jobTitle), company: x.companyName,
          location: `Remote - ${locText}`, workMode: 'remote',
          salaryText: x.salaryMin ? `${x.salaryCurrency || ''} ${x.salaryMin}–${x.salaryMax || x.salaryMin} per ${x.salaryPeriod || 'year'}` : '',
          description: strip(x.jobDescription).slice(0, 15000), postedAt: (x.pubDate || '').slice(0, 10) });
      }
      await sleep(1500);
    }
  }
  return out;
}

async function remoteok() {
  const out = [];
  for (const tag of ['marketing', 'design', 'content-writing', 'social-media']) {
    const j = await getJson(`https://remoteok.com/api?tag=${tag}`);
    for (const x of j.slice(1)) {
      const locText = x.location || 'Worldwide';
      if (!keep(x.position || '', locText, (x.tags || []).join(' '))) continue;
      out.push({ source: 'remoteok', extId: String(x.id), url: x.url, title: x.position, company: x.company,
        location: `Remote - ${locText}`, workMode: 'remote',
        salaryText: x.salary_min ? `USD ${x.salary_min}–${x.salary_max || x.salary_min} per year` : '',
        description: strip(x.description).slice(0, 15000), postedAt: (x.date || '').slice(0, 10) });
    }
    await sleep(2000);
  }
  return out;
}

async function workingnomads() {
  const j = await getJson('https://www.workingnomads.com/api/exposed_jobs/');
  const out = [];
  for (const x of j) {
    if (!/marketing|design|writing|content|media/i.test(`${x.category_name} ${x.tags}`)) continue;
    const locText = x.location || 'Worldwide';
    if (!keep(x.title || '', locText, x.tags || '')) continue;
    out.push({ source: 'workingnomads', extId: x.url, url: x.url, title: x.title, company: x.company_name,
      location: `Remote - ${locText}`, workMode: 'remote', description: strip(x.description).slice(0, 15000), postedAt: (x.pub_date || '').slice(0, 10) });
  }
  return out;
}

// "Remote - Anguilla, Antigua, …, Canada, …" → "Remote - Americas (incl. Canada)".
function shortLoc(loc) {
  const parts = loc.replace(/^Remote - /, '').split(/\s*,\s*/).filter(Boolean);
  if (parts.length <= 6) return loc;
  return parts.some((p) => /canada/i.test(p)) ? `Remote - ${parts.length} countries incl. Canada` : `Remote - ${parts.slice(0, 5).join(', ')} …`;
}

const all = [];
for (const [name, fn] of Object.entries({ remotive, himalayas, jobicy, remoteok, workingnomads })) {
  try {
    const got = await fn();
    console.log(`${name}: ${got.length}`);
    all.push(...got.map((j) => ({ ...j, location: shortLoc(j.location) })));
  } catch (e) {
    console.error(`${name} failed: ${e.message}`);
  }
}
// De-duplicate the same role posted on several boards.
const seen = new Set();
const uniq = all.filter((j) => {
  const k = `${j.company}|${j.title}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const out = process.argv[2] || `data/remote-feeds-${new Date().toISOString().slice(0, 10)}.json`;
mkdirSync('data', { recursive: true });
writeFileSync(out, JSON.stringify(uniq, null, 1));
console.log(`\n${uniq.length} roles written to ${out}`);
for (const j of uniq) console.log(`- ${j.title} — ${j.company} (${j.location}) [${j.source}]`);
