'use strict';
// Guides (2026-09-27): the hospital photo-walk (parking → entrance → desk → waiting room, one hospital at a time) and
// the Explainer (what is happening in the body, tap a part, "explain it simpler"). Both are shelves the coordinator
// stocks once and assigns per family; families only ever read.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const { id, must, clean, first } = require('../util');
const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');

// ---- hospital walks
async function saveWalk(ctx, p, c) {
  coOnly(ctx);
  const name = clean(p.name, 160).trim(); must(name, 'Name the hospital');
  const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, 20).map(s => ({
    title: clean(s.title, 120).trim(), text: clean(s.text, 1200), url: /^https:\/\/\S+$/.test(String(s.url || '')) ? String(s.url) : '',
    photo: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(s.photo || '')) && String(s.photo).length < 400000 ? String(s.photo) : '',
  })).filter(s => s.title);
  const row = { name, state: clean(p.state, 4).toUpperCase(), city: clean(p.city, 60), address: clean(p.address, 300), maps_url: /^https:\/\/\S+$/.test(String(p.maps_url || '')) ? String(p.maps_url) : '', phone: clean(p.phone, 40), notes: clean(p.notes, 2000), steps: JSON.stringify(steps), updated_by: ctx.email, updated_at: new Date() };
  const saved = p.walkId ? (await db.update('hospital_walks', { walk_id: String(p.walkId) }, row, c))[0] : await db.insert('hospital_walks', { walk_id: id(), ...row }, c);
  must(saved, 'Not found');
  return { walk: saved };
}
async function removeWalk(ctx, p, c) { coOnly(ctx); await db.q(`delete from hospital_walks where walk_id=$1`, [String(p.walkId || '')], c); return { ok: true }; }
// Campus maps: which hospital name opens which map and pin. Read live from the maps bucket (hospitals/index.json,
// written by maps/tools/build_all.py and publish.sh) so fine-tuning a map never needs a deploy; data/maps.json is the fallback.
const normName = n => String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
let MAPS = null, MAPS_AT = 0;
function indexFrom(list) { const m = new Map(); for (const h of list || []) if (h && h.name && h.map) m.set(normName(h.name), { map: String(h.map), map_pin: String(h.pin || '') }); return m; }
async function loadMaps() {
  if (MAPS && Date.now() - MAPS_AT < 5 * 60e3) return MAPS;
  try {
    const buf = await require('../maps').read('hospitals/index.json');
    MAPS = indexFrom(JSON.parse(buf.toString('utf8')).hospitals);
  } catch (e) {
    console.error('campus map index', e.message);
    if (!MAPS) { try { MAPS = indexFrom(require('../data/maps.json').hospitals); } catch (e2) { MAPS = new Map(); } }
  }
  MAPS_AT = Date.now(); return MAPS;
}
async function mapFor(name) { return (await loadMaps()).get(normName(name)) || null; }
const withMap = async w => { if (!w) return w; const m = await mapFor(w.name); return m ? { ...w, ...m } : { ...w, map: '', map_pin: '' }; };
async function walks() { return Promise.all((await db.all(`select walk_id, name, address, maps_url, phone, notes, steps, state, city, updated_at from hospital_walks order by name`)).map(withMap)); }
async function assignWalk(ctx, p, c) {
  coOnly(ctx); must(ctx.clientId, 'Pick a family first');
  const client = await core.clientById(ctx.clientId, c);
  const ex = client.extra && typeof client.extra === 'object' ? client.extra : {};
  await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...ex, walk_id: String(p.walkId || ''), walk_by: 'coordinator' })], c);
  return { ok: true };
}

