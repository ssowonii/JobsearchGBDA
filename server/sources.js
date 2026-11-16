// Adapters for public applicant-tracking-system (ATS) job APIs + a generic schema.org
// JobPosting (JSON-LD) extractor. Each adapter returns "raw" jobs for normalizeJob().
import { getJSON, request, sleep, mapLimit } from './http.js';
import { isStudentRole, htmlToText } from './normalize.js';
import { companyKey } from './store.js';

const RELEVANT_TITLE = /\b(market\w*|brand\w*|content|social|media|design\w*|ux|ui|creative|communicat\w*|video|growth|community|events?|copy\w*|writer|editor\w*|digital (marketing|media|content|design)|e-?commerce|public relations|campaigns?|graphic|visual|storytell\w*|partnerships?)\b/i;
const NOT_RELEVANT = /\b(engineer\w*|developer|devops|software|accountant|accounting|legal|counsel|finance|financial|data scien\w*|machine learning|sales associate|educator|store|warehouse|driver)\b/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|vice president|chief|executive)\b/i;

/** Decide whether to keep a listing before fetching its (expensive) details. */
export function wanted(title, hints, opts) {
  if (isStudentRole(title, hints)) return true;
  // "include non-intern roles": entry-level roles in your fields only
  if (opts.studentOnly === false) return RELEVANT_TITLE.test(title) && !NOT_RELEVANT.test(title) && !SENIOR.test(title);
  return false;
}

const intervalMap = (s = '') => {
  s = String(s).toLowerCase();
  if (/hour/.test(s)) return 'hour';
  if (/month/.test(s)) return 'month';
  if (/week/.test(s)) return 'week';
  if (/year|annual|salary/.test(s)) return 'year';
  return '';
};

// ---------------- Greenhouse ----------------
async function greenhouse(c, opts) {
  const base = `https://boards-api.greenhouse.io/v1/boards/${c.slug}`;
  const data = await getJSON(`${base}/jobs?content=true`);
  const list = (data.jobs || []).filter((j) => wanted(j.title, [], opts));
  return mapLimit(list, 4, async (j) => {
    let salary = null;
    try {
      const d = await getJSON(`${base}/jobs/${j.id}?pay_transparency=true`);
      const r = (d.pay_input_ranges || [])[0];
      if (r) salary = { min: r.min_cents / 100, max: r.max_cents / 100, currency: r.currency_type, interval: intervalMap(r.title) || '' };
    } catch {}
    const locs = [j.location?.name, ...(j.offices || []).map((o) => o.location || o.name)].filter(Boolean);
    return {
      source: 'greenhouse', companyKey: companyKey(c), company: c.name, extId: j.id, title: j.title,
      url: j.absolute_url, applyUrl: j.absolute_url, locations: [...new Set(locs)],
      descriptionHtml: j.content, salary, postedAt: j.first_published || j.updated_at,
    };
  });
}

