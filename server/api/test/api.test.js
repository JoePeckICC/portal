'use strict';
// End-to-end against a real Postgres (DATABASE_URL). Loads the schema + fixture, then drives api() like the page does.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret';
process.env.MAIL_TRANSPORT = 'log';
process.env.QUIET_FROM = '0'; process.env.QUIET_TO = '0';   // no quiet hours in tests: the mail assertions run at any hour
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

const PW = 'Correct horse battery staple 9!';
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
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'correct horse battery staple' })).error, /needs a capital letter, a number and a symbol/);
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'CORRECT HORSE BATTERY 9!' })).error, /needs a lowercase letter\./);
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'Correct horse battery staple!' })).error, /needs a number\./);
  assert.match((await api(null, 'setPassword', { token: h.boot.pwset.token, password: 'MyPassword is 2 long!' })).error, /easy to guess/);
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

test('a family writes to their own circle; the coordinator never sees it; delete hides it only for the one who deleted', async () => {
  const pat = await signIn('pat@example.com'), sis = await signIn('sis@example.com'), co = await signIn('joe@incadencecare.com');
  const t = await api(pat, 'newTopic', { to: ['sis@example.com'] });
  assert.equal(t.ok, true); assert.equal(t.topic.kind, 'family');
  const n = mail.sent.length;
  const m = await api(pat, 'sendMessage', { topicId: t.topic.topic_id, body: 'Can you drive Tuesday?' });
  assert.equal(m.ok, true);
  assert.deepEqual(mail.sent.slice(n).map(x => x.to), ['sis@example.com'], 'only the sister hears about it');
  const bs = await api(sis, 'bootstrap', {}); assert.ok(bs.topics.some(x => x.topic_id === t.topic.topic_id));
  const bc = await api(co, 'bootstrap', { clientId: 'c1' });
  assert.ok(!bc.topics.some(x => x.topic_id === t.topic.topic_id), 'coordinator does not see it');
  assert.ok(!bc.messages.some(x => x.topic_id === t.topic.topic_id));
  assert.equal((await api(co, 'topicMessages', { clientId: 'c1', topicId: t.topic.topic_id })).ok, false);
  assert.equal((await api(co, 'sendMessage', { clientId: 'c1', topicId: t.topic.topic_id, body: 'x' })).ok, false);
  const h = await api(pat, 'hideTopic', { topicId: t.topic.topic_id, hidden: true }); assert.equal(h.ok, true);
  const row = await db.one(`select extra from topics where topic_id=$1`, [t.topic.topic_id]);
  assert.deepEqual(row.extra.hidden, ['pat@example.com'], 'kept on record, hidden for the patient only');
  await api(sis, 'sendMessage', { topicId: t.topic.topic_id, body: 'Yes' });
  const row2 = await db.one(`select extra from topics where topic_id=$1`, [t.topic.topic_id]);
  assert.equal(row2.extra.hidden, undefined, 'a new line brings it back');
});

