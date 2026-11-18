// server/src/db.js sets `dateStrings: true` on the MySQL pool, so DATETIME columns come
// back as raw "YYYY-MM-DD HH:MM:SS" strings with no 'Z'/offset marker. `new Date(thatString)`
// parses a marker-less string as the BROWSER's local time, so a UTC value renders as its own
// UTC numbers -- 8 hours behind for a Philippines user. That breaks display, not just math:
// round-tripping preserves the numbers, and those numbers are UTC, not the reader's clock.
//
// USE THIS ONLY FOR TIMESTAMPS THIS APPLICATION WROTE. The database holds two conventions:
//
//   - App-written (MySQL NOW() / new Date(), and the database runs on UTC): tickets,
//     ticket_messages, notifications, non_standard_job_orders. These are UTC -> parseUtc.
//   - Imported from the live legacy system, written verbatim: job_orders and the rest of the
//     migrated transaction chain. These are already Manila wall-clock -> plain `new Date`.
//     Measured, not assumed: job_orders.created_at clusters 100% inside 08:00-18:00 (working
//     hours read literally), while tickets.created_at clusters 100% inside 00:00-10:00, which
//     is those same working hours in UTC.
//
// Applying parseUtc to imported rows shifts them 8 hours the wrong way, so check which kind a
// column holds before reaching for it. audit_logs.set_at is mixed by era (July 2026 imported,
// August 2026 onward app-written) and is deliberately left alone.
//
// Also use this wherever a DB timestamp is diffed against a real `Date.now()` -- e.g. a live
// countdown, which otherwise inflates by exactly the timezone offset.
export function parseUtc(v) {
  if (!v) return null;
  return new Date(`${String(v).replace(' ', 'T')}Z`);
}
