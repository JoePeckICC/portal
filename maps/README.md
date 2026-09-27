# Campus maps

Our own campus maps: OpenStreetMap data cut from the Protomaps daily build into one small file per hospital
(PMTiles), drawn with MapLibre in our colours, with pins placed on the real OpenStreetMap building outlines.
No Google Maps, no Mapbox, no per-view fees.

**Where it lives.** Files go to the private bucket `gs://incadence-campus-maps`. The API serves them at
`https://api.incadencecare.com/maps/…` (see `server/api/src/maps.js`), so the bucket never has to be public.
The portal shows the map on a family's hospital walk when `server/api/src/data/maps.json` has that hospital.

**Adding a hospital is data, not code.** Put it in `hospitals/all.json` (name, slug, state, city, address, search),
then in Cloud Shell:

    cd ~/maps && python3 tools/build_all.py <slug>     # finds it, cuts the area, pins the named buildings
    tools/publish.sh gs://incadence-campus-maps
    cp hospitals/index.json <portal repo>/server/api/src/data/maps.json   # then commit + deploy the API

Automatic pins say so on the map ("not yet checked against the hospital's own campus map"). To hand-check a
hospital, edit `hospitals/<slug>.pins.json` (pin numbers/letters, names, OSM ids from the hospital's official map),
add `"hand": true` so rebuilds never overwrite it, and run `python3 tools/pins.py <slug>`.

**Terms.** Protomaps builds are OpenStreetMap data (ODbL): keep the "© OpenStreetMap contributors" credit, copy
extracts into our own storage (never hotlink build.protomaps.com), and note that daily builds are kept about a week.

First time in a new Cloud Shell: `bash tools/setup.sh` (libraries, fonts, Manrope glyphs).
