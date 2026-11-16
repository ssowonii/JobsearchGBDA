import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, flushNow, saveDb, companyKey } from './store.js';
import { crawlAll, crawlDreamCompany, importPosting, task } from './crawl.js';
import { search, similar, refreshMatchScores, rankScore, hasOpenAI, hasKey, openaiState, profileText, ensureEmbeddings } from './rag.js';
import { DEFAULT_PROFILE } from './profile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const publicJob = (j) => {
  const { description, textHash, ...rest } = j;
  return { ...rest, rank: rankScore(j), snippet: (description || '').slice(0, 280) };
};

app.get('/api/jobs', (req, res) => {
  res.json({
    jobs: store.jobs().map(publicJob),
    meta: { lastCrawl: store.db.meta.lastCrawl || null, hasOpenAI: hasOpenAI() && Object.keys(store.emb).length > 1, hasKey: hasKey(), openaiError: openaiState.error, companies: store.companies().length },
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = store.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json({ ...j, rank: rankScore(j) });
});

app.patch('/api/jobs/:id/app', (req, res) => {
  const allowed = ['status', 'notes', 'deadline'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const j = store.updateApp(req.params.id, patch);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(publicJob(j));
});

app.delete('/api/jobs/:id', (req, res) => {
  store.deleteJob(req.params.id);
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  try {
    res.json(await search(String(req.query.q || '').slice(0, 500)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/similar/:id', async (req, res) => {
  try {
    res.json(await similar(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/crawl', (req, res) => {
  try {
    crawlAll();
    res.json({ started: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.post('/api/dream', (req, res) => {
  try {
    crawlDreamCompany(req.body?.company, { includeAll: Boolean(req.body?.includeAll) });
    res.json({ started: true });
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

app.get('/api/task', (req, res) => res.json(task));

// Manual add / paste a URL, and the Playwright browser helper posts here too.
app.post('/api/import', async (req, res) => {
  try {
    res.json(publicJob(await importPosting(req.body || {})));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/companies', (req, res) => res.json(store.companies().map((c) => ({ ...c, key: companyKey(c) }))));
app.delete('/api/companies/:key', (req, res) => {
  store.removeCompany(req.params.key);
  res.json({ ok: true });
});

app.get('/api/profile', (req, res) => res.json({ text: profileText(), isDefault: !store.db.meta.profileText }));
app.put('/api/profile', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  store.db.meta.profileText = text && text !== DEFAULT_PROFILE ? text : undefined;
  saveDb();
  try {
    await refreshMatchScores();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, async () => {
  console.log(`\n  Internship Hub running →  http://localhost:${PORT}\n`);
  console.log(hasOpenAI() ? '  RAG: OpenAI embeddings enabled' : '  RAG: no OPENAI_API_KEY, using keyword (BM25) search only');
  try {
    const n = await ensureEmbeddings(store.jobs());
    if (n) console.log(`  embedded ${n} job(s)`);
  } catch (e) {
    console.log(`  ⚠ ${e.message}\n  → falling back to keyword search until this is fixed (then restart or click Refresh all).`);
  }
  await refreshMatchScores().catch(() => {});
  if (!store.jobs().length) console.log('  No jobs yet. Click "Refresh all" in the app (or run `npm run crawl`).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushNow(); process.exit(0); });