test('vendors: invited, told by text, first to take it has it, then talk in Messages, and see nothing else', async () => {
  const sms = require('../src/sms');
  const co = await signIn('joe@incadencecare.com');
  await db.q(`update clients set address='12 Oak St, Nashville, TN 37203' where client_id='c1'`);
  const v = await api(co, 'saveVendor', { name: 'Sarah Walks', city: 'Nashville', state: 'TN', service: 'Pet care', phone: '(615) 555-0199', email: 'sarah@walks.example' });
  assert.equal(v.ok, true, v.error);
  const v2 = await api(co, 'saveVendor', { name: 'Paws Too', city: 'Nashville', state: 'TN', service: 'Pet care', phone: '(615) 555-0188', email: 'paws@walks.example' });
  { const r = await api(co, 'inviteVendor', { vendorId: v.vendor.vendor_id }); assert.equal(r.ok, true, r.error); }
  { const r = await api(co, 'inviteVendor', { vendorId: v2.vendor.vendor_id }); assert.equal(r.ok, true, r.error); }
  const pat = await signIn('pat@example.com');
  const n = sms.sent.length;
  const j = await api(pat, 'requestJob', { service: 'Pet care', startsAt: new Date(Date.now() + 86400e3).toISOString(), details: 'Biscuit, 2 walks' });
  assert.equal(j.ok, true, j.error); assert.equal(j.job.city, 'Nashville');
  const texts = sms.sent.slice(n);
  assert.deepEqual(texts.map(x => x.to).sort(), ['+16155550188', '+16155550199'], 'both invited vendors in town get a text');
  assert.ok(!/Pat|Peck|Oak/.test(texts[0].body), 'the text carries no name or address');
  const sarah = await signIn('sarah@walks.example'), paws = await signIn('paws@walks.example');
  const b = await api(sarah, 'bootstrap', {});
  assert.equal(b.ok, true, b.error); assert.equal(b.me.role, 'vendor'); assert.equal(b.openJobs.length, 1);
  assert.equal(b.openJobs[0].address, undefined, 'no address before taking it'); assert.equal(b.client, undefined);
  const tk = await api(sarah, 'takeJob', { jobId: j.job.job_id }); assert.equal(tk.ok, true, tk.error);
  assert.match((await api(paws, 'takeJob', { jobId: j.job.job_id })).error, /already took/);
  assert.equal((await api(sarah, 'addInner', { email: 'x@example.com', name: 'X' })).error, 'Not allowed');
  assert.equal((await api(sarah, 'topicMessages', { topicId: 'tp1' })).ok, false, 'not their thread');
  const pb = await api(pat, 'bootstrap', {});
  assert.equal(pb.jobs[0].status, 'Taken'); assert.equal(pb.jobs[0].vendor_name, 'Sarah Walks');
  const vt = pb.topics.find(t => t.kind === 'vendor'); assert.ok(vt);
  const n2 = sms.sent.length;
  { const r = await api(pat, 'sendMessage', { topicId: vt.topic_id, body: 'Leash is by the door' }); assert.equal(r.ok, true, r.error); }
  assert.equal(sms.sent.slice(n2)[0].to, '+16155550199', 'the vendor is texted that there is a message');
  { const r = await api(sarah, 'sendMessage', { topicId: vt.topic_id, body: 'Got it' }); assert.equal(r.ok, true, r.error); }
  const sb = await api(sarah, 'bootstrap', {});
  assert.equal(sb.myJobs[0].address, '12 Oak St, Nashville, TN 37203'); assert.equal(sb.messages.filter(m => m.topic_id === vt.topic_id).length, 3);
  { const r = await api(sarah, 'finishJob', { jobId: j.job.job_id }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).jobs[0].status, 'Done');
  // booking the same vendor again from the conversation: only they hear, and it stays in that thread
  const n3 = sms.sent.length;
  const again = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: new Date(Date.now() + 2 * 86400e3).toISOString(), details: 'Same as before' });
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(sms.sent.slice(n3).map(x => x.to), ['+16155550199'], 'only Sarah is asked');
  assert.equal((await api(paws, 'bootstrap', {})).openJobs.length, 0, 'the other walker never sees it');
  const sb2 = await api(sarah, 'bootstrap', {}); assert.equal(sb2.openJobs[0].for_me, true);
  { const r = await api(sarah, 'takeJob', { jobId: again.job.job_id }); assert.equal(r.ok, true, r.error); }
  const pb2 = await api(pat, 'bootstrap', {});
  assert.equal(pb2.topics.filter(t => t.kind === 'vendor').length, 1, 'no second thread');
  assert.ok(pb2.messages.some(m => m.topic_id === vt.topic_id && /confirmed/.test(m.body)));
  const third = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: new Date(Date.now() + 3 * 86400e3).toISOString() });
  { const r = await api(sarah, 'passJob', { jobId: third.job.job_id }); assert.equal(r.ok, true, r.error); }
  assert.ok((await api(pat, 'bootstrap', {})).messages.some(m => m.topic_id === vt.topic_id && /can’t make/.test(m.body)));
  { const r = await api(pat, 'saveCareNote', { service: 'Pet care', text: 'Biscuit: two walks, key under the mat' }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).careNotes['Pet care'], 'Biscuit: two walks, key under the mat', 'the usual note is kept');
  assert.equal((await api(sarah, 'saveCareNote', { service: 'Pet care', text: 'x' })).error, 'Not allowed');
  // her hours: the family sees only the times she is free, and can ask to meet first
  const { localStamp, localToIso } = require('../src/time');
  const day = localStamp(new Date(Date.now() + 5 * 86400e3)).slice(0, 10), dow = new Date(day + 'T12:00:00Z').getUTCDay();
  { const r = await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day }); assert.equal(r.ok, true, r.error); assert.equal(r.any, true, 'no hours set: any time'); }
  const week = [null, null, null, null, null, null, null]; week[dow] = { from: '15:00', to: '17:00' };
  { const r = await api(sarah, 'saveHours', { hours: { week, off: [] } }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'saveHours', { hours: { week } })).error, 'Not allowed');
  const tv = await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day });
  assert.equal(tv.any, false); assert.deepEqual(tv.times, ['15:00', '15:30', '16:00', '16:30'].map(t => localToIso(day + 'T' + t)));
  assert.match((await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: localToIso(day + 'T09:00') })).error, /not free then/);
  const meet = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: localToIso(day + 'T15:30'), meet: 'phone' });
  assert.equal(meet.ok, true, meet.error);
  const sb3 = await api(sarah, 'bootstrap', {}); assert.equal(sb3.openJobs.find(x => x.job_id === meet.job.job_id).meet, 'phone');
  assert.deepEqual((await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day })).times, [localToIso(day + 'T16:30')], 'an hour either side of a request is held');
  { const r = await api(sarah, 'takeJob', { jobId: meet.job.job_id }); assert.equal(r.ok, true, r.error); }
  assert.ok((await api(pat, 'bootstrap', {})).messages.some(m => m.topic_id === vt.topic_id && /confirmed: meet first \(phone call\)/.test(m.body)));
  { const r = await api(sarah, 'saveHours', { hours: { week, off: [day] } }); assert.equal(r.ok, true, r.error); }
  assert.deepEqual((await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day })).times, [], 'a day off');
  assert.equal((await api(pat, 'bootstrap', {})).topics.find(t => t.topic_id === vt.topic_id).extra.vendor_hours.week[dow].from, '15:00');
  // "I'm open": any time, except time off
  { const r = await api(sarah, 'saveHours', { hours: { open: true, off: [day] } }); assert.equal(r.ok, true, r.error); }
  assert.deepEqual((await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day })).times, [], 'time off holds when open');
  const day2 = localStamp(new Date(Date.now() + 6 * 86400e3)).slice(0, 10);
  assert.equal((await api(pat, 'vendorTimes', { topicId: vt.topic_id, date: day2 })).any, true);
  assert.match((await api(sarah, 'saveHours', { hours: { week: [] } })).error, /at least one day/);
  assert.equal((await api(sarah, 'bootstrap', {})).vendor.hours.set, true, 'onboarding is done once hours are saved');
  // not everything fits a clock time: meals by how soon, lodging by check-in and check-out
  const meal = await api(pat, 'requestJob', { service: 'Meals', soon: 'week', details: 'Dinners for four' });
  assert.equal(meal.ok, true, meal.error); assert.equal(meal.job.extra.soon, 'week');
  const ci = localStamp(new Date(Date.now() + 3 * 86400e3)).slice(0, 10), co2 = localStamp(new Date(Date.now() + 6 * 86400e3)).slice(0, 10);
  const stay = await api(pat, 'requestJob', { service: 'Lodging', from: ci, until: co2 });
  assert.equal(stay.ok, true, stay.error); assert.equal(stay.job.extra.until, co2);
  assert.match((await api(pat, 'requestJob', { service: 'Lodging', from: co2, until: ci })).error, /after check-in/);
  // questions: the pickup address stays private until someone takes it; equipment goes to the coordinator, not vendors
  const ride = await api(pat, 'requestJob', { service: 'Pet care', startsAt: new Date(Date.now() + 4 * 86400e3).toISOString(), info: [{ l: 'Pickup', v: '12 Oak St', p: true }, { l: 'Dogs', v: '2' }] });
  assert.equal(ride.ok, true, ride.error);
  const oj = (await api(sarah, 'bootstrap', {})).openJobs.find(x => x.job_id === ride.job.job_id);
  assert.deepEqual(oj.info, [{ l: 'Dogs', v: '2' }], 'addresses wait until the job is taken');
  const loan = await api(pat, 'requestJob', { service: 'Medical equipment', soon: 'days', info: [{ l: 'Item', v: 'Walker' }] });
  assert.equal(loan.ok, true, loan.error); assert.equal(loan.job.extra.loan, true);
  const pj = (await api(pat, 'bootstrap', {})).jobs;
  assert.equal(pj.find(j => j.job_id === ride.job.job_id).info.length, 2, 'the family sees all their own answers');
  // the circle's casting call: the support team never sees it until the time is up or the family says "ask InCadence now"
  const sis = await signIn('sis@example.com');
  assert.equal((await api(pat, 'bootstrap', {})).circleNear, 1, 'someone whose ZIP we do not know can still be asked');
  { const r = await api(sis, 'savePrefs', { zip: '90210' }); assert.equal(r.ok, true, r.error); }
  assert.match((await api(pat, 'requestJob', { service: 'Pet care', startsAt: new Date(Date.now() + 5 * 86400e3).toISOString(), circle: '1' })).error, /No one in your circle is set up/, 'far away is left out');
  assert.match((await api(sis, 'savePrefs', { zip: '372' })).error, /5-digit/);
  { const r = await api(sis, 'savePrefs', { zip: '37205' }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).circleNear, 1, 'sis lives nearby');
  { const r = await api(sis, 'savePrefs', { mobile: '(615) 555-0142' }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).circleAsk[0].text, true, 'sis can be texted');
  const nS = sms.sent.length;
  assert.match((await api(pat, 'requestJob', { service: 'Pet care', startsAt: new Date(Date.now() + 5 * 86400e3).toISOString(), circle: '1', circleTo: ['nobody@example.com'] })).error, /No one in your circle/);
  const cc = await api(pat, 'requestJob', { service: 'Pet care', startsAt: new Date(Date.now() + 5 * 86400e3).toISOString(), circle: '1', circleTo: ['sis@example.com'] });
  assert.ok(sms.sent.slice(nS).some(x => x.to === '+16155550142'), 'the circle gets a text');
  assert.equal(cc.ok, true, cc.error); assert.ok(cc.job.extra.circle.until);
  assert.ok(!(await api(sarah, 'bootstrap', {})).openJobs.some(x => x.job_id === cc.job.job_id), 'the circle goes first');
  const hi = (await db.all(`select * from help_items where job_id=$1`, [cc.job.job_id]))[0]; assert.equal(hi.status, 'Open');
  { const r = await api(pat, 'askUsNow', { jobId: cc.job.job_id }); assert.equal(r.ok, true, r.error); }
  assert.ok((await api(sarah, 'bootstrap', {})).openJobs.some(x => x.job_id === cc.job.job_id), 'then the support team');
  assert.equal((await db.all(`select status from help_items where job_id=$1`, [cc.job.job_id]))[0].status, 'Removed');
  const only = await api(pat, 'requestJob', { service: 'Childcare', startsAt: new Date(Date.now() + 5 * 86400e3).toISOString(), circle: 'only', info: [{ l: 'Their ages', v: '4 and 7' }] });
  const hi2 = (await db.all(`select * from help_items where job_id=$1`, [only.job.job_id]))[0];
  { const r = await api(sis, 'claimHelp', { itemId: hi2.item_id }); assert.equal(r.ok, true, r.error); }
  const oj2 = (await api(pat, 'bootstrap', {})).jobs.find(j => j.job_id === only.job.job_id); assert.equal(oj2.status, 'Taken'); assert.ok(oj2.circle_by);
  // the loan closet: the coordinator lends a walker from the Nashville closet and it comes back
  const coord = await signIn('joe@incadencecare.com');
  const eq = await api(coord, 'saveEquipment', { kind: 'Walker', label: 'Walker #1', city: 'Nashville', state: 'TN' }); assert.equal(eq.ok, true, eq.error);
  assert.equal((await api(pat, 'saveEquipment', { kind: 'Walker', city: 'Nashville' })).error, 'Not allowed');
  const ln = await api(coord, 'lendEquipment', { equipId: eq.item.equip_id, jobId: loan.job.job_id, dueBack: '2026-11-01' }); assert.equal(ln.ok, true, ln.error);
  const pb3 = await api(pat, 'bootstrap', {}); assert.equal(pb3.borrowed[0].label, 'Walker #1'); assert.equal(pb3.jobs.find(j => j.job_id === loan.job.job_id).status, 'Taken');
  assert.match((await api(coord, 'lendEquipment', { equipId: eq.item.equip_id, clientId: 'x' })).error, /already out/);
  { const r = await api(coord, 'returnEquipment', { equipId: eq.item.equip_id }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).borrowed.length, 0); assert.equal(pj.find(j => j.job_id === meal.job.job_id).soon, 'week'); assert.equal(pj.find(j => j.job_id === stay.job.job_id).from, ci);
  // what they do: Sarah only walks, so she can't be booked for a ride; once she ticks rides too, she can, and ride requests reach her
  const at = localToIso(day2 + 'T10:00');
  const nr = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: at, service: 'Rides' });
  assert.equal(nr.ok, true, nr.error); assert.equal(nr.job.service, 'Pet care', 'booked only for what she does');
  await api(pat, 'cancelJob', { jobId: nr.job.job_id });
  assert.equal((await api(pat, 'saveServices', { services: ['Rides'] })).error, 'Not allowed');
  assert.match((await api(sarah, 'saveServices', { services: ['Medical equipment'] })).error, /at least one/);
  { const r = await api(sarah, 'saveServices', { services: ['Pet care', 'Rides', 'Medical equipment'] }); assert.equal(r.ok, true, r.error); assert.deepEqual(r.services, ['Rides', 'Pet care']); }
  assert.deepEqual((await api(pat, 'bootstrap', {})).topics.find(t => t.topic_id === vt.topic_id).extra.vendor_services, ['Rides', 'Pet care']);
  const r2 = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: at, service: 'Rides' }); assert.equal(r2.job.service, 'Rides');
  await api(pat, 'cancelJob', { jobId: r2.job.job_id });
  const n4 = sms.sent.length;
  const openRide = await api(pat, 'requestJob', { service: 'Rides', startsAt: localToIso(day2 + 'T13:00') }); assert.equal(openRide.ok, true, openRide.error);
  assert.deepEqual(sms.sent.slice(n4).map(x => x.to), ['+16155550199'], 'Sarah hears about rides now; Paws does not');
  assert.ok(!(await api(paws, 'bootstrap', {})).openJobs.some(x => x.job_id === openRide.job.job_id));
  { const r = await api(sarah, 'takeJob', { jobId: openRide.job.job_id }); assert.equal(r.ok, true, r.error); }
  assert.deepEqual((await api(sarah, 'bootstrap', {})).vendor.services, ['Rides', 'Pet care']);
  // the family's pets: from intake first (the names they gave), then their own saved list
  await db.q(`delete from intake_answers where client_id='c1' and question_id in ('M.4','M.4p','M.4g')`);
  await db.q(`insert into intake_answers (client_id, question_id, answer) values ('c1','M.4','Dog; Cat'),('c1','M.4p','Biscuit (dog), Pepper (cat) and Moose'),('c1','M.4g','Pulls on the leash')`);
  assert.deepEqual((await api(pat, 'bootstrap', {})).pets.map(q => [q.name, q.kind, q.notes]), [['Biscuit', 'Dog', 'Pulls on the leash'], ['Pepper', 'Cat', ''], ['Moose', 'Other', '']]);
  { const r = await api(pat, 'savePets', { pets: [{ name: 'Biscuit', kind: 'Dog', notes: 'Pulls on the leash' }, { name: '', kind: 'Cat' }] }); assert.equal(r.ok, true, r.error); assert.equal(r.pets.length, 1); assert.ok(r.pets[0].id); }
  assert.equal((await api(sarah, 'savePets', { pets: [] })).error, 'Not allowed');
  const pets = (await api(pat, 'bootstrap', {})).pets; assert.equal(pets[0].name, 'Biscuit');
  const pw = await api(pat, 'requestJob', { topicId: vt.topic_id, startsAt: localToIso(day2 + 'T16:00'), service: 'Pet care', info: [{ l: 'Pets', v: 'Biscuit (dog), Pulls on the leash' }] });
  assert.equal(pw.ok, true, pw.error);
  assert.equal((await api(sarah, 'bootstrap', {})).openJobs.find(x => x.job_id === pw.job.job_id).info[0].v, 'Biscuit (dog), Pulls on the leash', 'she sees the dog');
  // her profile: a line about herself, and whether we vetted her
  { const r = await api(sarah, 'saveBio', { bio: 'Nursing student at Belmont. Loves big dogs.' }); assert.equal(r.ok, true, r.error); }
  await api(coord, 'saveVendor', { vendorId: v.vendor.vendor_id, name: 'Sarah Walks', city: 'Nashville', state: 'TN', service: 'Pet care', phone: '(615) 555-0199', email: 'sarah@walks.example', checked: true });
  const vx = (await api(pat, 'bootstrap', {})).topics.find(t => t.topic_id === vt.topic_id).extra;
  assert.equal(vx.vendor_bio, 'Nursing student at Belmont. Loves big dogs.'); assert.equal(vx.vendor_vetted, true);
  // tips for the next family: the coordinator reads each one first; only shared ones reach other families
  await db.q(`insert into appointments (appt_id, client_id, title, starts_at, location) values ('tipap','c1','Pre-op', now() + interval '3 day', 'Test Hospital') on conflict do nothing`);
  const tp = await api(pat, 'shareTip', { place: 'Test Hospital', text: 'Use the Garage B entrance; it is closest to pre-op.' }); assert.equal(tp.ok, true, tp.error);
  assert.equal((await api(pat, 'bootstrap', {})).placeTips.length, 0, 'not shown before the coordinator reads it');
  assert.ok((await api(coord, 'bootstrap', { clientId: 'c1' })).tipQueue.some(t => t.tip_id === tp.tip.tip_id));
  assert.equal((await api(pat, 'reviewTip', { tipId: tp.tip.tip_id, share: true })).error, 'Not allowed');
  { const r = await api(coord, 'reviewTip', { tipId: tp.tip.tip_id, share: true }); assert.equal(r.ok, true, r.error); }
  assert.equal((await api(pat, 'bootstrap', {})).placeTips[0].text, 'Use the Garage B entrance; it is closest to pre-op.');
  assert.equal((await api(pat, 'bootstrap', {})).placeTips[0].client_id, undefined, 'no family name on a shared tip');
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

