'use strict';
// Intake, plan, tasks, goals, appointments, care team, referrals.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const intake = require('../intake');
const { CONSENT_ITEMS_ } = require('../intakeSpec');
const { id, must, clean, pick, famName, first, normEmail } = require('../util');
// The family may check off the tasks that are theirs; everything else is the coordinator's to move.
const familyTask = (t, co) => { const o = String(t.owner || '').trim(); if (!o) return false; return !(co && (normEmail(o) === normEmail(co.email) || first(o).toLowerCase() === first(co.name).toLowerCase())); };
const { localToIso, localStamp, apptPublic } = require('../time');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const clientOrCo = ctx => must(ctx.role === 'client' || ctx.role === 'coordinator', 'Not allowed');
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
const dateOnly = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);

// ---- intake
async function saveIntake(ctx, p, c) {
  clientOrCo(ctx); needFamily(ctx);
  const answers = p.answers || {}, ok = {};
  Object.keys(answers).forEach(qid => { if (/^[A-Z0-9][A-Za-z0-9.]{0,12}$/.test(qid)) ok[qid] = intake.tidyAnswer(qid, answers[qid]); });
  const cur = await intake.readIntake(ctx.clientId, c);
  // After submitting, keep a running list of what changed (first value -> latest value), so the
  // coordinator gets one email listing it all when they press "Save my changes" (submitIntake).
  if (cur.status === 'Submitted' || cur.status === 'Updated after submitting') {
    const ch = Object.assign({}, cur.changed);
    Object.keys(ok).forEach(qid => {
      const was = cur.answers[qid] || { a: '', n: '' }, now = ok[qid] || {};
      const a0 = String(was.a || ''), a1 = clean(now.a, 4000), n0 = String(was.n || ''), n1 = clean(now.n, 4000);
      if (a0 === a1 && n0 === n1) return;
      ch[qid] = { from: ch[qid] ? ch[qid].from : a0, to: a1, note: n0 !== n1 };
    });
    if (JSON.stringify(ch) !== JSON.stringify(cur.changed)) { ok._changed = { a: JSON.stringify(ch) }; ok._status = { a: 'Updated after submitting' }; }
  } else if (cur.status === 'Not started') ok._status = { a: 'In progress' };
  await intake.writeIntake(ctx.clientId, ok, ctx.email, c);
  return { intake: await intake.readIntake(ctx.clientId, c) };
}
// Consent comes first. Nothing else in the portal opens until the intake is submitted.
async function signConsent(ctx, p, c) {
  clientOrCo(ctx); needFamily(ctx);
  const cs = p.consent || {};
  const initials = (cs.initials || []).map(x => clean(x, 6).trim());
  must(initials.length === CONSENT_ITEMS_.length && initials.every(Boolean), 'Please initial every item');
  const name = clean(cs.name, 120).trim();
  must(name, 'Type your full name to sign');
  must(clean(cs.relationship, 120).trim(), 'Tell us who you are to the patient (or "Self")');
  // Initials are part of the signature: letters only, and they must be the initials of the name signed with
  // (first + last, or every word). Added 2026-09-25 after "ZZZZ" and "1234" went through.
  const bad = intake.initialsProblem(initials, name); must(!bad, bad);
  const cur = await intake.readIntake(ctx.clientId, c);
  // The wording is kept with the signature, so their copy shows exactly what they signed even if it changes later.
  const consent = { initials, name: clean(cs.name, 120), relationship: clean(cs.relationship, 120), signed_at: new Date(), by: ctx.email, items: CONSENT_ITEMS_ };
  const patch = { _consent: { a: JSON.stringify(consent) } };
  if (cur.status === 'Not started') patch._status = { a: 'In progress' };
  await intake.writeIntake(ctx.clientId, patch, ctx.email, c);
  return { intake: await intake.readIntake(ctx.clientId, c) };
}
// "Save my changes" after submitting: back to Submitted, any new draft plan items, and one email
// to the coordinator listing what the family changed (not when the coordinator made the change).
async function resubmitIntake(ctx, client, cur, c) {
  await intake.writeIntake(ctx.clientId, { _status: { a: 'Submitted' }, _changed: { a: '{}' } }, ctx.email, c);
  const made = await intake.seedPlan(ctx.clientId, cur.answers, client, ctx.email, c);
  const byId = {};
  intake.intakeSpec().steps.forEach(st => st.qs.forEach(q => { byId[q.id] = q.q.replace(/\{[A-Z_]+\}/g, 'they'); }));
  const lines = Object.keys(cur.changed || {}).map(qid => {
    const x = cur.changed[qid], base = qid.replace(/d$/, ''), label = byId[qid] || (byId[base] ? byId[base] + ' (details)' : qid);
    return x.from === x.to ? label + ': note changed' : label + ': "' + (x.from || '—') + '" → "' + (x.to || '—') + '"' + (x.note ? ' (note changed too)' : '');
  });
  let after = null;
  if (lines.length && ctx.role !== 'coordinator') {
    const co = await core.coordinatorFor(client, c), who = (ctx.user && ctx.user.name) || 'The family';
    after = () => core.notifyCo(co, 'intake', famName(client.family_name) + ' changed their intake answers', who + ' changed:', lines.join('\n') + (made ? '\n\n' + made + ' new draft plan item(s) are waiting for your review.' : ''), 'Open the prep sheet');
  }
  return { intake: await intake.readIntake(ctx.clientId, c), drafts: made, _after: after };
}
async function submitIntake(ctx, p, c) {
  clientOrCo(ctx); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const cur = await intake.readIntake(ctx.clientId, c);
  must(cur.consent, 'Please sign the consent first');
  const missing = intake.missingRequired(cur.answers);
  must(!missing.length, 'A few required answers are still blank: ' + missing.join(', '));
  if (cur.status === 'Submitted') return { intake: cur, drafts: 0 };
  if (cur.status === 'Updated after submitting') return resubmitIntake(ctx, client, cur, c);
  await intake.writeIntake(ctx.clientId, { _status: { a: 'Submitted' }, _submitted_at: { a: new Date().toISOString() } }, ctx.email, c);
  const made = await intake.seedPlan(ctx.clientId, cur.answers, client, ctx.email, c);
  const co = await core.coordinatorFor(client, c);
  const after = () => core.notifyCo(co, 'intake', famName(client.family_name) + ' finished their intake', (cur.answers['F.1'] ? 'First thing off their plate: ' + cur.answers['F.1'].a : 'Their intake is in.') + (made ? ' ' + made + ' draft plan items are waiting for your review.' : ''), '', 'Open the prep sheet');
  return { intake: await intake.readIntake(ctx.clientId, c), drafts: made, _after: after };
}

