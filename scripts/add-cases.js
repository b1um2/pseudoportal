const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const { many, one, tx, pool } = require('../db');
const { hashPassword } = require('../lib/auth');

const TESTDATA = process.env.TESTDATA_DIR || path.join(__dirname, '..', '..', '..', 'testdata');
const PASSWORD = '1234';

function readCsv(file, options = {}) {
  return parse(fs.readFileSync(file, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    ...options
  });
}

function letterGrade(gpa) {
  const score = Number(gpa) * 25;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function pickSpread(rows, count) {
  if (rows.length <= count) return rows;
  const picked = [];
  for (let i = 0; i < count; i++) {
    const position = Math.floor(((i + 0.5) / count) * (rows.length - 1));
    picked.push(rows[position]);
  }
  return picked;
}

function makeCase(student, index, counters) {
  const types = ['OVERLOAD', 'PREREQ_OVERRIDE', 'SUBSTITUTION', 'LATE_ADD_DROP'];
  const type = types[index % types.length];
  const step = counters[type]++;

  if (type === 'OVERLOAD') {
    const gpa = Number(student.gpa);
    const probation = student.standing === 'probation';
    let requested = gpa >= 3 ? 20 : 19;
    let incompletes = 0;
    if (step % 6 === 3) incompletes = 1;
    if (step % 6 === 4) requested = 22;

    let expected;
    let rule;
    let reason;
    if (requested > 21) {
      expected = 'rejected'; rule = 'Academic Rules I.H.2'; reason = 'Requested credits exceed the 21-credit maximum.';
    } else if (incompletes > 0) {
      expected = 'rejected'; rule = 'Overload form: no incomplete courses'; reason = 'CAPP shows an incomplete course, so the overload condition is not met.';
    } else if (probation) {
      expected = 'rejected'; rule = 'Academic Rules I.H.4'; reason = 'Student is on probation; the maximum is 13 credits.';
    } else if (gpa < 2) {
      expected = 'rejected'; rule = 'Academic Rules I.H.2'; reason = 'GPA is below 2.00.';
    } else if (gpa < 3) {
      expected = 'approved_conditional'; rule = 'Academic Rules I.H.2 (2.0-3.0 petition)'; reason = 'GPA is between 2.00 and 3.00; conditional overload petition.';
    } else {
      expected = 'approved_conditional'; rule = 'Academic Rules I.H.2'; reason = 'GPA is at or above 3.00.';
    }

    return {
      type,
      data: {
        current_credits: 15,
        requested_credits: requested,
        cumulative_gpa: gpa,
        standing: student.standing,
        incompletes,
        term: '2026-Fall',
        reason: 'Need to complete the remaining requirements this year.'
      },
      expected,
      rule,
      reason
    };
  }

  if (type === 'PREREQ_OVERRIDE') {
    const scenarios = [
      { course: 'CSC310', prerequisite: 'CSC245', prerequisite_status: 'completed', prerequisite_grade: 'C', expected: 'approved', rule: 'Registration Rules A.3', reason: 'Prerequisite completed with C.' },
      { course: 'CSC310', prerequisite: 'CSC245', prerequisite_status: 'completed', prerequisite_grade: 'D', expected: 'approved', rule: 'Prerequisite minimum grade D', reason: 'Prerequisite completed with D.' },
      { course: 'CSC490', prerequisite: 'CSC390', prerequisite_status: 'missing', expected: 'rejected', rule: 'Registration Rules A.3', reason: 'Prerequisite has not been completed.' },
      { course: 'CSC310', prerequisite: 'CSC245', prerequisite_status: 'incomplete', expected: 'rejected', rule: 'Registration Rules A.4', reason: 'Incomplete grade in the prerequisite.' },
      { course: 'CSC490', prerequisite: 'CSC390', prerequisite_status: 'in_progress', expected: 'rejected', rule: 'Registration Rules A.3', reason: 'Prerequisite is in progress, not completed.' },
      { course: 'CSC310', prerequisite: 'CSC245', prerequisite_status: 'transfer', prerequisite_grade: 'B', equivalent_course: 'CSC245 at another university', expected: 'approved', rule: 'Transfer credit', reason: 'Equivalent transfer credit is recorded.' }
    ];
    const scenario = scenarios[step % scenarios.length];
    const { expected, rule, reason, ...data } = scenario;
    return { type, data: { ...data, term: '2026-Fall' }, expected, rule, reason };
  }

  if (type === 'SUBSTITUTION') {
    const scenarios = [
      { required_course: 'CSC490', substitute_course: 'CSC399', required_credits: 3, substitute_credits: 3, level_match: true, documented: true, expected: 'approved', rule: 'Academic Rules I.E', reason: 'Credits and level match; syllabus attached.' },
      { required_course: 'CSC490', substitute_course: 'CSC399', required_credits: 3, substitute_credits: 2, level_match: true, documented: true, expected: 'rejected', rule: 'Academic Rules I.E', reason: 'Substitute credits do not match the requirement.' },
      { required_course: 'CSC490', substitute_course: 'CSC399', required_credits: 3, substitute_credits: 3, level_match: false, documented: true, expected: 'rejected', rule: 'Academic Rules I.E', reason: 'Substitute course level does not match.' },
      { required_course: 'CSC490', substitute_course: 'CSC399', required_credits: 3, substitute_credits: 3, level_match: true, documented: false, expected: 'rejected', rule: 'Academic Rules I.E', reason: 'Syllabus is missing, so equivalence cannot be established.' },
      { required_course: 'ARA101', substitute_course: 'ARA102', required_credits: 3, substitute_credits: 3, level_match: true, documented: true, mehe_document: true, expected: 'approved', rule: 'Arabic substitution', reason: 'MEHE permission is attached.' },
      { required_course: 'CSC490', substitute_course: 'CSC399', required_credits: 3, substitute_credits: 3, level_match: true, documented: true, learning_outcomes: false, expected: 'rejected', rule: 'Academic Rules I.E', reason: 'Learning outcomes do not match the required course.' }
    ];
    const scenario = scenarios[step % scenarios.length];
    const { expected, rule, reason, ...data } = scenario;
    return { type, data: { ...data, term: '2026-Fall' }, expected, rule, reason };
  }

  const scenarios = [
    { course: 'CSC326', action: 'add', window_open: true, hold: null, seats: 5, current_credits: 15, requested_credits: 18, expected: 'approved', rule: 'Registration Rules E', reason: 'Window is open; no hold.' },
    { course: 'CSC326', action: 'drop', window_open: false, hold: null, seats: 5, expected: 'rejected', rule: 'Registration Rules E.1', reason: 'The drop/add deadline has passed.' },
    { course: 'CSC326', action: 'add', window_open: true, hold: 'UP', seats: 5, expected: 'rejected', rule: 'Holds table (UP)', reason: 'A UP probation hold blocks registration.' },
    { course: 'CSC326', action: 'add', window_open: false, hold: null, seats: 5, chair_approval: true, expected: 'approved', rule: 'Chair exception', reason: 'Chair approval is recorded.' },
    { course: 'CSC326', action: 'add', window_open: true, hold: null, seats: 0, expected: 'rejected', rule: 'Capacity', reason: 'The section is full.' },
    { course: 'CSC326', action: 'add', window_open: true, hold: null, seats: 5, current_credits: 18, requested_credits: 22, expected: 'rejected', rule: 'Academic Rules I.H.2', reason: 'The request would exceed the credit cap.' }
  ];
  const scenario = scenarios[step % scenarios.length];
  const { expected, rule, reason, ...data } = scenario;
  return { type, data: { ...data, term: '2026-Fall' }, expected, rule, reason };
}

async function main() {
  const existing = await one("SELECT COUNT(*)::int AS n FROM test_cases WHERE case_code = 'C26'");
  if (existing.n > 0) {
    console.log('C26 already exists. Nothing added.');
    return;
  }

  const dropoutFile = path.join(TESTDATA, 'student_records', 'uci_dropout_success', 'data.csv');
  const performanceFile = path.join(TESTDATA, 'student_records', 'uci_higher_ed_performance', 'data.csv');
  if (!fs.existsSync(dropoutFile) || !fs.existsSync(performanceFile)) {
    throw new Error('New UCI datasets are missing from testdata.');
  }

  const dropoutRows = readCsv(dropoutFile, { delimiter: ';' })
    .map((row, index) => {
      const sem1 = Number(row['Curricular units 1st sem (grade)'] || 0);
      const sem2 = Number(row['Curricular units 2nd sem (grade)'] || 0);
      const average = (sem1 + sem2) / 2;
      return {
        row,
        index,
        gpa: Math.max(0, Math.min(4, average / 5)),
        source_record_id: `data.csv#${index + 2}`,
        course: row.Course,
        target: row.Target
      };
    })
    .filter((row) => row.gpa > 0)
    .sort((a, b) => a.gpa - b.gpa);

  const performanceRows = readCsv(performanceFile)
    .map((row) => ({
      row,
      gpa: Math.max(0, Math.min(4, Number(row.GRADE || 0) / 7 * 4)),
      source_record_id: row['STUDENT ID'],
      course: row['COURSE ID']
    }))
    .filter((row) => row.gpa > 0)
    .sort((a, b) => a.gpa - b.gpa);

  const selectedDropout = pickSpread(dropoutRows, 15);
  const selectedPerformance = pickSpread(performanceRows, 10);

  const advisors = await many('SELECT id, user_id FROM advisors ORDER BY id');
  const fallSections = await many(`
    SELECT s.id, c.credits FROM sections s
    JOIN courses c ON c.id = s.course_id
    WHERE s.term = '2026-Fall'
    ORDER BY s.id
  `);
  if (!advisors.length || !fallSections.length) throw new Error('Seed the base database first.');

  const nextSeq = Number((await one('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM students')).next);
  const counters = { OVERLOAD: 0, PREREQ_OVERRIDE: 0, SUBSTITUTION: 0, LATE_ADD_DROP: 0 };
  const created = [];

  await tx(async (client) => {
    const q = (text, params = []) => client.query(text, params);
    const oneRow = async (text, params = []) => (await client.query(text, params)).rows[0];

    async function addStudent(seq, sourceDataset, sourceRecordId, program, campus, gpa) {
      const standing = gpa >= 2 ? 'good' : 'probation';
      const username = `student${seq}`;
      const userRow = await oneRow(
        'INSERT INTO users (username, password_hash, role, display_name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [username, hashPassword(PASSWORD), 'student', `Student ${String(seq).padStart(3, '0')}`, `${username}@example.edu`]
      );
      const studentRow = await oneRow(
        `INSERT INTO students (user_id, student_no, program, catalog_year, campus, advisor_id, cumulative_gpa, standing, source_dataset, source_record_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [userRow.id, `S2026${String(seq).padStart(4, '0')}`, program, '2025-2026', campus, advisors[(seq - 1) % advisors.length].id, Number(gpa.toFixed(2)), standing, sourceDataset, sourceRecordId]
      );
      return { id: studentRow.id, user_id: userRow.id, seq, gpa, standing, program, campus, sourceDataset, sourceRecordId };
    }

    for (const selected of selectedDropout) {
      const seq = nextSeq + created.length;
      const gpa = selected.gpa;
      const student = await addStudent(
        seq,
        'UCI Predict Students Dropout and Academic Success',
        selected.source_record_id,
        Number(selected.course) % 2 ? 'BS Business Administration' : 'BS Computer Science',
        seq % 2 ? 'Beirut' : 'Byblos',
        gpa
      );
      student.target = selected.target;
      created.push(student);
    }

    for (const selected of selectedPerformance) {
      const seq = nextSeq + created.length;
      const gpa = selected.gpa;
      const student = await addStudent(
        seq,
        'UCI Higher Education Students Performance Evaluation',
        selected.source_record_id,
        Number(selected.course) % 2 ? 'BS Business Administration' : 'BS Computer Science',
        seq % 2 ? 'Beirut' : 'Byblos',
        gpa
      );
      created.push(student);
    }

    for (let i = 0; i < created.length; i++) {
      const student = created[i];
      const completed = [];
      for (let j = 0; j < 12; j++) {
        const section = fallSections[(i * 3 + j) % fallSections.length];
        const grade = letterGrade(student.gpa);
        await q(
          'INSERT INTO enrollments (student_id, section_id, term, status, grade, credits) VALUES ($1, $2, $3, $4, $5, $6)',
          [student.id, section.id, '2026-Fall', 'completed', grade, section.credits]
        );
        completed.push({ credits: Number(section.credits), grade });
      }
      for (let j = 0; j < 3; j++) {
        const section = fallSections[(i * 5 + j) % fallSections.length];
        await q(
          'INSERT INTO enrollments (student_id, section_id, term, status, grade, credits) VALUES ($1, $2, $3, $4, $5, $6)',
          [student.id, section.id, '2026-Fall', 'enrolled', null, section.credits]
        );
      }

      const earned = completed.reduce((sum, row) => sum + row.credits, 0);
      const groups = [
        ['MAJOR', 'Major Core', 45],
        ['LAS', 'LAS Core', 30],
        ['FREE', 'Free Electives', 15],
        ['RES', 'Residency', 30]
      ].map(([id, name, required]) => {
        const applied = Math.min(required, Math.round((earned / 120) * required));
        return { id, name, required, applied, status: applied >= required ? 'met' : 'in_progress' };
      });

      const capp = {
        source: `${student.sourceDataset} record ${student.sourceRecordId}`,
        program: student.program,
        catalog_year: '2025-2026',
        total_required: 120,
        total_earned: earned,
        gpa: student.gpa,
        groups,
        courses: completed.slice(-8).map((row) => ({
          code: 'CURRICULAR-UNIT',
          title: 'Completed curricular unit',
          grade: row.grade,
          credits: row.credits,
          status: 'completed'
        }))
      };

      await q(
        `INSERT INTO degree_audits (student_id, catalog_year, program, total_required, total_earned, gpa, data_json, source_dataset)
         VALUES ($1, $2, $3, 120, $4, $5, $6, $7)`,
        [student.id, '2025-2026', student.program, earned, student.gpa, JSON.stringify(capp), student.sourceDataset]
      );

      const scenario = makeCase(student, i, counters);
      const caseCode = `C${String(26 + i).padStart(2, '0')}`;
      const approved = scenario.expected === 'approved' || scenario.expected === 'approved_conditional';
      const status = approved ? 'approved' : 'rejected';
      const decision = approved ? 'accept' : 'reject';
      const advisor = advisors[i % advisors.length];
      const decidedAt = new Date(Date.now() - (i + 1) * 86400000);

      const formRow = await oneRow(
        `INSERT INTO forms (student_id, type, term, status, submitted_at, data_json, assigned_advisor_id, decision, decided_by, decided_at, reason)
         VALUES ($1, $2, $3, $4, NOW() - ($5 || ' days')::interval, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [student.id, scenario.type, '2026-Fall', status, String(i % 5), JSON.stringify(scenario.data), advisor.id, decision, advisor.user_id, decidedAt, scenario.reason]
      );

      await q(
        `INSERT INTO test_cases (form_id, case_code, expected_decision, expected_rule, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [formRow.id, caseCode, approved ? 'approved' : 'rejected', scenario.rule, scenario.reason]
      );

      await q(
        `INSERT INTO decisions (form_id, actor_id, action, reason, agent_recommendation, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [formRow.id, advisor.user_id, decision, scenario.reason, decidedAt]
      );
    }
  });

  const totalStudents = (await one('SELECT COUNT(*)::int AS n FROM students')).n;
  const totalCases = (await one('SELECT COUNT(*)::int AS n FROM test_cases')).n;
  console.log(`Added ${created.length} students and ${created.length} cases.`);
  console.log(`Students: ${totalStudents} | Cases: ${totalCases}`);
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
