'use strict';
// Stripe webhook with real signature verification (the Apps Script could not read the header).
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');
const billing = require('./billing');
const { safeEqual, famName } = require('./util');

function verify(raw, header, secret) {
  if (!header || !secret) return false;
  let t = ''; const v1 = [];
  header.split(',').forEach(kv => { const [k, v] = kv.split('='); if (k === 't') t = v; if (k === 'v1') v1.push(v); });
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return v1.some(x => safeEqual(x, sig));
}

async function handle(req, res, rawBuf) {
  const raw = rawBuf.toString('utf8');
  const ok = verify(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  if (!ok) { res.writeHead(400); return res.end('bad signature'); }
  let ev; try { ev = JSON.parse(raw); } catch { res.writeHead(400); return res.end('bad json'); }
  const obj = ev.data && ev.data.object || {};
  try {
    await core.audit({ email: 'stripe', role: 'webhook', clientId: '' }, ev.type, { kind: String(obj.id || '') }, '');
    if (ev.type === 'invoice.paid' || ev.type === 'invoice.payment_succeeded') {
      await billing.markPaid(obj.customer, obj);
      await db.q(`update clients set billing_status='Active' where stripe_customer_id=$1 and billing_status='Payment failed'`, [obj.customer]);
    } else if (ev.type === 'invoice.payment_failed') {
      const c = await db.one(`select * from clients where stripe_customer_id=$1`, [obj.customer]);
      if (c) {
        await db.q(`update clients set billing_status='Payment failed' where client_id=$1`, [c.client_id]);
        await core.autoMsg(c.client_id, 'A payment of $' + ((obj.amount_due || 0) / 100).toFixed(2) + ' did not go through. Please check the card under Billing → Payment method.');
        await core.notifyCo(await core.coordinatorFor(c), 'billing', 'Payment failed — ' + famName(c.family_name), 'Stripe could not collect $' + ((obj.amount_due || 0) / 100).toFixed(2) + '. Stripe will retry; you may want to reach out.', '', 'Open the portal');
      }
    } else if (ev.type === 'checkout.session.completed' && obj.mode === 'setup' && obj.customer && obj.setup_intent) {
      try { const si = await billing.stripe('GET', '/v1/setup_intents/' + obj.setup_intent, {}); if (si.payment_method) await billing.stripe('POST', '/v1/customers/' + obj.customer, { 'invoice_settings[default_payment_method]': si.payment_method }); } catch {}
    }
    res.writeHead(200); res.end('ok');
  } catch (e) { console.error('webhook', e); res.writeHead(500); res.end('error'); }
}
module.exports = { handle, verify };
