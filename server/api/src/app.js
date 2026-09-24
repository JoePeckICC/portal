'use strict';
// The one API the page talks to: POST /api  { session, action, payload }  ->  { ok, ... } | { ok:false, error }
// Plus: GET /health (not /healthz: Google's front end swallows that path), GET /files/:uploadId (documents, session-checked), POST /stripe/webhook.
const http = require('http');
const C = require('./config');
const db = require('./db');
const auth = require('./auth');
const core = require('./core');
const H = require('./handlers');
const { wire, isTrue, must } = require('./util'); const SEC = { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" };

const MAX_BODY = 12 * 1024 * 1024;        // four 10 MB files arrive base64'd in chunks of one; keep the door reasonable

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function reqInfo(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return { ip: fwd || req.socket.remoteAddress || '', ua: req.headers['user-agent'] || '' };
}
function send(res, status, body, headers) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...(headers || {}) };
  res.writeHead(status, h); res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function cors(req, res) {
  const origin = req.headers.origin || '';
  if (C.ALLOWED_ORIGINS.includes(origin) || (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return !origin;   // no Origin header = not a browser (curl, health checks)
}

// The Apps Script's api(session, action, payload), one to one.
async function api(session, action, payload, req) {
  payload = payload && typeof payload === 'object' ? payload : {};
  action = String(action || '');
  try {
    if (action === 'requestLink') return await auth.requestLink(payload.email);
    if (action === 'hello') return await auth.hello(payload, req, core.audit);
    if (action === 'login') return await auth.login(payload, req, core.audit);
    if (action === 'verifyCode') return await auth.verifyCode(payload, req, core.audit);
    if (action === 'setPassword') return await auth.setPassword(payload, req, core.audit);
    const user = await auth.userForSession(session);
    if (!user) return { ok: false, error: 'signed_out' };
    const ctx = core.ctxFor(user, payload.clientId);
    const h = H[action];
    if (typeof h !== 'function') return { ok: false, error: 'Unknown action' };
    if (ctx.role === 'supporter' && !H.SUPPORTER_OK[action]) return { ok: false, error: 'Not allowed' };
    let out;
    try {
      if (core.fam(ctx) && H.OPEN_BEFORE_PAID.indexOf(action) < 0) {
        const cl = await core.clientById(ctx.clientId);
        must(cl && isTrue(cl.paid), 'Your portal opens once your first payment is received.');
      }
      // An archived family is read-only until it is reactivated.
      if (ctx.role === 'coordinator' && ctx.clientId && !H.READ_ONLY[action] && !H.ARCHIVE_OK[action]) {
        const cl = await core.clientById(ctx.clientId);
        must(!cl || cl.status !== 'Archived', 'This family is archived. Reactivate them to make changes.');
      }
      // Writes run in a transaction under the family's lock; reads run plain.
      out = H.READ_ONLY[action] ? await h(ctx, payload) : await db.tx(c => h(ctx, payload, c), ctx.clientId || ctx.email, { email: ctx.email, role: ctx.role, ip: req && req.ip });
      const after = out && out._after; if (out) delete out._after;
      out = wire(out || {}); out.ok = true;
      await core.audit(ctx, action, payload, '', req);
      if (after) { try { await after(); } catch (e) { console.error('after-hook failed', action, e.message); } }   // emails go after the write is safe
      return out;
    } catch (err) {
      await core.audit(ctx, action, payload, err.message, req);
      if (!err.expected) console.error(action, err);
      return { ok: false, error: err.expected ? err.message : 'Something went wrong on our side. Try again in a moment.' };
    }
  } catch (err) {
    console.error('api', action, err);
    return { ok: false, error: 'Something went wrong on our side. Try again in a moment.' };
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const info = reqInfo(req);
  if (!cors(req, res)) return send(res, 403, { ok: false, error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/health') { try { await db.q('select 1'); return send(res, 200, { ok: true }); } catch (e) { return send(res, 503, { ok: false }); } }

  if ((url.pathname === '/api' || url.pathname === '/') && req.method === 'POST') {
    if ((await auth.bump('api:' + info.ip, 60)) > C.RATE.apiPerMin) return send(res, 429, { ok: false, error: 'Slow down a little and try again.' });
    let b; try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return send(res, e.status || 400, { ok: false, error: e.status === 413 ? 'That is too large to send.' : 'Bad request' }); }
    return send(res, 200, await api(b.session || null, b.action, b.payload, info));
  }

  if (url.pathname.startsWith('/files/') && req.method === 'GET') return serveFile(req, res, url, info);
  if (url.pathname === '/stripe/webhook' && req.method === 'POST') return require('./webhook').handle(req, res, await readBody(req));
  if (url.pathname === '/hooks/booking' && req.method === 'POST') {   // the booking note's Apps Script; see booking.js
    let b; try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { return send(res, 400, { ok: false, error: 'Bad request' }); }
    try { const [status, out] = await require('./booking').handle(req.headers, b); return send(res, status, out); }
    catch (e) { console.error('booking hook', e); return send(res, 500, { ok: false, error: 'Something went wrong on our side.' }); }
  }
  if (url.pathname.startsWith('/jobs/') && req.method === 'POST') {
    const key = process.env.JOBS_KEY || '';
    if (!key || !require('./util').safeEqual(String(req.headers['x-jobs-key'] || ''), key)) return send(res, 403, { ok: false, error: 'Not allowed' });
    try { return send(res, 200, await require('./jobs').run(url.pathname.slice('/jobs/'.length))); } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }
  send(res, 404, { ok: false, error: 'Not found' });
}

// Documents: /files/<uploadId>?k=<signed link from the API> (or ?s=<session>). Person-checked, family-checked, never a public link.
async function serveFile(req, res, url, info) {
  const uploadId = url.pathname.slice('/files/'.length).split('/')[0];
  let user = null;
  const k = url.searchParams.get('k');
  if (k) { const t = auth.parseToken(k, 'file'); if (t && t.extra === uploadId) user = await auth.findUser(t.email); }
  else user = await auth.userForSession(url.searchParams.get('s') || '');
  if (!user) return send(res, 401, { ok: false, error: 'signed_out' });
  const ctx = core.ctxFor(user, url.searchParams.get('c') || '');
  const u = await db.one(`select * from uploads where upload_id=$1`, [uploadId]);
  if (!u || (ctx.role !== 'coordinator' && u.client_id !== ctx.clientId) || ctx.role === 'supporter') return send(res, 404, { ok: false, error: 'Not found' });
  if (ctx.role === 'family' && u.shared === false) return send(res, 404, { ok: false, error: 'Not found' });
  if (!u.storage_key) return send(res, 409, { ok: false, error: 'This file still lives in Drive; it moves over in the file migration.' });
  const bytes = await require('./storage').get(u.storage_key);
  await core.audit(ctx, 'openFile', { uploadId }, '', info); const _m = String(u.mime || '').toLowerCase().split(';')[0].trim(), _in = ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain'].includes(_m), _fn = String(u.name || 'file').replace(/[^A-Za-z0-9._ -]+/g, '_');   // uploads are untrusted: safe preview types render inline, the rest download
  res.writeHead(200, { 'Content-Type': _in ? _m : 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': (_in ? 'inline' : 'attachment') + '; filename="' + _fn + '"', 'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'", 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' });
  res.end(bytes);
}

function createServer() {
  return http.createServer((req, res) => handle(req, res).catch(e => { console.error('unhandled', e); try { send(res, 500, { ok: false, error: 'Something went wrong on our side.' }); } catch {} }));
}

module.exports = { api, createServer, handle };
