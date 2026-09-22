'use strict';
// Cloud Run function: Cloud Logging -> Pub/Sub -> Huntress HEC.
// Receives one log entry per Pub/Sub message (from the huntress-siem log sink) and posts it to the collector.
const functions = require('@google-cloud/functions-framework');
const URL_ = process.env.HUNTRESS_HEC_URL || 'https://hec.huntress.io/services/collector';
const TOKEN = process.env.HUNTRESS_HEC_TOKEN || '';

function toEvent(entry) {
  const t = entry.timestamp ? Date.parse(entry.timestamp) / 1000 : Date.now() / 1000;
  const res = entry.resource || {}, lab = res.labels || {};
  const isAudit = String(entry.logName || '').includes('cloudaudit.googleapis.com');
  const pp = entry.protoPayload || {};
  const event = isAudit
    ? { event: 'gcp.audit', service: pp.serviceName, method: pp.methodName, principal: pp.authenticationInfo && pp.authenticationInfo.principalEmail, ip: pp.requestMetadata && pp.requestMetadata.callerIp,
        resource: pp.resourceName, status: pp.status, severity: entry.severity, logName: entry.logName }
    : entry.jsonPayload && entry.jsonPayload.audit ? { ...entry.jsonPayload }
    : { event: 'gcp.log', severity: entry.severity, logName: entry.logName, text: entry.textPayload, json: entry.jsonPayload, http: entry.httpRequest, resource: res.type, labels: lab };
  return { time: t, host: lab.service_name || lab.job_name || res.type || 'gcp', source: 'gcp:' + (process.env.GOOGLE_CLOUD_PROJECT || 'project'), sourcetype: isAudit ? 'google:gcp:audit' : 'google:gcp:log', event };
}

functions.cloudEvent('forward', async (ce) => {
  if (!TOKEN) throw new Error('HUNTRESS_HEC_TOKEN is not set');
  const msg = ce.data && ce.data.message; if (!msg || !msg.data) return;
  const entry = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8'));
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Splunk ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(toEvent(entry)), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HEC ' + r.status + ' ' + (await r.text()).slice(0, 200));   // throwing makes Pub/Sub retry
});
