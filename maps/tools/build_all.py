"""Every hospital in hospitals/all.json gets a campus map: find the hospital on OpenStreetMap, cut its area out of
the Protomaps build, pull the outlines, and place pins automatically on the named buildings and garages inside the
hospital's own campus outline. Hand-made pin lists (hospitals/<id>.pins.json with "hand": true) are never replaced.
   usage: python3 tools/build_all.py [slug ...]     (no slugs = all; already-built ones are skipped unless named)
Writes hospitals/<id>.pins.json, hospitals/<id>.json, tiles/<id>.pmtiles, and hospitals/index.json."""
import json, math, os, subprocess, sys, time, urllib.parse, urllib.request
UA = {'User-Agent': 'InCadenceCare-campus-maps/1 (joe@incadencecare.com)'}
BUF = 900        # metres of streets and garages around the campus outline
ALL = json.load(open('hospitals/all.json'))
ONLY = set(sys.argv[1:])
def get(url, data=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            return json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:
            print('   retry', i + 1, type(e).__name__, str(e)[:80]); time.sleep(10 * (i + 1))
    raise RuntimeError('gave up: ' + url[:80])
def overpass(q):
    for ep in ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']:
        try: return get(ep, urllib.parse.urlencode({'data': q}).encode(), tries=3)
        except Exception as e: print('   overpass', ep, e)
    raise RuntimeError('overpass down')
def m2deg(lat, m): return m / 111320, m / (111320 * math.cos(math.radians(lat)))
def inside(pt, r):
    x, y, c = pt[0], pt[1], False
    for i in range(len(r) - 1):
        (x1, y1), (x2, y2) = r[i], r[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c
def near(pt, r, m):   # inside, or within m metres of the outline's corners
    if inside(pt, r): return True
    k = 111320 * math.cos(math.radians(pt[1]))
    return min(math.hypot((pt[0] - a[0]) * k, (pt[1] - a[1]) * 111320) for a in r) < m

def find(h):
    """The hospital's campus on OpenStreetMap: its outline if it has one, else its point."""
    q = f"{h['search']}, {h['city']}, {h['state']}" if h['city'] else f"{h['search']}, {h['state']}"
    time.sleep(1.2)   # Nominatim: one request a second
    res = get('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': q, 'format': 'jsonv2', 'limit': 5, 'countrycodes': 'us', 'polygon_geojson': 1}))
    if not res and h.get('address'):
        time.sleep(1.2); res = get('https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': h['address'], 'format': 'jsonv2', 'limit': 3, 'countrycodes': 'us', 'polygon_geojson': 1}))
    if not res: return None
    best = sorted(res, key=lambda r: (r.get('type') not in ('hospital', 'clinic'), r.get('category') not in ('amenity', 'healthcare'), -float(r.get('importance') or 0)))[0]
    g = best.get('geojson') or {}
    ring = None
    if g.get('type') == 'Polygon': ring = g['coordinates'][0]
    elif g.get('type') == 'MultiPolygon': ring = max((p[0] for p in g['coordinates']), key=len)
    lat, lon = float(best['lat']), float(best['lon'])
    return {'lat': lat, 'lon': lon, 'ring': ring, 'osm': f"{best.get('osm_type')}/{best.get('osm_id')}", 'display': best.get('display_name', ''), 'type': best.get('type')}

