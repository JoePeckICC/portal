'use strict';
// Small, repeatable schema changes applied when the API starts. Each statement is safe to run
// again (IF NOT EXISTS), so every instance can run this on boot without coordination.
const db = require('./db');

const STEPS = [
  // ---- appointment recordings into text (2026-09-27): see handlers/recordings.js
  `create table if not exists transcripts (
     transcript_id text primary key, client_id text not null references clients(client_id) on delete cascade, upload_id text not null default '',
     title text not null default '', appt_date date, status text not null default 'Working', op_name text not null default '', speech_key text not null default '',
     seconds integer not null default 0, billed_seconds integer not null default 0, text text not null default '', error text not null default '',
     shared boolean not null default false, consent_by text not null default '', consent_at timestamptz, created_by text not null default '',
     created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create index if not exists transcripts_client_idx on transcripts(client_id)`,
  // ---- the marketplace, step 1, and the needs log (2026-09-27): see handlers/market.js
  `create table if not exists vendors (
     vendor_id text primary key, name text not null, city text not null default '', state text not null default '',
     service text not null default 'Other', phone text not null default '', email text not null default '', website text not null default '',
     price text not null default '', insured boolean not null default false, checked boolean not null default false,
     notes text not null default '', active boolean not null default true, updated_by text not null default '', updated_at timestamptz not null default now())`,
  `create table if not exists need_events (
     event_id text primary key, client_id text not null references clients(client_id) on delete cascade, hospital text not null default '',
     surgery text not null default '', need text not null, day integer not null, logged_at timestamptz not null default now())`,
  `create index if not exists need_events_group_idx on need_events(hospital, need)`,
  // ---- the Circle, grown up (2026-09-27): reactions, comments, ways to help
  `create table if not exists update_reactions (
     update_id text not null references updates(update_id) on delete cascade,
     who       text not null,
     kind      text not null,
     at        timestamptz not null default now(),
     primary key (update_id, who, kind)
   )`,
  `create table if not exists update_comments (
     comment_id text primary key,
     update_id  text not null references updates(update_id) on delete cascade,
     client_id  text not null references clients(client_id) on delete cascade,
     author     text not null default '',
     email      text not null default '',
     body       text not null default '',
     status     text not null default 'Pending',
     by_role    text not null default '',
     at         timestamptz not null default now()
   )`,
  `create index if not exists update_comments_client_idx on update_comments(client_id, at)`,
  `create table if not exists help_items (
     item_id       text primary key,
     client_id     text not null references clients(client_id) on delete cascade,
     title         text not null,
     detail        text not null default '',
     when_text     text not null default '',
     status        text not null default 'Open',
     claimed_by    text not null default '',
     claimed_email text not null default '',
     claimed_at    timestamptz,
     added_by      text not null default '',
     added_at      timestamptz not null default now()
   )`,
  // ---- checklists: what each family has ticked (2026-09-27)
  // stage names in Joe's words (2026-09-27): every row that carries a stage moves to the new name
  ...[['The diagnosis','Diagnosis'],['Before surgery','The countdown'],['The week of','The last week'],['Surgery day','The day of surgery'],['The hospital stay','ICU'],['First weeks home','Home'],['The long middle','Recovery'],['Alumni','Finding wisdom']].flatMap(([o, n]) => [
    `update clients set current_stage='${n}' where current_stage='${o}'`,
    `update plan_items set stage='${n}' where stage='${o}'`,
    `update updates set stage='${n}' where stage='${o}'`,
    `update resources set stage='${n}' where stage='${o}'`,
  ]),
  `create table if not exists escalations (
     esc_id     text primary key,
     client_id  text not null references clients(client_id) on delete cascade,
     at         timestamptz not null default now(),
     by         text not null default '',
     kind       text not null default '',
     hospital   text not null default '',
     what       text not null default '',
     outcome    text not null default '',
     outcome_by text not null default '',
     outcome_at timestamptz
   )`,
  `create table if not exists checkins (
     checkin_id text primary key,
     client_id  text not null references clients(client_id) on delete cascade,
     at         timestamptz not null default now(),
     by         text not null default '',
     role       text not null default '',
     mood       integer,
     pain       integer,
     words      text not null default '',
     caregiver  boolean not null default false
   )`,
  `create table if not exists symptoms (
     symptom_id text primary key,
     client_id  text not null references clients(client_id) on delete cascade,
     at         timestamptz not null default now(),
     by         text not null default '',
     name       text not null default '',
     severity   integer,
     note       text not null default ''
   )`,
  `create table if not exists journal (
     entry_id  text primary key,
     client_id text not null references clients(client_id) on delete cascade,
     by        text not null,
     at        timestamptz not null default now(),
     prompt    text not null default '',
     body      text not null default ''
   )`,
  `create table if not exists coverage (
     slot_id   text primary key,
     client_id text not null references clients(client_id) on delete cascade,
     day       date not null,
     part      text not null,
     kind      text not null default 'with',
     who       text not null default '',
     note      text not null default '',
     added_by  text not null default '',
     unique (client_id, day, part, kind)
   )`,
  `create table if not exists time_log (
     log_id    text primary key,
     client_id text not null references clients(client_id) on delete cascade,
     at        timestamptz not null default now(),
     by        text not null default '',
     minutes   integer not null default 0,
     what      text not null default ''
   )`,
  `create table if not exists hospital_walks (
     walk_id    text primary key,
     name       text not null default '',
     address    text not null default '',
     maps_url   text not null default '',
     phone      text not null default '',
     notes      text not null default '',
     steps      jsonb not null default '[]',
     updated_by text not null default '',
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists explainers (
     key        text primary key,
     title      text not null default '',
     summary    text not null default '',
     simpler    text not null default '',
     figure     text not null default 'body',
     parts      jsonb not null default '[]',
     updated_by text not null default '',
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists hospital_facts (
     fact_id     text primary key,
     hospital    text not null,
     state       text not null default '',
     category    text not null default '',
     topic       text not null default '',
     detail      text not null default '',
     source_url  text not null default '',
     source_type text not null default '',
     access_date text not null default '',
     flag        text not null default '',
     ok          boolean not null default false
   )`,
  `create index if not exists hospital_facts_h on hospital_facts(hospital)`,
  `create table if not exists hospital_docs (doc_id text primary key, hospital text not null, type text not null default '', title text not null default '', url text not null default '', version text not null default '', notes text not null default '')`,
  `create table if not exists hospital_verify (verify_id text primary key, hospital text not null, issue text not null default '', sources text not null default '', done boolean not null default false)`,
  `create table if not exists outside_resources (res_id text primary key, name text not null, category text not null default '', area text not null default '', what text not null default '', eligibility text not null default '', contact text not null default '', source_url text not null default '', source_type text not null default '', access_date text not null default '', flag text not null default '')`,
  `alter table hospital_walks add column if not exists state text not null default ''`,
  `alter table hospital_walks add column if not exists city text not null default ''`,
  `create table if not exists held_mail (
     item_id    text primary key,
     to_email   text not null,
     kind       text not null default '',
     subject    text not null default '',
     lead       text not null default '',
     body       text not null default '',
     cta        text not null default '',
     url        text not null default '',
     created_at timestamptz not null default now(),
     sent_at    timestamptz
   )`,
  `create table if not exists checklist_ticks (
     client_id text not null references clients(client_id) on delete cascade,
     list_id   text not null,
     item_id   text not null,
     done_at   timestamptz not null default now(),
     done_by   text not null default '',
     primary key (client_id, list_id, item_id)
   )`,
  // ---- updates as a timeline: what kind of moment, a longer note behind "More", a verse or quote (2026-09-25)
  `alter table updates add column if not exists kind text not null default 'Family'`,
  `alter table updates add column if not exists detail text not null default ''`,
  `alter table updates add column if not exists quote text not null default ''`,
  `alter table updates add column if not exists quote_ref text not null default ''`,
  // ---- the family email timeline (lifecycle.js), 2026-09-25
  `alter table clients add column if not exists paid_at timestamptz`,
  `alter table clients add column if not exists plan_ready_at timestamptz`,
  `alter table clients add column if not exists cancelled_at timestamptz`,
  `alter table clients add column if not exists cancel_reason text not null default ''`,
  `create table if not exists lifecycle_sent (
     client_id text not null references clients(client_id) on delete cascade,
     key       text not null,
     sent_at   timestamptz not null default now(),
     primary key (client_id, key)
   )`,
  // passwords
  `alter table users add column if not exists password_hash text`,
  `alter table users add column if not exists password_set_at timestamptz`,
  // second step: a 6-digit code emailed on a new device
  `create table if not exists login_challenges (
     challenge_id text primary key,
     email        text not null references users(email) on delete cascade on update cascade,
     code_hash    text not null,
     attempts     integer not null default 0,
     created_at   timestamptz not null default now(),
     expires_at   timestamptz not null,
     used_at      timestamptz
   )`,
  `create index if not exists login_challenges_email_idx on login_challenges(email, created_at desc)`,
  // devices that passed the second step and asked to be remembered
  `create table if not exists trusted_devices (
     token_hash   text primary key,
     email        text not null references users(email) on delete cascade on update cascade,
     created_at   timestamptz not null default now(),
     last_used_at timestamptz not null default now(),
     expires_at   timestamptz not null,
     user_agent   text
   )`,
  `create index if not exists trusted_devices_email_idx on trusted_devices(email)`,

  // ---- before-and-after history for every clinical and financial record
  `create table if not exists record_history (
     history_id  bigserial primary key,
     at          timestamptz not null default now(),
     who         text not null default '',
     role        text not null default '',
     ip          text,
     table_name  text not null,
     row_id      text not null,
     client_id   text,
     op          text not null,                  -- insert | update | delete
     before      jsonb,
     after       jsonb
   )`,
  `create index if not exists record_history_client_idx on record_history(client_id, at desc)`,
  `create index if not exists record_history_row_idx on record_history(table_name, row_id, at desc)`,
  `create or replace function record_history_fn() returns trigger language plpgsql as $$
   declare who text := coalesce(current_setting('app.who', true), '');
           r   text := coalesce(current_setting('app.role', true), '');
           ip  text := nullif(current_setting('app.ip', true), '');
           b jsonb; a jsonb; rid text; cid text;
   begin
     if tg_op <> 'INSERT' then b := to_jsonb(old); end if;
     if tg_op <> 'DELETE' then a := to_jsonb(new); end if;
     rid := coalesce(a ->> TG_ARGV[0], b ->> TG_ARGV[0], '');
     cid := coalesce(a ->> 'client_id', b ->> 'client_id');
     if tg_op = 'UPDATE' and a - 'updated_at' = b - 'updated_at' then return null; end if;   -- nothing really changed
     insert into record_history (who, role, ip, table_name, row_id, client_id, op, before, after)
       values (who, r, ip, TG_TABLE_NAME, rid, cid, lower(tg_op), b, a);
     return null;
   end $$`,
  ...[['clients','client_id'],['users','email'],['plan_items','plan_id'],['tasks','task_id'],['goals','goal_id'],['topics','topic_id'],['messages','message_id'],['updates','update_id'],['circle','circle_id'],['intake_answers','question_id'],['appointments','appt_id'],['care_team','member_id'],['referrals','referral_id'],['medications','med_id'],['doses','dose_id'],['uploads','upload_id'],['vendor_bills','bill_id'],['assistance','program_id'],['recommendations','rec_id'],['transcripts','transcript_id']]
    .map(([t, k]) => `do $$ begin
      if not exists (select 1 from pg_trigger where tgname = '${t}_history') then
        create trigger ${t}_history after insert or update or delete on ${t} for each row execute function record_history_fn('${k}');
      end if; end $$`),
  // the password hash never lands in the history
  `create or replace function old_pw_changed(b jsonb, a jsonb) returns boolean language sql immutable as $$ select (b ->> 'password_set_at') is distinct from (a ->> 'password_set_at') $$`,
  `create or replace function scrub_history_fn() returns trigger language plpgsql as $$
   begin
     if new.table_name = 'users' then
       new.before := new.before - 'password_hash'; new.after := new.after - 'password_hash';
       if new.op = 'update' and (old_pw_changed(new.before, new.after)) then new.after := new.after || '{"password_changed":true}'::jsonb; end if;
     end if;
     return new;
   end $$`,
  `do $$ begin if not exists (select 1 from pg_trigger where tgname = 'record_history_scrub') then
      create trigger record_history_scrub before insert on record_history for each row execute function scrub_history_fn(); end if; end $$`,

  // ---- vendors in the app, and the jobs families send them (2026-09-28): see handlers/jobs.js
  `create table if not exists jobs (
     job_id text primary key, client_id text not null references clients(client_id) on delete cascade,
     service text not null default 'Other', city text not null default '', state text not null default '',
     starts_at timestamptz not null, details text not null default '', address text not null default '',
     status text not null default 'Open', vendor_id text, created_by text not null default '',
     created_at timestamptz not null default now(), taken_at timestamptz, done_at timestamptz, extra jsonb not null default '{}'::jsonb)`,
  `create index if not exists jobs_open_idx on jobs(status, city, service)`,
  `create index if not exists jobs_client_idx on jobs(client_id)`,
  `alter table vendors add column if not exists hours jsonb not null default '{}'::jsonb`,
  // Support team members can do more than one kind of help (Joe, 2026-09-28): the kinds they signed up for.
  `alter table vendors add column if not exists services jsonb not null default '[]'::jsonb`,
  // ---- the loan closet (2026-09-28): see handlers/loans.js
  `create table if not exists equipment (
     equip_id text primary key, kind text not null default 'Other', label text not null default '', city text not null default '', state text not null default '',
     notes text not null default '', status text not null default 'In closet', client_id text references clients(client_id) on delete set null,
     loaned_at timestamptz, due_back text not null default '', job_id text not null default '', history jsonb not null default '[]'::jsonb,
     created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
  `create index if not exists equipment_city_idx on equipment(state, city, status)`,
  // ---- tips from families for the next family, and what is helping (handlers/tips.js); nothing is deleted
  `create table if not exists tips (
     tip_id text primary key, client_id text references clients(client_id) on delete set null, kind text not null default 'tip',
     place text not null default '', text text not null default '', status text not null default 'New', created_by text not null default '',
     created_at timestamptz not null default now(), reviewed_by text not null default '', reviewed_at timestamptz)`,
  `create index if not exists tips_place_idx on tips(status, lower(place))`,
  // a support team member's line about themselves, shown to families on their profile
  `alter table vendors add column if not exists bio text not null default ''`,
  // ---- the circle's casting call: a request can go to the family's circle first (see handlers/jobs.js)
  `alter table help_items add column if not exists job_id text not null default ''`,   // a vendor's usual free hours (handlers/jobs.js)
  `do $$ begin if not exists (select 1 from pg_constraint where conname='users_role_chk' and pg_get_constraintdef(oid) like '%vendor%') then
      alter table users drop constraint if exists users_role_chk;
      alter table users add constraint users_role_chk check (role in ('client','family','supporter','coordinator','vendor')); end if; end $$`,
  // ---- the audit tables are append-only. The one exception: purging a family after its retention period
  // may delete that family's history rows (they hold the record contents), and only inside a purge.
  // The copy in Cloud Logging is the record nothing here can touch.
  `create or replace function append_only_fn() returns trigger language plpgsql as $$
   begin
     if tg_op = 'DELETE' and TG_TABLE_NAME = 'record_history' and old.client_id is not null
        and old.client_id = coalesce(current_setting('app.purge', true), '') then return old; end if;
     raise exception '% is append-only', TG_TABLE_NAME;
   end $$`,
  ...['audit', 'record_history'].map(t => `do $$ begin if not exists (select 1 from pg_trigger where tgname = '${t}_append_only') then
      create trigger ${t}_append_only before update or delete on ${t} for each row execute function append_only_fn(); end if; end $$`),
];

async function run() {
  for (const sql of STEPS) await db.q(sql);
  try { await require('./handlers/guides').seed(); } catch (e) { console.error('seed explainers', e.message); }
  try { await require('./handlers/hospitals').seed(); } catch (e) { console.error('seed hospitals', e.message); }
}

module.exports = { run, STEPS };
