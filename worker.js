// Static-only: every request is served from the assets. Kept so 'wrangler deploy' has an entry point.
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

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const k in SECURITY) out.headers.set(k, SECURITY[k]);
    return out;
  },
};
