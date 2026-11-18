'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, enc } from '@/lib/api';
import type { AppState, Job, Meta, Task } from '@/lib/types';

type Focus = { ids: Set<string>; label: string } | null;
type Detail = { id: string; showSimilar: boolean } | null;
/** Review list for dream-company roles: `ids` limits it to one search's results (null = everything pending). */
export type Review = { ids: Set<string> | null; label: string } | null;

type Hub = {
  jobs: Job[];
  meta: Meta | null;
  loading: boolean;
  load: () => Promise<void>;
  updateApp: (id: string, patch: Partial<AppState>) => Promise<void>;
  removeJob: (id: string) => Promise<void>;
  focus: Focus;
  setFocus: (f: Focus) => void;
  detail: Detail;
  openDetail: (id: string, showSimilar?: boolean) => void;
  closeDetail: () => void;
  profileOpen: boolean;
  setProfileOpen: (v: boolean) => void;
  task: Task | null;
  taskVisible: boolean;
  setTaskVisible: (v: boolean) => void;
  runCrawl: () => Promise<void>;
  runDream: (company: string, includeAll: boolean) => Promise<void>;
  review: Review;
  setReview: (r: Review) => void;
};

const Ctx = createContext<Hub | null>(null);
export const useHub = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHub outside HubProvider');
  return v;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function HubProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [focus, setFocus] = useState<Focus>(null);
  const [detail, setDetail] = useState<Detail>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const [taskVisible, setTaskVisible] = useState(false);
  const [review, setReview] = useState<Review>(null);
  const driving = useRef(false);

  const load = useCallback(async () => {
    const data = await api<{ jobs: Job[]; meta: Meta }>('/api/jobs');
    setJobs(data.jobs);
    setMeta(data.meta);
    setLoading(false);
  }, []);

  const updateApp = useCallback(async (id: string, patch: Partial<AppState>) => {
    const updated = await api<Job>(`/api/jobs/${enc(id)}/app`, { method: 'PATCH', body: patch });
    setJobs((js) => js.map((j) => (j.id === id ? updated : j)));
  }, []);

  const removeJob = useCallback(async (id: string) => {
    await api(`/api/jobs/${enc(id)}`, { method: 'DELETE' });
    setJobs((js) => js.filter((j) => j.id !== id));
  }, []);

  /** Work off a crawl's queue one step at a time while this tab is open. */
  const drive = useCallback(async (t: Task) => {
    if (driving.current) return;
    driving.current = true;
    setTaskVisible(true);
    let failures = 0;
    try {
      while (t.running) {
        try {
          if (t.busy) {
            // another tab or the daily cron is running this step; just watch
            await wait(4000);
            t = await api<Task>('/api/task');
          } else {
            t = await api<Task>('/api/crawl/step', { method: 'POST', body: { id: t.id } });
            failures = 0; // only a completed step counts as progress
          }
        } catch (e) {
          // a dropped connection doesn't stop the step on the server: re-check the run and carry on
          if (++failures > 5) throw e;
          await wait(5000);
          t = { ...(await api<Task>('/api/task')), busy: true };
          if (!t.running) t = { ...t, busy: false };
        }
        setTask(t);
        if (t.done) load().catch(() => {});
      }
    } catch (e) {
      setTask((cur) => (cur ? { ...cur, running: false, error: (e as Error).message } : cur));
    } finally {
      driving.current = false;
      load().catch(() => {});
    }
  }, [load]);

  const runCrawl = useCallback(async () => {
    try {
      const t = await api<Task>('/api/crawl', { method: 'POST' });
      setTask(t);
      await drive(t);
    } catch (e) {
      alert((e as Error).message);
    }
  }, [drive]);

  const runDream = useCallback(async (company: string, includeAll: boolean) => {
    setTaskVisible(true);
    setTask({ running: true, kind: 'dream', label: `Searching ${company}`, log: ['Looking for job boards and careers pages… (this can take a minute)'], startedAt: null, finishedAt: null, result: null, error: null, done: 0, total: 0 });
    try {
      const t = await api<Task>('/api/dream', { method: 'POST', body: { company, includeAll } });
      setTask(t);
      await load();
      if (t.result?.pending?.length) {
        // new roles wait in the review list so you can pick which ones join the hub
        setReview({ ids: new Set(t.result.pending), label: `${t.result.company}` });
      } else if (t.result?.ids?.length) {
        setFocus({ ids: new Set(t.result.ids), label: `${t.result.ids.length} role(s) at ${t.result.company}` });
        router.push('/');
      }
    } catch (e) {
      setTask((cur) => (cur ? { ...cur, running: false, error: (e as Error).message } : cur));
    }
  }, [load, router]);

  useEffect(() => {
    load().catch(() => setLoading(false));
    // resume a crawl that was started earlier (e.g. before a reload)
    api<Task>('/api/task').then((t) => {
      setTask(t);
      if (t.running && t.kind === 'crawl') drive(t);
    }).catch(() => {});
  }, [load, drive]);

  const value = useMemo<Hub>(() => ({
    jobs, meta, loading, load, updateApp, removeJob, focus, setFocus,
    detail, openDetail: (id, showSimilar = false) => setDetail({ id, showSimilar }), closeDetail: () => setDetail(null),
    profileOpen, setProfileOpen, task, taskVisible, setTaskVisible, runCrawl, runDream, review, setReview,
  }), [jobs, meta, loading, load, updateApp, removeJob, focus, detail, profileOpen, task, taskVisible, runCrawl, runDream, review]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