test('the patient says yes to what the Circle sees; the coordinator only takes things down', async () => {
  const co = await signIn('joe@incadencecare.com'), pat = await signIn('pat@example.com');
  const cid = (await api(pat, 'bootstrap', {})).client.client_id;
  await db.q(`update clients set circle_enabled=true where client_id=$1`, [cid]);
  const p1 = await api(co, 'postUpdate', { clientId: cid, title: 'From the coordinator', body: 'x', visible: true });
  assert.equal(p1.ok, true, p1.error); assert.equal(p1.update.visible_to_circle, false, 'waits for the patient');
  assert.ok((await api(co, 'approveUpdate', { clientId: cid, updateId: p1.update.update_id, ok: true })).error, 'coordinator cannot share');
  assert.equal((await api(pat, 'approveUpdate', { updateId: p1.update.update_id, ok: true })).ok, true);
  assert.equal((await db.one(`select visible_to_circle from updates where update_id=$1`, [p1.update.update_id])).visible_to_circle, true);
  assert.equal((await api(co, 'approveUpdate', { clientId: cid, updateId: p1.update.update_id, ok: false })).ok, true, 'coordinator can take it down');
  const p2 = await api(pat, 'postUpdate', { title: 'From me', body: 'y', visible: true });
  assert.equal(p2.update.visible_to_circle, true, 'the patient posts straight out');
  await db.q(`insert into update_comments (comment_id, update_id, client_id, author, email, body, status, by_role) values ('cmt-t1',$1,$2,'Aunt','aunt@example.com','Love you','Pending','supporter') on conflict (comment_id) do update set status='Pending'`, [p2.update.update_id, cid]);
  assert.ok((await api(co, 'moderateComment', { clientId: cid, commentId: 'cmt-t1', status: 'Approved' })).error, 'coordinator cannot approve a word');
  assert.equal((await api(co, 'moderateComment', { clientId: cid, commentId: 'cmt-t1', status: 'Hidden' })).ok, true, 'coordinator can hide');
  assert.equal((await api(pat, 'moderateComment', { commentId: 'cmt-t1', status: 'Approved' })).ok, true);
  assert.ok((await api(co, 'setDelegate', { clientId: cid, email: 'x@example.com', on: true })).error, 'only the patient names a delegate');
});

