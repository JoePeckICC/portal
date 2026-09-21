'use strict';
// Sign-in links (HMAC tokens, single use) and server-side sessions.
const crypto = require('crypto');
const C = require('./config');
const db = require('./db');
const mail = require('./mail');
const { normEmail, esc, safeEqual, first } = require('./util');

function secret() { if (!C.SESSION_SECRET) throw new Error('SESSION_SECRET is not set'); return C.SESSION_SECRET; }
const sign = s => crypto.createHmac('sha256', secret()).update(s).digest('base64url');

// token = base64url(email|kind|expiresMs|nonce|extra) + '.' + HMAC — same layout as the Apps Script, so links already in inboxes keep working after cutover if the secret is carried over.
function makeToken(email, kind, minutes, extra) {
  const body = [normEmail(email), kind, String(Date.now() + minutes * 60000), crypto.randomUUID(), String(extra || '')].join('|');
  const b = Buffer.from(body, 'utf8').toString('base64url');
  return b + '.' + sign(b);
}
function parseToken(token, kind) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [b, sig] = token.split('.');
  if (!sig || !safeEqual(sign(b), sig)) return null;
  let body; try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const f = body.split('|');
  if (f.length < 4 || f[1] !== kind) return null;
  if (Number(f[2]) < Date.now()) return null;
  return { email: f[0], kind: f[1], exp: Number(f[2]), nonce: f[3], extra: f[4] || '' };
}
const tokNonce = tok => { try { return Buffer.from(tok.split('.')[0], 'base64url').toString('utf8').split('|')[3] || ''; } catch { return ''; } };

// A link works once. The nonce row is written when the link is issued and marked used the first time it opens (atomically).
async function noteNonce(nonce, email, kind) { await db.q(`insert into sign_in_tokens (nonce,email,kind) values ($1,$2,$3) on conflict do nothing`, [nonce, email, kind]); }
async function spendNonce(nonce, email, kind) {
  const r = await db.one(`update sign_in_tokens set used_at=now() where nonce=$1 and used_at is null returning nonce`, [nonce]);
  if (r) return true;
  const exists = await db.one(`select 1 from sign_in_tokens where nonce=$1`, [nonce]);
  if (exists) return false;                                             // already used
  await db.q(`insert into sign_in_tokens (nonce,email,kind,used_at) values ($1,$2,$3,now()) on conflict do nothing`, [nonce, email, kind]);   // issued before this table existed
  return true;
}
async function verifyLinkToken(token, kind) {
  const t = parseToken(token, kind); if (!t) return null;
  if (!(await spendNonce(t.nonce, t.email, kind))) return null;
  return t;
}

// ---- users
async function findUser(email) {
  const u = await db.one(`select * from users where email=$1 and active`, [normEmail(email)]);
  if (!u) return null;
  u.role = String(u.role || '').trim().toLowerCase(); u.client_id = String(u.client_id || '').trim();
  return u;
}

// ---- sessions (opaque id; the page stores it and sends it with every call)
async function sessionFor(email, req) {
  const u = await findUser(email); if (!u) return null;
  const exp = new Date(Date.now() + C.SESSION_DAYS * 86400000);
  const s = await db.insert('sessions', { email: u.email, session_ver: u.session_ver, expires_at: exp, ip: req && req.ip || null, user_agent: req && String(req.ua || '').slice(0, 200) || null });
  return s.session_id;
}
// Returns the user for a live session, bumping last_seen; null when signed out, expired, idle too long, or "signed out everywhere".
async function userForSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) return null;
  const s = await db.one(`select s.*, u.session_ver as user_ver, u.active from sessions s join users u on u.email=s.email where s.session_id=$1`, [sessionId]);
  if (!s || !s.active) return null;
  if (s.expires_at < new Date() || s.session_ver !== s.user_ver) { await db.q(`delete from sessions where session_id=$1`, [sessionId]); return null; }
  if (C.IDLE_MINUTES && Date.now() - new Date(s.last_seen_at).getTime() > C.IDLE_MINUTES * 60000) { await db.q(`delete from sessions where session_id=$1`, [sessionId]); return null; }
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60000) db.q(`update sessions set last_seen_at=now() where session_id=$1`, [sessionId]).catch(() => {});
  const u = await findUser(s.email); if (!u) return null;
  u._session = { id: s.session_id, picked_client_id: s.picked_client_id };
  return u;
}
async function signOutEverywhere(email) {
  await db.q(`update users set session_ver=session_ver+1 where email=$1`, [normEmail(email)]);
  await db.q(`delete from sessions where email=$1`, [normEmail(email)]);
}
async function pruneSessions() { await db.q(`delete from sessions where expires_at < now()`); await db.q(`delete from sign_in_tokens where issued_at < now() - interval '2 days'`); }