// ---- plan
async function setPlanReady(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  await db.q(`update clients set plan_ready=$2, plan_ready_at=case when $2 then coalesce(plan_ready_at, now()) else plan_ready_at end where client_id=$1`, [cl.client_id, !!p.ready], c);
  if (p.ready) await core.autoMsg(ctx.clientId, 'Your Cadence Plan is ready. Open the Plan tile to read it.', c);
  const after = async () => {
    if (!p.ready) return;
    for (const u of await db.all(`select email from users where client_id=$1 and active and lower(role) in ('client','family')`, [ctx.clientId]))
      await mail.notify(u.email, 'Your Cadence Plan is ready', (first(cl.patient_first_name) || 'Your') + "'s road, written down. Sign in to read it. " + (ctx.user.name || 'Your coordinator') + ' will walk you through it.', '', 'Read the plan');
  };
  return { _after: after };
}
async function setPaid(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  await db.q(`update clients set paid=$2, paid_at=case when $2 then coalesce(paid_at, now()) else paid_at end where client_id=$1`, [cl.client_id, !!p.paid], c);
  if (p.paid) await core.autoMsg(ctx.clientId, 'Your first payment is in and your portal is open.', c);
  const after = async () => {
    if (!p.paid) return;
    for (const u of await db.all(`select email from users where client_id=$1 and active and lower(role) in ('client','family')`, [ctx.clientId]))
      await mail.notify(u.email, 'Your portal is open', 'Thank you. Your first payment is in, and your ' + C.APP_NAME + ' portal is open: the plan, messages with ' + (ctx.user.name || 'your coordinator') + ', and updates for the people you choose.', '', 'Open the portal');
  };
  return { _after: after };
}
async function approvePlanItem(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from plan_items where client_id=$1 and plan_id=$2`, [ctx.clientId, String(p.planId || '')], c); must(row, 'Not found');
  if (p.discard) await db.q(`update plan_items set draft=true, extra = extra || '{"draft":"Discarded"}' where plan_id=$1`, [row.plan_id], c);
  else await db.q(`update plan_items set draft=false, extra = extra - 'draft' where plan_id=$1`, [row.plan_id], c);
  return {};
}
async function addPlanItem(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);
  const item = clean(p.item, 300); must(item.trim(), 'Write the item');
  const row = await db.insert('plan_items', { plan_id: id(), client_id: ctx.clientId, stage: pick(p.stage, C.STAGES, C.STAGES[0]), category: pick(p.category, C.CATEGORIES, C.CATEGORIES[0]), item, detail: clean(p.detail, 2000), owner: clean(p.owner, 80), status: pick(p.status, C.PLAN_STATUSES, 'Not started'), target_date: dateOnly(p.target_date), draft: false, extra: JSON.stringify(p.note ? { note: clean(p.note, 2000) } : {}) }, c);
  const after = () => core.notifyFamily(ctx.clientId, 'plan', 'Added to your plan', (ctx.user.name || 'Your coordinator') + ' added to the plan:', item, 'See the plan', ctx.email);
  return { item: row, _after: after };
}
// Edit an item's wording or placement, draft or live (added 2026-09-25 for the plan builder).
async function editPlanItem(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from plan_items where client_id=$1 and plan_id=$2`, [ctx.clientId, String(p.planId || '')], c); must(row, 'Not found');
  const item = clean(p.item === undefined ? row.item : p.item, 300); must(item.trim(), 'Write the item');
  await db.q(`update plan_items set item=$2, detail=$3, stage=$4, category=$5, owner=$6, target_date=$7, updated_at=now() where plan_id=$1`,
    [row.plan_id, item, clean(p.detail === undefined ? row.detail : p.detail, 2000), pick(p.stage, C.STAGES, row.stage), pick(p.category, C.CATEGORIES, row.category), clean(p.owner === undefined ? row.owner : p.owner, 80), /^\d{4}-\d{2}-\d{2}$/.test(String(p.target_date || '')) ? p.target_date : (p.target_date === '' ? null : row.target_date)], c);
  // Your notes: the vendor, the in-depth version, what you will actually do. The family never sees these.
  if (p.note !== undefined) await db.q(`update plan_items set extra = (extra - 'note') || $2::jsonb where plan_id=$1`, [row.plan_id, JSON.stringify(clean(p.note, 2000).trim() ? { note: clean(p.note, 2000) } : {})], c);
  return {};
}
async function setPlanStatus(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from plan_items where client_id=$1 and plan_id=$2`, [ctx.clientId, String(p.planId || '')], c); must(row, 'Not found');
  await db.q(`update plan_items set status=$2 where plan_id=$1`, [row.plan_id, pick(p.status, C.PLAN_STATUSES, 'Not started')], c);
  const after = p.status === 'Done' ? () => core.notifyFamily(ctx.clientId, 'plan', 'Done: ' + row.item, (ctx.user.name || 'Your coordinator') + ' marked this done on your plan:', row.item, 'See the plan', ctx.email) : null;
  return { _after: after };
}

// ---- tasks
async function addTask(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);
  const title = clean(p.title, 300); must(title.trim(), 'Write the task');
  const row = await db.insert('tasks', { task_id: id(), client_id: ctx.clientId, title, category: pick(p.category, C.CATEGORIES, C.CATEGORIES[0]), status: 'Not started', owner: clean(p.owner, 80), due_date: dateOnly(p.due_date), notes: clean(p.notes, 2000) }, c);
  return { task: row };
}
// Edit a task's wording, date, owner or notes (added 2026-09-25 for the Implement page).
async function editTask(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from tasks where client_id=$1 and task_id=$2`, [ctx.clientId, String(p.taskId || '')], c); must(row, 'Not found');
  const title = clean(p.title === undefined ? row.title : p.title, 300); must(title.trim(), 'Write the task');
  await db.q(`update tasks set title=$2, due_date=$3, owner=$4, notes=$5, category=$6 where task_id=$1`,
    [row.task_id, title, p.due_date === undefined ? row.due_date : dateOnly(p.due_date), clean(p.owner === undefined ? row.owner : p.owner, 80), clean(p.notes === undefined ? row.notes : p.notes, 2000), pick(p.category, C.CATEGORIES, row.category)], c);
  return {};
}
async function setTaskStatus(ctx, p, c) {
  const row = await db.one(`select * from tasks where client_id=$1 and task_id=$2`, [ctx.clientId, String(p.taskId || '')], c); must(row, 'Not found');
  if (ctx.role !== 'coordinator') must(familyTask(row, await core.coordinatorFor(await core.clientById(ctx.clientId, c), c)) && ['Done', 'Not started'].indexOf(p.status) >= 0, 'Not allowed');
  await db.q(`update tasks set status=$2 where task_id=$1`, [row.task_id, pick(p.status, C.TASK_STATUSES, 'Not started')], c);
  return {};
}

