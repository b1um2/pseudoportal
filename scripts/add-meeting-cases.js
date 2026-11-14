const fs = require('node:fs');
const path = require('node:path');
const { init, one, many, tx, pool } = require('../db');
const { availableSlots } = require('../lib/schedule');

const DATES = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27'];

const reserved = new Set();

function reserveKey(kind, id, date, time) {
  return `${kind}:${id}:${date}:${time}`;
}

async function findFree(studentId, staffType, staffId, advisorId = null) {
  for (const date of DATES) {
    const slots = await availableSlots({ date, studentId, staffType, staffId, advisorId });
    const free = slots.filter((time) => (
      !reserved.has(reserveKey('student', studentId, date, time))
      && !reserved.has(reserveKey(staffType, staffId, date, time))
      && (!advisorId || !reserved.has(reserveKey('advisor', advisorId, date, time)))
    ));
    if (free.length) {
      const time = free[0];
      reserved.add(reserveKey('student', studentId, date, time));
      reserved.add(reserveKey(staffType, staffId, date, time));
      if (advisorId) reserved.add(reserveKey('advisor', advisorId, date, time));
      return { date, time };
    }
  }
  return null;
}

async function main() {
  await init();
  const existing = await one('SELECT COUNT(*)::int AS n FROM meeting_test_cases');
  if (existing.n > 0) {
    console.log('Meeting test cases already exist. Nothing added.');
    return;
  }

  const students = await many(`
    SELECT s.id, s.student_no, s.advisor_id
    FROM students s ORDER BY s.id
  `);
  const advisors = await many('SELECT id, user_id FROM advisors ORDER BY id');
  const professorRows = await many('SELECT id, user_id FROM professors ORDER BY id');
  if (students.length < 18 || !advisors.length || !professorRows.length) {
    throw new Error('Seed the base students, advisors, and professors first.');
  }

  const advisorById = new Map(advisors.map((row) => [row.id, row]));
  const created = [];

  function nextCode() {
    return `M${String(created.length + 1).padStart(2, '0')}`;
  }

  await tx(async (client) => {
    const q = (text, params = []) => client.query(text, params);
    const oneRow = async (text, params = []) => (await client.query(text, params)).rows[0];

    async function insertCase({ student, staffType, staffId, date, time, expected, reason }) {
      const start = new Date(`${date}T${time}:00Z`);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const advisorId = staffType === 'advisor' ? staffId : student.advisor_id;
      const professorId = staffType === 'professor' ? staffId : null;
      const advisorUser = advisorById.get(advisorId)?.user_id || advisors[0].user_id;
      const code = nextCode();

      const row = await oneRow(`
        INSERT INTO appointments (
          student_id, advisor_id, professor_id, meeting_type, requested_by,
          status, preferred_date, preferred_time, start_at, end_at, scheduled_by, reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        student.id,
        advisorId,
        professorId,
        staffType,
        staffType === 'advisor' ? 'student' : 'advisor',
        expected === 'scheduled' ? 'scheduled' : 'rejected',
        date,
        time,
        expected === 'scheduled' ? start.toISOString() : null,
        expected === 'scheduled' ? end.toISOString() : null,
        advisorUser,
        reason
      ]);

      const rule = staffType === 'advisor'
        ? 'Student and advisor availability'
        : 'Student, professor, and advisor availability';
      await q(`
        INSERT INTO meeting_test_cases (appointment_id, case_code, expected_decision, expected_rule, notes)
        VALUES ($1, $2, $3, $4, $5)
      `, [row.id, code, expected, rule, reason]);

      created.push({
        case_code: code,
        appointment_id: row.id,
        student_no: student.student_no,
        meeting_type: staffType,
        preferred_date: date,
        preferred_time: time,
        expected_decision: expected,
        expected_rule: rule,
        expected_reason: reason
      });
    }

    for (let i = 0; i < 12; i++) {
      const student = students[i];
      const advisorId = student.advisor_id || advisors[0].id;
      const slot = await findFree(student.id, 'advisor', advisorId);
      if (!slot) throw new Error('No free advisor slot for meeting case.');
      await insertCase({
        student, staffType: 'advisor', staffId: advisorId,
        date: slot.date, time: slot.time,
        expected: 'scheduled',
        reason: 'Student requested a planning meeting.'
      });
    }

    for (let i = 0; i < 6; i++) {
      const student = students[12 + i];
      const advisorId = student.advisor_id || advisors[0].id;
      const slot = await findFree(student.id, 'advisor', advisorId);
      if (!slot) throw new Error('No free advisor slot for meeting case.');
      await insertCase({
        student, staffType: 'advisor', staffId: advisorId,
        date: slot.date, time: slot.time,
        expected: 'scheduled',
        reason: 'Student requested a planning meeting.'
      });
    }

    for (let i = 0; i < 6; i++) {
      const student = students[i];
      const professorId = professorRows[0].id;
      const slot = await findFree(student.id, 'professor', professorId, student.advisor_id || advisors[0].id);
      if (!slot) throw new Error('No free professor slot for meeting case.');
      await insertCase({
        student, staffType: 'professor', staffId: professorId,
        date: slot.date, time: slot.time,
        expected: 'scheduled',
        reason: 'Advisor requested a student-professor meeting.'
      });
    }
  });

  fs.writeFileSync(
    path.join(__dirname, '..', 'true-meeting-answers.json'),
    JSON.stringify(created, null, 2) + '\n'
  );

  console.log(`Added ${created.length} meeting test cases.`);
  console.log('Wrote true-meeting-answers.json');
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
