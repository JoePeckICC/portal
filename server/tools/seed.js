// Synthetic data for load tests: N families with a realistic year of activity each. Never run against production.
'use strict';
const { Client } = require('pg');
const N = Number(process.argv[2] || 1000);
const crypto = require('crypto');
const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const pick = a => a[Math.floor(Math.random() * a.length)];
const STAGES = ['The diagnosis', 'Before surgery', 'The week of', 'Surgery day', 'The hospital stay', 'First weeks home', 'The long middle'];
const CATS = ['Care coordination', 'Understanding & advocacy', 'Family & ongoing support'];
const FIRST = ['Pat', 'Sam', 'Alex', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie', 'Drew'], LAST = ['Nguyen', 'Garcia', 'Smith', 'Johnson', 'Lee', 'Patel', 'Brown', 'Davis', 'Miller', 'Wilson'];
const daysAgo = d => new Date(Date.now() - d * 864e5);

async function copy(db, table, cols, rows) {
  if (!rows.length) return;
  // multi-row insert in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500), vals = [], ph = [];
    chunk.forEach((r, ri) => { ph.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')'); cols.forEach(c => vals.push(r[c] === undefined ? null : r[c])); });
    await db.query(`insert into ${table} (${cols.join(',')}) values ${ph.join(',')} on conflict do nothing`, vals);
  }
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const t0 = Date.now();
  await db.query(`insert into users (email,name,role) values ('joe@incadencecare.com','Joe Peck','coordinator') on conflict (email) do nothing`);
  for (let f = 0; f < N; f++) {
    const cid = 'l' + String(f).padStart(5, '0'), fn = pick(FIRST), ln = pick(LAST);
    const paid = Math.random() > 0.1, sd = daysAgo(Math.round(Math.random() * 300 - 150));
    await db.query(`insert into clients (client_id,family_name,patient_first_name,patient_last_name,surgery_date,current_stage,status,coordinator_email,circle_enabled,paid,plan_ready,billing_status,monthly_amount,stripe_customer_id)
      values ($1,$2,$3,$4,$5,$6,'Active','joe@incadencecare.com',$7,$8,$9,$10,599,$11) on conflict do nothing`,
      [cid, ln, fn, ln, sd.toISOString().slice(0, 10), pick(STAGES), Math.random() > 0.5, paid, paid, paid ? 'Active' : '', 'cus_' + cid]);
    const users = [{ email: `${cid}.patient@example.com`, name: fn + ' ' + ln, role: 'client', client_id: cid, relationship: '' }, { email: `${cid}.fam@example.com`, name: 'Family ' + ln, role: 'family', client_id: cid, relationship: 'Spouse' }];
    if (Math.random() > 0.5) users.push({ email: `${cid}.sup@example.com`, name: 'Aunt ' + ln, role: 'supporter', client_id: cid, relationship: 'Aunt' });
    await copy(db, 'users', ['email', 'name', 'role', 'client_id', 'relationship'], users);
    const topics = Array.from({ length: 6 }, (_, i) => ({ topic_id: id(), client_id: cid, title: ['Question for Joe', 'About the plan', 'Billing', 'Automated messages', 'Help with rides', 'Something else'][i], kind: ['question', 'plan', 'billing', 'auto', 'other', 'other'][i], status: 'Active', created_by: users[0].email, created_at: daysAgo(200), last_at: daysAgo(Math.random() * 30) }));
    await copy(db, 'topics', ['topic_id', 'client_id', 'title', 'kind', 'status', 'created_by', 'created_at', 'last_at'], topics);
    const msgs = Array.from({ length: 220 }, (_, i) => { const t = pick(topics); const fromCo = Math.random() > 0.5; return { message_id: id(), client_id: cid, topic_id: t.topic_id, sender_email: t.kind === 'auto' ? 'system' : fromCo ? 'joe@incadencecare.com' : users[0].email, sent_at: daysAgo(Math.random() * 200), body: 'Message ' + i + ' about the plan, the ride home, and what to pack. '.repeat(1 + Math.floor(Math.random() * 3)), read_by_client: Math.random() > 0.2, read_by_coordinator: Math.random() > 0.05, urgent: Math.random() > 0.98, attachments: '[]' }; });
    await copy(db, 'messages', ['message_id', 'client_id', 'topic_id', 'sender_email', 'sent_at', 'body', 'read_by_client', 'read_by_coordinator', 'urgent', 'attachments'], msgs);
    await copy(db, 'plan_items', ['plan_id', 'client_id', 'stage', 'category', 'item', 'detail', 'owner', 'status', 'draft'], Array.from({ length: 14 }, (_, i) => ({ plan_id: id(), client_id: cid, stage: pick(STAGES), category: pick(CATS), item: 'Plan item ' + i, detail: 'Some detail about why.', owner: i % 3 ? 'Coordinator' : 'Family', status: pick(['Not started', 'In progress', 'Done']), draft: i > 11 })));
    await copy(db, 'tasks', ['task_id', 'client_id', 'title', 'category', 'status', 'owner', 'due_date'], Array.from({ length: 24 }, (_, i) => ({ task_id: id(), client_id: cid, title: 'Task ' + i, category: pick(CATS), status: pick(['Not started', 'Done', 'Done', 'In progress']), owner: i % 4 ? 'Joe' : fn, due_date: daysAgo(Math.random() * 60 - 30).toISOString().slice(0, 10) })));
    await copy(db, 'goals', ['goal_id', 'client_id', 'title', 'status', 'added_by'], Array.from({ length: 4 }, (_, i) => ({ goal_id: id(), client_id: cid, title: 'Goal ' + i, status: 'Active', added_by: users[0].email })));
    await copy(db, 'appointments', ['appt_id', 'client_id', 'title', 'starts_at', 'location', 'status'], Array.from({ length: 9 }, (_, i) => ({ appt_id: id(), client_id: cid, title: i % 3 ? 'Follow-up' : 'Quick check-in with Joe', starts_at: daysAgo(Math.random() * 90 - 45), location: 'VUMC', status: 'Scheduled' })));
    await copy(db, 'care_team', ['member_id', 'client_id', 'name', 'role', 'org', 'kind', 'added_by', 'status'], Array.from({ length: 4 }, (_, i) => ({ member_id: id(), client_id: cid, name: 'Dr. ' + pick(LAST), role: pick(['Surgeon', 'Neurologist', 'PT']), org: 'VUMC', kind: 'provider', added_by: users[0].email, status: 'Active' })));
    const meds = Array.from({ length: 6 }, (_, i) => ({ med_id: id(), client_id: cid, name: pick(['Keppra', 'Dexamethasone', 'Oxycodone', 'Senna', 'Tylenol', 'Famotidine']) + ' ' + i, dose: '500 mg', frequency: i > 4 ? 'As needed' : 'Daily', times: i > 4 ? '' : '08:00,20:00', status: i === 0 ? 'Pending review' : 'Accepted', added_by: users[0].email, added_at: daysAgo(40) }));
    await copy(db, 'medications', ['med_id', 'client_id', 'name', 'dose', 'frequency', 'times', 'status', 'added_by', 'added_at'], meds);
    const doses = []; meds.slice(0, 5).forEach(m => { for (let d = 0; d < 30; d++) for (const h of [8, 20]) { const due = new Date(daysAgo(d)); due.setUTCHours(h + 5, 0, 0, 0); doses.push({ dose_id: id(), client_id: cid, med_id: m.med_id, due_at: due, status: 'Taken', taken_at: due, by: users[0].email }); } });
    await copy(db, 'doses', ['dose_id', 'client_id', 'med_id', 'due_at', 'status', 'taken_at', 'by'], doses);
    await copy(db, 'uploads', ['upload_id', 'client_id', 'kind', 'name', 'storage_key', 'mime', 'bytes', 'uploaded_by', 'shared'], Array.from({ length: 6 }, (_, i) => ({ upload_id: id(), client_id: cid, kind: pick(['Discharge', 'Insurance', 'Forms', 'Other']), name: 'file' + i + '.pdf', storage_key: cid + '/x/file' + i + '.pdf', mime: 'application/pdf', bytes: 120000, uploaded_by: users[0].email, shared: true })));
    await copy(db, 'updates', ['update_id', 'client_id', 'posted_by', 'stage', 'title', 'body', 'visible_to_circle'], Array.from({ length: 12 }, (_, i) => ({ update_id: id(), client_id: cid, posted_by: users[0].email, stage: pick(STAGES), title: 'Update ' + i, body: 'How things are going.', visible_to_circle: true })));
    await copy(db, 'intake_answers', ['client_id', 'question_id', 'answer'], [['_status', 'Submitted'], ['0.1', "I'm the person having surgery"], ['G.4', 'Craniotomy'], ['G.6', sd.toISOString().slice(0, 10)], ['A.2', 'Lives with others'], ['L.1', 'My sister']].map(([q, a]) => ({ client_id: cid, question_id: q, answer: a })));
    await copy(db, 'audit', ['at', 'who', 'role', 'action', 'client_id', 'detail'], Array.from({ length: 300 }, () => ({ at: daysAgo(Math.random() * 300), who: users[0].email, role: 'client', action: pick(['bootstrap', 'sendMessage', 'takeDose', 'readTopic']), client_id: cid, detail: '{}' })));
    if (f % 100 === 99) console.log(`${f + 1} families, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const counts = await db.query(`select (select count(*) from clients) clients, (select count(*) from messages) messages, (select count(*) from doses) doses, (select count(*) from audit) audit`);
  console.log(counts.rows[0]); await db.end();
})().catch(e => { console.error(e); process.exit(1); });
