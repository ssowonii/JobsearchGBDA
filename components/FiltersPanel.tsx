'use client';

import { DEFAULTS, type Filters } from '@/lib/filters';
import type { Job } from '@/lib/types';

type Props = { F: Filters; setF: (f: Filters) => void; jobs: Job[]; searching: boolean };

const uniqSorted = (xs: string[]) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));

export function FiltersPanel({ F, setF, jobs, searching }: Props) {
  const set = (patch: Partial<Filters>) => setF({ ...F, ...patch });
  const toggle = (key: 'modes' | 'cats' | 'terms', v: string, on: boolean) =>
    set({ [key]: on ? [...F[key], v] : F[key].filter((x) => x !== v) } as Partial<Filters>);
  const cities = uniqSorted(jobs.flatMap((j) => (j.location?.isOntario ? j.location.cities : []) || []));
  const otherCities = uniqSorted(jobs.flatMap((j) => (!j.location?.isOntario ? j.location?.cities : []) || []));
  const companies = uniqSorted(jobs.map((j) => j.company).filter(Boolean));

  const box = (key: 'modes' | 'cats' | 'terms', v: string, label: string) => (
    <label className="check" key={v}>
      <input type="checkbox" checked={F[key].includes(v)} onChange={(e) => toggle(key, v, e.target.checked)} /> {label}
    </label>
  );

  return (
    <aside className="filters">
      <div className="f-head"><h2>Filters</h2><button className="link" onClick={() => setF({ ...DEFAULTS })}>Reset</button></div>

      <label className="f-label" htmlFor="sortSel">Sort by</label>
      <select id="sortSel" value={F.sort === 'relevance' && !searching ? 'best' : F.sort} onChange={(e) => set({ sort: e.target.value })}>
        {searching && <option value="relevance">Search relevance</option>}
        <option value="best">Best match (resume + Ontario)</option>
        <option value="salaryAsc">Salary: low → high</option>
        <option value="salaryDesc">Salary: high → low</option>
        <option value="newest">Newest first</option>
        <option value="deadline">Deadline soonest</option>
      </select>

      <fieldset><legend>Job type</legend>
        {box('modes', 'remote', 'Remote')}
        {box('modes', 'hybrid', 'Hybrid')}
        {box('modes', 'onsite', 'In-person')}
        {box('modes', 'unknown', 'Not specified')}
      </fieldset>

      <fieldset><legend>Location</legend>
        <div className="seg">
          {(['ontario', 'canada', 'all'] as const).map((v) => (
            <button key={v} className={F.region === v ? 'on' : ''} onClick={() => set({ region: v })}>{v === 'ontario' ? 'Ontario' : v === 'canada' ? 'Canada' : 'All'}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={F.remoteCanada} onChange={(e) => set({ remoteCanada: e.target.checked })} /> + Remote roles workable from Canada</label>
        <select value={F.city} onChange={(e) => set({ city: e.target.value })}>
          <option value="">Any city</option>
          <optgroup label="Ontario">{cities.map((c) => <option key={c}>{c}</option>)}</optgroup>
          <optgroup label="Elsewhere in Canada">{otherCities.map((c) => <option key={c}>{c}</option>)}</optgroup>
        </select>
      </fieldset>

      <fieldset><legend>Focus area</legend>
        {box('cats', 'content', 'Content creation')}
        {box('cats', 'marketing', 'Marketing')}
        {box('cats', 'ux', 'UX/UI design')}
        {box('cats', 'other', 'Other student roles')}
      </fieldset>

      <fieldset><legend>Work term</legend>
        {box('terms', 'Winter 2027', 'Winter 2027 (Jan–Apr)')}
        {box('terms', 'Summer 2027', 'Summer 2027 (May–Aug)')}
        {box('terms', '8mo', '8-month (Winter + Summer)')}
        {box('terms', 'other', 'Other / not stated')}
      </fieldset>

      <fieldset><legend>Salary</legend>
        <label className="check"><input type="checkbox" checked={F.hasSalary} onChange={(e) => set({ hasSalary: e.target.checked })} /> Only postings with pay listed</label>
        <label className="f-label" htmlFor="minPay">Min hourly (CAD): <span>${F.minPay}</span></label>
        <input type="range" id="minPay" min={0} max={45} step={1} value={F.minPay} onChange={(e) => set({ minPay: Number(e.target.value) })} />
      </fieldset>

      <fieldset><legend>Eligibility</legend>
        <label className="check"><input type="checkbox" checked={F.hideBlocked} onChange={(e) => set({ hideBlocked: e.target.checked })} /> Hide roles I can&apos;t take (citizenship/PR, outside Canada)</label>
      </fieldset>

      <fieldset><legend>Company</legend>
        <select value={F.company} onChange={(e) => set({ company: e.target.value })}>
          <option value="">All companies</option>
          {companies.map((c) => <option key={c}>{c}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={F.dreamOnly} onChange={(e) => set({ dreamOnly: e.target.checked })} /> Dream-company results only</label>
      </fieldset>
    </aside>
  );
}
