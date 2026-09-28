'use strict';
// Recovery (2026-09-27): what the patient can and cannot do right now (restrictions, from the team's instructions),
// the home checks those restrictions create as tasks, the family's red-flag card, "the reason" line, the daily
// check-in in their own words, the symptom log, and the "in case I can't update" message written ahead.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const { id, must, clean, isTrue, first, famName } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const extraOf = c => (c.extra && typeof c.extra === 'object' ? c.extra : {});
async function patchExtra(client, patch, c) { await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...extraOf(client), ...patch })], c); }

// The things families ask about. status: no | from (a date) | ok | ask (nobody has said). Each "no"/"from" also
// suggests a home check, a task on the family's list, made once, keyed so it is never made twice.
const RESTRICTIONS = [
  { key: 'drive', label: 'Driving', check: 'Line up rides for the first appointments, who drives, which days', cat: 'Family & ongoing support' },
  { key: 'lift', label: 'Lifting', check: 'Move what gets lifted every day, laundry, groceries, the dog food, a toddler, to waist height, or to someone else', cat: 'Family & ongoing support' },
  { key: 'stairs', label: 'Stairs', check: 'Set up a bed and a bathroom on one floor', cat: 'Family & ongoing support' },
  { key: 'shower', label: 'Showering and bathing', check: 'A shower chair, a hand-held head or a sponge-bath plan; waterproof dressing covers if the team said so', cat: 'Family & ongoing support' },
  { key: 'work', label: 'Work', check: 'Tell the employer the return date the team gave; start the FMLA or leave paperwork under Letters', cat: 'Understanding & advocacy' },
  { key: 'diet', label: 'Eating and drinking', check: 'Stock the kitchen for the diet the team gave, three days of easy food that fits it', cat: 'Family & ongoing support' },
  { key: 'exercise', label: 'Exercise and walking', check: 'A safe walking route from the front door, and a chair at the far end', cat: 'Family & ongoing support' },
  { key: 'dressing', label: 'The dressing and the incision', check: 'Supplies on the landing-zone table: what the team said to use, and how often', cat: 'Care coordination' },
  { key: 'travel', label: 'Travel and flying', check: '', cat: '' },
  { key: 'alcohol', label: 'Alcohol', check: '', cat: '' },
  { key: 'intimacy', label: 'Intimacy', check: '', cat: '' },
  { key: 'sleep', label: 'Sleeping position', check: 'Set the bed or recliner up the way the team said, propped, on which side, with which pillows', cat: 'Family & ongoing support' },
];
const STATUSES = ['ask', 'no', 'from', 'ok'];

async function setRestrictions(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);   // the team's instructions, as the coordinator wrote them down; the family suggests changes in Messages
  const client = await core.clientById(ctx.clientId, c);
  const cur = extraOf(client).restrictions || {};
  const inp = p.restrictions && typeof p.restrictions === 'object' ? p.restrictions : {};
  const out = { ...cur }; const made = [];
  for (const r of RESTRICTIONS) {
    const v = inp[r.key]; if (!v) continue;
    const status = STATUSES.indexOf(v.status) >= 0 ? v.status : 'ask';
    const from = status === 'from' && /^\d{4}-\d{2}-\d{2}$/.test(String(v.from || '')) ? String(v.from) : '';
    must(status !== 'from' || from, r.label + ': pick the date it lifts, or choose another answer.');
    if (from) { const t = Date.parse(from); must(t > Date.now() - 366 * 864e5 && t < Date.now() + 731 * 864e5, r.label + ': the date should be within the next two years.'); }
    out[r.key] = { status, from, note: clean(v.note, 300), by: ctx.email, at: new Date().toISOString() };
    if ((status === 'no' || status === 'from') && r.check) {
      const exists = await db.one(`select 1 from tasks where client_id=$1 and extra->>'auto'=$2`, [ctx.clientId, 'restriction:' + r.key], c);
      if (!exists) { await db.insert('tasks', { task_id: id(), client_id: ctx.clientId, title: r.check, category: r.cat, status: 'Not started', owner: first(client.patient_first_name) || 'Family', due_date: null, notes: 'From the “' + r.label + '” restriction' + (from ? ' (until ' + new Date(from + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ')' : '') + '.', extra: JSON.stringify({ auto: 'restriction:' + r.key }) }, c); made.push(r.check); }
    }
  }
  // Taken back: a home check nobody has started goes away again.
  for (const r of RESTRICTIONS) { const v = out[r.key]; if (v && (v.status === 'ok' || v.status === 'ask')) await db.q(`delete from tasks where client_id=$1 and extra->>'auto'=$2 and status='Not started'`, [ctx.clientId, 'restriction:' + r.key], c); }
  await patchExtra(client, { restrictions: out }, c);
  return { restrictions: out, made };
}

