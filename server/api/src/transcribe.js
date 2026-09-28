'use strict';
// Appointment recordings into text (2026-09-27). Google Cloud Speech-to-Text V2, covered by the Google Cloud BAA.
// Every recording is first made into one small, plain format (mono, 16 kHz, Opus in Ogg) with ffmpeg, because the
// service does not read phone formats like .m4a. Then a batch job ("dynamic batching", the low-cost queue, usually
// minutes, at most a day) runs on the copy in the private bucket. Audio logging is never turned on.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFile } = require('child_process');
const storage = require('./storage');

const LOCATION = 'global', MODEL = 'long';

// Any audio or video file in, Ogg Opus out (bytes).
function toOgg(bytes) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), src = path.join(dir, 'in'), out = path.join(dir, 'out.ogg');
    fs.writeFileSync(src, bytes);
    execFile('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', out], { timeout: 240000 }, err => {
      try {
        if (err) return reject(Object.assign(new Error('That file could not be read as audio.'), { status: 400 }));
        resolve(fs.readFileSync(out));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
}
// Seconds of audio in an Ogg file, from ffprobe; 0 when unknown.
function seconds(bytes) {
  return new Promise(resolve => {
    const f = path.join(os.tmpdir(), 'probe-' + process.pid + '-' + Date.now() + '.ogg'); fs.writeFileSync(f, bytes);
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { timeout: 30000 }, (err, out) => { try { fs.unlinkSync(f); } catch {} resolve(err ? 0 : Math.round(Number(out) || 0)); });
  });
}

let client = null, project = null;
async function api() {
  if (!client) { const { google } = require('googleapis'); const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }); client = await auth.getClient(); project = await auth.getProjectId(); }
  return client;
}
// Starts the batch job on an object in the upload bucket. Returns the operation name to check on later.
async function start(key) {
  if (process.env.TRANSCRIBE_FAKE) return 'fake/' + key;
  const c = await api();
  const r = await c.request({ method: 'POST', url: `https://speech.googleapis.com/v2/projects/${project}/locations/${LOCATION}/recognizers/_:batchRecognize`,
    data: { config: { autoDecodingConfig: {}, languageCodes: ['en-US'], model: MODEL, features: { enableAutomaticPunctuation: true } },
      files: [{ uri: `gs://${storage.BUCKET}/${key}` }], recognitionOutputConfig: { inlineResponseConfig: {} }, processingStrategy: 'DYNAMIC_BATCHING' } });
  return r.data.name;
}
// { done:false } while it runs; { done:true, text, error, billed } when it is over.
async function check(opName) {
  if (process.env.TRANSCRIBE_FAKE) return { done: true, text: 'Hello, good morning.\n\nGood morning. So tell me what is going on.', error: '', billed: 58 };
  const c = await api();
  const r = (await c.request({ url: `https://speech.googleapis.com/v2/${opName}` })).data;
  if (!r.done) return { done: false };
  if (r.error) return { done: true, text: '', error: r.error.message || 'The transcription failed.', billed: 0 };
  const files = (r.response && r.response.results) || {}, f = files[Object.keys(files)[0]] || {};
  if (f.error) return { done: true, text: '', error: f.error.message || 'The transcription failed.', billed: 0 };
  const parts = ((f.transcript || f.inlineResult && f.inlineResult.transcript || {}).results || []).map(x => ((x.alternatives || [])[0] || {}).transcript || '').map(s => s.trim()).filter(Boolean);
  const billed = parseInt(String((f.metadata && f.metadata.totalBilledDuration) || (r.response.totalBilledDuration) || '0'), 10) || 0;
  return { done: true, text: parts.join('\n\n'), error: parts.length ? '' : 'No speech was found in the recording.', billed };
}

module.exports = { toOgg, seconds, start, check, MODEL };
