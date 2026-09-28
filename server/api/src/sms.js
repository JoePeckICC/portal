'use strict';
// Text messages (2026-09-28): vendors live in their texts, so jobs and replies reach them there, with a link back
// into the portal. Texts carry no health information — a first name, a time, a town, a link. Everything else
// stays behind the sign-in. Sends through Twilio when TWILIO_SID, TWILIO_TOKEN and TWILIO_FROM are set;
// until then (and in tests) they land in `sent` and the log, and the email copy still goes out.
const sent = [];
function e164(v) { const d = String(v || '').replace(/\D/g, ''); if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return ''; }
async function send(to, body) {
  const num = e164(to); if (!num) return false;
  const sid = process.env.TWILIO_SID, tok = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !tok || !from) { sent.push({ to: num, body }); if (process.env.NODE_ENV !== 'test') console.log(JSON.stringify({ sms: 'not configured', to: '…' + num.slice(-4) })); return false; }
  try {
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: num, From: from, Body: body }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.error(JSON.stringify({ sms: 'failed', status: r.status, to: '…' + num.slice(-4) }));
    return r.ok;
  } catch (e) { console.error(JSON.stringify({ sms: 'error', error: e.message })); return false; }
}
module.exports = { send, sent, e164 };
