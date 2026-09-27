'use strict';
// The hospital database (2026-09-27): every verified fact Joe's research gathered, one row each, matched to the
// hospital a family names. Families see the rows with no open flag; the coordinator sees the flags and clears them
// by phone. Maps and PDFs are linked, never copied. Outside resources match by area.
const db = require('../db');
const core = require('../core');
const { id, must, clean } = require('../util');
const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');

// Where each hospital is, for matching the outside resources (city is not in the source rows).
const CITY = [[/Memphis|Le Bonheur/i, 'Memphis'], [/Knoxville|Fort Sanders|Parkwest|Dolly Parton/i, 'Knoxville'], [/Chattanooga|Erlanger|CHI Memorial|Parkridge/i, 'Chattanooga'], [/St\. Louis|Barnes-Jewish|Bridgeton|Fenton|Mercy Hospital South|Saint Louis University|Cardinal Glennon/i, 'St. Louis'],
  [/Kansas City|Independence|Liberty Hospital|Research Medical|Truman|Children's Mercy/i, 'Kansas City'], [/Columbia\)/i, 'Columbia'], [/Maury Regional/i, 'Columbia, TN'], [/Springfield/i, 'Springfield'], [/Joplin/i, 'Joplin'], [/St\. Joseph/i, 'St. Joseph'],
  [/Johnson City/i, 'Johnson City'], [/Bristol/i, 'Bristol'], [/Kingsport|Holston/i, 'Kingsport'], [/Cookeville/i, 'Cookeville'], [/Jackson-Madison/i, 'Jackson'], [/Oak Ridge/i, 'Oak Ridge'], [/Rutherford/i, 'Murfreesboro'], [/Summit/i, 'Hermitage'], [/Vanderbilt|TriStar|Saint Thomas|Monroe Carell/i, 'Nashville']];
const cityOf = name => (CITY.find(c => c[0].test(name)) || [null, ''])[1];
const K = e => (e.hospital + '|' + e.topic + '|' + e.detail).toLowerCase();

// Seed from the shipped JSON: rows are added when they are not there yet, never overwritten (the coordinator's "ok" marks stay).
async function seed() {
  let data; try { data = require('../data/hospitaldb.json'); } catch (e) { return; }
  const have = new Set((await db.all(`select hospital, topic, detail from hospital_facts`)).map(K));
  const hospitals = {};
  for (const r of data.entries || []) {
    const e = { hospital: r['Hospital'], state: r['State'], category: r['Category'], topic: r['Topic'], detail: r['Detail (verified fact, in our words)'], source_url: r['Source URL'], source_type: r['Source type'], access_date: r['Access date'], flag: r['Flag / verify note'] || '' };
    if (!e.hospital || !e.detail) continue;
    hospitals[e.hospital] = hospitals[e.hospital] || { state: e.state, contact: '' };
    if (e.category === 'Contact' && /address/i.test(e.topic) && !hospitals[e.hospital].contact) hospitals[e.hospital].contact = e.detail;
    if (have.has(K(e))) continue;
    await db.insert('hospital_facts', { fact_id: id(), ...e, ok: false }); have.add(K(e));
  }
  const haveDocs = new Set((await db.all(`select hospital, title from hospital_docs`)).map(r => (r.hospital + '|' + r.title).toLowerCase()));
  for (const r of data.docs || []) { const k = (r['Hospital'] + '|' + r['Title']).toLowerCase(); if (!r['Hospital'] || haveDocs.has(k)) continue; await db.insert('hospital_docs', { doc_id: id(), hospital: r['Hospital'], type: r['Type'] || '', title: r['Title'] || '', url: r['Link / location'] || '', version: r['Date or version'] || '', notes: r['Notes'] || '' }); haveDocs.add(k); }
  const haveV = new Set((await db.all(`select hospital, issue from hospital_verify`)).map(r => (r.hospital + '|' + r.issue).toLowerCase()));
  for (const r of data.verify || []) { const k = (r['Hospital'] + '|' + r['Issue']).toLowerCase(); if (!r['Hospital'] || haveV.has(k)) continue; await db.insert('hospital_verify', { verify_id: id(), hospital: r['Hospital'], issue: r['Issue'] || '', sources: r['Sources involved'] || '', done: false }); haveV.add(k); }
  const haveO = new Set((await db.all(`select name from outside_resources`)).map(r => r.name.toLowerCase()));
  for (const r of data.outside || []) { if (!r['Resource'] || haveO.has(r['Resource'].toLowerCase())) continue; await db.insert('outside_resources', { res_id: id(), name: r['Resource'], category: r['Category'] || '', area: r['Area'] || '', what: r['What it offers'] || '', eligibility: r['Eligibility'] || '', contact: r['Contact'] || '', source_url: r['Source URL'] || '', source_type: r['Source type'] || '', access_date: r['Access date'] || '', flag: r['Flag'] || '' }); haveO.add(r['Resource'].toLowerCase()); }
  // one hospital record (the walk) per hospital, so the coordinator only has to assign it
  const walks = new Set((await db.all(`select name from hospital_walks`)).map(r => r.name.toLowerCase()));
  for (const name of Object.keys(hospitals)) {
    if (walks.has(name.toLowerCase())) continue;
    const h = hospitals[name], m = /^(.*?\d{5})/.exec(h.contact || ''), ph = /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.exec(h.contact || '');
    const map = (data.docs || []).find(d => d['Hospital'] === name && /campus map/i.test(d['Type'] || '') && /^https?:/.test(d['Link / location'] || ''));
    await db.insert('hospital_walks', { walk_id: id(), name, address: m ? m[1] : (h.contact || '').split('.')[0].slice(0, 200), maps_url: map ? map['Link / location'] : '', phone: ph ? ph[1] : '', notes: '', steps: '[]', state: h.state || '', city: cityOf(name), updated_by: 'seed' });
  }
}

// Everything a family may see about their hospital, and everything the coordinator sees.
async function factsFor(hospital, forCo) {
  if (!hospital) return null;
  const facts = await db.all(`select fact_id, category, topic, detail, source_url, source_type, access_date, flag, ok from hospital_facts where hospital=$1 order by category, topic`, [hospital]);
  const docs = await db.all(`select doc_id, type, title, url, version, notes from hospital_docs where hospital=$1 order by type`, [hospital]);
  const verify = forCo ? await db.all(`select verify_id, issue, sources, done from hospital_verify where hospital=$1 order by done, issue`, [hospital]) : [];
  return { facts: forCo ? facts : facts.filter(f => !f.flag || f.ok), docs, verify };
}
async function outsideFor(state, city) {
  const rows = await db.all(`select res_id, name, category, area, what, eligibility, contact, source_url, flag from outside_resources order by category, name`);
  const c = String(city || '').split(',')[0].toLowerCase(), s = String(state || '').toUpperCase();
  return rows.filter(r => { const a = String(r.area || '').toLowerCase(); return (c && a.indexOf(c) >= 0) || /national/.test(a) || /tn & mo/.test(a) || (s === 'TN' && /tennessee|tn \+/.test(a)) || (s === 'MO' && /missouri|mo \+/.test(a)); });
}
async function okFact(ctx, p, c) { coOnly(ctx); await db.q(`update hospital_facts set ok=$2 where fact_id=$1`, [String(p.factId || ''), p.ok !== false], c); return { ok: true }; }
async function doneVerify(ctx, p, c) { coOnly(ctx); await db.q(`update hospital_verify set done=$2 where verify_id=$1`, [String(p.verifyId || ''), p.done !== false], c); return { ok: true }; }
async function saveFact(ctx, p, c) {
  coOnly(ctx);
  const detail = clean(p.detail, 2000).trim(); must(detail, 'Write the fact');
  if (p.factId) { const r = await db.update('hospital_facts', { fact_id: String(p.factId) }, { detail, topic: clean(p.topic, 120), category: clean(p.category, 60), source_url: clean(p.source_url, 400), flag: clean(p.flag, 400), ok: !clean(p.flag, 400) }, c); must(r.length, 'Not found'); return { fact: r[0] }; }
  const hospital = clean(p.hospital, 200).trim(); must(hospital, 'Which hospital?');
  const row = await db.insert('hospital_facts', { fact_id: id(), hospital, state: clean(p.state, 4), category: clean(p.category, 60) || 'Navigation', topic: clean(p.topic, 120), detail, source_url: clean(p.source_url, 400), source_type: 'Coordinator', access_date: new Date().toISOString().slice(0, 10), flag: clean(p.flag, 400), ok: true }, c);
  return { fact: row };
}
async function removeFact(ctx, p, c) { coOnly(ctx); await db.q(`delete from hospital_facts where fact_id=$1`, [String(p.factId || '')], c); return { ok: true }; }
async function hospitalStats() {
  return db.all(`select w.walk_id, w.name, w.city, w.state, (select count(*)::int from hospital_facts f where f.hospital=w.name) facts, (select count(*)::int from hospital_facts f where f.hospital=w.name and f.flag<>'' and not f.ok) flagged, (select count(*)::int from hospital_verify v where v.hospital=w.name and not v.done) verify from hospital_walks w order by w.name`);
}

module.exports = { okFact, doneVerify, saveFact, removeFact };
Object.defineProperty(module.exports, 'seed', { value: seed, enumerable: false });
Object.defineProperty(module.exports, 'factsFor', { value: factsFor, enumerable: false });
Object.defineProperty(module.exports, 'outsideFor', { value: outsideFor, enumerable: false });
Object.defineProperty(module.exports, 'hospitalStats', { value: hospitalStats, enumerable: false });
