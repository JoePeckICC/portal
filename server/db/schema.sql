-- InCadence Care client portal — Postgres schema (v1)
-- One table per Sheet tab, same column names, plus real keys, indexes and timestamps.
-- Every family-scoped table carries client_id and an index on it: the API filters by it on every query.
-- Unknown/legacy Sheet columns land in `extra` (jsonb) during migration so nothing is lost.

create extension if not exists pgcrypto;

-- ---------- people & families ----------
create table clients (
  client_id              text primary key,
  family_name            text not null default '',
  patient_first_name     text not null default '',
  patient_last_name      text not null default '',
  dob                    date,
  surgery_date           date,
  current_stage          text not null default '',
  status                 text not null default 'Active',      -- Active | Archived
  coordinator_email      text not null default '',
  circle_enabled         boolean not null default false,
  paid                   boolean not null default false,
  plan_ready             boolean not null default false,
  phone                  text not null default '',
  address                text not null default '',
  allergies              text not null default '',
  autopay                boolean not null default false,
  billing_status         text not null default '',
  monthly_amount         numeric(10,2),
  stripe_customer_id     text,
  stripe_subscription_id text,
  emergency_name         text not null default '',
  emergency_phone        text not null default '',
  emergency_relationship text not null default '',
  pharmacy_name          text not null default '',
  pharmacy_phone         text not null default '',
  pharmacy_address       text not null default '',
  pharmacy_hours         text not null default '',
  archived_at            timestamptz,
  retain_until           date,                                  -- set at archive time (7 years by default)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  extra                  jsonb not null default '{}'
);
create index clients_status_idx on clients(status);
create index clients_coordinator_idx on clients(coordinator_email);
create unique index clients_stripe_customer_idx on clients(stripe_customer_id) where stripe_customer_id is not null;

create table users (
  email          text primary key,                    -- always lower-cased
  name           text not null default '',
  role           text not null,                       -- client | family | supporter | coordinator
  client_id      text references clients(client_id) on delete restrict,
  active         boolean not null default true,
  relationship   text not null default '',
  goes_by        text not null default '',
  avatar         text not null default '',
  prefs          jsonb not null default '{}',
  co_settings    jsonb not null default '{}',
  session_ver    integer not null default 1,
  created_at     timestamptz not null default now(),
  extra          jsonb not null default '{}',
  constraint users_role_chk check (role in ('client','family','supporter','coordinator'))
);
create index users_client_idx on users(client_id);

-- ---------- sign-in ----------
create table sign_in_tokens (               -- was: Links
  nonce      text primary key,
  email      text not null,
  kind       text not null,                 -- link | em | card ...
  issued_at  timestamptz not null default now(),
  used_at    timestamptz
);
create index sign_in_tokens_email_idx on sign_in_tokens(email, issued_at desc);

create table sessions (                     -- new: server-side sessions (replaces signed session strings)
  session_id   text primary key default encode(gen_random_bytes(32), 'hex'),
  email        text not null references users(email) on delete cascade,
  session_ver  integer not null,
  picked_client_id text,                    -- coordinator's currently opened chart
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  ip           text,
  user_agent   text
);
create index sessions_email_idx on sessions(email);
create index sessions_expires_idx on sessions(expires_at);

-- ---------- plan, tasks, goals ----------
create table plan_items (                   -- was: Plan
  plan_id     text primary key,
  client_id   text not null references clients(client_id),
  stage       text not null default '',
  category    text not null default '',
  item        text not null default '',
  detail      text not null default '',
  owner       text not null default '',
  status      text not null default 'Not started',
  target_date date,
  draft       boolean not null default false,
  updated_at  timestamptz not null default now(),
  extra       jsonb not null default '{}'
);
create index plan_items_client_idx on plan_items(client_id);

