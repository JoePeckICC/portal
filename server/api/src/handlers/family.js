'use strict';
// Family-side pieces (2026-09-27): the private journal, who-is-with-them coverage, the fundraiser link, the whole
// record as a download, and the coordinator's time log per family.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const { id, must, clean, isTrue, first } = require('../util');

const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
const famOnly = ctx => must(core.fam(ctx), 'Only the family');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const extraOf = c => (c.extra && typeof c.extra === 'object' ? c.extra : {});

// ---- the journal: the writer's alone. Not the coordinator's, not the family's. Prompts follow the stage.
const PROMPTS = {
  'Diagnosis': ['What did they say, and what did you hear?', 'Who have you told, and who are you not ready to tell?'],
  'The countdown': ['What are you most afraid of? Write it once.', 'What do you want the day after surgery to look like?'],
  'The last week': ['What do you want to say to the people around you before the day?', 'What are you doing to stay steady this week?'],
  'The day of surgery': ['Write to yourself, for later.'],
  'At the hospital': ['What is the room like? What are you noticing?'], 'In surgery': ['What are you doing while you wait?'],
  'ICU': ['One thing from today you do not want to forget.', 'What did a nurse or a doctor say that landed?'],
  'On the way home': ['What are you looking forward to at home? What are you dreading?'],
  'Home': ['What was harder than you expected today? What was easier?', 'Who showed up?'],
  'Recovery': ['What can you do this week that you could not do last week?', 'What are you tired of? Say it here.'],
  'Finding wisdom': ['What would you tell someone at the start of this?', 'What did this change in you?'],
};
async function journalWrite(ctx, p, c) {
  famOnly(ctx); needFamily(ctx);
  const body = clean(p.body, 6000).trim(); must(body, 'Write something');
  if (p.entryId) { const r = await db.update('journal', { client_id: ctx.clientId, entry_id: String(p.entryId), by: ctx.email }, { body }, c); must(r.length, 'Not found'); return { entry: r[0] }; }
  const row = await db.insert('journal', { entry_id: id(), client_id: ctx.clientId, by: ctx.email, prompt: clean(p.prompt, 200), body }, c);
  return { entry: row };
}
async function journalDelete(ctx, p, c) {
  famOnly(ctx); needFamily(ctx);
  await db.q(`delete from journal where client_id=$1 and entry_id=$2 and by=$3`, [ctx.clientId, String(p.entryId || ''), ctx.email], c);
  return { ok: true };
}
// Only the writer's own entries ever leave the server.
async function journalFor(ctx) { if (!core.fam(ctx)) return []; return db.all(`select entry_id, at, prompt, body from journal where client_id=$1 and by=$2 order by at desc limit 200`, [ctx.clientId, ctx.email]); }

// ---- coverage: who is with the patient, by day and part of day. A "with" slot is someone in the house; a "visit" is a visitor.
const PARTS = ['morning', 'afternoon', 'evening', 'night'];
async function setCoverage(ctx, p, c) {
  famOrCo(ctx); needFamily(ctx);
  must(/^\d{4}-\d{2}-\d{2}$/.test(String(p.day || '')), 'Bad day'); must(PARTS.indexOf(p.part) >= 0, 'Bad part of day');
  const who = clean(p.who, 120).trim(), kind = p.kind === 'visit' ? 'visit' : 'with';
  if (!who) { await db.q(`delete from coverage where client_id=$1 and day=$2 and part=$3 and kind=$4`, [ctx.clientId, p.day, p.part, kind], c); return { ok: true }; }
  await db.q(`insert into coverage (slot_id, client_id, day, part, kind, who, note, added_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict (client_id, day, part, kind) do update set who=excluded.who, note=excluded.note, added_by=excluded.added_by`, [id(), ctx.clientId, p.day, p.part, kind, who, clean(p.note, 200), ctx.email], c);
  return { ok: true };
}
async function coverageFor(clientId) { return db.all(`select day::text, part, kind, who, note from coverage where client_id=$1 and day >= current_date - 1 and day <= current_date + 21 order by day, part`, [clientId]); }

// ---- the fundraiser link: the family's own page, shown to the Circle and on the public page. We never take a cut and never host it.
async function setFundraiser(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Only the patient or the coordinator'); needFamily(ctx);
  const url = clean(p.url, 300).trim(); must(!url || /^https:\/\/[^\s]+$/.test(url), 'Paste the full link, starting with https://');
  const client = await core.clientById(ctx.clientId, c);
  await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...extraOf(client), fund_url: url, fund_note: clean(p.note, 200) })], c);
  return { ok: true };
}

// ---- everything, as one file. The patient's right to their record: every table that carries their family.
async function exportAll(ctx, p, c) {
  must(ctx.role === 'client', 'Only the patient can download the whole record'); needFamily(ctx);
  const cid = ctx.clientId, out = { exported_at: new Date().toISOString(), portal: C.APP_NAME };
  const client = await core.clientById(cid, c); out.client = { ...client, stripe_customer_id: undefined, stripe_subscription_id: undefined };
  const tables = ['plan_items', 'tasks', 'goals', 'topics', 'messages', 'updates', 'circle', 'appointments', 'care_team', 'medications', 'doses', 'uploads', 'vendor_bills', 'assistance', 'referrals', 'intake_answers', 'checklist_ticks', 'update_comments', 'help_items', 'escalations', 'checkins', 'symptoms', 'coverage'];
  for (const t of tables) { try { out[t] = await db.all(`select * from ${t} where client_id=$1`, [cid], c); } catch (e) { out[t] = []; } }
  out.journal = await db.all(`select entry_id, at, prompt, body from journal where client_id=$1 and by=$2`, [cid, ctx.email], c);   // only their own
  out.uploads = (out.uploads || []).map(u => ({ ...u, storage_key: undefined, url: core.fileUrl(ctx, u) }));
  return { file: out };
}

// ---- the coordinator's time log
async function logTime(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed'); needFamily(ctx);
  const minutes = Math.max(1, Math.min(600, parseInt(p.minutes, 10) || 0)); must(minutes, 'How many minutes?');
  const row = await db.insert('time_log', { log_id: id(), client_id: ctx.clientId, by: ctx.email, minutes, what: clean(p.what, 200) }, c);
  return { entry: row };
}
async function timeFor(clientId) {
  const rows = await db.all(`select log_id, at, by, minutes, what from time_log where client_id=$1 order by at desc limit 100`, [clientId]);
  const month = (await db.one(`select coalesce(sum(minutes),0)::int m from time_log where client_id=$1 and at >= date_trunc('month', now())`, [clientId])).m;
  const total = (await db.one(`select coalesce(sum(minutes),0)::int m from time_log where client_id=$1`, [clientId])).m;
  return { rows, month, total };
}

module.exports = { journalWrite, journalDelete, setCoverage, setFundraiser, exportAll, logTime };
Object.defineProperty(module.exports, 'journalFor', { value: journalFor, enumerable: false });
Object.defineProperty(module.exports, 'coverageFor', { value: coverageFor, enumerable: false });
Object.defineProperty(module.exports, 'timeFor', { value: timeFor, enumerable: false });
Object.defineProperty(module.exports, 'PROMPTS', { value: PROMPTS, enumerable: false });
Object.defineProperty(module.exports, 'PARTS', { value: PARTS, enumerable: false });
