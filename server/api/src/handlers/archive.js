'use strict';
// When a family leaves: archive in place, lock the door, keep the record for the retention period. A person purges, never a job.
const db = require('../db');
const core = require('../core');
const { must, ymd } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const RETAIN_YEARS = Number(process.env.RETAIN_YEARS || 8);

async function archiveClient(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  must(cl.status !== 'Archived', 'Already archived');
  const until = new Date(); until.setFullYear(until.getFullYear() + RETAIN_YEARS);
  await db.q(`update clients set status='Archived', archived_at=now(), retain_until=$2 where client_id=$1`, [cl.client_id, ymd(until, 'UTC')], c);
  // Everyone on the family loses sign-in; the coordinator can still open the chart read-only.
  await db.q(`update users set active=false, session_ver=session_ver+1 where client_id=$1 and lower(role) in ('client','family','supporter')`, [cl.client_id], c);
  await db.q(`delete from sessions where email in (select email from users where client_id=$1)`, [cl.client_id], c);
  return { client: core.publicClient(await core.clientById(ctx.clientId, c)), retain_until: ymd(until, 'UTC') };
}
// Test families (Joe 2026-09-30): archived in bulk once they are done, never deleted. A family counts as a test only when
// every sign-in on it is a test address (Joe's plus-addressed Gmail or an example.com address), or it has no sign-ins and
// its name says test, demo or sample. Anything else is a real family and never appears here.
const TEST_EMAIL = /^(joepeck\.usa(\+[^@]*)?@gmail\.com|[^@]+@example\.(com|org|net))$/i;
const TEST_NAME = /\b(test|demo|sample|fake)\b/i;
async function testFamilyRows(c) {
  const rows = await db.all(`select c.client_id, c.family_name, c.patient_first_name, c.created_at, coalesce(array_agg(lower(u.email)) filter (where u.email is not null and lower(u.role) in ('client','family')), '{}') emails
    from clients c left join users u on u.client_id=c.client_id where c.status <> 'Archived' group by c.client_id order by c.created_at`, [], c);
  return rows.filter(r => r.emails.length ? r.emails.every(e => TEST_EMAIL.test(e)) : TEST_NAME.test((r.family_name || '') + ' ' + (r.patient_first_name || '')));
}
async function familyRecords(ctx, p, c) {
  coOnly(ctx);
  const test = (await testFamilyRows(c)).map(r => ({ client_id: r.client_id, family_name: r.family_name, patient_first_name: r.patient_first_name, created_at: r.created_at, emails: r.emails }));
  const archived = await db.all(`select client_id, family_name, patient_first_name, archived_at, to_char(retain_until,'YYYY-MM-DD') retain_until from clients where status='Archived' order by archived_at desc nulls last`, [], c);
  return { test, archived };
}
async function archiveOne(clientId, c) {
  const until = new Date(); until.setFullYear(until.getFullYear() + RETAIN_YEARS);
  await db.q(`update clients set status='Archived', archived_at=now(), retain_until=$2 where client_id=$1 and status <> 'Archived'`, [clientId, ymd(until, 'UTC')], c);
  await db.q(`update users set active=false, session_ver=session_ver+1 where client_id=$1 and lower(role) in ('client','family','supporter')`, [clientId], c);
  await db.q(`delete from sessions where email in (select email from users where client_id=$1)`, [clientId], c);
}
// Only the families picked, and only if each one still passes the test rule at the moment of archiving.
async function archiveTestFamilies(ctx, p, c) {
  coOnly(ctx);
  const want = new Set((Array.isArray(p.clientIds) ? p.clientIds : []).map(String)); must(want.size, 'Pick at least one');
  const ok = (await testFamilyRows(c)).filter(r => want.has(String(r.client_id)));
  for (const r of ok) await archiveOne(r.client_id, c);
  return { ...(await familyRecords(ctx, p, c)), count: ok.length, skipped: want.size - ok.length };
}
async function reactivateClient(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.status === 'Archived', 'Not archived');
  await db.q(`update clients set status='Active', archived_at=null, retain_until=null where client_id=$1`, [cl.client_id], c);
  await db.q(`update users set active=true where client_id=$1 and lower(role) in ('client','family')`, [cl.client_id], c);   // supporters come back when the family re-adds them
  return { client: core.publicClient(await core.clientById(ctx.clientId, c)) };
}
// Everything on file for one family, as one JSON document (records request, transfer, or the archive copy).
async function exportClient(ctx) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId); must(cl, 'Not found');
  const tables = ['users', 'plan_items', 'tasks', 'goals', 'topics', 'messages', 'updates', 'circle', 'intake_answers', 'appointments', 'care_team', 'referrals', 'medications', 'doses', 'uploads', 'vendor_bills', 'assistance', 'recommendations', 'resource_views', 'transcripts'];
  const out = { exported_at: new Date().toISOString(), by: ctx.email, client: cl };
  for (const t of tables) out[t] = await db.all(`select * from ${t} where client_id=$1`, [cl.client_id]);
  if (out.users) out.users = out.users.map(u => { const { password_hash, ...rest } = u; return rest; });
  await core.securityAlert('a family record was exported', `${ctx.user.name || ctx.email} exported the full record for the ${cl.family_name} family.`, 'Exports are normal when a family leaves or asks for their records. If nobody asked for this one, look at the access log.');
  out.audit = await db.all(`select at, who, role, action, detail from audit where client_id=$1 order by at`, [cl.client_id]);
  return { b64: Buffer.from(JSON.stringify(out, null, 1)).toString('base64'), name: `Record - ${cl.family_name || cl.client_id} - ${ymd(new Date(), 'UTC')}.json` };
}
// The purge. Only for an archived family past its retention date, only by a coordinator, only with the family name typed back.
async function purgeClient(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  must(cl.status === 'Archived' && cl.retain_until && String(cl.retain_until) <= ymd(new Date(), 'UTC'), 'Only an archived family past its retention date can be purged');
  must(String(p.confirm || '').trim() === String(cl.family_name).trim(), 'Type the family name exactly to confirm');
  const storage = require('../storage');
  for (const u of await db.all(`select storage_key from uploads where client_id=$1 and storage_key is not null`, [cl.client_id], c)) await storage.remove(u.storage_key);
  for (const t of ['transcripts', 'doses', 'medications', 'messages', 'topics', 'plan_items', 'tasks', 'goals', 'updates', 'circle', 'intake_answers', 'appointments', 'care_team', 'referrals', 'uploads', 'vendor_bills', 'assistance', 'recommendations', 'resource_views'])
    await db.q(`delete from ${t} where client_id=$1`, [cl.client_id], c);
  await db.q(`delete from sessions where email in (select email from users where client_id=$1)`, [cl.client_id], c);
  await db.q(`delete from users where client_id=$1`, [cl.client_id], c);
  await db.q(`delete from clients where client_id=$1`, [cl.client_id], c);
  // The change history holds the records themselves, so it goes with them. The audit trail (ids only) stays.
  await db.q(`select set_config('app.purge', $1, true)`, [cl.client_id], c);
  await db.q(`delete from record_history where client_id=$1`, [cl.client_id], c);
  await core.securityAlert('a family record was purged', `${ctx.user.name || ctx.email} permanently deleted the ${cl.family_name} family's records after their retention period.`, '');
  return { purged: cl.client_id };
}

module.exports = { archiveClient, reactivateClient, exportClient, purgeClient, familyRecords, archiveTestFamilies };
