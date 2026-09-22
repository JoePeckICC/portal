'use strict';
// End-to-end against a real Postgres (DATABASE_URL). Loads the schema + fixture, then drives api() like the page does.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret';
process.env.MAIL_TRANSPORT = 'log';
process.env.UPLOAD_DIR = require('os').tmpdir() + '/portal-test-uploads';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const db = require('../src/db');
const { api } = require('../src/app');
const mail = require('../src/mail');
const auth = require('../src/auth');

const ROOT = path.join(__dirname, '..', '..');
test.before(async () => {
  await db.q('drop schema public cascade; create schema public');
  execSync(`psql "${process.env.DATABASE_URL}" -v ON_ERROR_STOP=1 -q -f ${ROOT}/db/schema.sql`, { stdio: 'pipe' });
  execSync(`node ${ROOT}/migrate/migrate.js --from-json ${ROOT}/migrate/fixture.json`, { stdio: 'pipe', env: process.env });
  await require('../src/upgrade').run();
});
test.after(async () => { await require('../src/pdf').close(); await db.pool.end(); });

const lastMail = () => mail.sent[mail.sent.length - 1];
const linkFrom = m => decodeURIComponent(m.html.match(/\?t=([^"]+)"/)[1]);

const PW = 'correct horse battery staple';
const devices = {};   // email -> remembered-device token, like the page keeps in localStorage
const codeFrom = m => m.html.match(/letter-spacing:\.2em;margin:18px 0">(\d{6})</)[1];

// First time for an email: emailed link -> choose a password (device remembered).
// After that: email + password on the remembered device.
async function signIn(email) {
  await db.q(`delete from rate_limits`);
  email = email.toLowerCase();
  if (devices[email]) {
    const r = await api(null, 'login', { email, password: PW, device: devices[email] }, { ip: '1.1.1.1' });
    assert.equal(r.ok, true, r.error); assert.ok(r.session, 'remembered device goes straight in');
    return r.session;
  }
  const r = await api(null, 'requestLink', { email });
  assert.equal(r.ok, true);
  const h = await api(null, 'hello', { t: linkFrom(lastMail()) });
  assert.equal(h.ok, true); assert.ok(h.boot.pwset, 'link opens the set-password screen');
  const s = await api(null, 'setPassword', { token: h.boot.pwset.token, password: PW });
  assert.equal(s.ok, true, s.error); assert.ok(s.session); assert.ok(s.device);
  devices[email] = s.device;
  return s.session;
}

test('hello without a token returns constants and no session', async () => {
  const h = await api(null, 'hello', {});
  assert.equal(h.ok, true); assert.equal(h.boot.appName, 'InCadence Care'); assert.equal(h.boot.session, null); assert.equal(h.boot.error, null);
});

test('requestLink is quiet for unknown emails and sends for known ones', async () => {
  await db.q(`delete from rate_limits`);
  const n = mail.sent.length;
  const r1 = await api(null, 'requestLink', { email: 'nobody@example.com' });
  assert.equal(r1.ok, true); assert.equal(mail.sent.length, n);
  const r2 = await api(null, 'requestLink', { email: 'PAT@example.com' });
  assert.equal(r2.ok, true); assert.equal(mail.sent.length, n + 1); assert.equal(lastMail().to, 'pat@example.com');
});

test('an emailed link works once and never signs in by itself', async () => {
  await db.q(`delete from rate_limits`);
  await api(null, 'requestLink', { email: 'pat@example.com' });
  const tok = linkFrom(lastMail());
  const h1 = await api(null, 'hello', { t: tok }); assert.equal(h1.boot.session, null); assert.ok(h1.boot.pwset);
  const h2 = await api(null, 'hello', { t: tok }); assert.equal(h2.boot.pwset, undefined); assert.match(h2.boot.error, /expired or was already used/);
});

test('passwords: first-time setup, rules, and the set-password link works once', async () => {
  await db.q(`delete from rate_limits`);
  const email = 'kiddo@example.com';
  await db.q(`insert into users (email,name,role,client_id) values ($1,'Kid Test','family','c1') on conflict do nothing`, [email]);
  assert.match((await api(null, 'login', { email, password: PW }, { ip: '2.2.2.2' })).error, /do not match/, 'no password yet');
  await api(null, 'requestLink', { email });
  assert.match(lastMail().subject, /Set up your/);
  const h = await api(null, 'hello', { t: linkFrom(lastMail()) });
  assert.equal(h.boot.pwset.reset, false);
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'short' })).error, /12 characters/);
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'kiddo-kiddo-kiddo-1' })).error, /email address out/);
  const ok = await api(null, 'setPassword', { token: h.boot.pwset.token, password: PW });
  assert.equal(ok.ok, true); assert.ok(ok.session); assert.ok(ok.device);
  assert.equal((await api(null, 'setPassword', { token: h.boot.pwset.token, password: PW + '!' })).expired, true, 'the link is spent');
  const row = await db.one(`select password_hash from users where email=$1`, [email]);
  assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes(PW), 'stored scrambled');
  devices[email] = ok.device;
});

