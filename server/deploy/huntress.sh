#!/usr/bin/env bash
# Hooks the portal up to Huntress Managed SIEM (Generic HEC source). Run after the token is in Secret Manager.
#
# Before running:
#   1. Huntress portal -> SIEM -> Source Management -> Add Source -> Generic HEC. Name it "InCadence portal".
#   2. Copy the HTTP Event Collector token it shows into Secret Manager as HUNTRESS_HEC_TOKEN
#      (console.cloud.google.com/security/secret-manager -> Create secret). Never paste it on a command line.
# Then: bash deploy/huntress.sh
#
# What this sets up:
#   - the API ships its own audit events (every view / change / sign-in / alert) straight to the collector
#   - a small forwarder receives Google's logs (infrastructure changes, secret reads, failed requests, job errors)
#     through a Pub/Sub topic and posts them to the same collector
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
gcloud config set project "$PROJECT" >/dev/null
gcloud secrets describe HUNTRESS_HEC_TOKEN >/dev/null 2>&1 || { echo "Add the HUNTRESS_HEC_TOKEN secret first (see the top of this file)."; exit 1; }
SA="portal-api@${PROJECT}.iam.gserviceaccount.com"

echo "== APIs"
gcloud services enable pubsub.googleapis.com cloudfunctions.googleapis.com eventarc.googleapis.com >/dev/null

echo "== The API sends its audit events to Huntress"
gcloud run services update portal-api --region "$REGION" --update-secrets HUNTRESS_HEC_TOKEN=HUNTRESS_HEC_TOKEN:latest --quiet >/dev/null
echo "   portal-api updated"

echo "== Google's logs -> Pub/Sub -> forwarder -> Huntress"
gcloud pubsub topics describe huntress-siem >/dev/null 2>&1 || gcloud pubsub topics create huntress-siem >/dev/null
FILTER='logName:"cloudaudit.googleapis.com" OR resource.type="cloud_run_job" OR (resource.type="cloud_run_revision" AND httpRequest.status>=400) OR (resource.type="cloud_run_revision" AND severity>=WARNING AND NOT jsonPayload.audit=true) OR resource.type="cloud_scheduler_job"'; FILTER="($FILTER) AND NOT resource.labels.service_name=\"huntress-forwarder\""   # never forward the forwarder's own logs (feedback loop)
DEST="pubsub.googleapis.com/projects/${PROJECT}/topics/huntress-siem"
if gcloud logging sinks describe huntress-sink >/dev/null 2>&1; then gcloud logging sinks update huntress-sink "$DEST" --log-filter="$FILTER" --quiet >/dev/null
else gcloud logging sinks create huntress-sink "$DEST" --log-filter="$FILTER" --quiet >/dev/null; fi
WRITER=$(gcloud logging sinks describe huntress-sink --format='value(writerIdentity)')
gcloud pubsub topics add-iam-policy-binding huntress-siem --member="$WRITER" --role=roles/pubsub.publisher --quiet >/dev/null
( cd "$(dirname "$0")/../huntress-forwarder" && gcloud functions deploy huntress-forwarder --gen2 --region "$REGION" --runtime nodejs22 --entry-point forward \
    --trigger-topic huntress-siem --service-account "$SA" --set-secrets HUNTRESS_HEC_TOKEN=HUNTRESS_HEC_TOKEN:latest \
    --memory 256Mi --cpu 1 --concurrency 20 --max-instances 5 --quiet >/dev/null )
gcloud run services add-iam-policy-binding huntress-forwarder --region "$REGION" --member="serviceAccount:$SA" --role=roles/run.invoker --quiet >/dev/null; echo "   forwarder deployed"

echo "== Test event"
URL=$(gcloud run services describe portal-api --region "$REGION" --format 'value(status.url)')
curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"x"}' "$URL/api" >/dev/null && echo "   sent one portal event; it should show in Huntress within a minute or two."
echo "== Done. In Huntress, the source should show as receiving data."
