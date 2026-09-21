// Copies every tab of the portal Google Sheet into Postgres.
// Safe to run repeatedly: rows are upserted by primary key, so re-running before cutover
// just brings the database up to date.
//
// Usage:
//   SHEET_ID=... GOOGLE_APPLICATION_CREDENTIALS=sa.json DATABASE_URL=postgres://... node migrate.js [--dry]
//   or: node migrate.js --from-json export.json   (export.json = { "Users": [[hdr...],[row...]], ... })
//
// Reads the Sheet with a service account that has Viewer access to the file (no OAuth click needed).

'use strict';
const { Client } = require('pg');

// Sheet tab -> table, plus per-column casting. Columns not listed keep their name and are cast by
// the table's column type; columns the table doesn't have go into `extra` (jsonb).
const MAP = {
  Clients:         { table: 'clients',        key: ['client_id'] },
  Users:           { table: 'users',          key: ['email'],  fix: r => ({ ...r, email: lower(r.email) }) },
  Links:           { table: 'sign_in_tokens', key: ['nonce'] },
  Plan:            { table: 'plan_items',     key: ['plan_id'] },
  Tasks:           { table: 'tasks',          key: ['task_id'] },
  Goals:           { table: 'goals',          key: ['goal_id'] },
  Topics:          { table: 'topics',         key: ['topic_id'] },
  Messages:        { table: 'messages',       key: ['message_id'] },
  Updates:         { table: 'updates',        key: ['update_id'] },
  Circle:          { table: 'circle',         key: ['circle_id'] },
  Intake:          { table: 'intake_answers', key: ['client_id', 'question_id'] },
  Appointments:    { table: 'appointments',   key: ['appt_id'] },
  CareTeam:        { table: 'care_team',      key: ['member_id'] },
  Referrals:       { table: 'referrals',      key: ['referral_id'] },
  Medications:     { table: 'medications',    key: ['med_id'] },
  Doses:           { table: 'doses',          key: ['dose_id'] },
  Uploads:         { table: 'uploads',        key: ['upload_id'] },
  VendorBills:     { table: 'vendor_bills',   key: ['bill_id'] },
  Assistance:      { table: 'assistance',     key: ['program_id'] },
  Resources:       { table: 'resources',      key: ['resource_id'] },
  Recommendations: { table: 'recommendations',key: ['rec_id'] },
  ResourceViews:   { table: 'resource_views', key: ['view_id'] },
  Digest:          { table: 'digest',         key: ['item_id'] },
  Audit:           { table: 'audit',          key: null },       // append-only; audit_id is generated
};
// Load order matters for foreign keys.
const ORDER = ['Clients', 'Users', 'Links', 'Plan', 'Tasks', 'Goals', 'Topics', 'Messages', 'Updates', 'Circle', 'Intake',
  'Appointments', 'CareTeam', 'Referrals', 'Medications', 'Doses', 'Uploads', 'VendorBills', 'Assistance',
  'Resources', 'Recommendations', 'ResourceViews', 'Digest', 'Audit'];

