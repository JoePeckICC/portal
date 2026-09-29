'use strict';
// The Circle, grown up (2026-09-27): the surgery-day tracker, a shareable link with no sign-in, reactions and
// comments under updates (the coordinator moderates), photos on updates (approved before the Circle sees them,
// sensitive ones behind a tap), a block list, "ways to help", the patient's "what I need" note, and a delegate
// who can act for the patient.
const C = require('../config');
const db = require('../db');
const core = require('../core');
const mail = require('../mail');
const auth = require('../auth');
const storage = require('../storage');
const { id, must, clean, isTrue, normEmail, first, famName } = require('../util');

// Where things are: from getting ready at home to home again (Joe 2026-09-29: check-in is too late a start).
const TRACKER = ['Getting ready', 'On the way', 'In pre-op', 'In surgery', 'In recovery', 'In a room', 'Home'];
const REACTIONS = ['Praying for you', 'With you', 'Sending love', 'Grateful for the update', 'Peace'];
const coOnly = ctx => must(ctx.role === 'coordinator', 'Not allowed');
const needFamily = ctx => must(ctx.clientId, 'Pick a family first');
// The patient, the coordinator, or a family member the patient named as delegate.
const canAct = ctx => ctx.role === 'coordinator' || ctx.role === 'client' || (ctx.role === 'family' && ctx.user && ctx.user.extra && isTrue(ctx.user.extra.delegate));
// Who says yes to what the Circle sees: the patient, or the delegate they named (Joe 2026-09-29: "I'm the approving
// authority on what's posted and what's commented; the coordinator is the moderator"). The coordinator can take
// things down, never put them up.
const approver = ctx => ctx.role === 'client' || (ctx.role === 'family' && ctx.user && ctx.user.extra && isTrue(ctx.user.extra.delegate));
async function approversOf(clientId) { return db.all(`select email, name from users where client_id=$1 and active and (lower(role)='client' or (lower(role)='family' and (extra->>'delegate')='true'))`, [clientId]); }
const actOrFam = ctx => must(core.fam(ctx) || ctx.role === 'coordinator', 'Not allowed');
const extraOf = c => (c.extra && typeof c.extra === 'object' ? c.extra : {});
async function patchExtra(client, patch, c) { await db.q(`update clients set extra=$2 where client_id=$1`, [client.client_id, JSON.stringify({ ...extraOf(client), ...patch })], c); }

