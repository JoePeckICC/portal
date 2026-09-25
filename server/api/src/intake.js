'use strict';
// Intake — screener + consent, the flag register, plan seeding. Ported from Intake.gs.
const C = require('./config');
const db = require('./db');
const { DK_, DISCUSS_, INTAKE_STEPS_, intakeSpec } = require('./intakeSpec');
const { id, clean, first } = require('./util');

// { status, submitted_at, consent, answers: { id: { a, n, t } } }
async function readIntake(clientId, c) {
  const out = { status: 'Not started', submitted_at: '', consent: null, changed: {}, answers: {} };
  (await db.all(`select * from intake_answers where client_id=$1`, [clientId], c)).forEach(r => {
    const q = String(r.question_id);
    if (q === '_status') out.status = String(r.answer || 'Not started');
    else if (q === '_submitted_at') out.submitted_at = r.answer;
    else if (q === '_consent') { try { out.consent = JSON.parse(r.answer); } catch { out.consent = null; } }
    else if (q === '_changed') { try { out.changed = JSON.parse(r.answer || '{}') || {}; } catch { out.changed = {}; } }
    else out.answers[q] = { a: plainAnswer(r.answer), n: r.note == null ? '' : String(r.note), t: r.updated_at };
  });
  return out;
}
const plainAnswer = v => { const s = v == null ? '' : String(v); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s) ? s.slice(0, 10) : s; };

// answers = { id: { a, n } }; upserts each row.
async function writeIntake(clientId, answers, by, c) {
  for (const qid of Object.keys(answers)) {
    const v = answers[qid] || {};
    await db.q(`insert into intake_answers (client_id,question_id,answer,note,updated_at,updated_by) values ($1,$2,$3,$4,now(),$5)
      on conflict (client_id,question_id) do update set answer=excluded.answer, note=excluded.note, updated_at=now(), updated_by=excluded.updated_by`,
      [clientId, String(qid).slice(0, 40), clean(v.a, 4000), clean(v.n, 4000), by], c);
  }
}