// ---- explainers
// parts: [{ id, name, x, y, plain, simpler }] — x,y are percentages on the figure. plain is for an adult with no medical
// background; simpler is the third-grade version, one idea per sentence. Neither is advice; both end at "ask the team".
async function saveExplainer(ctx, p, c) {
  coOnly(ctx);
  const key = clean(p.key, 60).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'); must(key, 'Give it a key');
  const parts = (Array.isArray(p.parts) ? p.parts : []).slice(0, 12).map(x => ({ id: clean(x.id, 30).trim() || id(), name: clean(x.name, 80).trim(), x: Math.max(0, Math.min(100, Number(x.x) || 50)), y: Math.max(0, Math.min(100, Number(x.y) || 50)), plain: clean(x.plain, 1500), simpler: clean(x.simpler, 1500) })).filter(x => x.name);
  const row = { title: clean(p.title, 160).trim(), summary: clean(p.summary, 1500), simpler: clean(p.simpler, 1500), figure: ['body', 'head', 'chest', 'spine', 'hip', 'knee'].indexOf(p.figure) >= 0 ? p.figure : 'body', parts: JSON.stringify(parts), updated_by: ctx.email, updated_at: new Date() };
  must(row.title, 'Give it a title');
  await db.q(`insert into explainers (key, title, summary, simpler, figure, parts, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
    on conflict (key) do update set title=excluded.title, summary=excluded.summary, simpler=excluded.simpler, figure=excluded.figure, parts=excluded.parts, updated_by=excluded.updated_by, updated_at=excluded.updated_at`, [key, row.title, row.summary, row.simpler, row.figure, row.parts, row.updated_by, row.updated_at], c);
  return { ok: true };
}
async function removeExplainer(ctx, p, c) { coOnly(ctx); await db.q(`delete from explainers where key=$1`, [String(p.key || '')], c); return { ok: true }; }
async function explainers() { return db.all(`select key, title, summary, simpler, figure, parts, updated_at from explainers order by title`); }
async function assignExplainer(ctx, p, c) {
  coOnly(ctx); must(ctx.clientId, 'Pick a family first');
  const client = await core.clientById(ctx.clientId, c);
  const ex = client.extra && typeof client.extra === 'object' ? client.extra : {};
  await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...ex, explainer_key: String(p.key || '') })], c);
  return { ok: true };
}
// The shelf as families see it: one walk and one explainer, the ones assigned to them.
async function guidesFor(client) {
  const ex = client.extra && typeof client.extra === 'object' ? client.extra : {};
  const walk = await withMap(ex.walk_id ? await db.one(`select walk_id, name, address, maps_url, phone, notes, steps, state, city from hospital_walks where walk_id=$1`, [ex.walk_id]) : null);
  const H = require('./hospitals'); const hospital = walk ? await H.factsFor(walk.name, false) : null; const outside = walk ? await H.outsideFor(walk.state, walk.city) : [];
  const explainer = ex.explainer_key ? await db.one(`select key, title, summary, simpler, figure, parts from explainers where key=$1`, [ex.explainer_key]) : null;
  return { walk, explainer, hospital, outside };
}

