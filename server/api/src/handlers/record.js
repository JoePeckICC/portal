'use strict';
// My Record: visit notes, allergies, documents, help asks, pharmacy, vendor bills, assistance.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const storage = require('../storage');
const { id, must, clean, pick, famName, first } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const dateOnly = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);

async function saveVisitNote(ctx, p, c) {
  must(ctx.role === 'coordinator' || ctx.role === 'client', 'Not allowed');
  const a = await db.one(`select * from appointments where client_id=$1 and appt_id=$2`, [ctx.clientId, String(p.apptId || '')], c); must(a, 'Not found');
  const extra = { ...(a.extra || {}) }, patch = {};
  if (ctx.role === 'coordinator' && p.note !== undefined) { patch.visit_note = clean(p.note, 4000); extra.note_by = ctx.email; extra.note_at = new Date().toISOString(); }
  if (p.shared !== undefined) extra.note_shared = p.shared ? 'TRUE' : 'FALSE';
  if (patch.visit_note !== undefined && p.shared === undefined && !String(extra.note_shared || '')) extra.note_shared = 'TRUE';
  patch.extra = JSON.stringify(extra);
  await db.update('appointments', { appt_id: a.appt_id }, patch, c);
  if (ctx.role === 'coordinator' && patch.visit_note && !String(a.visit_note || '').trim()) await core.autoMsg(ctx.clientId, 'A note from your visit “' + a.title + '” is under My Record → Visits.', c);
  return {};
}
async function saveAllergies(ctx, p, c) {
  must(ctx.role === 'coordinator' || ctx.role === 'client', 'Not allowed');
  const r = await db.update('clients', { client_id: ctx.clientId }, { allergies: clean(p.allergies, 400) }, c); must(r.length, 'Not found');
  return {};
}
async function savePharmacy(ctx, p, c) {
  famOrCo(ctx);
  const patch = {};
  ['pharmacy_name', 'pharmacy_phone', 'pharmacy_address', 'pharmacy_hours'].forEach(f => { if (p[f] !== undefined) patch[f] = clean(p[f], 240); });
  if (Object.keys(patch).length) { const r = await db.update('clients', { client_id: ctx.clientId }, patch, c); must(r.length, 'Not found'); }
  return { client: core.publicClient(await core.clientById(ctx.clientId, c)) };
}

// ---- documents
async function uploadDoc(ctx, p, c) {
  famOrCo(ctx);
  must(p.b64 && p.name, 'Nothing to upload');
  const bytes = Buffer.from(String(p.b64), 'base64');
  must(bytes.length <= 20 * 1024 * 1024, 'That file is over 20 MB. A photo of each page works well.');
  const kind = pick(p.kind, C.DOC_KINDS, 'Other');
  const row = await storage.saveUpload(ctx, { clientId: ctx.clientId, kind, name: clean(p.name, 120), mime: p.type || 'application/octet-stream', bytes, note: clean(p.note, 400), shared: p.shared !== false }, c);
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  let after = null;
  if (ctx.role !== 'coordinator') {
    if (kind === 'Discharge') await core.autoMsg(ctx.clientId, 'Discharge papers uploaded: ' + row.name + '. ' + (co ? first(co.name) : 'Your coordinator') + ' will build the medication list from them.', c);
    after = () => core.notifyCo(co, 'upload', famName(client.family_name) + ' uploaded a document (' + kind + ')', ctx.user.name + ' uploaded ' + row.name + (row.note ? ' — ' + row.note : ''), '', 'Open the portal');
  } else await core.autoMsg(ctx.clientId, 'New document under My Record → Documents: ' + row.name + ' (' + kind + ').', c);
  return { upload: core.docPublic(row, ctx), _after: after };
}
// Discharge papers (photo or PDF); the coordinator builds the med list from them.
async function uploadDischarge(ctx, p, c) { p.kind = p.kind === 'other' ? 'Other' : 'Discharge'; return uploadDoc(ctx, p, c); }
async function setDoc(ctx, p, c) {
  famOrCo(ctx);
  const u = await db.one(`select * from uploads where client_id=$1 and upload_id=$2`, [ctx.clientId, String(p.uploadId || '')], c); must(u, 'Not found');
  const patch = {};
  if (p.shared !== undefined && ctx.role !== 'family') patch.shared = !!p.shared;
  if (p.note !== undefined && ctx.role === 'coordinator') patch.note = clean(p.note, 400);
  if (p.kind !== undefined && ctx.role === 'coordinator') patch.kind = pick(p.kind, C.DOC_KINDS, u.kind);
  if (Object.keys(patch).length) await db.update('uploads', { upload_id: u.upload_id }, patch, c);
  return {};
}
// A message attachment becomes a Documents entry (attachments are already uploads; this flags it and sets the kind).
async function keepAttachment(ctx, p, c) {
  famOrCo(ctx);
  const m = await db.one(`select * from messages where client_id=$1 and message_id=$2`, [ctx.clientId, String(p.messageId || '')], c); must(m, 'Not found');
  const a = (Array.isArray(m.attachments) ? m.attachments : []).find(x => x.id === p.fileId); must(a, 'Not found');
  const u = await db.one(`select * from uploads where client_id=$1 and (upload_id=$2 or file_id=$2)`, [ctx.clientId, String(a.id)], c);
  if (u) {
    must(!(u.extra && u.extra.kept), 'Already in Documents');
    await db.update('uploads', { upload_id: u.upload_id }, { kind: pick(p.kind, C.DOC_KINDS, 'Other'), note: 'From Messages', shared: true, extra: JSON.stringify({ ...(u.extra || {}), kept: true }) }, c);
  } else {   // legacy Drive attachment from before the move: keep the pointer
    await db.insert('uploads', { upload_id: id(), client_id: ctx.clientId, kind: pick(p.kind, C.DOC_KINDS, 'Other'), name: a.name, url: a.url || '', file_id: a.id, uploaded_by: m.sender_email, uploaded_at: m.sent_at, note: 'From Messages', shared: true, extra: JSON.stringify({ kept: true }) }, c);
  }
  return {};
}

