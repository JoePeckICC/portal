#!/usr/bin/env bash
# Builds the API image and deploys it to Cloud Run. Re-run for every release.
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
gcloud config set project "$PROJECT"
CONN=$(gcloud sql instances describe portal-db --format='value(connectionName)')
SA="portal-api@${PROJECT}.iam.gserviceaccount.com"
IMG="${REGION}-docker.pkg.dev/${PROJECT}/portal/api:$(date +%Y%m%d-%H%M)"
gcloud artifacts repositories describe portal --location="$REGION" >/dev/null 2>&1 || gcloud artifacts repositories create portal --repository-format=docker --location="$REGION"
( cd "$(dirname "$0")/../api" && gcloud builds submit --tag "$IMG" . )
SECRETS="DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,JOBS_KEY=JOBS_KEY:latest"
for s in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do gcloud secrets describe "$s" >/dev/null 2>&1 && SECRETS="$SECRETS,$s=$s:latest"; done
gcloud run deploy portal-api --image "$IMG" --region "$REGION" --platform managed --allow-unauthenticated \
  --service-account "$SA" --add-cloudsql-instances "$CONN" --set-secrets "$SECRETS" \
  --network default --subnet default --vpc-egress private-ranges-only \
  --set-env-vars "NODE_ENV=production,TZ=America/Chicago,PORTAL_URL=https://portal.incadencecare.com,ALLOWED_ORIGINS=https://portal.incadencecare.com,UPLOAD_BUCKET=${PROJECT}-uploads,MAIL_TRANSPORT=${MAIL_TRANSPORT:-log},FROM_EMAIL=${FROM_EMAIL:-},MAIL_AS=${MAIL_AS:-},CALENDAR_USER=${CALENDAR_USER:-},IDLE_MINUTES=${IDLE_MINUTES:-0}" \
  --cpu 2 --memory 1Gi --min-instances 1 --max-instances 20 --concurrency 40 --timeout 60
URL=$(gcloud run services describe portal-api --region "$REGION" --format 'value(status.url)')
# The service needs its own address for the document links it hands out.
gcloud run services update portal-api --region "$REGION" --update-env-vars "API_URL=${API_URL:-$URL}" --quiet >/dev/null
echo "API is at: $URL   (health: $URL/health)"
