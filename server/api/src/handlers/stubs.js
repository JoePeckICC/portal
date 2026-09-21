'use strict';
// Actions not ported yet. Each answers with a clear error instead of "Unknown action", so the page
// shows a sentence rather than breaking. Remove entries as the real handlers land.
const PENDING = [];
const _OLD = [
  'slots', 'book', 
  'startBilling', 'changeAmount', 'pauseBilling', 'billing', 'saveVisitNote', 'saveAllergies', 'summaryPdf', 'planPdf', 'uploadDoc', 'setDoc', 'keepAttachment', 'askHelp',
  'resources', 'saveResource', 'recommend', 'openResource', 'writeLetter', 'saveCoSettings', 'newFamily', 'inbasket', 'portalLink', 'cardSetupLink', 'payInvoice', 'setAutopay',
  'chargeOnce', 'sendReminder', 'refundInvoice', 'addCredit', 'allBilling', 'askAssistance', 'saveAssistance', 'saveVendorBill', 'saveMed', 'readDischarge', 'addMeds', 'setMedStatus',
  'takeDose', 'missedDose', 'savePharmacy', 'uploadDischarge', 'flushCache'];

const out = {};
PENDING.forEach(name => { out[name] = async () => { const e = new Error('This part of the portal is moving to the new system and is not switched on here yet.'); e.expected = true; throw e; }; out[name].stub = true; });
module.exports = out;
