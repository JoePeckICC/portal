'use strict';
// Pharmacy: medications, doses, the discharge-papers reader.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const { localToIso } = require('../time');
const { id, must, clean, pick, famName, first } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const medPublic = m => ({ ...m, refills_left: m.refills_left == null ? '' : String(m.refills_left), next_refill: m.next_refill || '' });

// Anything the family enters is Pending review until the coordinator accepts it.
async function saveMed(ctx, p, c) {
  famOrCo(ctx); must(ctx.clientId, 'Pick a family first');
  const name = clean(p.name, 160).trim(); must(name, 'Name the medication');
  const times = String(p.times || '').split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));
  const freq = p.frequency === 'As needed' ? 'As needed' : 'Daily';
  must(freq === 'As needed' || times.length, 'Pick at least one time of day');
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  const refills = parseInt(p.refills_left, 10);
  const row = { name, dose: clean(p.dose, 120), instructions: clean(p.instructions, 500), prescriber: clean(p.prescriber, 120), frequency: freq, times: times.join(','), refills_left: Number.isFinite(refills) ? refills : null,
    next_refill: /^\d{4}-\d{2}-\d{2}$/.test(p.next_refill || '') ? p.next_refill : null, notes: clean(p.notes, 500), status: ctx.role === 'coordinator' ? 'Accepted' : 'Pending review', updated_by: ctx.email };
  const existing = p.medId ? await db.one(`select * from medications where client_id=$1 and med_id=$2`, [ctx.clientId, String(p.medId)], c) : null;
  let saved;
  if (existing) { if (ctx.role === 'coordinator' && existing.status === 'Stopped') row.status = 'Stopped'; saved = (await db.update('medications', { med_id: existing.med_id }, row, c))[0]; }
  else saved = await db.insert('medications', { ...row, med_id: id(), client_id: ctx.clientId, added_by: ctx.email }, c);
  let after = null;
  if (ctx.role !== 'coordinator') {
    await core.autoMsg(ctx.clientId, (existing ? 'Updated' : 'Added') + ' medication: ' + name + (row.dose ? ' ' + row.dose : '') + '. Pending review by ' + (co ? first(co.name) : 'your coordinator') + '.', c);
    after = () => core.notifyCo(co, 'meds', famName(client.family_name) + ' — medication to review', ctx.user.name + (existing ? ' updated ' : ' added ') + name + (row.dose ? ' ' + row.dose : '') + (times.length ? ' at ' + times.join(', ') : ' (as needed)') + '. It is pending your review.', row.instructions, 'Review it');
  }
  return { med: medPublic(saved), _after: after };
}
// The whole list in one go. Each row goes through saveMed so the rules stay in one place; the family gets one note, not ten.
async function addMeds(ctx, p, c) {
  coOnly(ctx);
  const rows = (p.meds || []).filter(m => String(m.name || '').trim()); must(rows.length, 'Nothing to add yet');
  const added = [];
  for (const m of rows) added.push((await saveMed(ctx, m, c)).med);
  const cf = first(ctx.user.name) || 'Your coordinator';
  await core.autoMsg(ctx.clientId, cf + ' built your medication list from the discharge papers: ' + added.map(m => m.name + (m.dose ? ' ' + m.dose : '')).join(', ') + '. Check it under Pharmacy — reminders start from the next dose.', c);
  const after = () => core.notifyFamily(ctx.clientId, 'meds', 'Your medication list is ready', cf + ' added ' + added.length + ' medication' + (added.length === 1 ? '' : 's') + ' from your discharge papers.', added.map(m => '• ' + m.name + (m.dose ? ' ' + m.dose : '') + (m.times ? ' at ' + m.times.split(',').join(', ') : ' as needed')).join('\n'), 'Open Pharmacy');
  return { added: added.length, _after: after };
}
async function setMedStatus(ctx, p, c) {
  coOnly(ctx);
  const m = await db.one(`select * from medications where client_id=$1 and med_id=$2`, [ctx.clientId, String(p.medId || '')], c); must(m, 'Not found');
  const st = pick(p.status, C.MED_STATUSES, m.status);
  await db.update('medications', { med_id: m.med_id }, { status: st, updated_by: ctx.email }, c);
  if (st === 'Accepted') await core.autoMsg(ctx.clientId, 'Medication reviewed: ' + m.name + (m.dose ? ' ' + m.dose : '') + ' is on your schedule.', c);
  if (st === 'Stopped') await core.autoMsg(ctx.clientId, 'Medication stopped: ' + m.name + '.', c);
  return {};
}
async function takeDose(ctx, p, c) {
  famOrCo(ctx);
  must(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(p.dueAt || '')), 'Bad time');
  const med = await db.one(`select med_id from medications where client_id=$1 and med_id=$2`, [ctx.clientId, String(p.medId || '')], c); must(med, 'Not found');
  const due = localToIso(p.dueAt);
  if (p.undo) { await db.q(`update doses set status='Undone', taken_at=null where client_id=$1 and med_id=$2 and due_at=$3`, [ctx.clientId, med.med_id, due], c); return {}; }
  await db.q(`insert into doses (dose_id,client_id,med_id,due_at,status,taken_at,by) values ($1,$2,$3,$4,'Taken',now(),$5)
    on conflict (med_id,due_at) do update set status='Taken', taken_at=now(), by=excluded.by`, [id(), ctx.clientId, med.med_id, due, ctx.email], c);
  return {};
}
// A missed dose can ask the coordinator to check in.
async function missedDose(ctx, p, c) {
  must(core.fam(ctx), 'Not allowed');
  const med = await db.one(`select * from medications where client_id=$1 and med_id=$2`, [ctx.clientId, String(p.medId || '')], c); must(med, 'Not found');
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  const when = String(p.dueAt || '').replace('T', ' at ');
  await core.autoMsg(ctx.clientId, 'Missed dose: ' + med.name + ' (' + when + '). ' + (co ? first(co.name) : 'Your coordinator') + ' has been asked to check in.', c);
  const after = () => core.notifyCo(co, 'missed', 'Check-in asked — ' + famName(client.family_name), ctx.user.name + ' missed ' + med.name + (med.dose ? ' ' + med.dose : '') + ' due ' + when + ' and asked you to check in.', med.instructions, 'Open the portal');
  return { _after: after };
}
// Reads discharge papers (photo or PDF) and drafts medication rows from the text. Always a draft; the coordinator checks every line.
async function readDischarge(ctx, p) {
  coOnly(ctx);
  const u = await db.one(`select * from uploads where client_id=$1 and upload_id=$2`, [ctx.clientId, String(p.uploadId || '')]); must(u, 'Not found');
  must(u.storage_key, 'This file still lives in Drive; it moves over in the file migration.');
  const text = await require('../ocr').textOf(u);
  return { text, meds: parseMeds(text) };
}

