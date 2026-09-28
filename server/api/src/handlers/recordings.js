'use strict';
// Appointment recordings and their transcripts (2026-09-27). The coordinator adds a recording (a phone voice memo,
// or one the family made in the portal), confirms the clinician agreed to it in the room, and asks for a transcript.
// The transcript comes back to the coordinator only. They read it, fix it, and choose whether the family sees it.
const db = require('../db');
const core = require('../core');
const storage = require('../storage');
const tx = require('../transcribe');
const { id, must, clean, isTrue, famName } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const dateOnly = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null);
const PART = 5 * 1024 * 1024, MAX_PARTS = 30;   // 150 MB: about five hours of a phone voice memo
const AUDIO = /^(audio|video)\//;

// A recording arrives in pieces (the request size is capped). The last piece joins them into one file.
async function addRecording(ctx, p, c) {
  coOnly(ctx); must(ctx.clientId, 'Pick a family first');
  const sid = String(p.sessionId || ''); must(/^[a-z0-9]{8,40}$/.test(sid), 'Start the upload again');
  const i = Number(p.part), n = Number(p.parts);
  must(Number.isInteger(i) && Number.isInteger(n) && n >= 1 && n <= MAX_PARTS && i >= 0 && i < n, 'That recording is too long for one upload (the limit is about five hours).');
  const bytes = Buffer.from(String(p.b64 || ''), 'base64'); must(bytes.length && bytes.length <= PART + 1024, 'Nothing to upload');
  const tmp = k => `_parts/${ctx.clientId}/${sid}/${String(k).padStart(2, '0')}`;
  await storage.put(tmp(i), bytes, 'application/octet-stream');
  if (i < n - 1) return { part: i };
  const mime = AUDIO.test(String(p.type || '')) ? String(p.type) : 'audio/mpeg';
  const name = clean(p.name, 120) || 'recording';
  const upload_id = id(), key = `${ctx.clientId}/${upload_id}/${name.replace(/[^\w.\- ]+/g, '_')}`;
  await storage.compose([...Array(n).keys()].map(tmp), key, mime);
  const title = clean(p.title, 160) || 'Appointment recording';
  const row = await db.insert('uploads', { upload_id, client_id: ctx.clientId, kind: 'Recording', name, storage_key: key, mime, bytes: Number(p.size) || 0, note: title, shared: false, uploaded_by: ctx.email }, c);
  return { upload: core.docPublic(row, ctx) };
}

// Ask for the transcript of a recording already in the portal. The clinician's OK is confirmed every time.
async function transcribe(ctx, p, c) {
  coOnly(ctx); must(ctx.clientId, 'Pick a family first');
  must(isTrue(p.consent), 'Confirm the clinician agreed to the recording before it is transcribed.');
  const u = await db.one(`select * from uploads where client_id=$1 and upload_id=$2`, [ctx.clientId, String(p.uploadId || '')], c); must(u && u.storage_key, 'Not found');
  must(AUDIO.test(u.mime || '') || /\.(m4a|mp3|wav|webm|ogg|aac|mp4|mov|caf|flac|amr|3gp)$/i.test(u.name || ''), 'That file is not a recording.');
  const was = await db.one(`select transcript_id from transcripts where upload_id=$1 and status in ('Working','Ready')`, [u.upload_id], c); must(!was, 'That recording already has a transcript.');
  const ogg = await tx.toOgg(await storage.get(u.storage_key));
  const secs = await tx.seconds(ogg);
  const key = `${ctx.clientId}/${u.upload_id}/speech.ogg`;
  await storage.put(key, ogg, 'audio/ogg');
  const op = await tx.start(key);
  const row = await db.insert('transcripts', { transcript_id: id(), client_id: ctx.clientId, upload_id: u.upload_id, title: clean(p.title, 160) || u.note || u.name, appt_date: dateOnly(p.apptDate), status: 'Working', op_name: op, speech_key: key, seconds: secs,
    consent_by: ctx.email, consent_at: new Date(), text: '', shared: false, created_by: ctx.email }, c);
  return { transcript: pub(row) };
}

