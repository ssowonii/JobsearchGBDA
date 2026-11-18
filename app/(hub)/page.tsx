'use client';

import { useEffect, useMemo, useState } from 'react';
import { FiltersPanel } from '@/components/FiltersPanel';
import { useHub } from '@/components/HubProvider';
import { JobCard } from '@/components/JobCard';
import { api, enc } from '@/lib/api';
import { DEFAULTS, loadFilters, passes, saveFilters, sorter, type Filters } from '@/lib/filters';
import type { Hit } from '@/lib/types';

export default function BrowsePage() {
  const { jobs, loading, focus, setFocus } = useHub();
  const [F, setFState] = useState<Filters>(DEFAULTS);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Map<string, number> | null>(null);
  const [searchMode, setSearchMode] = useState('');

  useEffect(() => setFState(loadFilters()), []);
  const setF = (f: Filters) => {
    setFState(f);
    saveFilters(f);
  };

  const visible = useMemo(() => {
    const focusIds = focus?.ids || null;
    return jobs.filter((j) => passes(j, F, hits, focusIds)).sort(sorter(F.sort, hits));
  }, [jobs, F, hits, focus]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = q.trim();
    if (!query) return clearSearch();
    setSearchMode('Searching…');
    try {
      const { mode, results } = await api<{ mode: string; results: Hit[] }>(`/api/search?q=${enc(query)}`);
      setHits(new Map(results.map((r) => [r.id, r.score])));
      setSearchMode(mode === 'hybrid' ? '· ranked by semantic + keyword similarity' : '· keyword match (add an OpenAI key for semantic search)');
      setFState({ ...F, sort: 'relevance' });
    } catch (err) {
      setSearchMode(`Search failed: ${(err as Error).message}`);
    }
  };
  const clearSearch = () => {
    setHits(null);
    setQ('');
    setSearchMode('');
    if (F.sort === 'relevance') setFState({ ...F, sort: loadFilters().sort });
  };

  return (
    <main className="layout">
      <FiltersPanel F={F} setF={setF} jobs={jobs} searching={!!hits} />
      <section className="results">
        <form className="searchbar" onSubmit={runSearch}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Semantic search, e.g. “short-form video for a beauty brand” or “Figma design system co-op”" />
          <button className="btn" type="submit">Search</button>
        </form>
        <div className="result-meta">
          <span>{visible.length} job{visible.length === 1 ? '' : 's'}</span>
          <span className="muted">{searchMode}</span>
          {hits && <button className="link" onClick={clearSearch}>Clear search</button>}
        </div>
        <div className="list">
          {focus && (
            <div className="panel" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong>✦ {focus.label}</strong>
              <span className="muted">Filters are paused for dream-company results. Ineligible roles are shown with a ⛔ badge.</span>
              <button className="link" onClick={() => setFocus(null)}>Back to all jobs</button>
            </div>
          )}
          {loading ? (
            <p className="muted">Loading…</p>
          ) : visible.length ? (
            visible.slice(0, 400).map((j) => <JobCard key={j.id} job={j} hit={hits?.get(j.id)} />)
          ) : (
            <div className="empty-state">
              <p><strong>{jobs.length ? 'No jobs match these filters.' : 'No jobs yet.'}</strong></p>
              <p>Try &quot;Canada&quot; or &quot;All&quot; locations, tick &quot;Other student roles&quot;, or click <b>Refresh all</b> to crawl again.</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
