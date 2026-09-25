'use strict';
// The coordinator's side: the library, settings, new families, the In Basket.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const auth = require('../auth');
const mail = require('../mail');
const storage = require('../storage');
const intake = require('../intake');
const { localStamp } = require('../time');
const { id, must, clean, pick, famName, first, normEmail, EMAIL_RE, esc, isTrue, ms, ymd } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');

// ---- the library: two tracks, hand-picked per family
const resPublic = r => ({ resource_id: String(r.resource_id), title: r.title, kind: pick(r.kind, C.RES_KINDS, 'Article'), track: pick(r.track, C.RES_TRACKS, 'Members'), stage: r.stage, by: r.by, minutes: r.minutes == null ? '' : String(r.minutes), summary: r.summary, url: r.url || '', has_body: !!String(r.body || '').trim(), status: r.status, sort: Number(r.sort) || 0 });
async function resources(ctx) {
  famOrCo(ctx);
  const co = ctx.role === 'coordinator';
  const all = (await db.all(`select * from resources where status <> 'Removed' ${co ? '' : "and status='Published'"} order by sort, added_at`)).map(resPublic);
  const recs = ctx.clientId ? await db.all(`select rec_id, resource_id, note, by, at, opened_at from recommendations where client_id=$1 order by at desc`, [ctx.clientId]) : [];
  const out = { resources: all, recs: recs.map(r => ({ ...r, opened_at: r.opened_at || '' })) };
  if (co) {
    const reach = await db.all(`select r.resource_id, (select count(*) from resource_views v where v.resource_id=r.resource_id)::int views, (select count(distinct client_id) from resource_views v where v.resource_id=r.resource_id)::int families, (select count(*) from recommendations x where x.resource_id=r.resource_id)::int recommended, r.body from resources r`);
    const by = {}; reach.forEach(x => { by[x.resource_id] = x; });
    out.resources.forEach(r => { const x = by[r.resource_id] || {}; r.reach = { views: x.views || 0, families: x.families || 0, recommended: x.recommended || 0 }; r.body = x.body || ''; });
  }
  return out;
}
async function saveResource(ctx, p, c) {
  coOnly(ctx);
  const title = clean(p.title, 160).trim(); must(title, 'Give it a title');
  const url = clean(p.url, 500).trim(), body = clean(p.body, 20000);
  must(url || body.trim(), 'Paste a link or write it here');
  if (url) must(/^https:\/\//i.test(url), 'Links start with https://');
  const minutes = parseInt(p.minutes, 10);
  const row = { title, kind: pick(p.kind, C.RES_KINDS, 'Article'), track: pick(p.track, C.RES_TRACKS, 'Members'), stage: pick(p.stage, C.STAGES, C.STAGES[1]), by: clean(p.by, 120).trim() || C.APP_NAME, minutes: Number.isFinite(minutes) ? minutes : null, summary: clean(p.summary, 400).trim(), url, body, status: p.status === 'Published' ? 'Published' : 'Draft' };
  const existing = p.resourceId ? await db.one(`select * from resources where resource_id=$1`, [String(p.resourceId)], c) : null;
  let saved;
  if (existing) { if (p.status === 'Removed') row.status = 'Removed'; saved = (await db.update('resources', { resource_id: existing.resource_id }, row, c))[0]; }
  else { const n = await db.one(`select count(*)::int n from resources`, [], c); saved = await db.insert('resources', { ...row, resource_id: id(), sort: n.n + 1, added_by: ctx.email }, c); }
  return { resource: resPublic(saved) };
}
async function recommend(ctx, p, c) {
  coOnly(ctx);
  const client = await core.clientById(ctx.clientId, c); must(client, 'Not found');
  const r = await db.one(`select * from resources where resource_id=$1 and status='Published'`, [String(p.resourceId || '')], c); must(r, 'Pick a published resource');
  const note = clean(p.note, 600).trim();
  const rec = await db.insert('recommendations', { rec_id: id(), client_id: ctx.clientId, resource_id: r.resource_id, note, by: ctx.email }, c);
  const cf = first(ctx.user.name) || 'Your coordinator';
  await core.autoMsg(ctx.clientId, cf + ' recommends “' + r.title + '”' + (note ? ' — ' + note : '') + ' Open it under Resources.', c);
  const after = () => core.notifyFamily(ctx.clientId, 'message', cf + ' picked something for you to read', cf + ' recommends “' + r.title + '”.', note, 'Open Resources', ctx.email);
  return { rec: { ...rec, opened_at: '' }, _after: after };
}
async function openResource(ctx, p, c) {
  famOrCo(ctx);
  const r = await db.one(`select * from resources where resource_id=$1`, [String(p.resourceId || '')], c); must(r, 'Not found');
  if (core.fam(ctx)) {
    await db.insert('resource_views', { view_id: id(), resource_id: r.resource_id, client_id: ctx.clientId, email: ctx.email }, c);
    await db.q(`update recommendations set opened_at=now() where client_id=$1 and resource_id=$2 and opened_at is null`, [ctx.clientId, r.resource_id], c);
  }
  return { body: r.body || '' };
}

// ---- coordinator settings
async function coSettingsPublic(user) {
  const s = core.coSettings(user);
  s.fromEmail = C.FROM_EMAIL;
  s.lifecycle = await require('../lifecycle').enabled();
  s.sigB64 = '';
  if (s.sigFileId) { try { const u = await db.one(`select * from uploads where upload_id=$1`, [s.sigFileId]); if (u && u.storage_key) s.sigB64 = 'data:' + (u.mime || 'image/png') + ';base64,' + (await storage.get(u.storage_key)).toString('base64'); else s.sigFileId = ''; } catch { s.sigFileId = ''; } }
  return s;
}
async function saveCoSettings(ctx, p, c) {
  coOnly(ctx);
  const s = core.coSettings(ctx.user);
  if (p.blocked !== undefined) s.blocked = (p.blocked || []).map(String).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).filter((d, i, a) => a.indexOf(d) === i).sort();
  if (p.notify) Object.keys(C.CO_KINDS).forEach(k => { if (['instant', 'digest', 'off'].indexOf(p.notify[k]) >= 0) s.notify[k] = p.notify[k]; });
  if (p.digestHour !== undefined) { const h = Number(p.digestHour); if (h >= 0 && h <= 23) s.digestHour = h; }
  if (p.title !== undefined) s.title = clean(p.title, 80).trim();
  if (p.tagline !== undefined) s.tagline = clean(p.tagline, 120).trim();
  if (p.lifecycle !== undefined) await require('../lifecycle').setEnabled(!!p.lifecycle, c);
  if (p.fromEmail !== undefined) { const fe = clean(p.fromEmail, 120).trim().toLowerCase(); must(!fe || EMAIL_RE.test(fe), 'That does not look like an email address'); await db.q(`insert into settings (key,value) values ('FROM_EMAIL',$1) on conflict (key) do update set value=excluded.value`, [fe], c); }
  if (p.sigB64) {
    const bytes = Buffer.from(String(p.sigB64), 'base64'); must(bytes.length <= 2 * 1024 * 1024, 'Keep the signature image under 2 MB');
    const up = await storage.saveUpload(ctx, { clientId: null, kind: 'Other', name: 'signature-' + ctx.email + '.png', mime: p.sigType || 'image/png', bytes, note: 'signature', shared: false }, c);
    if (s.sigFileId) { try { const old = await db.one(`select storage_key from uploads where upload_id=$1`, [s.sigFileId], c); if (old && old.storage_key) await storage.remove(old.storage_key); await db.q(`delete from uploads where upload_id=$1`, [s.sigFileId], c); } catch {} }
    s.sigFileId = up.upload_id;
  }
  if (p.removeSig) { if (s.sigFileId) { try { const old = await db.one(`select storage_key from uploads where upload_id=$1`, [s.sigFileId], c); if (old && old.storage_key) await storage.remove(old.storage_key); await db.q(`delete from uploads where upload_id=$1`, [s.sigFileId], c); } catch {} } s.sigFileId = ''; }
  await db.q(`update users set co_settings=$2 where email=$1`, [ctx.email, JSON.stringify(s)], c);
  ctx.user.co_settings = s;
  return { coSettings: await coSettingsPublic(ctx.user) };
}

