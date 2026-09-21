'use strict';
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const { id, must, clean, pick, famName, normEmail, EMAIL_RE, isTrue, first } = require('../util');

// Topics: every conversation has one. Either side can open a topic; presets or a name of their own.
async function newTopic(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  must(ctx.clientId, 'Pick a family first');
  const kind = C.TOPIC_KINDS[p.kind] && p.kind !== 'auto' ? p.kind : 'other';
  const co = await core.coordinatorFor(await core.clientById(ctx.clientId, c), c);
  const title = kind === 'other' ? clean(p.title, 120).trim() : C.TOPIC_KINDS[kind].replace('{CO}', first(co && co.name) || 'your coordinator');
  must(title, 'Give the topic a name');
  const t = await db.insert('topics', { topic_id: id(), client_id: ctx.clientId, title, kind, status: 'Active', created_by: ctx.email }, c);
  return { topic: t };
}

async function sendMessage(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  must(ctx.clientId, 'Pick a family first');
  let body = clean(p.body, 4000); const files = (p.files || []).slice(0, 4);
  must(body.trim() || files.length, 'Write something first');
  const topic = await core.topicById(ctx.clientId, p.topicId, c);
  must(topic, 'Pick a topic first');
  const atts = [];
  if (files.length) {
    const storage = require('../storage');
    for (const f of files) {
      if (!f || !f.b64 || !f.name) continue;
      const bytes = Buffer.from(f.b64, 'base64');
      must(bytes.length <= 10 * 1024 * 1024, 'Keep each file under 10 MB — a photo of each page works well');
      const up = await storage.saveUpload(ctx, { clientId: ctx.clientId, kind: 'Other', name: clean(f.name, 120), mime: f.type || 'application/octet-stream', bytes }, c);
      atts.push({ name: up.name, url: core.fileUrl(ctx, up), id: up.upload_id, type: f.type || '', size: bytes.length });
    }
  }
  const urgent = topic.kind === 'urgent' || !!p.urgent;
  const msg = await db.insert('messages', { message_id: id(), client_id: ctx.clientId, topic_id: topic.topic_id, sender_email: ctx.email, body, read_by_client: ctx.role === 'client', read_by_coordinator: ctx.role === 'coordinator', urgent: !!p.urgent, attachments: JSON.stringify(atts) }, c);
  if (atts.length) body = (body.trim() ? body + '\n\n' : '') + 'Attached: ' + atts.map(a => a.name).join(', ');
  await db.q(`update topics set last_at=now(), status='Active' where topic_id=$1`, [topic.topic_id], c);
  const client = await core.clientById(ctx.clientId, c);
  const after = async () => {
    if (core.fam(ctx)) {
      const co = await core.coordinatorFor(client);
      await core.notifyCo(co, urgent ? 'urgent' : 'message', (urgent ? 'URGENT — ' : '') + topic.title + ' — ' + famName(client.family_name).toLowerCase(), ctx.user.name + ' wrote in "' + topic.title + '":', body, 'Open the portal');
      await core.notifyFamily(ctx.clientId, 'message', topic.title + ' — ' + ctx.user.name + ' wrote', ctx.user.name + ' wrote in "' + topic.title + '":', body, 'Open the portal', ctx.email);
    } else {
      await core.notifyFamily(ctx.clientId, 'message', topic.title + ' — a note from ' + (ctx.user.name || 'your coordinator'), (ctx.user.name || 'Your coordinator') + ' wrote in "' + topic.title + '":', body, 'Open the portal', ctx.email);
    }
  };
  return { message: core.msgPublic(msg, ctx), _after: after };
}

// Opening a topic marks its messages read for whoever opened it.
async function readTopic(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const col = ctx.role === 'client' ? 'read_by_client' : 'read_by_coordinator';
  await db.q(`update messages set ${col}=true where client_id=$1 and topic_id=$2 and ${col}=false`, [ctx.clientId, String(p.topicId || '')], c);
  return {};
}
async function setTopicStatus(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  const topic = await core.topicById(ctx.clientId, p.topicId, c);
  must(topic, 'Not found');
  await db.q(`update topics set status=$2 where topic_id=$1`, [topic.topic_id, p.status === 'Archived' ? 'Archived' : 'Active'], c);
  return {};
}

async function postUpdate(ctx, p, c) {
  must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
  must(ctx.clientId, 'Pick a family first');
  const client = await core.clientById(ctx.clientId, c);
  const title = clean(p.title, 200), body = clean(p.body, 4000);
  must(title.trim(), 'Give it a title');
  const visible = !!p.visible && isTrue(client.circle_enabled);
  const u = await db.insert('updates', { update_id: id(), client_id: ctx.clientId, posted_by: ctx.email, stage: pick(p.stage, C.STAGES, client.current_stage || ''), title, body, visible_to_circle: visible }, c);
  const after = async () => {
    if (!visible) return;
    for (const s of await db.all(`select supporter_email from circle where client_id=$1 and status='Active'`, [ctx.clientId]))
      await mail.notify(s.supporter_email, 'An update on ' + client.patient_first_name, title, body, 'Read it in the portal');
  };
  return { update: u, _after: after };
}

async function addCircle(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Not allowed');
  must(ctx.clientId, 'Pick a family first');
  const client = await core.clientById(ctx.clientId, c);
  must(isTrue(client.circle_enabled), 'The Circle is not turned on for this family yet. That happens once the sharing authorization is signed.');
  const email = normEmail(p.email), name = clean(p.name, 120), rel = clean(p.relationship, 120);
  must(EMAIL_RE.test(email), 'That email does not look right');
  must(name.trim(), 'Add their name');
  const existing = await db.one(`select * from users where email=$1`, [email], c);
  must(!existing || (existing.role === 'supporter' && existing.client_id === ctx.clientId), 'That email is already in use on another account');
  const row = await db.insert('circle', { circle_id: id(), client_id: ctx.clientId, supporter_email: email, supporter_name: name, relationship: rel, added_by: ctx.email, status: 'Active' }, c);
  if (!existing) await db.insert('users', { email, name, role: 'supporter', client_id: ctx.clientId, active: true }, c);
  else if (!existing.active) await db.q(`update users set active=true where email=$1`, [email], c);
  const after = () => mail.notify(email, famName(client.family_name) + ' added you to their Circle', 'You can follow ' + client.patient_first_name + "'s recovery in the " + C.APP_NAME + ' portal. Sign in with this email address.', '', 'Open the portal');
  return { member: row, _after: after };
}
async function removeCircle(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Not allowed');
  const row = await db.one(`select * from circle where client_id=$1 and circle_id=$2`, [ctx.clientId, String(p.circleId || '')], c);
  must(row, 'Not found');
  await db.q(`update circle set status='Removed' where circle_id=$1`, [row.circle_id], c);
  const others = await db.one(`select 1 from circle where client_id=$1 and lower(supporter_email)=lower($2) and circle_id<>$3 and status='Active'`, [ctx.clientId, row.supporter_email, row.circle_id], c);
  if (!others) {
    await db.q(`update users set active=false, session_ver=session_ver+1 where lower(email)=lower($1) and lower(role)='supporter'`, [row.supporter_email], c);
    await db.q(`delete from sessions where lower(email)=lower($1)`, [row.supporter_email], c);
  }
  return {};
}

module.exports = { newTopic, sendMessage, readTopic, setTopicStatus, postUpdate, addCircle, removeCircle };
