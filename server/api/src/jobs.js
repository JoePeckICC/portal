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
const { esc, ymd, hourIn, normEmail, famName, first } = require('./util');
const { localToIso } = require('./time');

async function medReminders() {
  try { await core.flushHeld(); } catch (e) { console.error('flushHeld', e.message); }
  try { await reflections(); } catch (e) { console.error('reflections', e.message); }
  try { await require('./handlers/recordings').checkTranscripts(); } catch (e) { console.error('transcripts', e.message); }
  try { await require('./handlers/jobs').circleSweep(); } catch (e) { console.error('circle sweep', e.message); }   // casting calls whose time is up
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
      const body = list.map(x => x.m.name + (x.m.dose ? ' ' + x.m.dose : '') + ', ' + x.t + (x.m.instructions ? ' (' + x.m.instructions + ')' : '')).join('\n');
      await core.notifyFamily(cid, 'meds', kinds[k] + ': ' + (list.length === 1 ? 'a medication' : list.length + ' medications'), k === 'now' ? 'Time to take:' : 'Coming up ' + kinds[k].toLowerCase() + ':', body + '\n\nCheck it off on your Home page once it is taken.', 'Open the portal');
    }
  }
  return { families: Object.keys(byClient).length };
}

// Sends each coordinator one email at their digest hour with everything queued since the last one. Also the daily housekeeping.
async function dailyDigest() {
  let notes = { sent: 0 }; try { notes = await require('./lifecycle').timed(); } catch (e) { console.error('lifecycle', e.message); }
  await auth.pruneSessions();
  await auth.pruneLogin();
  await db.q(`delete from rate_limits where window_end < now() - interval '1 day'`);
  const hour = hourIn(C.TZ), today = ymd(new Date(), C.TZ);
  if (hour === 4) await db.q(`delete from audit where at < now() - interval '366 days'`);
  if (hour === 9) { try { await intakeNudges(); } catch (e) { console.error('nudge', e.message); } try { await twoDayReminders(); } catch (e) { console.error('twoDay', e.message); } try { await quietFamilies(); } catch (e) { console.error('quiet', e.message); } try { await circleNudges(); } catch (e) { console.error('circleNudge', e.message); } }
  try { await hospitalQuiet(); } catch (e) { console.error('hospitalQuiet', e.message); }
  if (hour === 16) { try { await weekCheck(); } catch (e) { console.error('weekCheck', e.message); } }
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
      await mail.sendMail(u.email, `${C.APP_NAME}: your digest, ${rows.length} item${rows.length === 1 ? '' : 's'}`, html);
      await db.q(`update digest set sent_at=now() where item_id = any($1)`, [rows.map(r => r.item_id)]);
      sent++;
    }
    s.lastDigest = today;
    await db.q(`update users set co_settings=$2 where email=$1`, [u.email, JSON.stringify(s)]);
  }
  return { sent, notes: notes.sent };
}

