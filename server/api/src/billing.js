'use strict';
// Stripe. Keys come from the environment (Secret Manager on Cloud Run). Same calls as the Apps Script.
const C = require('./config');
const db = require('./db');
const mail = require('./mail');
const { isTrue, famName } = require('./util');

const KEY = () => process.env.STRIPE_SECRET_KEY || '';
let PRODUCT_ID = process.env.STRIPE_PRODUCT_ID || '';

async function stripe(method, path, params) {
  const key = KEY(); if (!key) throw Object.assign(new Error('Billing is not connected yet'), { expected: true });
  const body = Object.keys(params || {}).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const url = 'https://api.stripe.com' + path + (method === 'GET' && body ? '?' + body : '');
  const res = await fetch(url, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('Stripe: ' + (j.error && j.error.message || res.status)), { expected: true });
  return j;
}
const iso = sec => (sec ? new Date(Number(sec) * 1000).toISOString() : '');

async function stripeProduct() {
  if (PRODUCT_ID) return PRODUCT_ID;
  const row = await db.one(`select value from settings where key='STRIPE_PRODUCT_ID'`);
  if (row) return (PRODUCT_ID = row.value);
  const pr = await stripe('POST', '/v1/products', { name: C.APP_NAME + ' — Care coordination' });
  await db.q(`insert into settings (key,value) values ('STRIPE_PRODUCT_ID',$1) on conflict (key) do update set value=excluded.value`, [pr.id]);
  return (PRODUCT_ID = pr.id);
}
// Stripe leaves a new subscription's first invoice as a draft for an hour. Finalize and email it now.
async function sendFirstInvoice(sub) {
  try {
    const invId = sub && sub.latest_invoice && (sub.latest_invoice.id || sub.latest_invoice); if (!invId) return;
    let inv = await stripe('GET', '/v1/invoices/' + invId, {});
    if (inv.status === 'draft') inv = await stripe('POST', '/v1/invoices/' + invId + '/finalize', {});
    if (inv.status === 'open') { if (inv.collection_method === 'charge_automatically') { try { await stripe('POST', '/v1/invoices/' + invId + '/pay', {}); } catch {} } else await stripe('POST', '/v1/invoices/' + invId + '/send', {}); }
  } catch {}
}
async function subParams(cust, amount, clientId, cl) {
  const auto = cl && isTrue(cl.autopay) && !!(await defaultCard(cust));
  const p = { customer: cust, 'items[0][price_data][currency]': 'usd', 'items[0][price_data][product]': await stripeProduct(), 'items[0][price_data][unit_amount]': Math.round(amount * 100), 'items[0][price_data][recurring][interval]': 'month', collection_method: auto ? 'charge_automatically' : 'send_invoice', 'metadata[client_id]': clientId };
  if (!auto) p.days_until_due = 7;
  return p;
}
// The customer's default card as "Visa ····4242". If a card was added (Checkout) but not made default, make it so.
async function defaultCard(cust) {
  try {
    const cu = await stripe('GET', '/v1/customers/' + cust, {});
    let dpm = cu.invoice_settings && cu.invoice_settings.default_payment_method;
    if (!dpm) { const pms = await stripe('GET', '/v1/payment_methods', { customer: cust, type: 'card', limit: 1 }); if (pms.data && pms.data.length) { dpm = pms.data[0].id; await stripe('POST', '/v1/customers/' + cust, { 'invoice_settings[default_payment_method]': dpm }); } }
    if (!dpm) return '';
    const pmo = await stripe('GET', '/v1/payment_methods/' + (dpm.id || dpm), {});
    return pmo.card ? pmo.card.brand.charAt(0).toUpperCase() + pmo.card.brand.slice(1) + ' ····' + pmo.card.last4 : '';
  } catch { return ''; }
}
// The PaymentIntent behind an invoice, on old and new Stripe API versions alike.
function invPi(i) {
  if (!i) return '';
  if (i.payment_intent) return i.payment_intent.id || i.payment_intent;
  const p = i.payments && i.payments.data && i.payments.data[0] && i.payments.data[0].payment;
  return p && p.payment_intent ? (p.payment_intent.id || p.payment_intent) : '';
}