test('passwords: a new device needs the emailed code; a remembered one does not', async () => {
  await db.q(`delete from rate_limits`);
  const email = 'kiddo@example.com';
  const r = await api(null, 'login', { email, password: PW }, { ip: '3.3.3.3' });
  assert.equal(r.ok, true); assert.equal(r.needCode, true); assert.ok(!r.session, 'no session before the code');
  assert.match(r.sentTo, /^k\*\*\*o@example\.com$/);
  const code = codeFrom(lastMail());
  const wrong = code === '000000' ? '111111' : '000000';
  assert.match((await api(null, 'verifyCode', { challenge: r.challenge, code: wrong })).error, /4 tries left/);
  const v = await api(null, 'verifyCode', { challenge: r.challenge, code });
  assert.equal(v.ok, true); assert.ok(v.session); assert.ok(v.device);
  assert.equal((await api(null, 'verifyCode', { challenge: r.challenge, code })).expired, true, 'a code works once');
  const again = await api(null, 'login', { email, password: PW, device: v.device }, { ip: '3.3.3.3' });
  assert.ok(again.session, 'remembered device skips the code');
  const other = await api(null, 'login', { email, password: PW, device: devices['pat@example.com'] }, { ip: '3.3.3.3' });
  assert.equal(other.needCode, true, "someone else's device token does not count");
});

test('passwords: five wrong tries pause the account, for known and unknown emails alike', async () => {
  await db.q(`delete from rate_limits`);
  for (const email of ['kiddo@example.com', 'ghost@example.com']) {
    for (let i = 0; i < 4; i++) assert.match((await api(null, 'login', { email, password: 'nope nope nope' }, { ip: '4.4.4.4' })).error, /do not match/);
    assert.match((await api(null, 'login', { email, password: 'nope nope nope' }, { ip: '4.4.4.4' })).error, /Too many tries/);
  }
  assert.match((await api(null, 'login', { email: 'kiddo@example.com', password: PW, device: devices['kiddo@example.com'] }, { ip: '4.4.4.4' })).error, /Too many tries/, 'even the right password waits');
  await api(null, 'requestLink', { email: 'kiddo@example.com' });
  assert.match(lastMail().subject, /Reset your/);
  const h = await api(null, 'hello', { t: linkFrom(lastMail()) });
  const s = await api(null, 'setPassword', { token: h.boot.pwset.token, password: PW });
  assert.equal(s.ok, true, 'resetting clears the pause'); devices['kiddo@example.com'] = s.device;
  await db.q(`update users set active=false where email='kiddo@example.com'`);   // keep later message tests' recipient lists as they were
});

test('passwords: changing it keeps this browser and signs out the rest', async () => {
  const a = await signIn('pat@example.com'); const b = await signIn('pat@example.com');
  assert.match((await api(a, 'changePassword', { current: 'wrong wrong wrong', next: PW + ' two' })).error, /current password/);
  assert.match((await api(a, 'changePassword', { current: PW, next: 'short' })).error, /12 characters/);
  assert.equal((await api(a, 'changePassword', { current: PW, next: PW + ' two' })).ok, true);
  assert.equal((await api(a, 'bootstrap', {})).ok, true, 'this browser stays in');
  assert.equal((await api(b, 'bootstrap', {})).error, 'signed_out', 'others are out');
  assert.equal((await api(a, 'changePassword', { current: PW + ' two', next: PW })).ok, true);
  const rows = await db.all(`select detail from audit where action in ('changePassword','login','setPassword')`);
  assert.ok(rows.every(r => !JSON.stringify(r.detail).includes(PW)), 'passwords never reach the audit');
});

test('rate limit: one link a minute, quietly', async () => {
  await db.q(`delete from rate_limits`);
  const n = mail.sent.length;
  await api(null, 'requestLink', { email: 'pat@example.com' });
  await api(null, 'requestLink', { email: 'pat@example.com' });
  assert.equal(mail.sent.length, n + 1);
});

test('bootstrap for a paid patient carries the whole chart', async () => {
  const s = await signIn('pat@example.com');
  const b = await api(s, 'bootstrap', {});
  assert.equal(b.ok, true); assert.equal(b.me.role, 'client'); assert.equal(b.client.client_id, 'c1'); assert.equal(b.client.paid, true);
  assert.equal(b.plan.length, 0, 'draft plan items are hidden from the family');
  assert.equal(b.tasks.length, 1); assert.equal(b.topics.length, 1); assert.equal(b.messages.length, 2);
  assert.equal(b.meds.length, 1); assert.equal(b.doses.length, 2, 'upcoming doses are carried');
  assert.equal(b.uploads.length, 1); assert.equal(b.coordinator.email, 'joe@incadencecare.com');
  assert.equal(b.recommended.title, 'What to pack'); assert.equal(b.intake.answers['G.6'].a, '2026-10-02');
  assert.equal(typeof b.messages[0].sent_at, 'string', 'dates travel as strings');
});

