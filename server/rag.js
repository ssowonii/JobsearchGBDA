// Retrieval layer: OpenAI embeddings (text-embedding-3-small) + BM25 keyword index.
// - Every job is embedded once (re-embedded only when its text changes).
// - "Match %" = cosine similarity between the job and your resume profile.
// - Search = hybrid (semantic + keyword); works keyword-only if no API key is set.
import { store, saveEmb } from './store.js';
import { hashText } from './normalize.js';
import { DEFAULT_PROFILE, PREFERENCES, TARGET_ROLES } from './profile.js';

const MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const DIMS = 512;
export const hasKey = () => Boolean(process.env.OPENAI_API_KEY);
// Last OpenAI failure (e.g. no credits). While set, everything falls back to keyword search;
// we retry after 10 minutes.
export const openaiState = { error: null, at: 0 };
export const hasOpenAI = () => hasKey() && !(openaiState.error && Date.now() - openaiState.at < 10 * 60 * 1000);

export function profileText() {
  return store.db.meta.profileText || DEFAULT_PROFILE;
}

// ---------- what gets embedded ----------
// Company boilerplate ("About Manulife…", EEO statements) repeats across a company's postings
// and would make every posting from that company look alike, so we strip repeated paragraphs.
const paraKey = (p) => p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
function boilerplateSets(jobs) {
  const perCompany = new Map();
  const global = new Map();
  for (const j of jobs) {
    const keys = new Set((j.description || '').split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40).map(paraKey));
    const m = perCompany.get(j.companyKey) || new Map();
    for (const k of keys) {
      m.set(k, (m.get(k) || 0) + 1);
      global.set(k, (global.get(k) || 0) + 1);
    }
    perCompany.set(j.companyKey, m);
  }
  return (j, key) => (perCompany.get(j.companyKey)?.get(key) || 0) >= 3 || (global.get(key) || 0) >= 5;
}

const CAT_NAME = { content: 'content creation', marketing: 'marketing', ux: 'UX/UI design' };
// The role itself, without "Winter Co-op 2027 – … (8 months)" noise that every posting shares.
const roleOnly = (t) => t.replace(/\b(winter|summer|fall|spring|autumn)\b|\b20\d\d\b|\b(co-?op|internships?|interns?|students?|work term)\b|\(?\b\d+\s*(-|–)?\s*months?\)?|[–—|]/gi, ' ').replace(/[\s,/-]+/g, ' ').trim();
const titleText = (j) => `${roleOnly(j.title) || j.title}${j.categories?.length ? ` (${j.categories.map((c) => CAT_NAME[c]).join(', ')})` : ''}`;
function bodyText(j, isBoiler) {
  const paras = (j.description || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const kept = paras.filter((p) => p.length <= 40 || !isBoiler(j, paraKey(p)));
  return `${j.title}\n${(kept.length >= 3 ? kept : paras).join('\n')}`.slice(0, 5000);
}

async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 8000) || ' ');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: batch, dimensions: DIMS }),
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body.slice(0, 200);
      try { msg = JSON.parse(body).error?.message || msg; } catch {}
      Object.assign(openaiState, { error: `OpenAI ${res.status}: ${msg}`, at: Date.now() });
      throw new Error(openaiState.error);
    }
    openaiState.error = null;
    const data = await res.json();
    for (const d of data.data.sort((a, b) => a.index - b.index)) out.push(d.embedding.map((x) => Math.round(x * 1e5) / 1e5));
  }
  return out;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Embed new/changed jobs: a title vector (t) and a cleaned-description vector (v). */
export async function ensureEmbeddings(jobs, log = () => {}) {
  if (!hasOpenAI()) return 0;
  const isBoiler = boilerplateSets(store.jobs());
  const work = jobs.map((j) => {
    const tt = titleText(j);
    const bt = bodyText(j, isBoiler);
    return { j, tt, bt, h: hashText(`${MODEL}|${tt}|${bt}`) };
  }).filter((w) => store.emb[w.j.id]?.h !== w.h || !store.emb[w.j.id]?.t);
  if (work.length) {
    log(`Embedding ${work.length} job(s) with ${MODEL}…`);
    const vecs = await embed(work.flatMap((w) => [w.tt, w.bt]));
    work.forEach((w, i) => (store.emb[w.j.id] = { h: w.h, t: vecs[2 * i], v: vecs[2 * i + 1] }));
    saveEmb();
  }
  return work.length;
}

// Two profile vectors: your skills/experience (generic co-op & school words removed, since
// every co-op posting shares them) and your target roles (compared against job titles).
function profileParts() {
  const text = profileText();
  const rolesLine = (text.match(/^target roles?:(.*)$/im) || [])[1] || TARGET_ROLES;
  const skills = text
    .split('\n')
    .filter((l) => !/^(education|target roles?)\s*:/i.test(l.trim()))
    .join('\n')
    .replace(/\b(undergraduate|co-?op|internships?|interns?|university|student)\b/gi, '');
  return { skills, roles: `${rolesLine}. ${TARGET_ROLES}` };
}
async function profileVectors() {
  const { skills, roles } = profileParts();
  const h = hashText(`${MODEL}|${skills}|${roles}`);
  if (store.emb.__profile?.h !== h || !store.emb.__profile?.r) {
    const [sv, rv] = await embed([skills, roles]);
    store.emb.__profile = { h, v: sv, r: rv };
    saveEmb();
  }
  return store.emb.__profile;
}

const qCache = new Map();
async function queryVector(q) {
  if (qCache.has(q)) return qCache.get(q);
  const [v] = await embed([q]);
  qCache.set(q, v);
  if (qCache.size > 200) qCache.delete(qCache.keys().next().value);
  return v;
}

