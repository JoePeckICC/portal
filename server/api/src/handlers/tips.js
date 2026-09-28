'use strict';
// Tips from families, for the next family (Joe, 2026-09-28): "if they know the right entrance to use, they should be
// able to give a hint to the next family." A family shares a tip about their hospital, or tells us what is helping;
// the coordinator reads every one first. Only tips the coordinator approves are shown to other families, with no
// name on them. Nothing is deleted: a tip that is not shared is archived.
const db = require('../db');
const core = require('../core');
const { id, must, clean, famName, first } = require('../util');

const KINDS = ['tip', 'helping'];
async function shareTip(ctx, p, c) {
  must(core.fam(ctx), 'Not allowed'); must(ctx.clientId, 'Pick a family first');
  const text = clean(p.text, 600).trim(); must(text, 'Write the tip first');
  const kind = KINDS.includes(p.kind) ? p.kind : 'tip';
  const place = clean(p.place, 160).trim();
  const row = await db.insert('tips', { tip_id: id(), client_id: ctx.clientId, kind, place, text, status: 'New', created_by: ctx.email }, c);
  const client = await core.clientById(ctx.clientId, c);
  return { tip: { tip_id: row.tip_id }, _after: async () => { const co = await core.coordinatorFor(client); await core.notifyCo(co, 'message', (kind === 'tip' ? 'A tip for the next family' : 'What is helping') + ', ' + famName(client.family_name), (first(ctx.user.name) || 'The family') + (place ? ' (' + place + ')' : '') + ': ' + text, '', 'Open the portal'); } };
}
// The coordinator shares it with other families, or keeps it private (archived).
async function reviewTip(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed');
  const status = p.share ? 'Shared' : 'Archived', text = p.text === undefined ? null : clean(p.text, 600).trim();
  const r = await db.q(`update tips set status=$2, text=coalesce($3, text), reviewed_by=$4, reviewed_at=now() where tip_id=$1 returning tip_id`, [String(p.tipId || ''), status, text || null, ctx.email], c);
  must((r.rows || r).length, 'Not found');
  return {};
}
// For a family: shared tips about the places they are going. For the coordinator: every tip still to read.
async function tipsFor(ctx, places) {
  const shared = places.length ? await db.all(`select tip_id, place, text, created_at from tips where status='Shared' and kind='tip' and lower(place) = any($1) order by created_at desc limit 20`, [places.map(x => String(x).toLowerCase())]) : [];
  const out = { placeTips: shared };
  if (ctx.role === 'coordinator') out.tipQueue = (await db.all(`select t.tip_id, t.kind, t.place, t.text, t.created_at, c.family_name from tips t left join clients c on c.client_id=t.client_id where t.status='New' order by t.created_at`)).map(t => ({ ...t, family: famName(t.family_name) }));
  return out;
}
module.exports = { shareTip, reviewTip };
Object.defineProperties(module.exports, { tipsFor: { value: tipsFor, enumerable: false } });
