'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { MODE_LABEL } from '@/lib/filters';
import type { Job } from '@/lib/types';
import { CatTags, EligTag } from './bits';
import { Modal } from './Dialogs';
import { useHub } from './HubProvider';

/**
 * Dream-company roles wait here until you pick which ones join the hub.
 * Tick several (Shift-click ticks a range), then "Add to hub". Unticked roles stay here unless you dismiss them.
 */
export function ReviewDialog() {
  const { review, setReview, load, setFocus } = useHub();
  const [all, setAll] = useState<Job[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const lastClicked = useRef<number | null>(null);

  useEffect(() => {
    setAll(null);
    setPicked(new Set());
    setNote('');
    lastClicked.current = null;
    if (!review) return;
    api<{ jobs: Job[] }>('/api/review').then((d) => setAll(d.jobs)).catch((e) => setNote(`Couldn't load: ${(e as Error).message}`));
  }, [review]);

  // One search's results when opened from a dream search (falls back to everything pending).
  const list = useMemo(() => {
    if (!all) return null;
    const scoped = review?.ids ? all.filter((j) => review.ids!.has(j.id)) : all;
    return scoped.length ? scoped : all;
  }, [all, review]);
  const scopedToSearch = !!(review?.ids && all && list && list.length < all.length);

  const close = () => setReview(null);

  const toggle = (i: number, shift: boolean) => {
    if (!list) return;
    const next = new Set(picked);
    const on = !next.has(list[i].id);
    const from = shift && lastClicked.current != null ? Math.min(lastClicked.current, i) : i;
    const to = shift && lastClicked.current != null ? Math.max(lastClicked.current, i) : i;
    for (let k = from; k <= to; k++) (on ? next.add(list[k].id) : next.delete(list[k].id));
    lastClicked.current = i;
    setPicked(next);
  };
  const allPicked = !!list?.length && list.every((j) => picked.has(j.id));
  const setAllPicked = (on: boolean) => setPicked(on ? new Set(list!.map((j) => j.id)) : new Set());

  const apply = async (add: string[], dismiss: string[]) => {
    setBusy(true);
    try {
      const r = await api<{ added: number; dismissed: number }>('/api/review', { method: 'POST', body: { add, dismiss } });
      await load();
      const left = (all || []).filter((j) => !add.includes(j.id) && !dismiss.includes(j.id));
      setAll(left);
      setPicked(new Set());
      lastClicked.current = null;
      if (r.added) setFocus({ ids: new Set(add), label: `${r.added} role(s) just added` });
      const msg = [r.added && `Added ${r.added} to your hub`, r.dismissed && `dismissed ${r.dismissed}`].filter(Boolean).join(', ');
      if (!left.length || (review?.ids && !left.some((j) => review.ids!.has(j.id)))) close();
      else setNote(`${msg}.`);
    } catch (e) {
      setNote(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const chosen = list ? list.filter((j) => picked.has(j.id)).map((j) => j.id) : [];
  const rest = list ? list.filter((j) => !picked.has(j.id)).map((j) => j.id) : [];

  return (
    <Modal open={!!review} onClose={close}>
      <div className="detail-inner review">
        <div>
          <button className="btn small close-x" onClick={close}>✕</button>
          <h2>Add dream-company roles</h2>
          <div className="co">
            {review?.label}
            {list ? ` · ${list.length} role${list.length === 1 ? '' : 's'} waiting` : ''}
            {scopedToSearch && <> · <button className="link" onClick={() => setReview({ ids: null, label: 'All dream companies' })}>show all {all!.length} waiting</button></>}
          </div>
          <p className="muted" style={{ margin: '6px 0 0' }}>Tick the roles you want in your hub. Shift-click to tick a range. Roles you leave unticked stay here for later.</p>
        </div>

        {!list ? (
          <p className="muted">{note || 'Loading…'}</p>
        ) : !list.length ? (
          <p className="muted">Nothing waiting for review.</p>
        ) : (
          <>
            <div className="review-bar">
              <label className="check"><input type="checkbox" checked={allPicked} onChange={(e) => setAllPicked(e.target.checked)} /> Select all</label>
              <span className="muted">{picked.size} selected</span>
              {note && <span className="muted">{note}</span>}
            </div>
            <ul className="review-list">
              {list.map((j, i) => {
                const terms = (j.term?.terms || []).filter((t) => /202[6-8]/.test(t));
                return (
                  <li key={j.id} className={picked.has(j.id) ? 'on' : ''}>
                    <label
                      className="review-row"
                      tabIndex={0}
                      role="checkbox"
                      aria-checked={picked.has(j.id)}
                      onClick={(e) => { e.preventDefault(); toggle(i, e.shiftKey); }}
                      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(i, e.shiftKey); } }}
                    >
                      <input type="checkbox" checked={picked.has(j.id)} readOnly tabIndex={-1} />
                      <span className="review-main">
                        <b>{j.title}</b>
                        <span className="muted">
                          {j.company} · {j.location?.display || 'Location not stated'} · {MODE_LABEL[j.workMode || 'unknown'] || MODE_LABEL.unknown}
                          {terms.length ? ` · ${terms.join(', ')}` : ''}
                        </span>
                        <span className="tags"><CatTags job={j} /><EligTag job={j} /></span>
                      </span>
                      <span className="review-score" title="Resume match">{j.match ?? '–'}%</span>
                    </label>
                    <a className="link review-open" href={j.applyUrl || j.url} target="_blank" rel="noopener">Posting ↗</a>
                  </li>
                );
              })}
            </ul>
            <div className="review-actions">
              <button className="btn" disabled={busy || !rest.length} onClick={() => apply([], rest)} title="Hide the unticked roles from this list">
                Dismiss {picked.size ? 'unticked' : 'all'} ({rest.length})
              </button>
              <span className="spacer" />
              <button className="btn" onClick={close}>Later</button>
              <button className="btn primary" disabled={busy || !chosen.length} onClick={() => apply(chosen, [])}>
                {busy ? 'Saving…' : `Add ${chosen.length || ''} to hub`}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
