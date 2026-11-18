require('dotenv').config();
const pool = require('../db');
const nodemailer = require('nodemailer');

// Configuration via environment variables
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || (SMTP_USER || 'no-reply@example.com');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

async function sendTicketReminders() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('SMTP configuration missing. Set SMTP_HOST, SMTP_USER and SMTP_PASS in env.');
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const [rows] = await pool.query(
    `SELECT t.id, t.ticket_no, t.subject, t.created_at, t.created_by_user_id,
            u.display_name AS created_by_name,
            d.id AS department_id, d.name AS department_name, d.head_user_id,
            hu.email AS head_email, hu.display_name AS head_name
     FROM tickets t
     JOIN departments d ON d.id = t.department_id
     LEFT JOIN users u ON u.id = t.created_by_user_id
     LEFT JOIN users hu ON hu.id = d.head_user_id
     WHERE DATE(t.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
       -- 'declined' belongs here too: the approver has answered, so nagging the department
       -- about it would be chasing a decision that has already been taken.
       AND t.status NOT IN ('resolved', 'closed', 'declined')
     ORDER BY d.id, t.created_at`);

  if (!rows.length) {
    console.log('No pending tickets from yesterday.');
    return;
  }

  const byDept = {};
  for (const r of rows) {
    const did = r.department_id || 'none';
    if (!byDept[did]) {
      byDept[did] = {
        dept: r.department_name,
        deptId: r.department_id,
        head: { id: r.head_user_id, email: r.head_email, name: r.head_name },
        tickets: [],
      };
    }
    byDept[did].tickets.push(r);
  }

  for (const [did, group] of Object.entries(byDept)) {
    const headEmail = group.head.email;
    if (!headEmail) {
      console.warn(`Skipping department ${group.dept}(${did}) - no head email configured.`);
      continue;
    }

    const subject = `[Tickets] ${group.tickets.length} unresolved ticket(s) from yesterday`;
    const lines = group.tickets.map((t) => `- ${t.ticket_no}: ${t.subject} (created by ${t.created_by_name || 'Unknown'} at ${t.created_at}) - ${CLIENT_URL}/tickets/${t.id}`);
    const htmlLines = lines.map((l) => `<li>${l}</li>`).join('');
    const text = `${subject}\n\n${lines.join('\n')}`;
    const html = `<p>Hi ${group.head.name || 'Department Head'},</p>
      <p>The following ticket(s) were created yesterday and are still unresolved:</p>
      <ul>${htmlLines}</ul>
      <p>Please review and take action as needed.</p>
      <p>Link to tickets: <a href="${CLIENT_URL}/tickets">Tickets</a></p>
      <p>-- System</p>`;

    try {
      const info = await transporter.sendMail({
        from: FROM_EMAIL,
        to: headEmail,
        subject,
        text,
        html,
      });
      console.log(`Sent reminder to ${headEmail} for dept ${group.dept} (${group.tickets.length} tickets). MessageId=${info.messageId}`);
    } catch (err) {
      console.error('Failed to send email to', headEmail, err);
    }

    if (group.head.id) {
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, message, related_type, related_id)
           VALUES (?, 'ticket_unresolved_reminder', ?, ?, 'Department', ?)`,
          [group.head.id, subject, text, group.deptId]
        );
      } catch (err) {
        console.error('Failed to create in-app reminder notification for', group.head.id, err);
      }
    }
  }
}

async function main() {
  await sendTicketReminders();
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Reminder job failed:', err);
    process.exit(1);
  });
}

module.exports = { sendTicketReminders };
