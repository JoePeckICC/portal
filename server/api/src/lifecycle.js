'use strict';
// The family's email timeline after they pay, each month, and when they leave (added 2026-09-25).
//
// Every email here is sent once per family and recorded in lifecycle_sent, so a redeploy or a rerun
// never sends one twice. The timed ones go out from the hourly job at SEND_HOUR local time, and only
// inside their window, so a family who paid months before this existed never gets "day one" mail.
// The billing ones are sent as Stripe reports events (invoice coming, invoice paid, subscription ended).
//
// To change the wording, edit TEXT below. To stop everything, set the LIFECYCLE setting to "off"
// (Coordinator settings → Family emails). Families can turn the notes off under Notifications
// ("Notes from Joe"); the billing emails always go.
const C = require('./config');
const db = require('./db');
const mail = require('./mail');
const core = require('./core');
const { esc, first, hourIn, isTrue, famName } = require('./util');

const SEND_HOUR = 9;          // local hour for the timed notes
const DAY = 864e5;

// Timed notes: key, when (days after the anchor), how long the window stays open, and the text.
// paid: days since the first payment. ready: days since the plan was marked ready and not paid.
// gone: days since the subscription ended.
const TIMED = [
  { key: 'd0', anchor: 'paid', after: 0, window: 7, hours: 1, kind: 'notes', subject: 'A note from Joe', paras: [
    'This is Joe. Thank you for trusting us with {patient}’s road. I know what this week feels like from the other side of it.',
    'Two things to do today. Read the plan once, start to finish. Then write us one message in the portal about the thing that worries you most. That is where we start.',
    'Reply to this email any time. I read these myself.'], cta: 'Open the portal' },
  { key: 'd1', anchor: 'paid', after: 1, window: 7, kind: 'notes', subject: 'What you have now', paras: [
    'Plainly, here is what your membership includes, so nothing is a surprise.',
    'Your Cadence Plan, kept current as things change. Messages with {co}, answered by a person. {patient}’s medication list with reminders, if you want them. Letters to employers, schools and insurers when you need one. A Circle, so the people you choose get updates without you repeating yourself.',
    'Billing is month to month. You can pause or stop it yourself under Billing in the portal, no call needed.'], cta: 'See the plan' },
  { key: 'd3', anchor: 'paid', after: 3, window: 7, kind: 'notes', subject: 'Three habits that make this work', paras: [
    'Families who get the most from this do three small things.',
    'They open the portal with their morning coffee and look at Home. Two minutes. That is where the day’s doses and appointments are.',
    'They message us before they call the hospital. Most questions we can answer or route in an hour, and it saves you a hold queue.',
    'They add one person to the Circle this week. A sister, a neighbor, a pastor. Then that person stops calling you for updates.'], cta: 'Open the portal' },
  { key: 'd6', anchor: 'paid', after: 6, window: 7, kind: 'notes', subject: 'What the first weeks look like', paras: [
    'A word about pace. The plan will not feel finished in week one, and it is not supposed to. Surgery dates move. Discharge plans change the morning of. That is normal, and the plan is built to move with it.',
    'When something changes, tell us in a message and we update the plan the same day. When nothing has changed, you do not have to do anything. We are still here.',
    'Most families say the portal earns its keep in the week of surgery and the two weeks after. Give it that long before you judge it.'], cta: 'Open the portal' },
  { key: 'd10', anchor: 'paid', after: 10, window: 7, kind: 'notes', subject: 'Ten days in', paras: [
    'You have been with us ten days. One question, and a reply is enough:',
    'What is the one thing you needed this week that you did not get?',
    'I read every answer and most of them change something.'] },
  { key: 'm2', anchor: 'paid', after: 30, window: 14, kind: 'notes', active: true, subject: 'Month two', paras: [
    'Month two is usually the quiet-but-heavy stretch: the drama is over and the fatigue sets in. Nobody warns you about it, so I will. It is normal, it passes, and it is easier with one person to say it to. Say it to us.',
    'And if the quiet has you wondering whether you still need us, message me. Some families step down to a check-in a month. Some pause. We will find the right size.'], cta: 'Open the portal' },
  { key: 'm4', anchor: 'paid', after: 90, window: 14, kind: 'notes', active: true, subject: 'Month four', paras: [
    'Four months. By now the plan probably looks nothing like the first version, which is how it should be.',
    'One ask: tell us what has changed that we have not caught up with. A new appointment, a medication that stopped, a helper who moved away. Ten minutes on a message and the plan is current again.'], cta: 'Open the portal' },
  { key: 'm6', anchor: 'paid', after: 150, window: 14, kind: 'notes', active: true, subject: 'Month six', paras: [
    'Half a year. Thank you for staying with us that long.',
    'Some families are winding down about now, and that is a good sign. If {patient} is steady and the plan is mostly done, say so, and we will talk about pausing or stopping so you are not paying for a quiet month. If things are still moving, we are still here.'], cta: 'Open the portal' },
  { key: 'p3', anchor: 'ready', after: 3, window: 7, kind: 'notes', subject: 'Your plan is waiting', paras: [
    '{patient}’s Cadence Plan is written and waiting in the portal. Nothing happens to it until you open it, and it does not expire.',
    'If the amount is the thing in the way, say so. We adjust it per family, and no one is turned away for money.'], cta: 'Open my plan' },
  { key: 'p10', anchor: 'ready', after: 10, window: 7, kind: 'notes', subject: 'Checking in', paras: [
    'This is Joe. We met about {patient} a couple of weeks ago and I wanted to check in myself.',
    'If you went another way, that is fine, and I hope it is going well. If things got busy, the plan is still there and one click opens it. And if you are not sure it is worth it, reply and tell me what is holding you back. I would rather hear it than guess.'], cta: 'Open my plan' },
  { key: 'wb', anchor: 'gone', after: 45, window: 14, kind: 'notes', subject: 'Checking in on {patient}', paras: [
    'It has been about six weeks. No pitch, I just wanted to ask how {patient} is doing.',
    'If things have gotten complicated again, a follow-up surgery, a new diagnosis, a caregiver who is worn down, the door is open. Reply here or call me and we will pick the plan up where it left off. Your first month back is on me.'] },
];

