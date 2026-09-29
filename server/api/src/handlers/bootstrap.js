'use strict';
const C = require('../config');
const db = require('../db');
const core = require('../core');
const intake = require('../intake');
const { isTrue, must, ymd } = require('../util');

// Everything the page needs to draw itself.
async function bootstrap(ctx) {
  const out = { me: { email: ctx.email, name: ctx.user.name, role: ctx.role, goes_by: ctx.user.goes_by || '', avatar: ctx.user.avatar || '', prefs: core.prefs(ctx.user), zip: (ctx.user.extra && ctx.user.extra.zip) || '', mobile: (ctx.user.extra && ctx.user.extra.phone) || '' }, fixedAnswers: C.FIXED_ANSWERS, notifyKinds: C.NOTIFY_KINDS, avatars: C.AVATARS };
  if (ctx.role === 'coordinator') {
    out.families = (await db.all(`select client_id, family_name, patient_first_name, patient_last_name, current_stage, status from clients where status <> 'Archived' order by family_name`)).map(c =>
      ({ client_id: c.client_id, family_name: c.family_name, patient: [c.patient_first_name, c.patient_last_name].join(' ').trim(), current_stage: c.current_stage, status: c.status }));
    if (!ctx.clientId && out.families.length) ctx.clientId = String(out.families[0].client_id);
    if (ctx.clientId && ctx.user._session) db.q(`update sessions set picked_client_id=$2 where session_id=$1`, [ctx.user._session.id, ctx.clientId]).catch(() => {});
  }
  if (ctx.role === 'vendor') return require('./jobs').vendorBoot(ctx, out);
  if (!ctx.clientId) return out;
  let client = await core.clientById(ctx.clientId);
  must(client, 'No family on file for this account yet.');
  out.client = core.publicClient(client);
  const CIRCLE = require('./circle');
  const withPhoto = (rows, role) => rows.map(u => { const e = u.extra || {}; const o = { ...u, extra: undefined }; if (e.photo) { o.photo = CIRCLE.photoVisible(u, role) ? core.fileUrl(ctx, { upload_id: e.photo, storage_key: 'x' }) : ''; o.photo_ok = isTrue(e.photo_ok); o.sensitive = isTrue(e.sensitive); o.photo_id = e.photo; } if (isTrue(e.pending_share)) o.pending_share = true; return o; });
  const ce = client.extra || {};
  if (ctx.role === 'supporter') {
    out.updates = withPhoto(await db.all(`select * from updates where client_id=$1 and visible_to_circle order by posted_at desc`, [ctx.clientId]), 'supporter');
    out.tracker = ce.tracker || null; out.trackerSteps = CIRCLE.TRACKER; out.reactions = CIRCLE.REACTIONS; out.what_i_need = ce.what_i_need || '';
    out.comments = await CIRCLE.commentsFor(ctx.clientId, true); out.reactionCounts = await CIRCLE.reactionsFor(ctx.clientId);
    out.myReactions = await db.all(`select r.update_id, r.kind from update_reactions r join updates u on u.update_id=r.update_id where u.client_id=$1 and r.who=$2`, [ctx.clientId, ctx.email]);
    out.help = await db.all(`select item_id, title, detail, when_text, status, claimed_by, claimed_email from help_items where client_id=$1 and status<>'Removed' order by added_at`, [ctx.clientId]);
    out.fund_url = ce.fund_url || ''; out.fund_note = ce.fund_note || ''; out.theme = ce.theme || 'ink'; out.story = ce.story && ce.story.shared ? { title: ce.story.title, body: ce.story.body } : null;
    return out;
  }
  const billing = require('../billing');
  if (core.fam(ctx) && !isTrue(client.paid) && client.stripe_customer_id) { await billing.syncPaid(client); client = await core.clientById(ctx.clientId); out.client = core.publicClient(client); }
  if (core.fam(ctx) && !isTrue(client.paid)) {
    out.billing = await billing.billingFor(client);
    out.intake = await intake.readIntake(ctx.clientId);
    out.intakeSpec = await intake.specFor();
    out.coordinator = pubCo(await core.coordinatorFor(client));
    return out;
  }
  const cid = ctx.clientId;
  const [inner, patient, plan, tasks, topics, updates, circle, appointments, goals, careTeam, meds, vendorBills, assistance, doses, uploads, referrals] = await Promise.all([
    db.all(`select email,name,relationship,(coalesce(password_hash,'')='') as pending from users where client_id=$1 and active and lower(role)='family' order by email`, [cid]),
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
  { const MK = require('./market'); const vmap = await MK.vendorsFor(out.plan); out.plan.forEach(p => { if (p.extra && p.extra.vendor_id && vmap[p.extra.vendor_id]) p.vendor = vmap[p.extra.vendor_id]; });
    if (ctx.role === 'coordinator') { out.vendors = await MK.vendors(); out.vendorServices = MK.SERVICES; { const vu = {}; (await db.all(`select extra->>'vendor_id' as vid from users where lower(role)='vendor' and active`)).forEach(r => { vu[r.vid] = 1; }); out.vendors.forEach(v => { v.invited = !!vu[v.vendor_id]; }); } } }
  out.inner = inner; out.patientUser = patient ? patient.email : '';
  out.intake = await intake.readIntake(cid); out.intakeSpec = await intake.specFor();
  if (ctx.role === 'coordinator') out.intakeFlags = intake.intakeFlags(out.intake.answers);
  out.tasks = tasks; out.topics = topics;
  { const vids = [...new Set(out.topics.filter(t => t.kind === 'vendor').map(t => t.extra && t.extra.vendor_id).filter(Boolean))];   // the vendor's number, for the call button in their conversation
    if (vids.length) { const ph = {}; const hr = {}; const sv = {}; const pr = {}; (await db.all(`select vendor_id, phone, hours, service, services, bio, checked, insured from vendors where vendor_id = any($1)`, [vids])).forEach(v => { ph[v.vendor_id] = v.phone; hr[v.vendor_id] = require('./jobs').normHours(v.hours); sv[v.vendor_id] = require('./jobs').svcsOf(v); pr[v.vendor_id] = { vendor_bio: v.bio || '', vendor_vetted: !!v.checked, vendor_insured: !!v.insured }; }); out.topics = out.topics.map(t => t.kind === 'vendor' ? { ...t, extra: { ...t.extra, vendor_phone: ph[t.extra && t.extra.vendor_id] || '', vendor_hours: hr[t.extra && t.extra.vendor_id] || null, vendor_services: sv[t.extra && t.extra.vendor_id] || [t.extra && t.extra.service], ...(pr[t.extra && t.extra.vendor_id] || {}) } } : t); } }
  out.borrowed = await require('./loans').borrowedBy(cid); if (ctx.role === 'coordinator') Object.assign(out, await require('./loans').closetFor());
  out.circleAsk = core.fam(ctx) ? (await require('./jobs').circleNear(cid, ctx.email, null, true)).map(x => ({ email: x.email, name: x.name, text: !!x.phone })) : []; out.circleNear = out.circleAsk.length;
  out.jobs = await require('./jobs').jobsFor(cid); out.careNotes = ce.care_notes || {}; out.pets = Array.isArray(ce.pets) ? ce.pets : require('./jobs').petsFromIntake((out.intake || await intake.readIntake(cid)).answers); out.jobServices = require('./market').SERVICES;
  out.updates = withPhoto(updates, ctx.role);
  out.tracker = ce.tracker || null; out.trackerSteps = CIRCLE.TRACKER; out.reactions = CIRCLE.REACTIONS; out.what_i_need = ce.what_i_need || '';
  out.share_token = CIRCLE.canAct(ctx) || ctx.role === 'family' ? (ce.share_token || '') : '';
  out.comments = await CIRCLE.commentsFor(ctx.clientId, false); out.reactionCounts = await CIRCLE.reactionsFor(ctx.clientId);
  out.myReactions = await db.all(`select r.update_id, r.kind from update_reactions r join updates u on u.update_id=r.update_id where u.client_id=$1 and r.who=$2`, [ctx.clientId, ctx.email]);
  out.help = await db.all(`select item_id, title, detail, when_text, status, claimed_by, claimed_email from help_items where client_id=$1 and status<>'Removed' order by added_at`, [ctx.clientId]);
  // What the heart on the Circle shows: reactions, words left, and things taken, newest first (not your own).
  out.circleNotes = await db.all(`select * from (
      select 'react' t, r.at, coalesce(nullif(uu.name,''), nullif(ci.supporter_name,''), case when r.who like 'link:%' then 'Someone with the link' else r.who end) who, r.kind x, up.title ut, up.update_id uid
        from update_reactions r join updates up on up.update_id=r.update_id
        left join users uu on lower(uu.email)=lower(r.who) left join circle ci on ci.client_id=up.client_id and lower(ci.supporter_email)=lower(r.who)
       where up.client_id=$1 and lower(r.who)<>lower($2)
      union all
      select 'comment', cm.at, cm.author, cm.body, up.title, up.update_id from update_comments cm join updates up on up.update_id=cm.update_id where cm.client_id=$1 and lower(cm.email)<>lower($2) and cm.status<>'Hidden'
      union all
      select 'help', h.claimed_at, h.claimed_by, h.title, '', '' from help_items h where h.client_id=$1 and h.claimed_at is not null and h.status in ('Claimed','Done') and lower(h.claimed_email)<>lower($2)
    ) n order by at desc nulls last limit 60`, [ctx.clientId, ctx.email]).catch(() => []);
  out.delegate = (await db.one(`select email from users where client_id=$1 and lower(role)='family' and active and (extra->>'delegate')='true' limit 1`, [ctx.clientId]) || {}).email || '';
  out.restrictions = ce.restrictions || {}; out.restrictionKeys = require('./recovery').RESTRICTIONS; out.red_flags = ce.red_flags || ''; out.red_flags_who = ce.red_flags_who || ''; out.reason = ce.reason || ''; out.disaster = ce.disaster || null;
  if (ctx.role === 'client' || ctx.role === 'coordinator' || ctx.role === 'family') out.icant = ce.icant ? { text: ctx.role === 'client' || ctx.role === 'coordinator' ? ce.icant.text : '', at: ce.icant.at } : null;
  out.checkins = await db.all(`select checkin_id, at, by, role, mood, pain, words, caregiver from checkins where client_id=$1 and at > now() - interval '60 days' order by at desc`, [cid]);
  out.symptoms = await db.all(`select symptom_id, at, by, name, severity, note from symptoms where client_id=$1 order by at desc limit 200`, [cid]);
  out.doseDays = await db.all(`select to_char(due_at at time zone $2, 'YYYY-MM-DD') as day, count(*)::int as due, count(taken_at)::int taken from doses where client_id=$1 and due_at > now() - interval '45 days' and due_at < now() group by 1 order by 1`, [cid, C.TZ]);
  const G = require('./guides'); Object.assign(out, await G.guidesFor(client)); if (ctx.role === 'coordinator') { out.walks = await G.walks(); out.explainerList = await G.explainers(); out.walk_id = ce.walk_id || ''; out.explainer_key = ce.explainer_key || ''; const H = require('./hospitals'); out.hospitalStats = await H.hospitalStats(); if (out.walk) out.hospital = await H.factsFor(out.walk.name, true); }
  const ST = require('./story'); out.story = ce.story || null; out.theme = ce.theme || 'ink'; out.peer = ce.peer || null; out.discharge = ce.discharge || null; out.dischargeQs = ST.DISCHARGE; out.themes = ST.THEMES;
  const FAM = require('./family'); out.journal = await FAM.journalFor(ctx); out.journalPrompts = FAM.PROMPTS; out.coverage = await FAM.coverageFor(cid); out.coverageParts = FAM.PARTS; out.fund_url = ce.fund_url || ''; out.fund_note = ce.fund_note || '';
  if (ctx.role === 'coordinator') out.time = await FAM.timeFor(cid);
  out.escalations = await require('./safety').escalationsFor(cid); out.escKinds = require('./safety').KINDS;
  out.checklists = require('../checklists').CHECKLISTS;
  out.ticks = await db.all(`select list_id, item_id, done_at, done_by from checklist_ticks where client_id=$1`, [cid]);
  const rm = await core.recentMessages(ctx); out.messages = rm.messages; if (rm.trimmed) out.msgTrimmed = true;
  // Threads a family started among themselves are theirs; the coordinator's view leaves them out entirely.
  if (ctx.role === 'coordinator') { const fo = {}; out.topics = out.topics.filter(t => { if (t.kind === 'family') { fo[t.topic_id] = 1; return false; } return true; }); out.messages = out.messages.filter(m => !fo[m.topic_id]); }
  else out.topics = out.topics.filter(t => t.kind !== 'family' || ((t.extra && t.extra.to) || []).includes(ctx.email));
   out.circle = circle;
  const co = await core.coordinatorFor(client); out.coordinator = pubCo(co);
  const { apptPublic, localStamp } = require('../time');
  out.appointments = appointments.map(apptPublic); out.goals = goals; out.careTeam = careTeam; out.meds = meds.map(require('./meds').medPublic); out.vendorBills = vendorBills; out.assistance = assistance;
  { const pl = [out.walk && out.walk.name].concat((out.appointments || []).map(a => a.location)).filter(Boolean); Object.assign(out, await require('./tips').tipsFor(ctx, pl)); }
  out.allergies = client.allergies || '';
  // Allergies the intake mentions, so an empty chart field never reads as "none" when the family told us something.
  try { const ia = await intake.readIntake(cid); out.allergyMentions = intake.allergyMentions(ia.answers || {}).map(x => x.text); } catch { out.allergyMentions = []; }
  if (ctx.role === 'coordinator') out.coSettings = await require('./coordinator').coSettingsPublic(ctx.user);
  else if (co) out.blockedDates = core.coSettings(co).blocked;
  out.doses = doses.map(d => ({ ...d, due_at: localStamp(d.due_at), taken_at: d.taken_at || '' }));
  out.uploads = uploads.map(u => core.docPublic(u, ctx));
  out.transcripts = await require('./recordings').forClient(ctx, cid);
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
  if (ctx.role === 'vendor') { const vt = await db.one(`select * from topics where topic_id=$1 and kind='vendor'`, [String(p.topicId || '')]); must(vt && vt.extra && vt.extra.vendor_email === ctx.email, 'Not found'); ctx.clientId = String(vt.client_id).trim(); return { messages: (await db.all(`select * from messages where topic_id=$1 order by sent_at, message_id`, [vt.topic_id])).map(m => ({ ...core.msgPublic(m, null), attachments: [] })) }; }
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const t = await core.topicById(ctx.clientId, p.topicId);
  must(!(t && t.kind === 'family' && (ctx.role === 'coordinator' || !((t.extra && t.extra.to) || []).includes(ctx.email))), 'Not found');
  return { messages: (await db.all(`select * from messages where client_id=$1 and topic_id=$2 order by sent_at, message_id`, [ctx.clientId, String(p.topicId || '')])).map(m => core.msgPublic(m, ctx)) };
}

module.exports = { bootstrap, topicMessages };
