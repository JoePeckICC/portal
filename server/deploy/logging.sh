#!/usr/bin/env bash
# Long-term, tamper-proof logging. Run once (re-running is safe, except the LOCK step, which is final).
#
#   1. Everything the project logs is kept 6 years (2200 days) instead of 30.
#   2. A separate "compliance" log bucket receives the records an audit asks for:
#        - Google's own audit logs (who changed infrastructure, who read a secret or a file)
#        - the portal's access log (every view / change / sign-in, as the app emits it)
#        - failed requests and the copier job's output
#      and is LOCKED: nothing and nobody, including the project owner, can shorten its retention or delete it.
#   3. Google records reads of secrets, database admin calls and document storage (off by default).
set -euo pipefail
PROJECT=${PROJECT:-incadence-portal}; REGION=${REGION:-us-central1}
DAYS=${RETAIN_DAYS:-2200}
gcloud config set project "$PROJECT" >/dev/null

echo "== 1. Keep all logs for $DAYS days"
gcloud logging buckets update _Default --location=global --retention-days="$DAYS" --quiet

echo "== 2. Compliance bucket + what flows into it"
gcloud logging buckets describe compliance --location="$REGION" >/dev/null 2>&1 || \
  gcloud logging buckets create compliance --location="$REGION" --retention-days="$DAYS" --description="Audit trail: kept $DAYS days, locked" --quiet
FILTER='logName:"cloudaudit.googleapis.com" OR jsonPayload.audit=true OR resource.type="cloud_run_job" OR (resource.type="cloud_run_revision" AND httpRequest.status>=400) OR (resource.type="cloud_run_revision" AND severity>=WARNING)'
DEST="logging.googleapis.com/projects/${PROJECT}/locations/${REGION}/buckets/compliance"
if gcloud logging sinks describe compliance-sink >/dev/null 2>&1; then
  gcloud logging sinks update compliance-sink "$DEST" --log-filter="$FILTER" --quiet
else
  gcloud logging sinks create compliance-sink "$DEST" --log-filter="$FILTER" --quiet
fi

echo "== 3. Record reads of secrets, database admin calls, document storage, and IAM"
python3 - "$PROJECT" <<'EOF'
import json, subprocess, sys
p = sys.argv[1]
pol = json.loads(subprocess.check_output(['gcloud', 'projects', 'get-iam-policy', p, '--format=json']))
want = {'secretmanager.googleapis.com': ['DATA_READ', 'DATA_WRITE'], 'sqladmin.googleapis.com': ['DATA_READ', 'DATA_WRITE'],
        'storage.googleapis.com': ['DATA_READ', 'DATA_WRITE'], 'iam.googleapis.com': ['DATA_READ', 'DATA_WRITE'], 'run.googleapis.com': ['DATA_READ', 'DATA_WRITE']}
cfgs = {c['service']: c for c in pol.get('auditConfigs', [])}
for svc, types in want.items():
    c = cfgs.setdefault(svc, {'service': svc, 'auditLogConfigs': []})
    have = {x['logType'] for x in c['auditLogConfigs']}
    for t in types:
        if t not in have: c['auditLogConfigs'].append({'logType': t})
pol['auditConfigs'] = list(cfgs.values())
open('/tmp/policy.json', 'w').write(json.dumps(pol))
EOF
gcloud projects set-iam-policy "$PROJECT" /tmp/policy.json --quiet >/dev/null && rm -f /tmp/policy.json
echo "   data-access logging on."

echo
echo "== Done. Last step, when you are sure: lock the compliance bucket (cannot be undone):"
echo "   gcloud logging buckets update compliance --location=$REGION --locked"