const TEXT = {
  paused: { subject: 'Your billing is paused', paras: [
    'Billing is paused. Nothing is charged until you resume it, and nothing is lost: the plan, the messages, the medication list and {patient}’s record all stay where they are.',
    'Resume any time from the Billing page. If it would help to talk it through first, reply here.'], cta: 'Open the portal' },
  ended: { subject: 'Your membership has ended', paras: [
    'Your {app} membership has ended, and this is the last thing we will charge you for: nothing.',
    '{patient}’s record stays with us, private, for as long as the law requires, and you can ask for a copy any time. If you ever want to pick the plan back up, one click below brings it back the same day.',
    'Thank you for letting us walk part of this road with you. I hope {patient} is doing well.'], cta: 'Come back any time' },
  covered: { subject: 'This month is covered', lead: 'This month is covered. Thank you.', cta: 'See the plan' },
  renew: { cta: 'Open the portal', pause: 'Need a break? You can pause billing for a month from the Billing page, and everything stays where it is.', pauseLink: 'Pause or change billing' },
};
const WHY = { done: '{patient} is recovered', cost: 'The cost', use: 'Did not use it enough', other: 'Something else' };

// ---- pieces
const p = s => `<p style="font-size:16px;line-height:1.55;margin:0 0 16px">${esc(s)}</p>`;
const soft = (url, label) => `<p style="font-size:14px;margin:0 0 16px"><a href="${esc(url)}" style="color:#1C2A3A">${esc(label)}</a></p>`;
function fill(s, v) { return String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] == null ? '' : v[k])); }
async function vars(cl, u) {
  const co = await core.coordinatorFor(cl);
  return { name: u ? (u.goes_by || first(u.name) || 'there') : 'there', patient: cl.patient_first_name || 'your patient', co: co ? first(co.name) : 'your coordinator', app: C.APP_NAME, family: famName(cl.family_name) };
}
const fmtDay = d => new Intl.DateTimeFormat('en-US', { timeZone: C.TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(d);
const fmtWhen = d => new Intl.DateTimeFormat('en-US', { timeZone: C.TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
async function familyUsers(clientId) { return db.all(`select * from users where client_id=$1 and active and lower(role) in ('client','family')`, [clientId]); }
async function enabled() { try { const r = await db.one(`select value from settings where key='LIFECYCLE'`); return !r || r.value !== 'off'; } catch { return true; } }
async function setEnabled(on, c) { await db.q(`insert into settings (key,value) values ('LIFECYCLE',$1) on conflict (key) do update set value=excluded.value`, [on ? 'on' : 'off'], c); }

// Sends one email once per family. kind '' means it always goes (billing); otherwise the family's
// Notifications choice for that kind is honored, and a note nobody wanted is not counted as sent
// (so a family who turns the notes back on inside the window still gets it). Returns true when sent now.
async function sendOnce(cl, key, kind, build, c) {
  if (await db.one(`select 1 from lifecycle_sent where client_id=$1 and key=$2`, [cl.client_id, key], c)) return false;
  let n = 0;
  for (const u of await familyUsers(cl.client_id)) {
    if (kind && !core.prefs(u)[kind]) continue;
    const m = await build(u);
    if (!m) continue;
    await mail.sendMail(u.email, `${C.APP_NAME}: ${m.subject}`, mail.frame(m.html + mail.footer()));
    n++;
  }
  if (!n && kind) return false;
  const ins = await db.q(`insert into lifecycle_sent (client_id, key) values ($1,$2) on conflict do nothing`, [cl.client_id, key], c);
  await core.audit({ email: 'system', role: 'lifecycle', clientId: cl.client_id }, 'lifecycle:' + key, { kind: key, what: n + ' sent' }, '');
  return !!ins.rowCount;
}
// A letter from Joe: "Hi Sarah," then the paragraphs, "Joe", a button.
async function letter(cl, u, t, extra) {
  const v = await vars(cl, u);
  const html = p('Hi ' + v.name + ',') + t.paras.map(s => p(fill(s, v))).join('') + p('Joe') + (t.cta ? mail.button(t.url || C.PORTAL_URL, fill(t.cta, v)) : '') + (extra ? fill(extra, v) : '');
  return { subject: fill(t.subject, v), html };
}

// ---- the timed notes (hourly job)
async function timed(now) {
  now = now || new Date();
  if (!(await enabled())) return { sent: 0, off: true };
  const hour = hourIn(C.TZ, now);
  let sent = 0;
  const rows = await db.all(`select * from clients where status<>'Archived' and (paid_at is not null or plan_ready_at is not null or cancelled_at is not null)`);
  for (const cl of rows) {
    for (const t of TIMED) {
      const at = t.anchor === 'paid' ? cl.paid_at : t.anchor === 'ready' ? cl.plan_ready_at : cl.cancelled_at;
      if (!at) continue;
      if (t.anchor === 'paid' && (!isTrue(cl.paid) || cl.cancelled_at)) continue;
      if (t.anchor === 'ready' && isTrue(cl.paid)) continue;
      if (t.active && (cl.billing_status === 'Paused' || cl.billing_status === 'Cancelled')) continue;
      const age = now.getTime() - new Date(at).getTime();
      if (t.hours != null) { if (age < t.hours * 3600e3 || age > t.window * DAY) continue; }
      else { if (age < t.after * DAY || age > (t.after + t.window) * DAY || hour !== SEND_HOUR) continue; }
      if (await sendOnce(cl, t.key, t.kind, u => letter(cl, u, t))) sent++;
    }
  }
  return { sent };
}

// ---- Stripe events
// Three days before a monthly charge (invoice.upcoming): what the month held, what is next, pause before manage.
async function renewal(cl, inv) {
  if (!inv || !inv.subscription) return false;
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const [msgs, done, doing, next, todo] = await Promise.all([
    db.one(`select count(*)::int n from messages m where m.client_id=$1 and m.sent_at>$2 and m.sender_email in (select email from users where lower(role)='coordinator')`, [cl.client_id, since]),
    db.one(`select count(*)::int n from plan_items where client_id=$1 and status='Done' and updated_at>$2 and not draft`, [cl.client_id, since]),
    db.one(`select count(*)::int n from plan_items where client_id=$1 and status='In progress' and not draft`, [cl.client_id]),
    db.one(`select * from appointments where client_id=$1 and status<>'Cancelled' and starts_at>now() order by starts_at limit 1`, [cl.client_id]),
    db.all(`select item from plan_items where client_id=$1 and status<>'Done' and not draft order by target_date nulls last, updated_at limit 2`, [cl.client_id]),
  ]);
  const when = inv.next_payment_attempt || inv.period_end || inv.due_date;
  const day = when ? fmtDay(new Date(when * 1000)) : 'soon';
  const key = 'renew:' + (inv.period_end || inv.id || day);
  return sendOnce(cl, key, '', async u => {
    const v = await vars(cl, u);
    const held = [
      msgs.n ? msgs.n + (msgs.n === 1 ? ' message' : ' messages') + ' answered' : '',
      done.n || doing.n ? [done.n ? done.n + ' plan item' + (done.n === 1 ? '' : 's') + ' done' : '', doing.n ? doing.n + ' in progress' : ''].filter(Boolean).join(', ') : '',
      next ? v.patient + '’s next appointment: ' + fmtWhen(new Date(next.starts_at)) + (next.title ? ' (' + next.title + ')' : '') : '',
    ].filter(Boolean);
    const html = p('Hi ' + v.name + ',') +
      p('Your next month with ' + C.APP_NAME + ' starts ' + day + '.' + (held.length ? ' Here is what this month held:' : '')) +
      (held.length ? `<blockquote style="margin:0 0 16px;padding:12px 16px;border-left:3px solid #C09B36;background:#F6F4EF;font-size:15px;line-height:1.6">${held.map(esc).join('<br>')}</blockquote>` : '') +
      (todo.length ? p('Coming up: ' + todo.map(x => x.item).join('; ') + '.') : '') +
      mail.button(C.PORTAL_URL, TEXT.renew.cta) + p(TEXT.renew.pause) + soft(C.PORTAL_URL + '?go=billing', TEXT.renew.pauseLink);
    return { subject: 'Your next month starts ' + day, html };
  });
}
// A monthly payment after the first (invoice.paid, subscription_cycle): the month is covered, what is on the plan.
async function covered(cl, inv) {
  if (!inv || !inv.subscription || (inv.billing_reason && inv.billing_reason !== 'subscription_cycle')) return false;
  const todo = await db.all(`select item from plan_items where client_id=$1 and status<>'Done' and not draft order by target_date nulls last, updated_at limit 3`, [cl.client_id]);
  return sendOnce(cl, 'paid:' + inv.id, '', async u => {
    const v = await vars(cl, u);
    const html = p('Hi ' + v.name + ',') + p(TEXT.covered.lead) +
      (todo.length ? p('On the plan this month: ' + todo.map(x => x.item).join('; ') + '.') : '') +
      mail.button(C.PORTAL_URL, TEXT.covered.cta) + (inv.hosted_invoice_url ? soft(inv.hosted_invoice_url, 'Receipt') : '');
    return { subject: TEXT.covered.subject, html };
  });
}
// Billing paused (by the family or the coordinator).
async function paused(cl, c) {
  return sendOnce(cl, 'paused:' + new Date().toISOString().slice(0, 10), '', u => letter(cl, u, TEXT.paused), c);
}
// The subscription ended (customer.subscription.deleted): record it, tell the family, tell the coordinator.
async function ended(cl, sub) {
  const cd = (sub && sub.cancellation_details) || {};
  const reason = [cd.feedback && ({ too_expensive: 'Too expensive', missing_features: 'Missing something', switched_service: 'Went elsewhere', unused: 'Did not use it', customer_service: 'Customer service', too_complex: 'Too complicated', low_quality: 'Not good enough', other: 'Other' }[cd.feedback] || cd.feedback), cd.comment].filter(Boolean).join(' — ');
  await db.q(`update clients set cancelled_at=coalesce(cancelled_at, now()), billing_status='Cancelled', cancel_reason=$2 where client_id=$1`, [cl.client_id, reason || cl.cancel_reason || '']);
  await core.autoMsg(cl.client_id, 'Your membership has ended. Nothing more is charged. Your record stays, and you can come back any time from the Billing page.');
  const why = `<p style="font-size:14px;color:#5B6470;margin:0 0 16px">One click, if you are willing: why did you stop? ` + Object.keys(WHY).map(k => `<a href="${esc(C.PORTAL_URL + '?why=' + k)}" style="color:#1C2A3A">{why_${k}}</a>`).join(' · ') + `</p>`;
  const sentNow = await sendOnce(cl, 'ended:' + (sub && sub.id || 'x'), '', async u => {
    const v = await vars(cl, u); Object.keys(WHY).forEach(k => { v['why_' + k] = fill(WHY[k], v); });
    const t = { ...TEXT.ended, url: C.PORTAL_URL + '?go=billing' };
    const m = await letter(cl, u, t, why.replace(/\{(why_\w+)\}/g, (_, k) => esc(v[k])));
    return m;
  });
  const wbDay = fmtDay(new Date(Date.now() + 45 * DAY));
  await core.notifyCo(await core.coordinatorFor(cl), 'billing', 'Cancelled — ' + famName(cl.family_name), 'Their subscription was cancelled in Stripe.' + (reason ? ' Reason they gave: “' + reason + '.”' : ' No reason given.'), 'Records stay under retention. The 45-day check-in note is scheduled for ' + wbDay + '.', 'Open the portal');
  return sentNow;
}
// The one-click "why did you stop?" from the ended email.
async function leaveReason(ctx, p, c) {
  const k = String(p.why || ''); if (!WHY[k]) return { ok: true };
  const cl = await core.clientById(ctx.clientId, c); if (!cl) return { ok: true };
  const v = await vars(cl, null); const label = fill(WHY[k], v);
  await db.q(`update clients set cancel_reason=$2 where client_id=$1`, [cl.client_id, [cl.cancel_reason, 'Family said: ' + label].filter(Boolean).join(' / ')], c);
  await core.notifyCo(await core.coordinatorFor(cl), 'assist', 'Why they stopped — ' + famName(cl.family_name), (ctx.user.name || ctx.email) + ' answered the one-click question: ' + label, '', 'Open the portal');
  return { ok: true };
}

module.exports = { TIMED, TEXT, WHY, timed, renewal, covered, paused, ended, leaveReason, enabled, setEnabled, SEND_HOUR };
