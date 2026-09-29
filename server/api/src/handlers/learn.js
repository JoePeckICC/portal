'use strict';
// Learning from our own families (Joe 2026-09-29): what actually happened after each surgery, day by day, grouped
// into cohorts (surgery, age band, lives alone, kind of work), so the suggested timelines get sharper with every
// family. Only families who said yes in the intake count, and a group's numbers are shown only once it has at
// least MIN_N families: nobody can be picked out of a small group. Nothing is deleted.
const db = require('../db');
const { must, clean, isTrue } = require('../util');

const MIN_N = 11;
const MILESTONES = [
  ['surgery', 'Surgery day'],
  ['icu_out', 'Out of ICU'],
  ['first_walk', 'First walk'],
  ['discharge', 'Home from the hospital'],
  ['staples_out', 'Staples or stitches out'],
  ['drive', 'Cleared to drive'],
  ['work', 'Back to work or school'],
  ['normal', 'Feels mostly back to normal'],
  ['readmit', 'Back in the hospital'],
];
const KEYS = MILESTONES.map(m => m[0]);
const DEST = ['Home', 'Home with home health', 'Inpatient rehab', 'Skilled nursing', 'Somewhere else'];
const SURGERIES = ['Craniotomy for a tumor (including meningioma)', 'Aneurysm clipping', 'Epilepsy surgery', 'Pituitary or skull base surgery', 'Chiari decompression', 'Microvascular decompression (MVD)', 'Deep brain stimulation (DBS)', 'VP shunt', 'Spinal fusion, neck (including ACDF)', 'Spinal fusion, mid or lower back', 'Something else'];

const approver = ctx => ctx.role === 'client' || (ctx.role === 'family' && ctx.user && ctx.user.extra && isTrue(ctx.user.extra.delegate));
const ymd = v => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; };

async function milestonesFor(clientId, c) {
  return db.all(`select kind, to_char(on_date,'YYYY-MM-DD') on_date, detail, source, set_by from recovery_milestones where client_id=$1`, [clientId], c);
}
// Record (or clear) one milestone. The coordinator, the patient, or their delegate. source: 'manual' or 'tracker'.
async function saveMilestone(clientId, kind, date, detail, by, source, c, onlyIfEmpty) {
  if (onlyIfEmpty && await db.one(`select 1 from recovery_milestones where client_id=$1 and kind=$2`, [clientId, kind], c)) return;
  if (!date) { await db.q(`delete from recovery_milestones where client_id=$1 and kind=$2`, [clientId, kind], c); return; }
  await db.q(`insert into recovery_milestones (client_id, kind, on_date, detail, source, set_by) values ($1,$2,$3,$4,$5,$6)
    on conflict (client_id, kind) do update set on_date=excluded.on_date, detail=excluded.detail, source=excluded.source, set_by=excluded.set_by, set_at=now()`, [clientId, kind, date, detail || '', source || 'manual', by || ''], c);
}
async function setMilestone(ctx, p, c) {
  must(ctx.clientId, 'Pick a family first'); must(ctx.role === 'coordinator' || approver(ctx), 'Not allowed');
  const kind = String(p.kind || ''); must(KEYS.includes(kind), 'Not a milestone');
  const date = ymd(p.date); must(date || !p.date, 'Pick a date');
  const detail = kind === 'discharge' ? (DEST.includes(p.detail) ? p.detail : '') : clean(p.detail, 200);
  await saveMilestone(ctx.clientId, kind, date, detail, ctx.email, 'manual', c);
  return { milestones: await milestonesFor(ctx.clientId, c) };
}
// The tracker fills two for free: "In surgery" is surgery day, "Home" is the day they went home.
async function fromTracker(clientId, stage, by, c) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (stage === 'In surgery') await saveMilestone(clientId, 'surgery', today, '', by, 'tracker', c, true);
  if (stage === 'Home') await saveMilestone(clientId, 'discharge', today, 'Home', by, 'tracker', c, true);
}

