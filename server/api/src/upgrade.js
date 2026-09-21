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
];

async function run() {
  for (const sql of STEPS) await db.q(sql);
}

module.exports = { run, STEPS };