test('an unpaid family sees billing + intake only', async () => {
  await db.q(`insert into users (email,name,role,client_id) values ('sam@example.com','Sam Second','client','c2')`);
  const s = await signIn('sam@example.com');
  const b = await api(s, 'bootstrap', {});
  assert.equal(b.ok, true); assert.equal(b.client.paid, false); assert.ok(b.billing); assert.ok(b.intakeSpec); assert.equal(b.tasks, undefined);
  const t = await api(s, 'newTopic', { kind: 'question' });
  assert.equal(t.ok, false); assert.match(t.error, /first payment/);
});

test('families cannot see each other', async () => {
  const s = await signIn('sam@example.com');
  await db.q(`update clients set paid=true where client_id='c2'`);
  const b = await api(s, 'bootstrap', { clientId: 'c1' });          // trying to pick another family
  assert.equal(b.client.client_id, 'c2');
  const m = await api(s, 'topicMessages', { topicId: 'tp1' });     // c1's topic
  assert.equal(m.ok, true); assert.equal(m.messages.length, 0);
  const r = await api(s, 'readTopic', { topicId: 'tp1' });
  assert.equal(r.ok, true);
  const still = await db.one(`select read_by_client from messages where message_id='m2'`);
  assert.equal(still.read_by_client, false, 'other family\'s message untouched');
});

test('coordinator picks a family; messaging round-trip notifies the right people', async () => {
  const co = await signIn('joe@incadencecare.com');
  const b = await api(co, 'bootstrap', { clientId: 'c1' });
  assert.equal(b.ok, true); assert.equal(b.me.role, 'coordinator'); assert.equal(b.families.length, 2); assert.ok(b.intakeFlags); assert.equal(b.plan.length, 1, 'coordinator sees drafts');
  const n = mail.sent.length;
  const t = await api(co, 'newTopic', { clientId: 'c1', kind: 'plan' });
  assert.equal(t.ok, true); assert.equal(t.topic.title, 'About the plan');
  const m = await api(co, 'sendMessage', { clientId: 'c1', topicId: t.topic.topic_id, body: 'Plan is ready to look at.' });
  assert.equal(m.ok, true); assert.equal(m.message.read_by_coordinator, true); assert.equal(m.message.read_by_client, false);
  const tos = mail.sent.slice(n).map(x => x.to).sort();
  assert.deepEqual(tos, ['pat@example.com', 'sis@example.com'], 'patient + inner circle, not the coordinator');
  // the patient replies: coordinator (digest by default) + the sister get it
  const pat = await signIn('pat@example.com');
  const n2 = mail.sent.length;
  const r = await api(pat, 'sendMessage', { topicId: t.topic.topic_id, body: 'Thanks!', urgent: true });
  assert.equal(r.ok, true); assert.equal(r.message.urgent, true);
  const tos2 = mail.sent.slice(n2).map(x => x.to).sort();
  assert.deepEqual(tos2, ['joe@incadencecare.com', 'sis@example.com'], 'urgent goes to the coordinator instantly');
  const read = await api(pat, 'readTopic', { topicId: t.topic.topic_id });
  assert.equal(read.ok, true);
  const row = await db.one(`select read_by_client from messages where message_id=$1`, [m.message.message_id]);
  assert.equal(row.read_by_client, true);
});

test('supporters only get updates', async () => {
  const s = await signIn('aunt@example.com').catch(() => null);
  assert.equal(s, null, 'aunt is in the circle table but has no user row yet');
  const co = await signIn('joe@incadencecare.com');
  await db.q(`update clients set circle_enabled=false where client_id='c2'`);
  const a = await api(co, 'addCircle', { clientId: 'c2', email: 'uncle@example.com', name: 'Uncle', relationship: 'Uncle' });
  assert.equal(a.ok, false, 'circle is off for c2');
  await db.q(`update clients set circle_enabled=true where client_id='c2'`);
  const a2 = await api(co, 'addCircle', { clientId: 'c2', email: 'uncle@example.com', name: 'Uncle', relationship: 'Uncle' });
  assert.equal(a2.ok, true);
  const u = await signIn('uncle@example.com');
  const b = await api(u, 'bootstrap', {});
  assert.equal(b.ok, true); assert.equal(b.me.role, 'supporter'); assert.equal(b.tasks, undefined); assert.ok(Array.isArray(b.updates));
  const t = await api(u, 'newTopic', { kind: 'question' });
  assert.equal(t.error, 'Not allowed');
  const rm = await api(co, 'removeCircle', { clientId: 'c2', circleId: a2.member.circle_id });
  assert.equal(rm.ok, true);
  const gone = await api(u, 'bootstrap', {});
  assert.equal(gone.error, 'signed_out', 'removed supporter is signed out');
});

