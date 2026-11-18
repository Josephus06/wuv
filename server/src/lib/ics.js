// A single-event iCalendar invite (RFC 5545), for emailing a CRM visit or meeting to a customer
// contact so it lands in their Google/Outlook calendar.
//
// crm_activities.starts_at is the wall-clock time the rep typed, with no zone. The installs do not
// share a server timezone (Railway runs UTC), so the conversion uses the business's offset, not the
// process's: CRM_UTC_OFFSET_MINUTES, default +480 (Philippine time, which has no DST).
const OFFSET_MIN = Number(process.env.CRM_UTC_OFFSET_MINUTES || 480);

function wallClockToUtc(wallClock) {
  const [date, time = '00:00:00'] = String(wallClock).replace('T', ' ').split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s = 0] = time.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - OFFSET_MIN * 60000);
}

// 20261002T063000Z
function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Commas, semicolons and backslashes are structural in iCalendar text; newlines become \n.
function esc(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Lines over 75 octets must be folded (continuation lines start with a space).
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

function buildInvite({ uid, startsAt, endsAt, summary, description, location, organizerName, organizerEmail, attendeeName, attendeeEmail, sequence = 0 }) {
  const start = wallClockToUtc(startsAt);
  // No end given: an hour, which is what a calendar would assume for a meeting anyway.
  const end = endsAt ? wallClockToUtc(endsAt) : new Date(start.getTime() + 3600000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ERP//CRM//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(summary)}`,
    description ? `DESCRIPTION:${esc(description)}` : null,
    location ? `LOCATION:${esc(location)}` : null,
    organizerEmail ? `ORGANIZER;CN=${esc(organizerName)}:mailto:${organizerEmail}` : null,
    attendeeEmail ? `ATTENDEE;CN=${esc(attendeeName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail}` : null,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { buildInvite, wallClockToUtc };