/** Raw resume↔job similarity: skills vs description (60%) + target roles vs title (40%). */
export function rawMatch(p, e) {
  return 0.6 * dot(p.v, e.v) + 0.4 * dot(p.r, e.t);
}

// ---------- BM25 ----------
const STOP = new Set('a an the and or of to in for on with at by from as is are be this that you your we our will it its their they'.split(' '));
const tokenize = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9+#/ ]+/g, ' ').split(/[\s/]+/).filter((t) => t.length > 1 && !STOP.has(t));

let bm25 = null;
let bm25Key = '';
function getBM25() {
  const jobs = store.jobs();
  const key = jobs.length + ':' + jobs.reduce((s, j) => s + j.textHash, '').length;
  if (bm25 && bm25Key === key) return bm25;
  const docs = jobs.map((j) => {
    const toks = [...tokenize(j.title), ...tokenize(j.title), ...tokenize(j.title), ...tokenize(j.company), ...tokenize((j.description || '').slice(0, 6000))];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { id: j.id, tf, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  bm25 = { docs, df, avg, N: docs.length };
  bm25Key = key;
  return bm25;
}

function lexicalScores(query) {
  const { docs, df, avg, N } = getBM25();
  const q = [...new Set(tokenize(query))];
  const k1 = 1.4, b = 0.75;
  const scores = new Map();
  for (const d of docs) {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg));
    }
    if (s > 0) scores.set(d.id, s);
  }
  return scores;
}

const normalizeMap = (m) => {
  const max = Math.max(0, ...m.values());
  const out = new Map();
  for (const [k, v] of m) out.set(k, max ? v / max : 0);
  return out;
};

// ---------- scoring ----------
/** Match % of each job to the resume profile. Stored on job.match (0–100). */
// Calibrated on real postings (Nov 2026): raw ≈0.35 for unrelated roles (banking, risk),
// ≈0.50–0.56 for a strong content/marketing/UX fit.
const MATCH_LO = 0.35, MATCH_HI = 0.55;
export async function refreshMatchScores() {
  const jobs = store.jobs();
  let p = null;
  if (hasOpenAI()) p = await profileVectors().catch(() => null);
  if (p) {
    for (const j of jobs) {
      const e = store.emb[j.id];
      if (e?.t) j.match = Math.round(Math.max(0, Math.min(1, (rawMatch(p, e) - MATCH_LO) / (MATCH_HI - MATCH_LO))) * 100);
    }
  }
  const missing = jobs.filter((j) => !p || !store.emb[j.id]?.t);
  if (missing.length) {
    const lex = normalizeMap(lexicalScores(profileText()));
    for (const j of missing) j.match = Math.round((lex.get(j.id) || 0) * 85);
  }
}

/** Overall ranking used for "Best match" sort: resume fit + your preferences. */
export function rankScore(j) {
  let s = j.match || 0;
  const cities = (j.location?.cities || []).map((c) => c.toLowerCase());
  if (j.location?.isOntario) s += 10;
  if (cities.some((c) => PREFERENCES.homeCities.includes(c))) s += 6;
  else if (cities.some((c) => PREFERENCES.gtaCities.includes(c))) s += 4;
  if (j.workMode === 'remote' && j.location?.isCanada) s += 3;
  if (j.categories?.length) s += 6;
  if (j.term?.eightMonth || j.term?.terms?.some((t) => t === 'Winter 2027' || t === 'Summer 2027')) s += 4;
  if (j.eligibility?.status === 'blocked') s -= 40;
  else if (j.eligibility?.status === 'warn') s -= 4;
  if (j.active === false) s -= 20;
  return Math.round(s);
}

/** Hybrid semantic + keyword search. Returns [{id, score}] sorted desc. */
export async function search(query, limit = 300) {
  const lex = normalizeMap(lexicalScores(query));
  let combined = new Map(lex);
  let mode = 'keyword';
  const qv = hasOpenAI() ? await queryVector(query).catch(() => null) : null;
  if (qv) {
    const sem = new Map();
    for (const j of store.jobs()) {
      const e = store.emb[j.id];
      if (e?.t) sem.set(j.id, 0.5 * dot(qv, e.t) + 0.5 * dot(qv, e.v));
    }
    const semN = normalizeMap(new Map([...sem].map(([k, v]) => [k, Math.max(0, v - 0.2)])));
    combined = new Map();
    for (const id of new Set([...semN.keys(), ...lex.keys()])) combined.set(id, 0.75 * (semN.get(id) || 0) + 0.25 * (lex.get(id) || 0));
    mode = 'hybrid';
  }
  const results = [...combined].filter(([, s]) => s > 0.05).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => ({ id, score: Math.round(score * 100) }));
  return { mode, results };
}

/** Nearest neighbours of a job (by embedding, or keywords as fallback). */
export async function similar(id, limit = 12) {
  const j = store.getJob(id);
  if (!j) return { mode: 'none', results: [] };
  const e = store.emb[id];
  if (e?.t) {
    const res = [];
    for (const o of store.jobs()) {
      const f = store.emb[o.id];
      if (o.id === id || !f?.t) continue;
      res.push({ id: o.id, score: Math.round((0.65 * dot(e.t, f.t) + 0.35 * dot(e.v, f.v)) * 100) });
    }
    return { mode: 'semantic', results: res.sort((a, b) => b.score - a.score).slice(0, limit) };
  }
  const { results } = await search(`${j.title} ${j.title} ${(j.description || '').slice(0, 400)}`, limit + 1);
  return { mode: 'keyword', results: results.filter((r) => r.id !== id).slice(0, limit) };
}