// ---- the medication parser (verbatim rules from the Apps Script)
const DOSE_RE = /(\d+(?:[.,]\d+)?)\s?(mg|mcg|g|ml|units?|iu|meq|%)\b/i;
function parseMeds(text) {
  const out = [], seen = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const l = line.replace(/\s+/g, ' ').trim(); if (l.length < 6 || l.length > 220) return;
    const dm = DOSE_RE.exec(l); const hasForm = /\b(tablet|tab|capsule|cap|puff|patch|drop|injection|inhaler|suspension|solution)s?\b/i.test(l);
    if (!dm && !hasForm) return;
    if (/allerg|discharge|instructions|pharmacy|signature|patient name|date of birth|follow[- ]?up/i.test(l) && !dm) return;
    let cut = dm ? dm.index : l.search(/\b\d/); if (cut <= 0) cut = l.length;
    let name = l.slice(0, cut).replace(/[^A-Za-z\- \/]/g, ' ').replace(/\s+/g, ' ').trim();
    name = name.split(' ').slice(0, 4).join(' ');
    if (name.length < 3 || /^(take|give|use|apply|and|the|with)$/i.test(name)) return;
    name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    const key = name.toLowerCase(); if (seen[key]) return; seen[key] = 1;
    const rest = l.slice(cut).trim();
    let dose = dm ? dm[1] + ' ' + dm[2].toLowerCase() : '';
    const form = /(\d+)\s?(tablet|tab|capsule|cap|puff|drop)s?\b/i.exec(rest); if (form) dose += (dose ? ', ' : '') + form[1] + ' ' + form[2].toLowerCase() + (Number(form[1]) === 1 ? '' : 's');
    const prn = /\bas needed\b|\bprn\b|\bif needed\b/i.test(l); let times = [];
    if (/\b(four times|qid|every 6 hours|q6h)\b/i.test(l)) times = ['06:00', '12:00', '18:00', '22:00'];
    else if (/\b(three times|tid|every 8 hours|q8h)\b/i.test(l)) times = ['08:00', '14:00', '20:00'];
    else if (/\b(twice|two times|bid|every 12 hours|q12h)\b/i.test(l)) times = ['08:00', '20:00'];
    else if (/\b(bedtime|at night|nightly|qhs|evening|qpm)\b/i.test(l)) times = ['21:00'];
    else if (!prn) times = ['08:00'];
    if (prn) times = [];
    const instr = rest.replace(DOSE_RE, '').replace(/^[\s,\-–—:.]+/, '').replace(/^(tablet|tab|capsule|cap|puff|patch|drop)s?\b[\s,\-–—:.]*/i, '').replace(/^[\s,\-–—:.]+/, '');
    out.push({ name, dose, instructions: instr.slice(0, 200), frequency: prn ? 'As needed' : 'Daily', times: times.join(','), prescriber: '', refills_left: '', next_refill: '', notes: '' });
  });
  return out;
}

module.exports = { saveMed, addMeds, setMedStatus, takeDose, missedDose, readDischarge };
Object.defineProperty(module.exports, 'parseMeds', { value: parseMeds, enumerable: false });   // helper, not an action
