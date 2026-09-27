'use strict';
// Intake — screener + consent, the flag register, plan seeding. Ported from Intake.gs.
const C = require('./config');
const db = require('./db');
const { DK_, DISCUSS_, INTAKE_STEPS_, intakeSpec } = require('./intakeSpec');
const { id, clean, first } = require('./util');

// { status, submitted_at, consent, answers: { id: { a, n, t } } }
async function readIntake(clientId, c) {
  const out = { status: 'Not started', submitted_at: '', consent: null, changed: {}, full: false, answers: {} };
  (await db.all(`select * from intake_answers where client_id=$1`, [clientId], c)).forEach(r => {
    const q = String(r.question_id);
    if (q === '_status') out.status = String(r.answer || 'Not started');
    else if (q === '_submitted_at') out.submitted_at = r.answer;
    else if (q === '_consent') { try { out.consent = JSON.parse(r.answer); } catch { out.consent = null; } }
    else if (q === '_changed') { try { out.changed = JSON.parse(r.answer || '{}') || {}; } catch { out.changed = {}; } }
    else if (q === '_full') { out.full = String(r.answer || '') === 'yes'; out.answers._full = { a: out.full ? 'yes' : '', n: '', t: r.updated_at }; }   // emergency family chose to circle back for the rest
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

const ans = (answers, qid) => (answers[qid] ? String(answers[qid].a || '') : '');
const has = (answers, qid, v) => ans(answers, qid).split('; ').indexOf(v) >= 0;
// The emergency path: surgery already happened (or is happening) and the family has not chosen to answer the
// rest yet. Only the questions marked em are asked; everything else waits until they circle back.
const emergencyPath = answers => /emergency/.test(ans(answers, 'G.6')) && !(answers._full && String(answers._full.a) === 'yes');
function showIfOk(q, answers) {
  if (!q.showIf) return true;
  const a = answers[q.showIf.id]; if (!a) return false;
  const parts = String(a.a || '').split('; ');
  if (q.showIf.any) return q.showIf.any.some(v => parts.indexOf(v) >= 0);
  return q.showIf.is.indexOf(String(a.a || '')) >= 0;
}
function visibleQs(answers) {
  const out = [], em = emergencyPath(answers);
  INTAKE_STEPS_.forEach(s => s.qs.forEach(q => {
    if (em && !q.em) return;
    if (!showIfOk(q, answers)) return;
    out.push(q);
  }));
  return out;
}
const missingRequired = answers => visibleQs(answers).filter(q => q.req && !(answers[q.id] && String(answers[q.id].a).trim())).map(q => q.id)
  .concat(answers['A.phone'] && String(answers['A.phone'].a).trim() && !phoneOk(answers['A.phone'].a) ? ['A.phone (not a working number)'] : []);

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
  { tier: T2, label: 'No backup caregiver named', id: 'A.4', test: a => !ans(a, 'A.4') || /isn't one/.test(ans(a, 'A.4')) },
  { tier: T2, label: "The patient doesn't fully know the family is doing this", id: 'A.5', test: a => /Not yet|Partly/.test(ans(a, 'A.5')) },
  { tier: T2, label: 'Licensed job — return to work may need its own medical sign-off', id: 'W.2', test: a => ans(a, 'W.2') === 'Yes' },
  { tier: T3, label: 'Employer not told yet — leave paperwork clock has not started', id: 'W.1', test: a => ans(a, 'W.1') === 'Not yet' },
  { tier: T3, label: 'Self-employed — income stops when they stop', id: 'W.1', test: a => ans(a, 'W.1') === 'Self-employed' },
  { tier: T3, label: 'Pharmacy weekend hours unknown', id: 'L.2', test: a => !ans(a, 'L.2') || ans(a, 'L.2') === DK_ },
  { tier: T3, label: 'Faith community would help but the family would rather not ask — respect it', id: 'S.2', test: a => /rather not ask/.test(ans(a, 'S.2')) },
  { tier: T3, label: 'Things the patient wants to keep doing themselves', id: 'P.1', test: a => !!ans(a, 'P.1') },
  { tier: T3, label: "Off limits — things they'd rather we didn't touch", id: 'P.2', test: a => !!ans(a, 'P.2') },
  { tier: 'Mode', label: 'EMERGENCY PATH — short form only; they can circle back for the rest', id: 'G.6', test: a => emergencyPath(a) },
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
  const stage = emergency ? 'ICU' : 'The countdown';
  const items = [];
  const add = (cat, item, detail) => items.push({ stage, category: cat, item, detail: detail || '' });
  const f1 = ans(a, 'F.1');
  if (f1) add(CC, 'First thing off your plate: “' + f1.slice(0, 120) + (f1.length > 120 ? '…' : '') + '”', 'The one thing the family asked for first. In their words.');
  if (ans(a, 'L.4') && !/Won't need/.test(ans(a, 'L.4'))) add(CC, 'Find a place to stay near the hospital — ' + ans(a, 'L.4').toLowerCase(), 'Hospital family housing first (many have it and never mention it), then Ronald McDonald-type houses if they qualify, then the hotels with medical rates. ' + (ans(a, 'L.4d') || ''));
  if (!ans(a, 'L.1') || /haven't sorted/.test(ans(a, 'L.1'))) add(CC, 'Name the adult who drives ' + name + ' home', 'The hospital will not discharge to a taxi or rideshare on its own; they need a named adult. Usually the first thing we solve.');
  else add(CC, 'Confirm the ride home: ' + ans(a, 'L.1').slice(0, 80), 'Check the day and time once the report time is known.' + (a['L.1'] && a['L.1'].n ? ' They added: “' + String(a['L.1'].n).slice(0, 200) + '”' : ''));
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
  if (ans(a, 'A.3')) add(CC, 'Confirm the one contact for the surgical team: ' + ans(a, 'A.3').slice(0, 80), 'Give the hospital one name and number so messages never cross.');
  if (!ans(a, 'A.4') || /isn't one/.test(ans(a, 'A.4'))) add(FS, 'Name a backup caregiver', 'Who steps in if the main caregiver gets sick or hits a wall. Decide it while it is easy.');
  if (/Yes, please/.test(ans(a, 'S.1'))) add(FS, 'Arrange a prayer, blessing or clergy visit before surgery', ans(a, 'S.1d') || 'Ask who they would like, and whether at home or at the hospital.');
  if (/welcome it/.test(ans(a, 'S.2'))) add(FS, 'Coordinate meals and visits with their faith community', 'They said they would welcome the help. One point of contact there.');
  if (/Yes, please/.test(ans(a, 'G.12'))) add(UA, 'Check the ride benefit (Medicaid) or travel pay (VA)', 'A free win. Confirm what is covered and how to book it before the first appointment.');
  if (!ans(a, 'L.2') || ans(a, 'L.2') === DK_) add(UA, 'Find the pharmacy and its weekend hours', 'A Friday discharge and a pharmacy closed Saturday is a scramble we can head off.');
  else add(UA, 'Confirm pharmacy weekend hours: ' + ans(a, 'L.2').slice(0, 80), 'Check delivery too.');
  if (ans(a, 'L.3') && !/None of these/.test(ans(a, 'L.3')) ) add(UA, 'Equipment already at home: ' + ans(a, 'L.3'), 'Check what the team wants on top of this (walker, shower chair, raised seat) and whether doorways are wide enough for a walker (about 30 inches).');
  else add(UA, 'Equipment for coming home', 'Ask the team what they want: walker, shower chair, raised toilet seat. Rent, buy, insurance, or a closet down the street. Doorways need about 30 inches for a walker.');
  if (ans(a, 'W.1') === 'Not yet') add(UA, 'Tell the employer and start leave paperwork', 'FMLA needs 50+ employees within 75 miles, a year worked, and about 1,250 hours. We prepare the request; the family sends it.');
  if (ans(a, 'W.1') === 'Yes') add(UA, 'Leave paperwork: FMLA, disability, or a letter', 'We prepare it; they send it.');
  if (ans(a, 'W.1') === 'Self-employed') add(UA, 'Plan around lost income', 'Self-employed. Build the schedule around their work hours; look at short-term disability and any financial assistance.');
  if (ans(a, 'W.2') === 'Yes') add(UA, 'Return-to-work medical sign-off: ' + (ans(a, 'W.2d') || 'licensed job'), 'Licensed jobs usually need their own recertification. Start early.');
  if (ans(a, 'P.1')) add(CC, 'Keep for the patient: ' + ans(a, 'P.1').slice(0, 100), 'Things they are adamant about doing themselves. Do not take these over.');
  if (ans(a, 'P.2')) add(CC, 'Off limits: ' + ans(a, 'P.2').slice(0, 100), "Things they'd rather we didn't touch.");
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

module.exports = { intakeSpec, readIntake, writeIntake, visibleQs, emergencyPath, missingRequired, phoneOk, initialsProblem, tidyAnswer, ans, has, isPatient, intakeFlags, seedPlan, DK_, DISCUSS_ };