// The coordinator's edits: the words, the title, and whether the family sees it.
async function saveTranscript(ctx, p, c) {
  coOnly(ctx);
  const t = await db.one(`select * from transcripts where client_id=$1 and transcript_id=$2`, [ctx.clientId, String(p.transcriptId || '')], c); must(t, 'Not found');
  const patch = { updated_at: new Date() };
  if (p.text !== undefined) patch.text = clean(p.text, 200000);
  if (p.title !== undefined) patch.title = clean(p.title, 160) || t.title;
  if (p.apptDate !== undefined) patch.appt_date = dateOnly(p.apptDate);
  if (p.shared !== undefined) { must(!isTrue(p.shared) || t.status === 'Ready', 'Only a finished transcript can be shared.'); patch.shared = isTrue(p.shared); }
  const row = (await db.update('transcripts', { transcript_id: t.transcript_id }, patch, c))[0];
  if (patch.shared && !t.shared) await core.autoMsg(ctx.clientId, 'A transcript of “' + row.title + '” is under My Record → Documents. It was checked by your coordinator; it is a record of what was said, not medical advice.', c);
  return { transcript: pub(row) };
}

const pub = t => ({ transcript_id: t.transcript_id, upload_id: t.upload_id, title: t.title, appt_date: t.appt_date ? String(t.appt_date instanceof Date ? t.appt_date.toISOString() : t.appt_date).slice(0, 10) : '', status: t.status, text: t.text || '', shared: !!t.shared,
  error: t.error || '', seconds: t.seconds || 0, created_at: t.created_at, updated_at: t.updated_at });
// For the page: every transcript for the coordinator, only shared, finished ones for the family.
async function forClient(ctx, clientId) {
  const rows = await db.all(`select * from transcripts where client_id=$1 order by created_at desc`, [clientId]);
  return ctx.role === 'coordinator' ? rows.map(pub) : rows.filter(t => t.shared && t.status === 'Ready').map(t => { const x = pub(t); delete x.error; delete x.upload_id; return x; });
}

// Every 15 minutes: finished jobs are collected. The working copy of the audio (speech.ogg) is removed once done.
async function checkTranscripts() {
  const rows = await db.all(`select * from transcripts where status='Working' and op_name<>''`);
  let n = 0;
  for (const t of rows) {
    let r; try { r = await tx.check(t.op_name); } catch (e) { console.error('transcript check', t.transcript_id, e.message); continue; }
    if (!r.done) {
      if (Date.now() - new Date(t.created_at).getTime() > 36 * 3600e3) await db.update('transcripts', { transcript_id: t.transcript_id }, { status: 'Failed', error: 'Took longer than a day and a half.', updated_at: new Date() });
      continue;
    }
    await db.update('transcripts', { transcript_id: t.transcript_id }, { status: r.error && !r.text ? 'Failed' : 'Ready', text: r.text, error: r.error || '', billed_seconds: r.billed || 0, updated_at: new Date() });
    if (t.speech_key) await storage.remove(t.speech_key);
    n++;
    try {
      const client = await core.clientById(t.client_id), co = await core.coordinatorFor(client);
      await core.notifyCo(co, 'upload', famName(client.family_name) + ': transcript ' + (r.text ? 'ready' : 'failed') + ', ' + t.title,
        r.text ? 'The transcript of “' + t.title + '” is ready to read and check. The family does not see it until you share it.' : 'The transcript of “' + t.title + '” did not work: ' + r.error, '', 'Open the portal');
    } catch (e) { console.error('transcript notify', e.message); }
  }
  return { transcripts: n };
}

module.exports = { addRecording, transcribe, saveTranscript };
Object.defineProperties(module.exports, {
  forClient: { value: forClient, enumerable: false }, checkTranscripts: { value: checkTranscripts, enumerable: false }, pub: { value: pub, enumerable: false },
});
