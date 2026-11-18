'use client';

import { useEffect, useRef, useState } from 'react';
import { api, enc } from '@/lib/api';
import { MODE_LABEL } from '@/lib/filters';
import type { Hit, Job } from '@/lib/types';
import { CatTags, DeadlineField, EligTag, NotesField, StatusSelect } from './bits';
import { useHub } from './HubProvider';

/** <dialog> that opens modally while `open` is true. */
export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="detail" onClose={onClose}>
      {open && children}
    </dialog>
  );
}

export function JobDetail() {
  const { detail, closeDetail, jobs, removeJob, openDetail } = useHub();
  const [job, setJob] = useState<Job | null>(null);
  const [sim, setSim] = useState<{ mode: string; results: Hit[] } | 'loading' | null>(null);

  const loadSimilar = async (id: string) => {
    setSim('loading');
    setSim(await api(`/api/similar/${enc(id)}`));
  };

  useEffect(() => {
    setJob(null);
    setSim(null);
    if (!detail) return;
    api<Job>(`/api/jobs/${enc(detail.id)}`).then(setJob).catch((e) => alert(e.message));
    if (detail.showSimilar) loadSimilar(detail.id).catch(() => setSim(null));
  }, [detail]);

  // keep status/notes in sync with list updates
  const live = job ? { ...job, ...(jobs.find((x) => x.id === job.id) || {}), description: job.description } : null;
  const e = live?.eligibility || {};
  const byId = new Map(jobs.map((x) => [x.id, x]));
  const coopHint = live?.location?.isCanada && !(live.source === 'manual' && /waterlooworks/i.test(live.url || ''));

  return (
    <Modal open={!!detail} onClose={closeDetail}>
      <div className="detail-inner" key={live?.id || 'loading'}>
        {!live ? <p className="muted">Loading…</p> : (
          <>
            <div>
              <button className="btn small close-x" onClick={closeDetail}>✕</button>
              <h2>{live.title}</h2>
              <div className="co">{live.company} · {live.location?.display}</div>
            </div>
            <div className="tags">
              <CatTags job={live} />
              <EligTag job={live} />
              <span className="tag">{MODE_LABEL[live.workMode || 'unknown']}</span>
              {live.salary && <span className="tag">💰 {live.salary.text}</span>}
              <span className="tag">Match {live.match ?? '–'}%</span>
            </div>
            {(e.reasons || []).length > 0 && (
              <div className="panel" style={{ padding: '10px 14px' }}>
                <strong>Work-permit check</strong>
                <ul className="reasons">{e.reasons!.map((r) => <li key={r}>{r}</li>)}</ul>
              </div>
            )}
            {coopHint && (
              <p className="muted" style={{ margin: 0 }}>💡 Found this outside WaterlooWorks? Submit it to Co-operative and Experiential Education as an <b>arranged (self-sourced) co-op job</b> so it counts as a work term under your co-op permit.</p>
            )}
            <div className="row">
              <label style={{ flex: '1 1 160px' }}>Status <StatusSelect job={live} className="detail-status" /></label>
              <label style={{ flex: '1 1 160px' }}>Deadline <DeadlineField job={live} /></label>
            </div>
            <label>Notes <NotesField job={live} rows={2} placeholder="Referral contact, cover letter angle…" /></label>
            <div className="actions" style={{ margin: 0 }}>
              <a className="btn primary" href={live.applyUrl || live.url} target="_blank" rel="noopener">Apply ↗</a>
              <a className="btn" href={live.url} target="_blank" rel="noopener">View posting</a>
              <button className="btn" onClick={() => loadSimilar(live.id)}>Find similar jobs</button>
              <span className="spacer" />
              <button
                className="link"
                style={{ color: 'var(--bad)' }}
                onClick={async () => {
                  if (!confirm('Remove this posting from your hub?')) return;
                  await removeJob(live.id);
                  closeDetail();
                }}
              >Remove</button>
            </div>
            {sim === 'loading' && <p className="muted">Finding similar postings…</p>}
            {sim && sim !== 'loading' && (
              <div>
                <strong>Similar jobs</strong> <span className="muted">({sim.mode === 'semantic' ? 'embedding similarity' : 'keyword similarity'})</span>
                <div className="sim-list">
                  {sim.results.map((r) => ({ ...r, j: byId.get(r.id) })).filter((r) => r.j && r.j.app?.status !== 'hidden').map((r) => (
                    <div key={r.id} className="sim-item" onClick={() => openDetail(r.id)}>
                      <span><b>{r.j!.title}</b> · {r.j!.company} <span className="muted">· {r.j!.location?.display || ''}</span></span>
                      <span className="muted">{r.score}%</span>
                    </div>
                  ))}
                  {!sim.results.length && <p className="muted">Nothing similar yet.</p>}
                </div>
              </div>
            )}
            <div className="detail-desc">{live.description || 'No description captured.'}</div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function ProfileDialog() {
  const { profileOpen, setProfileOpen, load } = useHub();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profileOpen) api<{ text: string }>('/api/profile').then((p) => setText(p.text)).catch((e) => alert(e.message));
  }, [profileOpen]);

  return (
    <Modal open={profileOpen} onClose={() => setProfileOpen(false)}>
      <form
        className="detail-inner"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          try {
            await api('/api/profile', { method: 'PUT', body: { text } });
            setProfileOpen(false);
            await load();
          } catch (err) {
            alert((err as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <h2>Your profile</h2>
        <p className="muted">Used for the Match % (embedding similarity to each job). It was taken from your resume, and you can edit it to steer the ranking.</p>
        <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row end">
          <button type="button" className="btn" onClick={() => setProfileOpen(false)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving}>Save & re-rank</button>
        </div>
      </form>
    </Modal>
  );
}
