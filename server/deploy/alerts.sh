#!/usr/bin/env bash
# Alerts to the coordinator's inbox. Run once; re-running replaces the policies.
#   - the portal stops answering (checked from three places in the world every minute)
#   - the API starts failing (5xx responses)
#   - an account is paused after wrong passwords, or a family record is exported / purged
#   - a scheduled job or the data copier fails
# Usage: ALERT_EMAIL=joe@incadencecare.com bash deploy/alerts.sh
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
EMAIL=${ALERT_EMAIL:?set ALERT_EMAIL=you@incadencecare.com}
gcloud config set project "$PROJECT" >/dev/null
URL=$(gcloud run services describe portal-api --region "$REGION" --format 'value(status.url)')
HOST=${URL#https://}

echo "== Where alerts go"
CH=$(gcloud monitoring channels list --filter="type=email AND labels.email_address=$EMAIL" --format='value(name)' | head -1)
[ -n "$CH" ] || CH=$(gcloud monitoring channels create --display-name="Coordinator email" --type=email --channel-labels="email_address=$EMAIL" --format='value(name)')
echo "   $CH"

echo "== Uptime check on $HOST/health"
UC=$(gcloud monitoring uptime list-configs --filter='displayName="portal-api health"' --format='value(name)' | head -1)
if [ -z "$UC" ]; then
  gcloud monitoring uptime create "portal-api health" --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT" --protocol=https --path=/health --port=443 --period=1 --timeout=10 --matcher-content='"ok":true' --matcher-type=contains-string >/dev/null
  UC=$(gcloud monitoring uptime list-configs --filter='displayName="portal-api health"' --format='value(name)' | head -1)
fi
UCID=${UC##*/}

mkpolicy() {   # name, json file
  local name=$1 file=$2
  for old in $(gcloud alpha monitoring policies list --filter="displayName=\"$name\"" --format='value(name)'); do gcloud alpha monitoring policies delete "$old" --quiet; done
  gcloud alpha monitoring policies create --policy-from-file="$file" >/dev/null && echo "   $name"
}

echo "== Policies"
cat > /tmp/p-uptime.json <<EOF
{ "displayName": "Portal API is down", "combiner": "OR", "notificationChannels": ["$CH"],
  "documentation": { "content": "The portal API has not answered its health check from at least two locations for 5 minutes. Families cannot sign in or load their portal. Check Cloud Run > portal-api > Logs.", "mimeType": "text/markdown" },
  "conditions": [{ "displayName": "health check failing", "conditionThreshold": {
    "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"$UCID\"",
    "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_NEXT_OLDER", "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.*"] }],
    "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "300s", "trigger": { "count": 1 } } }] }
EOF
mkpolicy "Portal API is down" /tmp/p-uptime.json

cat > /tmp/p-5xx.json <<EOF
{ "displayName": "Portal API errors", "combiner": "OR", "notificationChannels": ["$CH"],
  "documentation": { "content": "More than 5 server errors (5xx) in 5 minutes. Check Cloud Run > portal-api > Logs for the stack trace.", "mimeType": "text/markdown" },
  "conditions": [{ "displayName": "5xx responses", "conditionThreshold": {
    "filter": "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"portal-api\" AND metric.label.response_code_class=\"5xx\"",
    "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }],
    "comparison": "COMPARISON_GT", "thresholdValue": 5, "duration": "0s", "trigger": { "count": 1 } } }] }
EOF
mkpolicy "Portal API errors" /tmp/p-5xx.json

cat > /tmp/p-security.json <<EOF
{ "displayName": "Portal security event", "combiner": "OR", "notificationChannels": ["$CH"],
  "documentation": { "content": "An account was paused after repeated wrong passwords, or a family record was exported or purged. Open the portal's Access log for who and when.", "mimeType": "text/markdown" },
  "conditions": [{ "displayName": "lockout / export / purge", "conditionMatchedLog": {
    "filter": "jsonPayload.audit=true AND ((jsonPayload.action=\"login\" AND jsonPayload.error=\"locked\") OR jsonPayload.action=\"exportClient\" OR jsonPayload.action=\"purgeClient\")" } }],
  "alertStrategy": { "notificationRateLimit": { "period": "300s" }, "autoClose": "1800s" } }
EOF
mkpolicy "Portal security event" /tmp/p-security.json

cat > /tmp/p-jobs.json <<EOF
{ "displayName": "Portal scheduled job failed", "combiner": "OR", "notificationChannels": ["$CH"],
  "documentation": { "content": "A scheduled job (medication reminders, daily digest, retention) or the data copier failed. Check Cloud Scheduler and Cloud Run Jobs.", "mimeType": "text/markdown" },
  "conditions": [{ "displayName": "job error", "conditionMatchedLog": {
    "filter": "(resource.type=\"cloud_scheduler_job\" AND severity>=ERROR) OR (resource.type=\"cloud_run_job\" AND severity>=ERROR)" } }],
  "alertStrategy": { "notificationRateLimit": { "period": "3600s" }, "autoClose": "86400s" } }
EOF
mkpolicy "Portal scheduled job failed" /tmp/p-jobs.json
rm -f /tmp/p-*.json
echo "== Done. Alerts go to $EMAIL."
