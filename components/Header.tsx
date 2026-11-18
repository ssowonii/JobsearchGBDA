'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { isTracked } from '@/lib/filters';
import { useHub } from './HubProvider';

export function Header() {
  const { jobs, meta, task, setProfileOpen, runCrawl, setReview } = useHub();
  const count = (s: string) => jobs.filter((j) => j.app?.status === s).length;
  const core = jobs.filter((j) => j.categories?.length && j.location?.isOntario && j.eligibility?.status !== 'blocked').length;
  const stats: [number, string][] = [
    [jobs.length, 'jobs crawled'], [core, 'core in Ontario'], [count('saved'), 'saved'], [count('applied'), 'applied'], [count('interview'), 'interviews'],
  ];
  const last = meta?.lastCrawl ? `Last crawl ${new Date(meta.lastCrawl).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Never crawled';
  const badge = !meta ? '' : meta.hasOpenAI ? '● Semantic RAG on' : meta.openaiError ? '⚠ Keyword search (OpenAI unavailable)' : meta.hasKey ? '○ Keyword search (embeddings pending)' : '○ Keyword search (add OpenAI key)';
  const busy = !!task?.running;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  };

  return (
    <header className="topbar">
      <div className="brand">
        <h1>Internship Hub</h1>
        <p className="sub">Content · Marketing · UX/UI co-ops in Ontario. Built for a study + co-op permit holder.</p>
      </div>
      <div className="stats">
        {stats.map(([n, l]) => (
          <div className="stat" key={l}><b>{n}</b><span>{l}</span></div>
        ))}
      </div>
      <div className="top-actions">
        <span className={`pill ${meta?.hasOpenAI ? 'on' : ''}`} title={meta?.openaiError || (meta?.hasOpenAI ? 'OpenAI embeddings + keyword hybrid search' : '')}>{badge}</span>
        {!!meta?.pendingReview && (
          <button className="btn review-btn" onClick={() => setReview({ ids: null, label: 'All dream companies' })} title="Dream-company roles found but not added to your hub yet">
            ✦ Review {meta.pendingReview} dream role{meta.pendingReview === 1 ? '' : 's'}
          </button>
        )}
        <button className="btn" onClick={() => setProfileOpen(true)}>Profile</button>
        <button className="btn primary" title={last} disabled={busy} onClick={runCrawl}>↻ Refresh all</button>
        <button className="link" onClick={logout} title="Sign out">Sign out</button>
      </div>
    </header>
  );
}

export function Tabs() {
  const path = usePathname();
  const { jobs } = useHub();
  const tracked = jobs.filter(isTracked).length;
  const tab = (href: string, label: React.ReactNode) => (
    <Link href={href} className={`tab ${path === href ? 'active' : ''}`} role="tab" aria-selected={path === href}>{label}</Link>
  );
  return (
    <nav className="tabs" role="tablist">
      {tab('/', 'Browse jobs')}
      {tab('/applications', <>My applications <span className="count">{tracked || ''}</span></>)}
      {tab('/add', '+ Add posting')}
    </nav>
  );
}

export function DreamPanel() {
  const { task, taskVisible, setTaskVisible, runDream } = useHub();
  const [company, setCompany] = useState('');
  const [includeAll, setIncludeAll] = useState(false);
  const busy = !!task?.running;
  const label = !task ? '' : task.running ? `${task.label}…` : task.error ? `Failed: ${task.error}` : task.result?.message || `${task.label}: done`;
  const pct = task?.kind === 'crawl' && task.total ? Math.round((task.done / task.total) * 100) : null;

  return (
    <section className="panel dream">
      <form
        className="dream-form"
        onSubmit={(e) => {
          e.preventDefault();
          const c = company.trim();
          if (c) runDream(c, includeAll);
        }}
      >
        <label htmlFor="dreamInput" className="dream-label">✦ Dream company</label>
        <input id="dreamInput" placeholder="Company name (e.g. Shopify) or careers page URL" autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
        <label className="check"><input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} /> include entry-level non-intern roles</label>
        <button className="btn primary" type="submit" disabled={busy}>Search their jobs</button>
      </form>
      {taskVisible && task && (
        <div className="taskbox">
          <div className="task-head">
            <span className={`spinner ${task.running ? '' : 'done'}`} />
            <strong>{label}{pct != null && task.running ? ` (${task.done}/${task.total} boards)` : ''}</strong>
            <button className="link" onClick={() => setTaskVisible(false)}>Hide</button>
          </div>
          {pct != null && task.running && <div className="progress"><i style={{ width: `${pct}%` }} /></div>}
          <TaskLog lines={task.log} />
        </div>
      )}
    </section>
  );
}

function TaskLog({ lines }: { lines: string[] }) {
  return (
    <pre ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>{lines.join('\n')}</pre>
  );
}
