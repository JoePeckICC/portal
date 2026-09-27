"""Buildings, garages and entrances inside a hospital's area, from OpenStreetMap (Overpass API), with a point
guaranteed to sit inside each outline — pins go on the real footprint, not by eye.  usage: osm.py id w s e n"""
import json, sys, math, urllib.request, urllib.parse
ID, W, S, E, N = sys.argv[1], *map(float, sys.argv[2:6])
q = f'[out:json][timeout:180];(way["building"]({S},{W},{N},{E});relation["building"]({S},{W},{N},{E});way["amenity"="parking"]({S},{W},{N},{E});relation["amenity"="parking"]({S},{W},{N},{E});node["entrance"]({S},{W},{N},{E});node["amenity"="parking_entrance"]({S},{W},{N},{E}););out body geom;'
import time
def fetch(q):   # the public Overpass servers get busy; try each a few times, politely
    eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']
    for i in range(9):
        ep = eps[i % len(eps)]
        try:
            req = urllib.request.Request(ep, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': 'InCadenceCare-campus-maps/1 (joe@incadencecare.com)'})
            return json.load(urllib.request.urlopen(req, timeout=150))
        except Exception as e:
            print('   overpass', ep.split('/')[2], type(e).__name__, str(e)[:60], file=sys.stderr); time.sleep(15 * (i // 3 + 1))
    raise SystemExit('Overpass unavailable; run this hospital again later')
data = fetch(q)
def ring_area(r):   # m², equirectangular, fine at campus scale
    k = 111320 * math.cos(math.radians(r[0][1])); return abs(sum((r[i][0]*k)*(r[i+1][1]*111320) - (r[i+1][0]*k)*(r[i][1]*111320) for i in range(len(r)-1))) / 2
def inside(pt, r):
    x, y, c = pt[0], pt[1], False
    for i in range(len(r) - 1):
        (x1, y1), (x2, y2) = r[i], r[i+1]
        if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1) + x1: c = not c
    return c
def label_point(r):   # centroid if it is inside, else the inside grid point farthest from the edge
    cx = sum(p[0] for p in r[:-1]) / (len(r)-1); cy = sum(p[1] for p in r[:-1]) / (len(r)-1)
    if inside((cx, cy), r): return [round(cx, 6), round(cy, 6)]
    xs = [p[0] for p in r]; ys = [p[1] for p in r]; best, bd = None, -1
    for i in range(1, 30):
        for j in range(1, 30):
            p = (min(xs) + (max(xs)-min(xs))*i/30, min(ys) + (max(ys)-min(ys))*j/30)
            if not inside(p, r): continue
            d = min(math.hypot(p[0]-a[0], p[1]-a[1]) for a in r)
            if d > bd: best, bd = p, d
    return [round(best[0], 6), round(best[1], 6)] if best else [round(cx, 6), round(cy, 6)]
def join(ways):   # a multipolygon's outer ways, joined end to end into closed rings
    ways = [w for w in ways if len(w) > 1]; rings = []
    while ways:
        r = ways.pop(0)
        while r[0] != r[-1]:
            for i, w in enumerate(ways):
                if w[0] == r[-1]: r += w[1:]; ways.pop(i); break
                if w[-1] == r[-1]: r += w[::-1][1:]; ways.pop(i); break
            else: break
        if r[0] == r[-1]: rings.append(r)
    return rings
out = []
for el in data['elements']:
    t = el.get('tags', {})
    if el['type'] == 'node':
        out.append({'osm': f"node/{el['id']}", 'kind': 'entrance' if 'entrance' in t else 'parking_entrance', 'name': t.get('name', ''), 'ref': t.get('ref', ''), 'tags': {k: v for k, v in t.items() if k in ('entrance', 'wheelchair', 'access', 'door', 'addr:street', 'operator')}, 'at': [el['lon'], el['lat']]}); continue
    if el['type'] == 'way': rings = [[[g['lon'], g['lat']] for g in el.get('geometry', [])]]
    else: rings = join([[[g['lon'], g['lat']] for g in m.get('geometry', [])] for m in el.get('members', []) if m.get('role') in ('outer', 'outline', '') and m.get('geometry')])
    rings = [r for r in rings if len(r) > 3 and r[0] == r[-1]]
    if not rings: continue
    r = max(rings, key=ring_area); a = ring_area(r)
    named = bool(t.get('name') or t.get('alt_name') or t.get('official_name') or t.get('ref'))
    kind = 'parking' if t.get('amenity') == 'parking' or t.get('building') == 'parking' or t.get('parking') else 'building'
    if not named and kind == 'building' and a < 1500: continue
    out.append({'osm': f"{el['type']}/{el['id']}", 'kind': kind, 'name': t.get('name', ''), 'alt': t.get('alt_name', '') or t.get('official_name', ''), 'ref': t.get('ref', ''), 'building': t.get('building', ''), 'parking': t.get('parking', ''), 'operator': t.get('operator', ''), 'levels': t.get('building:levels', ''), 'area_m2': round(a), 'at': label_point(r), 'outline': [[round(x, 6), round(y, 6)] for x, y in r]})
json.dump({'id': ID, 'bbox': [W, S, E, N], 'source': 'OpenStreetMap via Overpass API', 'features': out}, open(f'tiles/{ID}-osm.json', 'w'))
print(len(out), 'features', sum(1 for f in out if f['name']), 'named')
