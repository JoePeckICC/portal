// Fake families for the test copy (staging). Made-up people only, so nobody working on the test copy ever sees a real
// client. Refuses to run unless APP_ENV=staging. Safe to re-run: it only adds what is missing.
//   APP_ENV=staging DATABASE_URL=... node server/tools/seed-staging.js
'use strict';
if (process.env.APP_ENV !== 'staging') { console.error('Refusing: APP_ENV must be "staging". This never runs against the live site.'); process.exit(1); }
const { Client } = require('pg');
const crypto = require('crypto');
const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const day = d => new Date(Date.now() + d * 864e5);
const ymd = d => day(d).toISOString().slice(0, 10);
const CO = process.env.STAGING_COORDINATOR || 'joe@incadencecare.com';

// Every name, date and story here is invented.
const FAMILIES = [
  { cid: 'demo1', first: 'Walt', last: 'Demo', surgery: 'Craniotomy for a tumor (including meningioma)', sd: -3, stage: 'In a room',
    posts: [[-4, 'Getting ready', 'Bags are packed.', 'Walt is calm and watching the game.'], [-3, 'In surgery', 'In surgery now.', ''], [-3, 'In recovery', 'Out of surgery.', 'The surgeon says it went well.'], [-2, 'In a room', 'Moved to a room.', 'Tired, but joking with the nurses.']] },
  { cid: 'demo2', first: 'Rosa', last: 'Sample', surgery: 'Spinal fusion, mid or lower back', sd: 10, stage: 'Getting ready',
    posts: [[-1, 'Getting ready', 'Surgery is set.', 'Ten days out. Meals would help the week after.']] },
  { cid: 'demo3', first: 'Hank', last: 'Testfield', surgery: 'Deep brain stimulation (DBS)', sd: -20, stage: 'Home',
    posts: [[-21, 'Getting ready', 'Tomorrow is the day.', ''], [-20, 'In surgery', 'In surgery now.', ''], [-18, 'Home', 'Home!', 'First walk around the block today.']] },
];

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  await db.query(`insert into users (email,name,role) values ($1,'Coordinator','coordinator') on conflict (email) do nothing`, [CO]);
  for (const f of FAMILIES) {
    await db.query(`insert into clients (client_id,family_name,patient_first_name,patient_last_name,surgery_date,current_stage,status,coordinator_email,circle_enabled,paid,plan_ready)
      values ($1,$2,$3,$2,$4,$5,'Active',$6,true,true,true) on conflict (client_id) do nothing`, [f.cid, f.last, f.first, ymd(f.sd), f.stage, CO]);
    const people = [
      [`${f.cid}.patient@example.com`, `${f.first} ${f.last}`, 'client', ''],
      [`${f.cid}.spouse@example.com`, `Pat ${f.last}`, 'family', 'Spouse'],
      [`${f.cid}.friend@example.com`, `Lee Friend`, 'supporter', 'Friend'],
    ];
    for (const [email, name, role, rel] of people)
      await db.query(`insert into users (email,name,role,client_id,relationship) values ($1,$2,$3,$4,$5) on conflict (email) do nothing`, [email, name, role, f.cid, rel]);
    const has = await db.query(`select 1 from updates where client_id=$1 limit 1`, [f.cid]);
    if (!has.rowCount) for (const [d, step, title, body] of f.posts)
      await db.query(`insert into updates (update_id,client_id,posted_at,posted_by,stage,title,body,visible_to_circle,extra) values ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
        [id(), f.cid, day(d), `${f.cid}.spouse@example.com`, step, title, body, JSON.stringify({ step })]);
    await db.query(`insert into intake_answers (client_id,question_id,answer) values ($1,'G.4b',$2),($1,'G.learn','Yes, count it') on conflict do nothing`, [f.cid, f.surgery]).catch(e => console.warn('intake answers skipped:', e.message));
  }
  console.log(`Seeded ${FAMILIES.length} made-up families: ${FAMILIES.map(f => f.cid).join(', ')}. Sign in as ${CO}, or as demoN.patient@example.com.`);
  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
