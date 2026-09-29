'use strict';
// Who is with them, visits, and the shift checklist (Joe 2026-09-29).
// InCadence never puts a person with a patient. The family says when someone is needed, asks its own Circle, and
// the people who follow them pick a time: a shift ("I can stay the evening") or a visit ("I'll stop by").
// Each part of each day is one of three: needs someone (shown big), welcome (a good time to visit), fine alone (a
// thin line). The page suggests "needs someone" for the day they come home, nights the first week home, and a
// dose due in the first week home; the family changes any of it with a tap.
// Whoever takes a shift sees what happens during it: medicine times (names only if the patient allows that person),
// and the family's to-dos for the day. They remind; they never give. Visitors see nothing medical, and nobody but the
// family sees who else is visiting.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const { localToIso } = require('../time');
const { id, must, clean, isTrue, normEmail, first, hourIn } = require('../util');

const PARTS = ['morning', 'afternoon', 'evening', 'night'];
const NEEDS = ['need', 'welcome', 'alone'];
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
const isFam = ctx => core.fam(ctx) || ctx.role === 'coordinator';
const approver = ctx => ctx.role === 'client' || (ctx.role === 'family' && ctx.user && ctx.user.extra && isTrue(ctx.user.extra.delegate));
// Who is with them is for the inner circle (Joe 2026-09-29): family with their own sign-in, close family in the Circle
// (a parent, sibling, spouse, child, grandparent), and anyone else the people who hold the page allow.
const CLOSE = /\b(sister|brother|sibling|mom|mother|dad|father|parent|spouse|wife|husband|partner|fianc\w*|grand\w*|son|daughter|child|step\w*)\b/i;
async function allowedIn(ctx, client, c) {
  if (isFam(ctx)) return true; if (ctx.role !== 'supporter') return false;
  const me = normEmail(ctx.email), ex = extraOf(client || await core.clientById(ctx.clientId, c));
  if ((ex.shift_allowed || []).map(normEmail).includes(me)) return true;
  const row = await db.one(`select relationship from circle where client_id=$1 and lower(supporter_email)=$2 and status='Active'`, [ctx.clientId, me], c);
  return !!row && CLOSE.test(row.relationship || '');
}
const inCircle = ctx => isFam(ctx) || ctx.role === 'supporter';
async function mustIn(ctx, c) { must(await allowedIn(ctx, null, c), 'This is for the family’s inner circle.'); }
const ymdTZ = d => new Intl.DateTimeFormat('en-CA', { timeZone: C.TZ || 'America/Chicago' }).format(d);
const dayOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const partOf = hhmm => { const h = Number(String(hhmm).slice(0, 2)); return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 21 ? 'evening' : 'night'; };
const when = (day, part) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }) + ', ' + part;
const extraOf = cl => (cl && cl.extra) || {};

// The day they came home: the tracker's Home, or the recorded discharge.
async function homeDay(client, c) {
  const m = await db.one(`select to_char(on_date,'YYYY-MM-DD') d from recovery_milestones where client_id=$1 and kind='discharge'`, [client.client_id], c).catch(() => null);
  if (m && m.d) return m.d;
  const tr = extraOf(client).tracker; return tr && tr.stage === 'Home' && tr.at ? ymdTZ(new Date(tr.at)) : '';
}
// Dose times per day and part, from accepted daily medicines.
async function doseSlots(clientId, c) {
  const meds = await db.all(`select med_id, name, times, frequency from medications where client_id=$1 and status='Accepted'`, [clientId], c);
  const out = [];
  meds.forEach(m => { if (/as needed/i.test(m.frequency || '')) return; String(m.times || '').split(',').map(s => s.trim()).filter(t => /^\d{2}:\d{2}$/.test(t)).forEach(t => out.push({ med_id: m.med_id, name: m.name, time: t, part: partOf(t) })); });
  return out.sort((a, b) => a.time.localeCompare(b.time));
}
// The night part runs past midnight: a 2 AM dose belongs to the night before.
const doseDay = (day, t) => Number(t.slice(0, 2)) < 5 ? addDays(day, 1) : day;