// The red-flag card: the team's own list of "call now" signs, in the coordinator's hand, on the family's home.
async function setRedFlags(ctx, p, c) {
  coOnly(ctx); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { red_flags: clean(p.text, 2000), red_flags_who: clean(p.who, 300) }, c);
  return { ok: true };
}
// "The reason": one line the family writes about why this matters, at the top of the plan.
async function setReason(ctx, p, c) {
  famOrCo(ctx); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { reason: clean(p.text, 300) }, c);
  return { ok: true };
}

// The daily check-in: a face, a number for pain, and their own words. Short; every field optional. Two low days
// in a row, or a one, and the coordinator hears about it.
async function checkin(ctx, p, c) {
  must(core.fam(ctx), 'Only the family checks in'); needFamily(ctx);
  const mood = p.mood === undefined || p.mood === '' ? null : Math.max(1, Math.min(5, Number(p.mood) || 0)) || null;
  const pain = p.pain === undefined || p.pain === '' ? null : Math.max(0, Math.min(10, Number(p.pain)));
  const words = clean(p.words, 1500).trim();
  must(mood !== null || pain !== null || words, 'A face, a number, or a few words, any one is enough');
  const row = await db.insert('checkins', { checkin_id: id(), client_id: ctx.clientId, by: ctx.email, role: ctx.role, mood, pain, words, caregiver: ctx.role === 'family' }, c);
  const client = await core.clientById(ctx.clientId, c);
  const after = async () => {
    if (mood === null || mood > 2) return;
    const prev = await db.one(`select mood from checkins where client_id=$1 and checkin_id<>$2 and at > now() - interval '36 hours' order by at desc limit 1`, [ctx.clientId, row.checkin_id]);
    if (mood === 1 || (prev && prev.mood !== null && prev.mood <= 2)) {
      const co = await core.coordinatorFor(client);
      await core.notifyCo(co, mood === 1 ? 'urgent' : 'checkin', 'A hard day, ' + famName(client.family_name), (ctx.user.name || ctx.email) + ' checked in at ' + mood + ' of 5' + (pain !== null ? ', pain ' + pain + ' of 10' : '') + (prev ? ', the second low day in a row' : '') + '. A call today.', words, 'Open the chart');
    }
  };
  return { checkin: row, _after: after };
}

// Symptoms, one line each, for the report the family hands the doctor.
async function addSymptom(ctx, p, c) {
  famOrCo(ctx); needFamily(ctx);
  const name = clean(p.name, 120).trim(); must(name, 'What is it?');
  const severity = p.severity === undefined || p.severity === '' ? null : Math.max(0, Math.min(10, Number(p.severity)));
  if (p.at) { must(/^\d{4}-\d{2}-\d{2}$/.test(String(p.at)), 'Check the date.'); const t = Date.parse(String(p.at)); must(t <= Date.now() + 864e5 && t > Date.now() - 366 * 864e5, 'The date should be today or earlier.'); }
  const row = await db.insert('symptoms', { symptom_id: id(), client_id: ctx.clientId, by: ctx.email, name, severity, note: clean(p.note, 600), at: p.at && /^\d{4}-\d{2}-\d{2}$/.test(String(p.at)) ? new Date(require('../time').localToIso(String(p.at) + 'T12:00')) : new Date() }, c);   // a bare date means noon that day, family time
  return { symptom: row };
}
async function removeSymptom(ctx, p, c) {
  famOrCo(ctx); needFamily(ctx);
  await db.q(`delete from symptoms where client_id=$1 and symptom_id=$2`, [ctx.clientId, String(p.symptomId || '')], c);
  return { ok: true };
}

