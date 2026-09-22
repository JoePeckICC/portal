'use strict';
// Ships security events to a SIEM over the Splunk-style HTTP Event Collector protocol (Huntress uses it).
// Off unless HUNTRESS_HEC_TOKEN is set. Never blocks a request: events queue in memory and go out in
// batches; if the collector is unreachable they are retried once and then dropped with a log line
// (Cloud Logging still has every event, so nothing is lost for the record).
const URL_ = process.env.HUNTRESS_HEC_URL || 'https://hec.huntress.io/services/collector';
const TOKEN = process.env.HUNTRESS_HEC_TOKEN || '';
const HOST = process.env.K_SERVICE || 'portal-api';
const SOURCE = process.env.HEC_SOURCE || 'incadence-portal';
const SOURCETYPE = process.env.HEC_SOURCETYPE || 'incadence:portal';
const BATCH = 100, EVERY_MS = 2000, MAX_QUEUE = 5000;

const queue = [];
let timer = null, sending = false;

const enabled = () => !!TOKEN;

function send(event) {
  if (!enabled()) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ time: Date.now() / 1000, host: HOST, source: SOURCE, sourcetype: SOURCETYPE, event });
  if (!timer) timer = setTimeout(flush, EVERY_MS);
}

async function post(body) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Splunk ' + TOKEN, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HEC ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

async function flush() {
  timer = null;
  if (sending || !queue.length) return;
  sending = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, BATCH);
      const body = batch.map(e => JSON.stringify(e)).join('\n');
      try { await post(body); }
      catch (e1) {
        await new Promise(r => setTimeout(r, 1500));
        try { await post(body); } catch (e2) { console.error(JSON.stringify({ severity: 'ERROR', hec: true, dropped: batch.length, error: e2.message })); }
      }
    }
  } finally { sending = false; if (queue.length && !timer) timer = setTimeout(flush, EVERY_MS); }
}

// Send one test event now and report what the collector said (used by `node tools/hec-test.js`).
async function selfTest() {
  if (!enabled()) throw new Error('HUNTRESS_HEC_TOKEN is not set');
  await post(JSON.stringify({ time: Date.now() / 1000, host: HOST, source: SOURCE, sourcetype: SOURCETYPE, event: { event: 'portal.test', outcome: 'success', message: 'InCadence portal -> Huntress HEC test' } }));
  return 'ok';
}

module.exports = { send, flush, enabled, selfTest };
