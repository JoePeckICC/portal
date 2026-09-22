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

// ---- the emailed link: first-time password setup, or a forgotten password
async function requestLink(email) {
  email = normEmail(email);
  const generic = { ok: true, message: `If that email is on file, a link to set your password is on its way. It is good for ${C.LINK_MINUTES} minutes.` };
  if (!email || email.length > 200) return generic;
  if ((await bump('link:' + email, 60)) > C.RATE.linkPerMin) return generic;         // one a minute, quietly
  if ((await bump('linkh:' + email, 3600)) > C.RATE.linkPerHour) return generic;     // five an hour
  const user = await findUser(email); if (!user) return generic;
  const tok = makeToken(email, 'link', C.LINK_MINUTES); await noteNonce(tokNonce(tok), email, 'link');
  const url = `${C.PORTAL_URL}?t=${encodeURIComponent(tok)}`;
  const f = first(user.name) || 'there';
  const reset = !!user.password_hash;
  await mail.sendMail(email, reset ? `Reset your ${C.APP_NAME} password` : `Set up your ${C.APP_NAME} password`, mail.frame(
    `<p style="font-size:17px">Hi ${esc(f)},</p>` +
    `<p style="font-size:16px;line-height:1.5">${reset ? 'Here is your link to choose a new password.' : 'Here is your link to set up your password for the portal.'} It works for ${C.LINK_MINUTES} minutes, one time.</p>` +
    `<p><a href="${url}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:3px">${reset ? 'Choose a new password' : 'Set my password'}</a></p>` +
    `<p style="font-size:13px;color:#5B6470;line-height:1.5">If you did not ask for this, you can ignore it. Your password stays the same until someone uses this link.</p>`));
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
    const u = t && await findUser(t.email);
    if (u) {
      const tok = makeToken(u.email, 'pwset', C.PWSET_MINUTES); await noteNonce(tokNonce(tok), u.email, 'pwset');
      out.boot.pwset = { token: tok, email: u.email, reset: !!u.password_hash, name: first(u.name) };
      await audit({ email: u.email, role: 'link', clientId: '' }, 'openPasswordLink', {}, '', req);
    } else { out.boot.error = 'That link has expired or was already used. Ask for a new one below.'; await audit({ email: '', role: 'link', clientId: '' }, 'openPasswordLink', {}, 'expired or used link', req); }
  }
  if (out.boot.session === undefined) out.boot.session = null;
  return out;
}

// ---- passwords
const pw = require('./password');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (challengeId, code) => sign('code|' + challengeId + '|' + code);
const WRONG = 'That email and password do not match. Check both, or use "Forgot your password?"';
const LOCKED = `Too many tries. Wait ${C.LOCK_MINUTES} minutes, or use "Forgot your password?" to choose a new one.`;

async function peek(bucket) { const r = await db.one(`select count from rate_limits where bucket=$1 and window_end > now()`, [bucket]); return r ? r.count : 0; }
const clearBucket = bucket => db.q(`delete from rate_limits where bucket=$1`, [bucket]);
const mask = e => { const [a, d] = String(e).split('@'); return (a.length <= 2 ? a[0] + '*' : a[0] + '***' + a.slice(-1)) + '@' + d; };

async function trustedDevice(email, device) {
  if (!device || typeof device !== 'string' || device.length > 128) return false;
  const r = await db.one(`update trusted_devices set last_used_at=now() where token_hash=$1 and email=$2 and expires_at > now() returning token_hash`, [sha(device), email]);
  return !!r;
}
async function trustDevice(email, req) {
  const tok = crypto.randomBytes(32).toString('base64url');
  await db.q(`insert into trusted_devices (token_hash,email,expires_at,user_agent) values ($1,$2,now() + make_interval(days => $3),$4)`,
    [sha(tok), email, C.DEVICE_DAYS, req && String(req.ua || '').slice(0, 200) || null]);
  return tok;
}

async function sendCode(email, name) {
  const challengeId = crypto.randomBytes(24).toString('base64url');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.q(`insert into login_challenges (challenge_id,email,code_hash,expires_at) values ($1,$2,$3,now() + make_interval(mins => $4))`,
    [challengeId, email, codeHash(challengeId, code), C.CODE_MINUTES]);
  await mail.sendMail(email, `${code} is your ${C.APP_NAME} code`, mail.frame(
    `<p style="font-size:17px">Hi ${esc(first(name) || 'there')},</p>` +
    `<p style="font-size:16px;line-height:1.5">Someone just signed in to your portal with your password on a new device. If that was you, enter this code:</p>` +
    `<p style="font-size:34px;font-weight:700;letter-spacing:.2em;margin:18px 0">${code}</p>` +
    `<p style="font-size:14px;color:#5B6470;line-height:1.5">It works for ${C.CODE_MINUTES} minutes. If this was not you, someone knows your password. Use "Forgot your password?" on the sign-in page to change it now.</p>`));
  return challengeId;
}

