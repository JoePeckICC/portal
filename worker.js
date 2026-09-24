// Serves the page from the assets, and passes the page's API calls (POST /api) through to the portal API on
// Cloud Run, so the sign-in cookies belong to portal.incadencecare.com and stay HttpOnly (added 2026-09-24).
// Security headers are added to every response so the portal the families load is locked down at the edge.
const SECURITY = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self' https://portal-api-94785728612.us-central1.run.app",
    "frame-src https://player.vimeo.com https://www.youtube-nocookie.com https://docs.google.com https://drive.google.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ].join('; '),
};

const API = 'https://portal-api-94785728612.us-central1.run.app';

// POST /api from this site's own page only. Cookies go along; the API sets them back on this domain.
async function proxy(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('{"ok":false,"error":"Origin not allowed"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const h = new Headers({ 'Content-Type': 'text/plain;charset=utf-8', 'X-Portal-Proxy': '1', 'X-Client-IP': ip });
  for (const k of ['Cookie', 'User-Agent']) { const v = request.headers.get(k); if (v) h.set(k, v); }
  const r = await fetch(API + '/api', { method: 'POST', headers: h, body: await request.arrayBuffer() });
  const out = new Response(r.body, { status: r.status, headers: r.headers });
  out.headers.set('Cache-Control', 'no-store');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      if (request.method !== 'POST') return new Response('Not found', { status: 404 });
      return proxy(request, url);
    }
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const k in SECURITY) out.headers.set(k, SECURITY[k]);
    return out;
  },
};
