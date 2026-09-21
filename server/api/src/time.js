'use strict';
// Local-time helpers. The page reads appointment and dose times as "yyyy-MM-ddTHH:mm" in the portal's time zone (what the Sheet held).
const C = require('./config');
// The page reads starts_at as "yyyy-MM-ddTHH:mm" in the portal's time zone (what the Sheet held). Convert both ways here.
function localToIso(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00';
  const [d, t] = s.split('T'); const [y, m, day] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  const off = tzOffsetMs(new Date(guess));
  return new Date(guess - off).toISOString();
}
function tzOffsetMs(d) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: C.TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = t => Number(f.find(x => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - d.getTime();
}
function localStamp(v) {
  if (!v) return '';
  const d = new Date(v); if (isNaN(d)) return String(v);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: C.TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = t => f.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${String(g('hour') % 24).padStart(2, '0')}:${g('minute')}`;
}
const apptPublic = a => ({ ...a, starts_at: localStamp(a.starts_at) });

module.exports = { localToIso, localStamp, apptPublic, tzOffsetMs };