// ---- new family
async function newFamily(ctx, p, c) {
  coOnly(ctx);
  const fam = clean(p.family_name, 80).trim(), fname = clean(p.patient_first_name, 60).trim(), last = clean(p.patient_last_name, 60).trim(), email = normEmail(p.email);
  must(fam && fname, 'Family name and the patient’s first name are needed');
  must(EMAIL_RE.test(email), 'A working email for the patient is needed — that is how they sign in');
  must(!(await db.one(`select 1 from users where email=$1`, [email], c)), 'That email already has a portal login');
  const sd = /^\d{4}-\d{2}-\d{2}$/.test(p.surgery_date || '') ? p.surgery_date : null;
  const stage = C.STAGES.indexOf(p.stage) >= 0 ? p.stage : C.STAGES[0];
  let cid = String(Date.now()).slice(-7);
  while (await db.one(`select 1 from clients where client_id=$1`, [cid], c)) cid = String(Number(cid) + 1);
  await db.insert('clients', { client_id: cid, family_name: fam, patient_first_name: fname, patient_last_name: last, surgery_date: sd, current_stage: stage, status: 'Active', coordinator_email: ctx.email, circle_enabled: false, paid: false, plan_ready: false, phone: clean(p.phone, 40).trim() }, c);
  const signin = clean(p.signin_name, 80).trim();
  await db.insert('users', { email, name: [signin || fname, !signin ? last : ''].filter(Boolean).join(' '), role: 'client', client_id: cid, active: true }, c);
  const tok = auth.makeToken(email, 'link', 60 * 24 * 3); await auth.noteNonce(auth.tokNonce(tok), email, 'link');
  const url = `${C.PORTAL_URL}?t=${encodeURIComponent(tok)}`;
  const who = signin || fname;
  const after = () => mail.sendMail(email, 'Welcome to ' + C.APP_NAME + ' — your portal', mail.frame(
    `<p style="font-size:17px">Hi ${esc(first(who))},</p><p style="font-size:16px;line-height:1.5">${esc(ctx.user.name)} set up your portal. Use the button below to choose your password. The first thing inside is a short intake — a few questions so we can start carrying the right things. The button works for three days; after that, use “First time here or forgot your password?” on the sign-in page.</p>` +
    `<p><a href="${url}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:3px">Set my password</a></p>` +
    (p.note ? `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #C09B36;background:#F6F4EF;white-space:pre-wrap;font-size:15px;line-height:1.5">${esc(clean(p.note, 1000))}</blockquote>` : '') +
    `<p style="font-size:13px;color:#5B6470;line-height:1.5">Questions? Reply to this email or call ${esc(C.INCADENCE_PHONE)}.</p>`));
  return { client_id: cid, _after: after };
}

