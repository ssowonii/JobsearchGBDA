'use client';

import { MODE_LABEL, daysLeft, fmtDate } from '@/lib/filters';
import type { Job } from '@/lib/types';
import { CatTags, EligTag, StatusSelect } from './bits';
import { useHub } from './HubProvider';

export function JobCard({ job: j, hit }: { job: Job; hit?: number }) {
  const { openDetail } = useHub();
  const L = j.location || {};
  const deadline = j.app?.deadline || j.deadline;
  const dl = daysLeft(deadline);
  const terms = (j.term?.terms || []).filter((t) => /202[6-8]/.test(t));
  const score = hit ?? j.match;
  return (
    <article className={`card ${j.active === false ? 'inactive' : ''}`}>
      <div>
        <h3 className="open" onClick={() => openDetail(j.id)}>{j.title}</h3>
        <div className="co">{j.company}{j.active === false && <> · <em>posting closed</em></>}</div>
      </div>
      <div className="score" title={hit != null ? 'Search relevance' : 'How well this job matches your resume (embedding similarity)'}>
        <b>{score ?? '–'}<small style={{ fontSize: 12 }}>%</small></b>
        <span>{hit != null ? 'relevance' : 'resume match'}</span>
        <div className="bar"><i style={{ width: `${Math.min(100, score ?? 0)}%` }} /></div>
      </div>
      <div className="meta">
        <span>📍 {L.display}</span>
        <span>{MODE_LABEL[j.workMode || 'unknown'] || MODE_LABEL.unknown}</span>
        {j.salary ? (
          <span className="salary" title={`${j.salary.raw || ''}  (~$${j.salary.hourlyMin}–${j.salary.hourlyMax}/hr CAD)`}>💰 {j.salary.text}</span>
        ) : (
          <span className="muted">💰 Pay not listed</span>
        )}
        {(terms.length > 0 || !!j.term?.durationMonths) && (
          <span>🗓 {terms.join(', ')}{j.term?.durationMonths ? ` · ${j.term.durationMonths}-month` : ''}</span>
        )}
        {deadline && (
          <span className={dl != null && dl <= 7 ? 'status-interview' : ''}>⏳ Apply by {fmtDate(deadline)}{dl != null && dl >= 0 ? ` (${dl}d)` : ''}</span>
        )}
        {j.postedAt && <span className="muted">Posted {fmtDate(j.postedAt)}</span>}
      </div>
      <div className="tags">
        <CatTags job={j} />
        <EligTag job={j} />
        {L.isOntario && <span className="tag">Ontario</span>}
        {j.dream && <span className="tag dream">✦ Dream</span>}
        <span className="tag" title="Source">{j.source}</span>
      </div>
      {j.snippet && <p className="snippet">{j.snippet}</p>}
      <div className="actions">
        <a className="btn small primary" href={j.applyUrl || j.url} target="_blank" rel="noopener">Apply ↗</a>
        <button className="btn small" onClick={() => openDetail(j.id)}>Details</button>
        <button className="btn small" onClick={() => openDetail(j.id, true)}>Similar jobs</button>
        <span className="spacer" />
        <StatusSelect job={j} />
      </div>
    </article>
  );
}