// ---- rate limits (database-backed so every instance shares them)
async function bump(bucket, windowSec) {
  const r = await db.one(`insert into rate_limits (bucket,count,window_end) values ($1,1,now() + make_interval(secs => $2))
    on conflict (bucket) do update set count = case when rate_limits.window_end < now() then 1 else rate_limits.count + 1 end,
      window_end = case when rate_limits.window_end < now() then now() + make_interval(secs => $2) else rate_limits.window_end end
    returning count`, [bucket, windowSec]);
  return r.count;
}

// ---- the sign-in link
async function requestLink(email) {
  email = normEmail(email);
  const generic = { ok: true, message: `If that email is on file, a sign-in link is on its way. It is good for ${C.LINK_MINUTES} minutes.` };
  if (!email || email.length > 200) return generic;
  if ((await bump('link:' + email, 60)) > C.RATE.linkPerMin) return generic;         // one a minute, quietly
  if ((await bump('linkh:' + email, 3600)) > C.RATE.linkPerHour) return generic;     // five an hour
  const user = await findUser(email); if (!user) return generic;
  const tok = makeToken(email, 'link', C.LINK_MINUTES); await noteNonce(tokNonce(tok), email, 'link');
  const url = `${C.PORTAL_URL}?t=${encodeURIComponent(tok)}`;
  const f = first(user.name) || 'there';
  await mail.sendMail(email, `Your ${C.APP_NAME} sign-in link`, mail.frame(
    `<p style="font-size:17px">Hi ${esc(f)},</p>` +
    `<p style="font-size:16px;line-height:1.5">Here is your link to the portal. It works for ${C.LINK_MINUTES} minutes and only from this email.</p>` +
    `<p><a href="${url}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:3px">Open the portal</a></p>` +
    `<p style="font-size:13px;color:#5B6470;line-height:1.5">If you did not ask for this, you can ignore it. Nobody can get in without this email.</p>`));
  return generic;
}

// First call from the page: constants, plus a session when the address carried a sign-in (?t) or email-change (?e) link.
async function hello(p, req, audit) {
  const out = { ok: true, boot: C.bootConst() };
  if (p.e) {
    const t = await verifyLinkToken(p.e, 'em');
    if (t && t.extra.indexOf('>') > 0) {
      const [oldE, newE] = t.extra.split('>');
      await db.q(`update users set email=$2 where email=$1`, [normEmail(oldE), normEmail(newE)]);
      out.boot.session = await sessionFor(newE, req);
    } else out.boot.error = 'That email-change link has expired. Ask for a new one from Settings.';
  }
  if (p.t) {
    const t = await verifyLinkToken(p.t, 'link');
    if (t) { out.boot.session = await sessionFor(t.email, req); await audit({ email: t.email, role: 'link', clientId: '' }, 'signIn', {}, '', req); }
    else { out.boot.error = 'That sign-in link has expired or was already used. Ask for a new one below.'; await audit({ email: '', role: 'link', clientId: '' }, 'signIn', {}, 'expired or used link', req); }
  }
  if (out.boot.session === undefined) out.boot.session = null;
  return out;
}

module.exports = { makeToken, parseToken, tokNonce, noteNonce, verifyLinkToken, findUser, sessionFor, userForSession, signOutEverywhere, pruneSessions, bump, requestLink, hello };
