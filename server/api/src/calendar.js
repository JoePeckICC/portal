'use strict';
// The coordinator's Google Calendar, through a service account with domain-wide delegation
// (CALENDAR_USER = the coordinator's Workspace address). Free time inside BOOK_HOURS, every day.
const C = require('./config');
const { must, id } = require('./util');
const { localToIso } = require('./time');

async function client() {
  const { google } = require('googleapis');
  const auth = await require('./gauth').authFor(process.env.CALENDAR_USER || '', ['https://www.googleapis.com/auth/calendar']);
  return google.calendar({ version: 'v3', auth });
}
const enabled = () => !!process.env.CALENDAR_USER;

async function busyOn(open, close) {
  if (!enabled()) return [];
  const r = await (await client()).freebusy.query({ requestBody: { timeMin: open.toISOString(), timeMax: close.toISOString(), timeZone: C.TZ, items: [{ id: 'primary' }] } });
  return ((r.data.calendars || {}).primary || {}).busy || [];
}
async function freeSlots(day, minutes) {
  must(/^\d{4}-\d{2}-\d{2}$/.test(String(day)), 'Pick a day');
  const open = new Date(localToIso(day + 'T' + String(C.BOOK_HOURS.from).padStart(2, '0') + ':00')), close = new Date(localToIso(day + 'T' + String(C.BOOK_HOURS.to).padStart(2, '0') + ':00'));
  const now = Date.now(), earliest = now + C.BOOK_LEAD_HOURS * 3600000, latest = now + C.BOOK_DAYS_AHEAD * 86400000;
  const busy = (await busyOn(open, close)).map(b => [new Date(b.start).getTime(), new Date(b.end).getTime()]);
  const out = [];
  for (let t = open.getTime(); t + minutes * 60000 <= close.getTime(); t += 30 * 60000) {
    if (t < earliest || t > latest) continue;
    const s = t, e = t + minutes * 60000;
    if (!busy.some(b => s < b[1] && e > b[0])) out.push(new Date(t));
  }
  return out;
}
// Creates the event with the family as guests; returns { id, link } (a Meet link for video calls).
async function createEvent({ title, start, end, guests, description, location, video }) {
  if (!enabled()) return { id: '', link: '' };
  const body = { summary: title, description, location, visibility: 'private', start: { dateTime: start.toISOString(), timeZone: C.TZ }, end: { dateTime: end.toISOString(), timeZone: C.TZ }, attendees: guests.map(email => ({ email })) };   // Private: family detail stays off the shared domain calendar (HIPAA)
  if (video) body.conferenceData = { createRequest: { requestId: id(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  const r = await (await client()).events.insert({ calendarId: 'primary', sendUpdates: 'all', conferenceDataVersion: video ? 1 : 0, requestBody: body });
  return { id: r.data.id || '', link: r.data.hangoutLink || '' };
}
async function deleteEvent(eventId) {
  if (!enabled() || !eventId) return;
  await (await client()).events.delete({ calendarId: 'primary', eventId: String(eventId).split('@')[0], sendUpdates: 'all' });
}
module.exports = { freeSlots, createEvent, deleteEvent, enabled };
