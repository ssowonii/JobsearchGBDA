// Runs the project's Python (.venv) cross-platform, loading .env.local like Next.js does.
//   node scripts/py.mjs setup        create .venv and install requirements-dev.txt
//   node scripts/py.mjs api          FastAPI dev server on :8000 (used by `npm run dev`)
//   node scripts/py.mjs <args...>    any python command, e.g. -m pytest
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const venvPy = path.join(ROOT, '.venv', win ? 'Scripts/python.exe' : 'bin/python');
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'setup') {
  const sys = win ? 'python' : 'python3';
  if (!fs.existsSync(venvPy)) run(sys, ['-m', 'venv', '.venv']);
  run(venvPy, ['-m', 'pip', 'install', '-r', 'requirements-dev.txt']);
  process.exit(0);
}

if (!fs.existsSync(venvPy)) {
  console.error('Python environment missing. Run:  npm run setup:py');
  process.exit(1);
}

const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' };
for (const f of ['.env', '.env.local']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const args = cmd === 'api'
  ? ['-m', 'uvicorn', 'backend.main:app', '--port', '8000', '--reload', '--reload-dir', 'backend', ...(win ? ['--loop', 'backend.devloop:selector_loop'] : [])]
  : [cmd, ...rest].filter((x) => x !== undefined);

const child = spawn(venvPy, args, { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));

function run(bin, a) {
  const r = spawnSync(bin, a, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