test('learning: the tracker fills milestones; only families who said yes count; no range under 11 families', async () => {
  const co = await signIn('joe@incadencecare.com'), pat = await signIn('pat@example.com');
  const cid = (await api(pat, 'bootstrap', {})).client.client_id;
  await db.q(`delete from recovery_milestones where client_id=$1`, [cid]);
  assert.equal((await api(pat, 'setTracker', { stage: 'In surgery' })).ok, true);
  const b = await api(pat, 'bootstrap', {});
  assert.ok(b.milestones.some(m => m.kind === 'surgery'), 'surgery day came from the tracker');
  assert.ok((await api(pat, 'setMilestone', { kind: 'nope', date: '2026-01-01' })).error);
  assert.equal((await api(co, 'setMilestone', { clientId: cid, kind: 'discharge', date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), detail: 'Inpatient rehab' })).ok, true);
  assert.ok((await api(pat, 'learnStats', {})).error, 'families do not see the cohort numbers');
  await db.q(`delete from intake_answers where client_id=$1 and question_id in ('G.learn','G.4b')`, [cid]);
  let r = await api(co, 'learnStats', {});
  assert.equal(r.ok, true, r.error); const before = r.total;
  await db.q(`insert into intake_answers (client_id, question_id, answer) values ($1,'G.learn','Yes, count it'),($1,'G.4b','VP shunt')`, [cid]);
  r = await api(co, 'learnStats', {});
  assert.equal(r.total, before + 1, 'a yes counts');
  const g = r.groups.find(x => x.surgery === 'VP shunt'); assert.ok(g);
  const dis = g.milestones.find(m => m.k === 'discharge');
  assert.equal(dis.mid, undefined, 'no typical day until 11 families'); assert.equal(g.dest, null, 'no destination split under 11');
  await db.q(`delete from intake_answers where client_id=$1 and question_id in ('G.learn','G.4b')`, [cid]);
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
  const a = await api(co, 'addPlanItem', { clientId: 'c1', item: 'Pick up the walker', stage: 'The countdown', category: 'Care coordination' });
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
  spec.steps.forEach(st => st.qs.forEach(q => { if (q.req && !q.showIf) answers[q.id] = { a: q.type === 'choice' ? q.opts[0] : q.type === 'date' ? '2026-11-03' : q.id === 'A.phone' ? '(615) 555-0100' : 'x' }; }));
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
  const fut = await db.one(`select starts_at from appointments where appt_id='a1'`);
  await db.q(`update appointments set starts_at=now() + interval '3 days' where appt_id='a1'`);
  assert.match((await api(co, 'saveVisitNote', { clientId: 'c1', apptId: 'a1', note: 'Too early.' })).error, /once the visit has happened/);
  await db.q(`update appointments set starts_at=now() - interval '1 day' where appt_id='a1'`);
  const vn = await api(co, 'saveVisitNote', { clientId: 'c1', apptId: 'a1', note: 'BP fine. Cleared for surgery.', shared: true });
  assert.equal(vn.ok, true);
  await db.q(`update appointments set starts_at=$1 where appt_id='a1'`, [fut.starts_at]);
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

test('booking hook: a new booker gets a locked family and a set-password link, once', async () => {
  const booking = require('../src/booking');
  const C = require('../src/config');
  process.env.BOOKING_HOOK_KEY = 'hook-key-for-tests-0123456789';
  const key = { 'x-hook-key': process.env.BOOKING_HOOK_KEY };
  let [st, out] = await booking.handle({ 'x-hook-key': 'wrong' }, { email: 'nora@example.com' });
  assert.equal(st, 403);
  [st, out] = await booking.handle(key, { email: 'not an email' });
  assert.equal(st, 400);
  [st, out] = await booking.handle(key, { email: 'Nora@Example.com', name: 'Nora Newcomb', phone: '(615) 555-0123' });
  assert.equal(st, 200); assert.equal(out.created, true); assert.match(out.url, /\?t=/);
  assert.equal(auth.parseToken(decodeURIComponent(out.url.split('?t=')[1]), 'link').email, 'nora@example.com');
  const u = await db.one(`select * from users where email='nora@example.com'`);
  assert.equal(u.role, 'client');
  const cl = await db.one(`select * from clients where client_id=$1`, [u.client_id]);
  assert.equal(cl.paid, false); assert.equal(cl.coordinator_email, 'joe@incadencecare.com');
  assert.equal(cl.patient_first_name, 'Nora'); assert.equal(cl.family_name, 'Newcomb'); assert.equal(cl.phone, '(615) 555-0123');
  // Booking again makes nothing new; a fresh link until they choose a password, then just the portal.
  [st, out] = await booking.handle(key, { email: 'nora@example.com', name: 'Nora Newcomb' });
  assert.equal(out.created, false); assert.match(out.url, /\?t=/);
  assert.equal((await db.one(`select count(*)::int n from users where email='nora@example.com'`)).n, 1);
  await db.q(`update users set password_hash='x' where email='nora@example.com'`);
  [st, out] = await booking.handle(key, { email: 'nora@example.com' });
  assert.equal(out.created, false); assert.equal(out.url, C.PORTAL_URL);
  // Without a key configured the hook is shut.
  delete process.env.BOOKING_HOOK_KEY;
  [st] = await booking.handle(key, { email: 'someone@example.com' });
  assert.equal(st, 403);
});

test('a booked family: intake, then Pay when ready (no invoice is sent), then the portal opens', async () => {
  const booking = require('../src/booking');
  const B = require('../src/billing');
  const C = require('../src/config');
  const webhook = require('../src/webhook');
  const crypto = require('crypto');
  process.env.BOOKING_HOOK_KEY = 'hook-key-for-tests-0123456789';
  await booking.handle({ 'x-hook-key': process.env.BOOKING_HOOK_KEY }, { email: 'olga@example.com', name: 'Olga Oakes' });
  delete process.env.BOOKING_HOOK_KEY;
  const olga = await signIn('olga@example.com');
  const boot = await api(olga, 'bootstrap', {});
  assert.equal(boot.client.paid, false); assert.ok(boot.intakeSpec); assert.equal(boot.tasks, undefined);
  const spec = boot.intakeSpec;
  await api(olga, 'signConsent', { consent: { initials: spec.consent.map(() => 'OO'), name: 'Olga Oakes', relationship: 'Self' } });
  const answers = {};
  spec.steps.forEach(st => st.qs.forEach(q => { if (q.req && !q.showIf) answers[q.id] = { a: q.type === 'choice' ? q.opts[0] : q.type === 'date' ? '2026-11-03' : q.id === 'A.phone' ? '(615) 555-0100' : 'x' }; }));
  assert.equal((await api(olga, 'saveIntake', { answers })).ok, true);
  // Stripe, faked: record what is asked of it.
  const saved = { stripe: B.stripe, stripeProduct: B.stripeProduct, key: process.env.STRIPE_SECRET_KEY, wh: process.env.STRIPE_WEBHOOK_SECRET };
  const calls = [];
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  B.stripe = async (method, path, params) => { calls.push(method + ' ' + path + (params && params.mode ? ' ' + params.mode : '') + (params && params['line_items[0][price_data][unit_amount]'] ? ' ' + params['line_items[0][price_data][unit_amount]'] : '')); return path === '/v1/customers' ? { id: 'cus_olga' } : path === '/v1/invoices' ? { data: [] } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }; };
  B.stripeProduct = async () => 'prod_test';
  const hook = async ev => {
    const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + raw).digest('hex');
    const res = { code: 0, writeHead(c) { this.code = c; }, end() {} };
    await webhook.handle({ headers: { 'stripe-signature': 't=' + t + ',v1=' + sig } }, res, Buffer.from(raw));
    return res.code;
  };
  try {
    const sub = await api(olga, 'submitIntake', {});
    assert.equal(sub.ok, true, sub.error); assert.equal(sub.intake.status, 'Submitted');
    assert.deepEqual(calls, [], 'finishing the intake sends nothing to Stripe');
    const plan = await api(olga, 'planPdf', {});
    assert.equal(plan.ok, false); assert.match(plan.error, /not ready yet/);          // the plan waits for the coordinator
    assert.match((await api(olga, 'checkoutLink', {})).error, /after your meeting/);        // no paying before the meeting
    assert.deepEqual(calls, []);
    await db.q(`update clients c set plan_ready=true from users u where u.client_id=c.client_id and u.email='olga@example.com'`);
    const co = await api(olga, 'checkoutLink', {});
    assert.equal(co.ok, true, co.error); assert.equal(co.url, 'https://checkout.stripe.test/cs_1');
    assert.deepEqual(calls, ['POST /v1/customers', 'POST /v1/checkout/sessions subscription ' + C.DEFAULT_MONTHLY * 100]);
    let cl = await db.one(`select c.* from clients c join users u on u.client_id=c.client_id where u.email='olga@example.com'`);
    assert.equal(cl.stripe_customer_id, 'cus_olga'); assert.equal(cl.paid, false); assert.equal(cl.stripe_subscription_id, null);
    assert.match((await api(olga, 'newTopic', { kind: 'question' })).error, /first payment/);
    // Stripe reports back: the checkout finished, and the first month is paid.
    assert.equal(await hook({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'subscription', customer: 'cus_olga', subscription: 'sub_olga', amount_subtotal: C.DEFAULT_MONTHLY * 100 } } }), 200);
    assert.equal(await hook({ type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_olga' } } }), 200);
    cl = await db.one(`select * from clients where client_id=$1`, [cl.client_id]);
    assert.equal(cl.paid, true); assert.equal(cl.stripe_subscription_id, 'sub_olga'); assert.equal(Number(cl.monthly_amount), C.DEFAULT_MONTHLY); assert.equal(cl.billing_status, 'Active');
    assert.equal((await api(olga, 'newTopic', { kind: 'question' })).ok, true, 'the portal is open');
    const again = await api(olga, 'checkoutLink', {});
    assert.equal(again.ok, false); assert.match(again.error, /already open/);
  } finally {
    Object.assign(B, { stripe: saved.stripe, stripeProduct: saved.stripeProduct });
    if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.wh === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved.wh;
  }
});

test('Pay when ready is for families only', async () => {
  const co = await signIn('joe@incadencecare.com');
  const r = await api(co, 'checkoutLink', { clientId: 'c2' });
  assert.equal(r.ok, false); assert.match(r.error, /Not allowed/);
});