// Seeds: four explainers written at two levels, so the shelf is never empty on day one. The coordinator edits any of it.
const SEED = [
  { key: 'craniotomy', title: 'Brain surgery (a craniotomy)', figure: 'head',
    summary: 'The skull is a hard case around the brain. A craniotomy opens a small window in that case so the surgeon can reach the part of the brain that needs help — to take out a tumor, stop a bleed, or fix a blood vessel — and then the window is closed again with tiny plates. The brain itself does not feel pain; the skin and the muscle over it do, and that is most of what hurts afterwards.',
    simpler: 'Your head has a hard shell called the skull. It keeps your brain safe. The doctor opens a small door in the shell. The doctor fixes the problem inside. Then the door is closed again. It heals like a bone.',
    parts: [
      { id: 'skull', name: 'The skull', x: 50, y: 22, plain: 'The bone case. The surgeon removes a piece the size of a playing card (a “bone flap”), works, and puts it back with small titanium plates and screws that stay for life. They do not set off airport scanners. The bone knits back over months.', simpler: 'The hard shell. The doctor takes out a small piece, like a lid. After, the lid goes back on with tiny screws. The bone grows back together.' },
      { id: 'brain', name: 'The brain', x: 50, y: 40, plain: 'Different areas do different jobs — speech, movement, sight. The team maps where the problem is before surgery so they can reach it while disturbing as little as possible. Swelling after surgery is expected and is why steroids are often given for a few days.', simpler: 'The brain is the boss of the body. Each part has a job. The doctor is careful to fix only the sick part. The brain gets a little puffy after. That is normal.' },
      { id: 'incision', name: 'The incision', x: 62, y: 18, plain: 'A curved cut in the scalp, usually behind the hairline, closed with staples or stitches. Numbness around it is common and can last months. It should be dry and closed; spreading redness, drainage, or a fever is a “call the team” sign.', simpler: 'The cut on the head. It has staples or stitches. It can feel numb. If it gets red or leaks, call the doctor.' },
      { id: 'drain', name: 'The drain', x: 72, y: 30, plain: 'A thin tube that lets fluid out for a day or two so it does not build up. It comes out at the bedside; that is a quick pull, not a procedure.', simpler: 'A little tube that lets extra water out. It comes out in a day or two. It only takes a second.' },
      { id: 'tired', name: 'Why so tired', x: 30, y: 62, plain: 'The brain uses a quarter of the body’s energy on a normal day, and healing brain uses more. Sleep is treatment. Two weeks of naps is not a setback.', simpler: 'The brain is working hard to heal. Healing makes you sleepy. Sleep is how it gets better.' },
    ] },
  { key: 'heart-valve', title: 'Heart valve surgery', figure: 'chest',
    summary: 'The heart has four one-way doors called valves. When one gets stiff or leaky, the heart has to work too hard. Surgery repairs the door or swaps in a new one — made of metal, or of tissue from a cow or pig. To reach the heart the surgeon usually goes through the breastbone, which is wired back together and heals like any broken bone: about six to eight weeks.',
    simpler: 'Your heart is a pump. It has four little doors. One door is broken. The doctor fixes the door or puts in a new one. To get to the heart, the doctor opens the chest bone. The bone is wired shut. It heals in about two months.',
    parts: [
      { id: 'valve', name: 'The valve', x: 48, y: 44, plain: 'A repaired valve is the person’s own tissue, reshaped. A tissue valve lasts ten to twenty years and usually needs no long-term blood thinner. A metal valve lasts a lifetime but needs warfarin every day, forever. The team chose based on age and other conditions; it is a fair question to ask why.', simpler: 'The little door in the heart. It can be fixed, or a new one put in. A new one can be metal or from an animal. Both work well.' },
      { id: 'sternum', name: 'The breastbone', x: 50, y: 36, plain: 'Split down the middle and closed with stainless wires that stay. “Sternal precautions” — no lifting over ten pounds, no pushing up from a chair with the arms, hug a pillow when coughing — protect it for six to eight weeks. The wires do not set off scanners.', simpler: 'The bone in the middle of the chest. It was opened and then wired shut. It is healing like a broken arm. No heavy lifting. Hug a pillow when you cough.' },
      { id: 'pump', name: 'The bypass machine', x: 72, y: 50, plain: 'During surgery a machine did the heart and lungs’ job so the heart could be still. Coming off it is normal, but for a few weeks the body can feel “off” — foggy, weepy, not hungry. This is common and it passes.', simpler: 'A machine did the heart’s job during surgery so the heart could rest. After, you might feel foggy or sad for a while. That is normal. It goes away.' },
      { id: 'tubes', name: 'Chest tubes and wires', x: 30, y: 52, plain: 'Tubes drain fluid from around the heart and lungs for a few days; temporary pacing wires sit on the heart in case the rhythm needs a nudge. All of it comes out before going home.', simpler: 'Some tubes let extra water out. Some wires help the heartbeat if it needs it. They all come out before you go home.' },
      { id: 'rhythm', name: 'The rhythm', x: 48, y: 60, plain: 'About a third of people get a fast, irregular beat (atrial fibrillation) in the first week. It is expected, it is treated, and it usually settles. It is why the monitor stays on.', simpler: 'The heart can beat funny for a few days after. The doctors watch for it. It is common. It gets better.' },
    ] },
  { key: 'hip-replacement', title: 'Hip replacement', figure: 'hip',
    summary: 'The hip is a ball on the top of the thigh bone sitting in a cup in the pelvis. When the cartilage wears away, bone grinds on bone. The surgeon replaces the ball with a metal one on a stem set into the thigh bone, and lines the cup with a smooth socket. Most people walk the same day. The new hip is strong immediately; the muscles around it take weeks to catch up.',
    simpler: 'Your hip is a ball in a cup. The old ball got rough and it hurt. The doctor put in a new smooth ball and a new cup. You can walk on it right away. The muscles need time to get strong.',
    parts: [
      { id: 'ball', name: 'The new ball and cup', x: 50, y: 48, plain: 'Metal, ceramic and a tough plastic liner. Modern hips last twenty years or more. There is no “breaking it in” — it works from day one; the limits are about the muscles and the healing cut, not the metal.', simpler: 'The new ball is metal. The new cup is smooth. It is strong from the first day.' },
      { id: 'incision', name: 'The incision', x: 62, y: 45, plain: 'On the side or the front of the hip, closed with glue, staples or stitches. Bruising down the thigh is normal and can be dramatic. A hot, red, weeping incision is a call.', simpler: 'The cut on the side of the hip. Bruises are normal. If it gets red and hot, call the doctor.' },
      { id: 'precautions', name: 'The rules', x: 40, y: 66, plain: 'Depending on the approach, the team may ask you not to bend past ninety degrees, cross the legs, or turn the foot inward for some weeks — to keep the new ball in its cup while the muscles heal. Their rules win over anything written here.', simpler: 'There are a few rules so the new hip stays in place. No crossing your legs. No bending too far. The doctor tells you the rules.' },
      { id: 'clots', name: 'Blood clots', x: 55, y: 80, plain: 'The biggest risk in the first weeks is a clot in the leg. Walking, the blood thinner, and the squeezy leg cuffs all fight it. One calf swollen, hot, or painful — especially on one side — is a same-day call. Sudden breathlessness is 911.', simpler: 'Walking keeps the blood moving. If one leg gets big and hot, call the doctor that day. If it is hard to breathe, call 911.' },
    ] },
  { key: 'spinal-fusion', title: 'Spinal fusion', figure: 'spine',
    summary: 'The spine is a stack of bones with cushions between them and the nerves running down the middle. When a level is unstable or a cushion is pressing on a nerve, the surgeon takes the pressure off and locks that level with screws and rods so the two bones grow into one. The screws hold it while the bone heals; the bone is what makes it permanent, and that takes months.',
    simpler: 'Your back is a stack of bones. One spot was wobbly or pinching a nerve. The doctor fixed it with screws and rods so two bones can grow into one. The screws hold it. The bone does the real work, and that takes a long time.',
    parts: [
      { id: 'hardware', name: 'Screws and rods', x: 50, y: 50, plain: 'Titanium, meant to stay. They hold the level still while the bone fuses; once fused, the bone carries the load. Setting off a scanner is rare; carry the card anyway.', simpler: 'Metal screws hold the bones still. They stay in. Once the bone heals, the bone is strong and the screws just rest.' },
      { id: 'fusion', name: 'The fusion', x: 50, y: 62, plain: 'Bone graft — your own, from a donor, or a synthetic — is packed in so new bone bridges the gap. It takes three to six months, sometimes a year. Smoking and nicotine are the biggest thing that stops it; the team will say so bluntly.', simpler: 'New bone grows between the two bones. It takes many months. No smoking — it stops the bone from growing.' },
      { id: 'nerve', name: 'The nerve', x: 62, y: 44, plain: 'Nerves that were squeezed for a long time wake up slowly. Numbness or tingling that was there before can take months to fade, and some may stay. New weakness, new numbness, or trouble with the bladder or bowels is a call now.', simpler: 'The nerve was squished. It wakes up slowly. Tingling can last a while. If a leg gets weak or you cannot pee, call right away.' },
      { id: 'bltr', name: 'No BLT', x: 34, y: 60, plain: 'No Bending, Lifting, or Twisting for the weeks the team gives — usually six to twelve. A brace, if ordered, is for those movements, not for sitting on the couch. Log-roll out of bed.', simpler: 'No bending. No lifting. No twisting. Roll like a log to get out of bed. The brace helps you remember.' },
    ] },
];
async function seed() {
  for (const e of SEED) {
    const has = await db.one(`select 1 from explainers where key=$1`, [e.key]); if (has) continue;
    await db.q(`insert into explainers (key, title, summary, simpler, figure, parts, updated_by) values ($1,$2,$3,$4,$5,$6,'seed') on conflict do nothing`, [e.key, e.title, e.summary, e.simpler, e.figure, JSON.stringify(e.parts)]);
  }
}

module.exports = { saveWalk, removeWalk, assignWalk, saveExplainer, removeExplainer, assignExplainer };
Object.defineProperty(module.exports, 'walks', { value: walks, enumerable: false });
Object.defineProperty(module.exports, 'mapFor', { value: mapFor, enumerable: false });
Object.defineProperty(module.exports, 'explainers', { value: explainers, enumerable: false });
Object.defineProperty(module.exports, 'guidesFor', { value: guidesFor, enumerable: false });
Object.defineProperty(module.exports, 'seed', { value: seed, enumerable: false });
