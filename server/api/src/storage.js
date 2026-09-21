'use strict';
// Documents live in a private Cloud Storage bucket and are only ever served through the API,
// after a session check. Locally (no bucket) they go to a folder on disk.
const fs = require('fs'), path = require('path');
const db = require('./db');
const { id } = require('./util');

const BUCKET = process.env.UPLOAD_BUCKET || '';
const LOCAL = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '.uploads');
let bucket = null;
function gcs() { if (!bucket) { const { Storage } = require('@google-cloud/storage'); bucket = new Storage().bucket(BUCKET); } return bucket; }

async function put(key, bytes, mime) {
  if (BUCKET) await gcs().file(key).save(bytes, { contentType: mime, resumable: false });
  else { const f = path.join(LOCAL, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); }
}
async function get(key) {
  if (BUCKET) { const [b] = await gcs().file(key).download(); return b; }
  return fs.readFileSync(path.join(LOCAL, key));
}
async function remove(key) {
  try { if (BUCKET) await gcs().file(key).delete(); else fs.unlinkSync(path.join(LOCAL, key)); } catch {}
}

// Stores the bytes and records the upload row. Returns the row.
async function saveUpload(ctx, { clientId, kind, name, mime, bytes, note, shared }, c) {
  const upload_id = id();
  const key = `${clientId || '_shared'}/${upload_id}/${name.replace(/[^\w.\- ]+/g, '_')}`;
  await put(key, bytes, mime);
  return db.insert('uploads', { upload_id, client_id: clientId, kind: kind || 'Other', name, storage_key: key, mime, bytes: bytes.length, note: note || '', shared: shared === undefined ? true : !!shared, uploaded_by: ctx.email }, c);
}

module.exports = { put, get, remove, saveUpload, BUCKET };