async function grid(ctx, c, days) {
  const client = await core.clientById(ctx.clientId, c), ex = extraOf(client), fam = isFam(ctx), me = normEmail(ctx.email);
  const start = ymdTZ(new Date()), list = Array.from({ length: days || 7 }, (_, i) => addDays(start, i)), end = list[list.length - 1];
  const [needs, cov, vis, asks, doses, taken, todos, home, jobs, chores, done] = await Promise.all([
    db.all(`select to_char(day,'YYYY-MM-DD') as day, part, need from coverage_needs where client_id=$1 and day between $2 and $3`, [ctx.clientId, start, end], c),
    db.all(`select to_char(day,'YYYY-MM-DD') as day, part, kind, who, note, email, added_by from coverage where client_id=$1 and day between $2 and $3`, [ctx.clientId, start, end], c),
    db.all(`select visit_id, to_char(day,'YYYY-MM-DD') as day, part, who, email from visits where client_id=$1 and day between $2 and $3`, [ctx.clientId, start, end], c),
    db.all(`select item_id, cov, status from help_items where client_id=$1 and cov<>'' and status in ('Open','Claimed')`, [ctx.clientId], c),
    doseSlots(ctx.clientId, c),
    db.all(`select med_id, due_at from doses where client_id=$1 and status='Taken' and due_at >= now() - interval '2 days'`, [ctx.clientId], c),
    db.all(`select title, to_char(due_date,'YYYY-MM-DD') as day from tasks where client_id=$1 and due_date between $2 and $3 and status<>'Done' and lower(owner)<>'coordinator'`, [ctx.clientId, start, end], c),
    homeDay(client, c),
    // Help already booked (Joe 2026-09-29: all the help in one place): a sitter, a ride, a meal, by time.
    db.all(`select j.job_id, j.service, j.starts_at, j.status, j.extra, v.name vendor_name from jobs j left join vendors v on v.vendor_id=coalesce(j.vendor_id, j.extra->>'for_vendor') where j.client_id=$1 and j.status in ('Open','Taken') and j.starts_at >= $2::date - interval '1 day' and j.starts_at < $3::date + interval '2 days'`, [ctx.clientId, start, end], c),
    // While you're there: the family's everyday things anyone can do on a visit (walk the dog, feed the cat, the trash).
    db.all(`select chore_id, title, part, coalesce(to_char(day,'YYYY-MM-DD'),'') as day from shift_chores where client_id=$1 and active order by added_at`, [ctx.clientId], c),
    db.all(`select chore_id, to_char(day,'YYYY-MM-DD') as day, by_name from chore_done where client_id=$1 and day between $2 and $3`, [ctx.clientId, start, end], c),
  ]);
  const jobAt = jobs.map(j => { const d = new Date(j.starts_at), hh = String(hourIn(C.TZ || 'America/Chicago', d)).padStart(2, '0'); return { day: ymdTZ(d), part: partOf(hh + ':00'), time: new Intl.DateTimeFormat('en-US', { timeZone: C.TZ || 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(d), service: (j.extra && j.extra.meet) ? 'Meet first' : j.service, who: j.status === 'Taken' && j.vendor_name ? j.vendor_name : '', open: j.status === 'Open' }; });
  const names = Array.isArray(ex.med_names_for) ? ex.med_names_for.map(normEmail) : [];
  const tk = new Set(taken.map(t => t.med_id + '|' + new Date(t.due_at).toISOString()));
  const firstWeek = d => home && d >= home && d < addDays(home, 7);
  const out = list.map(day => ({ day, slots: PARTS.map(part => {
    const set = needs.find(n => n.day === day && n.part === part);
    const dz = doses.filter(x => x.part === part);
    let need = set ? set.need : (day === home ? 'need' : part === 'night' ? (firstWeek(day) ? 'need' : 'alone') : (firstWeek(day) && dz.length ? 'need' : 'welcome'));
    const w = cov.find(x => x.day === day && x.part === part && x.kind === 'with');
    const mine = !!w && !!w.email && normEmail(w.email) === me;
    const vs = vis.filter(x => x.day === day && x.part === part).concat(cov.filter(x => x.day === day && x.part === part && x.kind === 'visit').map(x => ({ who: x.who, email: '' })));
    const s = { part, need, set: !!set, asked: asks.some(a => a.cov === day + '|' + part && a.status === 'Open') };
    if (w) s.with = fam ? { who: w.who, note: w.note, mine } : { who: mine ? 'You' : (first(w.who) || 'Someone'), mine };
    if (fam) s.visits = vs.map(x => x.who); else s.myVisit = vs.some(x => x.email && normEmail(x.email) === me);
    s.booked = jobAt.filter(j => j.day === day && j.part === part).map(j => ({ service: j.service, time: j.time, who: fam ? j.who : (j.who ? first(j.who) : ''), open: j.open }));
    s.chores = chores.filter(ch => ch.part === part && (!ch.day || String(ch.day).slice(0, 10) === day)).map(ch => { const dn = done.find(x => x.chore_id === ch.chore_id && x.day === day); return { chore_id: ch.chore_id, title: ch.title, done: !!dn, by: dn ? (fam ? dn.by_name : first(dn.by_name)) : '' }; });
    // The checklist: the family always; whoever holds this shift.
    if (fam || mine) {
      const showNames = fam || names.includes(me);
      s.checklist = dz.map(x => { const dd = doseDay(day, x.time), due = localToIso(dd + 'T' + x.time); return { med_id: x.med_id, time: x.time, day: dd, label: showNames ? x.name : 'A medicine', done: tk.has(x.med_id + '|' + new Date(due).toISOString()) }; });
      s.todos = todos.filter(t => t.day === day && (part === 'morning' || part === 'afternoon')).map(t => t.title);
    }
    return s;
  }) }));
  let people;
  if (fam) { const al = (ex.shift_allowed || []).map(normEmail); people = (await db.all(`select supporter_email email, supporter_name name, relationship from circle where client_id=$1 and status='Active' order by supporter_name`, [ctx.clientId], c)).map(r => ({ email: normEmail(r.email), name: r.name || r.email, relationship: r.relationship || '', close: CLOSE.test(r.relationship || ''), allowed: al.includes(normEmail(r.email)) })); }
  return { days: out, parts: PARTS, visitsOff: isTrue(ex.visits_off), home, fam, canNames: approver(ctx), canAllow: approver(ctx), people,
    medNamesFor: fam ? names : undefined, shiftPeople: fam ? [...new Map(cov.filter(x => x.kind === 'with' && x.email).map(x => [normEmail(x.email), x.who])).entries()].map(([email, who]) => ({ email, who, names: names.includes(email) })) : undefined,
    pf: first(client.patient_first_name) || '' };
}

async function careGrid(ctx, p, c) { needFamily(ctx); await mustIn(ctx, c); return grid(ctx, c, 7); }

async function setNeed(ctx, p, c) {
  needFamily(ctx); must(isFam(ctx), 'Only the family sets this');
  must(dayOk(p.day) && PARTS.includes(p.part) && NEEDS.includes(p.need), 'Pick a time and how much someone is needed');
  await db.q(`insert into coverage_needs (client_id, day, part, need, set_by) values ($1,$2,$3,$4,$5) on conflict (client_id, day, part) do update set need=excluded.need, set_by=excluded.set_by`, [ctx.clientId, p.day, p.part, p.need, ctx.email], c);
  return grid(ctx, c, 7);
}
async function setVisits(ctx, p, c) {
  needFamily(ctx); must(isFam(ctx), 'Only the family sets this');
  const client = await core.clientById(ctx.clientId, c);
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('visits_off', $2::boolean) where client_id=$1`, [ctx.clientId, !isTrue(p.on)], c);
  return grid(ctx, c, 7);
}
// The patient (or delegate) lets one person who takes shifts see medicine names.
async function setMedNames(ctx, p, c) {
  needFamily(ctx); must(approver(ctx), 'Only the patient decides this');
  const client = await core.clientById(ctx.clientId, c), email = normEmail(p.email); must(email, 'Who?');
  const list = new Set((extraOf(client).med_names_for || []).map(normEmail)); if (isTrue(p.on)) list.add(email); else list.delete(email);
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('med_names_for', $2::jsonb) where client_id=$1`, [ctx.clientId, JSON.stringify([...list])], c);
  return grid(ctx, c, 7);
}
// Someone from the Circle takes a shift: the slot is theirs, any open ask for it is answered, the family hears.
async function takeShift(ctx, p, c) {
  needFamily(ctx); await mustIn(ctx, c); must(dayOk(p.day) && PARTS.includes(p.part), 'Pick a time');
  must(p.day >= ymdTZ(new Date()), 'That time has passed');
  must(!(await db.one(`select 1 from coverage where client_id=$1 and day=$2 and part=$3 and kind='with'`, [ctx.clientId, p.day, p.part], c)), 'Someone already has this one. Thank you.');
  const who = clean(ctx.user.name || ctx.email, 120);
  await db.q(`insert into coverage (slot_id, client_id, day, part, kind, who, note, added_by, email) values ($1,$2,$3,$4,'with',$5,'From the Circle','circle',$6)`, [id(), ctx.clientId, p.day, p.part, who, ctx.email], c);
  await db.q(`update help_items set status='Claimed', claimed_by=$3, claimed_at=now(), claimed_email=$4 where client_id=$1 and cov=$2 and status='Open'`, [ctx.clientId, p.day + '|' + p.part, who, ctx.email], c);
  await db.q(`delete from visits where client_id=$1 and day=$2 and part=$3 and lower(email)=lower($4)`, [ctx.clientId, p.day, p.part, ctx.email], c);
  const after = isFam(ctx) ? null : async () => { for (const u of await core.usersFor(ctx.clientId, 'client')) await mail.notify(u.email, who + ' can stay ' + when(p.day, p.part), who + ' is taking the ' + p.part + ' on ' + when(p.day, p.part).split(',').slice(0, 2).join(',') + '.', '', 'Open Care'); };
  return { ...(await grid(ctx, c, 7)), _after: after };
}
async function releaseShift(ctx, p, c) {
  needFamily(ctx); must(dayOk(p.day) && PARTS.includes(p.part), 'Pick a time');
  const row = await db.one(`select * from coverage where client_id=$1 and day=$2 and part=$3 and kind='with'`, [ctx.clientId, p.day, p.part], c); must(row, 'Not found');
  must(isFam(ctx) || (row.email && normEmail(row.email) === normEmail(ctx.email)), 'Not yours');
  await db.q(`delete from coverage where slot_id=$1`, [row.slot_id], c);
  await db.q(`update help_items set status='Open', claimed_by='', claimed_at=null, claimed_email='' where client_id=$1 and cov=$2 and status='Claimed'`, [ctx.clientId, p.day + '|' + p.part], c);
  const after = isFam(ctx) ? null : async () => { for (const u of await core.usersFor(ctx.clientId, 'client')) await mail.notify(u.email, row.who + ' cannot make ' + when(p.day, p.part), 'That time is open again. It is back on the list for the Circle.', '', 'Open Care'); };
  return { ...(await grid(ctx, c, 7)), _after: after };
}
async function planVisit(ctx, p, c) {
  needFamily(ctx); await mustIn(ctx, c); must(dayOk(p.day) && PARTS.includes(p.part), 'Pick a time');
  const client = await core.clientById(ctx.clientId, c);
  if (isTrue(p.off)) { await db.q(`delete from visits where client_id=$1 and day=$2 and part=$3 and lower(email)=lower($4)`, [ctx.clientId, p.day, p.part, ctx.email], c); return grid(ctx, c, 7); }
  must(!isTrue(extraOf(client).visits_off) || isFam(ctx), 'The family is not taking visits right now. Thank you for asking.');
  must(p.day >= ymdTZ(new Date()), 'That time has passed');
  const who = clean(ctx.user.name || ctx.email, 120);
  await db.q(`insert into visits (visit_id, client_id, day, part, who, email) values ($1,$2,$3,$4,$5,$6) on conflict (client_id, day, part, email) do nothing`, [id(), ctx.clientId, p.day, p.part, who, normEmail(ctx.email)], c);
  return grid(ctx, c, 7);
}
// Ask the Circle for every "needs someone" time this week that nobody has and nobody was asked for yet.
async function askAllNeeds(ctx, p, c) {
  needFamily(ctx); must(isFam(ctx), 'Only the family asks');
  const g = await grid(ctx, c, 7), CIRCLE = require('./circle'); let n = 0;
  for (const d of g.days) for (const s of d.slots) if (s.need === 'need' && !s.with && !s.asked) { const r = await CIRCLE.askShift(ctx, { day: d.day, part: s.part }, c); n++; if (r._after) await r._after(); }
  return { ...(await grid(ctx, c, 7)), asked: n };
}
// A reminder done during a shift counts on the family's medicine list.
async function shiftDose(ctx, p, c) {
  needFamily(ctx); must(dayOk(p.day) && PARTS.includes(p.part) && /^\d{2}:\d{2}$/.test(String(p.time || '')), 'Bad time');
  if (!isFam(ctx)) must(await db.one(`select 1 from coverage where client_id=$1 and day=$2 and part=$3 and kind='with' and lower(email)=lower($4)`, [ctx.clientId, p.day, p.part, ctx.email], c), 'Only whoever has this shift');
  const med = await db.one(`select med_id from medications where client_id=$1 and med_id=$2 and status='Accepted'`, [ctx.clientId, String(p.medId || '')], c); must(med, 'Not found');
  const due = localToIso(doseDay(p.day, p.time) + 'T' + p.time);
  if (isTrue(p.undo)) await db.q(`update doses set status='Undone', taken_at=null where client_id=$1 and med_id=$2 and due_at=$3`, [ctx.clientId, med.med_id, due], c);
  else await db.q(`insert into doses (dose_id,client_id,med_id,due_at,status,taken_at,by) values ($1,$2,$3,$4,'Taken',now(),$5) on conflict (med_id,due_at) do update set status='Taken', taken_at=now(), by=excluded.by`, [id(), ctx.clientId, med.med_id, due, ctx.email], c);
  return grid(ctx, c, 7);
}

// While you're there: the family lists everyday things by part of the day, every day or one day. Never removed, set aside.
async function addChore(ctx, p, c) {
  needFamily(ctx); must(isFam(ctx), 'Only the family adds these');
  const title = clean(p.title, 120).trim(); must(title, 'What needs doing?'); must(PARTS.includes(p.part), 'Pick a part of the day');
  must(!p.day || dayOk(p.day), 'Pick a day');
  await db.q(`insert into shift_chores (chore_id, client_id, title, part, day, added_by) values ($1,$2,$3,$4,$5,$6)`, [id(), ctx.clientId, title, p.part, p.day || null, ctx.email], c);
  return grid(ctx, c, 7);
}
async function dropChore(ctx, p, c) {
  needFamily(ctx); must(isFam(ctx), 'Only the family changes these');
  const r = await db.q(`update shift_chores set active=false where client_id=$1 and chore_id=$2`, [ctx.clientId, String(p.choreId || '')], c); must(r.rowCount, 'Not found');
  return grid(ctx, c, 7);
}
// Anyone in the Circle who is there can check one off; the family sees who did it.
async function doneChore(ctx, p, c) {
  needFamily(ctx); await mustIn(ctx, c); must(dayOk(p.day), 'Pick a day');
  const ch = await db.one(`select chore_id from shift_chores where client_id=$1 and chore_id=$2 and active`, [ctx.clientId, String(p.choreId || '')], c); must(ch, 'Not found');
  if (isTrue(p.undo)) await db.q(`delete from chore_done where chore_id=$1 and day=$2`, [ch.chore_id, p.day], c);
  else await db.q(`insert into chore_done (chore_id, client_id, day, by_name, by_email) values ($1,$2,$3,$4,$5) on conflict (chore_id, day) do update set by_name=excluded.by_name, by_email=excluded.by_email, at=now()`, [ch.chore_id, ctx.clientId, p.day, clean(ctx.user.name || ctx.email, 120), ctx.email], c);
  return grid(ctx, c, 7);
}

// The page holders (the patient and up to two family members) let someone else in the Circle in.
async function setShiftAllowed(ctx, p, c) {
  needFamily(ctx); must(approver(ctx), 'Only the patient or the family members who hold the page decide this');
  const client = await core.clientById(ctx.clientId, c), email = normEmail(p.email); must(email, 'Who?');
  const list = new Set((extraOf(client).shift_allowed || []).map(normEmail)); if (isTrue(p.on)) list.add(email); else list.delete(email);
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('shift_allowed', $2::jsonb) where client_id=$1`, [ctx.clientId, JSON.stringify([...list])], c);
  return grid(ctx, c, 7);
}

module.exports = { setShiftAllowed, addChore, dropChore, doneChore, careGrid, setNeed, setVisits, setMedNames, takeShift, releaseShift, planVisit, askAllNeeds, shiftDose };
Object.defineProperty(module.exports, 'grid', { value: grid, enumerable: false });
Object.defineProperty(module.exports, 'allowedIn', { value: allowedIn, enumerable: false });
