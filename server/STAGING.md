# Test copy (staging)

A second copy of the portal with made-up families. Claude builds and tests there. Joe looks, then promotes it to live.

- **Test copy:** staging.portal.incadencecare.com, with its API at api-staging.incadencecare.com. It shows a red "TEST COPY" bar, sends no real email, and has its own database.
- **Live:** portal.incadencecare.com. Unchanged.

## Ready in the code

- `server/deploy/staging.sh`: deploys the API to the test project. It refuses the live project.
- `server/tools/seed-staging.js`: adds 3 made-up families. It refuses unless `APP_ENV=staging`.
- `index.html`: on a `staging.` address, it talks to the staging API and shows the red bar.
- `deploy.sh`: now takes `PORTAL_URL`, `APP_ENV` and `MIN_INSTANCES`. Live defaults are unchanged.

## Joe's steps (one time, about 30 minutes)

1. **Google Cloud:** create project `incadence-portal-staging` on the same billing account. In Cloud Shell, run `PROJECT=incadence-portal-staging bash server/deploy/setup.sh`.
2. **Deploy:** run `bash server/deploy/staging.sh`.
3. **Seed:** run `APP_ENV=staging DATABASE_URL=<staging db> node server/tools/seed-staging.js`.
4. **Cloudflare:** add a `staging` branch worker for `staging.portal.incadencecare.com`, plus the `api-staging` DNS record pointing to the staging Cloud Run URL.
5. **GitHub:** create a `staging` branch. Claude commits there. Protect `main` so only Joe merges.
6. **Access:** give Claude's accounts the staging project only, never `incadence-portal`.

## Promoting to live

Joe merges `staging` into `main`. The page goes live on its own, then run `deploy.sh` for the API as usual.
