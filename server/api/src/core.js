'use strict';
// Shared building blocks the handlers use: who's asking, family lookups, public shapes, notifications, audit.
const C = require('./config');
const db = require('./db');
const mail = require('./mail');
const { normEmail, isTrue, id, esc, must, first, byAsc, byDesc } = require('./util');

// Coordinators act on the family they picked; everyone else is pinned to their own.
function ctxFor(user, pickedClientId) {
  const ctx = { email: normEmail(user.email), user, role: String(user.role || '').trim().toLowerCase() };
  ctx.clientId = String(ctx.role === 'coordinator' ? (pickedClientId || user._session && user._session.picked_client_id || '') : user.client_id).trim();
  return ctx;
}
const fam = ctx => ctx.role === 'client' || ctx.role === 'family';

// ---- audit: who did what to which family, when. Ids and statuses only; never message bodies, notes or answers.
const AUDIT_SKIP = { billing: 1, allBilling: 1, inbasket: 1, resources: 1, topicMessages: 1, readTopic: 1 };
const AUDIT_KEYS = ['topicId', 'taskId', 'apptId', 'medId', 'uploadId', 'resourceId', 'goalId', 'memberId', 'referralId', 'billId', 'programId', 'planId', 'updateId', 'circleId', 'invoiceId', 'email', 'status', 'stage', 'kind', 'shared', 'urgent', 'what', 'amount'];
async function audit(ctx, action, payload, error, req) {
  try {
    if (!error && AUDIT_SKIP[action]) return;
    const d = {}; AUDIT_KEYS.forEach(k => { if (payload && payload[k] !== undefined && payload[k] !== '') d[k] = String(payload[k]).slice(0, 60); });
    if (payload && payload.files && payload.files.length) d.files = payload.files.length;
    if (payload && payload.meds && payload.meds.length) d.meds = payload.meds.length;
    await db.q(`insert into audit (who,role,action,client_id,detail,error,ip) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx && ctx.email || '', ctx && ctx.role || '', action, ctx && ctx.clientId || null, JSON.stringify(d).slice(0, 1000), String(error || '').slice(0, 200), req && req.ip || null]);
  } catch (e) { console.error('audit failed', e.message); }
}

// ---- lookups
const clientById = (clientId, c) => db.one(`select * from clients where client_id=$1`, [String(clientId || '').trim()], c);
const usersFor = (clientId, role, c) => db.all(`select * from users where client_id=$1 and active ${role ? 'and lower(role)=$2' : ''} order by email`, role ? [clientId, role] : [clientId], c);
async function coordinatorFor(client, c) {
  const email = normEmail(client && client.coordinator_email);
  const users = await db.all(`select email,name,co_settings from users where lower(role)='coordinator' and active order by email`, [], c);
  const u = users.find(x => normEmail(x.email) === email) || users[0];
  return u ? { email: u.email, name: u.name, co_settings: u.co_settings } : null;
}

// ---- public shapes (what the page sees)
function publicClient(c) {
  return { allergies: c.allergies || '', autopay: isTrue(c.autopay), monthly_amount: c.monthly_amount == null ? '' : Number(c.monthly_amount), billing_status: c.billing_status || '', stripe_customer_id: c.stripe_customer_id || '',
    pharmacy_name: c.pharmacy_name || '', pharmacy_phone: c.pharmacy_phone || '', pharmacy_address: c.pharmacy_address || '', pharmacy_hours: c.pharmacy_hours || '', phone: c.phone || '', goes_by: c.extra && c.extra.goes_by || '', dob: c.dob || '', address: c.address || '',
    emergency_name: c.emergency_name || '', emergency_relationship: c.emergency_relationship || '', emergency_phone: c.emergency_phone || '', client_id: String(c.client_id).trim(), family_name: c.family_name, patient_first_name: c.patient_first_name, patient_last_name: c.patient_last_name,
    surgery_date: c.surgery_date || '', current_stage: c.current_stage, status: c.status, circle_enabled: isTrue(c.circle_enabled), paid: isTrue(c.paid), plan_ready: isTrue(c.plan_ready) };
}
function prefs(user) {
  const out = {}; Object.keys(C.NOTIFY_KINDS).forEach(k => { out[k] = true; });
  const j = user.prefs && typeof user.prefs === 'object' ? user.prefs : {};
  Object.keys(j).forEach(k => { if (k in out) out[k] = !!j[k]; });
  return out;
}
function coSettings(user) {
  const s = { blocked: [], notify: {}, digestHour: 7, title: 'Care coordinator', tagline: '', sigFileId: '', lastDigest: '' };
  Object.keys(C.CO_KINDS).forEach(k => { s.notify[k] = C.CO_DEFAULTS[k]; });
  const j = user && user.co_settings && typeof user.co_settings === 'object' ? user.co_settings : {};
  ['blocked', 'digestHour', 'title', 'tagline', 'sigFileId', 'lastDigest'].forEach(k => { if (j[k] !== undefined) s[k] = j[k]; });
  if (j.notify) Object.keys(C.CO_KINDS).forEach(k => { if (j.notify[k]) s.notify[k] = j.notify[k]; });
  if (!Array.isArray(s.blocked)) s.blocked = [];
  return s;
}
// Documents open through the API with a signed link (24 h, tied to the person and the file) — never a public URL.
function fileUrl(ctx, u) {
  if (!u.storage_key) return u.url || '';
  const { makeToken } = require('./auth');
  return `${C.API_URL}/files/${u.upload_id}?k=${encodeURIComponent(makeToken(ctx.email, 'file', 24 * 60, u.upload_id))}`;
}
function docPublic(u, ctx) {
  let k = String(u.kind || 'Other'); k = k === 'discharge' ? 'Discharge' : k === 'other' ? 'Other' : k;
  return { upload_id: u.upload_id, kind: C.DOC_KINDS.indexOf(k) >= 0 ? k : 'Other', name: u.name, url: ctx ? fileUrl(ctx, u) : (u.storage_key ? '' : u.url), file_id: u.file_id || '', uploaded_by: u.uploaded_by, uploaded_at: u.uploaded_at, note: u.note || '', shared: u.shared === null || u.shared === undefined ? true : isTrue(u.shared) };
}
const msgPublic = (m, ctx) => ({ ...m, attachments: (Array.isArray(m.attachments) ? m.attachments : []).map(a => (ctx && a.id && !/^https?:\/\/(drive|docs)\.google\.com/.test(a.url || '') ? { ...a, url: fileUrl(ctx, { upload_id: a.id, storage_key: 'x' }) } : a)) });

// ---- topics & messages
async function topicsFor(clientId, c) {
  // Messages written before topics existed get folded into one "Earlier messages" topic.
  const orphans = await db.all(`select message_id from messages where client_id=$1 and (topic_id is null or topic_id='')`, [clientId], c);
  if (orphans.length) {
    const t = await db.insert('topics', { topic_id: id(), client_id: clientId, title: 'Earlier messages', kind: 'other', status: 'Active', created_by: 'system' }, c);
    await db.q(`update messages set topic_id=$2, read_by_coordinator=true where client_id=$1 and (topic_id is null or topic_id='')`, [clientId, t.topic_id], c);
  }
  return db.all(`select * from topics where client_id=$1 order by created_at`, [clientId], c);
}
const topicById = (clientId, topicId, c) => db.one(`select * from topics where client_id=$1 and topic_id=$2`, [clientId, String(topicId || '')], c);

// First load carries the recent conversation, anything unread, and the last line of every topic; older lines come when a topic is opened.
async function recentMessages(ctx, c) {
  const all = await db.all(`select * from messages where client_id=$1 order by sent_at, message_id`, [ctx.clientId], c);
  if (all.length <= C.MSG_KEEP) return { messages: all.map(m => msgPublic(m, ctx)), trimmed: false };
  const col = ctx.role === 'coordinator' ? 'read_by_coordinator' : 'read_by_client', keep = {}, lastOf = {};
  all.forEach(m => { lastOf[String(m.topic_id)] = m.message_id; });
  all.slice(-C.MSG_KEEP).forEach(m => { keep[m.message_id] = 1; });
  all.forEach(m => { if (lastOf[String(m.topic_id)] === m.message_id || (!m[col] && normEmail(m.sender_email) !== ctx.email)) keep[m.message_id] = 1; });
  return { messages: all.filter(m => keep[m.message_id]).map(m => msgPublic(m, ctx)), trimmed: true };
}
// System notes (confirmations, reminders) land in one Automated topic so the family can find them.
async function autoMsg(clientId, body, c) {
  try {
    let t = await db.one(`select * from topics where client_id=$1 and kind='auto' limit 1`, [clientId], c);
    if (!t) t = await db.insert('topics', { topic_id: id(), client_id: clientId, title: C.TOPIC_KINDS.auto, kind: 'auto', status: 'Active', created_by: 'system' }, c);
    else await db.q(`update topics set last_at=now() where topic_id=$1`, [t.topic_id], c);
    await db.insert('messages', { message_id: id(), client_id: clientId, topic_id: t.topic_id, sender_email: 'system', body, read_by_client: false, read_by_coordinator: true }, c);
  } catch (e) { console.error('autoMsg failed', e.message); }
}

// ---- notifications
// Coordinator notifications go by triage: instant, into the daily digest, or nowhere.
async function notifyCo(co, kind, subject, lead, body, cta, url) {
  if (!co || !co.email) return;
  const mode = coSettings(co).notify[kind] || C.CO_DEFAULTS[kind] || 'digest';
  if (mode === 'off') return;
  if (mode === 'instant') return mail.notify(co.email, subject, lead, body, cta, url);
  try { await db.insert('digest', { item_id: id(), coordinator: co.email, kind, subject, lead, body: body || '', url: url || '' }); }
  catch (e) { await mail.notify(co.email, subject, lead, body, cta, url); }
}
// Email the patient and the inner circle, honoring each person's notification settings. `skip` is whoever caused it.
async function notifyFamily(clientId, kind, subject, lead, body, cta, skip) {
  const users = await db.all(`select * from users where client_id=$1 and active and lower(role) in ('client','family')`, [clientId]);
  for (const u of users) {
    if (normEmail(u.email) === normEmail(skip)) continue;
    if (!prefs(u)[kind]) continue;
    await mail.notify(u.email, subject, lead, body, cta);
  }
}

module.exports = { ctxFor, fam, audit, clientById, usersFor, coordinatorFor, publicClient, prefs, coSettings, docPublic, fileUrl, msgPublic, topicsFor, topicById, recentMessages, autoMsg, notifyCo, notifyFamily, must, esc, first, byAsc, byDesc };
