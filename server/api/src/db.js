'use strict';
const { Pool, types } = require('pg');
// Dates stay as 'yyyy-mm-dd' strings (no time-zone drift) and numerics become numbers, the way the page expects them.
types.setTypeParser(1082, v => v);
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));

// One pool per process. Cloud Run + Cloud SQL: DATABASE_URL uses the unix socket (/cloudsql/<instance>).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL || 8), idleTimeoutMillis: 30000 });
pool.on('error', e => console.error('pg pool error', e.message));

const q = (text, params, client) => (client || pool).query(text, params);
const one = async (text, params, client) => (await q(text, params, client)).rows[0] || null;
const all = async (text, params, client) => (await q(text, params, client)).rows;

// Runs fn inside a transaction. Writes that touch one family also take that family's advisory lock,
// so two requests for the same family never interleave (the Apps Script used one global lock; this is per family).
async function tx(fn, lockKey, actor) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (actor) await c.query(`select set_config('app.who', $1, true), set_config('app.role', $2, true), set_config('app.ip', $3, true)`, [String(actor.email || ''), String(actor.role || ''), String(actor.ip || '')]);
    if (lockKey) await c.query('select pg_advisory_xact_lock(hashtext($1))', [String(lockKey)]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) { try { await c.query('rollback'); } catch {} throw e; }
  finally { c.release(); }
}

// insert one row from an object; returns the row.
async function insert(table, obj, client) {
  const keys = Object.keys(obj);
  const sql = `insert into ${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`;
  return one(sql, keys.map(k => obj[k]), client);
}
// update rows matching `where` (object, ANDed) with `patch` (object); returns updated rows.
async function update(table, where, patch, client) {
  const pk = Object.keys(patch), wk = Object.keys(where);
  if (!pk.length) return [];
  const sets = pk.map((k, i) => `${k}=$${i + 1}`).join(',');
  const conds = wk.map((k, i) => `${k}=$${pk.length + i + 1}`).join(' and ');
  return all(`update ${table} set ${sets} where ${conds} returning *`, [...pk.map(k => patch[k]), ...wk.map(k => where[k])], client);
}

module.exports = { pool, q, one, all, tx, insert, update };
