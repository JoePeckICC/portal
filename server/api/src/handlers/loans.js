'use strict';
// The loan closet (2026-09-28, Joe): "you're going to buy a walker and then you're never going to use it again."
// The coordinator keeps equipment in each city, walkers, wheelchairs, shower chairs, and lends it to families
// through the portal. A family asks on Find Care (a "Medical equipment" request, which goes to the coordinator,
// never to vendors); the coordinator picks a piece from that city's closet and lends it, with a date it is due
// back. Nothing is ever deleted: a piece that wears out is retired, and every loan stays in its history.
const db = require('../db');
const core = require('../core');
const { id, must, clean, famName, first } = require('../util');

const KINDS = ['Walker', 'Wheelchair', 'Shower chair', 'Raised toilet seat', 'Bedside commode', 'Crutches', 'Knee scooter', 'Other'];
const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Add a piece to the closet, or change its details (label, city, notes), or retire it.
async function saveEquipment(ctx, p, c) {
  coOnly(ctx);
  const kind = KINDS.includes(p.kind) ? p.kind : 'Other';
  const label = clean(p.label, 120).trim() || kind, city = clean(p.city, 60).trim(), state = clean(p.state, 4).trim().toUpperCase();
  must(city, 'Which city is it kept in?');
  if (p.equipId) {
    const row = await db.one(`select * from equipment where equip_id=$1`, [String(p.equipId)], c); must(row, 'Not found');
    const status = p.retire ? 'Retired' : row.status === 'Retired' && p.unretire ? 'In closet' : row.status;
    must(!(p.retire && row.status === 'On loan'), 'It is out on loan. Mark it returned first.');
    await db.q(`update equipment set kind=$2, label=$3, city=$4, state=$5, notes=$6, status=$7, updated_at=now() where equip_id=$1`, [row.equip_id, kind, label, city, state, clean(p.notes, 400), status], c);
    return {};
  }
  const row = await db.insert('equipment', { equip_id: id(), kind, label, city, state, notes: clean(p.notes, 400), status: 'In closet', history: '[]' }, c);
  return { item: row };
}
// Lend a piece to a family. With a request (a loan job), it answers that request.
async function lendEquipment(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from equipment where equip_id=$1`, [String(p.equipId || '')], c); must(row, 'Not found');
  must(row.status === 'In closet', row.status === 'On loan' ? 'That one is already out on loan.' : 'That one is retired.');
  const job = p.jobId ? await db.one(`select * from jobs where job_id=$1 and status='Open' and extra->>'loan'='true'`, [String(p.jobId)], c) : null;
  const clientId = job ? job.client_id : String(p.clientId || ''); must(clientId, 'Pick the family');
  const client = await core.clientById(clientId, c); must(client, 'Not found');
  const due = DAY.test(String(p.dueBack || '')) ? String(p.dueBack) : '';
  const hist = (row.history || []).concat([{ client_id: clientId, family: famName(client.family_name), out: new Date().toISOString(), due }]);
  await db.q(`update equipment set status='On loan', client_id=$2, loaned_at=now(), due_back=$3, job_id=$4, history=$5, updated_at=now() where equip_id=$1`, [row.equip_id, clientId, due, job ? job.job_id : '', JSON.stringify(hist)], c);
  if (job) await db.q(`update jobs set status='Taken', taken_at=now(), extra=extra || jsonb_build_object('equip_id', $2::text, 'lent_by', $3::text) where job_id=$1`, [job.job_id, row.equip_id, first(ctx.user.name) || 'Your coordinator'], c);
  const what = row.label || row.kind;
  return { _after: () => core.notifyFamily(clientId, 'message', 'Your ' + what.toLowerCase() + ' is on its way', (first(ctx.user.name) || 'Your coordinator') + ' is lending you a ' + what.toLowerCase() + ' from the loan closet' + (due ? ', due back ' + due : '') + '.', '', 'Open the portal') };
}
// It came back: into the closet again, and the loan closes in its history.
async function returnEquipment(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select * from equipment where equip_id=$1`, [String(p.equipId || '')], c); must(row, 'Not found');
  must(row.status === 'On loan', 'It is not out on loan.');
  const hist = (row.history || []).slice(); if (hist.length) hist[hist.length - 1] = { ...hist[hist.length - 1], back: new Date().toISOString() };
  await db.q(`update equipment set status='In closet', client_id=null, loaned_at=null, due_back='', job_id='', history=$2, notes=$3, updated_at=now() where equip_id=$1`, [row.equip_id, JSON.stringify(hist), p.notes === undefined ? row.notes : clean(p.notes, 400)], c);
  if (row.job_id) await db.q(`update jobs set status='Done', done_at=now() where job_id=$1 and status='Taken'`, [row.job_id], c);
  return {};
}

// For the coordinator's page: the closet (with who has what), and the open requests to borrow.
async function closetFor() {
  const items = await db.all(`select e.*, c.family_name from equipment e left join clients c on c.client_id=e.client_id order by e.state, e.city, e.kind, e.label`);
  const asks = await db.all(`select j.job_id, j.client_id, j.city, j.state, j.starts_at, j.details, j.extra, c.family_name from jobs j join clients c on c.client_id=j.client_id where j.status='Open' and j.extra->>'loan'='true' order by j.starts_at`);
  return {
    equipment: items.map(e => ({ equip_id: e.equip_id, kind: e.kind, label: e.label, city: e.city, state: e.state, notes: e.notes, status: e.status, family: e.client_id ? famName(e.family_name) : '', client_id: e.client_id || '', due_back: e.due_back || '', loaned_at: e.loaned_at, history: e.history || [] })),
    loanAsks: asks.map(j => ({ job_id: j.job_id, client_id: j.client_id, family: famName(j.family_name), city: j.city, state: j.state, needed_by: j.starts_at, details: j.details, soon: (j.extra && j.extra.soon) || '', info: (j.extra && j.extra.info) || [] })),
    equipmentKinds: KINDS,
  };
}
// For a family: what they have borrowed right now.
async function borrowedBy(clientId) {
  const rows = await db.all(`select equip_id, kind, label, due_back, loaned_at from equipment where client_id=$1 and status='On loan'`, [clientId]);
  return rows.map(e => ({ equip_id: e.equip_id, kind: e.kind, label: e.label, due_back: e.due_back || '', loaned_at: e.loaned_at }));
}

module.exports = { saveEquipment, lendEquipment, returnEquipment };
Object.defineProperties(module.exports, { closetFor: { value: closetFor, enumerable: false }, borrowedBy: { value: borrowedBy, enumerable: false }, KINDS: { value: KINDS, enumerable: false } });