// ---- the tracker: checked in → pre-op → surgery → recovery → a room → home. Each step posts an update.
async function setTracker(ctx, p, c) {
  must(canAct(ctx), 'Only the patient, a delegate, or the coordinator can move this'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const stage = String(p.stage || '');
  must(stage === '' || TRACKER.indexOf(stage) >= 0, 'Not a tracker step');
  await patchExtra(client, { tracker: stage ? { stage, at: new Date().toISOString(), by: ctx.email } : null }, c);
  if (!stage) return { ok: true };
  await require('./learn').fromTracker(ctx.clientId, stage, ctx.email, c);
  const want = isTrue(client.circle_enabled), visible = want && approver(ctx);
  const u = await db.insert('updates', { update_id: id(), client_id: ctx.clientId, posted_by: ctx.email, stage: client.current_stage || '', title: stage + '.', body: clean(p.note, 600), visible_to_circle: visible, kind: 'Clinical', detail: '', quote: '', quote_ref: '', extra: JSON.stringify(want && !visible ? { pending_share: true, step: stage } : { step: stage }) }, c);
  const after = async () => {
    if (!visible) return;
    for (const s of await db.all(`select supporter_email from circle where client_id=$1 and status='Active'`, [ctx.clientId]))
      await mail.notify(s.supporter_email, first(client.patient_first_name) + ': ' + stage, stage + '.', clean(p.note, 600), 'Follow along');
  };
  return { update: u, _after: after };
}

// ---- the shareable link. On: anyone holding the link sees the shared updates, no sign-in. Off: the link dies.
async function setShare(ctx, p, c) {
  must(canAct(ctx), 'Only the patient, a delegate, or the coordinator can change this'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  const on = isTrue(p.on);
  const token = on ? (extraOf(client).share_token || require('crypto').randomBytes(18).toString('base64url')) : '';
  await patchExtra(client, { share_token: token, share_off_at: on ? null : new Date().toISOString() }, c);
  return { share_token: token };
}
async function clientByShare(token) {
  if (!token || String(token).length < 10) return null;
  return db.one(`select * from clients where extra->>'share_token' = $1 and status <> 'Archived'`, [String(token)]);
}

// ---- reactions and comments
async function commentsFor(clientId, forPublic) {
  const rows = await db.all(`select * from update_comments where client_id=$1 ${forPublic ? "and status='Approved'" : ''} order by at`, [clientId]);
  return rows.map(r => ({ comment_id: r.comment_id, update_id: r.update_id, author: r.author, body: r.body, status: r.status, at: r.at, role: r.by_role }));
}
async function reactionsFor(clientId) {
  return db.all(`select r.update_id, r.kind, count(*)::int n from update_reactions r join updates u on u.update_id=r.update_id where u.client_id=$1 group by r.update_id, r.kind`, [clientId]);
}
async function react(ctx, p, c) {
  needFamily(ctx);
  const kind = String(p.kind || ''); must(REACTIONS.indexOf(kind) >= 0, 'Not a reaction');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2`, [String(p.updateId || ''), ctx.clientId], c); must(u, 'Not found');
  if (ctx.role === 'supporter') must(isTrue(u.visible_to_circle), 'Not found');
  if (isTrue(p.off)) await db.q(`delete from update_reactions where update_id=$1 and who=$2 and kind=$3`, [u.update_id, ctx.email, kind], c);
  // One reaction per person, like Facebook: a new one replaces the old.
  else { await db.q(`delete from update_reactions where update_id=$1 and who=$2`, [u.update_id, ctx.email], c); await db.q(`insert into update_reactions (update_id, who, kind) values ($1,$2,$3) on conflict do nothing`, [u.update_id, ctx.email, kind], c); }
  return { ok: true };
}
async function comment(ctx, p, c) {
  needFamily(ctx);
  if (ctx.role === 'supporter') { const cl = await core.clientById(ctx.clientId, c); must(!isTrue(extraOf(cl).comments_off), 'Comments are off for now.'); }
  const body = clean(p.body, 2000).trim(); must(body, 'Write something');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2`, [String(p.updateId || ''), ctx.clientId], c); must(u, 'Not found');
  if (ctx.role === 'supporter') must(isTrue(u.visible_to_circle), 'Not found');
  const status = ctx.role === 'supporter' ? 'Pending' : 'Approved';   // the coordinator moderates what the Circle writes
  const row = await db.insert('update_comments', { comment_id: id(), update_id: u.update_id, client_id: ctx.clientId, author: clean(ctx.user.name || ctx.email, 120), email: ctx.email, body, status, by_role: ctx.role }, c);
  const after = status === 'Pending' ? async () => { const cl = await core.clientById(ctx.clientId); await core.notifyCo(await core.coordinatorFor(cl), 'comment', 'A comment to approve, ' + (cl.family_name || ''), (ctx.user.name || ctx.email) + ' wrote under “' + u.title + '”', body.slice(0, 300), 'Open the Circle'); } : null;
  return { comment: row, _after: after };
}
async function moderateComment(ctx, p, c) {
  // The coordinator approves what the Circle writes (Joe 2026-09-29); families do not moderate comments.
  needFamily(ctx); must(ctx.role === 'coordinator', 'Your coordinator approves comments');
  const status = String(p.status || ''); must(['Approved', 'Hidden', 'Pending'].indexOf(status) >= 0, 'Bad status');
  const r = await db.update('update_comments', { client_id: ctx.clientId, comment_id: String(p.commentId || '') }, { status }, c); must(r.length, 'Not found');
  return { ok: true };
}

// ---- photos on updates: the coordinator approves before the Circle sees one; sensitive ones sit behind a tap.
async function approvePhoto(ctx, p, c) {
  needFamily(ctx); must(approver(ctx) || ctx.role === 'coordinator', 'Not allowed');
  if (!approver(ctx)) must((p.ok === undefined || !isTrue(p.ok)) && (p.sensitive === undefined || isTrue(p.sensitive)), 'Only the patient approves what the Circle sees. You can take it down.');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2`, [String(p.updateId || ''), ctx.clientId], c); must(u, 'Not found');
  const extra = { ...(u.extra || {}) }; must(extra.photo, 'No photo on this update');
  if (p.ok !== undefined) extra.photo_ok = isTrue(p.ok);
  if (p.sensitive !== undefined) extra.sensitive = isTrue(p.sensitive);
  await db.q(`update updates set extra=$2 where update_id=$1`, [u.update_id, JSON.stringify(extra)], c);
  return { ok: true };
}
// Can this viewer see the photo on this update? Family and coordinator always (they see "waiting for approval");
// the Circle and the public link only once approved and only on shared updates.
function photoVisible(u, role) {
  const e = u.extra || {}; if (!e.photo) return false;
  if (role === 'coordinator' || role === 'client' || role === 'family') return true;
  if (role === 'public' && !isTrue(e.public)) return false;
  return isTrue(u.visible_to_circle) && isTrue(e.photo_ok);
}

// ---- a post someone else wrote for the Circle waits for the patient's yes. ok=false keeps it private (the coordinator
// can do that too, to take something down).
async function approveUpdate(ctx, p, c) {
  needFamily(ctx);
  const ok = isTrue(p.ok); must(approver(ctx) || (ctx.role === 'coordinator' && !ok), ok ? 'Only the patient says yes to what the Circle sees' : 'Not allowed');
  const client = await core.clientById(ctx.clientId, c);
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2`, [String(p.updateId || ''), ctx.clientId], c); must(u, 'Not found');
  if (ok) must(isTrue(client.circle_enabled), 'The Circle is not on yet');
  const extra = { ...(u.extra || {}), pending_share: false }; if (ok && extra.photo) extra.photo_ok = true;
  const was = isTrue(u.visible_to_circle);
  await db.q(`update updates set visible_to_circle=$2, extra=$3 where update_id=$1`, [u.update_id, ok, JSON.stringify(extra)], c);
  const after = ok && !was ? async () => { for (const s of await db.all(`select supporter_email from circle where client_id=$1 and status='Active'`, [ctx.clientId])) await mail.notify(s.supporter_email, 'An update on ' + first(client.patient_first_name), u.title, u.body, 'Read it'); } : null;
  return { ok: true, _after: after };
}