def build(h):
    sid = h['slug']; spec_path = f'hospitals/{sid}.pins.json'
    if os.path.exists(spec_path) and json.load(open(spec_path)).get('hand'):
        print(sid, 'hand-made pins kept'); return 'kept'
    f = find(h)
    if not f: print(sid, 'NOT FOUND on OpenStreetMap'); return 'notfound'
    ring = f['ring'] or [[f['lon'] + dx, f['lat'] + dy] for dx, dy in [(-.003, -.0025), (.003, -.0025), (.003, .0025), (-.003, .0025), (-.003, -.0025)]]
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    dy, dx = m2deg(f['lat'], BUF)
    area = [round(min(xs) - dx, 4), round(min(ys) - dy, 4), round(max(xs) + dx, 4), round(max(ys) + dy, 4)]
    vy, vx = m2deg(f['lat'], 120)
    view = [round(min(xs) - vx, 5), round(min(ys) - vy, 5), round(max(xs) + vx, 5), round(max(ys) + vy, 5)]
    oy, ox = m2deg(f['lat'], 200)   # outlines only near the campus: pins never go further out than that
    obox = f"{min(xs) - ox:.5f} {min(ys) - oy:.5f} {max(xs) + ox:.5f} {max(ys) + oy:.5f}"
    subprocess.run(['bash', 'tools/cut.sh', sid, *map(str, area)], check=True, stdout=subprocess.DEVNULL, env={**os.environ, 'OSM_BBOX': obox})
    time.sleep(5)   # be gentle with the public Overpass servers
    feats = json.load(open(f'tiles/{sid}-osm.json'))['features']
    SKIP = ('residential', 'house', 'apartments', 'dormitory', 'church', 'garage', 'garages', 'shed', 'roof', 'retail')
    bl = [x for x in feats if x['kind'] == 'building' and x.get('name') and x.get('building') not in SKIP and near(x['at'], ring, 40)]
    pk = [x for x in feats if x['kind'] == 'parking' and (x.get('parking') == 'multi-storey' or x.get('name')) and near(x['at'], ring, 150)]
    bl = sorted(bl, key=lambda x: -x.get('area_m2', 0))[:24]; pk = sorted(pk, key=lambda x: -x.get('area_m2', 0))[:12]
    pins = [{'id': str(i + 1), 'label': str(i + 1), 'kind': 'building', 'name': x['name'], 'osm': x['osm']} for i, x in enumerate(bl)]
    letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    pins += [{'id': letters[i], 'label': letters[i], 'kind': 'parking', 'name': x.get('name') or ('Parking garage' if x.get('parking') == 'multi-storey' else 'Parking'), 'osm': x['osm']} for i, x in enumerate(pk)]
    if not pins:   # nothing named inside: one pin on the hospital itself, so the map still says where
        pins = [{'id': '1', 'label': '1', 'kind': 'building', 'name': h['name'], 'at': [round(f['lon'], 6), round(f['lat'], 6)], 'source': 'OpenStreetMap ' + f['osm']}]
    spec = {'id': sid, 'name': h['name'], 'subtitle': (h.get('city') + ' · ' if h.get('city') else '') + 'tap a pin for the building', 'state': h['state'], 'city': h.get('city', ''),
            'bounds': area, 'view': view, 'tiles': f'tiles/{sid}.pmtiles', 'auto': True, 'campus': {'osm': f['osm'], 'outline': bool(f['ring'])},
            'source': 'Pins placed automatically from OpenStreetMap building names inside the hospital campus (© OpenStreetMap contributors). Not yet checked against the hospital’s own campus map.',
            'pins': pins}
    json.dump(spec, open(spec_path, 'w'), indent=1)
    subprocess.run(['python3', 'tools/pins.py', sid], check=True)
    print(sid, 'ok', len(bl), 'buildings', len(pk), 'garages', '' if f['ring'] else '(no campus outline: 600 m box around the point)')
    return 'ok'

done = {}
for h in ALL:
    if h.get('map') and h['map'] != h['slug']: continue       # shares another hospital's map (Children's at Vanderbilt)
    if ONLY and h['slug'] not in ONLY: continue
    if not ONLY and os.path.exists(f"hospitals/{h['slug']}.json"): done[h['slug']] = 'exists'; continue
    try: done[h['slug']] = build(h)
    except Exception as e: done[h['slug']] = 'error ' + str(e)[:120]; print(h['slug'], 'ERROR', e)
# the index the portal reads: which hospital name opens which map (and pin)
idx = []
for h in ALL:
    mid = h.get('map') or h['slug']
    if os.path.exists(f'hospitals/{mid}.json'): idx.append({'name': h['name'], 'map': mid, 'pin': h.get('pin', ''), 'state': h['state'], 'city': h.get('city', '')})
json.dump({'hospitals': idx}, open('hospitals/index.json', 'w'), indent=1)
print(json.dumps(done, indent=1)); print(len(idx), 'hospitals have a map')
