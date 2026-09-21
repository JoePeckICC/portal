#!/usr/bin/env bash
# One-time Google Cloud setup for the portal backend. Run from a machine with gcloud signed in as joe@incadencecare.com.
# Everything here is idempotent; re-running is safe.
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}
REGION=${REGION:-us-central1}          # closest region to Nashville with Cloud SQL + Cloud Run
gcloud config set project "$PROJECT"

echo "== APIs"
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com vision.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com servicenetworking.googleapis.com compute.googleapis.com iamcredentials.googleapis.com sheets.googleapis.com gmail.googleapis.com calendar-json.googleapis.com

echo "== Service account the API runs as"
gcloud iam service-accounts create portal-api --display-name "Portal API" 2>/dev/null || true
SA="portal-api@${PROJECT}.iam.gserviceaccount.com"
for role in roles/cloudsql.client roles/secretmanager.secretAccessor roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --quiet >/dev/null
done
# Lets the API act as a Workspace user (send mail as care@, read the coordinator's calendar) without a downloaded key.
gcloud iam service-accounts add-iam-policy-binding "$SA" --member "serviceAccount:$SA" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null

echo "== Let Cloud Build read the uploaded source and push images (new projects no longer grant this by default)"
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${PN}-compute@developer.gserviceaccount.com" --role roles/cloudbuild.builds.builder --quiet >/dev/null

echo "== Private network path (Cloud SQL gets no public address; Cloud Run reaches it inside the VPC)"
gcloud compute addresses describe google-managed-services-default --global >/dev/null 2>&1 || gcloud compute addresses create google-managed-services-default \
  --global --purpose=VPC_PEERING --prefix-length=16 --network=default
gcloud services vpc-peerings list --network=default --format='value(peering)' | grep -q servicenetworking || gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com --ranges=google-managed-services-default --network=default

echo "== Postgres (Cloud SQL; no public IP, Cloud Run connects over its socket)"
gcloud sql instances describe portal-db >/dev/null 2>&1 || gcloud sql instances create portal-db \
  --database-version=POSTGRES_16 --tier=db-custom-1-3840 --region="$REGION" --storage-size=20GB --storage-auto-increase \
  --backup-start-time=08:00 --enable-point-in-time-recovery --retained-backups-count=30 --retained-transaction-log-days=7 \
  --availability-type=zonal --edition=enterprise --no-assign-ip --network=projects/${PROJECT}/global/networks/default --deletion-protection
gcloud sql databases create portal --instance=portal-db 2>/dev/null || true
DBPASS=$(openssl rand -base64 24 | tr -d '/+=')
gcloud sql users create portal --instance=portal-db --password="$DBPASS" 2>/dev/null || gcloud sql users set-password portal --instance=portal-db --password="$DBPASS"
CONN=$(gcloud sql instances describe portal-db --format='value(connectionName)')

echo "== Secrets"
mk() { local name=$1 val=$2; if gcloud secrets describe "$name" >/dev/null 2>&1; then printf '%s' "$val" | gcloud secrets versions add "$name" --data-file=-; else printf '%s' "$val" | gcloud secrets create "$name" --data-file=- --replication-policy=automatic; fi; }
mk DATABASE_URL "postgres://portal:${DBPASS}@localhost/portal?host=/cloudsql/${CONN}"
gcloud secrets describe SESSION_SECRET >/dev/null 2>&1 || mk SESSION_SECRET "$(openssl rand -hex 32)"
gcloud secrets describe JOBS_KEY >/dev/null 2>&1 || mk JOBS_KEY "$(openssl rand -hex 24)"
echo "   STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET: add them yourself in Secret Manager (never on a command line):"
echo "   console.cloud.google.com/security/secret-manager -> Create secret -> name STRIPE_SECRET_KEY -> paste the value"

echo "== Bucket for documents (private; the API is the only reader)"
gsutil ls -b "gs://${PROJECT}-uploads" >/dev/null 2>&1 || gsutil mb -l "$REGION" -b on "gs://${PROJECT}-uploads"

echo "== Done. Next: deploy/deploy.sh"
echo "Cloud SQL connection: $CONN"
