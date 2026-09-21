'use strict';
// Text out of a discharge document. Images and PDFs go through Google Cloud Vision (HIPAA-covered on Google Cloud).
const storage = require('./storage');

async function textOf(upload) {
  const bytes = await storage.get(upload.storage_key);
  const mime = upload.mime || '';
  if (/^text\//.test(mime)) return bytes.toString('utf8');
  const { ImageAnnotatorClient } = require('@google-cloud/vision');
  const client = new ImageAnnotatorClient();
  if (mime === 'application/pdf') {
    const [res] = await client.batchAnnotateFiles({ requests: [{ inputConfig: { content: bytes.toString('base64'), mimeType: 'application/pdf' }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], pages: [1, 2, 3, 4, 5] }] });
    return (res.responses[0].responses || []).map(r => r.fullTextAnnotation && r.fullTextAnnotation.text || '').join('\n');
  }
  const [res] = await client.documentTextDetection({ image: { content: bytes } });
  return res.fullTextAnnotation && res.fullTextAnnotation.text || '';
}
module.exports = { textOf };
