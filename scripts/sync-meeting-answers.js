const fs = require('node:fs');
const path = require('node:path');
const { init, many, query, pool } = require('../db');

function datePart(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function timePart(value) {
  return new Date(value).toISOString().slice(11, 16);
}

async function main() {
  await init();
  const rows = await many(`
    SELECT m.case_code, m.appointment_id, m.expected_rule, s.student_no,
           a.meeting_type, a.status, a.start_at, a.agent_reasoning, a.reason
    FROM meeting_test_cases m
    JOIN appointments a ON a.id = m.appointment_id
    JOIN students s ON s.id = a.student_id
    ORDER BY m.case_code
  `);

  if (!rows.length) throw new Error('No meeting test cases found.');

  const answers = rows.map((row) => {
    const scheduled = row.status === 'scheduled' || row.status === 'booked';
    return {
      case_code: row.case_code,
      appointment_id: row.appointment_id,
      student_no: row.student_no,
      meeting_type: row.meeting_type,
      preferred_date: scheduled ? datePart(row.start_at) : null,
      preferred_time: scheduled ? timePart(row.start_at) : null,
      expected_decision: scheduled ? 'scheduled' : 'rejected',
      expected_rule: row.expected_rule || 'Participant availability and model reasoning',
      expected_reason: row.agent_reasoning || row.reason || 'No conflict-free time assigned.'
    };
  });

  for (const answer of answers) {
    await query(`
      UPDATE meeting_test_cases
      SET expected_decision = $1, expected_rule = $2, notes = $3
      WHERE case_code = $4
    `, [answer.expected_decision, answer.expected_rule, answer.expected_reason, answer.case_code]);
  }

  fs.writeFileSync(
    path.join(__dirname, '..', 'true-meeting-answers.json'),
    JSON.stringify(answers, null, 2) + '\n'
  );

  console.log(`Synced ${answers.length} meeting answers from the current schedule.`);
  console.log('Wrote true-meeting-answers.json');
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
