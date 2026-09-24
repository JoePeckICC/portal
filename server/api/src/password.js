'use strict';
// Password hashing (scrypt, salted, never reversible) and the rules a new password has to meet.
const crypto = require('crypto');

const N = 1 << 15, R = 8, P = 1, KEYLEN = 32;
const scrypt = (pw, salt, n, r, p) => new Promise((ok, bad) =>
  crypto.scrypt(pw, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => e ? bad(e) : ok(k)));

async function hash(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(String(pw).normalize('NFKC'), salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), k.toString('base64url')].join('$');
}

// A fixed dummy so an unknown email takes as long to reject as a wrong password.
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
async function verify(pw, stored) {
  const f = String(stored || DUMMY).split('$');
  if (f.length !== 6 || f[0] !== 'scrypt') return false;
  const want = Buffer.from(f[5], 'base64url');
  const got = await scrypt(String(pw || '').normalize('NFKC'), Buffer.from(f[4], 'base64url'), Number(f[1]), Number(f[2]), Number(f[3]));
  return !!stored && want.length === got.length && crypto.timingSafeEqual(want, got);
}

// Has this password shown up in a known data breach? Uses the k-anonymity range API:
// only the first 5 characters of its SHA-1 leave our server, never the password.
// If the check can't be reached we let the password through rather than block sign-up.
async function breached(pw) {
  if (process.env.NODE_ENV === 'test' || process.env.SKIP_BREACH_CHECK) return false;
  const h = crypto.createHash('sha1').update(String(pw)).digest('hex').toUpperCase();
  try {
    const r = await fetch('https://api.pwnedpasswords.com/range/' + h.slice(0, 5), { headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const rest = h.slice(5);
    return (await r.text()).split('\n').some(line => { const [suf, n] = line.trim().split(':'); return suf === rest && Number(n) > 0; });
  } catch { return false; }
}

// Words that make a password easy to guess, whatever else is added to them.
const COMMON = /passw[o0]rd|incadence|cadence|qwerty|asdf|123456|abc123|letmein|welcome|iloveyou|admin/i;

// Returns '' when the password is fine, otherwise a plain sentence saying what to change.
// The rules (added 2026-09-24): 12+ characters with a lowercase letter, a capital, a number and a
// symbol; no email address, no common words, and not in a known breach. index.html pwChecks() shows
// the first five as a checklist; keep the two in step.
async function problem(pw, email) {
  pw = String(pw || '');
  if (pw.length < 12) return 'Use at least 12 characters. A short sentence you will remember works well.';
  if (pw.length > 200) return 'That is longer than we can take. Keep it under 200 characters.';
  if (/^(.)\1+$/.test(pw)) return 'Pick something less predictable than one repeated character.';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'Leave your email address out of your password.';
  const need = [];
  if (!/[a-z]/.test(pw)) need.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) need.push('a capital letter');
  if (!/[0-9]/.test(pw)) need.push('a number');
  if (!/[^A-Za-z0-9\s]/.test(pw)) need.push('a symbol, like ! or #');
  if (need.length) return 'Your password still needs ' + (need.length > 1 ? need.slice(0, -1).join(', ') + ' and ' + need[need.length - 1] : need[0]) + '.';
  if (COMMON.test(pw)) return 'That has a word in it that is easy to guess, like "password" or "123456". Pick something else.';
  if (await breached(pw)) return 'That password has shown up in a data breach somewhere else, so it is not safe to use. Pick a different one.';
  return '';
}

module.exports = { hash, verify, problem };