test('sign out everywhere kills every session', async () => {
  const s1 = await signIn('pat@example.com'); const s2 = await signIn('pat@example.com');
  const r = await api(s1, 'signOutEverywhere', {});
  assert.equal(r.ok, true); assert.equal(r.self, true);
  assert.equal((await api(s1, 'bootstrap', {})).error, 'signed_out');
  assert.equal((await api(s2, 'bootstrap', {})).error, 'signed_out');
});

test('every view is logged, the log is append-only, and history keeps before/after', async () => {
  const co = await signIn('joe@incadencecare.com'); const pat = await signIn('pat@example.com');
  await db.q(`delete from audit where who='pat@example.com' and action='topicMessages'`).catch(() => {});
  const topics = (await api(pat, 'bootstrap', {})).topics || [];
  if (topics.length) { await api(pat, 'topicMessages', { topicId: topics[0].topic_id }); }
  await api(pat, 'billing', {});
  const views = await db.all(`select action from audit where who='pat@example.com' and action in ('billing','topicMessages','bootstrap') and at > now() - interval '1 minute'`);
  assert.ok(views.some(v => v.action === 'billing') && views.some(v => v.action === 'bootstrap'), 'views are in the audit trail');
  await assert.rejects(db.q(`delete from audit where who='pat@example.com'`), /append-only/, 'audit rows cannot be deleted');
  await assert.rejects(db.q(`update audit set who='x' where who='pat@example.com'`), /append-only/, 'audit rows cannot be changed');
  // a change lands in the history with who + before/after
  const t = await api(co, 'addTask', { clientId: 'c1', title: 'History test task', due: '2026-12-24' });
  const id = t.task.task_id;
  assert.equal((await api(co, 'setTaskStatus', { clientId: 'c1', taskId: id, status: 'Done' })).ok, true);
  const h = await db.all(`select who, role, op, before, after from record_history where table_name='tasks' and row_id=$1 order by history_id`, [id]);
  assert.equal(h.length, 2); assert.equal(h[0].op, 'insert'); assert.equal(h[0].who, 'joe@incadencecare.com'); assert.equal(h[0].role, 'coordinator'); assert.equal(h[0].after.title, 'History test task');
  assert.equal(h[1].op, 'update'); assert.equal(h[1].before.status, 'Not started'); assert.equal(h[1].after.status, 'Done');
  await assert.rejects(db.q(`delete from record_history where row_id=$1`, [id]), /append-only/);
  const users = await db.all(`select before, after from record_history where table_name='users' and row_id='pat@example.com'`);
  assert.ok(users.length && users.every(r => !(r.before && r.before.password_hash) && !(r.after && r.after.password_hash)), 'password hashes never enter the history');
  // the access log shows it to the coordinator, and to nobody else
  const log = await api(co, 'accessLog', { clientId: 'c1' });
  assert.equal(log.ok, true); assert.ok(log.entries.length > 0);
  assert.ok(log.entries.some(e => e.kind === 'view' && e.who === 'pat@example.com'), 'views appear');
  assert.ok(log.entries.some(e => e.record === 'Task' && e.changes && e.changes.status && e.changes.status.to === 'Done'), 'record changes appear with the changed fields');
  const byPerson = await api(co, 'accessLog', { clientId: '', email: 'pat@example.com', from: '2020-01-01' });
  assert.ok(byPerson.entries.length > 0 && byPerson.entries.every(e => e.who === 'pat@example.com'));
  assert.equal((await api(pat, 'accessLog', { clientId: 'c1' })).ok, false, 'families cannot read the log');
});

test('security alerts reach the coordinator: lockout and export', async () => {
  await db.q(`delete from rate_limits`);
  const n = mail.sent.length;
  for (let i = 0; i < 5; i++) await api(null, 'login', { email: 'pat@example.com', password: 'wrong wrong wrong' }, { ip: '9.9.9.9' });
  const alert = mail.sent.slice(n).find(m => /Security: account paused/.test(m.subject));
  assert.ok(alert && alert.to === 'joe@incadencecare.com', 'lockout alert goes to the coordinator');
  await db.q(`delete from rate_limits`);
  const co = await signIn('joe@incadencecare.com');
  const n2 = mail.sent.length;
  const ex = await api(co, 'exportClient', { clientId: 'c1' });
  assert.equal(ex.ok, true); const doc = JSON.parse(Buffer.from(ex.b64, 'base64').toString()); assert.ok(doc.users.length && doc.users.every(u => u.password_hash === undefined), 'exports never carry password hashes');
  assert.ok(mail.sent.slice(n2).some(m => /Security: a family record was exported/.test(m.subject)));
});