// ---- public or Circle only, one post at a time (Joe 2026-09-29). Only the patient or their delegate decides; the
// coordinator can take a post off the web.
async function setUpdatePublic(ctx, p, c) {
  needFamily(ctx); const on = isTrue(p.on); must(approver(ctx) || (ctx.role === 'coordinator' && !on), 'Only the patient decides what goes on the web');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2`, [String(p.updateId || ''), ctx.clientId], c); must(u, 'Not found');
  if (on) must(isTrue(u.visible_to_circle), 'Share it with your Circle first');
  await db.q(`update updates set extra = coalesce(extra,'{}'::jsonb) || jsonb_build_object('public', $2::boolean) where update_id=$1`, [u.update_id, on], c);
  return { ok: true };
}

// ---- whether the Circle and the public page can leave a word at all (the patient or delegate decides)
async function setComments(ctx, p, c) {
  needFamily(ctx); must(ctx.role === 'coordinator', 'Your coordinator turns comments on or off');
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { comments_off: !isTrue(p.on) }, c);
  return { ok: true };
}

// ---- block list: never this person, even if someone forwards the link to sign in
async function blockCircle(ctx, p, c) {
  must(canAct(ctx), 'Not allowed'); needFamily(ctx);
  const row = await db.one(`select * from circle where client_id=$1 and circle_id=$2`, [ctx.clientId, String(p.circleId || '')], c); must(row, 'Not found');
  await db.q(`update circle set status='Blocked' where circle_id=$1`, [row.circle_id], c);
  const others = await db.one(`select 1 from circle where lower(supporter_email)=lower($1) and status='Active' and circle_id<>$2`, [row.supporter_email, row.circle_id], c);
  if (!others) await db.q(`update users set active=false where lower(email)=lower($1) and lower(role)='supporter'`, [row.supporter_email], c);
  await db.q(`delete from update_reactions where who=$1 and update_id in (select update_id from updates where client_id=$2)`, [row.supporter_email, ctx.clientId], c);
  await db.q(`update update_comments set status='Hidden' where client_id=$1 and lower(email)=lower($2)`, [ctx.clientId, row.supporter_email], c);
  return { ok: true };
}

// ---- ways to help: the coordinator or family lists concrete things; the Circle claims them
async function addHelp(ctx, p, c) {
  actOrFam(ctx); needFamily(ctx);
  const title = clean(p.title, 160).trim(); must(title, 'Say what would help');
  const row = await db.insert('help_items', { item_id: id(), client_id: ctx.clientId, title, detail: clean(p.detail, 600), when_text: clean(p.when, 120), status: 'Open', claimed_by: '', added_by: ctx.email }, c);
  return { item: row };
}
// Who is with them (Joe 2026-09-29): we never put people with a patient; the family asks its own Circle. A shift
// becomes a "what would help" item everyone following can claim, and whoever claims it fills the slot.
const PARTS = ['morning', 'afternoon', 'evening', 'night'];
async function askShift(ctx, p, c) {
  actOrFam(ctx); needFamily(ctx);
  const day = String(p.day || ''); must(/^\d{4}-\d{2}-\d{2}$/.test(day), 'Pick a day'); must(PARTS.includes(p.part), 'Pick a part of the day');
  must(!(await db.one(`select 1 from help_items where client_id=$1 and cov=$2 and status in ('Open','Claimed')`, [ctx.clientId, day + '|' + p.part], c)), 'The Circle already has this one.');
  const client = await core.clientById(ctx.clientId, c), pf = first(client.patient_first_name) || 'them';
  const when = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ', ' + p.part;
  const row = await db.insert('help_items', { item_id: id(), client_id: ctx.clientId, title: 'Stay with ' + pf, detail: clean(p.note, 600), when_text: when, status: 'Open', claimed_by: '', added_by: ctx.email, cov: day + '|' + p.part }, c);
  const after = async () => {
    const to = new Set();
    const SH = require('./shifts'), al = ((client.extra || {}).shift_allowed || []).map(normEmail);
    for (const s of await db.all(`select supporter_email, relationship from circle where client_id=$1 and status='Active'`, [ctx.clientId])) if (al.includes(normEmail(s.supporter_email)) || /\b(sister|brother|sibling|mom|mother|dad|father|parent|spouse|wife|husband|partner|fianc\w*|grand\w*|son|daughter|child|step\w*)\b/i.test(s.relationship || '')) to.add(normEmail(s.supporter_email));
    for (const u of await db.all(`select email from users where client_id=$1 and active and lower(role)='family'`, [ctx.clientId])) to.add(normEmail(u.email));
    to.delete(normEmail(ctx.email));
    for (const e of to) await mail.notify(e, 'Can you stay with ' + pf + ' ' + when + '?', 'The family is asking the Circle for someone to be with ' + pf + ' ' + when + '.' + (row.detail ? ' ' + row.detail : ''), 'The first person to say yes gets it, and the family sees who.', 'Open the Circle');
  };
  return { item: row, _after: after };
}
// A claimed shift fills (or, when let go, empties) that slot of Who is with.
async function fillShift(row, who, c, email) {
  if (!row.cov) return; const [day, part] = row.cov.split('|');
  if (who) await db.q(`insert into coverage (slot_id, client_id, day, part, kind, who, note, added_by) values ($1,$2,$3,$4,'with',$5,'From the Circle','circle')
    on conflict (client_id, day, part, kind) do update set who=excluded.who, note=excluded.note, added_by=excluded.added_by`, [id(), row.client_id, day, part, who], c);
  if (who && email) await db.q(`update coverage set email=$4 where client_id=$1 and day=$2 and part=$3 and kind='with'`, [row.client_id, day, part, email], c);
  else await db.q(`delete from coverage where client_id=$1 and day=$2 and part=$3 and kind='with' and added_by='circle'`, [row.client_id, day, part], c);
}
async function claimHelp(ctx, p, c) {
  needFamily(ctx);
  const row = await db.one(`select * from help_items where client_id=$1 and item_id=$2`, [ctx.clientId, String(p.itemId || '')], c); must(row, 'Not found');
  if (isTrue(p.release)) { must(row.claimed_by === ctx.email || row.claimed_email === ctx.email || ctx.role === 'coordinator' || core.fam(ctx), 'Not yours'); await fillShift(row, '', c); await db.update('help_items', { item_id: row.item_id }, { status: 'Open', claimed_by: '', claimed_at: null }, c); if (row.job_id) await db.q(`update jobs set status='Open', taken_at=null, extra = extra - 'circle_by' where job_id=$1 and status='Taken' and extra ? 'circle_by'`, [row.job_id], c); return { ok: true }; }
  must(row.status === 'Open', 'Someone already has this one');
  if (row.cov) must(await require('./shifts').allowedIn(ctx, null, c), 'This is for the family’s inner circle.');
  await db.update('help_items', { item_id: row.item_id }, { status: 'Claimed', claimed_by: clean(ctx.user.name || ctx.email, 120), claimed_at: new Date(), claimed_email: ctx.email }, c);
  await fillShift(row, clean(ctx.user.name || ctx.email, 120), c, ctx.email);
  if (row.job_id) must(await require('./jobs').circleTook(row, clean(ctx.user.name || ctx.email, 120), c), 'That one was already taken care of.');   // a casting call: the request is theirs
  const after = async () => { for (const u of await core.usersFor(ctx.clientId, 'client')) await mail.notify(u.email, (ctx.user.name || 'Someone') + ' is taking care of: ' + row.title, (ctx.user.name || ctx.email) + ' claimed “' + row.title + '”' + (row.when_text ? ' (' + row.when_text + ')' : '') + '.', '', 'Open the Circle'); };
  return { ok: true, _after: after };
}
async function setHelpStatus(ctx, p, c) {
  actOrFam(ctx); needFamily(ctx);
  const status = String(p.status || ''); must(['Open', 'Done', 'Removed'].indexOf(status) >= 0, 'Bad status');
  const r = await db.update('help_items', { client_id: ctx.clientId, item_id: String(p.itemId || '') }, { status }, c); must(r.length, 'Not found');
  return { ok: true };
}

// ---- "what this feels like / what I need": written once, shown to the Circle so nobody has to explain it ten times
async function setWhatINeed(ctx, p, c) {
  must(canAct(ctx) || ctx.role === 'family', 'Not allowed'); needFamily(ctx);
  const client = await core.clientById(ctx.clientId, c);
  await patchExtra(client, { what_i_need: clean(p.text, 3000) }, c);
  return { ok: true };
}

// ---- delegate: one family member who can act for the patient when the patient cannot
async function setDelegate(ctx, p, c) {
  must(ctx.role === 'client', 'Only the patient can name who acts for them'); needFamily(ctx);
  const email = normEmail(p.email);
  const u = await db.one(`select * from users where lower(email)=$1 and client_id=$2 and lower(role)='family' and active`, [email, ctx.clientId], c); must(u, 'That person is not on the inner circle');
  const on = isTrue(p.on);
  // The patient plus up to two family members hold the page (Joe 2026-09-29).
  if (on && !isTrue(u.extra && u.extra.delegate)) must((await db.one(`select count(*)::int n from users where client_id=$1 and lower(role)='family' and active and (extra->>'delegate')='true'`, [ctx.clientId], c)).n < 2, 'Two family members already hold the page. Take one off first.');
  await db.q(`update users set extra = coalesce(extra,'{}'::jsonb) || $2::jsonb where lower(email)=$1`, [email, JSON.stringify({ delegate: on })], c);
  return { ok: true };
}

// ---- the public page (no sign-in): what the family chose to share, read through the link
async function publicPage(p, req) {
  const client = await clientByShare(p.token); must(client, 'This link is not active.');
  const updates = await db.all(`select * from updates where client_id=$1 and visible_to_circle and (extra->>'public')='true' order by posted_at desc`, [client.client_id]);   // the web sees only posts marked public
  const e = extraOf(client);
  const tok = require('crypto').createHash('sha256').update(String(p.token)).digest('hex').slice(0, 24);
  return {
    patient: first(client.patient_first_name) || famName(client.family_name), family: famName(client.family_name), stage: client.current_stage || '', surgery_date: client.surgery_date || '',
    tracker: e.tracker || null, what_i_need: e.what_i_need || '', trackerSteps: TRACKER, reactions: REACTIONS, fund_url: e.fund_url || '', fund_note: e.fund_note || '', theme: e.theme || 'ink', story: e.story && e.story.shared ? { title: e.story.title, body: e.story.body } : null,
    updates: updates.map(u => ({ step: (u.extra && u.extra.step) || '', kinds: (u.extra && Array.isArray(u.extra.kinds)) ? u.extra.kinds : undefined, update_id: u.update_id, posted_at: u.posted_at, title: u.title, body: u.body, kind: u.kind, stage: u.stage, detail: u.detail, quote: u.quote, quote_ref: u.quote_ref,
      photo: photoVisible(u, 'public') ? `${C.API_URL}/files/${u.extra.photo}?p=${encodeURIComponent(p.token)}` : '', sensitive: !!(u.extra && u.extra.sensitive) })),
    comments: await commentsFor(client.client_id, true), reactionCounts: await reactionsFor(client.client_id),
    help: await db.all(`select item_id, title, detail, when_text, status, claimed_by from help_items where client_id=$1 and status<>'Removed' and cov='' order by added_at`, [client.client_id]),
    viewer: tok, comments_off: isTrue(e.comments_off),
  };
}
async function publicReact(p, req) {
  const client = await clientByShare(p.token); must(client, 'This link is not active.');
  must((await auth.bump('pub:' + (req && req.ip || ''), 60)) <= 30, 'Slow down a little.');
  const kind = String(p.kind || ''); must(REACTIONS.indexOf(kind) >= 0, 'Not a reaction');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2 and visible_to_circle and (extra->>'public')='true'`, [String(p.updateId || ''), client.client_id]); must(u, 'Not found');
  const who = 'link:' + clean(p.viewer, 64);
  if (isTrue(p.off)) await db.q(`delete from update_reactions where update_id=$1 and who=$2 and kind=$3`, [u.update_id, who, kind]);
  else { await db.q(`delete from update_reactions where update_id=$1 and who=$2`, [u.update_id, who]); await db.q(`insert into update_reactions (update_id, who, kind) values ($1,$2,$3) on conflict do nothing`, [u.update_id, who, kind]); }
  return { ok: true };
}
async function publicComment(p, req) {
  const client = await clientByShare(p.token); must(client, 'This link is not active.');
  must((await auth.bump('pubc:' + (req && req.ip || ''), 600)) <= 10, 'Slow down a little.');
  must(!isTrue(extraOf(client).comments_off), 'Comments are off for now.');
  const name = clean(p.name, 80).trim(), body = clean(p.body, 2000).trim(); must(name && body, 'Your name and a few words');
  must(!/\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,16}\b/.test(body), 'That looks like a number that should not be posted here.');
  const u = await db.one(`select * from updates where update_id=$1 and client_id=$2 and visible_to_circle and (extra->>'public')='true'`, [String(p.updateId || ''), client.client_id]); must(u, 'Not found');
  await db.insert('update_comments', { comment_id: id(), update_id: u.update_id, client_id: client.client_id, author: name, email: '', body, status: 'Pending', by_role: 'link' });
  await core.notifyCo(await core.coordinatorFor(client), 'comment', 'A comment to approve, ' + (client.family_name || ''), name + ' wrote under “' + u.title + '”', body.slice(0, 300), 'Open the Circle');
  return { ok: true, pending: true };
}
async function publicClaim(p, req) {
  const client = await clientByShare(p.token); must(client, 'This link is not active.');
  must((await auth.bump('pubh:' + (req && req.ip || ''), 600)) <= 10, 'Slow down a little.');
  const name = clean(p.name, 80).trim(); must(name, 'Your name, so the family knows who');
  const row = await db.one(`select * from help_items where client_id=$1 and item_id=$2 and status='Open' and cov=''`, [client.client_id, String(p.itemId || '')]); must(row, 'Someone already has this one');
  await db.update('help_items', { item_id: row.item_id }, { status: 'Claimed', claimed_by: name, claimed_at: new Date(), claimed_email: '' });
  await fillShift(row, name);
  for (const u of await core.usersFor(client.client_id, 'client')) await mail.notify(u.email, name + ' is taking care of: ' + row.title, name + ' claimed “' + row.title + '”' + (row.when_text ? ' (' + row.when_text + ')' : '') + '.', '', 'Open the Circle');
  return { ok: true };
}

module.exports = { askShift, setComments, setUpdatePublic, approver, approversOf, approveUpdate, TRACKER, REACTIONS, setTracker, setShare, clientByShare, react, comment, moderateComment, approvePhoto, photoVisible, blockCircle, addHelp, claimHelp, setHelpStatus, setWhatINeed, setDelegate, publicPage, publicReact, publicComment, publicClaim, commentsFor, reactionsFor, canAct };
