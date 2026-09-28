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

const cityOf = c => { const m = /,\s*([^,]+?),\s*([A-Z]{2})\b/.exec(String(c.address || '')); return m ? { city: m[1].trim(), state: m[2] } : { city: '', state: '' }; };
const link = () => C.PORTAL_URL;
async function vendorFor(ctx, c) { const vid = ctx.user && ctx.user.extra && ctx.user.extra.vendor_id; const v = vid ? await db.one(`select * from vendors where vendor_id=$1 and active`, [vid], c) : null; must(v, 'Your vendor account is not active. Ask your coordinator.'); return v; }
// Reach a vendor where they are: a text if we have their cell, and an email as well.
async function tellVendor(v, subject, text) { if (v.phone) await sms.send(v.phone, text); if (v.email) await mail.notify(v.email, subject, text, '', 'Open the portal'); }
const jobPublicOpen = (j, cl) => ({ job_id: j.job_id, service: j.service, starts_at: j.starts_at, city: j.city, details: j.details, status: j.status, first_name: first(cl && cl.patient_first_name) || '' });
const jobPublicMine = (j, cl) => ({ ...jobPublicOpen(j, cl), family: famName(cl && cl.family_name), address: j.address, taken_at: j.taken_at, done_at: j.done_at, topic_id: (j.extra && j.extra.topic_id) || '' });

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
  const when = new Date(p.startsAt); must(!isNaN(when), 'When do you need it?'); must(when > new Date(Date.now() - 3600e3), 'Pick a time that has not passed');
  const client = await core.clientById(ctx.clientId, c), place = cityOf(client);
  const city = clean(p.city, 60).trim() || place.city; must(city, 'Which town is it in?');
  const j = await db.insert('jobs', { job_id: id(), client_id: ctx.clientId, service, city, state: clean(p.state, 4).toUpperCase() || place.state, starts_at: when, details: clean(p.details, 600), address: clean(p.address, 200).trim() || client.address || '', status: 'Open', created_by: ctx.email }, c);
  const after = async () => {
    const vs = await db.all(`select v.* from vendors v join users u on lower(u.role)='vendor' and u.active and u.extra->>'vendor_id'=v.vendor_id where v.active and lower(v.city)=lower($1) and v.service=$2 and ($3='' or v.state='' or v.state=$3)`, [city, service, j.state]);
    const whenTxt = when.toLocaleString('en-US', { timeZone: C.TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    for (const v of vs) await tellVendor(v, 'New job: ' + service + ' in ' + city, C.APP_NAME + ' — new job: ' + service.toLowerCase() + ', ' + whenTxt + ', ' + city + '. First to take it has it: ' + link());
    const co = await core.coordinatorFor(client);
    await core.notifyCo(co, 'message', service + ' requested — ' + famName(client.family_name), (ctx.user.name || 'The family') + ' asked for ' + service.toLowerCase() + ', ' + whenTxt + '. ' + (vs.length ? vs.length + ' vendor' + (vs.length === 1 ? ' was' : 's were') + ' told.' : 'No vendor in ' + city + ' offers it yet — it needs you.'), j.details, 'Open the chart');
  };
  return { job: j, _after: after };
}
async function cancelJob(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const j = await db.one(`select * from jobs where job_id=$1 and client_id=$2`, [String(p.jobId || ''), ctx.clientId], c); must(j, 'Not found');
  must(j.status === 'Open' || j.status === 'Taken', 'That one is already ' + j.status.toLowerCase());
  await db.q(`update jobs set status='Cancelled' where job_id=$1`, [j.job_id], c);
  const v = j.vendor_id ? await db.one(`select * from vendors where vendor_id=$1`, [j.vendor_id], c) : null;
  return { _after: v ? () => tellVendor(v, 'Job cancelled', C.APP_NAME + ': the ' + j.service.toLowerCase() + ' job for ' + new Date(j.starts_at).toLocaleString('en-US', { timeZone: C.TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' was cancelled by the family.') : null };
}

// ---- the vendor: take it, finish it
async function takeJob(ctx, p, c) {
  must(ctx.role === 'vendor', 'Not allowed'); const v = await vendorFor(ctx, c);
  const r = await db.q(`update jobs set status='Taken', vendor_id=$2, taken_at=now() where job_id=$1 and status='Open' and lower(city)=lower($3) and service=$4 returning *`, [String(p.jobId || ''), v.vendor_id, v.city, v.service], c);
  const j = r.rows ? r.rows[0] : r[0]; must(j, 'Someone else already took this one.');
  const client = await core.clientById(j.client_id, c);
  // their thread with the family: Messages, like every other conversation
  const t = await db.insert('topics', { topic_id: id(), client_id: j.client_id, title: v.name + ' · ' + j.service, kind: 'vendor', status: 'Active', created_by: ctx.email, extra: JSON.stringify({ vendor_email: ctx.email, vendor_id: v.vendor_id, vendor_name: v.name, service: j.service, job_id: j.job_id }) }, c);
  await db.q(`update jobs set extra=coalesce(extra,'{}'::jsonb) || jsonb_build_object('topic_id',$2::text) where job_id=$1`, [j.job_id, t.topic_id], c);
  const whenTxt = new Date(j.starts_at).toLocaleString('en-US', { timeZone: C.TZ, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  await db.insert('messages', { message_id: id(), client_id: j.client_id, topic_id: t.topic_id, sender_email: 'system', body: v.name + ' has this covered: ' + j.service.toLowerCase() + ', ' + whenTxt + '. Write here to reach them.', read_by_client: false, read_by_coordinator: true }, c);
  const after = async () => { await core.notifyFamily(j.client_id, 'message', v.name + ' has your ' + j.service.toLowerCase() + ' covered', v.name + ' took the ' + j.service.toLowerCase() + ' job for ' + whenTxt + '. You can message them in the portal.', '', 'Open the portal'); };
  return { job: jobPublicMine({ ...j, extra: { topic_id: t.topic_id } }, client), _after: after };
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
  out.vendor = { name: v.name, service: v.service, city: v.city, state: v.state, phone: v.phone };
  const open = await db.all(`select j.*, c.patient_first_name, c.family_name from jobs j join clients c on c.client_id=j.client_id where j.status='Open' and lower(j.city)=lower($1) and j.service=$2 and j.starts_at > now() - interval '1 hour' order by j.starts_at`, [v.city, v.service]);
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
  const rows = await db.all(`select j.*, v.name as vendor_name, v.phone as vendor_phone from jobs j left join vendors v on v.vendor_id=j.vendor_id where j.client_id=$1 and j.status <> 'Cancelled' order by j.starts_at desc limit 40`, [clientId]);
  return rows.map(j => ({ job_id: j.job_id, service: j.service, starts_at: j.starts_at, city: j.city, details: j.details, status: j.status, vendor_name: j.vendor_name || '', topic_id: (j.extra && j.extra.topic_id) || '', taken_at: j.taken_at, done_at: j.done_at }));
}
// Only handlers are enumerable: everything enumerable here becomes a callable action.
module.exports = { inviteVendor, requestJob, cancelJob, takeJob, finishJob };
Object.defineProperties(module.exports, { vendorBoot: { value: vendorBoot, enumerable: false }, jobsFor: { value: jobsFor, enumerable: false } });
