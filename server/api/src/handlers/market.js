'use strict';
// The marketplace, step 1 (2026-09-27): a vetted list of local vendors per city (rides, meals, childcare, pets,
// lodging, help at home). The coordinator keeps the list and books from it; a family sees only the vendor booked
// on their own plan item. Families pay vendors directly — we never take their money.
//
// And the needs log: what each family needed and when (days from surgery), by hospital and surgery. It is built
// from the plan and tasks every day, nobody types it. Group numbers show only once 11 or more families are behind
// them, so nobody can be picked out of a small group.
const db = require('../db');
const core = require('../core');
const { id, must, clean, isTrue } = require('../util');
const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');

const SERVICES = ['Rides', 'Meals', 'Childcare', 'Pet care', 'Lodging', 'Help at home', 'Medical equipment', 'Other'];
const MIN_FAMILIES = 11;

// ---- vendors
const web = v => (/^https:\/\/\S+$/.test(String(v || '')) ? String(v) : '');
async function saveVendor(ctx, p, c) {
  coOnly(ctx);
  const name = clean(p.name, 160).trim(); must(name, 'Name the vendor');
  const city = clean(p.city, 60).trim(); must(city, 'Which city do they serve?');
  const row = {
    name, city, state: clean(p.state, 4).toUpperCase(), service: SERVICES.includes(p.service) ? p.service : 'Other',
    phone: clean(p.phone, 40), email: clean(p.email, 160), website: web(p.website), price: clean(p.price, 120),
    insured: isTrue(p.insured), checked: isTrue(p.checked), notes: clean(p.notes, 2000), active: p.active === undefined ? true : isTrue(p.active),
    updated_by: ctx.email, updated_at: new Date(),
  };
  const saved = p.vendorId ? (await db.update('vendors', { vendor_id: String(p.vendorId) }, row, c))[0] : await db.insert('vendors', { vendor_id: id(), ...row }, c);
  must(saved, 'Not found');
  return { vendor: saved };
}
async function vendors() { return db.all(`select * from vendors order by active desc, state, city, service, name`); }
const vendorPublic = v => (v ? { name: v.name, service: v.service, phone: v.phone, website: v.website } : null);

// Book a vendor on a plan item (or clear it). The family then sees the vendor's name and number on that item.
async function setPlanVendor(ctx, p, c) {
  coOnly(ctx);
  const row = await db.one(`select plan_id, extra from plan_items where client_id=$1 and plan_id=$2`, [ctx.clientId, String(p.planId || '')], c); must(row, 'Not found');
  const vid = String(p.vendorId || '');
  if (vid) must(await db.one(`select vendor_id from vendors where vendor_id=$1 and active`, [vid], c), 'That vendor is not on the list');
  const ex = { ...(row.extra || {}) }; if (vid) ex.vendor_id = vid; else delete ex.vendor_id;
  await db.q(`update plan_items set extra=$2, updated_at=now() where plan_id=$1`, [row.plan_id, JSON.stringify(ex)], c);
  return {};
}
// For the family's plan: each item's booked vendor, public details only.
async function vendorsFor(planRows) {
  const ids = [...new Set(planRows.map(p => p.extra && p.extra.vendor_id).filter(Boolean))];
  if (!ids.length) return {};
  const out = {}; for (const v of await db.all(`select * from vendors where vendor_id = any($1)`, [ids])) out[v.vendor_id] = vendorPublic(v);
  return out;
}

// ---- the needs log
// What kind of need a plan item or task is, from its words. Anything else is left out of the log.
const NEEDS = [
  ['Ride', /\b(ride|rides|drive|driver|driving|transport|pick ?up|escort home)\b/i],
  ['Meals', /\b(meal|meals|food|groceries|grocery|cook)/i],
  ['Childcare', /\b(child ?care|kids|children|school pick|babysit|nanny)\b/i],
  ['Pet care', /\b(pet|pets|dog|dogs|cat|cats|walker)\b/i],
  ['Lodging', /\b(lodging|hotel|stay near|place to stay|hospitality house|ronald mcdonald)\b/i],
  ['Someone overnight', /\b(overnight|first night|stay with|caregiver)\b/i],
  ['Work and leave papers', /\b(fmla|short-term disability|std|work note|employer|leave)\b/i],
  ['Home setup', /\b(recliner|shower chair|grab bar|home setup|set up the house|walker|commode|bed rail)\b/i],
  ['Medications', /\b(medication|meds|pharmacy|pill|prescription)\b/i],
];
const needOf = text => { for (const [k, re] of NEEDS) if (re.test(String(text || ''))) return k; return ''; };
const dayDiff = (a, b) => Math.round((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 864e5);

// Rebuilds the log from the plan and tasks: one row per item, the day it was needed counted from the surgery date
// (its target date, or the day it was marked done). Safe to run any number of times.
async function logNeeds() {
  const clients = await db.all(`select c.client_id, c.surgery_date, c.extra, (select answer from intake_answers i where i.client_id=c.client_id and i.question_id='G.4') surgery
                                from clients c where c.surgery_date is not null`);
  let n = 0;
  for (const cl of clients) {
    const ex = cl.extra || {};
    const walk = ex.walk_id ? await db.one(`select name from hospital_walks where walk_id=$1`, [ex.walk_id]) : null;
    const hospital = walk ? walk.name : '';
    const items = await db.all(`select 'plan:'||plan_id src, item txt, target_date, status, updated_at from plan_items where client_id=$1 and not draft
                                union all select 'task:'||task_id, title, due_date, status, updated_at from tasks where client_id=$1`, [cl.client_id]);
    for (const it of items) {
      const need = needOf(it.txt); if (!need) continue;
      const when = it.target_date || (/^done$/i.test(it.status) ? it.updated_at : null); if (!when) continue;
      await db.q(`insert into need_events (event_id, client_id, hospital, surgery, need, day, logged_at) values ($1,$2,$3,$4,$5,$6,now())
                  on conflict (event_id) do update set hospital=excluded.hospital, surgery=excluded.surgery, need=excluded.need, day=excluded.day, logged_at=now()`,
        [cl.client_id + ':' + it.src, cl.client_id, hospital, clean(cl.surgery || '', 160), need, dayDiff(when, cl.surgery_date)]);
      n++;
    }
  }
  return { needs_logged: n };
}
// The coordinator's view: by hospital and need, how many families and the middle day. Fewer than 11 families: the
// count toward 11 only, no day.
async function needsReport(ctx) {
  coOnly(ctx);
  const rows = await db.all(`select hospital, need, count(distinct client_id)::int families, percentile_cont(0.5) within group (order by day) median_day
                             from need_events group by hospital, need order by hospital, need`);
  return { min: MIN_FAMILIES, rows: rows.map(r => ({ hospital: r.hospital || 'Hospital not chosen yet', need: r.need, families: r.families,
    median_day: r.families >= MIN_FAMILIES ? Math.round(Number(r.median_day)) : null })) };
}

module.exports = { saveVendor, setPlanVendor, needsReport };
Object.defineProperties(module.exports, {
  vendors: { value: vendors, enumerable: false }, vendorsFor: { value: vendorsFor, enumerable: false }, logNeeds: { value: logNeeds, enumerable: false },
  needOf: { value: needOf, enumerable: false }, SERVICES: { value: SERVICES, enumerable: false }, MIN_FAMILIES: { value: MIN_FAMILIES, enumerable: false },
});
