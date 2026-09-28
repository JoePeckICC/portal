'use strict';
// The family's story, the Circle page's look, the discharge planner, and the peer a few steps ahead (2026-09-27).
const C = require('../config');
const db = require('../db');
const core = require('../core');
const { id, must, clean, isTrue, first } = require('../util');
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
const extraOf = c => (c.extra && typeof c.extra === 'object' ? c.extra : {});
async function patchExtra(client, patch, c) { await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...extraOf(client), ...patch })], c); }

// Written with the family, in their words. Shown to the Circle and on the public page once the family says so.
async function setStory(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const body = clean(p.body, 6000).trim();
  await patchExtra(client, { story: body ? { title: clean(p.title, 120).trim(), body, by: ctx.email, at: new Date().toISOString(), shared: isTrue(p.shared) } : null }, c);
  return { ok: true };
}
const THEMES = ['ink', 'sage', 'clay', 'sky'];
async function setTheme(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator' || ctx.role === 'family', 'Not allowed'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { theme: THEMES.indexOf(p.theme) >= 0 ? p.theme : 'ink' }, c);
  return { ok: true };
}
// Someone a few steps ahead: the coordinator names them, with both families' permission. The family sees a name and a line.
async function setPeer(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const name = clean(p.name, 120).trim();
  await patchExtra(client, { peer: name ? { name, note: clean(p.note, 300), contact: clean(p.contact, 160), at: new Date().toISOString() } : null }, c);
  return { ok: true };
}

// The discharge planner: eight questions the day before the wheelchair. A "no" or a "don't know" becomes a task, once.
const DISCHARGE = [
  { id: 'ride', q: 'Is the named adult driver confirmed for the discharge day and time?', task: 'Confirm who drives home from the hospital, and the time', cat: 0 },
  { id: 'meds', q: 'Do you have the medication schedule in writing — what, how much, when?', task: 'Get the medication schedule from the nurse, on paper, before leaving', cat: 0 },
  { id: 'rx', q: 'Are the prescriptions filled, or do you know which pharmacy has them and its hours today?', task: 'Find out where the prescriptions are going and when they will be ready', cat: 0 },
  { id: 'call', q: 'Do you know who to call once home, at what number, day and night?', task: 'Write down the post-op line and the after-hours number', cat: 1 },
  { id: 'follow', q: 'Are the follow-up appointments booked, or do you know who books them?', task: 'Pin down the follow-up appointments — who books, and when', cat: 0 },
  { id: 'equip', q: 'Is the equipment at home or in the car?', task: 'Chase the equipment delivery — walker, shower chair, whatever was ordered', cat: 0 },
  { id: 'night', q: 'Is someone in the house the first night?', task: 'Name who stays the first night', cat: 2 },
  { id: 'home', q: 'Is home ready — bed on the right floor, a clear path, food for three days?', task: 'Set up the landing zone at home before the car pulls in', cat: 2 },
  { id: 'papers', q: 'Are the discharge papers in the bag, and will you upload them tonight?', task: 'Upload the discharge papers under Documents once home', cat: 0 },
];
async function dischargePlan(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const ans = p.answers && typeof p.answers === 'object' ? p.answers : {};
  const out = {}, made = [];
  for (const q of DISCHARGE) {
    if (ans[q.id] === undefined) continue;
    const v = ['yes', 'no', 'dk'].indexOf(ans[q.id]) >= 0 ? ans[q.id] : '';
    out[q.id] = v;
    // A yes, or a cleared answer, takes back a task nobody has started.
    if (v === 'yes' || !v) { await db.q(`delete from tasks where client_id=$1 and extra->>'auto'=$2 and status='Not started'`, [ctx.clientId, 'discharge:' + q.id], c); continue; }
    {
      const exists = await db.one(`select 1 from tasks where client_id=$1 and extra->>'auto'=$2 and status<>'Done'`, [ctx.clientId, 'discharge:' + q.id], c);
      if (!exists) { await db.insert('tasks', { task_id: id(), client_id: ctx.clientId, title: q.task, category: C.CATEGORIES[q.cat], status: 'Not started', owner: first(client.patient_first_name) || 'Family', due_date: null, notes: 'From the discharge planner' + (v === 'dk' ? ' — nobody knew yet' : '') + '.', extra: JSON.stringify({ auto: 'discharge:' + q.id }) }, c); made.push(q.task); }
    }
  }
  await patchExtra(client, { discharge: { answers: { ...((extraOf(client).discharge || {}).answers || {}), ...out }, at: new Date().toISOString(), by: ctx.email } }, c);
  return { made };
}

module.exports = { setStory, setTheme, setPeer, dischargePlan };
Object.defineProperty(module.exports, 'DISCHARGE', { value: DISCHARGE, enumerable: false });
Object.defineProperty(module.exports, 'THEMES', { value: THEMES, enumerable: false });