// ---------------- Lever ----------------
async function lever(c, opts) {
  const host = c.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
  const data = await getJSON(`https://${host}/v0/postings/${c.slug}?mode=json`);
  return data
    .filter((j) => wanted(j.text, [j.categories?.commitment], opts))
    .map((j) => {
      const lists = (j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
      const sr = j.salaryRange;
      return {
        source: 'lever', companyKey: companyKey(c), company: c.name, extId: j.id, title: j.text,
        url: j.hostedUrl, applyUrl: j.applyUrl || j.hostedUrl,
        locations: j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location],
        workModeHint: j.workplaceType, employmentType: j.categories?.commitment,
        description: [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n\n'),
        salary: sr ? { min: sr.min, max: sr.max, currency: sr.currency, interval: intervalMap(sr.interval) } : null,
        salaryText: j.salaryDescriptionPlain || '',
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
      };
    });
}

// ---------------- Ashby ----------------
async function ashby(c, opts) {
  const data = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${c.slug}?includeCompensation=true`);
  return (data.jobs || [])
    .filter((j) => j.isListed !== false && wanted(j.title, [j.employmentType], opts))
    .map((j) => {
      const comp = (j.compensation?.summaryComponents || []).find((x) => /salary|hourly|wage/i.test(x.compensationType) && (x.minValue || x.maxValue));
      return {
        source: 'ashby', companyKey: companyKey(c), company: c.name, extId: j.id, title: j.title,
        url: j.jobUrl, applyUrl: j.applyUrl || j.jobUrl,
        locations: [j.location, ...(j.secondaryLocations || []).map((s) => s.location)],
        workModeHint: j.workplaceType || (j.isRemote ? 'remote' : ''), employmentType: j.employmentType,
        description: j.descriptionPlain || htmlToText(j.descriptionHtml),
        salary: comp ? { min: comp.minValue, max: comp.maxValue, currency: comp.currencyCode, interval: intervalMap(comp.interval) } : null,
        salaryText: j.compensation?.scrapeableCompensationSalarySummary || '',
        postedAt: j.publishedAt,
      };
    });
}

// ---------------- SmartRecruiters ----------------
async function smartrecruiters(c, opts) {
  const all = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${c.slug}/postings?limit=100&offset=${offset}`);
    all.push(...(d.content || []));
    if (!d.content?.length || all.length >= (d.totalFound || 0)) break;
  }
  const list = all.filter((j) => wanted(j.name, [j.experienceLevel?.id, j.typeOfEmployment?.label], opts));
  return mapLimit(list, 4, async (j) => {
    let desc = '';
    let applyUrl = '';
    let url = `https://jobs.smartrecruiters.com/${c.slug}/${j.id}`;
    try {
      const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${c.slug}/postings/${j.id}`);
      const s = d.jobAd?.sections || {};
      desc = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'].map((k) => htmlToText(s[k]?.text || '')).filter(Boolean).join('\n\n');
      applyUrl = d.applyUrl;
      url = d.postingUrl || url;
    } catch {}
    const L = j.location || {};
    return {
      source: 'smartrecruiters', companyKey: companyKey(c), company: j.company?.name || c.name, extId: j.id, title: j.name,
      url, applyUrl: applyUrl || url,
      locations: [L.fullLocation || [L.city, L.region, L.country?.toUpperCase() === 'CA' ? 'Canada' : L.country].filter(Boolean).join(', ')],
      workModeHint: L.hybrid ? 'hybrid' : L.remote ? 'remote' : '',
      employmentType: j.typeOfEmployment?.label, hints: [j.experienceLevel?.id],
      description: desc, postedAt: j.releasedDate,
    };
  });
}

// ---------------- Workday ----------------
async function workday(c, opts) {
  const host = `${c.slug}.myworkdayjobs.com`;
  const tenant = c.slug.split('.')[0];
  const api = `https://${host}/wday/cxs/${tenant}/${c.site}`;
  const queries = opts.studentOnly === false
    ? ['intern', 'co-op', 'student', 'marketing', 'content', 'design', 'communications', 'social media']
    : ['intern', 'co-op', 'student', 'summer 2027', 'winter 2027'];
  const seen = new Map();
  for (const q of queries) {
    for (let offset = 0; offset < 200; offset += 20) {
      const res = await request(`${api}/jobs`, { method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText: q } });
      if (!res.ok) throw new Error(`Workday HTTP ${res.status}`);
      const d = JSON.parse(res.text);
      for (const p of d.jobPostings || []) if (p.externalPath && !seen.has(p.externalPath)) seen.set(p.externalPath, p);
      if (!d.jobPostings?.length || offset + 20 >= (d.total || 0)) break;
      await sleep(350);
    }
  }
  const list = [...seen.values()].filter((p) => wanted(p.title, [], opts));
  opts.log?.(`  ${c.name}: ${list.length} matching postings, fetching details…`);
  const out = [];
  for (const p of list) {
    try {
      const res = await request(`${api}${p.externalPath}`);
      if (!res.ok) continue;
      const info = JSON.parse(res.text).jobPostingInfo || {};
      out.push({
        source: 'workday', companyKey: companyKey(c), company: c.name, extId: info.jobReqId || p.externalPath, title: info.title || p.title,
        url: info.externalUrl || `https://${host}/${c.site}${p.externalPath}`, applyUrl: (info.externalUrl || `https://${host}/${c.site}${p.externalPath}`) + '/apply',
        locations: [info.location, ...(info.additionalLocations || [])].filter(Boolean),
        workModeHint: info.remoteType || '', employmentType: info.timeType,
        descriptionHtml: info.jobDescription, postedAt: info.startDate, deadline: info.endDate || '',
        countryHint: info.country?.descriptor,
      });
    } catch {}
    await sleep(300);
  }
  // Workday city strings often lack the country; append it so location parsing works.
  // (Only the primary location's country is known, so only that one gets the suffix.)
  for (const j of out) {
    if (j.countryHint && j.locations[0] && !j.locations[0].toLowerCase().includes(j.countryHint.toLowerCase()) && !/\bCAN\b|\bUSA\b/.test(j.locations[0])) j.locations[0] += `, ${j.countryHint}`;
    delete j.countryHint;
  }
  return out;
}

// ---------------- Workable ----------------
async function workable(c, opts) {
  const res = await request(`https://apply.workable.com/api/v3/accounts/${c.slug}/jobs`, { method: 'POST', body: { query: '', location: [], department: [], worktype: [], remote: [] } });
  if (!res.ok) throw new Error(`Workable HTTP ${res.status}`);
  const list = (JSON.parse(res.text).results || []).filter((j) => wanted(j.title, [j.type], opts));
  return mapLimit(list, 3, async (j) => {
    let desc = '';
    try {
      const d = await getJSON(`https://apply.workable.com/api/v2/accounts/${c.slug}/jobs/${j.shortcode}`);
      desc = htmlToText([d.description, d.requirements, d.benefits].filter(Boolean).join('\n'));
    } catch {}
    const L = j.location || {};
    const url = `https://apply.workable.com/${c.slug}/j/${j.shortcode}/`;
    return {
      source: 'workable', companyKey: companyKey(c), company: c.name, extId: j.shortcode, title: j.title,
      url, applyUrl: url + 'apply/', locations: [[L.city, L.region, L.country].filter(Boolean).join(', ')],
      workModeHint: j.workplace || (j.remote ? 'remote' : ''), description: desc, postedAt: j.published,
    };
  });
}

// ---------------- Avature (used by many big consumer brands, e.g. lululemon) ----------------
// slug = portal base, e.g. "careers.lululemon.com/en_US/careers"
async function avature(c, opts) {
  const base = `https://${c.slug}`;
  const queries = opts.studentOnly === false
    ? ['intern', 'co-op', 'student', 'marketing', 'content', 'design', 'social media', 'brand', 'creative']
    : ['intern', 'internship', 'co-op', 'student'];
  const found = new Map();
  for (const q of queries) {
    for (let offset = 0; offset < 60; offset += 10) {
      const r = await request(`${base}/SearchJobs/${encodeURIComponent(q)}?jobRecordsPerPage=10&jobOffset=${offset}`, { headers: { Accept: 'text/html' } });
      if (!r.ok) throw new Error(`Avature HTTP ${r.status}`);
      let n = 0;
      for (const m of r.text.matchAll(/href="(https?:\/\/[^"]+\/JobDetail\/[^"]+\/(\d+))"[^>]*>([^<]{3,})</g)) {
        n++;
        if (!found.has(m[2])) found.set(m[2], { url: m[1], id: m[2], title: htmlToText(m[3]) });
      }
      if (n < 10) break;
      await sleep(300);
    }
  }
  const list = [...found.values()].filter((j) => wanted(j.title, [], opts)).slice(0, 80);
  opts.log?.(`  ${c.name}: ${list.length} matching postings, fetching details…`);
  return mapLimit(list, 3, async (j) => {
    const r = await request(j.url, { headers: { Accept: 'text/html' } });
    const ld = extractJsonLdJobs(r.text, j.url)[0];
    const text = htmlToText((r.text.match(/<main[\s\S]*<\/main>/i) || r.text.match(/<body[\s\S]*<\/body>/i) || [''])[0]);
    const field = (label) => (text.match(new RegExp(`(?:^|\\n)${label}:?\\s*\\n+([^\\n]{2,80})`, 'i')) || [])[1]?.trim() || '';
    const loc = [field('City'), field('State/Province/City') || field('State'), field('Location') || field('Country')].filter(Boolean);
    const descStart = text.search(/Description|Who We Are|About (the|this) (role|job)/i);
    return {
      source: 'avature', companyKey: companyKey(c), company: c.name, extId: j.id, title: j.title,
      url: j.url, applyUrl: j.url,
      locations: ld?.locations?.length ? ld.locations : [[...new Set(loc)].join(', ') || (j.title.split('|')[1] || '').trim()],
      description: ld ? htmlToText(ld.descriptionHtml) : text.slice(Math.max(0, descStart)).slice(0, 15000),
      salary: ld?.salary, postedAt: ld?.postedAt || '',
    };
  });
}

export const ADAPTERS = { greenhouse, lever, ashby, smartrecruiters, workday, workable, avature };

export async function fetchCompanyJobs(c, opts = {}) {
  const fn = ADAPTERS[c.ats];
  if (!fn) throw new Error(`Unknown ATS: ${c.ats}`);
  return (await fn(c, opts)).filter((x) => x && !x.error);
}

// ---------------- Generic JSON-LD JobPosting ----------------
export function extractJsonLdJobs(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const stack = Array.isArray(data) ? [...data] : [data];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
      const type = [].concat(n['@type'] || []);
      if (type.includes('JobPosting')) out.push(fromJsonLd(n, pageUrl));
    }
  }
  return out;
}

