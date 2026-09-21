#!/usr/bin/env bash
# Cloud Scheduler jobs that call the API's /jobs endpoints. Run once after the first deploy.
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
URL=$(gcloud run services describe portal-api --region "$REGION" --format 'value(status.url)')
KEY=$(gcloud secrets versions access latest --secret JOBS_KEY)
mk() { local name=$1 sched=$2; gcloud scheduler jobs delete "$name" --location "$REGION" --quiet 2>/dev/null || true
  gcloud scheduler jobs create http "$name" --location "$REGION" --schedule "$sched" --time-zone "America/Chicago" --uri "$URL/jobs/$name" --http-method POST --headers "X-Jobs-Key=$KEY" --attempt-deadline 300s; }
mk medReminders "*/15 * * * *"
mk dailyDigest "5 * * * *"
mk retention "0 6 * * *"
