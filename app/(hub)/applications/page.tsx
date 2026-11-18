'use client';

import { DeadlineField, NotesField, StatusSelect } from '@/components/bits';
import { useHub } from '@/components/HubProvider';
import { STATUSES, isTracked } from '@/lib/filters';

export default function ApplicationsPage() {
  const { jobs, openDetail } = useHub();
  const tracked = jobs.filter(isTracked).sort((a, b) => String(b.app?.updatedAt || '').localeCompare(String(a.app?.updatedAt || '')));
  const stages = ['saved', 'applied', 'interview', 'offer', 'rejected'];

  return (
    <main className="tracker">
      <div className="pipeline">
        {stages.map((s) => (
          <div className="stat" key={s}>
            <b className={`status-${s}`}>{tracked.filter((j) => j.app?.status === s).length}</b>
            <span>{STATUSES.find((x) => x[0] === s)![1].replace('★ ', '')}</span>
          </div>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Role</th><th>Company</th><th>Status</th><th>Applied</th><th>Deadline</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {tracked.map((j) => (
              <tr key={j.id}>
                <td>
                  <a href={j.applyUrl || j.url} target="_blank" rel="noopener">{j.title}</a>
                  <div className="muted" style={{ fontSize: 12 }}>{j.location?.display || ''}{j.active === false ? ' · closed' : ''}</div>
                </td>
                <td>{j.company}</td>
                <td><StatusSelect job={j} /></td>
                <td>{j.app?.appliedAt || ''}</td>
                <td><DeadlineField job={j} /></td>
                <td><NotesField job={j} placeholder="Contacts, interview dates…" /></td>
                <td><button className="link" onClick={() => openDetail(j.id)}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!tracked.length && <p className="muted empty">Nothing tracked yet. Set a status (Saved, Applied…) on any job card.</p>}
    </main>
  );
}
