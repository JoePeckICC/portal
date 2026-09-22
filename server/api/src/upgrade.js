'use strict';
// Small, repeatable schema changes applied when the API starts. Each statement is safe to run
// again (IF NOT EXISTS), so every instance can run this on boot without coordination.
const db = require('./db');

const STEPS = [
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
  ...[['clients','client_id'],['users','email'],['plan_items','plan_id'],['tasks','task_id'],['goals','goal_id'],['topics','topic_id'],['messages','message_id'],['updates','update_id'],['circle','circle_id'],['intake_answers','question_id'],['appointments','appt_id'],['care_team','member_id'],['referrals','referral_id'],['medications','med_id'],['doses','dose_id'],['uploads','upload_id'],['vendor_bills','bill_id'],['assistance','program_id'],['recommendations','rec_id']]
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
}

module.exports = { run, STEPS };
