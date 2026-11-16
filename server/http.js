// Minimal HTTP client built on node:https.
// We avoid global fetch() because some job boards (notably Workday) rate-limit
// undici's request fingerprint, while plain https requests go through fine.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function request(url, { method = "GET", headers = {}, body, timeout = 45000, maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`Invalid URL: ${url}`));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'Accept-Language': 'en-CA,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          ...(payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          const sameMethod = status === 307 || status === 308;
          return resolve(
            request(next, {
              method: sameMethod ? method : 'GET',
              headers,
              body: sameMethod ? body : undefined,
              timeout,
              maxRedirects: maxRedirects - 1,
            })
          );
        }
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status, ok: status >= 200 && status < 300, url: u.toString(), headers: res.headers, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${timeout}ms: ${url}`)));
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

export async function getJSON(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`Non-JSON response from ${url}`);
  }
}

export async function getHTML(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'text/html,application/xhtml+xml', ...(opts.headers || {}) } });
  return res;
}

/** Run async fn over items with limited concurrency. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { error: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
