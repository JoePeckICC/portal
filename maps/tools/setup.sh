#!/usr/bin/env bash
# One-time setup in Cloud Shell: the libraries (from npm, into vendor/), and the Manrope label glyphs (fonts/).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f package.json ] || npm init -y >/dev/null
npm i --silent maplibre-gl@5 pmtiles@4 @protomaps/basemaps@5 @fontsource/manrope @mapbox/tiny-sdf pbf@3 playwright http-server
mkdir -p vendor fonts/files tiles
cp node_modules/maplibre-gl/dist/maplibre-gl.js node_modules/maplibre-gl/dist/maplibre-gl.css node_modules/pmtiles/dist/pmtiles.js node_modules/@protomaps/basemaps/dist/basemaps.js vendor/
cp node_modules/maplibre-gl/LICENSE.txt vendor/maplibre-LICENSE.txt; cp node_modules/pmtiles/LICENSE vendor/pmtiles-LICENSE 2>/dev/null || true
cp node_modules/@fontsource/manrope/files/manrope-latin-{500,600,700,800}-normal.woff2 fonts/files/
cp node_modules/@fontsource/manrope/LICENSE fonts/OFL.txt 2>/dev/null || true
npx playwright install chromium >/dev/null 2>&1 || npx playwright install --with-deps chromium
node tools/genglyphs.mjs
echo "setup done"