// ---- cohorts
function ageBand(dob, at) {
  const b = ymd(dob); if (!b) return 'Unknown';
  const a = Math.floor((new Date(at || Date.now()) - new Date(b)) / (365.25 * 864e5));
  return a < 40 ? '18–39' : a < 55 ? '40–54' : a < 65 ? '55–64' : a < 75 ? '65–74' : '75+';
}
function workBand(v) { v = String(v || ''); return /desk/i.test(v) ? 'Desk work' : /feet|physical|lifting/i.test(v) ? 'Physical work' : /mixed/i.test(v) ? 'Mixed work' : /No|retired/i.test(v) ? 'Not working' : 'Unknown'; }
const quantile = (xs, q) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return Math.round(s[lo] + (s[hi] - s[lo]) * (i - lo)); };

// Every family who said yes, with their cohort and their milestones as days from surgery.
async function consented(c) {
  const rows = await db.all(`select client_id, question_id, answer from intake_answers where question_id in ('G.learn','G.4b','G.4a','A.dob','A.2','N.1','G.6')`, [], c);
  const by = {};
  rows.forEach(r => { (by[r.client_id] = by[r.client_id] || {})[r.question_id] = String(r.answer || ''); });
  const ms = await db.all(`select client_id, kind, on_date, detail from recovery_milestones`, [], c);
  const out = [];
  Object.keys(by).forEach(id => {
    const a = by[id]; if (!/^Yes/.test(a['G.learn'] || '')) return;
    const mine = ms.filter(m => m.client_id === id), s = mine.find(m => m.kind === 'surgery');
    const sd = s ? new Date(s.on_date) : (ymd(a['G.6']) ? new Date(a['G.6']) : null);
    const days = {}; let dest = '';
    mine.forEach(m => { if (m.kind === 'surgery' || !sd) return; days[m.kind] = Math.round((new Date(m.on_date) - sd) / 864e5); if (m.kind === 'discharge') dest = m.detail || ''; });
    out.push({ surgery: SURGERIES.includes(a['G.4b']) ? a['G.4b'] : 'Not picked yet', approach: a['G.4a'] || '', age: ageBand(a['A.dob'], sd), alone: /alone/i.test(a['A.2'] || '') ? 'Lives alone' : a['A.2'] ? 'Lives with others' : 'Unknown', work: workBand(a['N.1']), hasSurgery: !!s, days, dest });
  });
  return out;
}
// What we are learning: for each surgery (optionally narrowed by a cohort), how many families, and once there are
// MIN_N with a milestone, the middle half of the days it took (25th to 75th percentile) and the typical day.
async function learnStats(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed');
  const f = { age: p.age || '', alone: p.alone || '', work: p.work || '' };
  const all = (await consented(c)).filter(x => (!f.age || x.age === f.age) && (!f.alone || x.alone === f.alone) && (!f.work || x.work === f.work));
  const groups = {};
  all.forEach(x => { (groups[x.surgery] = groups[x.surgery] || []).push(x); });
  const result = Object.keys(groups).sort().map(name => {
    const g = groups[name];
    const miles = MILESTONES.filter(m => m[0] !== 'surgery').map(([k, label]) => {
      const xs = g.map(x => x.days[k]).filter(v => typeof v === 'number' && v >= 0 && v < 1100);
      return xs.length >= MIN_N ? { k, label, n: xs.length, p25: quantile(xs, .25), mid: quantile(xs, .5), p75: quantile(xs, .75) } : { k, label, n: xs.length };
    });
    const withDest = g.filter(x => x.dest);
    const dest = withDest.length >= MIN_N ? DEST.map(d => ({ d, pct: Math.round(100 * withDest.filter(x => x.dest === d).length / withDest.length) })).filter(x => x.pct) : null;
    return { surgery: name, families: g.length, withSurgeryDay: g.filter(x => x.hasSurgery).length, milestones: miles, dest, destN: withDest.length };
  });
  return { minN: MIN_N, filters: { age: ['18–39', '40–54', '55–64', '65–74', '75+'], alone: ['Lives alone', 'Lives with others'], work: ['Desk work', 'Physical work', 'Mixed work', 'Not working'] }, groups: result, total: all.length };
}

module.exports = { MILESTONES, DEST, SURGERIES, MIN_N, milestonesFor, setMilestone, fromTracker, learnStats, ageBand, workBand, quantile };