// Two days before a booked meeting with the coordinator: one reminder, with the three things to have ready. Once per booking.
async function twoDayReminders() {
  const rows = await db.all(`select a.* from appointments a where a.status<>'Cancelled' and a.starts_at >= now() + interval '36 hours' and a.starts_at < now() + interval '60 hours'
    and not exists (select 1 from lifecycle_sent s where s.client_id=a.client_id and s.key='r2:'||a.appt_id)`);
  let sent = 0;
  for (const a of rows) {
    const { localStamp } = require('./time');
    await core.notifyFamily(a.client_id, 'booking', 'In two days: ' + a.title, a.title + ' is ' + localStamp(a.starts_at) + (a.location ? ' · ' + a.location : '') + '.',
      'Three things to have ready:\n1. Your questions, written down, the ones you think of at 2 am.\n2. The newest papers from the hospital or the surgeon, photographed if that is easier.\n3. Who else should be on the call, and whether they can make it.\n\nIf the time no longer works, change it in the portal under Care.', 'Open the portal');
    await db.q(`insert into lifecycle_sent (client_id, key) values ($1, $2) on conflict do nothing`, [a.client_id, 'r2:' + a.appt_id]); sent++;
  }
  return { sent };
}
// Intake not finished: a short "still here when you are ready" every two days from day 2, and nothing after day 14.
async function intakeNudges() {
  const rows = await db.all(`select c.* from clients c where lower(c.status) not in ('closed','archived') and c.created_at < now() - interval '2 days' and c.created_at > now() - interval '14 days'
    and coalesce((select answer from intake_answers i where i.client_id=c.client_id and i.question_id='_status'), '') not like 'Submitted%' and coalesce((select answer from intake_answers i where i.client_id=c.client_id and i.question_id='_status'), '') not like 'Updated%'`);
  let sent = 0;
  for (const cl of rows) {
    const day = Math.floor((Date.now() - new Date(cl.created_at).getTime()) / 864e5); if (day % 2) continue;
    const key = 'ia:' + day;
    const done = await db.one(`select 1 from lifecycle_sent where client_id=$1 and key=$2`, [cl.client_id, key]); if (done) continue;
    const co = await core.coordinatorFor(cl);
    await core.notifyFamily(cl.client_id, 'notes', 'Still here when you are ready', 'Your form is saved where you left it. Finish it when there is a quiet ten minutes, or answer the short version now and the rest later.', (co ? first(co.name) + ' is' : 'We are') + ' not going anywhere. Nothing happens on our side until you say so.', 'Open the form');
    await db.q(`insert into lifecycle_sent (client_id, key) values ($1, $2) on conflict do nothing`, [cl.client_id, key]); sent++;
  }
  return { sent };
}
// A few hours after an appointment: "how did it go?", three lines in the check-in, while it is fresh.
async function reflections() {
  const rows = await db.all(`select a.* from appointments a where a.status<>'Cancelled' and a.starts_at < now() - interval '2 hours' and a.starts_at > now() - interval '5 hours'
    and not exists (select 1 from lifecycle_sent s where s.client_id=a.client_id and s.key='rf:'||a.appt_id)`);
  let sent = 0;
  for (const a of rows) {
    await core.notifyFamily(a.client_id, 'booking', 'How did it go?, ' + a.title, 'While it is fresh: what did they say, what did you not get to ask, what changed?', 'Three lines in today’s check-in on your Home page is enough. Your coordinator reads it and follows up on anything left open.', 'Open the portal');
    await db.q(`insert into lifecycle_sent (client_id, key) values ($1, $2) on conflict do nothing`, [a.client_id, 'rf:' + a.appt_id]); sent++;
  }
  return { sent };
}
// The Circle is waiting: sharing is on, people are following, and nothing has gone out in two days. One nudge, then quiet for two more.
async function circleNudges() {
  const rows = await db.all(`select c.* from clients c where c.circle_enabled and lower(c.status) not in ('closed','archived') and c.current_stage in ('The day of surgery','At the hospital','In surgery','ICU','On the way home','Home')
    and exists (select 1 from circle x where x.client_id=c.client_id and x.status='Active')
    and coalesce((select max(u.posted_at) from updates u where u.client_id=c.client_id and u.visible_to_circle), c.created_at) < now() - interval '2 days'
    and coalesce((c.extra->>'circle_nudge_at')::timestamptz, now() - interval '100 days') < now() - interval '2 days'`);
  for (const cl of rows) {
    const n = (await db.one(`select count(*)::int n from circle where client_id=$1 and status='Active'`, [cl.client_id])).n;
    const last = (await db.one(`select max(posted_at) d from updates where client_id=$1 and visible_to_circle`, [cl.client_id])).d;
    await core.notifyFamily(cl.client_id, 'message', 'The Circle has not heard in two days', n + (n === 1 ? ' person is' : ' people are') + ' following ' + (first(cl.patient_first_name) || 'the family') + ' and nothing has gone out ' + (last ? 'since the last update' : 'yet') + '. One line is enough, “quiet day, resting” counts. Or move the tracker; that posts for you.', '', 'Post an update');
    await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('circle_nudge_at', now()::text) where client_id=$1`, [cl.client_id]);
  }
  return { nudged: rows.length };
}
// A quiet stretch in the hospital (Joe 2026-09-29): the tracker is on a hospital step and nothing has been posted for
// 6 hours (3 during surgery). Checked hourly from 7 AM to 11 PM. At 11 PM the bar drops to 2 hours: a surgery that runs
// late must not leave the Circle going to bed with no word because whoever posts fell asleep (Joe's own family lived this).
// Once per stretch, plus the 11 PM check once a night: the coordinator is told (to call the family), and the family gets
// one line asking for a short update before they sleep.
const HOSP = ['On the way', 'In pre-op', 'In surgery', 'In recovery', 'In a room'];
async function hospitalQuiet(anyHour) {
  const h = hourIn(C.TZ), night = anyHour === 'night' || h === 23; if (!anyHour && (h < 7 || h > 23)) return { flagged: 0 };
  const rows = await db.all(`select c.*, greatest((c.extra->'tracker'->>'at')::timestamptz, (select max(u.posted_at) from updates u where u.client_id=c.client_id)) last_at
    from clients c where c.circle_enabled and lower(c.status) not in ('closed','archived') and c.extra->'tracker'->>'stage' = any($1)`, [HOSP]);
  let n = 0;
  for (const cl of rows) {
    const stage = cl.extra.tracker.stage, hrs = night ? 2 : stage === 'In surgery' ? 3 : 6, last = cl.last_at ? new Date(cl.last_at) : null;
    if (!last || Date.now() - last < hrs * 36e5) continue;
    const mark = night ? 'hosp_night_at' : 'hosp_quiet_at';
    if (cl.extra[mark] && new Date(cl.extra[mark]) > last) continue;
    const hh = Math.round((Date.now() - last) / 36e5), pf = first(cl.patient_first_name) || 'the patient';
    if (night) {
      await core.notifyCo(await core.coordinatorFor(cl), 'quiet', 'Before bed: no update in ' + hh + ' hours, ' + famName(cl.family_name), pf + ' is at “' + stage + '” and the Circle has not heard in ' + hh + ' hours. People are about to go to bed without news. Call the family, or post a short line yourself.', '', 'Open the chart');
      // Straight out, not held for the morning like other family email after 10 PM: this one only matters tonight.
      for (const u of await db.all(`select * from users where client_id=$1 and active and lower(role) in ('client','family')`, [cl.client_id]))
        if (core.prefs(u).message) await mail.notify(u.email, 'One line before you sleep?', 'The Circle has not heard in ' + hh + ' hours and people are going to bed. One line is enough: “Out of surgery, resting. More in the morning.”', '', 'Post an update');
    } else {
      await core.notifyCo(await core.coordinatorFor(cl), 'quiet', 'No update in ' + hh + ' hours, ' + famName(cl.family_name), pf + ' is at “' + stage + '” and nothing has been posted for ' + hh + ' hours. The Circle sees a calm “no news” line. A call to the family, then a short post, closes the gap.', '', 'Open the chart');
      await core.notifyFamily(cl.client_id, 'message', 'A short update for the Circle?', 'Nothing has gone out in ' + hh + ' hours. One line is enough: “Resting. More in the morning.” People are waiting on you, kindly.', '', 'Post an update');
    }
    await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object($2::text, now()::text) where client_id=$1`, [cl.client_id, mark]); n++;
  }
  return { flagged: n };
}
// Sunday at 4 PM (Joe 2026-09-29): the people who hold the page get one note asking if the week ahead looks right.
// Once per week per family, and not if someone already confirmed it. The home screen shows the same check.
async function weekCheck(force) {
  const today = ymd(new Date(), C.TZ); if (!force && new Date(today + 'T12:00:00Z').getUTCDay() !== 0) return { asked: 0 };
  const wk = require('./handlers/shifts').weekOf(today);
  const rows = await db.all(`select c.* from clients c where c.circle_enabled and c.paid and lower(c.status) not in ('closed','archived') and coalesce(c.current_stage,'')<>'Finding wisdom'
    and coalesce(c.extra->'week_ok'->>'week','') <> $1 and coalesce(c.extra->>'week_ask_for','') <> $1`, [wk]);
  for (const cl of rows) {
    const pf = first(cl.patient_first_name) || 'your';
    for (const u of await db.all(`select * from users where client_id=$1 and active and (lower(role)='client' or (lower(role)='family' and coalesce(extra->>'delegate','')='true'))`, [cl.client_id]))
      if (core.prefs(u).message) await mail.notify(u.email, 'Does next week look right?', 'Take a minute with the plan for ' + (pf === 'your' ? 'your' : pf + '’s') + ' week: appointments, who is staying, meals and rides. If it matches what you expect, one tap confirms it and your inner circle hears the plan is set.', '', 'Check the week');
    await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('week_ask_for', $2::text) where client_id=$1`, [cl.client_id, wk]);
  }
  return { asked: rows.length };
}
// A paid family nobody has heard from: no sign-in and no message for QUIET_DAYS. The coordinator gets one note, then not again for another stretch.
async function quietFamilies() {
  const rows = await db.all(`select c.* from clients c where c.paid and c.plan_ready and lower(c.status) not in ('closed','archived') and coalesce(c.current_stage,'')<>'Finding wisdom'
    and coalesce((select max(a.at) from audit a where a.client_id=c.client_id and lower(a.role) in ('client','family')), now() - interval '100 days') < now() - ($1 || ' days')::interval
    and coalesce((select max(m.sent_at) from messages m where m.client_id=c.client_id and m.sender_email<>'system' and m.sender_email<>c.coordinator_email), now() - interval '100 days') < now() - ($1 || ' days')::interval
    and coalesce((c.extra->>'quiet_alert_at')::timestamptz, now() - interval '100 days') < now() - ($1 || ' days')::interval`, [String(C.QUIET_DAYS)]);
  for (const cl of rows) {
    const co = await core.coordinatorFor(cl);
    await core.notifyCo(co, 'quiet', 'Gone quiet, ' + famName(cl.family_name), 'Nobody from the ' + cl.family_name + ' household has signed in or written in ' + C.QUIET_DAYS + ' days. Stage: ' + (cl.current_stage || 'Not set') + '. A call is usually the right move.', '', 'Open the chart');
    await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('quiet_alert_at', now()::text) where client_id=$1`, [cl.client_id]);
  }
  return { flagged: rows.length };
}

// Archived families whose retention date has passed: emailed to the coordinator as a list. Nothing is deleted by a job.
async function retention() {
  try { await require('./handlers/market').logNeeds(); } catch (e) { console.error('needs log', e.message); }   // the needs log rebuilds daily with this job
  const due = await db.all(`select client_id, family_name, archived_at, retain_until from clients where status='Archived' and retain_until is not null and retain_until <= current_date order by retain_until`);
  if (!due.length) return { due: 0 };
  for (const co of await db.all(`select email, name from users where lower(role)='coordinator' and active`)) {
    await mail.notify(co.email, `${due.length} archived famil${due.length === 1 ? 'y has' : 'ies have'} reached the retention date`, 'These records are past the date you set to keep them. Nothing has been deleted. Open the archive to review and purge when you are ready.', due.map(d => `${d.family_name}, archived ${String(d.archived_at).slice(0, 10)}, keep until ${d.retain_until}`).join('\n'), 'Open the portal');
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
module.exports = { run, JOBS, hospitalQuiet, weekCheck };