function fromJsonLd(n, pageUrl) {
  const locs = [].concat(n.jobLocation || []).map((l) => {
    const a = l.address || {};
    return typeof a === 'string' ? a : [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'object' ? a.addressCountry.name : a.addressCountry].filter(Boolean).join(', ');
  });
  if (/telecommute/i.test(n.jobLocationType || '')) locs.push(`Remote${n.applicantLocationRequirements?.name ? ' - ' + n.applicantLocationRequirements.name : ''}`);
  const bs = n.baseSalary;
  const v = bs?.value || {};
  const salary = bs ? { min: v.minValue ?? v.value, max: v.maxValue ?? v.value, currency: bs.currency, interval: intervalMap(v.unitText) } : null;
  const org = typeof n.hiringOrganization === 'object' ? n.hiringOrganization?.name : n.hiringOrganization;
  const url = n.url || pageUrl;
  return {
    source: 'web', company: org || '', extId: n.identifier?.value || n.identifier || url, title: n.title,
    url, applyUrl: url, locations: locs, workModeHint: /telecommute/i.test(n.jobLocationType || '') ? 'remote' : '',
    descriptionHtml: n.description, salary, employmentType: [].concat(n.employmentType || []).join(', '),
    postedAt: n.datePosted, deadline: n.validThrough || '',
  };
}