// Email + password. A remembered device goes straight in; anything else gets a code by email.
async function login(p, req, audit) {
  const email = normEmail(p.email), who = { email, role: 'login', clientId: '' };
  if (!email || email.length > 200 || typeof p.password !== 'string') return { ok: false, error: WRONG };
  if ((await bump('loginip:' + (req && req.ip || ''), 900)) > C.RATE.loginPerIp15) return { ok: false, error: 'Too many sign-in attempts from here. Wait 15 minutes and try again.' };
  if ((await peek('pwfail:' + email)) >= C.LOCK_AFTER) { await audit(who, 'login', {}, 'locked', req); return { ok: false, error: LOCKED }; }
  const u = await findUser(email);
  const good = await pw.verify(p.password, u && u.password_hash);   // runs even for unknown emails, so timing gives nothing away
  if (!u || !good) {
    const n = await bump('pwfail:' + email, C.LOCK_MINUTES * 60);
    await audit(who, 'login', {}, u ? (u.password_hash ? 'wrong password' : 'no password set yet') : 'unknown email', req);
    if (n === C.LOCK_AFTER && u) await require('./core').securityAlert('account paused after wrong passwords', `${u.name || email} (${email}) had ${C.LOCK_AFTER} wrong passwords in a row from ${req && req.ip || 'an unknown address'}, so sign-in is paused for ${C.LOCK_MINUTES} minutes.`, 'If this was not them, their password may be known to someone else. You can ask them to reset it from the sign-in page.');
    return { ok: false, error: n >= C.LOCK_AFTER ? LOCKED : WRONG };
  }
  await clearBucket('pwfail:' + email);
  if (await trustedDevice(u.email, p.device)) {
    await audit({ email: u.email, role: u.role, clientId: '' }, 'login', {}, '', req);
    return { ok: true, session: await sessionFor(u.email, req) };
  }
  if ((await bump('code:' + u.email, 900)) > C.RATE.codesPer15) return { ok: false, error: 'We have sent several codes already. Check your email, or wait 15 minutes.' };
  const challenge = await sendCode(u.email, u.name);
  await audit({ email: u.email, role: u.role, clientId: '' }, 'loginCodeSent', {}, '', req);
  return { ok: true, needCode: true, challenge, sentTo: mask(u.email), minutes: C.CODE_MINUTES };
}

async function verifyCode(p, req, audit) {
  const id = String(p.challenge || '').slice(0, 64), code = String(p.code || '').replace(/\D/g, '');
  const ch = id && await db.one(`update login_challenges set attempts=attempts+1 where challenge_id=$1 and used_at is null returning *`, [id]);
  if (!ch || ch.expires_at < new Date() || ch.attempts > C.CODE_TRIES) return { ok: false, error: 'That code has expired. Sign in again to get a new one.', expired: true };
  if (code.length !== 6 || !safeEqual(codeHash(id, code), ch.code_hash)) {
    await audit({ email: ch.email, role: 'login', clientId: '' }, 'loginCode', {}, 'wrong code', req);
    const left = C.CODE_TRIES - ch.attempts;
    return left > 0 ? { ok: false, error: `That code does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.` } : { ok: false, error: 'Too many wrong codes. Sign in again to get a new one.', expired: true };
  }
  await db.q(`update login_challenges set used_at=now() where challenge_id=$1`, [id]);
  const u = await findUser(ch.email); if (!u) return { ok: false, error: WRONG, expired: true };
  const out = { ok: true, session: await sessionFor(u.email, req) };
  if (p.remember !== false) out.device = await trustDevice(u.email, req);
  await audit({ email: u.email, role: u.role, clientId: '' }, 'login', { what: p.remember !== false ? 'code, device remembered' : 'code' }, '', req);
  return out;
}

// From the emailed link: choose a password, then you are in. The link itself proved the email,
// so this device is remembered. Every other browser is signed out.
async function setPassword(p, req, audit) {
  const t = parseToken(p.token, 'pwset');
  if (!t) return { ok: false, error: 'That link has expired. Ask for a new one.', expired: true };
  const u = await findUser(t.email); if (!u) return { ok: false, error: 'That link has expired. Ask for a new one.', expired: true };
  const bad = await pw.problem(p.password, u.email); if (bad) return { ok: false, error: bad };
  if (!(await spendNonce(t.nonce, t.email, 'pwset'))) return { ok: false, error: 'That link was already used. Ask for a new one.', expired: true };
  await db.q(`update users set password_hash=$2, password_set_at=now() where email=$1`, [u.email, await pw.hash(p.password)]);
  await signOutEverywhere(u.email);
  await clearBucket('pwfail:' + u.email);
  await audit({ email: u.email, role: u.role, clientId: '' }, u.password_hash ? 'resetPassword' : 'setPassword', {}, '', req);
  return { ok: true, session: await sessionFor(u.email, req), device: await trustDevice(u.email, req) };
}

// Signed in: change it knowing the current one. Other browsers are signed out; this one stays.
async function changePassword(user, p) {
  if (!(await pw.verify(p.current, user.password_hash))) { const e = new Error('Your current password is not right.'); e.expected = true; throw e; }
  const bad = await pw.problem(p.next, user.email); if (bad) { const e = new Error(bad); e.expected = true; throw e; }
  await db.q(`update users set password_hash=$2, password_set_at=now() where email=$1`, [user.email, await pw.hash(p.next)]);
  await db.q(`delete from sessions where email=$1 and session_id<>$2`, [user.email, user._session && user._session.id || '']);
  return { done: true };
}

async function forgetDevices(email) { await db.q(`delete from trusted_devices where email=$1`, [normEmail(email)]); }
async function pruneLogin() {
  await db.q(`delete from login_challenges where expires_at < now() - interval '1 day'`);
  await db.q(`delete from trusted_devices where expires_at < now()`);
}

module.exports = { login, verifyCode, setPassword, changePassword, forgetDevices, pruneLogin,  makeToken, parseToken, tokNonce, noteNonce, verifyLinkToken, findUser, sessionFor, userForSession, signOutEverywhere, pruneSessions, bump, requestLink, hello };
