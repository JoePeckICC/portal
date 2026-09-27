'use strict';
// Campus maps: GET /maps/<file> streams the map viewer, its tiles and pin files out of the maps bucket.
// Public on purpose: it is OpenStreetMap data and building names, nothing about any family.
// The bucket itself stays private (the organization doesn't allow public buckets); the API reads it.
// Range requests are supported, because the map reads its tile file a slice at a time.
const BUCKET = process.env.MAPS_BUCKET || 'incadence-campus-maps';
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8',
  pbf: 'application/x-protobuf', pmtiles: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
const FRAMERS = 'https://portal.incadencecare.com https://incadencecare.com https://www.incadencecare.com';
const HTML_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src blob:; child-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors " + FRAMERS;
const meta = new Map();   // key -> { size, etag, at }
let bucket = null;
function gcs() { if (!bucket) { const { Storage } = require('@google-cloud/storage'); bucket = new Storage().bucket(BUCKET); } return bucket; }

function keyFor(pathname) {
  let k = decodeURIComponent(pathname.slice('/maps/'.length)) || 'index.html';
  if (k.endsWith('/')) k += 'index.html';
  if (!/^[\w .\-\/]+$/.test(k) || k.split('/').some(p => p === '..' || p === '.' || p === '')) return null;
  if (k.startsWith('src/')) return null;   // build inputs stay private
  return k;
}
async function stat(key) {
  const m = meta.get(key); if (m && Date.now() - m.at < 5 * 60e3) return m;
  const [md] = await gcs().file(key).getMetadata();
  const v = { size: Number(md.size), etag: md.etag || md.md5Hash || '', at: Date.now() }; meta.set(key, v); return v;
}

async function serve(req, res, url) {
  const plain = (s, t) => { res.writeHead(s, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end(t); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
  const key = keyFor(url.pathname); if (!key) return plain(404, 'Not found');
  let m; try { m = await stat(key); } catch (e) { return plain(e.code === 404 ? 404 : 502, e.code === 404 ? 'Not found' : 'Map storage is not reachable right now.'); }
  const ext = (key.split('.').pop() || '').toLowerCase();
  const h = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'ETag': '"' + m.etag + '"', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length',
    'Cache-Control': ext === 'html' || ext === 'json' ? 'public, max-age=300' : 'public, max-age=86400' };
  if (ext === 'html') h['Content-Security-Policy'] = HTML_CSP;
  else h['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'";
  if (req.headers['if-none-match'] === h.ETag) { res.writeHead(304, h); return res.end(); }
  let start = 0, end = m.size - 1, status = 200;
  const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (r && m.size > 0) {
    if (r[1] === '') { start = Math.max(0, m.size - Number(r[2] || 0)); }
    else { start = Number(r[1]); if (r[2] !== '') end = Math.min(end, Number(r[2])); }
    if (start > end || start >= m.size) { res.writeHead(416, { ...h, 'Content-Range': 'bytes */' + m.size }); return res.end(); }
    status = 206; h['Content-Range'] = `bytes ${start}-${end}/${m.size}`;
  }
  h['Content-Length'] = m.size ? end - start + 1 : 0;
  res.writeHead(status, h);
  if (req.method === 'HEAD' || !m.size) return res.end();
  gcs().file(key).createReadStream({ start, end, decompress: false, validation: false })
    .on('error', e => { console.error('maps stream', key, e.message); res.destroy(); })
    .pipe(res);
}

const file = key => gcs().file(key);
// A whole small file (the hospital index), read the same way the viewer's files are served.
function read(key) {
  return new Promise((resolve, reject) => { const parts = []; gcs().file(key).createReadStream({ decompress: false, validation: false })
    .on('data', d => parts.push(d)).on('end', () => resolve(Buffer.concat(parts))).on('error', reject); });
}
module.exports = { serve, keyFor, file, read, BUCKET };
