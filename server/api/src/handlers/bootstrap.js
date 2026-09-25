'use strict';
const C = require('../config');
const db = require('../db');
const core = require('../core');
const intake = require('../intake');
const { isTrue, must, ymd } = require('../util');

// Everything the page needs to draw itself.
async function bootstrap(ctx) {
  const out = { me: { email: ctx.email, name: ctx.user.name, role: ctx.role, goes_by: ctx.user.goes_by || '', avatar: ctx.user.avatar || '', prefs: core.prefs(ctx.user) }, fixedAnswers: C.FIXED_ANSWERS, notifyKinds: C.NOTIFY_KINDS, avatars: C.AVATARS };
  if (ctx.role === 'coordinator') {
    out.families = (await db.all(`select client_id, family_name, patient_first_name, patient_last_name, current_stage, status from clients where status <> 'Archived' order by family_name`)).map(c =>
      ({ client_id: c.client_id, family_name: c.family_name, patient: [c.patient_first_name, c.patient_last_name].join(' ').trim(), current_stage: c.current_stage, status: c.status }));
    if (!ctx.clientId && out.families.length) ctx.clientId = String(out.families[0].client_id);
    if (ctx.clientId && ctx.user._session) db.q(`update sessions set picked_client_id=$2 where session_id=$1`, [ctx.user._session.id, ctx.clientId]).catch(() => {});
  }
  if (!ctx.clientId) return out;
  let client = await core.clientById(ctx.clientId);
  must(client, 'No family on file for this account yet.');
  out.client = core.publicClient(client);
  if (ctx.role === 'supporter') {
    out.updates = await db.all(`select * from updates where client_id=$1 and visible_to_circle order by posted_at desc`, [ctx.clientId]);
    return out;
  }
  const billing = require('../billing');
  if (core.fam(ctx) && !isTrue(client.paid) && client.stripe_customer_id) { await billing.syncPaid(client); client = await core.clientById(ctx.clientId); out.client = core.publicClient(client); }
  if (core.fam(ctx) && !isTrue(client.paid)) {
    out.billing = await billing.billingFor(client);
    out.intake = await intake.readIntake(ctx.clientId);
    out.intakeSpec = intake.intakeSpec();
    out.coordinator = pubCo(await core.coordinatorFor(client));
    return out;
  }
  const cid = ctx.clientId;
  const [inner, patient, plan, tasks, topics, updates, circle, appointments, goals, careTeam, meds, vendorBills, assistance, doses, uploads, referrals] = await Promise.all([
    db.all(`select email,name,relationship from users where client_id=$1 and active and lower(role)='family' order by email`, [cid]),
    db.one(`select email from users where client_id=$1 and active and lower(role)='client' order by email limit 1`, [cid]),
    db.all(`select * from plan_items where client_id=$1 ${ctx.role === 'coordinator' ? '' : 'and draft = false'} order by updated_at`, [cid]),
    db.all(`select * from tasks where client_id=$1 order by updated_at`, [cid]),
    core.topicsFor(cid),
    db.all(`select * from updates where client_id=$1 order by posted_at desc`, [cid]),
    db.all(`select * from circle where client_id=$1 and status <> 'Removed' order by added_at`, [cid]),
    db.all(`select * from appointments where client_id=$1 and status <> 'Cancelled' order by starts_at`, [cid]),
    db.all(`select * from goals where client_id=$1 and status <> 'Removed' order by updated_at`, [cid]),
    db.all(`select * from care_team where client_id=$1 and status <> 'Removed' order by updated_at`, [cid]),
    db.all(`select * from medications where client_id=$1 order by added_at`, [cid]),
    db.all(`select * from vendor_bills where client_id=$1 order by updated_at`, [cid]),
    db.all(`select * from assistance where client_id=$1 order by updated_at`, [cid]),
    db.all(`select * from doses where client_id=$1 and due_at >= $2::date order by due_at`, [cid, ymd(new Date(Date.now() - 2 * 86400000), C.TZ)]),
    db.all(`select * from uploads where client_id=$1 order by uploaded_at desc`, [cid]),
    db.all(`select * from referrals where client_id=$1 order by updated_at`, [cid]),
  ]);
  // Plan items the coordinator discarded never show anywhere.
  out.plan = plan.filter(p => !(p.extra && p.extra.draft === 'Discarded'));
  // The coordinator's notes on an item (the vendor, the in-depth version) are theirs alone.
  if (ctx.role !== 'coordinator') out.plan = out.plan.map(p => { const e = { ...(p.extra || {}) }; delete e.note; delete e.coordinated; return { ...p, extra: e }; });
  out.inner = inner; out.patientUser = patient ? patient.email : '';
  out.intake = await intake.readIntake(cid); out.intakeSpec = intake.intakeSpec();
  if (ctx.role === 'coordinator') out.intakeFlags = intake.intakeFlags(out.intake.answers);
  out.tasks = tasks; out.topics = topics;
  const rm = await core.recentMessages(ctx); out.messages = rm.messages; if (rm.trimmed) out.msgTrimmed = true;
  out.updates = updates; out.circle = circle;
  const co = await core.coordinatorFor(client); out.coordinator = pubCo(co);
  const { apptPublic, localStamp } = require('../time');
  out.appointments = appointments.map(apptPublic); out.goals = goals; out.careTeam = careTeam; out.meds = meds; out.vendorBills = vendorBills; out.assistance = assistance;
  out.allergies = client.allergies || '';
  if (ctx.role === 'coordinator') out.coSettings = await require('./coordinator').coSettingsPublic(ctx.user);
  else if (co) out.blockedDates = core.coSettings(co).blocked;
  out.doses = doses.map(d => ({ ...d, due_at: localStamp(d.due_at), taken_at: d.taken_at || '' }));
  out.uploads = uploads.map(u => core.docPublic(u, ctx));
  if (ctx.role === 'family') { out.uploads = out.uploads.filter(u => u.shared); out.appointments.forEach(a => { if (!(a.extra && isTrue(a.extra.note_shared))) { a.visit_note = ''; a.note_hidden = true; } }); }
  out.referrals = referrals;
  if (core.fam(ctx) || ctx.role === 'coordinator') { try { out.recommended = await latestRec(cid); } catch { out.recommended = null; } }   // the coordinator's Implement page checks it too
  return out;
}
const pubCo = co => (co ? { email: co.email, name: co.name } : null);

// The newest hand-picked piece for a family, so the homepage can point at it.
async function latestRec(clientId) {
  const r = await db.one(`select rec.rec_id, rec.resource_id, rec.note, rec.by, rec.at, rec.opened_at, r.title, r.kind, r.minutes, r.track
    from recommendations rec join resources r on r.resource_id=rec.resource_id where rec.client_id=$1 and r.status='Published' order by rec.at desc limit 1`, [clientId]);
  return r ? { ...r, opened_at: r.opened_at || '' } : null;
}

// The rest of a conversation, fetched when someone opens a topic that the first load trimmed.
async function topicMessages(ctx, p) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  return { messages: (await db.all(`select * from messages where client_id=$1 and topic_id=$2 order by sent_at, message_id`, [ctx.clientId, String(p.topicId || '')])).map(m => core.msgPublic(m, ctx)) };
}

module.exports = { bootstrap, topicMessages };
