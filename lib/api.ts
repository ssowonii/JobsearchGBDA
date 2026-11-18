export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** JSON fetch against the FastAPI backend. A 401 sends you to the login page. */
export async function api<T = any>(url: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  // Crawl steps, dream searches and imports can legitimately take minutes (Vercel allows 300 s).
  const slow = /\/api\/(crawl|dream|import|profile)/.test(url) && (opts.method || 'GET') !== 'GET';
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? (slow ? 310_000 : 30_000)),
    });
  } catch (e) {
    throw new ApiError((e as Error).name === 'TimeoutError' ? 'The server took too long to respond' : (e as Error).message, 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
  return data as T;
}

export const enc = encodeURIComponent;