// ---- appointments (booking against the coordinator's calendar lives in calendar.js)
async function addAppointment(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);
  const title = clean(p.title, 200), when = clean(p.starts_at, 40);
  must(title.trim(), 'Write what the appointment is');
  must(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(when), 'Pick a date and time');
  const row = await db.insert('appointments', { appt_id: id(), client_id: ctx.clientId, title, starts_at: localToIso(when), location: clean(p.location, 200), note: clean(p.note, 500), status: 'Scheduled' }, c);
  await core.autoMsg(ctx.clientId, 'Appointment added: ' + title + ' — ' + when.replace('T', ' at ') + (row.location ? ', ' + row.location : '') + '.', c);
  return { appointment: apptPublic(row) };
}
async function cancelAppointment(ctx, p, c) {
  const a = await db.one(`select * from appointments where client_id=$1 and appt_id=$2`, [ctx.clientId, String(p.apptId || '')], c); must(a, 'Not found');
  must(ctx.role === 'coordinator' || String(a.event_id || ''), 'Only appointments you booked can be cancelled here');
  if (a.event_id) { try { await require('../calendar').deleteEvent(a.event_id); } catch (e) { console.error('calendar delete', e.message); } }
  await db.q(`update appointments set status='Cancelled' where appt_id=$1`, [a.appt_id], c);
  await core.autoMsg(ctx.clientId, 'Cancelled: ' + a.title + ' on ' + localStamp(a.starts_at).replace('T', ' at ') + '.', c);
  return {};
}
// ---- care team + referrals (Find Care)
async function addCareTeam(ctx, p, c) {
  famOrCo(ctx); needFamily(ctx);
  const name = clean(p.name, 120).trim(); must(name, 'Add their name');
  const row = await db.insert('care_team', { member_id: id(), client_id: ctx.clientId, name, role: clean(p.role, 120), org: clean(p.org, 160), phone: clean(p.phone, 40), address: clean(p.address, 240), notes: clean(p.notes, 500), kind: p.kind === 'vendor' ? 'vendor' : 'provider', added_by: ctx.email, status: 'Active' }, c);
  return { member: row };
}
async function removeCareTeam(ctx, p, c) {
  famOrCo(ctx);
  const r = await db.update('care_team', { client_id: ctx.clientId, member_id: String(p.memberId || '') }, { status: 'Removed' }, c); must(r.length, 'Not found');
  return {};
}
async function addReferral(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);
  const vendor = clean(p.vendor, 160).trim(); must(vendor, 'Name the vendor');
  const row = await db.insert('referrals', { referral_id: id(), client_id: ctx.clientId, vendor, service: clean(p.service, 160), contact: clean(p.contact, 160), note: clean(p.note, 500), status: 'Suggested', added_by: ctx.email }, c);
  await core.autoMsg(ctx.clientId, 'New referral: ' + vendor + (row.service ? ' — ' + row.service : '') + '. See Find Care.', c);
  return { referral: row };
}
async function setReferralStatus(ctx, p, c) {
  famOrCo(ctx);
  const row = await db.one(`select * from referrals where client_id=$1 and referral_id=$2`, [ctx.clientId, String(p.referralId || '')], c); must(row, 'Not found');
  await db.q(`update referrals set status=$2 where referral_id=$1`, [row.referral_id, pick(p.status, C.REFERRAL_STATUSES, row.status)], c);
  return {};
}

// ---- goals
async function addGoal(ctx, p, c) {
  needFamily(ctx);
  const title = clean(p.title, 200); must(title.trim(), 'Write the goal');
  const row = await db.insert('goals', { goal_id: id(), client_id: ctx.clientId, title, detail: clean(p.detail, 500), status: 'Active', added_by: ctx.email }, c);
  return { goal: row };
}
async function setGoalStatus(ctx, p, c) {
  const r = await db.update('goals', { client_id: ctx.clientId, goal_id: String(p.goalId || '') }, { status: pick(p.status, ['Active', 'Done', 'Removed'], 'Active') }, c); must(r.length, 'Not found');
  return {};
}

// Only handlers are exported from this file: everything here becomes a callable action.
module.exports = { saveIntake, signConsent, submitIntake, setPlanReady, setPaid, approvePlanItem, addPlanItem, setPlanStatus, addTask, setTaskStatus, addAppointment, cancelAppointment,
  addCareTeam, removeCareTeam, addReferral, setReferralStatus, addGoal, setGoalStatus, editPlanItem, editTask };
