// Sends one test event to the SIEM collector. Usage: HUNTRESS_HEC_TOKEN=... node tools/hec-test.js
require('../api/src/hec').selfTest().then(r => { console.log('collector answered:', r); }, e => { console.error('failed:', e.message); process.exit(1); });
