'use strict';
// The action table. Each handler is (ctx, p, c) => result, where c is the transaction client for writes.
// Names, inputs and outputs match the Apps Script's HANDLERS_, so the page does not change.
const H = {};
Object.assign(H, require('./stubs'), require('./bootstrap'), require('./messages'), require('./account'), require('./plan'), require('./record'), require('./meds'), require('./money'), require('./coordinator'), require('./docs'), require('./archive'), require('./audit'));   // real handlers win over stubs

// Reads never wait on a lock and are not audited unless they fail.
H.READ_ONLY = { accessLog: 1, bootstrap: 1, billing: 1, allBilling: 1, inbasket: 1, resources: 1, planPdf: 1, summaryPdf: 1, readDischarge: 1, topicMessages: 1, exportClient: 1, slots: 1 };
// Supporters (the wider circle) read updates and manage their own account. Nothing else.
H.SUPPORTER_OK = { bootstrap: 1, savePrefs: 1, changeEmail: 1, signOutEverywhere: 1, changePassword: 1, forgetDevices: 1 };
// A family's portal stays closed until their first payment is in. Consent and intake are always open.
// Coordinator actions that are fine on an archived family (everything else is refused until reactivation).
H.ARCHIVE_OK = { accessLog: 1, changePassword: 1, forgetDevices: 1, reactivateClient: 1, purgeClient: 1, exportClient: 1, savePrefs: 1, saveCoSettings: 1, newFamily: 1, saveResource: 1, signOutEverywhere: 1, changeEmail: 1 };
H.OPEN_BEFORE_PAID = ['bootstrap', 'changePassword', 'forgetDevices', 'signConsent', 'saveIntake', 'submitIntake', 'planPdf', 'checkoutLink', 'savePrefs', 'changeEmail'];

module.exports = H;
