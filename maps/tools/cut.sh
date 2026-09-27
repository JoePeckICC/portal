#!/usr/bin/env bash
# Cut one hospital's map area out of the latest Protomaps OpenStreetMap build, and pull the real building
# outlines, garages and entrances for placing pins.   usage: tools/cut.sh <id> <west> <south> <east> <north>
# Output: tiles/<id>.pmtiles  and  tiles/<id>-osm.json   (upload both with tools/publish.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
ID=$1; W=$2; S=$3; E=$4; N=$5
PM="$HOME/.local/bin/go-pmtiles"; [ -x "$PM" ] || GOBIN="$HOME/.local/bin" go install github.com/protomaps/go-pmtiles@latest
# the newest daily build (they keep a week of them); copied into our storage, never hotlinked
for d in 0 1 2 3 4 5 6; do B=$(date -u -d "-$d day" +%Y%m%d); if curl -sfI "https://build.protomaps.com/$B.pmtiles" >/dev/null; then break; fi; done
echo "build $B  area $W,$S,$E,$N"
"$PM" extract "https://build.protomaps.com/$B.pmtiles" "tiles/$ID.pmtiles" --bbox="$W,$S,$E,$N" --maxzoom=15
"$PM" show "tiles/$ID.pmtiles" | sed -n 1,12p || true
# OSM_BBOX (optional, "w s e n"): pull outlines for a tighter box than the map, to keep Overpass queries light
python3 tools/osm.py "$ID" ${OSM_BBOX:-$W $S $E $N}
[ -f "hospitals/$ID.pins.json" ] && python3 tools/pins.py "$ID"
echo "$B" > "tiles/$ID.build"
ls -la "tiles/$ID".*