// "In case I can't update": the patient writes it ahead. Only the delegate or the coordinator can post it, and
// only as a Family update to the Circle; the patient can rewrite or clear it any time before then.
async function setIcant(ctx, p, c) {
  must(ctx.role === 'client', 'Only the patient writes this one'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { icant: clean(p.text, 3000).trim() ? { text: clean(p.text, 3000).trim(), at: new Date().toISOString() } : null }, c);
  return { ok: true };
}
async function postIcant(ctx, p, c) {
  needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const delegate = ctx.role === 'family' && ctx.user && ctx.user.extra && isTrue(ctx.user.extra.delegate);
  must(ctx.role === 'coordinator' || delegate, 'Only the delegate or the coordinator can post this');
  const m = extraOf(client).icant; must(m && m.text, 'Nothing was written ahead');
  const u = await db.insert('updates', { update_id: id(), client_id: ctx.clientId, posted_by: ctx.email, stage: client.current_stage || '', title: 'A note ' + (first(client.patient_first_name) || 'they') + ' wrote ahead of time', body: m.text, visible_to_circle: isTrue(client.circle_enabled), kind: 'Family', detail: '', quote: '', quote_ref: '' }, c);
  await patchExtra(client, { icant: null, icant_posted_at: new Date().toISOString() }, c);
  const after = async () => {
    if (!isTrue(client.circle_enabled)) return;
    for (const s of await db.all(`select supporter_email from circle where client_id=$1 and status='Active'`, [ctx.clientId]))
      await mail.notify(s.supporter_email, first(client.patient_first_name) + ' wrote this ahead of time', 'A note ' + (first(client.patient_first_name) || 'they') + ' wrote in case they could not write today.', m.text, 'Follow along');
  };
  return { update: u, _after: after };
}

// Disaster mode: what in the house runs on power or needs cold, the backup, where they would go. Power-dependent and not on
// the utility's medical priority list → one task, once.
const DZ = ['oxygen', 'cpap', 'fridge', 'pump', 'bed', 'charge'];
async function setDisaster(ctx, p, c) {
  must(core.fam(ctx), 'Only the family'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const items = (Array.isArray(p.items) ? p.items : []).map(String).filter(x => DZ.indexOf(x) >= 0);
  const dz = { items, backup: clean(p.backup, 300), shelter: clean(p.shelter, 300), utility: isTrue(p.utility), at: new Date().toISOString() };
  await patchExtra(client, { disaster: dz }, c);
  let made = false;
  if (items.length && !dz.utility) {
    const exists = await db.one(`select 1 from tasks where client_id=$1 and extra->>'auto'='disaster:utility' and status<>'Done'`, [ctx.clientId], c);
    if (!exists) { await db.insert('tasks', { task_id: id(), client_id: ctx.clientId, title: 'Register with the power company’s medical priority list', category: 'Care coordination', status: 'Not started', owner: first(client.patient_first_name) || 'Family', due_date: null, notes: 'Call the utility; ask for the medical baseline / priority restoration program. A doctor’s letter is usually needed, the coordinator can request it.', extra: JSON.stringify({ auto: 'disaster:utility' }) }, c); made = true; }
  }
  else await db.q(`delete from tasks where client_id=$1 and extra->>'auto'='disaster:utility' and status='Not started'`, [ctx.clientId], c);
  return { made };
}
module.exports = { setRestrictions, setRedFlags, setReason, checkin, addSymptom, removeSymptom, setIcant, postIcant, setDisaster };
Object.defineProperty(module.exports, 'RESTRICTIONS', { value: RESTRICTIONS, enumerable: false });
