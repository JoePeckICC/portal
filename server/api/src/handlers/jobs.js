'use strict';
// Vendors in the app (2026-09-28, Joe). The coordinator keeps a vetted list of vendors per city and invites them
// to sign in. A family asks for help ("walk the dog Tuesday at 2"); every invited vendor in that city who offers
// that service gets a text with a link. The first to take it has it, and the family sees who. From then on the
// family and the vendor talk in the portal's Messages, never by personal numbers; the coordinator can see it all.
// A vendor sees only what the job needs: before they take it, the service, the time, the town and the note;
// after, the family's name, the address, and the thread. No diagnosis, no chart, no other family.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const sms = require('../sms');
const { id, must, clean, normEmail, EMAIL_RE, famName, first } = require('../util');
const { SERVICES } = require('./market');
const { localToIso } = require('../time');

// ---- a vendor's hours (2026-09-28, Joe): "people are available at different times, like college students
// walking a dog." A vendor sets the hours they are usually free each weekday, and days off. A family scheduling
// them sees only those days, and only the times inside those hours that are not already booked. A vendor who
// has not set hours shows every time, and can say they can't make it, as before.
const HM = /^([01]\d|2[0-3]):[0-5]\d$/, DAY = /^\d{4}-\d{2}-\d{2}$/;
const MEET = { phone: 'phone call', 'in person': 'in person' };
// Not every kind of help fits a clock time (2026-09-28, Joe). Meals, help at home and equipment are asked for by how
// soon; lodging by check-in and check-out days. starts_at still holds a date (the "needed by", or the check-in) so
// everything sorts and shows on calendars the same way.
const SOON = { asap: ['As soon as possible', 0], days: ['In the next few days', 3], week: ['This week', 6], flex: ['No rush', 14] };
const dayTxt = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
function whenLabel(j, long) {
  const x = j.extra || {};
  if (x.soon && SOON[x.soon]) return 'needed ' + SOON[x.soon][0].toLowerCase();
  if (x.until) return 'check in ' + dayTxt(x.from || require('../time').localStamp(j.starts_at).slice(0, 10)) + ', check out ' + dayTxt(x.until);
  return new Date(j.starts_at).toLocaleString('en-US', { timeZone: C.TZ, weekday: long ? 'long' : 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const meetTxt = m => 'meet first (' + MEET[m] + ')';
function normHours(h) {
  h = h || {}; const week = [];
  for (let i = 0; i < 7; i++) { const w = (h.week || [])[i]; week.push(w && HM.test(w.from) && HM.test(w.to) && w.from < w.to ? { from: w.from, to: w.to } : null); }
  const today = new Date().toISOString().slice(0, 10);
  const off = [...new Set((h.off || []).map(String).filter(d => DAY.test(d) && d >= today))].sort().slice(0, 370);   // vacation: one entry per day
  return { week, off, open: !!h.open, set: !!h.set };
}
const localStampDay = d => require('../time').localStamp(d).slice(0, 10);
const hasHours = h => !!(h && !h.open && Array.isArray(h.week) && h.week.some(Boolean));
// Open start times on one day, every half hour; null when the vendor has not set hours.
async function openTimes(v, day, c) {
  const h = v.hours || {};
  must(DAY.test(String(day)), 'Pick a day');
  if ((h.off || []).includes(day)) return [];   // time off counts even for a vendor who is open any time
  if (!hasHours(h)) return null;
  const w = h.week[new Date(day + 'T12:00:00Z').getUTCDay()]; if (!w) return [];
  const open = new Date(localToIso(day + 'T' + w.from)).getTime(), close = new Date(localToIso(day + 'T' + w.to)).getTime();
  const busy = (await db.all(`select starts_at from jobs where starts_at between $2 and $3 and (vendor_id=$1 and status='Taken' or status='Open' and extra->>'for_vendor'=$1)`, [v.vendor_id, new Date(open - 3600e3), new Date(close + 3600e3)], c)).map(r => new Date(r.starts_at).getTime());
  const out = [], soon = Date.now() + 3600e3;
  for (let t = open; t + 30 * 60000 <= close; t += 30 * 60000) if (t >= soon && !busy.some(b => Math.abs(b - t) < 3600e3)) out.push(new Date(t));
  return out;
}
async function saveHours(ctx, p, c) {
  must(ctx.role === 'vendor', 'Not allowed'); const v = await vendorFor(ctx, c);
  const hours = { ...normHours(p.hours), set: true };
  must(hours.open || hours.week.some(Boolean), 'Pick at least one day, or say you are open any time');
  await db.q(`update vendors set hours=$2 where vendor_id=$1`, [v.vendor_id, JSON.stringify(hours)], c);
  return { hours };
}
async function vendorTopic(ctx, topicId, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); must(ctx.clientId, 'Pick a family first');
  const t = await db.one(`select * from topics where client_id=$1 and topic_id=$2 and kind='vendor'`, [ctx.clientId, String(topicId || '')], c); must(t, 'Not found');
  const v = await db.one(`select * from vendors where vendor_id=$1 and active`, [t.extra && t.extra.vendor_id], c); must(v, 'That vendor is not taking jobs right now');
  return { t, v };
}
// The family's schedule pop-up asks this for the day they picked.
async function vendorTimes(ctx, p, c) {
  const { v } = await vendorTopic(ctx, p.topicId, c);
  const r = await openTimes(v, String(p.date || ''), c);
  return { any: r === null, times: (r || []).map(d => d.toISOString()) };
}

const cityOf = c => { const m = /,\s*([^,]+?),\s*([A-Z]{2})\b/.exec(String(c.address || '')); return m ? { city: m[1].trim(), state: m[2] } : { city: '', state: '' }; };
const link = () => C.PORTAL_URL;
async function vendorFor(ctx, c) { const vid = ctx.user && ctx.user.extra && ctx.user.extra.vendor_id; const v = vid ? await db.one(`select * from vendors where vendor_id=$1 and active`, [vid], c) : null; must(v, 'Your vendor account is not active. Ask your coordinator.'); return v; }
// Reach a vendor where they are: a text if we have their cell, and an email as well.
async function tellVendor(v, subject, text) { if (v.phone) await sms.send(v.phone, text); if (v.email) await mail.notify(v.email, subject, text, '', 'Open the portal'); }
// The answers to a request's questions (pickup, drop-off, how many kids…). Private ones — addresses — only show
// once someone has taken the job, the same rule as the family's address.
const infoOf = (j, all) => ((j.extra && j.extra.info) || []).filter(x => all || !x.p).map(x => ({ l: x.l, v: x.v }));
function cleanInfo(a) { return (Array.isArray(a) ? a : []).slice(0, 12).map(x => ({ l: clean(x && x.l, 60).trim(), v: clean(x && x.v, 300).trim(), p: !!(x && x.p) })).filter(x => x.l && x.v); }
const jobPublicOpen = (j, cl) => ({ job_id: j.job_id, service: j.service, info: infoOf(j, false), loan: !!(j.extra && j.extra.loan), meet: (j.extra && j.extra.meet) || '', soon: (j.extra && j.extra.soon) || '', until: (j.extra && j.extra.until) || '', from: (j.extra && j.extra.from) || '', starts_at: j.starts_at, city: j.city, details: j.details, status: j.status, first_name: first(cl && cl.patient_first_name) || '', for_me: !!(j.extra && j.extra.for_vendor), family: j.extra && j.extra.for_vendor ? famName(cl && cl.family_name) : undefined });
const jobPublicMine = (j, cl) => ({ ...jobPublicOpen(j, cl), info: infoOf(j, true), family: famName(cl && cl.family_name), address: j.address, taken_at: j.taken_at, done_at: j.done_at, topic_id: (j.extra && j.extra.topic_id) || '' });

// ---- the coordinator: invite a vendor from the list to sign in
async function inviteVendor(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed');
  const v = await db.one(`select * from vendors where vendor_id=$1`, [String(p.vendorId || '')], c); must(v, 'Not found');
  const email = normEmail(v.email); must(EMAIL_RE.test(email), 'Add the vendor\'s email first');
  const ex = await db.one(`select * from users where email=$1`, [email], c);
  must(!ex || String(ex.role).toLowerCase() === 'vendor', 'That email is already in use on another account');
  if (ex) await db.q(`update users set active=true, name=$2, extra=coalesce(extra,'{}'::jsonb) || jsonb_build_object('vendor_id', $3::text) where email=$1`, [email, v.name, v.vendor_id], c);
  else await db.insert('users', { email, name: v.name, role: 'vendor', client_id: null, active: true, relationship: v.service, extra: JSON.stringify({ vendor_id: v.vendor_id }) }, c);
  const after = async () => {
    await mail.notify(email, 'You can now take jobs through ' + C.APP_NAME, 'Sign in with this email address. When a family near you needs ' + v.service.toLowerCase() + ', you will get a text and an email, and the first to take it has it.', '', 'Sign in', link());
    if (v.phone) await sms.send(v.phone, C.APP_NAME + ': you are set up to take jobs. Sign in with ' + email + ' at ' + link());
  };
  return { _after: after };
}

// ---- the family: ask for help
async function requestJob(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); must(ctx.clientId, 'Pick a family first');
  const service = SERVICES.includes(p.service) ? p.service : 'Other';
  const soon = !p.topicId && SOON[p.soon] ? p.soon : '';
  const stay = !p.topicId && DAY.test(String(p.from || '')) && DAY.test(String(p.until || '')) ? { from: String(p.from), until: String(p.until) } : null;
  if (stay) { const today = require('../time').localStamp(new Date()).slice(0, 10); must(stay.from >= today, 'Pick a check-in day that has not passed'); must(stay.until > stay.from, 'Check-out has to be after check-in'); }
  const when = soon ? new Date(Date.now() + SOON[soon][1] * 86400e3) : stay ? new Date(localToIso(stay.from + 'T15:00')) : new Date(p.startsAt);
  must(!isNaN(when), 'When do you need it?'); must(soon || stay || when > new Date(Date.now() - 3600e3), 'Pick a time that has not passed');
  const timing = soon ? { soon } : stay ? stay : {};
  // Medical equipment is borrowed from the coordinator's loan closet, not bought from a vendor: it goes to the coordinator.
  const loan = !p.topicId && service === 'Medical equipment';
  const info = cleanInfo(p.info); if (info.length) timing.info = info; if (loan) timing.loan = true;
  const client = await core.clientById(ctx.clientId, c), place = cityOf(client);
  // Asked from a conversation with a vendor: it goes to that vendor alone, and lives in that same thread.
  const vt = p.topicId ? await db.one(`select * from topics where client_id=$1 and topic_id=$2 and kind='vendor'`, [ctx.clientId, String(p.topicId)], c) : null;
  const direct = vt ? await db.one(`select * from vendors where vendor_id=$1 and active`, [vt.extra && vt.extra.vendor_id], c) : null;
  if (p.topicId) must(direct, 'That vendor is not taking jobs right now');
  const meet = direct && MEET[p.meet] ? p.meet : '';
  if (direct) { const ok = await openTimes(direct, localStampDay(when), c); must(ok === null || ok.some(d => d.getTime() === when.getTime()), first(direct.name) + ' is not free then. Pick another time.'); }
  const svc = direct ? direct.service : service;
  const city = direct ? direct.city : (clean(p.city, 60).trim() || place.city); must(city, 'Which town is it in?');
  const j = await db.insert('jobs', { job_id: id(), client_id: ctx.clientId, service: svc, city, state: direct ? direct.state : (clean(p.state, 4).toUpperCase() || place.state), starts_at: when, details: clean(p.details, 600), address: clean(p.address, 200).trim() || client.address || '', status: 'Open', created_by: ctx.email, extra: JSON.stringify(direct ? { for_vendor: direct.vendor_id, topic_id: vt.topic_id, ...(meet ? { meet } : {}) } : timing) }, c);
  if (direct) {
    const whenTxt0 = when.toLocaleString('en-US', { timeZone: C.TZ, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await db.insert('messages', { message_id: id(), client_id: ctx.clientId, topic_id: vt.topic_id, sender_email: 'system', body: 'Asked ' + direct.name + (meet ? ' to ' + meetTxt(meet) : ' for ' + svc.toLowerCase()) + ', ' + whenTxt0 + (j.details ? ': ' + j.details : '') + '. Waiting for them to confirm.', read_by_client: true, read_by_coordinator: true }, c);
    await db.q(`update topics set last_at=now() where topic_id=$1`, [vt.topic_id], c);
    return { job: j, _after: () => tellVendor(direct, 'New request from ' + famName(client.family_name), C.APP_NAME + ' — a family ' + (meet ? 'would like to ' + meetTxt(meet) : 'you have helped asked for you: ' + svc.toLowerCase()) + ', ' + whenTxt0 + '. Accept or pass: ' + link()) };
  }
  if (loan) return { job: j, _after: async () => { const co = await core.coordinatorFor(client); await core.notifyCo(co, 'message', 'Equipment to borrow — ' + famName(client.family_name), (ctx.user.name || 'The family') + ' would like to borrow: ' + info.map(x => x.l + ': ' + x.v).join('; ') + '.', j.details, 'Open the chart'); } };
  // The circle's casting call (Joe): ask the family's own people first — for an hour or two, or only them — and if
  // no one steps up in time, it goes to the support team like any other request.
  const CIRCLE_HRS = { '1': 1, '2': 2, '4': 4 };
  if (p.circle === 'only' || CIRCLE_HRS[p.circle]) {
    const near = await circleNear(ctx.clientId, ctx.email, c);
    must(near.length, 'No one in your circle lives near you yet. Ask our support team instead.');
    const until = p.circle === 'only' ? '' : new Date(Date.now() + CIRCLE_HRS[p.circle] * 3600e3).toISOString();
    await db.q(`update jobs set extra = extra || jsonb_build_object('circle', $2::jsonb) where job_id=$1`, [j.job_id, JSON.stringify({ until, fallback: !!until })], c);
    const whenTxt = whenLabel({ starts_at: when, extra: timing });
    const title = service + ' — ' + whenTxt;
    const detail = info.map(x => x.l + ': ' + x.v).join('\n') + (j.details ? (info.length ? '\n' : '') + j.details : '');
    await db.insert('help_items', { item_id: id(), client_id: ctx.clientId, title, detail, when_text: whenTxt, status: 'Open', claimed_by: '', added_by: ctx.email, job_id: j.job_id }, c);
    const after = async () => {
      const people = near;
      const fam = famName(client.family_name);
      for (const e of people) await mail.notify(e, fam + ' could use a hand: ' + service.toLowerCase(), (first(ctx.user.name) || 'The family') + ' is asking their circle first: ' + service.toLowerCase() + ', ' + whenTxt + '.' + (until ? ' If no one steps up by ' + new Date(until).toLocaleTimeString('en-US', { timeZone: C.TZ, hour: 'numeric', minute: '2-digit' }) + ', InCadence finds someone.' : '') + ' The first to step up has it.', detail, 'I can help', link());
    };
    return { job: { ...j, extra: { ...j.extra, circle: { until, fallback: !!until } } }, _after: after };
  }
  return { job: j, _after: () => broadcast(j, client, ctx.user.name) };
}
// The people in a family's circle who live near them: the same first three ZIP digits (roughly the same area).
// Everyone in the circle gives a ZIP code when they first sign in; people far away are never asked to drive over.
const zipOf = s => { const m = String(s || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/); return m ? m[1] : ''; };
async function circleNear(clientId, exceptEmail, c) {
  const client = await core.clientById(clientId, c); const home = zipOf(client && client.address); if (!home) return [];
  const emails = [...new Set([...(await db.all(`select lower(supporter_email) e from circle where client_id=$1 and status='Active'`, [clientId], c)).map(r => r.e), ...(await db.all(`select lower(email) e from users where client_id=$1 and active and lower(role)='family'`, [clientId], c)).map(r => r.e)].filter(e => e && e !== String(exceptEmail || '').toLowerCase()))];
  if (!emails.length) return [];
  const rows = await db.all(`select lower(email) e, extra->>'zip' z from users where lower(email) = any($1) and active`, [emails], c);
  return rows.filter(r => r.z && r.z.slice(0, 3) === home.slice(0, 3)).map(r => r.e);
}
// Tell every support-team member in town who offers this kind of help, and the coordinator.
async function broadcast(j, client, askedBy) {
  const vs = await db.all(`select v.* from vendors v join users u on lower(u.role)='vendor' and u.active and u.extra->>'vendor_id'=v.vendor_id where v.active and lower(v.city)=lower($1) and v.service=$2 and ($3='' or v.state='' or v.state=$3)`, [j.city, j.service, j.state]);
  const whenTxt = whenLabel(j);
  for (const v of vs) await tellVendor(v, 'New job: ' + j.service + ' in ' + j.city, C.APP_NAME + ' — new job: ' + j.service.toLowerCase() + ', ' + whenTxt + ', ' + j.city + '. First to take it has it: ' + link());
  const co = await core.coordinatorFor(client);
  await core.notifyCo(co, 'message', j.service + ' requested — ' + famName(client.family_name), (askedBy || 'The family') + ' asked for ' + j.service.toLowerCase() + ', ' + whenTxt + '. ' + (vs.length ? vs.length + ' vendor' + (vs.length === 1 ? ' was' : 's were') + ' told.' : 'No vendor in ' + j.city + ' offers it yet — it needs you.'), j.details, 'Open the chart');
}
// The casting call is over: no one stepped up in time (or the family asked us to take it now). It goes to the
// support team, and the circle's "ways to help" item closes.
async function releaseCircle(j, c) {
  const x = j.extra || {}; if (!x.circle || x.circle.released) return null;
  await db.q(`update jobs set extra = jsonb_set(extra, '{circle,released}', 'true'::jsonb) where job_id=$1`, [j.job_id], c);
  await db.q(`update help_items set status='Removed' where job_id=$1 and status='Open'`, [j.job_id], c);
  return async () => broadcast({ ...j, extra: { ...x, circle: { ...x.circle, released: true } } }, await core.clientById(j.client_id), 'The family');
}
// The family: "Ask InCadence now" instead of waiting for the circle.
async function askUsNow(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const j = await db.one(`select * from jobs where job_id=$1 and client_id=$2 and status='Open'`, [String(p.jobId || ''), ctx.clientId], c); must(j, 'Not found');
  const after = await releaseCircle(j, c); must(after, 'That one already went to the support team.');
  return { _after: after };
}
// Every 15 minutes (with the dose reminders): casting calls whose time is up go to the support team.
async function circleSweep() {
  const due = await db.all(`select * from jobs where status='Open' and extra->'circle' is not null and coalesce(extra->'circle'->>'released','')<>'true' and coalesce(extra->'circle'->>'until','')<>'' and (extra->'circle'->>'until')::timestamptz < now()`);
  for (const j of due) { const after = await db.tx(c => releaseCircle(j, c)); if (after) await after(); }
  return due.length;
}
// Someone in the circle stepped up (from "ways to help"): the request is theirs.
async function circleTook(item, who, c) {
  if (!item.job_id) return null;
  const r = await db.q(`update jobs set status='Taken', taken_at=now(), extra = extra || jsonb_build_object('circle_by', $2::text) where job_id=$1 and status='Open' returning *`, [item.job_id, who], c);
  return (r.rows ? r.rows[0] : r[0]) || null;
}
// The family's standing note for a kind of help ("Biscuit: two walks, key under the mat, feed at 5"), so they
// never type it twice. It fills the note on every request for that kind of help; they can change it any time.
async function saveCareNote(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); must(ctx.clientId, 'Pick a family first');
  const service = SERVICES.includes(p.service) ? p.service : 'Other', text = clean(p.text, 600).trim();
  await db.q(`update clients set extra = jsonb_set(coalesce(extra,'{}'::jsonb), '{care_notes}', coalesce(extra->'care_notes','{}'::jsonb) || jsonb_build_object($2::text, $3::text)) where client_id=$1`, [ctx.clientId, service, text], c);
  return {};
}
async function cancelJob(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const j = await db.one(`select * from jobs where job_id=$1 and client_id=$2`, [String(p.jobId || ''), ctx.clientId], c); must(j, 'Not found');
  must(j.status === 'Open' || j.status === 'Taken', 'That one is already ' + j.status.toLowerCase());
  await db.q(`update jobs set status='Cancelled' where job_id=$1`, [j.job_id], c);
  await db.q(`update help_items set status='Removed' where job_id=$1 and status<>'Removed'`, [j.job_id], c);
  const v = j.vendor_id ? await db.one(`select * from vendors where vendor_id=$1`, [j.vendor_id], c) : null;
  return { _after: v ? () => tellVendor(v, 'Job cancelled', C.APP_NAME + ': the ' + j.service.toLowerCase() + ' job for ' + new Date(j.starts_at).toLocaleString('en-US', { timeZone: C.TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' was cancelled by the family.') : null };
}

// ---- the vendor: take it, finish it
async function takeJob(ctx, p, c) {
  must(ctx.role === 'vendor', 'Not allowed'); const v = await vendorFor(ctx, c);
  const r = await db.q(`update jobs set status='Taken', vendor_id=$2, taken_at=now() where job_id=$1 and status='Open' and (extra->>'for_vendor'=$2 or (coalesce(extra->>'for_vendor','')='' and coalesce(extra->>'loan','')='' and (extra->'circle' is null or extra->'circle'->>'released'='true') and lower(city)=lower($3) and service=$4)) returning *`, [String(p.jobId || ''), v.vendor_id, v.city, v.service], c);
  const j = r.rows ? r.rows[0] : r[0]; must(j, 'Someone else already took this one.');
  const client = await core.clientById(j.client_id, c);
  const whenTxt = whenLabel(j, true);
  if (j.extra && j.extra.topic_id) {   // asked from their conversation: confirm it there
    await db.insert('messages', { message_id: id(), client_id: j.client_id, topic_id: j.extra.topic_id, sender_email: 'system', body: v.name + ' confirmed: ' + (j.extra.meet ? meetTxt(j.extra.meet) : j.service.toLowerCase()) + ', ' + whenTxt + '.', read_by_client: false, read_by_coordinator: true }, c);
    await db.q(`update topics set last_at=now() where topic_id=$1`, [j.extra.topic_id], c);
    return { job: jobPublicMine(j, client), _after: () => core.notifyFamily(j.client_id, 'message', v.name + ' confirmed', v.name + ' confirmed ' + (j.extra.meet ? 'meeting you first' : j.service.toLowerCase()) + ' for ' + whenTxt + '.', '', 'Open the portal') };
  }
  // their thread with the family: Messages, like every other conversation
  const t = await db.insert('topics', { topic_id: id(), client_id: j.client_id, title: v.name + ' · ' + j.service, kind: 'vendor', status: 'Active', created_by: ctx.email, extra: JSON.stringify({ vendor_email: ctx.email, vendor_id: v.vendor_id, vendor_name: v.name, service: j.service, job_id: j.job_id }) }, c);
  await db.q(`update jobs set extra=coalesce(extra,'{}'::jsonb) || jsonb_build_object('topic_id',$2::text) where job_id=$1`, [j.job_id, t.topic_id], c);
  await db.insert('messages', { message_id: id(), client_id: j.client_id, topic_id: t.topic_id, sender_email: 'system', body: v.name + ' has this covered: ' + j.service.toLowerCase() + ', ' + whenTxt + '. Write here to reach them.', read_by_client: false, read_by_coordinator: true }, c);
  const after = async () => { await core.notifyFamily(j.client_id, 'message', v.name + ' has your ' + j.service.toLowerCase() + ' covered', v.name + ' took the ' + j.service.toLowerCase() + ' job for ' + whenTxt + '. You can message them in the portal.', '', 'Open the portal'); };
  return { job: jobPublicMine({ ...j, extra: { topic_id: t.topic_id } }, client), _after: after };
}
// A vendor can pass on a request made to them by name; the family hears it in the same conversation.
async function passJob(ctx, p, c) {
  must(ctx.role === 'vendor', 'Not allowed'); const v = await vendorFor(ctx, c);
  const j = await db.one(`select * from jobs where job_id=$1 and status='Open' and extra->>'for_vendor'=$2`, [String(p.jobId || ''), v.vendor_id], c); must(j, 'Not found');
  await db.q(`update jobs set status='Declined' where job_id=$1`, [j.job_id], c);
  const whenTxt = whenLabel(j, true);
  if (j.extra && j.extra.topic_id) await db.insert('messages', { message_id: id(), client_id: j.client_id, topic_id: j.extra.topic_id, sender_email: 'system', body: v.name + ' can’t make ' + whenTxt + '. Try another time, or ask for help on Find Care.', read_by_client: false, read_by_coordinator: true }, c);
  return { _after: () => core.notifyFamily(j.client_id, 'message', v.name + ' can’t make that time', v.name + ' can’t make ' + whenTxt + '.', '', 'Open the portal') };
}
async function finishJob(ctx, p, c) {
  must(ctx.role === 'vendor', 'Not allowed'); const v = await vendorFor(ctx, c);
  const j = await db.one(`select * from jobs where job_id=$1 and vendor_id=$2 and status='Taken'`, [String(p.jobId || ''), v.vendor_id], c); must(j, 'Not found');
  await db.q(`update jobs set status='Done', done_at=now() where job_id=$1`, [j.job_id], c);
  if (j.extra && j.extra.topic_id) await db.insert('messages', { message_id: id(), client_id: j.client_id, topic_id: j.extra.topic_id, sender_email: 'system', body: v.name + ' marked the ' + j.service.toLowerCase() + ' done.', read_by_client: false, read_by_coordinator: true }, c);
  return {};
}

// What a vendor's portal needs: their profile, open jobs they can take, their own jobs, and their threads.
async function vendorBoot(ctx, out) {
  const v = await vendorFor(ctx);
  out.vendor = { name: v.name, service: v.service, city: v.city, state: v.state, phone: v.phone, hours: normHours(v.hours) };
  const open = await db.all(`select j.*, c.patient_first_name, c.family_name from jobs j join clients c on c.client_id=j.client_id where j.status='Open' and j.starts_at > now() - interval '1 hour' and (j.extra->>'for_vendor'=$3 or (coalesce(j.extra->>'for_vendor','')='' and coalesce(j.extra->>'loan','')='' and (j.extra->'circle' is null or j.extra->'circle'->>'released'='true') and lower(j.city)=lower($1) and j.service=$2)) order by j.starts_at`, [v.city, v.service, v.vendor_id]);
  const mine = await db.all(`select j.*, c.patient_first_name, c.family_name from jobs j join clients c on c.client_id=j.client_id where j.vendor_id=$1 and j.status in ('Taken','Done') order by j.starts_at desc limit 60`, [v.vendor_id]);
  out.openJobs = open.map(j => jobPublicOpen(j, j)); out.myJobs = mine.map(j => jobPublicMine(j, j));
  const topics = await db.all(`select * from topics where kind='vendor' and extra->>'vendor_email'=$1 order by created_at`, [ctx.email]);
  const fam = {}; mine.forEach(j => { fam[j.client_id] = famName(j.family_name); });
  out.topics = topics.map(t => ({ ...t, extra: { ...t.extra, family_name: fam[t.client_id] || 'A family' } }));
  const ids = topics.map(t => t.topic_id);
  out.messages = ids.length ? (await db.all(`select * from messages where topic_id = any($1) order by sent_at, message_id`, [ids])).map(m => ({ ...core.msgPublic(m, null), attachments: [] })) : [];
  out.appointments = []; out.tasks = []; out.plan = [];
  return out;
}
// Jobs for a family's own pages (and the coordinator's view of that family).
async function jobsFor(clientId) {
  const rows = await db.all(`select j.*, v.name as vendor_name, v.phone as vendor_phone from jobs j left join vendors v on v.vendor_id=coalesce(j.vendor_id, j.extra->>'for_vendor') where j.client_id=$1 and j.status <> 'Cancelled' order by j.starts_at desc limit 40`, [clientId]);
  return rows.map(j => ({ job_id: j.job_id, service: j.service, circle: (j.extra && j.extra.circle) || null, circle_by: (j.extra && j.extra.circle_by) || '', lent_by: (j.extra && j.extra.lent_by) || '', info: infoOf(j, true), loan: !!(j.extra && j.extra.loan), meet: (j.extra && j.extra.meet) || '', soon: (j.extra && j.extra.soon) || '', until: (j.extra && j.extra.until) || '', from: (j.extra && j.extra.from) || '', address: j.address || '', starts_at: j.starts_at, city: j.city, details: j.details, status: j.status, vendor_name: j.vendor_name || '', direct: !!(j.extra && j.extra.for_vendor), topic_id: (j.extra && j.extra.topic_id) || '', taken_at: j.taken_at, done_at: j.done_at }));
}
// Only handlers are enumerable: everything enumerable here becomes a callable action.
module.exports = { inviteVendor, requestJob, saveCareNote, cancelJob, takeJob, passJob, finishJob, saveHours, vendorTimes, askUsNow };
Object.defineProperties(module.exports, { vendorBoot: { value: vendorBoot, enumerable: false }, jobsFor: { value: jobsFor, enumerable: false }, normHours: { value: normHours, enumerable: false }, circleSweep: { value: circleSweep, enumerable: false }, circleNear: { value: circleNear, enumerable: false }, circleTook: { value: circleTook, enumerable: false } });
