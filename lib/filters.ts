import type { Job } from './types';

export const STATUSES: [string, string][] = [
  ['none', '— Track…'], ['saved', '★ Saved'], ['applied', 'Applied'], ['interview', 'Interviewing'],
  ['offer', 'Offer 🎉'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['hidden', 'Not interested'],
];
export const CAT_LABEL: Record<string, string> = { content: 'Content', marketing: 'Marketing', ux: 'UX/UI' };
export const MODE_LABEL: Record<string, string> = { remote: '🏠 Remote', hybrid: '🔀 Hybrid', onsite: '🏢 In-person', unknown: '❔ Type not stated' };

export type Filters = {
  sort: string;
  modes: string[];
  region: 'ontario' | 'canada' | 'all';
  remoteCanada: boolean;
  city: string;
  cats: string[];
  terms: string[];
  hasSalary: boolean;
  minPay: number;
  hideBlocked: boolean;
  company: string;
  dreamOnly: boolean;
};

export const DEFAULTS: Filters = {
  sort: 'best', modes: ['remote', 'hybrid', 'onsite', 'unknown'], region: 'ontario', remoteCanada: true, city: '',
  cats: ['content', 'marketing', 'ux'], terms: ['Winter 2027', 'Summer 2027', '8mo', 'other'], hasSalary: false, minPay: 0,
  hideBlocked: true, company: '', dreamOnly: false,
};

const KEY = 'ih-filters';
export function loadFilters(): Filters {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveFilters(f: Filters) {
  try {
    if (f.sort !== 'relevance') localStorage.setItem(KEY, JSON.stringify(f));
  } catch {}
}

export const termTags = (j: Job) => {
  const t = new Set<string>((j.term?.terms || []).filter((x) => x === 'Winter 2027' || x === 'Summer 2027'));
  if (j.term?.eightMonth) t.add('8mo');
  if (!t.size) t.add('other');
  return t;
};
const userAdded = (j: Job) => ['manual', 'linkedin', 'indeed'].includes(j.source);
export const isTracked = (j: Job) => !!j.app?.status && !['none', 'hidden'].includes(j.app.status);

export function passes(j: Job, F: Filters, hits: Map<string, number> | null, focus: Set<string> | null): boolean {
  if (j.app?.status === 'hidden') return false;
  if (focus) return focus.has(j.id);
  if (F.hideBlocked && j.eligibility?.status === 'blocked') return false;
  if (!F.modes.includes(j.workMode || 'unknown')) return false;
  const L = j.location || {};
  const unknownLoc = !L.isCanada && (L.country === 'UNKNOWN' || L.country === 'REMOTE?');
  const remoteOk = j.workMode === 'remote' && (L.isCanada || !!L.remoteFromCanada);
  if (F.region === 'ontario') {
    const ok = L.isOntario || (F.remoteCanada && remoteOk) || (userAdded(j) && unknownLoc);
    if (!ok) return false;
  } else if (F.region === 'canada') {
    if (!L.isCanada && !unknownLoc && !(F.remoteCanada && remoteOk)) return false;
  }
  if (F.city && !(L.cities || []).includes(F.city)) return false;
  const cats = j.categories?.length ? j.categories : ['other'];
  if (!cats.some((c) => F.cats.includes(c))) return false;
  if (![...termTags(j)].some((t) => F.terms.includes(t))) return false;
  if ((F.hasSalary || F.minPay > 0) && !j.salary) return false;
  if (F.minPay > 0 && j.salary && j.salary.hourlyMax < F.minPay) return false;
  if (F.company && j.company !== F.company) return false;
  if (F.dreamOnly && !j.dream) return false;
  if (hits && !hits.has(j.id)) return false;
  return true;
}

type Cmp = (a: Job, b: Job) => number;
export function sorter(sort: string, hits: Map<string, number> | null): Cmp {
  const S: Record<string, Cmp> = {
    relevance: (a, b) => (hits?.get(b.id) || 0) - (hits?.get(a.id) || 0),
    best: (a, b) => b.rank - a.rank,
    salaryAsc: (a, b) => (a.salary ? a.salary.hourlyMin : Infinity) - (b.salary ? b.salary.hourlyMin : Infinity) || b.rank - a.rank,
    salaryDesc: (a, b) => (b.salary ? b.salary.hourlyMax : -1) - (a.salary ? a.salary.hourlyMax : -1) || b.rank - a.rank,
    newest: (a, b) => String(b.postedAt || b.firstSeen).localeCompare(String(a.postedAt || a.firstSeen)),
    deadline: (a, b) => String(a.app?.deadline || a.deadline || '9999').localeCompare(String(b.app?.deadline || b.deadline || '9999')),
  };
  return S[sort] || S.best;
}

export const fmtDate = (d?: string | null) => {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(+x) ? String(d) : x.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: x.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
};
export const daysLeft = (d?: string | null) => {
  if (!d) return null;
  const n = Math.ceil((+new Date(d) - +new Date()) / 864e5);
  return Number.isFinite(n) ? n : null;
};