const clientByCustomer = cust => db.one(`select * from clients where stripe_customer_id=$1`, [String(cust || '')]);
// First payment in: open the portal, tell everyone.
async function markPaid(cust, inv) {
  const core = require('./core');
  const cl = await clientByCustomer(cust); if (!cl) return;
  if (isTrue(cl.paid)) { try { await require('./lifecycle').covered(cl, inv); } catch (e) { console.error('covered', e.message); } return; }   // a later month
  await db.q(`update clients set paid=true, paid_at=coalesce(paid_at, now()), cancelled_at=null where client_id=$1`, [cl.client_id]);
  const co = await core.coordinatorFor(cl);
  await core.autoMsg(cl.client_id, 'Your first payment is in and your portal is open.');
  for (const u of await db.all(`select email from users where client_id=$1 and active and lower(role) in ('client','family')`, [cl.client_id]))
    await mail.notify(u.email, 'Your portal is open', 'Thank you. Your first payment is in, and your ' + C.APP_NAME + ' portal is open: the plan, messages with ' + (co ? co.name : 'your coordinator') + ', and updates for the people you choose.', '', 'Open the portal');
  await core.notifyCo(co, 'assist', 'Paid — ' + famName(cl.family_name), 'Their first invoice is paid and the portal is open.', '', 'Open the portal');
}
// Backstop for the webhook: an unpaid family with a Stripe customer gets checked on sign-in.
async function syncPaid(cl) {
  try { const inv = await stripe('GET', '/v1/invoices', { customer: cl.stripe_customer_id, status: 'paid', limit: 1 }); if (inv.data && inv.data.length) await markPaid(cl.stripe_customer_id); } catch {}
}
// What the Billing page shows: the subscription and the invoices, straight from Stripe.
async function billingFor(cl) {
  const out = { connected: !!KEY(), amount: cl.monthly_amount == null ? '' : Number(cl.monthly_amount), status: cl.billing_status || '', invoices: [], next: null, card: '' };
  if (!cl.stripe_customer_id || !out.connected) return out;
  try {
    const inv = await stripe('GET', '/v1/invoices', { customer: cl.stripe_customer_id, limit: 24, 'expand[0]': 'data.payments' });
    for (const i of inv.data || []) if (i.status === 'draft' && i.subscription) { try { const f = await stripe('POST', '/v1/invoices/' + i.id + '/finalize', {}); await stripe('POST', '/v1/invoices/' + i.id + '/send', {}); Object.assign(i, { status: f.status, hosted_invoice_url: f.hosted_invoice_url, invoice_pdf: f.invoice_pdf, due_date: f.due_date, status_transitions: f.status_transitions }); } catch {} }
    out.invoices = (inv.data || []).filter(i => i.status !== 'draft' && i.status !== 'void').map(i => ({ id: i.id, date: iso((i.status_transitions && i.status_transitions.finalized_at) || i.created), due: iso(i.due_date), description: (i.lines && i.lines.data[0] && i.lines.data[0].description) || 'Care coordination', amount: (i.amount_due || i.total || 0) / 100, paid: i.status === 'paid', status: i.status, url: i.hosted_invoice_url || '', pdf: i.invoice_pdf || '' }));
    const refunded = {};
    try { const chs = await stripe('GET', '/v1/charges', { customer: cl.stripe_customer_id, limit: 100 }); (chs.data || []).forEach(ch => { if (!ch.amount_refunded) return; if (ch.invoice) refunded[String(ch.invoice)] = (refunded[String(ch.invoice)] || 0) + ch.amount_refunded / 100; const cpi = ch.payment_intent && (ch.payment_intent.id || ch.payment_intent); if (cpi) refunded[String(cpi)] = (refunded[String(cpi)] || 0) + ch.amount_refunded / 100; }); } catch {}
    const nowS = Date.now() / 1000, piOf = {};
    (inv.data || []).forEach(i => { piOf[i.id] = invPi(i); });
    out.invoices.forEach(i => { i.refunded = refunded[i.id] || (piOf[i.id] && refunded[piOf[i.id]]) || 0; i.overdue = i.status === 'open' && !!i.due && new Date(i.due).getTime() / 1000 < nowS; });
    (inv.data || []).forEach(i => { out.invoices.forEach(o => { if (o.id === i.id) o.failed = i.status === 'open' && (i.attempt_count || 0) > 0 && i.collection_method === 'charge_automatically'; }); });
    if (cl.stripe_subscription_id) {
      const sub = await stripe('GET', '/v1/subscriptions/' + cl.stripe_subscription_id, {});
      const it0 = sub.items && sub.items.data && sub.items.data[0];
      if (sub.status && sub.status !== 'canceled') out.next = { date: iso(sub.current_period_end || (it0 && it0.current_period_end)), amount: (it0 && it0.price && it0.price.unit_amount || 0) / 100, paused: !!sub.pause_collection };
      out.autopay = sub.collection_method === 'charge_automatically';
    }
    out.card = await defaultCard(cl.stripe_customer_id) || '';
    const cu = await stripe('GET', '/v1/customers/' + cl.stripe_customer_id, {});
    out.credit = cu.balance < 0 ? -cu.balance / 100 : 0;
    out.owed = cu.balance > 0 ? cu.balance / 100 : 0;
  } catch (e) { out.error = String(e.message || e); }
  return out;
}

module.exports = { stripe, iso, stripeProduct, sendFirstInvoice, subParams, defaultCard, invPi, clientByCustomer, markPaid, syncPaid, billingFor, connected: () => !!KEY() };
