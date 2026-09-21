'use strict';
const C = require('../config');
const db = require('../db');
const core = require('../core');
const auth = require('../auth');
const mail = require('../mail');
const intake = require('../intake');
const { must, clean, pick, normEmail, EMAIL_RE, esc, first, famName } = require('../util');

async function saveProfile(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Only the patient can change this');
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  const fields = ['patient_first_name', 'patient_last_name', 'dob', 'phone', 'address', 'emergency_name', 'emergency_relationship', 'emergency_phone'];
  const patch = {};
  fields.forEach(f => { if (p[f] !== undefined) patch[f] = clean(p[f], 240); });
  if (patch.dob !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dob)) patch.dob = null;
  if (p.goes_by !== undefined) patch.extra = JSON.stringify({ ...(cl.extra || {}), goes_by: clean(p.goes_by, 240) });
  must(String(patch.patient_first_name === undefined ? cl.patient_first_name : patch.patient_first_name).trim(), 'First name is needed');
  if (Object.keys(patch).length) await db.update('clients', { client_id: cl.client_id }, patch, c);
  if (p.my_name !== undefined && clean(p.my_name, 120).trim()) await db.q(`update users set name=$2 where email=$1`, [ctx.email, clean(p.my_name, 120).trim()], c);
  return { client: core.publicClient(await core.clientById(ctx.clientId, c)) };
}

// Email is the sign-in, so a change is confirmed from the new address before it takes effect.
async function changeEmail(ctx, p) {
  const newE = normEmail(p.email);
  must(EMAIL_RE.test(newE), 'That email does not look right');
  must(!(await auth.findUser(newE)), 'That email is already in use');
  const tok = auth.makeToken(ctx.email, 'em', 60, ctx.email + '>' + newE);
  await auth.noteNonce(auth.tokNonce(tok), ctx.email, 'em');
  const url = `${C.PORTAL_URL}?e=${encodeURIComponent(tok)}`;
  await mail.sendMail(newE, `${C.APP_NAME}: confirm your new sign-in email`, `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1C2A3A;max-width:520px"><p style="font-size:16px;line-height:1.5">Hi ${esc(first(ctx.user.name))}, you asked to move your ${C.APP_NAME} sign-in from ${esc(ctx.email)} to this address. Confirm it here (the link works for an hour):</p><p><a href="${url}" style="display:inline-block;background:#C09B36;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:3px">Use this email from now on</a></p><p style="font-size:13px;color:#5B6470">If this was not you, ignore this and nothing changes.</p></div>`);
  return { message: 'Check ' + newE + ' for a confirmation link. Nothing changes until you click it.' };
}

// My answers: the editable intake questions. The coordinator gets a note; the plan is re-checked for new drafts.
async function saveAnswers(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Only the patient can change their answers');
  must(ctx.clientId, 'Pick a family first');
  const cur = await intake.readIntake(ctx.clientId, c), spec = intake.intakeSpec(), byId = {};
  spec.steps.forEach(st => st.qs.forEach(q => { byId[q.id] = q; }));
  const ok = {}, changes = [];
  Object.keys(p.answers || {}).forEach(qid => {
    const base = qid.replace(/d$/, '');
    if (!byId[base] || C.FIXED_ANSWERS.indexOf(base) >= 0) return;
    ok[qid] = p.answers[qid];
    const before = (cur.answers[qid] || {}).a || '', after = String((p.answers[qid] || {}).a || '');
    if (byId[qid] && before !== after) changes.push(byId[qid].q.replace(/\{[A-Z_]+\}/g, 'they') + ': "' + (before || '—') + '" → "' + (after || '—') + '"');
  });
  must(Object.keys(ok).length, 'Nothing to change');
  ok._status = { a: 'Updated after submitting' };
  await intake.writeIntake(ctx.clientId, ok, ctx.email, c);
  const client = await core.clientById(ctx.clientId, c), fresh = await intake.readIntake(ctx.clientId, c);
  const made = await intake.seedPlan(ctx.clientId, fresh.answers, client, ctx.email, c);
  let after = null;
  if (changes.length) {
    const co = await core.coordinatorFor(client, c), who = ctx.user.name || 'The family';
    await core.autoMsg(ctx.clientId, who + ' updated an answer: ' + changes.join('; ') + (made ? '. ' + made + ' new draft item' + (made === 1 ? '' : 's') + ' for ' + (co ? first(co.name) : 'the coordinator') + ' to review.' : '.'), c);
    if (ctx.role === 'client') after = () => core.notifyCo(co, 'intake', famName(client.family_name) + ' changed an answer', who + ' changed:', changes.join('\n') + (made ? '\n\n' + made + ' new draft plan item(s) are waiting for your review.' : ''), 'Open the prep sheet');
  }
  return { intake: fresh, client: core.publicClient(await core.clientById(ctx.clientId, c)), drafts: made, _after: after };
}

