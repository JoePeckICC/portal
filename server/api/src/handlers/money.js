'use strict';
// Billing through Stripe: the coordinator's controls and the family's self-service.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const B = require('../billing');
const { must, clean, famName, isTrue } = require('../util');

const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const famOnly = ctx => must(core.fam(ctx), 'Not allowed');
const famOrCo = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const pub = async (ctx, c) => ({ client: core.publicClient(await core.clientById(ctx.clientId, c)) });

async function startBilling(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  const amount = Number(p.amount); must(amount >= 0 && amount < 100000, 'Enter a monthly amount');
  const payer = await db.one(`select * from users where client_id=$1 and active and lower(role)='client' order by email limit 1`, [ctx.clientId], c); must(payer, 'The family needs a client sign-in first');
  let cust = cl.stripe_customer_id;
  if (!cust) { const cr = await B.stripe('POST', '/v1/customers', { email: payer.email, name: famName(cl.family_name), 'metadata[client_id]': ctx.clientId }); cust = cr.id; }
  let sub = null;
  if (amount > 0) { sub = await B.stripe('POST', '/v1/subscriptions', await B.subParams(cust, amount, ctx.clientId, cl)); await B.sendFirstInvoice(sub); }
  await db.update('clients', { client_id: cl.client_id }, { stripe_customer_id: cust, stripe_subscription_id: sub ? sub.id : null, monthly_amount: amount, billing_status: amount > 0 ? 'Active' : 'No charge' }, c);
  if (amount === 0) { await db.q(`update clients set paid=true where client_id=$1`, [cl.client_id], c); await core.autoMsg(ctx.clientId, 'Your portal is open. There is no monthly charge on your account.', c); }
  else await core.autoMsg(ctx.clientId, 'Billing started: $' + amount.toFixed(2) + ' a month. Your first invoice is on its way by email; you can also pay it under Billing.', c);
  return pub(ctx, c);
}
async function changeAmount(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_customer_id, 'Start billing first');
  const amount = Number(p.amount); must(amount >= 0 && amount < 100000, 'Enter a monthly amount');
  if (cl.stripe_subscription_id) {
    const sub = await B.stripe('GET', '/v1/subscriptions/' + cl.stripe_subscription_id, {});
    const itemId = sub.items && sub.items.data[0] && sub.items.data[0].id;
    if (amount > 0 && itemId) await B.stripe('POST', '/v1/subscriptions/' + cl.stripe_subscription_id, { 'items[0][id]': itemId, 'items[0][price_data][currency]': 'usd', 'items[0][price_data][product]': await B.stripeProduct(), 'items[0][price_data][unit_amount]': Math.round(amount * 100), 'items[0][price_data][recurring][interval]': 'month', proration_behavior: 'none' });
    else if (amount === 0) { await B.stripe('DELETE', '/v1/subscriptions/' + cl.stripe_subscription_id, {}); await db.q(`update clients set stripe_subscription_id=null where client_id=$1`, [cl.client_id], c); }
  } else if (amount > 0) {
    const ns = await B.stripe('POST', '/v1/subscriptions', await B.subParams(cl.stripe_customer_id, amount, ctx.clientId, cl));
    await B.sendFirstInvoice(ns);
    await db.q(`update clients set stripe_subscription_id=$2 where client_id=$1`, [cl.client_id, ns.id], c);
  }
  await db.update('clients', { client_id: cl.client_id }, { monthly_amount: amount, billing_status: amount > 0 ? 'Active' : 'No charge' }, c);
  await core.autoMsg(ctx.clientId, 'Your monthly amount is now $' + amount.toFixed(2) + (amount === 0 ? ' — no charge going forward.' : ', starting with the next invoice.'), c);
  return pub(ctx, c);
}
async function pauseBilling(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_subscription_id, 'Nothing to pause');
  if (p.resume) await B.stripe('POST', '/v1/subscriptions/' + cl.stripe_subscription_id, { pause_collection: '' });
  else await B.stripe('POST', '/v1/subscriptions/' + cl.stripe_subscription_id, { 'pause_collection[behavior]': 'void' });
  await db.q(`update clients set billing_status=$2 where client_id=$1`, [cl.client_id, p.resume ? 'Active' : 'Paused'], c);
  await core.autoMsg(ctx.clientId, p.resume ? 'Billing resumed.' : 'Billing is paused. No invoices until it is resumed.', c);
  return pub(ctx, c);
}
async function billing(ctx) {
  famOrCo(ctx);
  const cl = await core.clientById(ctx.clientId); must(cl, 'Not found');
  return { billing: await B.billingFor(cl) };
}
async function portalLink(ctx) {
  famOnly(ctx);
  const cl = await core.clientById(ctx.clientId); must(cl && cl.stripe_customer_id, 'Billing has not started yet');
  const sess = await B.stripe('POST', '/v1/billing_portal/sessions', { customer: cl.stripe_customer_id, return_url: C.PORTAL_URL });
  return { url: sess.url };
}
// Pay when you're ready (added 2026-09-24). A family that has not paid can start their monthly plan
// from the page themselves: no invoice is sent. Stripe Checkout creates the subscription and takes the
// first month on the spot; the invoice.paid webhook then opens the portal (billing.markPaid), and
// checkout.session.completed records the subscription (webhook.js). The amount is whatever the
// coordinator set for the family, else DEFAULT_MONTHLY.
async function checkoutLink(ctx, p, c) {
  famOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  must(!isTrue(cl.paid), 'Your portal is already open.');
  must(!cl.stripe_subscription_id, 'Your plan is already set up. You can pay the open invoice under Billing.');
  const payer = await db.one(`select * from users where client_id=$1 and active and lower(role)='client' order by email limit 1`, [ctx.clientId], c);
  let cust = cl.stripe_customer_id;
  if (!cust) {
    cust = (await B.stripe('POST', '/v1/customers', { email: (payer || ctx.user).email, name: famName(cl.family_name), 'metadata[client_id]': ctx.clientId })).id;
    await db.update('clients', { client_id: cl.client_id }, { stripe_customer_id: cust }, c);
  }
  const amount = Number(cl.monthly_amount) > 0 ? Number(cl.monthly_amount) : C.DEFAULT_MONTHLY;
  const sess = await B.stripe('POST', '/v1/checkout/sessions', { mode: 'subscription', customer: cust, 'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product]': await B.stripeProduct(), 'line_items[0][price_data][unit_amount]': Math.round(amount * 100), 'line_items[0][price_data][recurring][interval]': 'month', 'metadata[client_id]': ctx.clientId, 'subscription_data[metadata][client_id]': ctx.clientId, success_url: C.PORTAL_URL + '?paid=1', cancel_url: C.PORTAL_URL });
  return { url: sess.url };
}
// Card on file: Stripe Checkout in setup mode. The card lands on the customer; billingFor makes it the default.
async function cardSetupLink(ctx) {
  famOrCo(ctx);
  const cl = await core.clientById(ctx.clientId); must(cl && cl.stripe_customer_id, 'Billing has not started yet');
  const sess = await B.stripe('POST', '/v1/checkout/sessions', { mode: 'setup', customer: cl.stripe_customer_id, 'payment_method_types[0]': 'card', success_url: C.PORTAL_URL + '?card=saved', cancel_url: C.PORTAL_URL });
  return { url: sess.url };
}
// Pay an open invoice with the card on file, from inside the portal.
async function payInvoice(ctx, p, c) {
  famOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_customer_id, 'Billing has not started yet');
  const inv = await B.stripe('GET', '/v1/invoices/' + String(p.invoiceId), {});
  must(inv.customer === cl.stripe_customer_id && inv.status === 'open', 'That invoice is not open');
  const cu = await B.stripe('GET', '/v1/customers/' + cl.stripe_customer_id, {}), pm = cu.invoice_settings && cu.invoice_settings.default_payment_method;
  must(pm, 'No card on file yet. Add one under Payment method, or pay from the invoice link.');
  const paid = await B.stripe('POST', '/v1/invoices/' + inv.id + '/pay', { payment_method: pm.id || pm });
  const after = async () => { if (paid.status === 'paid') { await B.markPaid(cl.stripe_customer_id); if (cl.billing_status === 'Payment failed') await db.q(`update clients set billing_status='Active' where client_id=$1`, [cl.client_id]); } };
  return { status: paid.status, _after: after };
}
// Autopay: charge the card on file each month instead of emailing an invoice.
async function setAutopay(ctx, p, c) {
  famOrCo(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_subscription_id, 'Start billing first');
  if (p.on) {
    const card = await B.defaultCard(cl.stripe_customer_id); must(card, 'Add a card first (Billing → Payment method).');
    await B.stripe('POST', '/v1/subscriptions/' + cl.stripe_subscription_id, { collection_method: 'charge_automatically', days_until_due: '' });
    await db.q(`update clients set autopay=true where client_id=$1`, [cl.client_id], c);
    await core.autoMsg(ctx.clientId, 'Autopay is on. The monthly amount will be charged to ' + card + ' on the billing date.', c);
  } else {
    await B.stripe('POST', '/v1/subscriptions/' + cl.stripe_subscription_id, { collection_method: 'send_invoice', days_until_due: 7 });
    await db.q(`update clients set autopay=false where client_id=$1`, [cl.client_id], c);
    await core.autoMsg(ctx.clientId, 'Autopay is off. Invoices will come by email again, due in 7 days.', c);
  }
  return pub(ctx, c);
}
// One-off charge: a single invoice outside the monthly plan (extra time, a pass-through vendor cost).
async function chargeOnce(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_customer_id, 'Start billing first');
  const amount = Number(p.amount); must(amount > 0 && amount < 100000, 'Enter an amount');
  const desc = clean(p.description, 200); must(desc, 'Say what it is for');
  const auto = isTrue(cl.autopay) && !!(await B.defaultCard(cl.stripe_customer_id));
  const params = { customer: cl.stripe_customer_id, collection_method: auto ? 'charge_automatically' : 'send_invoice', auto_advance: 'true', 'metadata[client_id]': ctx.clientId };
  if (!auto) params.days_until_due = 7;
  let inv = await B.stripe('POST', '/v1/invoices', params);
  await B.stripe('POST', '/v1/invoiceitems', { customer: cl.stripe_customer_id, invoice: inv.id, amount: Math.round(amount * 100), currency: 'usd', description: desc });
  inv = await B.stripe('POST', '/v1/invoices/' + inv.id + '/finalize', {});
  if (auto) { try { await B.stripe('POST', '/v1/invoices/' + inv.id + '/pay', {}); } catch {} } else await B.stripe('POST', '/v1/invoices/' + inv.id + '/send', {});
  await core.autoMsg(ctx.clientId, 'New charge: ' + desc + ' — $' + amount.toFixed(2) + (auto ? ', charged to the card on file.' : '. The invoice is in your email and under Billing.'), c);
  return {};
}
async function sendReminder(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); const inv = await B.stripe('GET', '/v1/invoices/' + String(p.invoiceId), {});
  must(cl && inv.customer === cl.stripe_customer_id && inv.status === 'open', 'That invoice cannot be re-sent');
  await B.stripe('POST', '/v1/invoices/' + inv.id + '/send', {});
  await core.autoMsg(ctx.clientId, 'A reminder about the open invoice for $' + ((inv.amount_due || 0) / 100).toFixed(2) + ' was just sent to your email.' + (inv.hosted_invoice_url ? ' You can also pay it under Billing.' : ''), c);
  return {};
}
async function refundInvoice(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); const inv = await B.stripe('GET', '/v1/invoices/' + String(p.invoiceId), { 'expand[0]': 'payments' });
  must(cl && inv.customer === cl.stripe_customer_id && inv.status === 'paid', 'Only a paid invoice can be refunded');
  const params = {}, pi = B.invPi(inv), ch = inv.charge && (inv.charge.id || inv.charge);
  if (pi) params.payment_intent = pi; else if (ch) params.charge = ch; else must(false, 'This invoice was not paid by card');
  const amount = Number(p.amount || 0); if (amount > 0) params.amount = Math.round(amount * 100);
  const r = await B.stripe('POST', '/v1/refunds', params);
  await core.autoMsg(ctx.clientId, 'Refunded $' + ((r.amount || 0) / 100).toFixed(2) + ' to the card you paid with. It usually shows in 5–10 business days.', c);
  return {};
}
async function addCredit(ctx, p, c) {
  coOnly(ctx);
  const cl = await core.clientById(ctx.clientId, c); must(cl && cl.stripe_customer_id, 'Start billing first');
  const amount = Number(p.amount); must(amount > 0 && amount < 100000, 'Enter an amount');
  await B.stripe('POST', '/v1/customers/' + cl.stripe_customer_id + '/balance_transactions', { amount: -Math.round(amount * 100), currency: 'usd', description: clean(p.note, 200) || 'Credit from ' + C.APP_NAME });
  await core.autoMsg(ctx.clientId, 'A credit of $' + amount.toFixed(2) + (p.note ? ' (' + clean(p.note, 200) + ')' : '') + ' is on your account. It comes off your next invoice.', c);
  return {};
}
// Every family at once: invoices across the account, with this month's totals.
async function allBilling(ctx) {
  coOnly(ctx);
  const clients = await db.all(`select * from clients`), byCust = {};
  clients.forEach(cl => { if (cl.stripe_customer_id) byCust[cl.stripe_customer_id] = cl; });
  const fams = clients.filter(cl => cl.stripe_customer_id).map(cl => ({ client_id: cl.client_id, family: famName(cl.family_name), amount: cl.monthly_amount == null ? '' : Number(cl.monthly_amount), status: cl.billing_status || '', autopay: isTrue(cl.autopay) }));
  const t = { paidThisMonth: 0, open: 0, overdue: 0, overdueCount: 0, failedCount: 0 };
  if (!B.connected()) return { invoices: [], totals: t, families: fams };
  const inv = await B.stripe('GET', '/v1/invoices', { limit: 100 }), now = Date.now() / 1000; let m0 = new Date(); m0 = new Date(m0.getFullYear(), m0.getMonth(), 1).getTime() / 1000;
  const rows = (inv.data || []).filter(i => i.status !== 'draft' && i.status !== 'void' && byCust[String(i.customer)]).map(i => {
    const cl = byCust[String(i.customer)], overdue = i.status === 'open' && i.due_date && i.due_date < now;
    return { client_id: cl.client_id, family: famName(cl.family_name), id: i.id, date: B.iso((i.status_transitions && i.status_transitions.finalized_at) || i.created), due: B.iso(i.due_date), amount: (i.amount_due || i.total || 0) / 100, status: i.status, paid: i.status === 'paid', overdue, failed: i.status === 'open' && (i.attempt_count || 0) > 0, url: i.hosted_invoice_url || '', paidAt: B.iso(i.status_transitions && i.status_transitions.paid_at) };
  });
  rows.forEach(r => { if (r.paid && r.paidAt && new Date(r.paidAt).getTime() / 1000 >= m0) t.paidThisMonth += r.amount; if (!r.paid && r.status === 'open') { t.open += r.amount; if (r.overdue) { t.overdue += r.amount; t.overdueCount++; } if (r.failed) t.failedCount++; } });
  return { invoices: rows, totals: t, families: fams };
}

module.exports = { startBilling, changeAmount, pauseBilling, billing, portalLink, checkoutLink, cardSetupLink, payInvoice, setAutopay, chargeOnce, sendReminder, refundInvoice, addCredit, allBilling };