const lower = s => String(s || '').trim().toLowerCase();
const TZ = process.env.TZ_NAME || 'America/Chicago';
// The Sheet held local stamps like "2026-09-28T14:00" (no zone). Those are portal-time, not UTC.
function tzOffsetMs(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = t => Number(f.find(x => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - d.getTime();
}
function naiveToDate(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return new Date(s);                                   // has a zone (Z / +hh:mm) or another format: trust it
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return new Date(guess - tzOffsetMs(new Date(guess)));
}
const TRUE = /^(true|yes|1|x)$/i;

function cast(type, v) {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'string' ? v.trim() : v;
  if (s === '') return null;
  switch (type) {
    case 'boolean': return typeof s === 'boolean' ? s : TRUE.test(String(s));
    case 'integer': case 'bigint': { const n = parseInt(s, 10); return Number.isFinite(n) ? n : null; }
    case 'numeric': { const n = parseFloat(String(s).replace(/[$,]/g, '')); return Number.isFinite(n) ? n : null; }
    case 'date': { const d = new Date(String(s).length === 10 ? s + 'T00:00:00' : s); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
    case 'timestamp with time zone': { const d = naiveToDate(String(s)); return d && !isNaN(d) ? d.toISOString() : null; }
    case 'jsonb': { if (typeof s === 'object') return JSON.stringify(s); try { JSON.parse(s); return s; } catch { return JSON.stringify(s); } }
    default: return String(s);
  }
}

async function columnTypes(db, table) {
  const { rows } = await db.query(
    `select column_name, data_type, column_default, is_nullable from information_schema.columns where table_schema='public' and table_name=$1`, [table]);
  const t = {}; rows.forEach(r => { t[r.column_name] = r; }); return t;
}

function toObjects(values) {
  if (!values || values.length < 2) return [];
  const hdr = values[0].map(h => String(h || '').trim());
  return values.slice(1).filter(r => r.some(c => String(c ?? '').trim() !== '')).map(r => {
    const o = {}; hdr.forEach((h, i) => { if (h) o[h] = r[i]; }); return o;
  });
}

async function upsert(db, spec, cols, objs, dry) {
  const names = Object.keys(cols).filter(c => !['audit_id', 'extra'].includes(c));
  let n = 0, skipped = 0;
  for (const raw of objs) {
    const r = spec.fix ? spec.fix(raw) : raw;
    const row = {}, extra = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === '_row') continue;
      if (cols[k]) row[k] = cast(cols[k].data_type, v); else if (String(v ?? '').trim() !== '') extra[k] = v;
    }
    if (spec.key && spec.key.some(k => row[k] === null || row[k] === undefined)) { skipped++; continue; }
    // Required text columns default to '' — never insert null into them.
    for (const c of names) if (row[c] === null && cols[c].is_nullable === 'NO') {
      if (cols[c].data_type === 'text') row[c] = '';
      else if (cols[c].column_default != null) delete row[c];      // let the database default apply
    }
    const keys = names.filter(c => c in row);
    if (cols.extra) { keys.push('extra'); row.extra = JSON.stringify(extra); }
    const vals = keys.map(k => row[k]);
    const ph = keys.map((_, i) => `$${i + 1}`).join(',');
    let sql = `insert into ${spec.table} (${keys.join(',')}) values (${ph})`;
    if (spec.key) sql += ` on conflict (${spec.key.join(',')}) do update set ${keys.filter(k => !spec.key.includes(k)).map(k => `${k}=excluded.${k}`).join(',') || `${spec.key[0]}=excluded.${spec.key[0]}`}`;
    if (!dry) await db.query(sql, vals);
    n++;
  }
  return { n, skipped };
}

async function readSheet() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
  const tabs = meta.data.sheets.map(s => s.properties.title).filter(t => MAP[t]);
  const res = await sheets.spreadsheets.values.batchGet({ spreadsheetId: process.env.SHEET_ID, ranges: tabs, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  const out = {}; res.data.valueRanges.forEach((vr, i) => { out[tabs[i]] = vr.values || []; }); return out;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const ji = process.argv.indexOf('--from-json');
  const data = ji > 0 ? JSON.parse(require('fs').readFileSync(process.argv[ji + 1], 'utf8')) : await readSheet();
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const report = [];
  try {
    if (!dry) await db.query('begin');
    for (const tab of ORDER) {
      if (!data[tab]) { report.push([tab, 'missing tab', 0, 0]); continue; }
      const spec = MAP[tab], cols = await columnTypes(db, spec.table);
      if (spec.key === null && !dry) await db.query(`delete from ${spec.table}`);   // audit: full reload
      const { n, skipped } = await upsert(db, spec, cols, toObjects(data[tab]), dry);
      report.push([tab, spec.table, n, skipped]);
    }
    if (!dry) await db.query('commit');
  } catch (e) { if (!dry) await db.query('rollback'); throw e; } finally { await db.end(); }
  const w = Math.max(...report.map(r => r[0].length));
  console.log((dry ? 'DRY RUN — nothing written\n' : '') + report.map(([t, tb, n, s]) => `${t.padEnd(w)}  -> ${tb.padEnd(16)} ${String(n).padStart(6)} rows${s ? `  (${s} skipped: missing key)` : ''}`).join('\n'));
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
