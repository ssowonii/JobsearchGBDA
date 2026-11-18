'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/login', { method: 'POST', body: { password: pw } });
      const next = new URLSearchParams(window.location.search).get('next') || '/';
      window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <h1 style={{ margin: 0 }}>Internship Hub</h1>
        <p className="muted" style={{ margin: 0 }}>Enter your password to continue.</p>
        <input type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" />
        {err && <p style={{ color: 'var(--bad)', margin: 0 }}>{err}</p>}
        <button className="btn primary" type="submit" disabled={busy || !pw}>Sign in</button>
      </form>
    </div>
  );
}
