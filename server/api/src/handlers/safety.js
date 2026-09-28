'use strict';
// Safety (2026-09-27): the ER heads-up and the escalation log. A family taps "We're headed to the ER", says which
// hospital and why, and the coordinator is paged that minute — so they can call the ED before the car arrives with
// the one-page Health summary in hand. Every escalation (ER, 911, a call to the surgeon after hours) lands in the
// log with an outcome, so the story is in one place when the family or a lawyer asks.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const { id, must, clean, famName, first } = require('../util');

const KINDS = ['ER', '911', 'Surgeon after hours', 'Nurse line', 'Other'];
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');

async function erAlert(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const hospital = clean(p.hospital, 160).trim(), why = clean(p.why, 1000).trim();
  must(hospital, 'Which hospital?');
  const client = await core.clientById(ctx.clientId, c);
  const row = await db.insert('escalations', { esc_id: id(), client_id: ctx.clientId, by: ctx.email, kind: 'ER', hospital, what: why, outcome: '' }, c);
  // it lands in Messages too, under the urgent topic, so the thread is where the family already looks
  // One conversation per person (2026-09-28): it goes into the family's thread with the coordinator, not a new one.
  let t = await db.one(`select * from topics where client_id=$1 and kind not in ('auto','family') order by last_at desc nulls last, created_at desc limit 1`, [ctx.clientId], c);
  if (!t) t = await db.insert('topics', { topic_id: id(), client_id: ctx.clientId, title: C.TOPIC_KINDS.urgent, kind: 'urgent', status: 'Active', created_by: ctx.email }, c);
  const body = 'Headed to the ER: ' + hospital + (why ? '\n' + why : '') + '\n\nIf this is life-threatening, call 911. Your care coordinator has been notified.';
  await db.insert('messages', { message_id: id(), client_id: ctx.clientId, topic_id: t.topic_id, sender_email: ctx.email, body, read_by_client: ctx.role === 'client', read_by_coordinator: false, urgent: true }, c);
  await db.q(`update topics set last_at=now(), status='Active', extra=coalesce(extra,'{}'::jsonb)-'hidden' where topic_id=$1`, [t.topic_id], c);
  const after = async () => {
    const co = await core.coordinatorFor(client);
    const name = (ctx.user && ctx.user.name) || ctx.email;
    await core.notifyCo(co, 'er', 'ER — ' + famName(client.family_name) + ' · ' + hospital, name + ' says they are headed to ' + hospital + ' now. Call the ED charge nurse before they arrive; the Health summary has what to read them.', why, 'Open the chart');
    await core.notifyFamily(ctx.clientId, 'urgent', 'Headed to the ER — ' + hospital, name + ' let us know the family is headed to ' + hospital + '. Your care coordinator has been notified.', why, 'Open the portal', ctx.email);
  };
  return { escalation: row, _after: after };
}

async function addEscalation(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'Other';
  const what = clean(p.what, 1000).trim(); must(what, 'Say what happened');
  const row = await db.insert('escalations', { esc_id: id(), client_id: ctx.clientId, by: ctx.email, kind, hospital: clean(p.hospital, 160), what, outcome: clean(p.outcome, 1000), outcome_by: p.outcome ? ctx.email : '', outcome_at: p.outcome ? new Date() : null }, c);
  return { escalation: row };
}
async function setEscalation(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const r = await db.update('escalations', { client_id: ctx.clientId, esc_id: String(p.escId || '') }, { outcome: clean(p.outcome, 1000), outcome_by: ctx.email, outcome_at: new Date() }, c);
  must(r.length, 'Not found');
  return { ok: true };
}
async function escalationsFor(clientId) {
  return db.all(`select esc_id, at, by, kind, hospital, what, outcome, outcome_at from escalations where client_id=$1 order by at desc`, [clientId]);
}

module.exports = { erAlert, addEscalation, setEscalation };
Object.defineProperty(module.exports, 'escalationsFor', { value: escalationsFor, enumerable: false });
Object.defineProperty(module.exports, 'KINDS', { value: KINDS, enumerable: false });
