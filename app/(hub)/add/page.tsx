'use client';

import { useState } from 'react';
import { useHub } from '@/components/HubProvider';
import { api } from '@/lib/api';
import type { Job } from '@/lib/types';

export default function AddPage() {
  const { load } = useHub();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = Object.fromEntries(new FormData(form));
    setMsg('Adding…');
    setBusy(true);
    try {
      const j = await api<Job>('/api/import', { method: 'POST', body: fd });
      setMsg(`Added "${j.title}" (${j.company || 'unknown company'}).`);
      form.reset();
      await load();
    } catch (err) {
      setMsg(`⚠ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="addview">
      <div className="panel">
        <h2>Add a posting</h2>
        <p className="muted">For WaterlooWorks, LinkedIn, Indeed, or anything the crawler can&apos;t reach. Paste a URL (public pages get parsed automatically) or paste the description text. It will be embedded and ranked like everything else.</p>
        <form className="addform" onSubmit={submit}>
          <label>Posting URL<input name="url" placeholder="https://…" /></label>
          <div className="row">
            <label>Title<input name="title" placeholder="Marketing Co-op" /></label>
            <label>Company<input name="company" /></label>
          </div>
          <div className="row">
            <label>Location<input name="location" placeholder="Toronto, ON" /></label>
            <label>Job type
              <select name="workMode" defaultValue="">
                <option value="">Not specified</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">In-person</option>
              </select>
            </label>
            <label>Deadline<input name="deadline" type="date" /></label>
          </div>
          <label>Description (paste full text if the URL needs a login)<textarea name="description" rows={8} /></label>
          <div className="row end">
            <label className="inline">Status
              <select name="status" defaultValue="saved"><option value="saved">Saved</option><option value="applied">Applied</option><option value="none">Just track it</option></select>
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Add posting</button>
          </div>
          <p className="muted">{msg}</p>
        </form>
      </div>
      <div className="panel">
        <h2>LinkedIn & Indeed (browser helper)</h2>
        <p>Run in a terminal: <code>npm run browser</code>. A Chrome window opens. Sign in yourself, then browse as you normally would. Every job posting you open is captured here automatically. Set <code>HUB_URL</code> and <code>HUB_TOKEN</code> in <code>.env.local</code> to send captures to your deployed hub.</p>
        <p className="muted">The optional <code>npm run browser -- search</code> mode runs your saved searches automatically, slowly. LinkedIn&apos;s terms forbid automated access, and accounts can be restricted, so capture mode is the safer choice.</p>
      </div>
    </main>
  );
}
