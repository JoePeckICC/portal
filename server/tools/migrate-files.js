// Moves the families' documents from Google Drive into the private Cloud Storage bucket.
// Rows in `uploads` with a file_id and no storage_key are copied; the row is then pointed at the bucket.
// Re-runnable. Needs: the shared drive shared (Viewer) with the job's service account; UPLOAD_BUCKET set.
'use strict';
const { Client } = require('pg');
const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const drive = google.drive({ version: 'v3', auth });
  const bucket = new Storage().bucket(process.env.UPLOAD_BUCKET);
  const rows = (await db.query(`select upload_id, client_id, name, file_id from uploads where file_id is not null and file_id <> '' and storage_key is null`)).rows;
  let ok = 0, failed = 0;
  for (const u of rows) {
    try {
      const meta = await drive.files.get({ fileId: u.file_id, fields: 'mimeType,size,name', supportsAllDrives: true });
      const res = await drive.files.get({ fileId: u.file_id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      const bytes = Buffer.from(res.data);
      const key = `${u.client_id || '_shared'}/${u.upload_id}/${(u.name || meta.data.name).replace(/[^\w.\- ]+/g, '_')}`;
      await bucket.file(key).save(bytes, { contentType: meta.data.mimeType, resumable: false });
      await db.query(`update uploads set storage_key=$2, mime=$3, bytes=$4 where upload_id=$1`, [u.upload_id, key, meta.data.mimeType, bytes.length]);
      ok++;
    } catch (e) { failed++; console.error(`${u.upload_id} (${u.name}): ${e.message}`); }
  }
  console.log(`${ok} files moved, ${failed} failed, ${rows.length} total`);
  await db.end();
})().catch(e => { console.error(e); process.exit(1); });
