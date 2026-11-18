'use client';

import { useRef } from 'react';
import { CAT_LABEL, STATUSES } from '@/lib/filters';
import type { Job } from '@/lib/types';
import { useHub } from './HubProvider';

export function StatusSelect({ job, className = '' }: { job: Job; className?: string }) {
  const { updateApp } = useHub();
  const status = job.app?.status || 'none';
  return (
    <select
      className={`status ${className} status-${status}`}
      aria-label="Application status"
      value={status}
      onChange={(e) => updateApp(job.id, { status: e.target.value }).catch((err) => alert(err.message))}
    >
      {STATUSES.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}

export function EligTag({ job }: { job: Job }) {
  const e = job.eligibility || {};
  const tip = (e.reasons || []).join('\n');
  if (e.status === 'blocked') return <span className="tag blocked" title={tip}>⛔ Not eligible</span>;
  if (e.status === 'warn') return <span className="tag warn" title={tip}>⚠ Check eligibility</span>;
  return <span className="tag ok" title={tip || 'No citizenship/PR requirement found'}>✓ Permit-friendly</span>;
}

export function CatTags({ job }: { job: Job }) {
  return (
    <>
      {(job.categories || []).map((c) => (
        <span key={c} className={`tag ${c}`}>{CAT_LABEL[c]}</span>
      ))}
    </>
  );
}

/** Notes textarea that saves 600 ms after you stop typing. */
export function NotesField({ job, rows, placeholder }: { job: Job; rows?: number; placeholder: string }) {
  const { updateApp } = useHub();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <textarea
      className="notes"
      rows={rows}
      placeholder={placeholder}
      defaultValue={job.app?.notes || ''}
      onChange={(e) => {
        const v = e.target.value;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => updateApp(job.id, { notes: v }).catch(() => {}), 600);
      }}
    />
  );
}

export function DeadlineField({ job }: { job: Job }) {
  const { updateApp } = useHub();
  return (
    <input
      type="date"
      className="deadline"
      defaultValue={(job.app?.deadline || job.deadline || '').slice(0, 10)}
      onChange={(e) => updateApp(job.id, { deadline: e.target.value }).catch(() => {})}
    />
  );
}
