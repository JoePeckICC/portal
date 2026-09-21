'use strict';
// One place that sends. Transport: Gmail API via the service account's domain-wide delegation: it acts as MAIL_AS (a real mailbox)
// and sends From: FROM_EMAIL (that mailbox's address, or one of its aliases such as care@).
// or, when MAIL_TRANSPORT=log (local/dev/tests), print to the console and keep a copy in memory.
const C = require('./config');
const { esc, normEmail } = require('./util');

const sent = [];                                   // dev/test inbox

async function gmailClient() {
  const { google } = require('googleapis');
  const auth = await require('./gauth').authFor(process.env.MAIL_AS || process.env.FROM_EMAIL || '', ['https://www.googleapis.com/auth/gmail.send']);
  return google.gmail({ version: 'v1', auth });
}

function mime({ to, from, bcc, subject, html }) {
  const text = html.replace(/<[^>]+>/g, '');
  const b = 'b' + Date.now().toString(36);
  const enc = s => Buffer.from(s, 'utf8').toString('base64');
  return [
    `From: ${C.APP_NAME} <${from}>`, `To: ${to}`, bcc ? `Bcc: ${bcc}` : null, `Subject: =?UTF-8?B?${enc(subject)}?=`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', enc(text), '',
    `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', enc(html), '', `--${b}--`,
  ].filter(l => l !== null).join('\r\n');
}

let fromCache = { at: 0, v: '' };
async function fromEmail() {
  if (C.FROM_EMAIL) return C.FROM_EMAIL;
  if (Date.now() - fromCache.at < 60000) return fromCache.v;
  try { const r = await require('./db').one(`select value from settings where key='FROM_EMAIL'`); fromCache = { at: Date.now(), v: r ? r.value : '' }; } catch { fromCache = { at: Date.now(), v: '' }; }
  return fromCache.v;
}
async function sendMail(to, subject, html) {
  const from = await fromEmail();
  const bcc = C.BCC_EMAIL && normEmail(C.BCC_EMAIL) !== normEmail(to) ? C.BCC_EMAIL : '';
  const msg = { to, from, bcc, subject, html, at: new Date() };
  if ((process.env.MAIL_TRANSPORT || 'log') === 'log') {
    sent.push(msg); if (process.env.NODE_ENV !== 'test') console.log(`[mail] to=${to} subject=${JSON.stringify(subject)}`);
    if (process.env.MAIL_DUMP) require('fs').appendFileSync(process.env.MAIL_DUMP, JSON.stringify(msg) + '\n');   // local end-to-end runs read links from here
    return;
  }
  const raw = Buffer.from(mime(msg)).toString('base64url');
  await (await gmailClient()).users.messages.send({ userId: 'me', requestBody: { raw } });
}

function frame(inner) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1C2A3A;max-width:520px"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#C09B36;font-weight:700">${C.APP_NAME}</p>${inner}</div>`;
}
const button = (url, label) => `<p><a href="${url}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:3px">${esc(label)}</a></p>`;
const footer = () => `<p style="margin-top:28px;font-size:12px;color:#5B6470;line-height:1.5;border-top:1px solid #E3DED3;padding-top:10px"><b style="color:#1C2A3A">${esc(C.APP_NAME)}</b> · ${esc(C.INCADENCE_PHONE)} · ${esc(C.INCADENCE_SITE)}<br>${esc(C.INCADENCE_ADDRESS)}</p>`;

// The standard notification: a lead line, an optional quoted body, a button.
async function notify(to, subject, lead, body, cta, url) {
  if (!to) return;
  url = url || C.PORTAL_URL;
  try {
    await sendMail(to, `${C.APP_NAME}: ${subject}`, frame(
      `<p style="font-size:16px;line-height:1.5">${esc(lead)}</p>` +
      (body ? `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #C09B36;background:#F6F4EF;white-space:pre-wrap;font-size:15px;line-height:1.5">${esc(body)}</blockquote>` : '') +
      button(url, cta) + footer()));
  } catch (e) { console.error('notify failed', to, e.message); }
}

module.exports = { sendMail, notify, frame, button, footer, sent };
