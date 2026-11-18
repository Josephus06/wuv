// Process Location on estimate and job order process lines (2026-11-11): a line's location is the
// one picked on it, else its process's Default Location (Master Lists > Processes). A line with a
// process but neither cannot be saved.

// The location for a line: the one given, else the process's default; null when there is none.
async function lineLocation(conn, processId, locationId) {
  if (locationId) return locationId;
  if (!processId) return null;
  const [[p]] = await conn.query('SELECT default_location_id FROM processes WHERE id = ?', [processId]);
  return p?.default_location_id || null;
}

const MISSING_LOCATION = 'Process Location is required on every process line -- this process has no Default Location, so pick one on the line.';

module.exports = { lineLocation, MISSING_LOCATION };
