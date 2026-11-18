// Next.js 16 proxy (formerly middleware): send signed-out visitors to /login.
// The FastAPI backend enforces auth on every /api route; this only gates the pages.
// Cookie format (see backend/auth.py): "<expiry>.<hex HMAC-SHA256(SESSION_SECRET, 'v1.<expiry>')>"
import { NextResponse, type NextRequest } from 'next/server';

const COOKIE = 'ih_session';

async function valid(value: string | undefined, secret: string): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !(Number(exp) > Date.now() / 1000)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v1.${exp}`)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function proxy(req: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  // Local dev without APP_PASSWORD/SESSION_SECRET: auth is off (the backend agrees).
  if (!secret || !process.env.APP_PASSWORD) return NextResponse.next();
  if (await valid(req.cookies.get(COOKIE)?.value, secret)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // everything except the API, Next internals, static files and the login page itself
  matcher: ['/((?!api/|_next/|login|favicon|.*\\.[\\w]+$).*)'],
};