// Inner circle: family with their own sign-in and the patient's view. Only the patient (or the coordinator) manages the list.
async function addInner(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Only the patient can add to the inner circle');
  must(ctx.clientId, 'Pick a family first');
  const email = normEmail(p.email), name = clean(p.name, 120).trim(), rel = clean(p.relationship, 120).trim();
  must(EMAIL_RE.test(email), 'That email does not look right');
  must(name, 'Add their name');
  const existing = await db.one(`select * from users where email=$1`, [email], c);
  must(!existing || (String(existing.client_id).trim() === ctx.clientId && ['family', 'supporter'].indexOf(String(existing.role).toLowerCase()) >= 0), 'That email is already in use on another account');
  if (existing) await db.update('users', { email }, { role: 'family', name, relationship: rel, active: true }, c);
  else await db.insert('users', { email, name, role: 'family', client_id: ctx.clientId, active: true, relationship: rel }, c);
  const client = await core.clientById(ctx.clientId, c), co = await core.coordinatorFor(client, c);
  const after = () => mail.notify(email, famName(client.family_name) + ' added you to their inner circle', 'You can see ' + (client.patient_first_name || 'their') + "'s plan, messages and appointments in the " + C.APP_NAME + ' portal, and message ' + ((co || {}).name || 'the coordinator') + ' yourself. Sign in with this email address — no password, we send you a link.', '', 'Open the portal');
  return { _after: after };
}
async function removeInner(ctx, p, c) {
  must(ctx.role === 'client' || ctx.role === 'coordinator', 'Only the patient can change the inner circle');
  await db.q(`update users set active=false, session_ver=session_ver+1 where email=$1 and client_id=$2 and lower(role)='family'`, [normEmail(p.email), ctx.clientId], c);
  await db.q(`delete from sessions where email=$1`, [normEmail(p.email)], c);
  return {};
}

// Every signed-in browser for this account goes back to the sign-in screen.
async function signOutEverywhere(ctx, p, c) {
  let target = ctx.email;
  if (ctx.role === 'coordinator' && p.email) { const t = await auth.findUser(normEmail(p.email)); must(t && t.client_id === ctx.clientId, 'Not on this family'); target = t.email; }
  await auth.signOutEverywhere(target);
  return { done: true, self: normEmail(target) === ctx.email };
}
async function savePrefs(ctx, p, c) {
  const patch = {};
  if (p.prefs) { const cur = core.prefs(ctx.user); Object.keys(C.NOTIFY_KINDS).forEach(k => { if (p.prefs[k] !== undefined) cur[k] = !!p.prefs[k]; }); patch.prefs = JSON.stringify(cur); }
  if (p.goes_by !== undefined) patch.goes_by = clean(p.goes_by, 60).trim();
  if (p.avatar !== undefined) patch.avatar = C.AVATARS.indexOf(p.avatar) >= 0 ? p.avatar : '';
  if (Object.keys(patch).length) await db.update('users', { email: ctx.email }, patch, c);
  return {};
}
async function setStage(ctx, p, c) {
  must(ctx.role === 'coordinator', 'Not allowed');
  const cl = await core.clientById(ctx.clientId, c); must(cl, 'Not found');
  await db.q(`update clients set current_stage=$2 where client_id=$1`, [cl.client_id, pick(p.stage, C.STAGES, cl.current_stage)], c);
  return {};
}

module.exports = { saveProfile, changeEmail, saveAnswers, addInner, removeInner, signOutEverywhere, savePrefs, setStage };