test('audit records actions with ids only', async () => {
  const rows = await db.all(`select action, who, detail from audit where action in ('sendMessage','setPassword','login') order by at desc limit 40`);
  assert.ok(rows.length >= 2);
  const sm = rows.find(r => r.action === 'sendMessage');
  assert.ok(sm.detail.topicId); assert.equal(sm.detail.body, undefined, 'message bodies never reach the audit');
});

test('unknown actions answer cleanly', async () => {
  const s = await signIn('pat@example.com');
  const u = await api(s, 'nope', {});
  assert.equal(u.error, 'Unknown action');
});

test('pdfs render and booking degrades when the calendar is off', async () => {
  const co = await signIn('joe@incadencecare.com'); const pat = await signIn('pat@example.com');
  const pp = await api(co, 'planPdf', { clientId: 'c1' });
  assert.equal(pp.ok, true, pp.error); assert.ok(Buffer.from(pp.b64, 'base64').slice(0, 4).toString() === '%PDF'); assert.match(pp.name, /^Cadence Plan - /);
  await db.q(`update clients set plan_ready=false where client_id='c1'`);
  assert.match((await api(pat, 'planPdf', {})).error, /not ready/);
  await db.q(`update clients set plan_ready=true where client_id='c1'`);
  const sp = await api(pat, 'summaryPdf', {}); assert.equal(sp.ok, true, sp.error); assert.match(sp.name, /^Health summary/);
  const lt = await api(co, 'writeLetter', { clientId: 'c1', to: 'HR at Acme', subject: 'Leave dates', body: 'Pat will be out.\n\nThanks.' });
  assert.equal(lt.ok, true, lt.error); assert.equal(lt.upload.kind, 'Letters');
  const sl = await api(pat, 'slots', { date: '2026-09-25', kind: 'quick' });
  assert.equal(sl.ok, true); assert.equal(sl.closed, true);
  assert.match((await api(pat, 'book', { kind: 'quick', startsAt: '2026-09-25T15:00:00Z', mode: 'phone', phone: '615' })).error, /not switched on/);
});

test('plan, tasks, goals, appointments, care team, referrals', async () => {
  const co = await signIn('joe@incadencecare.com');
  const pat = await signIn('pat@example.com');
  // plan: coordinator adds; family sees it; draft approve/discard
  const a = await api(co, 'addPlanItem', { clientId: 'c1', item: 'Pick up the walker', stage: 'Before surgery', category: 'Care coordination' });
  assert.equal(a.ok, true); assert.equal(a.item.draft, false);
  const d = await api(co, 'approvePlanItem', { clientId: 'c1', planId: 'p1', discard: true }); assert.equal(d.ok, true);
  const bp = await api(pat, 'bootstrap', {});
  assert.deepEqual(bp.plan.map(x => x.item), ['Pick up the walker']);
  const bc = await api(co, 'bootstrap', { clientId: 'c1' });
  assert.equal(bc.plan.length, 1, 'discarded drafts vanish for the coordinator too');
  const st = await api(co, 'setPlanStatus', { clientId: 'c1', planId: a.item.plan_id, status: 'Done' }); assert.equal(st.ok, true);
  assert.equal(lastMail().subject, 'InCadence Care: Done: Pick up the walker');
  // tasks: family may only tick their own
  const t = await api(co, 'addTask', { clientId: 'c1', title: 'Call the pharmacy', owner: 'Pat', due_date: '2026-09-30' });
  assert.equal(t.ok, true); assert.equal(t.task.due_date, '2026-09-30');
  const t2 = await api(co, 'addTask', { clientId: 'c1', title: 'Send referral', owner: 'Joe' }); assert.equal(t2.ok, true);
  assert.equal((await api(pat, 'setTaskStatus', { taskId: t.task.task_id, status: 'Done' })).ok, true);
  assert.equal((await api(pat, 'setTaskStatus', { taskId: t2.task.task_id, status: 'Done' })).error, 'Not allowed');
  assert.equal((await api(pat, 'setTaskStatus', { taskId: t.task.task_id, status: 'Blocked' })).error, 'Not allowed');
  // goals
  const g = await api(pat, 'addGoal', { title: 'Walk to the mailbox' }); assert.equal(g.ok, true);
  assert.equal((await api(pat, 'setGoalStatus', { goalId: g.goal.goal_id, status: 'Done' })).ok, true);
  // appointments keep portal-local times
  const ap = await api(co, 'addAppointment', { clientId: 'c1', title: 'Pre-op labs', starts_at: '2026-09-29T09:30', location: 'VUMC' });
  assert.equal(ap.ok, true); assert.equal(ap.appointment.starts_at, '2026-09-29T09:30');
  const row = await db.one(`select starts_at from appointments where appt_id=$1`, [ap.appointment.appt_id]);
  assert.equal(new Date(row.starts_at).toISOString(), '2026-09-29T14:30:00.000Z', 'stored as UTC (Chicago is -5 in September)');
  const b2 = await api(pat, 'bootstrap', {});
  assert.ok(b2.appointments.some(x => x.starts_at === '2026-09-29T09:30'));
  assert.equal((await api(pat, 'cancelAppointment', { apptId: ap.appointment.appt_id })).ok, false, 'family cannot cancel a coordinator-added visit');
  assert.equal((await api(co, 'cancelAppointment', { clientId: 'c1', apptId: ap.appointment.appt_id })).ok, true);
  // care team + referrals
  const ct = await api(pat, 'addCareTeam', { name: 'Dr. Lee', role: 'Neurologist' }); assert.equal(ct.ok, true);
  assert.equal((await api(pat, 'removeCareTeam', { memberId: ct.member.member_id })).ok, true);
  const rf = await api(co, 'addReferral', { clientId: 'c1', vendor: 'Acme Home Health', service: 'Aide' }); assert.equal(rf.ok, true);
  assert.equal((await api(pat, 'setReferralStatus', { referralId: rf.referral.referral_id, status: 'Contacted' })).ok, true);
  const auto = await db.one(`select count(*)::int n from messages where client_id='c1' and sender_email='system'`);
  assert.ok(auto.n >= 3, 'automated notes were written for appointment, cancel, referral');
});

