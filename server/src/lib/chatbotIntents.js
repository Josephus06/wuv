const { runSqlFallback } = require('./sqlFallback');
const { answerUnitConversion } = require('./unitConversion');
const { answerCountQuestion } = require('./chatbotCounts');
const pool = require('../db');

// Job-order artist lookups are a common, exact question with a stable relationship
// (job_orders.artist_id -> employees.id). Do this deterministically for admins instead
// of asking the SQL fallback model to infer the join, which can produce a plausible but
// incorrect employee when unrelated numeric ids happen to match.
function extractJobOrderForArtistLookup(message) {
  const match = String(message).match(/\bartist\b[\s\S]{0,100}\b(JO-\d+(?:-\d+)+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractSupervisorLookupName(message) {
  const text = String(message);
  const patterns = [
    /\b(?:who\s+is|who's|what\s+is)\s+the\s+supervisor\s+of\s+(.+?)\b/i,
    /\b(?:supervisor\s+of|supervisor\s+for)\s+(.+?)\b/i,
    /\b(?:who\s+is|who's|what\s+is)\s+(.+?)\s*(?:'s)?\s+supervisor\b/i,
  ];

  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

// Hardcoded easter-egg answer: any relationship question about Josephus Abatayo (e.g. "kinsa
// uyab ni josephus abatayo?", "who is the girlfriend of josephus abatayo?", "how is angeline
// betonta related to josephus abatayo?") resolves to a fixed answer, never the SQL/LLM path.
// Fires when the message mentions Josephus (Abatayo) and either asks a relationship question
// OR already names Angeline (Betonta) -- so it only ever circulates these two names.
function answerJosephusRelationship(message) {
  const text = String(message).toLowerCase();
  const mentionsJosephus = /\bjosephus\b/.test(text) || /\babatayo\b/.test(text);
  if (!mentionsJosephus) return null;
  const mentionsAngeline = /\bangeline\b/.test(text) || /\bbetonta\b/.test(text);
  // Relationship cues in English + Cebuano/Bisaya (uyab = partner, gf = girlfriend).
  const relationshipCue = /\b(uyab|girlfriend|gf|partner|boyfriend|bf|relate[d]?|relationship|dating|love\s*life|asawa|bana|spouse|wife|husband)\b/.test(text);
  if (!mentionsAngeline && !relationshipCue) return null;
  return 'Angeline Betonta is the girlfriend of Josephus Abatayo. 💕';
}

async function isSystemAdmin(userId) {
  const [[user]] = await pool.query('SELECT account_type FROM users WHERE id = ?', [userId]);
  return user?.account_type === 'System Admin';
}

async function answerAdminJobOrderArtist(userId, jobOrderNo) {
  if (!await isSystemAdmin(userId)) return null;

  const [[jobOrder]] = await pool.query(
    `SELECT CONCAT(e.first_name, ' ', e.last_name) AS artist_name
     FROM job_orders jo
     LEFT JOIN employees e ON e.id = jo.artist_id
     WHERE jo.job_order_no = ?
     LIMIT 1`,
    [jobOrderNo]
  );

  if (!jobOrder) return 'No matching records found.';
  if (!jobOrder.artist_name) return `No artist is assigned to job order ${jobOrderNo}.`;
  return `The artist assigned to job order ${jobOrderNo} is ${jobOrder.artist_name}.`;
}

async function answerAdminSupervisorLookup(userId, personName) {
  if (!await isSystemAdmin(userId)) return null;

  const like = `%${personName}%`;
  // A user may report to more than one supervisor, so this reads user_supervisors and lists
  // them all -- users.supervisor_id would answer with only the primary and quietly imply it
  // is the only one.
  const [people] = await pool.query(
    `SELECT u.display_name,
            (SELECT GROUP_CONCAT(s.display_name ORDER BY s.display_name SEPARATOR ', ')
               FROM user_supervisors us JOIN users s ON s.id = us.supervisor_id
              WHERE us.user_id = u.id) AS supervisor_names
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE CONCAT_WS(' ', e.first_name, e.last_name) LIKE ?
        OR u.display_name LIKE ?
        OR u.username LIKE ?
     LIMIT 2`,
    [like, like, like]
  );

  if (people.length === 0) return 'No matching records found.';
  if (people.length > 1) return `I found multiple people matching "${personName}". Please use their full name.`;
  const { display_name: name, supervisor_names: supervisors } = people[0];
  if (!supervisors) return `${name} does not have a supervisor assigned.`;
  const list = supervisors.split(', ');
  if (list.length === 1) return `${name}'s supervisor is ${list[0]}.`;
  return `${name} has ${list.length} supervisors: ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}.`;
}

// Data-Q&A is entirely delegated to sqlFallback.js now -- no hand-built regex/keyword
// intents here. Two reasons that turned out to be the right call rather than growing
// an ever-longer list of question patterns (see git history on this file for the
// earlier version): (1) every new phrasing a user actually typed needed its own patch,
// which doesn't scale, and (2) sqlFallback.js's retrieval-then-answer path for non-admin
// users already reuses the exact same visibility helpers (resolveScope,
// ticketVisibilityClause) the rest of the app trusts, so it isn't a weaker guarantee
// than hand-written scoped queries -- just a lot more general.
async function answerQuestion(user, message, history = []) {
  try {
    const relationshipAnswer = answerJosephusRelationship(message);
    if (relationshipAnswer) return relationshipAnswer;

    // Ahead of the model on purpose -- see lib/unitConversion.js. It answers only what it
    // can parse with certainty and returns null otherwise, so nothing else changes.
    const conversion = await answerUnitConversion(message);
    if (conversion) return conversion;

    // "How many estimates today" and its relatives, answered exactly and in a sentence rather
    // than as a result set -- see lib/chatbotCounts.js. It matters more now the answer may be
    // read aloud: "COUNT(*): 14" is fine on screen and meaningless in the ear.
    const counted = await answerCountQuestion(user, message);
    if (counted) return counted;

    const jobOrderNo = extractJobOrderForArtistLookup(message);
    if (jobOrderNo) {
      const answer = await answerAdminJobOrderArtist(user.id, jobOrderNo);
      if (answer) return answer;
    }

    const supervisorName = extractSupervisorLookupName(message);
    if (supervisorName) {
      const answer = await answerAdminSupervisorLookup(user.id, supervisorName);
      if (answer) return answer;
    }

    const answer = await runSqlFallback(user, message, history);
    if (answer) return answer;
  } catch (err) {
    console.error('[chatbot] answerQuestion failed:', err.message);
    return 'Sorry, I ran into a problem looking that up.';
  }
  return "I don't have an answer for that yet. You can also type \"create ticket\" to reach a department.";
}

// Checked by the chatbot route BEFORE intent matching -- "create ticket" always wins
// even if the rest of the message would otherwise read as a data question. This is a
// mode switch (into the ticket-intake flow), not a data answer, so it stays a literal
// trigger phrase rather than something the LLM decides.
function isTicketTrigger(message) {
  return /create ticket/i.test(message);
}

module.exports = { answerQuestion, isTicketTrigger };
