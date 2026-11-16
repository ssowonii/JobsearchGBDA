// Tiny JSON-file persistence. Everything lives in ./data (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_COMPANIES } from './companies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const EMB_FILE = path.join(DATA_DIR, 'embeddings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const db = readJSON(DB_FILE, null) || { jobs: {}, companies: SEED_COMPANIES, meta: {} };
db.jobs ||= {};
db.companies ||= SEED_COMPANIES;
db.meta ||= {};

// embeddings: { [jobId]: { h: textHash, v: number[] } } plus "__profile"
const emb = readJSON(EMB_FILE, {});

let dbTimer = null;
let embTimer = null;
export function saveDb() {
  clearTimeout(dbTimer);
  dbTimer = setTimeout(() => writeAtomic(DB_FILE, db), 300);
}
export function saveEmb() {
  clearTimeout(embTimer);
  embTimer = setTimeout(() => writeAtomic(EMB_FILE, emb), 500);
}
export function flushNow() {
  clearTimeout(dbTimer);
  clearTimeout(embTimer);
  writeAtomic(DB_FILE, db);
  writeAtomic(EMB_FILE, emb);
}

export const store = {
  db,
  emb,
  jobs: () => Object.values(db.jobs),
  getJob: (id) => db.jobs[id],

  /** Insert or refresh a crawled job while preserving the user's tracking data. */
  upsertJob(job) {
    const now = new Date().toISOString();
    const prev = db.jobs[job.id];
    db.jobs[job.id] = {
      ...prev,
      ...job,
      app: prev?.app || job.app || { status: 'none', notes: '', deadline: job.deadline || '' },
      firstSeen: prev?.firstSeen || now,
      lastSeen: now,
      active: true,
    };
    saveDb();
    return db.jobs[job.id];
  },

  updateApp(id, patch) {
    const j = db.jobs[id];
    if (!j) return null;
    j.app = { ...j.app, ...patch, updatedAt: new Date().toISOString() };
    if (patch.status === 'applied' && !j.app.appliedAt) j.app.appliedAt = new Date().toISOString().slice(0, 10);
    saveDb();
    return j;
  },

  deleteJob(id) {
    delete db.jobs[id];
    delete emb[id];
    saveDb();
    saveEmb();
  },

  /** After a full crawl of a company, mark jobs no longer listed as closed (kept if you're tracking them). */
  markInactive(companyKey, seenIds) {
    for (const j of Object.values(db.jobs)) {
      if (j.companyKey === companyKey && !seenIds.has(j.id)) {
        if (j.app?.status && j.app.status !== 'none') j.active = false;
        else delete db.jobs[j.id];
      }
    }
    saveDb();
  },

  companies: () => db.companies,
  addCompany(c) {
    const key = companyKey(c);
    if (!db.companies.some((x) => companyKey(x) === key)) db.companies.push(c);
    saveDb();
  },
  removeCompany(key) {
    db.companies = db.companies.filter((x) => companyKey(x) !== key);
    saveDb();
  },
};

export function companyKey(c) {
  return `${c.ats}:${c.slug}${c.site ? '/' + c.site : ''}`.toLowerCase();
}
