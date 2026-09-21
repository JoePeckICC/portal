'use strict';
// Scheduled work. Cloud Scheduler calls POST /jobs/<name> with the X-Jobs-Key header:
//   medReminders   every 15 minutes   dose reminders an hour before, 15 minutes before, and at the time
//   dailyDigest    hourly             each coordinator's digest at their hour; housekeeping
//   retention      daily              archived families past their retention date are listed (never deleted without a person)
const C = require('./config');
const db = require('./db');
const core = require('./core');
const mail = require('./mail');
const auth = require('./auth');
const { esc, ymd, hourIn, normEmail } = require('./util');
const { localToIso } = require('./time');

async function medReminders() {
  const now = new Date(), today = ymd(now, C.TZ);
  const meds = await db.all(`select m.*, c.status client_status from medications m join clients c on c.client_id=m.client_id where m.status='Accepted' and m.frequency<>'As needed' and trim(m.times)<>'' and c.status<>'Archived'`);
  const byClient = {};
  for (const m of meds) {
    for (let t of String(m.times).split(',')) {
      t = t.trim(); if (!/^\d{2}:\d{2}$/.test(t)) continue;
      const dueKey = today + 'T' + t, due = new Date(localToIso(dueKey));
      const taken = await db.one(`select 1 from doses where med_id=$1 and due_at=$2 and status='Taken'`, [m.med_id, due.toISOString()]);
      if (taken) continue;
      const mins = Math.round((due.getTime() - now.getTime()) / 60000); let kind = null;
      if (mins <= 60 && mins > 45) kind = 'hour'; else if (mins <= 15 && mins > 0) kind = 'soon'; else if (mins <= 0 && mins > -15) kind = 'now';
      if (!kind) continue;
      if ((await auth.bump('rem:' + m.med_id + ':' + dueKey + ':' + kind, 6 * 3600)) > 1) continue;     // once per med, dose and kind
      (byClient[m.client_id] = byClient[m.client_id] || []).push({ m, t, kind });
    }
  }
  const kinds = { hour: 'In an hour', soon: 'In 15 minutes', now: 'Now' };
  for (const cid of Object.keys(byClient)) {
    for (const k of ['now', 'soon', 'hour']) {
      const list = byClient[cid].filter(x => x.kind === k); if (!list.length) continue;
      const body = list.map(x => x.m.name + (x.m.dose ? ' ' + x.m.dose : '') + ' — ' + x.t + (x.m.instructions ? ' (' + x.m.instructions + ')' : '')).join('\n');
      await core.notifyFamily(cid, 'meds', kinds[k] + ': ' + (list.length === 1 ? list[0].m.name : list.length + ' medications'), k === 'now' ? 'Time to take:' : 'Coming up ' + kinds[k].toLowerCase() + ':', body + '\n\nCheck it off on your Home page once it is taken.', 'Open the portal');
    }
  }
  return { families: Object.keys(byClient).length };
}

// Sends each coordinator one email at their digest hour with everything queued since the last one. Also the daily housekeeping.
async function dailyDigest() {
  await auth.pruneSessions();
  await auth.pruneLogin();
  await db.q(`delete from rate_limits where window_end < now() - interval '1 day'`);
  const hour = hourIn(C.TZ), today = ymd(new Date(), C.TZ);
  if (hour === 4) await db.q(`delete from audit where at < now() - interval '366 days'`);
  let sent = 0;
  for (const u of await db.all(`select * from users where lower(role)='coordinator' and active`)) {
    const s = core.coSettings(u);
    if (hour < s.digestHour || s.lastDigest === today) continue;
    const rows = await db.all(`select * from digest where lower(coordinator)=$1 and sent_at is null order by created_at`, [normEmail(u.email)]);
    if (rows.length) {
      const groups = {}; rows.forEach(r => { (groups[r.kind] = groups[r.kind] || []).push(r); });
      let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1C2A3A;max-width:560px"><p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#C09B36;font-weight:700">${C.APP_NAME} · daily digest</p><p style="font-size:16px">${rows.length} thing${rows.length === 1 ? '' : 's'} since yesterday.</p>`;
      Object.keys(groups).forEach(k => { html += `<h3 style="font-size:14px;margin:18px 0 6px;border-bottom:1px solid #E3DED3;padding-bottom:4px">${esc(C.CO_KINDS[k] || k)} (${groups[k].length})</h3>`; groups[k].forEach(r => { html += `<p style="margin:0 0 10px;font-size:14px;line-height:1.45"><b>${esc(r.subject)}</b><br>${esc(r.lead)}${r.body ? '<br><span style="color:#5B6470;white-space:pre-wrap">' + esc(String(r.body).slice(0, 300)) + '</span>' : ''}</p>`; }); });
      html += `<p style="margin-top:20px"><a href="${C.PORTAL_URL}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:3px">Open the In Basket</a></p></div>`;
      await mail.sendMail(u.email, `${C.APP_NAME}: your digest — ${rows.length} item${rows.length === 1 ? '' : 's'}`, html);
      await db.q(`update digest set sent_at=now() where item_id = any($1)`, [rows.map(r => r.item_id)]);
      sent++;
    }
    s.lastDigest = today;
    await db.q(`update users set co_settings=$2 where email=$1`, [u.email, JSON.stringify(s)]);
  }
  return { sent };
}

// Archived families whose retention date has passed: emailed to the coordinator as a list. Nothing is deleted by a job.
async function retention() {
  const due = await db.all(`select client_id, family_name, archived_at, retain_until from clients where status='Archived' and retain_until is not null and retain_until <= current_date order by retain_until`);
  if (!due.length) return { due: 0 };
  for (const co of await db.all(`select email, name from users where lower(role)='coordinator' and active`)) {
    await mail.notify(co.email, `${due.length} archived famil${due.length === 1 ? 'y has' : 'ies have'} reached the retention date`, 'These records are past the date you set to keep them. Nothing has been deleted. Open the archive to review and purge when you are ready.', due.map(d => `${d.family_name} — archived ${String(d.archived_at).slice(0, 10)}, keep until ${d.retain_until}`).join('\n'), 'Open the portal');
  }
  return { due: due.length };
}

const JOBS = { medReminders, dailyDigest, retention };
async function run(name) {
  const fn = JOBS[name]; if (!fn) throw new Error('No such job');
  const t = Date.now();
  try { const out = await fn(); await core.audit({ email: 'system', role: 'job', clientId: '' }, name, out || {}, ''); return { ok: true, ms: Date.now() - t, ...out }; }
  catch (e) { await core.audit({ email: 'system', role: 'job', clientId: '' }, name, {}, e.message); throw e; }
}
module.exports = { run, JOBS };
