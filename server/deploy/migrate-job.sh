#!/usr/bin/env bash
# Copies the Google Sheet into Postgres as a Cloud Run job (no keys: the job's service account reads the Sheet).
# Before the first run: share the Sheet (Viewer) with portal-api@<project>.iam.gserviceaccount.com
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
SHEET_ID=${SHEET_ID:-10hhQHwBgfeNjsKy89RPrgvvpyIox6e_MdFlUs62iLQM}
CONN=$(gcloud sql instances describe portal-db --format='value(connectionName)')
SA="portal-api@${PROJECT}.iam.gserviceaccount.com"
IMG="${REGION}-docker.pkg.dev/${PROJECT}/portal/migrate:$(date +%Y%m%d-%H%M)"
( cd "$(dirname "$0")/.." && gcloud builds submit --config migrate/cloudbuild.yaml --substitutions _IMG="$IMG" . )
gcloud run jobs delete portal-migrate --region "$REGION" --quiet 2>/dev/null || true
gcloud run jobs create portal-migrate --image "$IMG" --region "$REGION" --service-account "$SA" --set-cloudsql-instances "$CONN" --network default --subnet default --vpc-egress private-ranges-only \
  --set-secrets DATABASE_URL=DATABASE_URL:latest --set-env-vars "SHEET_ID=$SHEET_ID,TZ_NAME=America/Chicago" --task-timeout 30m --max-retries 0
echo "Run it with: gcloud run jobs execute portal-migrate --region $REGION --wait"