test('intake: consent, answers, submit seeds the plan and pings the coordinator', async () => {
  await db.q(`insert into users (email,name,role,client_id) values ('sam@example.com','Sam Second','client','c2') on conflict (email) do nothing`);
  const sam = await signIn('sam@example.com');
  const spec = (await api(sam, 'bootstrap', {})).intakeSpec;
  const bad = await api(sam, 'submitIntake', {}); assert.match(bad.error, /sign the consent/);
  const cs = await api(sam, 'signConsent', { consent: { initials: spec.consent.map(() => 'SS'), name: 'Sam Second', relationship: 'Self' } });
  assert.equal(cs.ok, true); assert.equal(cs.intake.status, 'In progress'); assert.equal(cs.intake.consent.name, 'Sam Second');
  const answers = {};
  spec.steps.forEach(st => st.qs.forEach(q => { if (q.req && !q.showIf) answers[q.id] = { a: q.type === 'choice' ? q.opts[0] : q.type === 'date' ? '2026-11-03' : 'x' }; }));
  answers['A.2'] = { a: 'Lives alone' }; answers['L.1'] = { a: "We haven't sorted that out yet" };
  const sv = await api(sam, 'saveIntake', { answers }); assert.equal(sv.ok, true);
  const n = mail.sent.length;
  const sub = await api(sam, 'submitIntake', {});
  assert.equal(sub.ok, true, sub.error); assert.equal(sub.intake.status, 'Submitted'); assert.ok(sub.drafts >= 3, 'draft plan items were seeded');
  const digest = await db.one(`select count(*)::int n from digest where coordinator='joe@incadencecare.com' and kind='intake'`);
  assert.equal(digest.n, 1, 'intake pings go to the digest by default');
  const cl = await db.one(`select surgery_date from clients where client_id='c2'`);
  assert.equal(cl.surgery_date, '2026-11-03', 'surgery date carried onto the client');
  const co = await signIn('joe@incadencecare.com');
  const b = await api(co, 'bootstrap', { clientId: 'c2' });
  assert.ok(b.intakeFlags.some(f => /Lives alone/.test(f.label)));
  assert.ok(b.plan.every(p => p.draft === true), 'seeded items are drafts');
});

