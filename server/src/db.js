const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gsuite_erp',
  waitForConnections: true,
  // 10 was the whole company's share (2026-10-29: lag with many tabs open) -- every tab's polling and
  // every report queued behind a few slow queries. DB_POOL_SIZE overrides; MySQL allows 151 by default.
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 25,
  decimalNumbers: true,
  // Without this, mysql2 returns DATE/DATETIME columns as JS Date objects parsed in the
  // server's local timezone; res.json() then serializes them via toISOString() (UTC),
  // which silently shifts DATE values back a day in any timezone ahead of UTC (e.g.
  // 2026-08-01 local midnight -> "2026-07-31T16:00:00.000Z" at UTC+8). Every route
  // already treats date/datetime fields as strings (String(x).slice(0, 10)), so
  // returning them as raw strings instead of Date objects is a pure bug fix.
  dateStrings: true,
});

// Every session in UTC, whatever the MySQL server's own clock says. The droplet's MySQL runs on
// UTC but the office's runs on Philippine time, so NOW() / CURRENT_TIMESTAMP stamped office-made
// records 8 hours ahead of the droplet's -- and the dashboard read them as created in the future
// ("-468m ago", 2026-10-05). The two replicate into one dataset, so they must write one clock.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

module.exports = pool;
