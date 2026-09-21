// Drives the running API the way 1,000 families' browsers would: sign-ins, bootstraps, messages, dose ticks, plus the coordinator's In Basket.
// Usage: API=http://localhost:8091 CONCURRENCY=50 SECONDS=60 node loadtest.js
'use strict';
const API = process.env.API || 'http://localhost:8091';
const CONC = Number(process.env.CONCURRENCY || 50), SECS = Number(process.env.SECONDS || 60), N = Number(process.env.FAMILIES || 1000);
const { Client } = require('pg');

const lat = {}; const rec = (k, ms, ok) => { (lat[k] = lat[k] || { t: [], err: 0 }); if (ok) lat[k].t.push(ms); else lat[k].err++; };
async function call(session, action, payload, tag) {
  const t = Date.now();
  try { const r = await fetch(API + '/api', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ session, action, payload }) }); const j = await r.json(); rec(tag || action, Date.now() - t, j.ok === true); return j; }
  catch (e) { rec(tag || action, Date.now() - t, false); return { ok: false, error: e.message }; }
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

(async () => {
  // Sessions are minted straight into the sessions table (the email leg is not what we are measuring).
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const fams = (await db.query(`select client_id from clients where paid order by client_id limit $1`, [N])).rows.map(r => r.client_id);
  const sessions = [];
  for (const cid of fams) { const r = await db.query(`insert into sessions (email, session_ver, expires_at) values ($1, 1, now() + interval '1 day') returning session_id`, [`${cid}.patient@example.com`.toLowerCase()]); sessions.push({ cid, s: r.rows[0].session_id }); }
  const co = (await db.query(`insert into sessions (email, session_ver, expires_at) values ('joe@incadencecare.com', 1, now() + interval '1 day') returning session_id`)).rows[0].session_id;
  await db.query(`delete from rate_limits`);
  await db.end();
  const topicOf = {};
  const end = Date.now() + SECS * 1000; let n = 0;
  async function worker(i) {
    while (Date.now() < end) {
      const f = sessions[(i + n++) % sessions.length];
      const b = await call(f.s, 'bootstrap', {});
      if (b.ok) { topicOf[f.cid] = topicOf[f.cid] || (b.topics.find(t => t.kind !== 'auto') || {}).topic_id; if (b.meds && b.meds.length) await call(f.s, 'takeDose', { medId: b.meds[1].med_id, dueAt: '2026-09-21T08:00' }); }
      if (topicOf[f.cid] && Math.random() < 0.3) await call(f.s, 'sendMessage', { topicId: topicOf[f.cid], body: 'Load test message ' + n });
      if (Math.random() < 0.2) await call(f.s, 'topicMessages', { topicId: topicOf[f.cid] });
    }
  }
  async function coordinator() {
    while (Date.now() < end) { await call(co, 'inbasket', {}); await call(co, 'bootstrap', { clientId: sessions[n % sessions.length].cid }, 'bootstrap(co)'); await new Promise(r => setTimeout(r, 2000)); }
  }
  const t0 = Date.now();
  await Promise.all([...Array.from({ length: CONC }, (_, i) => worker(i)), coordinator()]);
  const secs = (Date.now() - t0) / 1000;
  let total = 0, errs = 0;
  console.log(`concurrency ${CONC}, ${secs.toFixed(0)}s, ${N} families\n`);
  console.log('action            calls   err   p50    p95    p99   max (ms)');
  for (const k of Object.keys(lat)) { const l = lat[k]; total += l.t.length + l.err; errs += l.err; console.log(k.padEnd(16), String(l.t.length).padStart(6), String(l.err).padStart(5), String(pct(l.t, .5)).padStart(6), String(pct(l.t, .95)).padStart(6), String(pct(l.t, .99)).padStart(6), String(Math.max(0, ...l.t)).padStart(5)); }
  console.log(`\n${total} calls, ${errs} errors, ${(total / secs).toFixed(0)} calls/sec`);
})().catch(e => { console.error(e); process.exit(1); });
