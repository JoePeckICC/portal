'use strict';
// Constants the portal page draws with. Kept identical to the Apps Script so the page needs no changes.
const env = process.env;

module.exports = {
  APP_NAME: 'InCadence Care',
  LINK_MINUTES: 20,
  PWSET_MINUTES: 30,        // after opening the emailed link, time to choose a password
  CODE_MINUTES: 10,         // the 6-digit code for a new device
  CODE_TRIES: 5,
  DEVICE_DAYS: 30,          // a device that passed the code is remembered this long
  LOCK_AFTER: 5,            // wrong passwords in a row before the account pauses
  LOCK_MINUTES: 15,
  SESSION_DAYS: Number(env.SESSION_DAYS || 30),
  IDLE_MINUTES: Number(env.IDLE_MINUTES || 0),           // 0 = no idle timeout (matches today); set to 30 for the healthcare norm
  STAGES: ['The diagnosis', 'Before surgery', 'The week of', 'Surgery day', 'The hospital stay', 'First weeks home', 'The long middle'],
  CATEGORIES: ['Care coordination', 'Understanding & advocacy', 'Family & ongoing support'],
  PLAN_STATUSES: ['Not started', 'In progress', 'Done'],
  TASK_STATUSES: ['Not started', 'In progress', 'Done', 'Blocked'],
  BOOK_HOURS: { from: 7, to: 21 },
  BOOK_KINDS: { quick: { label: 'Quick check-in', minutes: 20 }, planning: { label: 'Planning call', minutes: 45 }, talk: { label: 'Talk something through', minutes: 30 } },
  BOOK_LEAD_HOURS: 2,
  BOOK_DAYS_AHEAD: 21,
  INCADENCE_PHONE: '(629) 800-3622',
  INCADENCE_ADDRESS: '6688 Nolensville Rd, Ste 108 #2321, Brentwood, TN 37027',
  INCADENCE_SITE: 'InCadenceCare.com',
  BCC_EMAIL: env.BCC_EMAIL === undefined ? 'admin@incadencecare.com' : env.BCC_EMAIL,
  FROM_EMAIL: env.FROM_EMAIL || '',
  REFERRAL_STATUSES: ['Suggested', 'Contacted', 'In place', 'Not needed'],
  FIXED_ANSWERS: ['0.1', '0.1a', 'A.name', 'G.1', 'G.4'],
  NOTIFY_KINDS: { message: 'Messages', plan: 'Plan changes', booking: 'Booking confirmations', meds: 'Medication reminders' },
  CO_KINDS: { urgent: 'Urgent messages', missed: 'Missed-dose check-ins', billing: 'Declined cards and payment problems', bookingSoon: 'Bookings for today or tomorrow', message: 'Messages', booking: 'Bookings further out', upload: 'Uploads', meds: 'Medications to review', intake: 'Intake finished or changed', assist: 'Assistance asks and payments in' },
  CO_DEFAULTS: { urgent: 'instant', missed: 'instant', billing: 'instant', bookingSoon: 'instant', message: 'digest', booking: 'digest', upload: 'digest', meds: 'digest', intake: 'digest', assist: 'digest' },
  MED_STATUSES: ['Pending review', 'Accepted', 'Stopped'],
  DOC_KINDS: ['Discharge', 'Insurance', 'Forms', 'Letters', 'Living will', 'Other'],
  DEFAULT_MONTHLY: 599,
  BILL_STATUSES: ['Estimate', 'Due', 'Paid', 'Covered'],
  ASSIST_STATUSES: ['Suggested', 'Coordinator is on it', 'Applied', 'Approved', 'Not a fit'],
  AVATARS: ['#1C2A3A', '#C09B36', '#2F6B3A', '#7A2E2E', '#3B5B8C'],
  RES_KINDS: ['Video', 'Article', 'Guide', 'Checklist'],
  RES_TRACKS: ['Open', 'Members'],
  TOPIC_KINDS: { question: 'Question for {CO}', plan: 'About the plan', billing: 'Billing', urgent: 'Something urgent today', other: 'Something else', auto: 'Automated messages' },
  MSG_KEEP: 150,
  TZ: env.TZ || 'America/Chicago',
  PORTAL_URL: env.PORTAL_URL || 'https://portal.incadencecare.com',
  API_URL: env.API_URL || '',                                // this service's own public address (for links in documents)
  ALLOWED_ORIGINS: (env.ALLOWED_ORIGINS || 'https://portal.incadencecare.com').split(',').map(s => s.trim()).filter(Boolean),
  SESSION_SECRET: env.SESSION_SECRET || '',                  // required in production (Secret Manager)
  RATE: { linkPerMin: 1, linkPerHour: 5, loginPerIp15: 30, codesPer15: 4, apiPerMin: Number(env.API_PER_MIN || 240) },
};

// What the page receives on first contact. Same shape as the Apps Script's bootConst_().
module.exports.bootConst = function bootConst() {
  const c = module.exports;
  return { appName: c.APP_NAME, stages: c.STAGES, categories: c.CATEGORIES, planStatuses: c.PLAN_STATUSES, taskStatuses: c.TASK_STATUSES, topicKinds: c.TOPIC_KINDS, bookKinds: c.BOOK_KINDS, bookHours: c.BOOK_HOURS, phone: c.INCADENCE_PHONE, referralStatuses: c.REFERRAL_STATUSES, defaultMonthly: c.DEFAULT_MONTHLY, assistStatuses: c.ASSIST_STATUSES, coKinds: c.CO_KINDS, session: null, error: null };
};