// A US phone number: 10 digits (a leading 1 is fine), a real area code, an optional extension. '' when it is not one.
function phoneOk(v) {
  const m = String(v || '').trim().match(/^([\s\S]*?)(?:\s*(?:ext\.?|extension|x)\s*#?\s*(\d{1,6}))?$/i);
  let d = (m ? m[1] : '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || /^[01]/.test(d) || /^[01]/.test(d.slice(3)) || /^(\d)\1{9}$/.test(d)) return '';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` + (m && m[2] ? ' ext. ' + m[2] : '');
}
// Initials that match the signed name: first + last, or every word (Sarah Marie Rivera -> SR or SMR). '' when fine.
function initialsProblem(list, name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (w.length < 2) return 'Please sign with your first and last name.';
  const all = w.map(x => x[0]).join('').toUpperCase(), fl = (w[0][0] + w[w.length - 1][0]).toUpperCase();
  for (const x of list) {
    const s = String(x || '').replace(/\./g, '').toUpperCase();
    if (!/^[A-Z]{2,4}$/.test(s) || (s !== all && s !== fl)) return `Initials should match the name you sign with. For ${w[0]} ${w[w.length - 1]}, that is ${fl}.`;
  }
  return '';
}
// One saved answer, tidied: the phone in one format, and a multi-choice never mixes "No", "None" or
// "I don't know" with real picks (the page prevents it; this covers anything else that calls the API).
const EXCLUSIVE_ = new Set(['No', 'None', DK_]);
function tidyAnswer(qid, v) {
  v = v && typeof v === 'object' ? { a: v.a, n: v.n } : { a: '', n: '' };
  const q = []; INTAKE_STEPS_.forEach(s => s.qs.forEach(x => { if (x.id === qid) q.push(x); }));
  if (!q.length) return v;
  if (qid === 'A.phone') { const p = phoneOk(v.a); if (p) v.a = p; }
  if (q[0].type === 'multi' && v.a) {
    const parts = String(v.a).split('; ').filter(Boolean);
    if (parts.length > 1 && parts.some(p => EXCLUSIVE_.has(p))) v.a = parts.filter(p => !EXCLUSIVE_.has(p)).join('; ');
  }
  return v;
}

function visibleQs(answers) {
  const out = [];
  INTAKE_STEPS_.forEach(s => s.qs.forEach(q => {
    if (q.showIf) { const a = answers[q.showIf.id]; if (!a || q.showIf.is.indexOf(a.a) < 0) return; }
    out.push(q);
  }));
  return out;
}
const missingRequired = answers => visibleQs(answers).filter(q => q.req && !(answers[q.id] && String(answers[q.id].a).trim())).map(q => q.id)
  .concat(answers['A.phone'] && String(answers['A.phone'].a).trim() && !phoneOk(answers['A.phone'].a) ? ['A.phone (not a working number)'] : []);
const ans = (answers, qid) => (answers[qid] ? String(answers[qid].a || '') : '');
const has = (answers, qid, v) => ans(answers, qid).split('; ').indexOf(v) >= 0;
const isPatient = answers => /person having surgery/.test(ans(answers, '0.1'));

// ---- flag register (family never sees these)
const T1 = 'Tier 1 — could derail the surgery or discharge', T2 = "Tier 2 — conflicts the family hasn't connected", T3 = 'Tier 3 — slow-burn, name them to show foresight';
const FLAG_RULES = [
  { tier: T1, label: 'No named escort home', id: 'L.1', test: a => !ans(a, 'L.1') || /haven't sorted/.test(ans(a, 'L.1')) },
  { tier: T1, label: 'Lives alone, no overnight person', id: 'A.2', test: a => ans(a, 'A.2') === 'Lives alone' && ans(a, 'A.2a').indexOf('Yes') !== 0 },
  { tier: T1, label: 'Lives alone — high priority', id: 'A.2', test: a => ans(a, 'A.2') === 'Lives alone' && ans(a, 'A.2a').indexOf('Yes') === 0 },
  { tier: T1, label: 'EMERGENCY PATH — surgery already happened or is happening', id: 'G.6', test: a => /emergency/.test(ans(a, 'G.6')) },
  { tier: T1, label: 'Home or rehab unknown — changes the whole plan', id: 'G.10', test: a => /Not sure|don't know/.test(ans(a, 'G.10')) },
  { tier: T2, label: 'Children at home during a multi-night stay', id: 'M.1', test: a => has(a, 'M.1', 'Yes') && /4–7|More than/.test(ans(a, 'G.9')) },
  { tier: T3, label: 'Surgery not scheduled yet', id: 'G.6', test: a => ans(a, 'G.6') === 'Not scheduled yet' },
  { tier: T3, label: 'No name for the surgery yet', id: 'G.4', test: a => /don't have a name/.test(ans(a, 'G.4')) },
  { tier: T3, label: 'Still waiting on the diagnosis', id: 'G.1', test: a => /waiting to find out/.test(ans(a, 'G.1')) },
  { tier: T3, label: 'Length of stay unknown', id: 'G.9', test: a => ans(a, 'G.9') === DK_ },
  { tier: T3, label: 'Pets to cover', id: 'M.4', test: a => ans(a, 'M.4') && ans(a, 'M.4') !== 'No' },
  { tier: 'Mode', label: 'Quick mode — the meeting does more work; present assumptions as assumptions', id: '0.1a', test: a => /^Quick/.test(ans(a, '0.1a')) },
  { tier: 'Mode', label: 'Thorough mode — accuracy over warmth; they will notice contradictions', id: '0.1a', test: a => /^Thorough/.test(ans(a, '0.1a')) },
];
function intakeFlags(answers) {
  const out = [];
  FLAG_RULES.forEach(r => { try { if (r.test(answers)) out.push({ tier: r.tier, label: r.label, id: r.id }); } catch {} });
  visibleQs(answers).forEach(q => {
    const a = ans(answers, q.id);
    if (a === DISCUSS_) out.push({ tier: 'Bring to the meeting', label: q.id + ' — asked to discuss in person. Never raise it unless they open it.', id: q.id });
    else if (a === DK_) out.push({ tier: 'Bring to the meeting', label: q.id + " — \"I don't know\"", id: q.id });
  });
  return out;
}

// ---- plan seeding: draft items the coordinator approves before the family sees them
function seedRules(a, client) {
  const name = first(client.patient_first_name) || 'the patient';
  const [CC, UA, FS] = C.CATEGORIES;
  const emergency = /emergency/.test(ans(a, 'G.6'));
  const stage = emergency ? 'The hospital stay' : 'Before surgery';
  const items = [];
  const add = (cat, item, detail) => items.push({ stage, category: cat, item, detail: detail || '' });
  const f1 = ans(a, 'F.1');
  if (f1) add(CC, 'First thing off your plate: “' + f1.slice(0, 120) + (f1.length > 120 ? '…' : '') + '”', 'The one thing the family asked for first. In their words.');
  if (!ans(a, 'L.1') || /haven't sorted/.test(ans(a, 'L.1'))) add(CC, 'Name the adult who drives ' + name + ' home', 'The hospital will not discharge to a taxi or rideshare on its own; they need a named adult. Usually the first thing we solve.');
  else add(CC, 'Confirm the ride home: ' + ans(a, 'L.1').slice(0, 80), 'Check the day and time once the report time is known.');
  if (ans(a, 'A.2') === 'Lives alone') {
    if (ans(a, 'A.2a').indexOf('Yes') === 0) add(FS, 'Confirm who stays the first night or two', ans(a, 'A.2ad'));
    else add(FS, 'Someone with ' + name + ' the first night or two', 'Lives alone. Most procedures require someone present for the first stretch.');
  }
  if (ans(a, 'G.6') === 'Not scheduled yet') add(CC, 'Surgery date — hold the plan until it is set', 'Nothing gets booked against a date that does not exist yet.');
  if (emergency) add(UA, 'Where things stand today', [ans(a, 'G.6a'), ans(a, 'G.6b')].filter(Boolean).join(' — '));
  if (/don't have a name/.test(ans(a, 'G.4'))) add(UA, "Get the surgery's name, and whether it is open or minimally invasive", 'The same operation done two ways can mean one night in the hospital or five.');
  if (/waiting to find out/.test(ans(a, 'G.1'))) add(UA, 'Waiting on the diagnosis — check in after the next appointment');
  if (/Not sure|don't know/.test(ans(a, 'G.10'))) add(UA, 'Find out: straight home, or rehab first', "Changes the whole plan. Ask the surgeon's office or the discharge planner.");
  if (/rehab/.test(ans(a, 'G.10'))) add(CC, 'Rehab facility: which one, how far, and a visiting plan');
  if (/4–7|More than/.test(ans(a, 'G.9'))) add(FS, 'Household coverage while ' + name + ' is in the hospital', 'Several days where the house runs without them.');
  if (has(a, 'M.1', 'Yes')) add(FS, 'Childcare for surgery week', ans(a, 'M.1d') ? 'Ages: ' + ans(a, 'M.1d') : '');
  if (ans(a, 'M.4') && ans(a, 'M.4') !== 'No') add(FS, 'Pet care for the hospital days', ans(a, 'M.4') + (ans(a, 'M.4d') ? ' — ' + ans(a, 'M.4d') : ''));
  add(CC, 'Intake meeting', 'Go through the flags, the notes, and anything marked "I don\'t know."');
  return items;
}
async function seedPlan(clientId, answers, client, by, c) {
  const existing = (await db.all(`select item from plan_items where client_id=$1`, [clientId], c)).map(p => String(p.item));
  let made = 0;
  for (const it of seedRules(answers, client)) {
    if (existing.indexOf(it.item) >= 0) continue;
    await db.insert('plan_items', { plan_id: id(), client_id: clientId, stage: it.stage, category: it.category, item: it.item, detail: it.detail, owner: 'Coordinator', status: 'Not started', draft: true }, c);
    made++;
  }
  const d = ans(answers, 'G.6');
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) await db.q(`update clients set surgery_date=$2 where client_id=$1`, [clientId, d], c);
  return made;
}

module.exports = { intakeSpec, readIntake, writeIntake, visibleQs, missingRequired, phoneOk, initialsProblem, tidyAnswer, ans, has, isPatient, intakeFlags, seedPlan, DK_, DISCUSS_ };
