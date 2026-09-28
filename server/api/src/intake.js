'use strict';
// Intake — consent, which questions show (conditions, modes, depth, the emergency path), the flag register, plan seeding.
const C = require('./config');
const db = require('./db');
const { DK_, DISCUSS_, RNS_, EMERGENCY_, INTAKE_STEPS_, SVC_BY_TEXT, SVC_TEXT, DEPTH_OPTS, JUST_HANDLE, DEPTH_AREAS, intakeSpec } = require('./intakeSpec');
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
const EXCLUSIVE_ = new Set(['No', 'None', 'None of these', 'None that we know of', 'Nothing we know of', 'Nothing unusual', 'No license needed', 'No preferences', DK_]);
const Q_BY_ID = {}; INTAKE_STEPS_.forEach(s => s.qs.forEach(x => { Q_BY_ID[x.id] = x; }));
function tidyAnswer(qid, v) {
  v = v && typeof v === 'object' ? { a: v.a, n: v.n } : { a: '', n: '' };
  const q = Q_BY_ID[qid];
  if (!q) return v;
  if (qid === 'A.phone') { const p = phoneOk(v.a); if (p) v.a = p; }
  if (q.type === 'multi' && v.a) {
    let parts = String(v.a).split('; ').filter(Boolean);
    if (parts.length > 1 && parts.some(p => EXCLUSIVE_.has(p))) parts = parts.filter(p => !EXCLUSIVE_.has(p));
    if (q.max) parts = parts.slice(0, q.max);
    v.a = parts.join('; ');
  }
  return v;
}

const ans = (answers, qid) => (answers[qid] ? String(answers[qid].a || '') : '');
// A typed answer on one line, for titles and short lines: line breaks become sentence breaks.
const flat = t => String(t || '').replace(/([^.!?;:,\s])[ \t]*\n+\s*/g, '$1. ').replace(/\s*\n+\s*/g, ' ').trim();
const has = (answers, qid, v) => ans(answers, qid).split('; ').indexOf(v) >= 0;
// Where a question's extra box is saved: the detail under an option (qid_d, or qid_d.k when it has several
// boxes) and the boxes of a fields question (qid.k, with every box joined into qid as well).
const detailId = (qid, k) => qid + '_d' + (k ? '.' + k : '');
const det = (answers, qid) => ans(answers, detailId(qid)) || Object.keys(answers).filter(k => k.indexOf(qid + '_d.') === 0).map(k => ans(answers, k)).filter(Boolean).join(', ');

// The emergency path: surgery already happened (or is happening) and the family has not chosen to answer the
// rest yet. Only the questions marked em are asked; everything else waits until they circle back.
const emergencyPath = answers => ans(answers, 'G.6') === EMERGENCY_ && !(answers._full && String(answers._full.a) === 'yes');
const roleOf = a => { const w = ans(a, '0.1'); return /person having surgery/.test(w) ? 'patient' : /together/.test(w) ? 'together' : w ? 'family' : ''; };
// The mode from 0.1a. Blank is "decide as I go", the form's default.
const modeOf = a => { const m = ans(a, '0.1a'); return /^Quick/.test(m) ? 'quick' : /^Thorough/.test(m) ? 'thorough' : 'decide'; };
const servicesOf = a => ans(a, 'F').split('; ').map(t => SVC_BY_TEXT[t]).filter(Boolean);
// Children's ages from the box under M.1 "Yes": every number in it ("4 and 7", "18 months" counts as 1).
const agesOf = a => { const t = ans(a, detailId('M.1')); const out = []; String(t).replace(/(\d+(?:\.\d+)?)\s*(months?|mos?|weeks?|wks?)?/gi, (m, n, u) => { out.push(u ? Math.floor(Number(n) / (/^w/i.test(u) ? 52 : 12)) : Number(n)); return m; }); return out; };

