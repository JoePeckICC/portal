'use strict';
const crypto = require('crypto');

const normEmail = e => String(e || '').trim().toLowerCase();
const isTrue = v => v === true || String(v).toUpperCase() === 'TRUE' || String(v).toLowerCase() === 'yes';
const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const now = () => new Date();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const famName = n => { n = String(n || '').trim(); return /family$/i.test(n) ? 'The ' + n : 'The ' + n + ' family'; };
const must = (cond, msg) => { if (!cond) { const e = new Error(msg); e.expected = true; throw e; } };
const pick = (v, list, fallback) => (list.indexOf(v) >= 0 ? v : fallback);
const clean = (s, max) => { s = String(s == null ? '' : s).replace(/\s+$/, ''); return s.length > max ? s.slice(0, max) : s; };
const first = n => String(n || '').trim().split(' ')[0];
const ms = v => { const d = new Date(v); return isNaN(d) ? 0 : d.getTime(); };
const byAsc = k => (a, b) => (String(a[k]) < String(b[k]) ? -1 : 1);
const byDesc = k => (a, b) => (String(a[k]) > String(b[k]) ? -1 : 1);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Dates go over the wire as ISO strings, the way the Apps Script sent them (JSON.parse(JSON.stringify(...))).
const wire = o => JSON.parse(JSON.stringify(o));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
// yyyy-MM-dd in the portal's time zone
function ymd(d, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d || new Date());
  const g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`;
}
function hourIn(tz, d) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d || new Date()).replace(/\D/g, '')) % 24; }

module.exports = { normEmail, isTrue, id, now, esc, famName, must, pick, clean, first, ms, byAsc, byDesc, EMAIL_RE, wire, safeEqual, ymd, hourIn };
