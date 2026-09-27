// Serves the page from the assets and adds security headers to every response, so the portal the families
// load is locked down at the edge. That is all Cloudflare does: the page talks to the API at its own address
// (api.incadencecare.com, straight to Google), so nothing a family types passes through here. The API
// pass-through that lived at POST /api from 2026-09-24 to 2026-09-25 is gone for that reason.
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
    "connect-src 'self' https://api.incadencecare.com",
    "frame-src https://api.incadencecare.com https://player.vimeo.com https://www.youtube-nocookie.com https://docs.google.com https://drive.google.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ].join('; '),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') return new Response('{"ok":false,"error":"The portal API lives at api.incadencecare.com"}', { status: 410, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const k in SECURITY) out.headers.set(k, SECURITY[k]);
    return out;
  },
};