test('changes after submitting: one email to the coordinator, listing what changed', async () => {
  const booking = require('../src/booking');
  process.env.BOOKING_HOOK_KEY = 'hook-key-for-tests-0123456789';
  await booking.handle({ 'x-hook-key': process.env.BOOKING_HOOK_KEY }, { email: 'quinn@example.com', name: 'Quinn Quill' });
  delete process.env.BOOKING_HOOK_KEY;
  const q = await signIn('quinn@example.com');
  const spec = (await api(q, 'bootstrap', {})).intakeSpec;
  const signed = await api(q, 'signConsent', { consent: { initials: spec.consent.map(() => 'QQ'), name: 'Quinn Quill', relationship: 'Self' } });
  assert.deepEqual(signed.intake.consent.items, spec.consent, 'the wording is kept with the signature');
  const answers = {};
  spec.steps.forEach(st => st.qs.forEach(x => { if (x.req && !x.showIf) answers[x.id] = { a: x.type === 'choice' ? x.opts[0] : x.type === 'date' ? '2026-11-03' : x.id === 'A.phone' ? '(615) 555-0100' : 'x' }; }));
  await api(q, 'saveIntake', { answers });
  assert.equal((await api(q, 'submitIntake', {})).intake.status, 'Submitted');
  // Saving a step with nothing changed (the Back button does this) is not a change.
  assert.equal((await api(q, 'saveIntake', { answers })).intake.status, 'Submitted');
  mail.sent.length = 0;
  await db.q(`delete from digest`);
  await api(q, 'saveIntake', { answers: { 'G.10': { a: "I don't know", n: '' } } });
  await api(q, 'saveIntake', { answers: { 'G.10': { a: 'To rehab or a nursing facility first', n: 'Son wants rehab' } } });
  const r = await api(q, 'saveIntake', { answers: { 'K.5': { a: 'Ramp; Raised toilet seat', n: '' } } });
  assert.equal(r.intake.status, 'Updated after submitting');
  const done = await api(q, 'submitIntake', {});
  assert.equal(done.intake.status, 'Submitted'); assert.deepEqual(done.intake.changed, {});
  const got = (await db.all(`select * from digest where kind='intake'`)).concat(mail.sent.map(m => ({ subject: m.subject, body: JSON.stringify(m) })));
  assert.equal(got.length, 1, 'one email');
  assert.match(got[0].subject, /changed their intake answers/);
  const body = got[0].body + ' ' + (got[0].lead || '');
  assert.match(body, /Straight home" → "To rehab or a nursing facility first" \(note changed too\)/);
  assert.match(body, /What's already installed\?: "Not set" → "Ramp; Raised toilet seat"/);
});

test('through the portal, sign-in lives in HttpOnly cookies, never in the page', async () => {
  const srv = require('../src/app').createServer(); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port, jar = {};
  const send = async (action, payload, proxied = true) => {
    const h = { 'Content-Type': 'text/plain;charset=utf-8' };
    if (proxied) { h['X-Portal-Proxy'] = '1'; h['X-Client-IP'] = '7.7.7.7'; }
    const c = Object.keys(jar).map(k => k + '=' + encodeURIComponent(jar[k])).join('; '); if (c) h.Cookie = c;
    const r = await fetch(base + '/api', { method: 'POST', headers: h, body: JSON.stringify({ action, payload }) });
    const set = r.headers.getSetCookie();
    set.forEach(line => {
      assert.match(line, /^__Host-ic_[sd]=[^;]*; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
      const kv = line.split(';')[0], i = kv.indexOf('=');
      if (/Max-Age=0$/.test(line)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    return Object.assign(await r.json(), { _set: set.length });
  };
  try {
    await db.q(`delete from rate_limits`);
    // A new browser: password, then the emailed code. Both tokens come back as cookies; the page only sees true.
    let r = await send('login', { email: 'pat@example.com', password: PW });
    assert.equal(r.needCode, true, r.error);
    r = await send('verifyCode', { challenge: r.challenge, code: codeFrom(lastMail()) });
    assert.equal(r.ok, true, r.error); assert.equal(r.session, true); assert.equal(r.device, true);
    assert.ok(jar['__Host-ic_s'] && jar['__Host-ic_d'], 'session and remembered-device cookies set');
    const sid = jar['__Host-ic_s'];
    assert.equal((await db.one(`select ip from sessions where session_id=$1`, [sid])).ip, '7.7.7.7', 'the family\'s own address, passed by the worker');
    // A fresh page load knows it is signed in, and calls work with no token in the page.
    assert.equal((await send('hello', {})).boot.session, true);
    assert.equal((await send('bootstrap', {})).ok, true);
    // Sign out: cookie cleared, and the session is gone on the server too.
    await send('signOut', {});
    assert.equal(jar['__Host-ic_s'], undefined); assert.equal(await auth.userForSession(sid), null);
    jar['__Host-ic_s'] = sid;
    assert.equal((await send('bootstrap', {})).error, 'signed_out'); assert.equal(jar['__Host-ic_s'], undefined, 'a dead cookie is cleared');
    assert.equal((await send('hello', {})).boot.session, null);
    // Signing in again on this browser: the device cookie skips the code.
    r = await send('login', { email: 'pat@example.com', password: PW });
    assert.equal(r.session, true, 'remembered device goes straight in'); assert.ok(jar['__Host-ic_s']);
    // An older page calling the API directly works as before: token in the body, no cookies.
    const old = await send('login', { email: 'pat@example.com', password: PW, device: devices['pat@example.com'] }, false);
    assert.equal(typeof old.session, 'string'); assert.equal(old._set, 0);
    // Forget devices clears that cookie too.
    await send('forgetDevices', {}); assert.equal(jar['__Host-ic_d'], undefined);
  } finally { srv.close(); }
});

test('consent initials must match the signature; phones are checked and tidied; exclusive picks stay exclusive', async () => {
  const booking = require('../src/booking');
  const intake = require('../src/intake');
  process.env.BOOKING_HOOK_KEY = 'hook-key-for-tests-0123456789';
  await booking.handle({ 'x-hook-key': process.env.BOOKING_HOOK_KEY }, { email: 'rita@example.com', name: 'Rita Marie Rivera' });
  delete process.env.BOOKING_HOOK_KEY;
  const r = await signIn('rita@example.com');
  const spec = (await api(r, 'bootstrap', {})).intakeSpec;
  const sign = (ini, name) => api(r, 'signConsent', { consent: { initials: spec.consent.map(() => ini), name, relationship: 'Self' } });
  assert.match((await sign('ZZZZ', 'Rita Marie Rivera')).error, /should match the name.*that is RR/);
  assert.match((await sign('1234', 'Rita Marie Rivera')).error, /should match/);
  assert.match((await sign('RR', 'Rita')).error, /first and last name/);
  assert.equal((await sign('R.M.R.', 'Rita Marie Rivera')).ok, true, 'all initials, with periods');
  assert.equal((await sign('rr', 'Rita Marie Rivera')).ok, true, 'first + last, any case');
  // Phone: tidied on save, refused at submit when it is not a real number.
  assert.equal(intake.phoneOk('615-555-0100'), '(615) 555-0100');
  assert.equal(intake.phoneOk('+1 (615) 555-0100 ext. 22'), '(615) 555-0100 ext. 22');
  assert.equal(intake.phoneOk('000-000-0000'), ''); assert.equal(intake.phoneOk('61555501001234'), ''); assert.equal(intake.phoneOk('(615) 555'), '');
  let s = await api(r, 'saveIntake', { answers: { 'A.phone': { a: '6155550100 x22', n: '' }, 'K.5': { a: 'Ramp; None of these; I don\'t know; Raised toilet seat', n: '' }, 'M.4': { a: 'No; Dog', n: '' } } });
  assert.equal(s.intake.answers['A.phone'].a, '(615) 555-0100 ext. 22');
  assert.equal(s.intake.answers['K.5'].a, 'Ramp; Raised toilet seat');
  assert.equal(s.intake.answers['M.4'].a, 'Dog');
  const answers = {};
  spec.steps.forEach(st => st.qs.forEach(q => { if (q.req && !q.showIf) answers[q.id] = { a: q.type === 'choice' ? q.opts[0] : q.type === 'date' ? '2026-11-03' : q.id === 'A.phone' ? '(615) 555-0100' : 'x' }; }));
  answers['A.phone'] = { a: '000-000-0000' };
  await api(r, 'saveIntake', { answers });
  assert.match((await api(r, 'submitIntake', {})).error, /A.phone \(not a working number\)/);
});

test('the family email timeline: first ten days, renewal, receipt, pause, ended, why, win-back', async () => {
  const booking = require('../src/booking');
  const B = require('../src/billing');
  const L = require('../src/lifecycle');
  const webhook = require('../src/webhook');
  const crypto = require('crypto');
  process.env.BOOKING_HOOK_KEY = 'hook-key-for-tests-0123456789';
  await booking.handle({ 'x-hook-key': process.env.BOOKING_HOOK_KEY }, { email: 'tess@example.com', name: 'Tess Tran' });
  delete process.env.BOOKING_HOOK_KEY;
  const tess = await signIn('tess@example.com');
  const cid = (await db.one(`select client_id from users where email='tess@example.com'`)).client_id;
  await db.q(`update clients set patient_first_name='Sam', stripe_customer_id='cus_tess', stripe_subscription_id='sub_tess', billing_status='Active' where client_id=$1`, [cid]);
  const saved = { stripe: B.stripe, key: process.env.STRIPE_SECRET_KEY, wh: process.env.STRIPE_WEBHOOK_SECRET };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const calls = []; B.stripe = async (m, path, params) => { calls.push(m + ' ' + path + ' ' + JSON.stringify(params || {})); return { id: 'x', url: 'https://stripe.test/portal' }; };
  const hook = async ev => {
    const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test').update(t + '.' + raw).digest('hex');
    const res = { code: 0, writeHead(c) { this.code = c; }, end() {} };
    await webhook.handle({ headers: { 'stripe-signature': 't=' + t + ',v1=' + sig } }, res, Buffer.from(raw));
    return res.code;
  };
  const subjects = from => mail.sent.slice(from).filter(m => m.to === 'tess@example.com' || /Tran family/i.test(m.subject)).map(m => m.subject);   // other test families have timelines too
  const { localToIso } = require('../src/time'); const { ymd } = require('../src/util'); const CFG = require('../src/config');
  const at = (base, days, hour) => new Date(localToIso(ymd(new Date(base.getTime() + days * 864e5), CFG.TZ) + 'T' + String(hour).padStart(2, '0') + ':00'));   // that local hour, N days on
  try {
    // Plan ready, not paid: the two nudges, once each, and never once they pay.
    await db.q(`update clients set plan_ready=true, plan_ready_at=now() where client_id=$1`, [cid]);
    const ready = new Date((await db.one(`select plan_ready_at from clients where client_id=$1`, [cid])).plan_ready_at);
    let n = mail.sent.length;
    await L.timed(at(ready, 4, L.SEND_HOUR)); await L.timed(at(ready, 4, L.SEND_HOUR)); await L.timed(at(ready, 11, L.SEND_HOUR));
    assert.deepEqual(subjects(n), ['InCadence Care: Your plan is waiting', 'InCadence Care: Checking in']);   // the 9 am after the third and tenth full days
    // First payment: the portal opens (existing email) and paid_at is set. Day-0 note an hour later.
    n = mail.sent.length;
    assert.equal(await hook({ type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_tess', subscription: 'sub_tess', billing_reason: 'subscription_create' } } }), 200);
    let cl = await db.one(`select * from clients where client_id=$1`, [cid]);
    assert.equal(cl.paid, true); assert.ok(cl.paid_at);
    assert.deepEqual(subjects(n), ['InCadence Care: Your portal is open']);
    const paid = new Date(cl.paid_at);
    n = mail.sent.length;
    await L.timed(new Date(paid.getTime() + 30 * 60e3));                       // 30 minutes: too soon
    assert.deepEqual(subjects(n), []);
    await L.timed(new Date(paid.getTime() + 90 * 60e3)); await L.timed(new Date(paid.getTime() + 95 * 60e3));
    assert.deepEqual(subjects(n), ['InCadence Care: A note from Joe']);
    assert.match(mail.sent[mail.sent.length - 1].html, /Hi Tess,/); assert.match(mail.sent[mail.sent.length - 1].html, /Sam’s road/);
    // Days 1, 3, 6, 10 at the send hour only; the plan-ready nudge never fires now that they paid.
    n = mail.sent.length;
    await L.timed(at(paid, 1, 8));
    assert.deepEqual(subjects(n), [], 'not at 8 am');
    for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) await L.timed(at(paid, d, L.SEND_HOUR));
    assert.deepEqual(subjects(n), ['InCadence Care: What you have now', 'InCadence Care: Three habits that make this work', 'InCadence Care: What the first weeks look like', 'InCadence Care: Ten days in']);
    // A family who paid long before this existed gets no stale "day one" note; month two lands in its window.
    n = mail.sent.length;
    await L.timed(at(paid, 25, L.SEND_HOUR)); assert.deepEqual(subjects(n), []);
    await L.timed(at(paid, 32, L.SEND_HOUR)); assert.deepEqual(subjects(n), ['InCadence Care: Month two']);
    // Families can turn the notes off; the switch stops everything.
    await api(tess, 'savePrefs', { prefs: { notes: false } });
    n = mail.sent.length; await L.timed(at(paid, 92, L.SEND_HOUR)); assert.deepEqual(subjects(n), []);
    await api(tess, 'savePrefs', { prefs: { notes: true } });
    await L.setEnabled(false); n = mail.sent.length; await L.timed(at(paid, 93, L.SEND_HOUR)); assert.deepEqual(subjects(n), []);
    await L.setEnabled(true); await L.timed(at(paid, 93, L.SEND_HOUR)); assert.deepEqual(subjects(n), ['InCadence Care: Month four']);
    // Three days before the charge: the renewal note with the month's numbers. Once per period.
    await api(tess, 'newTopic', { kind: 'question', title: 'Rides', body: 'Who drives Tuesday?' });
    const periodEnd = Math.floor(Date.now() / 1000) + 3 * 86400;
    n = mail.sent.length;
    assert.equal(await hook({ type: 'invoice.upcoming', data: { object: { customer: 'cus_tess', subscription: 'sub_tess', period_end: periodEnd, next_payment_attempt: periodEnd, amount_due: 59900 } } }), 200);
    assert.equal(await hook({ type: 'invoice.upcoming', data: { object: { customer: 'cus_tess', subscription: 'sub_tess', period_end: periodEnd, next_payment_attempt: periodEnd, amount_due: 59900 } } }), 200);
    assert.equal(subjects(n).length, 1); assert.match(subjects(n)[0], /^InCadence Care: Your next month starts /);
    assert.match(mail.sent[mail.sent.length - 1].html, /Pause or change billing/);
    // The second month's payment: "This month is covered", not "Your portal is open" again.
    n = mail.sent.length;
    assert.equal(await hook({ type: 'invoice.paid', data: { object: { id: 'in_2', customer: 'cus_tess', subscription: 'sub_tess', billing_reason: 'subscription_cycle', hosted_invoice_url: 'https://stripe.test/in_2' } } }), 200);
    assert.deepEqual(subjects(n), ['InCadence Care: This month is covered']);
    assert.match(mail.sent[mail.sent.length - 1].html, /Receipt/);
    // The family pauses from their own Billing page: Stripe is told, the family and the coordinator hear.
    n = mail.sent.length; calls.length = 0;
    const pz = await api(tess, 'pauseBilling', {});
    assert.equal(pz.ok, true, pz.error);
    assert.ok(calls.some(x => x.includes('pause_collection[behavior]')), calls.join('\n'));
    assert.deepEqual(subjects(n), ['InCadence Care: Your billing is paused', 'InCadence Care: Billing paused, The Tran family']);   // the family's note, and the coordinator's alert
    cl = await db.one(`select * from clients where client_id=$1`, [cid]); assert.equal(cl.billing_status, 'Paused');
    assert.equal((await api(tess, 'pauseBilling', { resume: true })).ok, true);
    // Cancelled in Stripe: the ended note with the one-click reasons, the coordinator alert, and no more monthly notes.
    n = mail.sent.length;
    assert.equal(await hook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_tess', customer: 'cus_tess', cancellation_details: { feedback: 'too_expensive', comment: 'Sam is home now' } } } }), 200);
    cl = await db.one(`select * from clients where client_id=$1`, [cid]);
    assert.ok(cl.cancelled_at); assert.equal(cl.billing_status, 'Cancelled'); assert.equal(cl.stripe_subscription_id, null); assert.match(cl.cancel_reason, /Too expensive, Sam is home now/);
    const s2 = subjects(n);
    assert.ok(s2.includes('InCadence Care: Your membership has ended'), s2.join(' | '));
    assert.ok(s2.some(x => /Cancelled, The Tran family/i.test(x)) || (await db.all(`select * from digest where lower(subject) like 'cancelled, the tran family%'`)).length, 'the coordinator hears (instant or digest, per their settings)');
    const endedMail = mail.sent.find(m => m.subject === 'InCadence Care: Your membership has ended');
    assert.match(endedMail.html, /\?why=cost/); assert.match(endedMail.html, /Sam is recovered/);
    n = mail.sent.length; await L.timed(at(paid, 152, L.SEND_HOUR)); assert.deepEqual(subjects(n), [], 'no month-six note after cancelling');
    // One click on "why": recorded, coordinator told. Then the 45-day check-in, once.
    assert.equal((await api(tess, 'leaveReason', { why: 'cost' })).ok, true);
    cl = await db.one(`select * from clients where client_id=$1`, [cid]); assert.match(cl.cancel_reason, /Family said: The cost/);
    const gone = new Date(cl.cancelled_at);
    n = mail.sent.length;
    await L.timed(at(gone, 45, L.SEND_HOUR)); assert.deepEqual(subjects(n), []);
    await L.timed(at(gone, 46, L.SEND_HOUR)); await L.timed(at(gone, 47, L.SEND_HOUR));
    assert.deepEqual(subjects(n), ['InCadence Care: Checking in on Sam']);
    // Everything sent is on the family's access log.
    const log = await db.all(`select action from audit where client_id=$1 and action like 'lifecycle:%' order by at`, [cid]);
    assert.ok(log.length >= 10, 'audit rows: ' + log.length);
  } finally { B.stripe = saved.stripe; process.env.STRIPE_SECRET_KEY = saved.key; process.env.STRIPE_WEBHOOK_SECRET = saved.wh; }
});

test('a finished intake shows "Plan ready to create" until the plan is sent; the builder edits drafts and items', async () => {
  const co = await signIn('joe@incadencecare.com');
  const C = require('../src/config');
  // Olga (from the Pay-when-ready test) has a submitted intake and a plan marked ready; take the plan back.
  const olga = await db.one(`select c.* from clients c join users u on u.client_id=c.client_id where u.email='olga@example.com'`);
  await db.q(`update clients set plan_ready=false where client_id=$1`, [olga.client_id]);
  let ib = await api(co, 'inbasket', {});
  const need = ib.needs.find(n => n.client_id === olga.client_id && n.kind === 'Plan');
  assert.ok(need, 'a Plan row for Olga'); assert.match(need.text, /Plan ready to create/); assert.equal(need.go, 'build'); assert.equal(need.pri, 1);
  assert.ok(ib.families.find(f => f.client_id === olga.client_id).flags.includes('Plan'));
  // Pick the family; edit a draft, approve it, add an item by hand.
  const cid = olga.client_id;
  const boot = await api(co, 'bootstrap', { clientId: cid });
  const drafts = (boot.plan || []).filter(p => p.draft === true);
  assert.ok(drafts.length, 'drafts from the intake rules');
  const d0 = drafts[0];
  const ed = await api(co, 'editPlanItem', { clientId: cid, planId: d0.plan_id, item: 'Ride home: confirm with her brother', detail: 'They said: not sorted yet', stage: C.STAGES[1], owner: 'Joe', target_date: '2026-11-01' });
  assert.equal(ed.ok, true, ed.error);
  let row = await db.one(`select * from plan_items where plan_id=$1`, [d0.plan_id]);
  assert.equal(row.item, 'Ride home: confirm with her brother'); assert.equal(row.stage, C.STAGES[1]); assert.equal(row.owner, 'Joe'); assert.equal(String(row.target_date).slice(0, 10), '2026-11-01'); assert.equal(row.draft, true, 'editing keeps it a draft');
  assert.equal((await api(co, 'approvePlanItem', { clientId: cid, planId: d0.plan_id })).ok, true);
  row = await db.one(`select * from plan_items where plan_id=$1`, [d0.plan_id]); assert.equal(row.draft, false);
  assert.match((await api(co, 'editPlanItem', { clientId: cid, planId: d0.plan_id, item: '   ' })).error, /Write the item/);
  assert.equal((await api(co, 'editPlanItem', { clientId: cid, planId: 'nope' })).ok, false);
  // Sending the plan clears the row.
  assert.equal((await api(co, 'setPlanReady', { clientId: cid, ready: true })).ok, true);
  ib = await api(co, 'inbasket', {});
  assert.ok(!ib.needs.find(n => n.client_id === olga.client_id && n.kind === 'Plan'), 'no Plan row once the plan is sent');
  // The consent never claims software writes the plan.
  const spec = require('../src/intakeSpec').intakeSpec();
  assert.ok(!spec.consent.some(([h, t]) => /\bAI\b/.test(h + ' ' + t)), 'no AI in the consent');
  assert.ok(spec.consent.some(([h, t]) => /written by a person/.test(t)));
});

test('implementation: editTask, the Circle switch, and the In Basket row once a paid family has nothing booked', async () => {
  const co = await signIn('joe@incadencecare.com');
  const olga = await db.one(`select c.* from clients c join users u on u.client_id=c.client_id where u.email='olga@example.com'`);
  const cid = olga.client_id;
  await db.q(`update clients set plan_ready=true, paid=true, paid_at=now() where client_id=$1`, [cid]);
  await db.q(`delete from appointments where client_id=$1`, [cid]);
  let ib = await api(co, 'inbasket', {});
  const need = ib.needs.find(n => n.client_id === cid && n.kind === 'Implement');
  assert.ok(need, 'an Implement row'); assert.equal(need.go, 'run'); assert.match(need.text, /nothing booked/);
  assert.equal((await api(co, 'addAppointment', { clientId: cid, title: 'Planning call with Joe', starts_at: '2026-12-01T10:00', location: 'Phone' })).ok, true);
  ib = await api(co, 'inbasket', {});
  assert.ok(!ib.needs.find(n => n.client_id === cid && n.kind === 'Implement'), 'gone once something is booked');
  // tasks can be edited from the dates screen
  const t = await api(co, 'addTask', { clientId: cid, title: 'Pet care for the hospital days', category: 'Family & ongoing support' });
  assert.equal(t.ok, true, t.error);
  assert.equal((await api(co, 'editTask', { clientId: cid, taskId: t.task.task_id, due_date: '2026-11-01', owner: 'Her brother' })).ok, true);
  const row = await db.one(`select * from tasks where task_id=$1`, [t.task.task_id]);
  assert.equal(String(row.due_date).slice(0, 10), '2026-11-01'); assert.equal(row.owner, 'Her brother'); assert.equal(row.title, 'Pet care for the hospital days');
  assert.match((await api(co, 'editTask', { clientId: cid, taskId: t.task.task_id, title: ' ' })).error, /Write what the task is/);
  // the Circle switch
  assert.equal((await api(co, 'setCircle', { clientId: cid, on: true })).client.circle_enabled, true);
  assert.equal((await api(co, 'setCircle', { clientId: cid, on: false })).client.circle_enabled, false);
  const olgaS = await signIn('olga@example.com');
  assert.match((await api(olgaS, 'setCircle', { on: true })).error, /Not allowed/);
  // the coordinator's bootstrap carries the latest recommendation too
  const boot = await api(co, 'bootstrap', { clientId: cid });
  assert.ok('recommended' in boot);
});

test("the coordinator's notes on a plan item never reach the family; the full PDF is the coordinator's alone; 30-minute idle sign-out", async () => {
  const co = await signIn('joe@incadencecare.com');
  const olga = await db.one(`select c.* from clients c join users u on u.client_id=c.client_id where u.email='olga@example.com'`);
  const cid = olga.client_id;
  const add = await api(co, 'addPlanItem', { clientId: cid, stage: 'The countdown', category: 'Care coordination', item: 'Arrange the ride home', detail: 'A named adult, confirmed the week of.', note: 'Vendor: Franklin Rides, $45, ask for Dee. We book it; they think a neighbor is driving.' });
  assert.equal(add.ok, true, add.error);
  const pid = add.item.plan_id;
  let row = await db.one(`select * from plan_items where plan_id=$1`, [pid]);
  assert.match(row.extra.note, /Franklin Rides/);
  // the coordinator sees the note; the family does not, on the page or in their PDF
  const cb = await api(co, 'bootstrap', { clientId: cid });
  assert.match(cb.plan.find(p => p.plan_id === pid).extra.note, /Franklin Rides/);
  const olgaS = await signIn('olga@example.com');
  const fb = await api(olgaS, 'bootstrap', {});
  const mine = fb.plan.find(p => p.plan_id === pid);
  assert.ok(mine, 'the family sees the item'); assert.equal(mine.extra.note, undefined, 'but not the note'); assert.equal(mine.detail, 'A named adult, confirmed the week of.');
  assert.equal(JSON.stringify(fb).includes('Franklin Rides'), false, 'the note is nowhere in the family bootstrap');
  // editing keeps or clears the note; a blank clears it
  assert.equal((await api(co, 'editPlanItem', { clientId: cid, planId: pid, note: 'Vendor: Franklin Rides. Booked for 7 am.' })).ok, true);
  row = await db.one(`select * from plan_items where plan_id=$1`, [pid]); assert.match(row.extra.note, /Booked for 7 am/);
  assert.equal((await api(co, 'editPlanItem', { clientId: cid, planId: pid, owner: 'Joe' })).ok, true);
  row = await db.one(`select * from plan_items where plan_id=$1`, [pid]); assert.match(row.extra.note, /Booked for 7 am/, 'an edit without note leaves it');
  // the PDFs: the family version has no note; the full version (coordinator only) has it
  const docs = require('../src/handlers/docs');
  const co_ctx = { role: 'coordinator', clientId: cid, email: 'joe@incadencecare.com' };
  const html = { fam: '', full: '' };
  const pdf = require('../src/pdf'); const saved = pdf.render;
  pdf.render = async h => { html.last = h; return Buffer.from('pdf'); };
  try {
    await docs.planPdf(co_ctx, {}); html.fam = html.last;
    await docs.planPdf(co_ctx, { full: true }); html.full = html.last;
    await docs.planPdf({ role: 'client', clientId: cid, email: 'olga@example.com' }, { full: true }); html.famFull = html.last;
  } finally { pdf.render = saved; }
  assert.ok(!/Franklin Rides/.test(html.fam)); assert.ok(/Franklin Rides/.test(html.full)); assert.ok(/FOR THE MEETING/.test(html.full));
  assert.ok(!/Franklin Rides/.test(html.famFull), 'a family asking for full gets the family version');
  // idle: a session untouched for 31 minutes is gone
  const C = require('../src/config'); assert.equal(C.IDLE_MINUTES, 30);
  await db.q(`update sessions set last_seen_at = now() - interval '31 minutes' where session_id=$1`, [olgaS]);
  const r = await api(olgaS, 'bootstrap', {});
  assert.equal(r.ok, false); assert.equal(r.error, 'signed_out');
});

test('the hospital question puts that hospital (facts, walk, campus map) on the plan; a coordinator pick wins', async () => {
  await db.q(`insert into users (email,name,role,client_id) values ('hana@example.com','Hana H','client','c2') on conflict (email) do nothing`);
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) - 'walk_id' - 'walk_by' where client_id='c2'`);
  const w1 = (await db.one(`insert into hospital_walks (walk_id,name,steps) values ('hw1','Test General Hospital','[]') on conflict (walk_id) do update set name=excluded.name returning walk_id`)).walk_id;
  await db.q(`insert into hospital_walks (walk_id,name,steps) values ('hw2','Other Test Hospital','[]') on conflict (walk_id) do nothing`);
  const s = await signIn('hana@example.com');
  const spec = (await api(s, 'bootstrap', {})).intakeSpec;
  const hq = spec.steps.flatMap(st => st.qs).find(q => q.id === 'G.7');
  assert.ok(hq && hq.type === 'select'); assert.ok(spec.hospitals.includes('Test General Hospital'));
  assert.equal((await api(s, 'saveIntake', { answers: { 'G.7': { a: 'Test General Hospital', n: '' } } })).ok, true);
  let cl = await db.one(`select extra from clients where client_id='c2'`); assert.equal(cl.extra.walk_id, w1); assert.equal(cl.extra.walk_by, 'intake');
  await api(s, 'saveIntake', { answers: { 'G.7': { a: "We don't know yet", n: '' } } });
  cl = await db.one(`select extra from clients where client_id='c2'`); assert.equal(cl.extra.walk_id, undefined, 'a changed answer takes it back');
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) || '{"walk_id":"hw2","walk_by":"coordinator"}' where client_id='c2'`);
  await api(s, 'saveIntake', { answers: { 'G.7': { a: 'Test General Hospital', n: '' } } });
  cl = await db.one(`select extra from clients where client_id='c2'`); assert.equal(cl.extra.walk_id, 'hw2', 'the coordinator pick stays');
  await db.q(`update clients set extra = coalesce(extra,'{}'::jsonb) - 'walk_id' - 'walk_by' where client_id='c2'`);
  await db.q(`delete from hospital_walks where walk_id in ('hw1','hw2')`);
});

test

test('the master intake: modes, per-area depth, the emergency path, flags and plan drafts', () => {
  const intake = require('../src/intake');
  const S = require('../src/intakeSpec');
  const A = o => { const r = {}; for (const k in o) r[k] = { a: o[k], n: '' }; return r; };
  const ids = a => intake.visibleQs(A(a)).map(q => q.id);
  const fam = { '0.1': "I'm a family member or friend" };
  const quick = { ...fam, '0.1a': S.INTAKE_STEPS_[0].qs[1].opts[0] }, thorough = { ...fam, '0.1a': S.INTAKE_STEPS_[0].qs[1].opts[1] };
  const n = ids(quick).length; assert.ok(n >= 55 && n <= 75, 'quick mode is about 55–70 questions, got ' + n);
  assert.ok(!ids(quick).includes('O3.12'), 'quick skips the standards layer');
  assert.ok(ids({ ...quick, 'Z.O3': 'yes' }).includes('O3.12'), '"ask me more about this" opens a skipped section');
  // Gated: insurance only when they asked for help with bills, records or authorizations.
  assert.ok(!ids(thorough).includes('E.carrier'));
  assert.ok(ids({ ...thorough, F: S.SVC_TEXT.bills }).includes('E.carrier'));
  // Per-area depth: "just handle it" drops that area's precision questions, not the base ones.
  const dec = { ...fam, '0.1a': S.INTAKE_STEPS_[0].qs[1].opts[2], F: S.SVC_TEXT.pets, 'M.4': 'Dog' };
  assert.ok(ids(dec).includes('F.d.pets') && ids(dec).includes('M.4e'));
  assert.ok(!ids({ ...dec, 'F.d.pets': S.JUST_HANDLE }).includes('M.4e'));
  assert.ok(ids({ ...dec, 'F.d.pets': S.JUST_HANDLE }).includes('M.4a'));
  // Children by age, from the box under M.1.
  const kids = { ...thorough, F: S.SVC_TEXT.childcare, 'M.1': 'Yes', 'M.1_d': '18 months and 7' };
  assert.ok(ids(kids).includes('M.1a') && ids(kids).includes('M.1e') && !ids(kids).includes('M.1h'));
  // The patient filling it out: no "About you" or "Contacting them".
  assert.ok(!ids({ '0.1': "I'm the person having surgery" }).some(x => /^(B|D)\./.test(x)));
  // Emergency: only the em questions until they circle back.
  const em = ids({ ...fam, 'G.6': S.EMERGENCY_ });
  assert.ok(em.includes('G.6b') && em.includes('G.7') && !em.includes('K.1'));
  assert.ok(ids({ ...fam, 'G.6': S.EMERGENCY_, _full: 'yes' }).includes('K.1'));
  // An answer to a question that is now hidden opens nothing.
  assert.ok(!ids({ ...thorough, 'L.3': 'No', 'L.3a': 'High' }).includes('L.3a'));
  // Flags, per the register.
  const flags = intake.intakeFlags(A({ ...thorough, 'H2.1': 'Not yet', 'I.3': 'No bending, lifting, or twisting', 'M.1': 'Yes', 'M.1_d': '3', 'N.1': 'Yes, mixed', 'N.1b': "Commercial driver's license (CDL)", 'P.1': S.RNS_, 'O3.15': 'Her garden' }));
  const has = re => flags.some(f => re.test(f.label));
  assert.ok(has(/Fasting times/) && has(/LIFTING CONFLICT/) && has(/Licensed job/) && has(/return to work is far out/) && has(/No named escort/) && has(/rather we didn't touch/));
  assert.ok(flags.some(f => f.tier === 'Declined' && f.id === 'P.1'), 'a decline reaches the reviewer as a decline');
  // Every choice question offers "I don't know" unless it has its own way to say it, or is marked nodk.
  const g3 = S.INTAKE_STEPS_.flatMap(st => st.qs).find(q => q.id === 'K.4');
  assert.ok(g3.opts.includes(S.DK_));
});

test('marketplace step 1: vendors by city, booked on a plan item, the family sees only that one; the needs log waits for 11 families', async () => {
  const co = await signIn('joe@incadencecare.com');
  const bad = await api(co, 'saveVendor', { name: 'X' }); assert.match(bad.error, /city/);
  const v = (await api(co, 'saveVendor', { name: 'Franklin Rides', city: 'Franklin', state: 'tn', service: 'Rides', phone: '(615) 555-0199', website: 'javascript:alert(1)', insured: true, notes: 'Owner is Tom' })).vendor;
  assert.equal(v.state, 'TN'); assert.equal(v.website, '', 'only https links'); assert.equal(v.insured, true);
  await api(co, 'saveVendor', { name: 'Old Cab', city: 'Franklin', service: 'Rides', active: false });
  const pid = (await db.one(`insert into plan_items (plan_id, client_id, stage, category, item, status) values ('mk1','c2','The day of surgery','Care coordination','Ride home from the hospital','Not started') on conflict (plan_id) do update set item=excluded.item returning plan_id`)).plan_id;
  const old = await db.one(`select vendor_id from vendors where name='Old Cab'`);
  assert.match((await api(co, 'setPlanVendor', { clientId: 'c2', planId: pid, vendorId: old.vendor_id })).error, /not on the list/, 'a vendor not in use cannot be booked');
  assert.equal((await api(co, 'setPlanVendor', { clientId: 'c2', planId: pid, vendorId: v.vendor_id })).ok, true);
  const cb = await api(co, 'bootstrap', { clientId: 'c2' }); assert.ok(cb.vendors.length >= 2); assert.ok(cb.vendorServices.includes('Meals'));
  await db.q(`update clients set paid=true where client_id='c2'`);
  const fam = await api(await signIn('hana@example.com'), 'bootstrap', {});
  const item = fam.plan.find(p => p.plan_id === pid);
  assert.deepEqual(item.vendor, { name: 'Franklin Rides', service: 'Rides', phone: '(615) 555-0199', website: '' });
  assert.equal(fam.vendors, undefined, 'families never get the vendor list'); assert.equal(JSON.stringify(fam).includes('Owner is Tom'), false, 'nor the notes');
  const pat = await signIn('hana@example.com'); assert.equal((await api(pat, 'saveVendor', { name: 'Y', city: 'Z' })).error, 'Not allowed');
  // the needs log: built from the plan; a day shows only with 11 families behind it
  const MK = require('../src/handlers/market');
  assert.equal(MK.needOf('Ride home from the hospital'), 'Ride'); assert.equal(MK.needOf('Meals the first week'), 'Meals'); assert.equal(MK.needOf('Sign the consent'), '');
  await db.q(`update clients set surgery_date='2026-10-10' where client_id='c2'`);
  await db.q(`update plan_items set target_date='2026-10-13' where plan_id=$1`, [pid]);
  await MK.logNeeds();
  let r = await api(co, 'needsReport', {}); assert.equal(r.min, 11);
  let ride = r.rows.find(x => x.need === 'Ride'); assert.ok(ride);
  const before = ride.families;
  for (let i = 0; i < 11; i++) await db.q(`insert into need_events (event_id, client_id, hospital, surgery, need, day) values ($1,'c2',$2,'','Ride',3) on conflict (event_id) do nothing`, ['fake' + i, ride.hospital === 'Hospital not chosen yet' ? '' : ride.hospital]);
  r = await api(co, 'needsReport', {}); ride = r.rows.find(x => x.need === 'Ride');
  assert.equal(ride.families, before, 'more items from the same family do not add families');
  r.rows.forEach(x => assert.equal(x.median_day === null, x.families < 11, 'a day shows only with 11 or more families'));
  await db.q(`delete from need_events where event_id like 'fake%'`);
  await db.q(`delete from plan_items where plan_id=$1`, [pid]); await db.q(`delete from vendors`);
});

test('recordings: pieces join, the clinician OK is required, the transcript reaches the coordinator first and the family only when shared', async () => {
  process.env.TRANSCRIBE_FAKE = '1';
  const { execSync } = require('child_process');
  const f = require('os').tmpdir() + '/memo-test.m4a'; execSync(`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=440:duration=3 -c:a aac ${f}`); const m4a = require('fs').readFileSync(f);
  const co = await signIn('joe@incadencecare.com');
  const half = Math.ceil(m4a.length / 2), sid = 'abcdefgh12345';
  const p1 = await api(co, 'addRecording', { clientId: 'c2', sessionId: sid, part: 0, parts: 2, b64: m4a.subarray(0, half).toString('base64'), name: 'memo.m4a', type: 'audio/mp4', title: 'Pre-op visit' });
  assert.equal(p1.ok, true, p1.error); assert.equal(p1.part, 0);
  const p2 = await api(co, 'addRecording', { clientId: 'c2', sessionId: sid, part: 1, parts: 2, b64: m4a.subarray(half).toString('base64'), name: 'memo.m4a', type: 'audio/mp4', size: m4a.length, title: 'Pre-op visit' });
  assert.equal(p2.ok, true, p2.error); assert.equal(p2.upload.kind, 'Recording'); assert.equal(p2.upload.shared, false);
  const uid = p2.upload.upload_id;
  assert.equal((await require('../src/storage').get((await db.one(`select storage_key from uploads where upload_id=$1`, [uid])).storage_key)).length, m4a.length, 'the pieces join in order');
  assert.match((await api(co, 'transcribe', { clientId: 'c2', uploadId: uid })).error, /clinician agreed/);
  const t = await api(co, 'transcribe', { clientId: 'c2', uploadId: uid, consent: true, title: 'Pre-op with Dr. Smith', apptDate: '2026-10-01' });
  assert.equal(t.ok, true, t.error); assert.equal(t.transcript.status, 'Working'); assert.ok(t.transcript.seconds >= 2, 'the length is measured');
  assert.match((await api(co, 'transcribe', { clientId: 'c2', uploadId: uid, consent: true })).error, /already has a transcript/);
  await require('../src/handlers/recordings').checkTranscripts();
  let b = await api(co, 'bootstrap', { clientId: 'c2' });
  const tr = b.transcripts.find(x => x.transcript_id === t.transcript.transcript_id);
  assert.equal(tr.status, 'Ready'); assert.match(tr.text, /good morning/i);
  const sam = await signIn('sam@example.com');
  assert.equal((await api(sam, 'bootstrap', {})).transcripts.length, 0, 'the family sees nothing until it is shared');
  assert.match((await api(sam, 'saveTranscript', { transcriptId: tr.transcript_id, shared: true })).error, /Not allowed/);
  await api(co, 'saveTranscript', { clientId: 'c2', transcriptId: tr.transcript_id, text: tr.text + '\n\n(Checked by Joe.)', shared: true });
  b = await api(sam, 'bootstrap', {});
  assert.equal(b.transcripts.length, 1); assert.match(b.transcripts[0].text, /Checked by Joe/); assert.equal(b.transcripts[0].upload_id, undefined);
  delete process.env.TRANSCRIBE_FAKE;
});