test('record: visit notes, allergies, pharmacy, documents, help', async () => {
  const co = await signIn('joe@incadencecare.com');
  const pat = await signIn('pat@example.com');
  assert.equal((await api(co, 'saveAllergies', { clientId: 'c1', allergies: 'Penicillin' })).ok, true);
  const ph = await api(pat, 'savePharmacy', { pharmacy_name: 'Walgreens', pharmacy_phone: '615-555-0199' });
  assert.equal(ph.client.pharmacy_name, 'Walgreens');
  const vn = await api(co, 'saveVisitNote', { clientId: 'c1', apptId: 'a1', note: 'BP fine. Cleared for surgery.' });
  assert.equal(vn.ok, true);
  const bp = await api(pat, 'bootstrap', {});
  assert.equal(bp.allergies, 'Penicillin'); assert.equal(bp.appointments.find(a => a.appt_id === 'a1').visit_note, 'BP fine. Cleared for surgery.');
  // documents: upload, family visibility, served through the API with a session check
  const up = await api(pat, 'uploadDoc', { kind: 'Insurance', name: 'card.txt', type: 'text/plain', b64: Buffer.from('member 12345').toString('base64'), shared: false });
  assert.equal(up.ok, true); assert.equal(up.upload.shared, false); assert.match(up.upload.url, /^\/files\//);
  const sis = await signIn('sis@example.com');
  const bs = await api(sis, 'bootstrap', {});
  assert.ok(!bs.uploads.some(u => u.upload_id === up.upload.upload_id), 'unshared file hidden from family members');
  assert.equal((await api(co, 'setDoc', { clientId: 'c1', uploadId: up.upload.upload_id, shared: true, kind: 'Forms' })).ok, true);
  const bs2 = await api(sis, 'bootstrap', {});
  assert.equal(bs2.uploads.find(u => u.upload_id === up.upload.upload_id).kind, 'Forms');
  // attachment on a message -> keep in Documents
  const m = await api(pat, 'sendMessage', { topicId: 'tp1', body: 'here it is', files: [{ name: 'labs.txt', type: 'text/plain', b64: Buffer.from('WBC 5.1').toString('base64') }] });
  assert.equal(m.ok, true); assert.equal(m.message.attachments.length, 1);
  const keep = await api(pat, 'keepAttachment', { messageId: m.message.message_id, fileId: m.message.attachments[0].id, kind: 'Other' });
  assert.equal(keep.ok, true);
  assert.match((await api(pat, 'keepAttachment', { messageId: m.message.message_id, fileId: m.message.attachments[0].id })).error, /Already/);
  // help ask lands in a named topic and pings the coordinator
  const h = await api(pat, 'askHelp', { what: 'Rides', body: 'Need a ride Tuesday' });
  assert.equal(h.ok, true); assert.equal(h.topic.title, 'Help with Rides');
  const h2 = await api(pat, 'askHelp', { what: 'Rides' });
  assert.equal(h2.topic.topic_id, h.topic.topic_id, 'same topic reused');
});

test('files endpoint enforces the session and the family', async () => {
  const { handle } = require('../src/app');
  const http = require('http');
  const srv = http.createServer((q, r) => handle(q, r)); await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const get = async (p) => { const r = await fetch(`http://localhost:${port}${p}`); return { status: r.status, body: await r.text() }; };
  const pat = await signIn('pat@example.com'); const sam = await signIn('sam@example.com');
  const u = await db.one(`select upload_id from uploads where client_id='c1' and storage_key is not null limit 1`);
  assert.equal((await get(`/files/${u.upload_id}`)).status, 401);
  assert.equal((await get(`/files/${u.upload_id}?s=${sam}`)).status, 404, 'other family');
  const ok = await get(`/files/${u.upload_id}?s=${pat}`);
  assert.equal(ok.status, 200); assert.ok(ok.body.length > 0);
  const b = await api(pat, 'bootstrap', {});
  const link = b.uploads.find(x => x.upload_id === u.upload_id).url;
  assert.match(link, /\/files\/.*\?k=/, 'documents carry a signed link');
  assert.equal((await get(link.replace(/^https?:\/\/[^/]+/, ''))).status, 200);
  const other = b.uploads.find(x => x.upload_id !== u.upload_id && /\?k=/.test(x.url));
  if (other) assert.equal((await get(`/files/${u.upload_id}?k=${other.url.split('?k=')[1]}`)).status, 401, 'a link for one file does not open another');
  srv.close();
});

test('meds: family adds pending, coordinator accepts, doses tick', async () => {
  const pat = await signIn('pat@example.com'); const co = await signIn('joe@incadencecare.com');
  const m = await api(pat, 'saveMed', { name: 'Tylenol', dose: '500 mg', frequency: 'Daily', times: '08:00,20:00', refills_left: '3' });
  assert.equal(m.ok, true); assert.equal(m.med.status, 'Pending review'); assert.equal(m.med.refills_left, '3');
  assert.ok((await api(co, 'inbasket', {})).needs.some(n => n.kind === 'Meds' && /Tylenol/.test(n.text)));
  assert.equal((await api(co, 'setMedStatus', { clientId: 'c1', medId: m.med.med_id, status: 'Accepted' })).ok, true);
  assert.equal((await api(pat, 'takeDose', { medId: m.med.med_id, dueAt: '2026-09-22T08:00' })).ok, true);
  assert.equal((await api(pat, 'takeDose', { medId: m.med.med_id, dueAt: '2026-09-22T08:00' })).ok, true, 'ticking twice is fine');
  const d = await api(pat, 'bootstrap', {});
  const dose = d.doses.find(x => x.med_id === m.med.med_id);
  assert.equal(dose.due_at, '2026-09-22T08:00'); assert.equal(dose.status, 'Taken');
  assert.equal((await api(pat, 'takeDose', { medId: m.med.med_id, dueAt: '2026-09-22T08:00', undo: true })).ok, true);
  assert.equal((await api(pat, 'missedDose', { medId: m.med.med_id, dueAt: '2026-09-22T20:00' })).ok, true);
  assert.equal(lastMail().to, 'joe@incadencecare.com', 'missed-dose check-ins are instant');
  const built = await api(co, 'addMeds', { clientId: 'c1', meds: [{ name: 'Keppra', dose: '500 mg', times: '08:00,20:00' }, { name: 'Senna', frequency: 'As needed' }] });
  assert.equal(built.added, 2);
});

test('resources and recommendations', async () => {
  const co = await signIn('joe@incadencecare.com'); const pat = await signIn('pat@example.com');
  const r = await api(co, 'saveResource', { title: 'Sleep after surgery', kind: 'Guide', track: 'Members', body: 'Rest.', status: 'Published', minutes: '4' });
  assert.equal(r.ok, true); assert.equal(r.resource.has_body, true);
  const draft = await api(co, 'saveResource', { title: 'Draft one', body: 'x' }); assert.equal(draft.resource.status, 'Draft');
  const lp = await api(pat, 'resources', {});
  assert.ok(lp.resources.some(x => x.resource_id === r.resource.resource_id)); assert.ok(!lp.resources.some(x => x.resource_id === draft.resource.resource_id));
  const rec = await api(co, 'recommend', { clientId: 'c1', resourceId: r.resource.resource_id, note: 'Read tonight' }); assert.equal(rec.ok, true);
  assert.equal((await api(pat, 'bootstrap', {})).recommended.title, 'Sleep after surgery');
  assert.equal((await api(pat, 'openResource', { resourceId: r.resource.resource_id })).body, 'Rest.');
  const lc = await api(co, 'resources', { clientId: 'c1' });
  const mine = lc.resources.find(x => x.resource_id === r.resource.resource_id);
  assert.deepEqual(mine.reach, { views: 1, families: 1, recommended: 1 });
  assert.ok((await api(pat, 'resources', {})).recs[0].opened_at, 'opened_at set');
});

test('coordinator: new family, settings, in basket', async () => {
  const co = await signIn('joe@incadencecare.com');
  const nf = await api(co, 'newFamily', { family_name: 'Nguyen', patient_first_name: 'Linh', patient_last_name: 'Nguyen', email: 'linh@example.com', surgery_date: '2026-12-01', note: 'Welcome!' });
  assert.equal(nf.ok, true); assert.ok(nf.client_id);
  assert.equal(lastMail().to, 'linh@example.com'); assert.match(lastMail().html, /Welcome!/);
  const link = linkFrom(lastMail());
  const h = await api(null, 'hello', { t: link }); assert.ok(h.boot.pwset, 'welcome link opens set-password');
  const sp = await api(null, 'setPassword', { token: h.boot.pwset.token, password: PW }); assert.ok(sp.session);
  const b = await api(sp.session, 'bootstrap', {});
  assert.equal(b.client.family_name, 'Nguyen'); assert.equal(b.client.paid, false);
  const cs = await api(co, 'saveCoSettings', { notify: { message: 'instant' }, digestHour: 6, title: 'Founder' });
  assert.equal(cs.coSettings.notify.message, 'instant'); assert.equal(cs.coSettings.digestHour, 6);
  const ib = await api(co, 'inbasket', {});
  assert.equal(ib.ok, true); assert.ok(ib.families.length >= 3); assert.ok(typeof ib.counts.needs === 'number');
  assert.ok(ib.families[0].days !== null && ib.families[0].days <= ib.families[1].days, 'sorted by days to surgery');
});

test('archive: lock, export, reactivate, purge rules', async () => {
  const co = await signIn('joe@incadencecare.com');
  const pat = await signIn('pat@example.com');
  const a = await api(co, 'archiveClient', { clientId: 'c1' });
  assert.equal(a.ok, true); assert.equal(a.client.status, 'Archived'); assert.match(a.retain_until, new RegExp('^' + (new Date().getFullYear() + 8) + '-'));
  assert.equal((await api(pat, 'bootstrap', {})).error, 'signed_out', 'family is locked out');
  assert.match((await api(co, 'addTask', { clientId: 'c1', title: 'x' })).error, /archived/, 'read-only for the coordinator');
  const b = await api(co, 'bootstrap', { clientId: 'c1' }); assert.equal(b.ok, true, 'chart still opens');
  assert.ok(!b.families.some(f => f.client_id === 'c1'), 'archived families leave the picker');
  const ex = await api(co, 'exportClient', { clientId: 'c1' });
  assert.equal(ex.ok, true); const doc = JSON.parse(Buffer.from(ex.b64, 'base64').toString()); assert.ok(doc.messages.length > 0); assert.ok(doc.audit.length > 0);
  assert.match((await api(co, 'purgeClient', { clientId: 'c1', confirm: 'Test Family' })).error, /retention date/);
  const r = await api(co, 'reactivateClient', { clientId: 'c1' }); assert.equal(r.client.status, 'Active');
  assert.equal((await signIn('pat@example.com')).length > 0, true, 'family signs in again');
  const jobs = require('../src/jobs');
  assert.equal((await jobs.run('retention')).due, 0);
  assert.equal(typeof (await jobs.run('dailyDigest')).sent, 'number');
  assert.equal(typeof (await jobs.run('medReminders')).families, 'number');
});
