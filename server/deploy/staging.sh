#!/usr/bin/env bash
# Deploys the API to the TEST COPY (staging). Its own Google project, its own database, made-up families only,
# and email only goes to the log. It will not touch the live project.
#   bash server/deploy/staging.sh
set -euo pipefail
export PROJECT=${STAGING_PROJECT:-incadence-portal-staging}
if [ "$PROJECT" = "incadence-portal" ]; then echo "Refusing: that is the live project." >&2; exit 1; fi
export APP_ENV=staging MAIL_TRANSPORT=log MIN_INSTANCES=0
export API_URL=https://api-staging.incadencecare.com
export PORTAL_URL=https://staging.portal.incadencecare.com
exec bash "$(dirname "$0")/deploy.sh"
