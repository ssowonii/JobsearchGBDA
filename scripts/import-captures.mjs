// Posts a JSON array of captured postings to the hub's /api/import endpoint.
// Usage: node scripts/import-captures.mjs data/captures-2026-11-17.json
// Uses HUB_URL (default http://localhost:3000) and HUB_TOKEN from .env.local, like scripts/browser.js.
import { readFileSync, existsSync } from 'node:fs';

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-captures.mjs <file.json>'); process.exit(1); }
const HUB = (process.env.HUB_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json', ...(process.env.HUB_TOKEN ? { Authorization: `Bearer ${process.env.HUB_TOKEN}` } : {}) };

let ok = 0;
for (const job of JSON.parse(readFileSync(file, 'utf8'))) {
  try {
    const r = await fetch(`${HUB}/api/import`, { method: 'POST', headers, body: JSON.stringify(job) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    ok++;
    console.log(`✓ ${job.title} — ${job.company}`);
  } catch (e) {
    console.error(`✗ ${job.title} — ${job.company}: ${e.message}`);
  }
}
console.log(`\nImported ${ok} postings into ${HUB}`);