// ---- the In Basket: what needs the coordinator, across every family
async function inbasket(ctx) {
  coOnly(ctx);
  const clients = await db.all(`select * from clients where lower(status) not in ('closed','archived')`);
  const byId = {}; clients.forEach(cl => { byId[cl.client_id] = cl; });
  const ids = clients.map(cl => cl.client_id);
  const fam = cid => (byId[cid] ? famName(byId[cid].family_name) : cid);
  const today = ymd(new Date(), C.TZ);
  const day = s => { const { localToIso } = require('../time'); return new Date(localToIso(s)); };
  const t0 = day(today), t1 = new Date(t0.getTime() + 864e5), t7 = new Date(t0.getTime() + 7 * 864e5);
  const needs = [];
  const [meds, unread, intakes, assist, papers, appts, tasks, booked] = await Promise.all([
    db.all(`select * from medications where status='Pending review' and client_id = any($1)`, [ids]),
    db.all(`select m.client_id, m.topic_id, count(*)::int n, bool_or(m.urgent) urgent, max(m.sent_at) last_at, (array_agg(m.body order by m.sent_at desc))[1] body, t.title, t.kind
            from messages m left join topics t on t.topic_id=m.topic_id where m.sender_email<>'system' and m.read_by_coordinator=false and m.client_id = any($1) group by m.client_id, m.topic_id, t.title, t.kind`, [ids]),
    db.all(`select client_id, answer status, (select answer from intake_answers s where s.client_id=i.client_id and s.question_id='_submitted_at') submitted_at from intake_answers i where question_id='_status' and (answer like 'Updated%' or answer like 'Submitted%') and client_id = any($1)`, [ids]),
    db.all(`select * from assistance where status='Suggested' and client_id = any($1)`, [ids]),
    db.all(`select u.* from uploads u where u.kind='Discharge' and u.client_id = any($1) and u.uploaded_at > coalesce((select max(added_at) from medications m where m.client_id=u.client_id), '1970-01-01')
            and u.uploaded_at = (select max(uploaded_at) from uploads x where x.client_id=u.client_id and x.kind='Discharge')`, [ids]),
    db.all(`select * from appointments where status<>'Cancelled' and client_id = any($1) and starts_at >= $2 and starts_at < $3 order by starts_at`, [ids, t0, t7]),
    db.all(`select * from tasks where status<>'Done' and client_id = any($1) and due_date is not null and due_date < $2`, [ids, ymd(t7, C.TZ)]),
    db.all(`select client_id, count(*)::int n from appointments where status<>'Cancelled' and starts_at > now() and client_id = any($1) group by client_id`, [ids]),
  ]);
  meds.forEach(m => needs.push({ kind: 'Meds', client_id: m.client_id, family: fam(m.client_id), text: m.name + (m.dose ? ' ' + m.dose : '') + ' — pending review', when: m.updated_at || m.added_at || '', go: 'meds', pri: 1 }));
  unread.forEach(u => { const urg = u.kind === 'urgent' || u.urgent; needs.push({ kind: urg ? 'Urgent' : 'Message', client_id: u.client_id, family: fam(u.client_id), text: '“' + String(u.body).slice(0, 110) + (String(u.body).length > 110 ? '…' : '') + '” — ' + (u.title || 'Messages') + (u.n > 1 ? ' (' + u.n + ')' : ''), when: u.last_at, go: 'messages:' + u.topic_id, pri: urg ? 0 : 2 }); });
  intakes.forEach(i => {
    const cl = byId[i.client_id];
    if (cl && !isTrue(cl.plan_ready)) needs.push({ kind: 'Plan', client_id: i.client_id, family: fam(i.client_id), text: 'Plan ready to create — the intake is in', when: i.submitted_at || '', go: 'build', pri: 1 });
    else if (/^Updated/.test(String(i.status))) needs.push({ kind: 'Intake', client_id: i.client_id, family: fam(i.client_id), text: 'Changed answers after submitting — plan re-check', when: i.submitted_at || '', go: 'intake', pri: 3 });
  });
  clients.forEach(cl => {
    if (isTrue(cl.paid) && isTrue(cl.plan_ready) && !booked.some(b => b.client_id === cl.client_id)) needs.push({ kind: 'Implement', client_id: cl.client_id, family: fam(cl.client_id), text: 'Portal open, nothing booked yet — set the plan in motion', when: cl.paid_at || '', go: 'run', pri: 2 });
    if (cl.billing_status === 'Payment failed') needs.push({ kind: 'Billing', client_id: cl.client_id, family: fam(cl.client_id), text: 'Card declined · $' + (cl.monthly_amount == null ? '' : cl.monthly_amount) + ' · Stripe will retry', when: '', go: 'billing', pri: 3 });
    if (cl.stripe_customer_id && !isTrue(cl.paid) && cl.billing_status === 'Active') needs.push({ kind: 'Billing', client_id: cl.client_id, family: fam(cl.client_id), text: 'First invoice not paid yet — portal still locked', when: '', go: 'billing', pri: 4 });
  });
  assist.forEach(a => needs.push({ kind: 'Assistance', client_id: a.client_id, family: fam(a.client_id), text: a.name + (a.what ? ' — ' + a.what : ''), when: a.updated_at || '', go: 'billing:assist', pri: 4 }));
  papers.forEach(u => needs.push({ kind: 'Papers', client_id: u.client_id, family: fam(u.client_id), text: 'Discharge papers uploaded — build the medication list', when: u.uploaded_at || '', go: 'meds:build', pri: 2 }));
  needs.sort((a, b) => a.pri - b.pri || ms(b.when) - ms(a.when));
  const apptsOut = appts.map(a => ({ client_id: a.client_id, family: fam(a.client_id), appt_id: a.appt_id, title: a.title, starts_at: localStamp(a.starts_at), location: a.location || '', note: a.note || '', kind: /with joe|planning call|quick check|talk something/i.test(String(a.title)) ? 'yours' : 'outside', has_note: !!String(a.visit_note || '').trim() }));
  const tasksOut = tasks.map(t => { const due = t.due_date || ''; return { client_id: t.client_id, family: fam(t.client_id), task_id: t.task_id, title: t.title, owner: t.owner || '', due, status: t.status, overdue: !!due && due < today, today: due === today }; }).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')));
  const fams = clients.map(cl => {
    const flags = needs.filter(n => n.client_id === cl.client_id).map(n => n.kind);
    const dts = cl.surgery_date ? Math.round((day(cl.surgery_date) - t0) / 864e5) : null;
    return { client_id: cl.client_id, family: famName(cl.family_name), family_name: cl.family_name, patient: [cl.patient_first_name, cl.patient_last_name].join(' ').trim(), stage: cl.current_stage || '', surgery_date: cl.surgery_date || '', days: dts, flags: flags.filter((f, i) => flags.indexOf(f) === i), billing: cl.billing_status || (cl.stripe_customer_id ? 'Active' : ''), paid: isTrue(cl.paid), plan_ready: isTrue(cl.plan_ready) };
  }).sort((a, b) => (a.days === null ? 9999 : a.days) - (b.days === null ? 9999 : b.days));
  return { needs, appts: apptsOut, tasks: tasksOut, families: fams, counts: { needs: needs.length, today: appts.filter(a => new Date(a.starts_at) < t1).length, families: fams.length, overdue: tasksOut.filter(t => t.overdue).length } };
}

module.exports = { resources, saveResource, recommend, openResource, saveCoSettings, newFamily, inbasket };
Object.defineProperty(module.exports, 'coSettingsPublic', { value: coSettingsPublic, enumerable: false });