// One condition (see intakeSpec.js). shown: the ids already shown, so an answer to a question that has since been
// hidden never opens anything.
function cond(c, a, shown) {
  if (!c) return true;
  const val = id => (shown && !shown.has(id) ? '' : ans(a, id));
  if (c.all) return c.all.every(x => cond(x, a, shown));
  if (c.any) return c.any.some(x => cond(x, a, shown));
  if (c.not) return !cond(c.not, a, shown);
  if (c.role) return c.role.indexOf(roleOf(a)) >= 0;
  if (c.mode) return c.mode.indexOf(modeOf(a)) >= 0;
  if (c.svc) { const s = servicesOf(a); return c.svc.some(k => s.indexOf(k) >= 0); }
  if (c.ages) return val('M.1') === 'Yes' && agesOf(a).some(n => n >= c.ages[0] && n <= c.ages[1]);
  if (c.differentFloors) { const b = val('K.3'), t = val('K.3x'); return !!b && !!t && b !== t; }
  if (c.lodgingNeeded) {
    if (servicesOf(a).indexOf('lodging') < 0) return false;
    const l5 = val('L.5'), far = /More than 2|Out of state/.test(val('L.4'));
    return l5 === "No, we'd like help" || (far && !/close enough|already arranged/.test(l5));
  }
  if (c.q) {
    const v = val(c.q);
    if (c.filled) return !!v.trim();
    if (c.startsWith) return v.indexOf(c.startsWith) === 0;
    if (c.has) { const parts = v.split('; '); return c.has.some(x => parts.indexOf(x) >= 0); }
    if (c.is) return c.is.indexOf(v) >= 0;
  }
  return true;
}
// Which steps and questions show, in order. Quick mode keeps Tier 1 and 2 (req, quick, tier 2) and drops the
// precision questions and the standards layer; "Just handle it" on a service drops that service's precision
// questions; "Ask me more about this" (Z.<step> = yes) opens a step fully again.
function walk(answers) {
  const em = emergencyPath(answers), shown = new Set(), steps = [];
  INTAKE_STEPS_.forEach(st => {
    if (!cond(st.when, answers, shown)) return;
    const more = ans(answers, 'Z.' + st.id) === 'yes', mode = more ? 'thorough' : modeOf(answers);
    const lean = (mode === 'quick' && st.standards) || (em && !st.qs.some(q => q.em));
    const qs = [];
    st.qs.forEach(q => {
      if (em && !q.em) return;
      if (mode === 'quick' && (q.detail || st.standards || !(q.req || q.quick || q.tier === 2))) return;
      if (q.detail && q.area && mode === 'decide' && ans(answers, 'F.d.' + q.area) === JUST_HANDLE) return;
      if (!cond(q.when, answers, shown)) return;
      shown.add(q.id); qs.push(q);
    });
    steps.push({ id: st.id, qs, skipped: lean || qs.length < st.qs.length });
  });
  return { steps, shown };
}
const visibleQs = answers => [].concat(...walk(answers).steps.map(s => s.qs));
const blank = (answers, q) => !(answers[q.id] && String(answers[q.id].a).trim());
const missingRequired = answers => visibleQs(answers).filter(q => q.req && blank(answers, q)).map(q => q.id)
  .concat(answers['A.phone'] && String(answers['A.phone'].a).trim() && !phoneOk(answers['A.phone'].a) ? ['A.phone (not a working number)'] : []);
// Only what the family can see counts: an answer to a question that has since been hidden is left out.
function visibleAnswers(answers) {
  const { shown } = walk(answers), out = {};
  Object.keys(answers).forEach(k => { const base = k.replace(/_d(\..*)?$/, '').replace(/\.[a-z]+$/, ''); if (shown.has(k) || shown.has(base) || /^(_|Z\.)/.test(k)) out[k] = answers[k]; });
  return out;
}

const isPatient = answers => roleOf(answers) === 'patient';

// ---- flag register (family never sees these). The appendix of the master intake form, tier by tier.
const T1 = 'Tier 1 — could derail the surgery or discharge', T1b = 'Tier 1b — could cancel the surgery on the day', T1c = 'Tier 1c — anesthesia history affecting the day',
  T2 = "Tier 2 — conflicts the family hasn't connected", T3 = 'Tier 3 — slow-burn, name them to show foresight', T4 = 'Tier 4 — respect and standards, quiet failures if missed',
  T5 = 'Tier 5 — income and licensing, the expensive surprises';
const any_ = (a, id, ...v) => v.some(x => has(a, id, x));
const LIFT = a => any_(a, 'I.3', 'No bending, lifting, or twisting') || /^Yes/.test(ans(a, 'I.1'));
const BEND = a => any_(a, 'I.3', 'No bending, lifting, or twisting', 'No nose-blowing, no straws, no bending over');
const MOBILITY = a => any_(a, 'I.3', 'No bending, lifting, or twisting', 'Dizziness or balance problems expected', 'Will wear a brace, collar, or helmet', 'Weakness in an arm or leg')
  || /cane or walker|wheelchair|bathing or dressing/.test(ans(a, 'I.4')) || /one person|two people/.test(ans(a, 'I.5'));
