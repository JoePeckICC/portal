'use strict';
// The access log: who viewed or changed what, for one family or one person, over a date range.
// Coordinators only. Reads the audit trail (every action, ids only) and the record history
// (before/after of every clinical and financial row) and returns them as one timeline.
const db = require('../db');
const { must, normEmail } = require('../util');

const PAGE = 200;
const HIDE = ['updated_at', 'created_at', 'session_ver', 'extra'];
const LABEL = {
  clients: 'Family record', users: 'Account', plan_items: 'Plan item', tasks: 'Task', goals: 'Goal', topics: 'Message topic', messages: 'Message',
  updates: 'Update', circle: 'Circle member', intake_answers: 'Intake answer', appointments: 'Appointment', care_team: 'Care team member',
  referrals: 'Referral', medications: 'Medication', doses: 'Dose', uploads: 'Document', vendor_bills: 'Vendor bill', assistance: 'Assistance program', recommendations: 'Recommendation',
};
const SIGNIN = { login: 1, loginCodeSent: 1, loginCode: 1, setPassword: 1, resetPassword: 1, changePassword: 1, openPasswordLink: 1, signOutEverywhere: 1, forgetDevices: 1, hello: 1 };

function kindOf(action) { if (SIGNIN[action]) return 'sign-in'; if (require('./index').READ_ONLY[action] || action === 'openFile') return 'view'; return 'change'; }

// Only what changed, and never the fields that carry nothing a person would want to see.
function diff(before, after) {
  const out = {}; const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (HIDE.includes(k)) continue;
    const b = before ? before[k] : undefined, a = after ? after[k] : undefined;
    if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = { from: trim(b), to: trim(a) };
  }
  return out;
}
const trim = v => v === undefined || v === null ? null : typeof v === 'string' ? v.slice(0, 300) : v;

async function accessLog(ctx, p) {
  must(ctx.role === 'coordinator', 'Not allowed');
  const clientId = String(p.clientId || ctx.clientId || '').trim();
  const email = normEmail(p.email || '');
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(p.from || '')) ? p.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(p.to || '')) ? p.to : null;
  const page = Math.max(0, Number(p.page) || 0);
  must(clientId || email, 'Pick a family or enter an email');
  const where = [], args = [];
  if (clientId) { args.push(clientId); where.push(`client_id=$${args.length}`); }
  if (email) { args.push(email); where.push(`lower(who)=$${args.length}`); }
  if (from) { args.push(from); where.push(`at >= ($${args.length}::date)::timestamptz`); }
  if (to) { args.push(to); where.push(`at < ($${args.length}::date + 1)::timestamptz`); }
  const w = where.join(' and ');
  args.push(PAGE, page * PAGE);
  const rows = await db.all(`
    select at, who, role, ip, 'audit' as src, action, null as table_name, null as row_id, null as op, detail, error, null as before, null as after
      from audit where ${w}
    union all
    select at, who, role, ip, 'history', op, table_name, row_id, op, null, '', before, after
      from record_history where ${w}
    order by at desc limit $${args.length - 1} offset $${args.length}`, args);
  const entries = rows.map(r => r.src === 'audit'
    ? { at: r.at, who: r.who, role: r.role, ip: r.ip, kind: r.error ? 'failed' : kindOf(r.action), action: r.action, detail: r.detail, error: r.error }
    : { at: r.at, who: r.who || 'system', role: r.role || 'system', ip: r.ip, kind: 'change', action: r.op, record: LABEL[r.table_name] || r.table_name, rowId: r.row_id,
        changes: r.op === 'update' ? diff(r.before, r.after) : r.op === 'insert' ? diff(null, r.after) : diff(r.before, null) });
  return { entries, page, more: rows.length === PAGE };
}

module.exports = { accessLog };