create table tasks (
  task_id    text primary key,
  client_id  text not null references clients(client_id),
  title      text not null default '',
  category   text not null default '',
  status     text not null default 'Not started',
  owner      text not null default '',
  due_date   date,
  notes      text not null default '',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index tasks_client_idx on tasks(client_id, status);

create table goals (
  goal_id    text primary key,
  client_id  text not null references clients(client_id),
  title      text not null default '',
  detail     text not null default '',
  status     text not null default 'Active',
  added_by   text not null default '',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index goals_client_idx on goals(client_id);

-- ---------- messaging ----------
create table topics (
  topic_id   text primary key,
  client_id  text not null references clients(client_id),
  title      text not null default '',
  kind       text not null default '',
  status     text not null default 'Active',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index topics_client_idx on topics(client_id, last_at desc);

create table messages (
  message_id          text primary key,
  client_id           text not null references clients(client_id),
  topic_id            text references topics(topic_id),
  sender_email        text not null default '',
  sent_at             timestamptz not null default now(),
  body                text not null default '',
  read_by_client      boolean not null default false,
  read_by_coordinator boolean not null default false,
  urgent              boolean not null default false,
  attachments         jsonb not null default '[]',
  extra               jsonb not null default '{}'
);
create index messages_client_sent_idx on messages(client_id, sent_at desc);
create index messages_topic_idx on messages(topic_id, sent_at);
create index messages_unread_co_idx on messages(client_id) where read_by_coordinator = false;

create table updates (
  update_id         text primary key,
  client_id         text not null references clients(client_id),
  posted_at         timestamptz not null default now(),
  posted_by         text not null default '',
  stage             text not null default '',
  title             text not null default '',
  body              text not null default '',
  visible_to_circle boolean not null default false,
  extra             jsonb not null default '{}'
);
create index updates_client_idx on updates(client_id, posted_at desc);

create table circle (
  circle_id       text primary key,
  client_id       text not null references clients(client_id),
  supporter_email text not null default '',
  supporter_name  text not null default '',
  relationship    text not null default '',
  added_by        text not null default '',
  added_at        timestamptz not null default now(),
  status          text not null default 'Active',
  extra           jsonb not null default '{}'
);
create index circle_client_idx on circle(client_id);

-- ---------- intake ----------
create table intake_answers (               -- was: Intake
  client_id   text not null references clients(client_id),
  question_id text not null,
  answer      text not null default '',
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  text not null default '',
  primary key (client_id, question_id)
);

-- ---------- appointments & care team ----------
create table appointments (
  appt_id    text primary key,
  client_id  text not null references clients(client_id),
  title      text not null default '',
  starts_at  timestamptz,
  location   text not null default '',
  note       text not null default '',
  status     text not null default 'Scheduled',
  kind       text not null default '',
  mode       text not null default '',
  minutes    integer,
  event_id   text,                           -- Google Calendar event
  booked_by  text not null default '',
  about      text not null default '',
  link       text not null default '',
  visit_note text not null default '',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index appointments_client_idx on appointments(client_id, starts_at);
create index appointments_upcoming_idx on appointments(starts_at) where status <> 'Cancelled';

create table care_team (                     -- was: CareTeam
  member_id  text primary key,
  client_id  text not null references clients(client_id),
  name       text not null default '',
  role       text not null default '',
  org        text not null default '',
  phone      text not null default '',
  address    text not null default '',
  notes      text not null default '',
  kind       text not null default '',
  added_by   text not null default '',
  status     text not null default 'Active',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index care_team_client_idx on care_team(client_id);

create table referrals (
  referral_id text primary key,
  client_id   text not null references clients(client_id),
  vendor      text not null default '',
  service     text not null default '',
  contact     text not null default '',
  note        text not null default '',
  status      text not null default '',
  added_by    text not null default '',
  updated_at  timestamptz not null default now(),
  extra       jsonb not null default '{}'
);
create index referrals_client_idx on referrals(client_id);

-- ---------- medications ----------
create table medications (
  med_id       text primary key,
  client_id    text not null references clients(client_id),
  name         text not null default '',
  dose         text not null default '',
  instructions text not null default '',
  prescriber   text not null default '',
  frequency    text not null default '',
  times        text not null default '',    -- "08:00,20:00"
  refills_left integer,
  next_refill  date,
  notes        text not null default '',
  status       text not null default 'Pending review',
  added_by     text not null default '',
  added_at     timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   text not null default '',
  extra        jsonb not null default '{}'
);
create index medications_client_idx on medications(client_id, status);

create table doses (
  dose_id   text primary key,
  client_id text not null references clients(client_id),
  med_id    text not null references medications(med_id) on delete cascade,
  due_at    timestamptz not null,
  status    text not null default 'Due',
  taken_at  timestamptz,
  by        text not null default ''
);
create index doses_client_due_idx on doses(client_id, due_at);
create unique index doses_med_due_idx on doses(med_id, due_at);

-- ---------- documents ----------
create table uploads (
  upload_id   text primary key,
  client_id   text references clients(client_id),          -- null: not a family's file (a coordinator's signature image)
  kind        text not null default '',
  name        text not null default '',
  url         text not null default '',     -- legacy Drive link (migration only)
  file_id     text,                          -- legacy Drive file id (migration only)
  storage_key text,                          -- Cloud Storage object key (new)
  mime        text,
  bytes       bigint,
  note        text not null default '',
  shared      boolean not null default false,
  uploaded_by text not null default '',
  uploaded_at timestamptz not null default now(),
  extra       jsonb not null default '{}'
);
create index uploads_client_idx on uploads(client_id, uploaded_at desc);

-- ---------- money ----------
create table vendor_bills (                  -- was: VendorBills
  bill_id    text primary key,
  client_id  text not null references clients(client_id),
  vendor     text not null default '',
  service    text not null default '',
  amount     numeric(10,2),
  status     text not null default '',
  due_date   date,
  note       text not null default '',
  added_by   text not null default '',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index vendor_bills_client_idx on vendor_bills(client_id);

create table assistance (
  program_id text primary key,
  client_id  text not null references clients(client_id),
  name       text not null default '',
  what       text not null default '',
  status     text not null default '',
  note       text not null default '',
  link       text not null default '',
  updated_at timestamptz not null default now(),
  extra      jsonb not null default '{}'
);
create index assistance_client_idx on assistance(client_id);

-- ---------- library ----------
create table resources (
  resource_id text primary key,
  title       text not null default '',
  kind        text not null default '',
  track       text not null default '',
  stage       text not null default '',
  by          text not null default '',
  minutes     integer,
  summary     text not null default '',
  url         text not null default '',
  body        text not null default '',
  status      text not null default 'Draft',
  sort        integer not null default 0,
  added_by    text not null default '',
  added_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  extra       jsonb not null default '{}'
);
create index resources_status_idx on resources(status, sort);

create table recommendations (
  rec_id      text primary key,
  client_id   text not null references clients(client_id),
  resource_id text not null references resources(resource_id),
  note        text not null default '',
  by          text not null default '',
  at          timestamptz not null default now(),
  opened_at   timestamptz
);
create index recommendations_client_idx on recommendations(client_id, at desc);

create table resource_views (
  view_id     text primary key,
  resource_id text not null references resources(resource_id),
  client_id   text references clients(client_id),
  email       text not null default '',
  at          timestamptz not null default now()
);
create index resource_views_resource_idx on resource_views(resource_id);

-- ---------- coordinator mail ----------
create table digest (
  item_id     text primary key,
  coordinator text not null default '',
  kind        text not null default '',
  subject     text not null default '',
  lead        text not null default '',
  body        text not null default '',
  url         text not null default '',
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index digest_pending_idx on digest(coordinator) where sent_at is null;

-- ---------- audit ----------
create table audit (
  audit_id  bigserial primary key,
  at        timestamptz not null default now(),
  who       text not null default '',
  role      text not null default '',
  action    text not null default '',
  client_id text,
  detail    jsonb not null default '{}',
  error     text not null default '',
  ip        text
);
create index audit_at_idx on audit(at desc);
create index audit_client_idx on audit(client_id, at desc);

-- ---------- housekeeping ----------
create table settings (                      -- was: Script properties (non-secret ones only; secrets live in Secret Manager)
  key   text primary key,
  value text not null
);

create table rate_limits (
  bucket     text primary key,               -- e.g. "link:joe@x.com", "api:1.2.3.4"
  count      integer not null default 0,
  window_end timestamptz not null
);

-- updated_at maintenance
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['clients','plan_items','tasks','goals','appointments','care_team','referrals','medications','vendor_bills','assistance','resources']
  loop execute format('create trigger %I_touch before update on %I for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;
