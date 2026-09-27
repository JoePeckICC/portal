#!/usr/bin/env bash
# Copy the map (page, fonts, libraries, hospitals, tiles) to the storage bucket that serves it.
# usage: tools/publish.sh gs://BUCKET
set -euo pipefail
cd "$(dirname "$0")/.."
BKT=${1:?gs://bucket}
gsutil -m -h "Cache-Control:public,max-age=300" cp index.html "$BKT/"
gsutil -m -h "Cache-Control:public,max-age=86400" cp -r vendor fonts "$BKT/"
gsutil -m -h "Cache-Control:public,max-age=300" cp hospitals/*.json "$BKT/hospitals/"
gsutil -m -h "Cache-Control:public,max-age=86400" -h "Content-Type:application/vnd.pmtiles" cp tiles/*.pmtiles "$BKT/tiles/"
echo "published to $BKT"