const weeks = t => { const m = /(\d+(?:\.\d+)?)\s*(day|week|wk|month|mo)/i.exec(String(t || '')); if (!m) return 0; const n = Number(m[1]); return /^d/i.test(m[2]) ? n / 7 : /^m/i.test(m[2]) ? n * 4.3 : n; };
const filledNot = (a, id, ...skip) => !!ans(a, id).trim() && skip.indexOf(ans(a, id)) < 0;
const FLAG_RULES = [
  // Tier 1
  { tier: T1, label: 'No named escort home', id: 'L.1', test: a => !ans(a, 'L.1') || /haven't sorted/.test(ans(a, 'L.1')) },
  { tier: T1, label: 'Lives alone, no overnight person', id: 'A.2a', test: a => ans(a, 'A.2') === 'Lives alone' && !/^Yes/.test(ans(a, 'A.2a')) },
  { tier: T1, label: 'Same-day or one-night stay with no named adult picking them up', id: 'G.9a', test: a => /same day|One night/.test(ans(a, 'G.9')) && !/Someone named/.test(ans(a, 'G.9a')) },
  { tier: T1, label: 'Steps at every entrance — check whether a ramp is even possible', id: 'K.1', test: a => ans(a, 'K.1') === 'Yes' && ans(a, 'K.1c') !== 'Right at the step' },
  { tier: T1, label: 'Steps at every entrance and the door opens right at the step — a ramp is unlikely', id: 'K.1', test: a => ans(a, 'K.1') === 'Yes' && ans(a, 'K.1c') === 'Right at the step' },
  { tier: T1, label: 'No bath on the sleeping floor, with a mobility restriction', id: 'K.3e', test: a => ans(a, 'K.3e') === 'None' && MOBILITY(a) },
  { tier: T1, label: 'No backup caregiver named (someone to step in if the main one cannot) — single point of failure on the whole plan', id: 'C.2c', test: a => !!ans(a, 'C.2c') && !/^Someone$/.test(ans(a, 'C.2c')) },
  { tier: T1, label: "Advance directive exists but the hospital may not have it — fast, easy, ours to fix", id: 'C.3a', test: a => /^(No|Not sure)$/.test(ans(a, 'C.3a')) },
  { tier: T1, label: 'Home or rehab unknown — changes the whole plan', id: 'G.10', test: a => /Not sure|don't know/.test(ans(a, 'G.10')) },
  { tier: T1, label: 'EMERGENCY PATH — surgery already happened or is happening', id: 'G.6', test: a => ans(a, 'G.6') === EMERGENCY_ },
  // Tier 1b
  { tier: T1b, label: 'Fasting times unknown or not remembered — the most common same-day cancellation', id: 'H2.1', test: a => /don't remember|Not yet|don't know/.test(ans(a, 'H2.1')) },
  { tier: T1b, label: "The household doesn't all know the fasting times", id: 'H2.2', test: a => /Not really|reminders/.test(ans(a, 'H2.2')) },
  { tier: T1b, label: 'Medication stop date unclear', id: 'H2.3', test: a => /not clear|don't know/.test(ans(a, 'H2.3')) },
  { tier: T1b, label: 'Pre-op tests not all done — ours to chase', id: 'H2.6', test: a => /Some done|None yet|Not sure/.test(ans(a, 'H2.6')) },
  { tier: T1b, label: 'Pre-op results never confirmed back and cleared — ours to chase', id: 'H2.7', test: a => /^No$|Hadn't thought/.test(ans(a, 'H2.7')) },
  { tier: T1b, label: 'Insurance authorization not confirmed', id: 'H2.8', test: a => /waiting|Don't know/.test(ans(a, 'H2.8')) },
  { tier: T1b, label: 'Someone in the household is unwell right now', id: 'H2.10', test: a => /^Yes|getting over/.test(ans(a, 'H2.10')) },
  { tier: T1b, label: 'Dental work, an infection, or an open wound brewing', id: 'H2.11', test: a => any_(a, 'H2.11', 'Dental work or a tooth problem', 'A skin infection, rash, or open wound', 'An infection being treated', 'Something else') },
  { tier: T1b, label: 'Report time and surgery time not both known — families routinely arrive late', id: 'H2.15', test: a => /one time but not|Not yet/.test(ans(a, 'H2.15')) },
  { tier: T1b, label: "Jewelry or piercings that don't come out", id: 'H2.18', test: a => any_(a, 'H2.18', "Jewelry or piercings that don't come out easily") },
  { tier: T1b, label: 'Interpreter needed and possibly not booked', id: 'H2.19', test: a => /don't know if one's booked/.test(ans(a, 'H2.19')) },
  { tier: T1b, label: 'Nobody able to stay through the surgery', id: 'H2.20', test: a => ans(a, 'H2.20') === 'Nobody can stay' },
  // Tier 1c
  { tier: T1c, label: 'Prior nausea, slow waking, or agitation — plan a longer day and the right person at the bedside', id: 'H2.12a', test: a => any_(a, 'H2.12a', 'Nausea or vomiting afterward', 'Took a long time to wake up', 'Confused or agitated on waking') },
  { tier: T1c, label: "Family history of a serious anesthesia reaction — confirm they've told the anesthesia team", id: 'H2.14', test: a => ans(a, 'H2.14') === 'Yes' },
  // Tier 2
  { tier: T2, label: 'LIFTING CONFLICT — lifting restriction and a child under 5', id: 'I.3', test: a => LIFT(a) && ans(a, 'M.1') === 'Yes' && agesOf(a).some(n => n < 5) },
  { tier: T2, label: 'BENDING CONFLICT — bending restriction and a cat litter box', id: 'I.3', test: a => BEND(a) && has(a, 'M.4', 'Cat') },
  { tier: T2, label: 'Balance problems and daily stairs', id: 'I.3d', test: a => has(a, 'I.3', 'Dizziness or balance problems expected') && (ans(a, 'I.3d') === 'Yes' || ans(a, 'K.2') === 'Two or more') },
  { tier: T2, label: 'Balance problems and a pet underfoot', id: 'I.3f', test: a => has(a, 'I.3', 'Dizziness or balance problems expected') && ans(a, 'I.3f') === 'Yes' },
  { tier: T2, label: 'STRANDED RISK — bedroom and bathroom on different floors, with a mobility restriction', id: 'K.3', test: a => cond({ differentFloors: true }, a) && MOBILITY(a) },
  { tier: T2, label: 'Big or jumpy dog and a lifting restriction', id: 'M.4a', test: a => (ans(a, 'M.4a') === 'Over 60 lb' || /Yes|Sometimes/.test(ans(a, 'M.4b'))) && LIFT(a) },
  { tier: T2, label: 'HEAVY CARE LOAD — brace for 10+ weeks and no second adult', id: 'I.3g', test: a => has(a, 'I.3', 'Will wear a brace, collar, or helmet') && weeks(ans(a, 'I.3g')) >= 10 && (ans(a, 'A.2') === 'Lives alone' || /haven't figured/.test(ans(a, 'C.2'))) },
  { tier: T2, label: 'Must sleep propped up, no recliner, bedroom upstairs', id: 'I.3t', test: a => has(a, 'I.3', 'Needs to sleep propped up, head elevated') && ans(a, 'I.3t') === 'No' && (ans(a, 'I.3u') === 'Upstairs' || ans(a, 'K.3') === 'Upstairs') },
  { tier: T2, label: 'Walker needed and narrow doorways', id: 'I.4b', test: a => /cane or walker|wheelchair/.test(ans(a, 'I.4')) && (ans(a, 'I.4b') === 'Yes' || has(a, 'K.6', 'Tight hallways or doorways')) },
  { tier: T2, label: 'Children at home during a multi-night stay', id: 'M.1', test: a => ans(a, 'M.1') === 'Yes' && /4–7|More than/.test(ans(a, 'G.9')) },
  { tier: T2, label: "The patient doesn't fully know the family is doing this", id: 'D.1', test: a => /unsure|Not yet/.test(ans(a, 'D.1')) || ans(a, '0.5') === 'Not yet' },
  // Tier 3
  { tier: T3, label: '4 or more doctors or facilities — each needs its own records release', id: 'G.11', test: a => ans(a, 'G.11') === '4 or more' },
  { tier: T3, label: 'Self-employed or gig caregiver with no real leave — income stops when they stop', id: 'N.2', test: a => /self-employed/.test(ans(a, 'N.2')) },
  { tier: T3, label: '8 or more medications, or a complex schedule', id: 'J.5', test: a => /8\+/.test(ans(a, 'J.5')) || any_(a, 'J.6', 'Doses at odd hours, including overnight', 'Something needs refrigeration', "An injection or something that isn't just a pill") },
  { tier: T3, label: 'Pharmacy closed weekends', id: 'J.4c', test: a => ans(a, 'J.4c') === 'No' },
  { tier: T3, label: 'No primary caregiver identified', id: 'C.2', test: a => /haven't figured/.test(ans(a, 'C.2')) },
  { tier: T3, label: 'No instruction sheets received', id: 'H.2', test: a => /Haven't received/.test(ans(a, 'H.2')) },
  { tier: T3, label: 'Help offered but unorganized — an easy win', id: 'O.3', test: a => /nothing's organized/.test(ans(a, 'O.3')) },
  { tier: T3, label: 'Medicaid ride benefit never used — a free win', id: 'E.0', test: a => /^No$|Didn't know/.test(ans(a, 'E.0')) },
  { tier: T3, label: 'VA travel reimbursement unused — a free win', id: 'E.0b', test: a => /haven't used|Never heard/.test(ans(a, 'E.0b')) },
  { tier: T3, label: 'VA Caregiver Support Program not in place — a free win', id: 'E.0c', test: a => /^No$|Never heard/.test(ans(a, 'E.0c')) },
  { tier: T3, label: 'Caregiver running on empty before surgery', id: 'P.1', test: a => ans(a, 'P.1') === 'Running on empty' },
  { tier: T3, label: 'A prior bad experience with the system', id: 'P.5', test: a => /didn't go well/.test(ans(a, 'P.5')) },
  { tier: T3, label: 'Cost is a significant worry', id: 'Q.4', test: a => /^Yes/.test(ans(a, 'Q.4')) },
  { tier: T3, label: 'Surgery already rescheduled more than once', id: 'G.6c', test: a => ans(a, 'G.6c') === 'Yes, more than once' },
  { tier: T3, label: "House access not thought about — will break on day one", id: 'K.8', test: a => /Haven't thought/.test(ans(a, 'K.8')) },
  { tier: T3, label: 'Surgery not scheduled yet', id: 'G.6', test: a => ans(a, 'G.6') === 'Not scheduled yet' },
  { tier: T3, label: 'No name for the surgery yet', id: 'G.4', test: a => /don't have a name/.test(ans(a, 'G.4')) },
  { tier: T3, label: 'Still waiting on the diagnosis', id: 'G.1', test: a => /waiting to find out/.test(ans(a, 'G.1')) },
  { tier: T3, label: 'Length of stay unknown', id: 'G.9', test: a => ans(a, 'G.9') === DK_ },
  // Tier 4
  { tier: T4, label: "Outside food can't come into the house — a meal train is off; plan catering or in-kitchen help", id: 'O2.2b', test: a => /^No/.test(ans(a, 'O2.2b')) || /^No/.test(ans(a, 'O2.2g')) },
  { tier: T4, label: 'Shabbat — food ready before sundown Friday', id: 'O2.2d', test: a => /^Yes|Somewhat/.test(ans(a, 'O2.2d')) },
  { tier: T4, label: 'Passover in the recovery window — start weeks early', id: 'O2.2e', test: a => ans(a, 'O2.2e') === 'Passover' },
  { tier: T4, label: 'Ramadan — meal timing shifts to pre-dawn and after sunset', id: 'O2.2i', test: a => ans(a, 'O2.2i') === 'Yes' },
  { tier: T4, label: 'Severe allergy — brief every provider in writing', id: 'O2.4a', test: a => /^Severe/.test(ans(a, 'O2.4a')) },
  { tier: T4, label: 'The cook is the patient', id: 'O2.7', test: a => /person having surgery/.test(ans(a, 'O2.7')) },
  { tier: T4, label: "“We'd rather not, honestly” about people in the home", id: 'O3.1', test: a => /rather not, honestly/.test(ans(a, 'O3.1')) },
  { tier: T4, label: "Something they'd rather we didn't touch — never override this", id: 'O3.15', test: a => !!ans(a, 'O3.15').trim() },
  { tier: T4, label: 'Something the patient is adamant about keeping', id: 'D.6', test: a => filledNot(a, 'D.6', 'Not that I know of') },
  { tier: T4, label: "Something the patient would rather we didn't discuss with family", id: '0.4', test: a => filledNot(a, '0.4', RNS_) },
  { tier: T4, label: "Someone not to contact, or something to keep private", id: 'O.11', test: a => filledNot(a, 'O.11', RNS_) },
  { tier: T4, label: 'Landlord permission needed for modifications', id: 'K.7b', test: a => /landlord/.test(ans(a, 'K.7b')) },
  { tier: T4, label: "“We'd rather not ask” the faith community — do not go around them", id: 'O.10a', test: a => /rather not ask/.test(ans(a, 'O.10a')) },
  { tier: T4, label: 'Something wanted before surgery (prayer, blessing, someone present) — easy to forget, matters enormously', id: 'O.10c', test: a => filledNot(a, 'O.10c', 'Nothing specific') },
  // Tier 5
  { tier: T5, label: 'Licensed job — medical certification is its own process, often months. Start early.', id: 'N.1b', test: a => !!ans(a, 'N.1b') && !/^No license needed$/.test(ans(a, 'N.1b')) },
  { tier: T5, label: 'Physical job and a lifting restriction — return to work is far out', id: 'N.1', test: a => /physical|mixed/.test(ans(a, 'N.1')) && LIFT(a) },
  { tier: T5, label: 'Employer not told yet, with an absence coming', id: 'N.1c', test: a => ans(a, 'N.1c') === 'Not yet' },
  { tier: T5, label: "Someone in the family with relevant expertise — don't duplicate what they've done", id: 'N.2b', test: a => ans(a, 'N.2b') === 'Yes' },
  // How they chose to fill it out
  { tier: 'Mode', label: 'EMERGENCY PATH — short form only; they can circle back for the rest', id: 'G.6', test: a => emergencyPath(a) },
  { tier: 'Mode', label: 'Quick mode — a delegating family, not a lesser file. The meeting does more work; present assumptions as assumptions.', id: '0.1a', test: a => modeOf(a) === 'quick' && !!ans(a, '0.1a') },
  { tier: 'Mode', label: 'Thorough mode — accuracy over warmth; they will notice if the plan contradicts what they said', id: '0.1a', test: a => modeOf(a) === 'thorough' },
];
// Every place the family wrote something (answers and notes), as { id, text }.
function writtenBits(all) {
  const out = [];
  Object.keys(all || {}).forEach(k => { if (k[0] === '_') return; const v = all[k] || {}; [v.a, v.n].forEach(t => { t = String(t || '').trim(); if (t.length >= 3) out.push({ id: k.split('_')[0], text: t }); }); });
  return out;
}
const snip = (t, i, n = 160) => { const s = Math.max(0, i - 60); return (s ? '…' : '') + t.slice(s, s + n).replace(/\s+/g, ' ').trim() + (s + n < t.length ? '…' : ''); };
// Allergies the family mentioned anywhere (the form has no allergy question; people write them in notes).
function allergyMentions(all) {
  const seen = new Set(), out = [];
  writtenBits(all).forEach(b => { const m = /allerg|anaphyla|epi-?pen/i.exec(b.text); if (!m || b.text === 'Food allergies' || /^Food allergies(; |$)/.test(b.text)) return; const t = snip(b.text, m.index); if (!seen.has(t)) { seen.add(t); out.push({ id: b.id, text: t }); } });
  return out.slice(0, 6);
}
// Medical questions in their own words: we pass these to the care team, we never answer them.
const MED_Q = /\b(should (i|we|he|she|they) (stop|start|take|keep|skip)|is (that|it|this) (bad|normal|safe|okay|ok|serious|dangerous)|(might|may|have to|need to) (cancel|postpone)|stop (taking )?(my |his |her |their )?(metformin|insulin|aspirin|blood thinner|eliquis|warfarin|plavix|meds|medication)|how (long|much) (will|should) (it|the) (hurt|bleed|swell)|what (dose|should (i|we) take))/i;
function medicalQuestions(all) {
  const out = [];
  writtenBits(all).forEach(b => { const m = MED_Q.exec(b.text); if (m) out.push({ id: b.id, text: snip(b.text, m.index) }); });
  return out.slice(0, 6);
}
function intakeFlags(all) {
  const answers = visibleAnswers(all), out = [];
  allergyMentions(all).forEach(x => out.push({ tier: 'Tier 1 — could derail the surgery or discharge', label: 'Allergy mentioned — make sure it is on the chart: “' + x.text + '”', id: x.id }));
  medicalQuestions(all).forEach(x => out.push({ tier: 'Tier 1 — could derail the surgery or discharge', label: 'Medical question in their words — pass it to the surgeon’s office, do not answer it: “' + x.text + '”', id: x.id }));
  // Filled in on an older version of the form: the answers the current form needs are listed, so nothing is assumed.
  const sent = /Submitted|Updated after submitting/.test(String((all._status && all._status.a) || '')); const miss = sent ? missingRequired(all) : []; if (miss.length) out.push({ tier: 'Tier 1 — could derail the surgery or discharge', label: 'Required answers still blank (the form changed after they filled it in): ' + miss.join(', '), id: miss[0].split(' ')[0] });
  FLAG_RULES.forEach(r => { try { if (r.test(answers)) out.push({ tier: r.tier, label: r.label, id: r.id }); } catch {} });
  // Decide-as-I-go: the areas they went deep on are their priorities (better signal than O3.14).
  if (modeOf(answers) === 'decide') {
    const deep = DEPTH_AREAS.filter(k => ans(answers, 'F.d.' + k) === DEPTH_OPTS[0]).map(k => SVC_TEXT[k].split(/ — |,/)[0].toLowerCase());
    const handed = DEPTH_AREAS.filter(k => ans(answers, 'F.d.' + k) === JUST_HANDLE).map(k => SVC_TEXT[k].split(/ — |,/)[0].toLowerCase());
    if (deep.length) out.push({ tier: 'Mode', label: 'Went deep on: ' + deep.join(', ') + ' — their priorities', id: 'F' });
    if (handed.length) out.push({ tier: 'Mode', label: 'Handed over: ' + handed.join(', ') + ' — plan on judgment, then confirm', id: 'F' });
  }
  visibleQs(answers).forEach(q => {
    const a = ans(answers, q.id);
    if (a === DISCUSS_ || a === 'Rather discuss in person') out.push({ tier: 'Bring to the meeting', label: q.id + ' — asked to discuss in person.', id: q.id });
    else if (a === DK_) out.push({ tier: 'Bring to the meeting', label: q.id + " — \"I don't know\"" + (answers[q.id].n ? ' (they added a note)' : ''), id: q.id });
    else if (a === RNS_) out.push({ tier: 'Declined', label: q.id + ' — declined. Information, not a gap: never raise it unless they open it.', id: q.id });
  });
  return out;
}

// ---- plan seeding: draft items the coordinator approves before the family sees them
function seedRules(all, client) {
  const a = visibleAnswers(all);
  const name = first(client.patient_first_name) || 'the patient';
  const [CC, UA, FS] = C.CATEGORIES;
  const emergency = ans(a, 'G.6') === EMERGENCY_;
  const stage = emergency ? 'ICU' : 'The countdown';
  const items = [];
  const add = (cat, item, detail) => items.push({ stage, category: cat, item, detail: detail || '' });
  const said = id => (a[id] && a[id].n ? ' They added: “' + String(a[id].n).slice(0, 200) + '”' : '');
  const svc = servicesOf(a), wants = k => svc.indexOf(k) >= 0;
  const f1 = flat(ans(a, 'F.1'));
  if (f1) add(CC, 'First thing off your plate: “' + (f1.length > 140 ? f1.slice(0, 140).replace(/\s+\S*$/, '') + '…' : f1) + '”', 'The one thing the family asked for first. In their words.');
  if (cond({ lodgingNeeded: true }, a)) add(CC, 'Find a place to stay near the hospital', 'Hospital family housing first (many have it and never mention it), then Ronald McDonald-type houses if they qualify, then the hotels with medical rates.' + [ans(a, 'L.5a') && ' Nights: ' + ans(a, 'L.5a') + '.', ans(a, 'L.5b') && ' People: ' + ans(a, 'L.5b') + '.', ans(a, 'L.5e') && ' ' + ans(a, 'L.5e') + '.'].filter(Boolean).join(''));
  if (!ans(a, 'L.1') || /haven't sorted/.test(ans(a, 'L.1'))) add(CC, 'Name the adult who drives ' + name + ' home', 'The hospital will not discharge to a taxi or rideshare on its own; they need a named adult. Usually the first thing we solve.' + said('L.1'));
  else add(CC, 'Confirm the ride home' + (det(a, 'L.1') ? ': ' + det(a, 'L.1').slice(0, 80) : ''), 'Check the day and time once the report time is known.' + said('L.1'));
  if (ans(a, 'A.2') === 'Lives alone') {
    if (/^Yes/.test(ans(a, 'A.2a'))) add(FS, 'Confirm who stays the first night or two', det(a, 'A.2a'));
    else add(FS, 'Someone with ' + name + ' the first night or two', 'Lives alone. Ask the surgeon’s office whether someone needs to be there the first night or two.' + said('A.2'));
  }
  if (ans(a, 'G.6') === 'Not scheduled yet') add(CC, 'Surgery date — hold the plan until it is set', 'Nothing gets booked against a date that does not exist yet.');
  if (emergency) add(UA, 'Where things stand today', [ans(a, 'G.6a'), ans(a, 'G.6b'), ans(a, 'G.6e') && 'With them: ' + ans(a, 'G.6e'), ans(a, 'G.6f') && 'Call first: ' + ans(a, 'G.6f')].filter(Boolean).join(' — '));
  if (/don't have a name/.test(ans(a, 'G.4'))) add(UA, "Get the surgery's name, and whether it is open or minimally invasive", 'The same operation done two ways can mean one night in the hospital or five.');
  if (/waiting to find out/.test(ans(a, 'G.1'))) add(UA, 'Waiting on the diagnosis — check in after the next appointment');
  if (/Not sure|don't know/.test(ans(a, 'G.10'))) add(UA, 'Find out: straight home, or rehab first', "Changes the whole plan. Ask the surgeon's office or the discharge planner.");
  if (/rehab/.test(ans(a, 'G.10'))) add(CC, 'Rehab facility: which one, how far, and a visiting plan', det(a, 'G.10a'));
  if (/4–7|More than/.test(ans(a, 'G.9'))) add(FS, 'Household coverage while ' + name + ' is in the hospital', 'Several days where the house runs without them.' + (ans(a, 'G.9c') ? ' Days that worry them: ' + ans(a, 'G.9c') : ''));
  if (ans(a, 'M.1') === 'Yes') add(FS, 'Childcare for surgery week', det(a, 'M.1') ? 'Ages: ' + det(a, 'M.1') : '');
  if (ans(a, 'M.4') && ans(a, 'M.4') !== 'No') add(FS, 'Pet care for the hospital days', ans(a, 'M.4') + (ans(a, 'M.4f') ? ' — ' + ans(a, 'M.4f') : ''));
  if (/Someone else/.test(ans(a, 'C.6'))) add(CC, 'Confirm the one contact for the surgical team: ' + det(a, 'C.6').slice(0, 80), 'Give the hospital one name and number so messages never cross.');
  if (/Nobody's been designated/.test(ans(a, 'C.6'))) add(CC, 'Name one contact for the surgical team', 'Several of them are calling. One named person keeps the information clean.');
  if (!/^Someone$/.test(ans(a, 'C.2c'))) add(FS, 'Name a backup caregiver', 'Who steps in if the main caregiver gets sick or hits a wall. Decide it while it is easy.');
  if (/^(No|Not sure)$/.test(ans(a, 'C.3a'))) add(UA, 'Get a copy of the advance directive into the hospital chart', 'It exists, but the hospital may not have it. Simple paperwork, and ours to do.');
  if (filledNot(a, 'O.10c', 'Nothing specific')) add(FS, 'Before surgery: ' + ans(a, 'O.10c').slice(0, 100), 'Easy to arrange, easy to forget in the rush. It matters to them.');
  if (/Our own clergy|chaplain|Both/.test(ans(a, 'O.10b'))) add(FS, 'Arrange a clergy visit: ' + ans(a, 'O.10b').toLowerCase(), det(a, 'O.10b'));
  if (/already offered|would if we asked/.test(ans(a, 'O.10a'))) add(FS, 'Coordinate meals and visits with their faith community', 'One point of contact there, so it is organized rather than everyone arriving Tuesday.');
  if (/^No$|Didn't know/.test(ans(a, 'E.0'))) add(UA, 'Check the Medicaid ride benefit', 'A free win. Confirm what is covered and how to book it before the first appointment.');
  if (ans(a, 'E.type') === 'VA') add(UA, 'VA: travel pay and the Caregiver Support Program', 'Underused benefits. Find out what applies.');
  if (wants('pharmacy') || /^Yes/.test(ans(a, 'J.4'))) {
    if (ans(a, 'J.4c') === 'No' || !ans(a, 'J.4c')) add(UA, 'Pharmacy weekend hours and delivery' + (det(a, 'J.4') ? ': ' + det(a, 'J.4').slice(0, 80) : ''), 'A Friday discharge and a pharmacy closed Saturday is a scramble we can head off.');
  }
  const k5 = ans(a, 'K.5');
  if (k5 && !/None of these/.test(k5)) add(UA, 'Equipment already at home: ' + k5, 'Check what the team wants on top of this (walker, shower chair, raised seat) and whether doorways are wide enough for a walker (about 30 inches).');
  else if (!/rehab/.test(ans(a, 'G.10'))) add(UA, 'Equipment for coming home', 'Ask the team what they want: walker, shower chair, raised toilet seat. Rent, buy, insurance, or a closet down the street. Doorways need about 30 inches for a walker.');
  if (ans(a, 'K.7b') && /landlord/.test(ans(a, 'K.7b'))) add(UA, 'Ask the landlord about grab bars or a ramp now', 'Permission takes days to weeks.');
  if (ans(a, 'N.1c') === 'Not yet') add(UA, 'Tell the employer and start leave paperwork', 'FMLA needs 50+ employees within 75 miles, a year worked, and about 1,250 hours. We prepare the request; the family sends it.');
  if (wants('leave') && ans(a, 'N.4')) add(UA, 'Forms: ' + ans(a, 'N.4'), 'We prepare them; they send them.' + said('N.3'));
  if (/self-employed/.test(ans(a, 'N.2'))) add(UA, 'Plan around lost income', 'Self-employed or gig. Build the schedule around their work hours where we can.');
  if (ans(a, 'N.1b') && !/No license needed/.test(ans(a, 'N.1b'))) add(UA, 'Return-to-work medical sign-off: ' + ans(a, 'N.1b'), 'Licensed jobs usually need their own recertification, often months. Start early.');
  if (filledNot(a, 'D.6', 'Not that I know of')) add(CC, 'Keep for the patient: ' + ans(a, 'D.6').slice(0, 100), 'Things they are adamant about doing themselves. Do not take these over.');
  if (ans(a, 'O3.15').trim()) add(CC, 'Off limits: ' + ans(a, 'O3.15').slice(0, 100), "Things they'd rather we didn't touch. Never override this.");
  if (/^Yes/.test(ans(a, 'P.1a'))) add(FS, 'Talk through what comes off the caregiver’s plate first', 'They said they are running on empty.');
  add(CC, 'Intake meeting', 'Go through the flags, the notes (in their words), and anything marked "I don\'t know" or "rather discuss."');
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

// The intake form as the page gets it: the hospital question's list comes from the hospitals the coordinator keeps.
async function specFor() {
  let names = [];
  try { names = (await db.all(`select name from hospital_walks order by name`)).map(r => r.name); } catch (e) {}
  return intakeSpec(names);
}
module.exports = { allergyMentions, medicalQuestions, specFor, intakeSpec, readIntake, writeIntake, visibleQs, visibleAnswers, walk, cond, emergencyPath, missingRequired, phoneOk, initialsProblem, tidyAnswer, ans, has, det, detailId, isPatient, roleOf, modeOf, servicesOf, intakeFlags, seedPlan, DK_, DISCUSS_, RNS_, EMERGENCY_ };
