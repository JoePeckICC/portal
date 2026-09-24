'use strict';
// Booking hook (added 2026-09-24). When someone books an Introductory Call, the Apps Script that
// sends Joe's personal note calls this first, so the note can carry a "Set up my profile" link.
//
//   POST /hooks/booking   X-Hook-Key: <BOOKING_HOOK_KEY>   { email, name, phone }
//   -> { ok, created, url }
//
// A new address gets a family and a client sign-in, the same records "New family" makes, owned by
// Joe (or BOOKING_COORDINATOR). url is a one-time link to choose a password, good for 7 days.
// An address that already signs in gets no new records; url is a fresh link if they never chose
// a password, otherwise the plain portal address.
//
// Nothing here opens the portal. Until the first payment, app.js lets a family reach only the
// consent, the intake form and Billing (H.OPEN_BEFORE_PAID). Submitting the intake starts billing
// (money.autoStartBilling), which puts the Pay now button in front of them.
const C = require('./config');
const db = require('./db');
const auth = require('./auth');
const core = require('./core');
const { clean, normEmail, EMAIL_RE, safeEqual } = require('./util');

const LINK_MINUTES = 60 * 24 * 7;

async function link(email) {
  const tok = auth.makeToken(email, 'link', LINK_MINUTES);
  await auth.noteNonce(auth.tokNonce(tok), email, 'link');
  return `${C.PORTAL_URL}?t=${encodeURIComponent(tok)}`;
}

async function handle(headers, body) {
  const key = process.env.BOOKING_HOOK_KEY || '';
  if (!key || !safeEqual(String(headers['x-hook-key'] || ''), key)) return [403, { ok: false, error: 'Not allowed' }];

  const email = normEmail(body && body.email);
  if (!EMAIL_RE.test(email) || email.length > 200) return [400, { ok: false, error: 'A working email is needed' }];
  const name = clean(body.name, 80).trim();
  const phone = clean(body.phone, 40).trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || email.split('@')[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';

  const existing = await auth.findUser(email);
  if (existing) {
    const url = existing.password_hash ? C.PORTAL_URL : await link(email);
    return [200, { ok: true, created: false, url }];
  }

  // Owned by BOOKING_COORDINATOR when set, else Joe, else the first active coordinator.
  const want = normEmail(process.env.BOOKING_COORDINATOR || 'joe@incadencecare.com');
  const co = await db.one(`select email,name,co_settings from users where lower(role)='coordinator' and active order by (lower(email)=$1) desc, email limit 1`, [want]);
  if (!co) return [500, { ok: false, error: 'No coordinator on file' }];

  let cid = null;
  await db.tx(async c => {
    if (await db.one(`select 1 from users where email=$1`, [email], c)) return;   // closed account, or lost a race
    cid = String(Date.now()).slice(-7);
    while (await db.one(`select 1 from clients where client_id=$1`, [cid], c)) cid = String(Number(cid) + 1);
    await db.insert('clients', { client_id: cid, family_name: lastName || firstName, patient_first_name: firstName, patient_last_name: lastName, surgery_date: null, current_stage: C.STAGES[0], status: 'Active', coordinator_email: co.email, circle_enabled: false, paid: false, plan_ready: false, phone }, c);
    await db.insert('users', { email, name: name || firstName, role: 'client', client_id: cid, active: true }, c);
  }, 'booking:' + email, { email: 'booking-hook', role: 'system' });

  if (!cid) return [200, { ok: true, created: false, url: C.PORTAL_URL }];   // a closed or racing account: no link
  const url = await link(email);
  {
    const ctx = { email: 'booking-hook', role: 'system', clientId: cid };
    await core.audit(ctx, 'bookingSignup', { kind: 'Introductory Call' }, '');
    await core.notifyCo(co, 'booking', 'New booking — ' + (name || email), 'A portal login was made for them from their Introductory Call booking. They can fill out the intake before your call.', '', 'Open the portal').catch(() => {});
  }
  return [200, { ok: true, created: true, url }];
}

module.exports = { handle };
