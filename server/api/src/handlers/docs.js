'use strict';
// Papers the portal prints: the Cadence Plan, the health summary, coordinator letters. Plus booking.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const intake = require('../intake');
const storage = require('../storage');
const calendar = require('../calendar');
const pdf = require('../pdf');
const { id, must, clean, esc, first, famName, isTrue } = require('../util');
const { localToIso, localStamp } = require('../time');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const longDate = () => new Intl.DateTimeFormat('en-US', { timeZone: C.TZ, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());

// ---- HTML builders (same markup as the Apps Script)
function planHtml(c, items, co) {
  const name = [c.patient_first_name, c.patient_last_name].join(' ').trim() || c.family_name;
  let h = '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Helvetica,Arial,sans-serif;color:#1C2A3A;font-size:11pt;line-height:1.5;margin:48px 56px}h1{font-family:Georgia,serif;font-weight:normal;font-size:26pt;margin:6px 0 4px}h2{font-family:Georgia,serif;font-weight:normal;font-size:16pt;margin:26px 0 2px;padding-top:14px;border-top:1px solid #E3DED3}' +
    '.k{font-size:8.5pt;letter-spacing:2px;text-transform:uppercase;color:#C09B36;font-weight:bold}.muted{color:#5B6470;font-size:10pt}.cat{font-size:8.5pt;letter-spacing:1.5px;text-transform:uppercase;color:#C09B36;font-weight:bold;margin:12px 0 2px}.it{margin:0 0 6px 0;padding-left:14px;text-indent:-14px}.d{color:#5B6470;font-size:9.5pt;padding-left:14px}.foot{margin-top:36px;padding-top:12px;border-top:1px solid #E3DED3;color:#5B6470;font-size:9pt}' +
    '</style></head><body>' +
    '<div class="k">' + esc(C.APP_NAME) + ' &middot; The Cadence Plan</div>' +
    '<h1>' + esc(first(c.patient_first_name) || name) + '&rsquo;s road, written down.</h1>' +
    '<div class="muted">Prepared for ' + esc(famName(c.family_name)) + (c.surgery_date ? ' &middot; Surgery ' + esc(String(c.surgery_date).slice(0, 10)) : '') + ' &middot; ' + esc(longDate()) + (co ? ' &middot; Coordinator: ' + esc(co.name) : '') + '</div>';
  let any = false;
  C.STAGES.forEach(st => {
    const rows = items.filter(p => p.stage === st); if (!rows.length) return; any = true;
    h += '<h2>' + esc(st) + '</h2>';
    C.CATEGORIES.forEach(cat => { const rs = rows.filter(p => p.category === cat); if (!rs.length) return; h += '<div class="cat">' + esc(cat) + '</div>'; rs.forEach(p => { h += '<div class="it">&#9675;&nbsp; ' + esc(p.item) + '</div>' + (p.detail ? '<div class="d">' + esc(p.detail) + '</div>' : ''); }); });
  });
  if (!any) h += '<p class="muted">The plan is being written. This page will fill in.</p>';
  h += '<div class="foot">' + esc(C.APP_NAME) + ' is a non-clinical support service. We coordinate; we do not diagnose, treat, or give medical advice. For anything medical, call your care team. In an emergency, call 911.</div></body></html>';
  return h;
}
async function sigImg(user) {
  const sid = core.coSettings(user).sigFileId; if (!sid) return '';
  try { const u = await db.one(`select * from uploads where upload_id=$1`, [sid]); if (!u || !u.storage_key) return ''; return '<img src="data:' + (u.mime || 'image/png') + ';base64,' + (await storage.get(u.storage_key)).toString('base64') + '" style="height:54px;display:block;margin:6px 0 2px">'; } catch { return ''; }
}
function sigBlock(user) {
  const cs = core.coSettings(user);
  return '<div style="border-left:3px solid #C09B36;padding:2px 0 2px 14px;margin-top:6px;line-height:1.5"><b style="font-size:12pt">' + esc(user.name || 'Care coordinator') + '</b><br><span style="color:#C09B36;font-weight:bold">' + esc(cs.title || 'Care coordinator') + ', ' + esc(C.APP_NAME) + '</span>' + (cs.tagline ? '<br>' + esc(cs.tagline) : '') + '<br>' + esc(C.INCADENCE_PHONE) + '<br><b>' + esc(C.INCADENCE_SITE) + '</b><br><span style="color:#5B6470">' + esc(C.INCADENCE_ADDRESS).replace(', Brentwood', '<br>Brentwood') + '</span></div>';
}
async function letterHtml(c, user, to, subject, body) {
  const name = [c.patient_first_name, c.patient_last_name].join(' ').trim() || c.family_name;
  return '<html><head><meta charset="utf-8"><style>body{font-family:Helvetica,Arial,sans-serif;color:#1C2A3A;font-size:11pt;line-height:1.55;margin:56px 64px}.lh{display:flex;justify-content:space-between;border-bottom:2px solid #C09B36;padding-bottom:10px;margin-bottom:28px}.lh b{font-family:Georgia,serif;font-size:20pt;font-weight:normal}.lh span{font-size:9pt;color:#5B6470;text-align:right}p{margin:0 0 12px}.sig{margin-top:34px}.fine{margin-top:40px;font-size:8.5pt;color:#5B6470;border-top:1px solid #E3DED3;padding-top:8px}</style></head><body>' +
    '<div class="lh"><b>' + esc(C.APP_NAME) + '</b><span>' + esc(C.INCADENCE_PHONE) + ' · ' + esc(C.INCADENCE_SITE) + '<br>' + esc(C.INCADENCE_ADDRESS) + '</span></div>' +
    '<p>' + esc(longDate()) + '</p><p>To: ' + esc(to) + '</p><p><b>Re: ' + esc(subject) + '</b><br>Regarding ' + esc(name) + '</p>' +
    body.split(/\n\s*\n/).map(para => '<p>' + esc(para).replace(/\n/g, '<br>') + '</p>').join('') +
    '<div class="sig"><p>Sincerely,</p>' + (await sigImg(user)) + sigBlock(user) + '</div>' +
    '<div class="fine">' + esc(C.APP_NAME) + ' provides non-medical care coordination. This letter confirms the timeline and support arrangements known to us; it is not a physician’s statement, diagnosis, or medical excuse. Medical documentation comes from the treating clinician.</div></body></html>';
}
async function summaryHtml(c, clientId) {
  const it = await intake.readIntake(clientId), a = qid => (it.answers[qid] || {}).a || '';
  const meds = await db.all(`select * from medications where client_id=$1 and status<>'Stopped' order by added_at`, [clientId]);
  const team = await db.all(`select * from care_team where client_id=$1 and status<>'Removed' order by updated_at`, [clientId]);
  const inner = await core.usersFor(clientId, 'family'), co = await core.coordinatorFor(c);
  const name = [c.patient_first_name, c.patient_last_name].join(' ').trim() || c.family_name;
  const row = (k, v) => (v ? '<tr><td class="k">' + esc(k) + '</td><td>' + v + '</td></tr>' : '');
  const sec = (t, rows) => (rows ? '<h2>' + t + '</h2><table>' + rows + '</table>' : '');
  return '<html><head><meta charset="utf-8"><style>body{font-family:Helvetica,Arial,sans-serif;color:#1C2A3A;font-size:10.5pt;line-height:1.45;margin:44px 56px}h1{font-family:Georgia,serif;font-weight:normal;font-size:22pt;margin:0}h2{font-family:Georgia,serif;font-weight:normal;font-size:13pt;margin:18px 0 4px;border-top:1px solid #E3DED3;padding-top:8px}table{border-collapse:collapse;width:100%}td{padding:3px 0;vertical-align:top}td.k{width:150px;color:#5B6470}.top{display:flex;justify-content:space-between;border-bottom:2px solid #C09B36;padding-bottom:8px}.top span{font-size:9pt;color:#5B6470;text-align:right}</style></head><body>' +
    '<div class="top"><div><h1>' + esc(name) + '</h1><div>Health summary · ' + esc(longDate()) + '</div></div><span>' + esc(C.APP_NAME) + '<br>' + esc(C.INCADENCE_PHONE) + '</span></div>' +
    sec('The situation', row('Patient', esc(name) + (c.dob ? ' · born ' + esc(String(c.dob).slice(0, 10)) : '')) + row('Phone', esc(c.phone || a('A.phone'))) + row('Diagnosis', esc(a('G.1'))) + row('Surgery', esc(a('G.4')) + (c.surgery_date ? ' · ' + esc(String(c.surgery_date).slice(0, 10)) : '')) + row('Expected stay', esc(a('G.9'))) + row('After the hospital', esc(a('G.10'))) + row('Stage', esc(c.current_stage || ''))) +
    sec('Medications', meds.map(m => row(m.name, esc([m.dose, m.frequency, m.instructions].filter(Boolean).join(' · ')) + (m.status === 'Pending review' ? ' <i>(pending review)</i>' : ''))).join('') + row('Allergies', esc(c.allergies || 'None listed')) + row('Pharmacy', esc([c.pharmacy_name, c.pharmacy_phone].filter(Boolean).join(' · ')))) +
    sec('Care team', team.map(m => row(m.role || m.kind, esc([m.name, m.org, m.phone].filter(Boolean).join(' · ')))).join('') + (co ? row('Coordinator', esc(co.name) + ' · ' + esc(C.APP_NAME) + ' · ' + esc(C.INCADENCE_PHONE)) : '')) +
    sec('People & home', row('Emergency contact', esc([c.emergency_name, c.emergency_relationship ? '(' + c.emergency_relationship + ')' : '', c.emergency_phone].filter(Boolean).join(' '))) + row('Lives', esc(a('A.2'))) + row('Ride home', esc(a('L.1'))) + row('Children at home', esc(a('M.1') === 'Yes' ? 'Yes' + ((it.answers['M.1d'] || {}).a ? ' · ' + (it.answers['M.1d'] || {}).a : '') : a('M.1'))) + row('Pets', esc(a('M.4'))) + row('Inner circle', esc(inner.map(u => u.name + (u.relationship ? ' (' + u.relationship + ')' : '')).join(', ')))) +
    '</body></html>';
}

// ---- actions
async function planPdf(ctx) {
  must(ctx.clientId, 'Pick a family first');
  const c = await core.clientById(ctx.clientId); must(c, 'Not found');
  if (ctx.role === 'client') must(isTrue(c.plan_ready), 'Your plan is not ready yet.');
  const items = (await db.all(`select * from plan_items where client_id=$1 and draft=false order by updated_at`, [ctx.clientId])).filter(p => !(p.extra && p.extra.draft === 'Discarded'));
  const bytes = await pdf.render(planHtml(c, items, await core.coordinatorFor(c)));
  return { b64: bytes.toString('base64'), name: 'Cadence Plan - ' + (c.family_name || c.patient_last_name || 'family') + '.pdf' };
}
async function summaryPdf(ctx) {
  famOrCo(ctx);
  const c = await core.clientById(ctx.clientId); must(c, 'Not found');
  const bytes = await pdf.render(await summaryHtml(c, ctx.clientId));
  return { b64: bytes.toString('base64'), name: 'Health summary - ' + (c.family_name || 'family') + '.pdf' };
}
async function writeLetter(ctx, p, cx) {
  coOnly(ctx);
  const c = await core.clientById(ctx.clientId, cx); must(c, 'Not found');
  const to = clean(p.to, 200).trim(), subject = clean(p.subject, 200).trim(), body = clean(p.body, 6000).trim();
  must(to && subject && body, 'Who it is to, a subject, and the letter itself are all needed');
  const bytes = await pdf.render(await letterHtml(c, ctx.user, to, subject, body));
  const fname = 'Letter — ' + subject.replace(/[\/:*?"<>|]/g, ' ').slice(0, 80) + '.pdf';
  const row = await storage.saveUpload(ctx, { clientId: ctx.clientId, kind: 'Letters', name: fname, mime: 'application/pdf', bytes, note: 'To ' + to, shared: p.shared !== false }, cx);
  await core.autoMsg(ctx.clientId, 'A letter is ready under My Record → Documents: ' + subject + ' (to ' + to + ').', cx);
  const after = async () => { for (const u of await core.usersFor(ctx.clientId, 'client')) await mail.notify(u.email, 'A letter is ready: ' + subject, first(ctx.user.name) + ' wrote a letter to ' + to + '. It is under My Record → Documents in the portal.', '', 'Open the portal'); };
  return { b64: bytes.toString('base64'), name: fname, upload: core.docPublic(row, ctx), _after: after };
}

// ---- booking (Find Care)
async function slots(ctx, p) {
  must(ctx.clientId, 'Pick a family first');
  const kind = C.BOOK_KINDS[p.kind] || C.BOOK_KINDS.quick;
  const co = await core.coordinatorFor(await core.clientById(ctx.clientId));
  if (co && core.coSettings(co).blocked.indexOf(String(p.date)) >= 0) return { slots: [], closed: true };
  if (!calendar.enabled()) return { slots: [], closed: true, unavailable: true };
  return { slots: (await calendar.freeSlots(p.date, kind.minutes)).map(d => d.toISOString()) };
}
async function book(ctx, p, cx) {
  famOrCo(ctx); must(ctx.clientId, 'Pick a family first');
  must(calendar.enabled(), 'Booking is not switched on yet. Message your coordinator to set up a call.');
  const kind = C.BOOK_KINDS[p.kind]; must(kind, 'Pick what the call is for');
  const mode = p.mode === 'video' ? 'video' : 'phone';
  const start = new Date(p.startsAt); must(!isNaN(start), 'Pick a time');
  const day = localStamp(start).slice(0, 10);
  must((await calendar.freeSlots(day, kind.minutes)).some(d => d.getTime() === start.getTime()), 'That time was just taken. Pick another.');
  const end = new Date(start.getTime() + kind.minutes * 60000);
  const client = await core.clientById(ctx.clientId, cx), co = await core.coordinatorFor(client, cx);
  const phone = clean(p.phone, 40).trim();
  if (mode === 'phone') { must(phone, 'Add the best number to reach you'); await db.q(`update clients set phone=$2 where client_id=$1`, [client.client_id, phone], cx); }
  const about = clean(p.about, 500).trim(), fam = famName(client.family_name);
  const title = kind.label + ' — ' + fam;
  const where = mode === 'phone' ? ('Phone. ' + (co ? first(co.name) : 'We') + ' will call ' + phone + (C.INCADENCE_PHONE ? ' (or reach us at ' + C.INCADENCE_PHONE + ')' : '') + '.') : 'Video. The link is in this invite.';
  const desc = kind.label + ' (' + kind.minutes + ' min) with ' + (co ? co.name : C.APP_NAME) + '.\n' + where + (about ? '\n\nWhat to talk through: ' + about : '') + '\n\nBooked from the ' + C.APP_NAME + ' portal.';
  const guests = (await db.all(`select email from users where client_id=$1 and active and lower(role) in ('client','family')`, [ctx.clientId], cx)).map(u => u.email);
  const ev = await calendar.createEvent({ title, start, end, guests, description: desc, location: mode === 'phone' ? 'Phone' : 'Video', video: mode === 'video' });
  const row = await db.insert('appointments', { appt_id: id(), client_id: ctx.clientId, title: kind.label + ' with ' + (co ? first(co.name) : C.APP_NAME), starts_at: start.toISOString(), location: mode === 'phone' ? 'Phone' : 'Video', note: mode === 'phone' ? 'They call ' + phone : (ev.link ? 'Video link in your invite' : 'Video'), status: 'Scheduled', kind: p.kind, mode, minutes: kind.minutes, event_id: ev.id, booked_by: ctx.email, about, link: ev.link }, cx);
  const out = { ...row, starts_at: localStamp(row.starts_at) };
  await core.autoMsg(ctx.clientId, 'Booked: ' + out.title + ', ' + out.starts_at.replace('T', ' at ') + ' (' + out.location + '). An invite went to your email.', cx);
  const after = ctx.role === 'client' ? () => core.notifyCo(co, (start.getTime() - Date.now() < 2 * 864e5) ? 'bookingSoon' : 'booking', 'New booking — ' + fam, ctx.user.name + ' booked a ' + kind.label.toLowerCase() + ' for ' + out.starts_at.replace('T', ' at ') + ' (' + out.location + ').', about, 'Open the portal') : null;
  return { appointment: out, _after: after };
}
async function flushCache(ctx) { coOnly(ctx); return { flushed: true }; }   // nothing to flush any more; kept so the button still works

module.exports = { planPdf, summaryPdf, writeLetter, slots, book, flushCache };
