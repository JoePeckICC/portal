'use strict';
// Acting as a Workspace user (domain-wide delegation) without a downloaded key.
// On Cloud Run the service account has no private key, so the usual `subject` option does nothing;
// instead we ask the IAM Credentials API to sign a JWT for us (the account holds Token Creator on
// itself) and trade it for an access token scoped to that user. Locally, with
// GOOGLE_APPLICATION_CREDENTIALS pointing at a key file, the plain path still works.
const { google } = require('googleapis');

const cache = new Map();                      // `${subject}|${scopes}` -> { token, exp }
let saEmail = null;

async function serviceAccountEmail(auth) {
  if (saEmail) return saEmail;
  if (process.env.SERVICE_ACCOUNT_EMAIL) return (saEmail = process.env.SERVICE_ACCOUNT_EMAIL);
  const creds = await auth.getCredentials();
  return (saEmail = creds.client_email);
}

async function delegatedToken(subject, scopes) {
  const key = subject + '|' + scopes.join(' ');
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const name = `projects/-/serviceAccounts/${await serviceAccountEmail(auth)}`;
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: name.split('/').pop(), sub: subject, aud: 'https://oauth2.googleapis.com/token', scope: scopes.join(' '), iat: now, exp: now + 3600 };
  const iam = google.iamcredentials({ version: 'v1', auth });
  const { data } = await iam.projects.serviceAccounts.signJwt({ name, requestBody: { payload: JSON.stringify(payload) } });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: data.signedJwt }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error('Could not act as ' + subject + ': ' + (tok.error_description || tok.error || 'no token'));
  cache.set(key, { token: tok.access_token, exp: Date.now() + (tok.expires_in || 3600) * 1000 });
  return tok.access_token;
}

// An auth object for googleapis that acts as `subject` with `scopes`.
async function authFor(subject, scopes) {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return new google.auth.GoogleAuth({ scopes, clientOptions: { subject } });
  const oauth = new google.auth.OAuth2();
  oauth.setCredentials({ access_token: await delegatedToken(subject, scopes) });
  return oauth;
}

module.exports = { authFor };