// Help with one thing: a Messages topic named for it, so the ask never gets lost.
async function askHelp(ctx, p, c) {
  must(core.fam(ctx), 'Not allowed');
  const what = clean(p.what, 120).trim(); must(what, 'What do you need help with?');
  const title = 'Help with ' + what;
  let t = await db.one(`select * from topics where client_id=$1 and title=$2 and status<>'Archived' limit 1`, [ctx.clientId, title], c);
  if (!t) t = await db.insert('topics', { topic_id: id(), client_id: ctx.clientId, title, kind: 'other', status: 'Active', created_by: ctx.email }, c);
  const body = clean(p.body, 2000).trim() || 'I could use help with ' + what.toLowerCase() + '.';
  await db.insert('messages', { message_id: id(), client_id: ctx.clientId, topic_id: t.topic_id, sender_email: ctx.email, body, read_by_client: ctx.role === 'client', read_by_coordinator: false }, c);
  await db.q(`update topics set last_at=now(), status='Active' where topic_id=$1`, [t.topic_id], c);
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  const after = () => core.notifyCo(co, 'message', title + ' — ' + famName(client.family_name).toLowerCase(), ctx.user.name + ' asked:', body, 'Open the portal');
  return { topic: t, _after: after };
}

// ---- money
async function askAssistance(ctx, p, c) {
  must(core.fam(ctx), 'Not allowed');
  const choice = clean(p.choice, 80).trim(), note = clean(p.note, 2000).trim();
  must(choice || note, 'Pick one, or tell us what would help');
  let t = await db.one(`select * from topics where client_id=$1 and kind='billing' and status<>'Archived' limit 1`, [ctx.clientId], c);
  if (!t) t = await db.insert('topics', { topic_id: id(), client_id: ctx.clientId, title: C.TOPIC_KINDS.billing, kind: 'billing', status: 'Active', created_by: ctx.email }, c);
  const body = 'Financial assistance: ' + (choice || 'a question') + (note ? '\n' + note : '');
  await db.insert('messages', { message_id: id(), client_id: ctx.clientId, topic_id: t.topic_id, sender_email: ctx.email, body, read_by_client: true, read_by_coordinator: false }, c);
  await db.q(`update topics set last_at=now(), status='Active' where topic_id=$1`, [t.topic_id], c);
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  const after = () => core.notifyCo(co, 'assist', 'Financial assistance — ' + famName(client.family_name), ctx.user.name + ' asked for help with billing:', body, 'Open the portal');
  return { topicId: t.topic_id, _after: after };
}
async function saveAssistance(ctx, p, c) {
  coOnly(ctx);
  if (p.programId) {
    const row = await db.one(`select * from assistance where client_id=$1 and program_id=$2`, [ctx.clientId, String(p.programId)], c); must(row, 'Not found');
    await db.update('assistance', { program_id: row.program_id }, { status: pick(p.status, C.ASSIST_STATUSES, row.status), note: p.note !== undefined ? clean(p.note, 500) : row.note }, c);
    return {};
  }
  const name = clean(p.name, 160).trim(); must(name, 'Name the program');
  await db.insert('assistance', { program_id: id(), client_id: ctx.clientId, name, what: clean(p.what, 200), status: pick(p.status, C.ASSIST_STATUSES, 'Suggested'), note: clean(p.note, 500), link: clean(p.link, 300) }, c);
  await core.autoMsg(ctx.clientId, 'Financial help to look at: ' + name + (p.what ? ' — ' + clean(p.what, 200) : '') + '. See Billing → Financial assistance.', c);
  return {};
}
// Vendor bills: what the family owes the people the coordinator brought in. Either side can add; the family marks paid.
async function saveVendorBill(ctx, p, c) {
  famOrCo(ctx);
  if (p.billId) {
    const row = await db.one(`select * from vendor_bills where client_id=$1 and bill_id=$2`, [ctx.clientId, String(p.billId)], c); must(row, 'Not found');
    const patch = {}; if (p.status) patch.status = pick(p.status, C.BILL_STATUSES, row.status); if (p.note !== undefined) patch.note = clean(p.note, 300);
    if (Object.keys(patch).length) await db.update('vendor_bills', { bill_id: row.bill_id }, patch, c);
    return {};
  }
  const vendor = clean(p.vendor, 160).trim(); must(vendor, 'Name the vendor');
  const amt = parseFloat(String(p.amount || '').replace(/[$,]/g, ''));
  await db.insert('vendor_bills', { bill_id: id(), client_id: ctx.clientId, vendor, service: clean(p.service, 200), amount: Number.isFinite(amt) ? amt : null, status: pick(p.status, C.BILL_STATUSES, 'Estimate'), due_date: dateOnly(p.due_date), note: clean(p.note, 300), added_by: ctx.email }, c);
  return {};
}

module.exports = { saveVisitNote, saveAllergies, savePharmacy, uploadDoc, uploadDischarge, setDoc, keepAttachment, askHelp, askAssistance, saveAssistance, saveVendorBill };
