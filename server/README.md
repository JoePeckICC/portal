# InCadence Care — portal backend

The database and API behind portal.incadencecare.com. Replaces the Google Sheet + Apps Script so the portal
serves 1,000 families with room to spare. The page itself does not change: it talks to the same
`api(action, payload)` contract over HTTPS.

```
db/schema.sql        Postgres tables (one per old Sheet tab, plus sessions, audit, rate limits, settings)
migrate/migrate.js   copies the Google Sheet into Postgres; safe to re-run
api/                 the service (Node 22, no framework): sign-in links, sessions, every portal action, files, Stripe webhook, jobs
tools/               seed.js (synthetic families for load tests), loadtest.js, migrate-files.js (Drive -> Cloud Storage)
deploy/              setup.sh (one-time Google Cloud), deploy.sh (each release), schedule.sh (jobs), migrate-job.sh
```

## Run it locally
```
createdb portal && psql portal -f db/schema.sql
cd api && npm install
DATABASE_URL=postgres://localhost/portal SESSION_SECRET=dev MAIL_TRANSPORT=log PORTAL_URL=http://localhost:8092 node src/index.js
npm test          # needs DATABASE_URL (the suite rebuilds the schema and loads migrate/fixture.json)
```
Emails print to the console when `MAIL_TRANSPORT=log`; in production they go through the Gmail API as `FROM_EMAIL`.

## Deploy (Google Cloud, project `incadence-portal`)
1. `deploy/setup.sh` — APIs, service account, Cloud SQL (Postgres 16, daily backups + point-in-time recovery), secrets, bucket. Once.
2. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Secret Manager by hand.
3. `deploy/deploy.sh` — builds the image with Cloud Build and deploys Cloud Run `portal-api`. Every release.
4. `deploy/schedule.sh` — the three scheduled jobs (dose reminders every 15 min, digest hourly, retention daily). Once.
5. Share the data Sheet and the shared drive (Viewer) with `portal-api@incadence-portal.iam.gserviceaccount.com`, then
   `deploy/migrate-job.sh` and `gcloud run jobs execute portal-migrate --wait`. Re-run right before cutover.
6. Cutover: rebuild the hosted page with `API_URL` = the Cloud Run address (or api.incadencecare.com), push to the
   `portal` repo, and set the Stripe webhook to `<API_URL>/stripe/webhook`. Leave the Apps Script deployed, untouched, for 30 days.

## Environment
| name | what |
|---|---|
| DATABASE_URL, SESSION_SECRET, JOBS_KEY | secrets (Secret Manager) |
| STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET | secrets |
| PORTAL_URL, API_URL, ALLOWED_ORIGINS | addresses; CORS allows only ALLOWED_ORIGINS |
| UPLOAD_BUCKET | private bucket for documents |
| MAIL_TRANSPORT (`gmail`/`log`), FROM_EMAIL, MAIL_AS | sending: MAIL_AS is the real mailbox the API acts as; FROM_EMAIL can be one of its aliases |
| CALENDAR_USER | coordinator's Workspace address for booking (domain-wide delegation) |
| IDLE_MINUTES (default 0 = off), SESSION_DAYS (30) | session policy |
| RETAIN_YEARS (7) | archive retention |

## What the API guarantees
- Every request is pinned to the signed-in person's family; coordinators pick a family, nobody else can.
- Writes run in a transaction under a per-family lock; reads never wait.
- Sign-in links: 20 minutes, single use, 1/min and 5/hour per address. Sessions are server-side and revocable ("sign out everywhere").
- Documents are served only through `/files/<id>` with a signed, per-person, per-file link (24 h). No public URLs.
- Audit: who did what to which family, ids only, kept 366 days.
- Archived families are locked and read-only; purge needs a coordinator, the retention date, and the family name typed back.

## Sign-in

Email + password (scrypt-hashed, breach-checked, 12+ characters). A new device also needs a 6-digit code
emailed to the account; a device that passed it is remembered 30 days. Five wrong passwords pause the
account for 15 minutes. The emailed link is only for setting a password the first time or resetting it.

## Audit and logging

- `audit`: every action, view and sign-in (who, role, family, record ids, error, IP). Append-only.
- `record_history`: before/after of every clinical and financial row, stamped with who (Postgres triggers).
  Append-only; a purge after the retention period removes that family's rows.
- Both are also written to Cloud Logging as structured lines (`jsonPayload.audit=true`) and routed by
  `deploy/logging.sh` into a locked compliance bucket kept 6 years, together with Google's own audit logs.
- Coordinators see it all under **Access log** in the portal, with CSV export.
- `deploy/alerts.sh`: uptime, 5xx, security events (lockout / export / purge), failed jobs -> email.

## Huntress (Managed SIEM)

Ready to connect; nothing sends until the token exists.
1. Huntress portal -> SIEM -> Source Management -> Add Source -> **Generic HEC** ("InCadence portal").
2. Put the token it shows into Secret Manager as `HUNTRESS_HEC_TOKEN`.
3. `bash deploy/huntress.sh` — the API then ships every audit event (`event: portal.<action>`, `outcome`,
   `who`, `role`, `client_id`, `ip`, `ua`, `error`) to `hec.huntress.io`, and a small forwarder
   (`huntress-forwarder/`) relays Google's own logs (infrastructure changes, secret reads, failed requests,
   job errors) through a Pub/Sub sink to the same source. Sourcetypes: `incadence:portal`, `google:gcp:audit`,
   `google:gcp:log`.
4. Google Workspace itself (mail, admin changes) is connected inside the Huntress portal, not here.
Test from anywhere: `HUNTRESS_HEC_TOKEN=... node tools/hec-test.js`.
