"""Turns a hospital's pin list into the map file.   usage: pins.py <id>
In:  hospitals/<id>.pins.json  — the area and the pins, by OpenStreetMap id (e.g. "way/370611106")
     tiles/<id>-osm.json       — from cut.sh: every outline in the area
Out: hospitals/<id>.json       — what the map page reads: each pin with its point (inside the real outline) and the outline.
A pin with "osm" gets its place from that outline. A pin with "at" [lng,lat] is placed there (say where it came from in
"source"). A pin with neither is kept as "not on the map yet" and listed, never guessed."""
import json, sys
ID = sys.argv[1]
spec = json.load(open(f'hospitals/{ID}.pins.json')); osm = {f['osm']: f for f in json.load(open(f'tiles/{ID}-osm.json'))['features']}
out, missing = [], []
for p in spec['pins']:
    q = dict(p); f = osm.get(p.get('osm', ''))
    if f: q['lngLat'] = f['at']; q['outline'] = f.get('outline'); q['osmName'] = f.get('name', '')
    elif p.get('at'): q['lngLat'] = p['at']
    else: q['lngLat'] = None; missing.append(p['label'] + ' ' + p['name'])
    if p.get('osm') and not f and not p.get('at'): missing[-1] += '  (osm id not found: ' + p['osm'] + ')'
    out.append(q)
# Two pins on one spot (a garage under a tower): move the later one to the point of its own outline farthest from
# the pins already placed, still inside its outline. Never off the building.
import math
def inside(pt, r):
    x, y, c = pt[0], pt[1], False
    for i in range(len(r) - 1):
        (x1, y1), (x2, y2) = r[i], r[i+1]
        if (y1 > y) != (y2 > y) and x < (x2-x1)*(y-y1)/(y2-y1) + x1: c = not c
    return c
def m(a, b): return math.hypot((a[0]-b[0])*90000, (a[1]-b[1])*111000)
placed = []
for q in out:
    if not q['lngLat']: continue
    if q.get('outline') and any(m(q['lngLat'], p) < 18 for p in placed):
        r = q['outline']; xs = [a[0] for a in r]; ys = [a[1] for a in r]; best, bd = q['lngLat'], -1
        for i in range(1, 25):
            for j in range(1, 25):
                pt = (min(xs)+(max(xs)-min(xs))*i/25, min(ys)+(max(ys)-min(ys))*j/25)
                if not inside(pt, r) or min(math.hypot((pt[0]-a[0])*90000, (pt[1]-a[1])*111000) for a in r) < 6: continue
                d = min(m(pt, p) for p in placed)
                if d > bd: best, bd = [round(pt[0], 6), round(pt[1], 6)], d
        q['lngLat'] = best
    placed.append(q['lngLat'])
H = {k: v for k, v in spec.items() if k != 'pins'}; H['pins'] = out
json.dump(H, open(f'hospitals/{ID}.json', 'w'), separators=(',', ':'))
print(len(out), 'pins,', len(out) - len(missing), 'on the map')
for m in missing: print('  not on the map yet:', m)
