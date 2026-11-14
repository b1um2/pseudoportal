const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const { reset, tx } = require('./db');
const { hashPassword } = require('./lib/auth');

const TESTDATA = process.env.TESTDATA_DIR || path.join(__dirname, '..', '..', 'testdata');
const PASSWORD = '1234';

function readCsv(file, options = {}) {
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    ...options
  });
}

function letterGrade(score) {
  if (score == null) return 'B';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

async function main() {
  await reset();

  const advisorNames = ['John Doe', 'Jane Smith', 'Alex Johnson'];
  const professorNames = ['Prof. John Doe', 'Prof. Jane Smith', 'Prof. Alex Johnson', 'Prof. Sam Lee'];

  const catalog = [
    ['CSC101', 'Introduction to Programming', 3, 'Computer Science'],
    ['CSC210', 'Data Structures', 3, 'Computer Science'],
    ['CSC310', 'Operating Systems', 3, 'Computer Science'],
    ['CSC326', 'Database Systems', 3, 'Computer Science'],
    ['MTH201', 'Calculus III', 3, 'Mathematics'],
    ['ENG101', 'Academic English I', 3, 'English'],
    ['BUS210', 'Principles of Management', 3, 'Business'],
    ['ACC201', 'Financial Accounting', 3, 'Business'],
    ['ECO201', 'Microeconomics', 3, 'Business'],
    ['LAS101', 'Liberal Arts Seminar', 3, 'LAS'],
    ['PHY101', 'General Physics', 4, 'Physics'],
    ['BIO101', 'General Biology', 4, 'Biology']
  ];

  const formTemplates = [
    {
      type: 'OVERLOAD',
      name: 'Course Overload Petition',
      source_url: 'https://www.simmons.edu/sites/default/files/2023-11/Registrar_Petition-for-Course-Overload.pdf',
      fields: { student_name: 'text', student_id: 'text', credits_requested: 'number', reason: 'text', advisor_signature: 'signature' }
    },
    {
      type: 'CHANGE_OF_MAJOR',
      name: 'Change of Major Form',
      source_url: 'https://www.mga.edu/registrar/docs/Change_of_Major_Form.pdf',
      fields: { student_name: 'text', student_id: 'text', current_major: 'text', new_major: 'text', reason: 'text', advisor_signature: 'signature' }
    },
    {
      type: 'SUBSTITUTION',
      name: 'Course Substitution Petition',
      source_url: 'https://www.shoreline.edu/apply-and-aid/registration/documents/course-substitution.pdf',
      fields: { student_name: 'text', student_id: 'text', required_course: 'text', substitute_course: 'text', reason: 'text', chair_signature: 'signature' }
    },
    {
      type: 'PREREQ_OVERRIDE',
      name: 'Prerequisite Waiver',
      source_url: 'https://www.csusm.edu/enroll/forms/forms/prereqwaiver.pdf',
      fields: { student_name: 'text', student_id: 'text', course: 'text', prerequisite: 'text', equivalent_course: 'text', reason: 'text' }
    },
    {
      type: 'LATE_ADD_DROP',
      name: 'Drop/Add Form',
      source_url: 'https://www.rochester.edu/registrar/assets/pdf/drop-add-form.pdf',
      fields: { student_name: 'text', student_id: 'text', course: 'text', action: 'add_or_drop', reason: 'text', instructor_signature: 'signature' }
    }
  ];

  await tx(async (client) => {
    const q = (text, params = []) => client.query(text, params);
    const one = async (text, params = []) => (await client.query(text, params)).rows[0];

    async function insertUser(username, role, displayName, email) {
      const passwordHash = hashPassword(PASSWORD);
      const row = await one(
        'INSERT INTO users (username, password_hash, role, display_name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [username, passwordHash, role, displayName, email]
      );
      return row.id;
    }

    const advisors = [];
    for (let i = 0; i < advisorNames.length; i++) {
      const userId = await insertUser(`advisor${i + 1}`, 'advisor', advisorNames[i], `advisor${i + 1}@example.edu`);
      const row = await one('INSERT INTO advisors (user_id, department) VALUES ($1, $2) RETURNING id', [userId, 'Advising']);
      advisors.push(row.id);
    }

    const professors = [];
    for (let i = 0; i < professorNames.length; i++) {
      const userId = await insertUser(`prof${i + 1}`, 'professor', professorNames[i], `prof${i + 1}@example.edu`);
      const row = await one(
        'INSERT INTO professors (user_id, department) VALUES ($1, $2) RETURNING id',
        [userId, i % 2 ? 'Business' : 'Computer Science']
      );
      professors.push(row.id);
    }

    const courseIds = [];
    for (const [code, title, credits, department] of catalog) {
      const row = await one(
        'INSERT INTO courses (code, title, credits, department) VALUES ($1, $2, $3, $4) RETURNING id',
        [code, title, credits, department]
      );
      courseIds.push(row.id);
    }

    const sections = [];
    let crn = 1000;
    for (const term of ['2026-Fall', '2027-Spring']) {
      for (let courseIndex = 0; courseIndex < courseIds.length; courseIndex++) {
        for (let s = 1; s <= 2; s++) {
          crn += 1;
          const professorId = professors[(courseIndex + s) % professors.length];
          const row = await one(
            `INSERT INTO sections (course_id, term, crn, professor_id, campus, capacity, enrolled, schedule)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [courseIds[courseIndex], term, String(crn), professorId, s % 2 ? 'Beirut' : 'Byblos', 30, 12 + ((courseIndex * 3 + s) % 16), `Mon/Wed ${9 + (courseIndex % 4)}:00`]
          );
          sections.push({ id: row.id, term, courseId: courseIds[courseIndex], professorId, courseIndex });
        }
      }
    }
    const fallSections = sections.filter((s) => s.term === '2026-Fall');

    for (const template of formTemplates) {
      await q(
        'INSERT INTO form_templates (type, name, source_url, license, fields_json) VALUES ($1, $2, $3, $4, $5)',
        [template.type, template.name, template.source_url, 'Public web template; used for schema testing only.', JSON.stringify(template.fields)]
      );
    }

    const ouladDir = path.join(TESTDATA, 'student_records', 'oulad');
    const studentInfo = readCsv(path.join(ouladDir, 'studentInfo.csv'));
    const assessmentRows = readCsv(path.join(ouladDir, 'studentAssessment.csv'));
    const scoreMap = new Map();
    for (const row of assessmentRows) {
      if (row.score === '' || row.score == null) continue;
      const key = String(row.id_student);
      const current = scoreMap.get(key) || { sum: 0, count: 0 };
      current.sum += Number(row.score);
      current.count += 1;
      scoreMap.set(key, current);
    }

    const seen = new Set();
    const ouladStudents = [];
    for (const row of studentInfo) {
      if (seen.has(row.id_student)) continue;
      seen.add(row.id_student);
      ouladStudents.push(row);
      if (ouladStudents.length >= 20) break;
    }

    const uciDir = path.join(TESTDATA, 'student_records', 'uci_student_performance');
    const uciAll = readCsv(path.join(uciDir, 'student-por.csv'), { delimiter: ';' });
    const uciSorted = [...uciAll].sort((a, b) => Number(a.G3) - Number(b.G3));
    const uciIndexes = [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => Math.floor((uciSorted.length - 1) * p));
    const uciRows = uciIndexes.map((index) => uciSorted[index]);

    const students = [];
    let studentIndex = 0;

    async function addStudent({ displayName, program, campus, gpa, standing, advisorId, sourceDataset, sourceRecordId, extra }) {
      studentIndex += 1;
      const userId = await insertUser(`student${studentIndex}`, 'student', displayName, `student${studentIndex}@example.edu`);
      const row = await one(
        `INSERT INTO students (user_id, student_no, program, catalog_year, campus, advisor_id, cumulative_gpa, standing, source_dataset, source_record_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [userId, `S2026${String(studentIndex).padStart(4, '0')}`, program, '2025-2026', campus, advisorId, Number(gpa.toFixed(2)), standing, sourceDataset, sourceRecordId]
      );
      students.push({ id: row.id, program, gpa, standing, sourceDataset, sourceRecordId, extra });
    }

    for (let i = 0; i < ouladStudents.length; i++) {
      const row = ouladStudents[i];
      const stats = scoreMap.get(String(row.id_student));
      const average = stats ? stats.sum / stats.count : 72;
      const gpa = Math.max(0, Math.min(4, average / 25));
      await addStudent({
        displayName: `Student ${String(i + 1).padStart(3, '0')}`,
        program: i % 2 === 0 ? 'BS Computer Science' : 'BS Business Administration',
        campus: i % 3 === 0 ? 'Byblos' : 'Beirut',
        gpa,
        standing: gpa >= 2 ? 'good' : 'probation',
        advisorId: advisors[i % advisors.length],
        sourceDataset: 'OULAD',
        sourceRecordId: String(row.id_student),
        extra: { module: row.code_module, presentation: row.code_presentation, final_result: row.final_result }
      });
    }

    for (let i = 0; i < uciRows.length; i++) {
      const row = uciRows[i];
      const gpa = Math.max(0, Math.min(4, Number(row.G3) / 5));
      await addStudent({
        displayName: `Student ${String(20 + i + 1).padStart(3, '0')}`,
        program: i % 2 === 0 ? 'BS Business Administration' : 'BS Computer Science',
        campus: i % 2 === 0 ? 'Beirut' : 'Byblos',
        gpa,
        standing: gpa >= 2 ? 'good' : 'probation',
        advisorId: advisors[(20 + i) % advisors.length],
        sourceDataset: 'UCI Student Performance',
        sourceRecordId: `student-por.csv#${i + 1}`,
        extra: { G1: row.G1, G2: row.G2, G3: row.G3 }
      });
    }

    const groupDefs = [
      ['MAJOR', 'Major Core', 45],
      ['LAS', 'LAS Core', 30],
      ['FREE', 'Free Electives', 15],
      ['RES', 'Residency', 30]
    ];

    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      const completedCount = 12 + (i % 6);
      for (let j = 0; j < completedCount; j++) {
        const section = fallSections[(i * 3 + j) % fallSections.length];
        const course = await one('SELECT * FROM courses WHERE id = $1', [section.courseId]);
        const score = 55 + ((i * 7 + j * 11) % 45);
        await q(
          'INSERT INTO enrollments (student_id, section_id, term, status, grade, credits) VALUES ($1, $2, $3, $4, $5, $6)',
          [student.id, section.id, '2026-Fall', 'completed', letterGrade(score), course.credits]
        );
      }
      for (let j = 0; j < 3; j++) {
        const section = fallSections[(i * 5 + j) % fallSections.length];
        const course = await one('SELECT * FROM courses WHERE id = $1', [section.courseId]);
        await q(
          'INSERT INTO enrollments (student_id, section_id, term, status, grade, credits) VALUES ($1, $2, $3, $4, $5, $6)',
          [student.id, section.id, '2026-Fall', 'enrolled', null, course.credits]
        );
      }

      const completed = await q(
        `SELECT e.*, c.code, c.title FROM enrollments e
         JOIN sections sec ON sec.id = e.section_id
         JOIN courses c ON c.id = sec.course_id
         WHERE e.student_id = $1 AND e.status = 'completed'`,
        [student.id]
      );
      const earned = completed.rows.reduce((sum, row) => sum + Number(row.credits), 0);
      const groups = groupDefs.map(([id, name, required]) => {
        const applied = Math.min(required, Math.round((earned / 120) * required));
        return { id, name, required, applied, status: applied >= required ? 'met' : 'in_progress' };
      });
      const data = {
        source: `${student.sourceDataset} record ${student.sourceRecordId}`,
        program: student.program,
        catalog_year: '2025-2026',
        total_required: 120,
        total_earned: earned,
        gpa: student.gpa,
        groups,
        courses: completed.rows.slice(-8).map((row) => ({
          code: row.code,
          title: row.title,
          grade: row.grade,
          credits: Number(row.credits),
          status: 'completed'
        }))
      };
      await q(
        `INSERT INTO degree_audits (student_id, catalog_year, program, total_required, total_earned, gpa, data_json, source_dataset)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [student.id, '2025-2026', student.program, 120, earned, student.gpa, JSON.stringify(data), student.sourceDataset]
      );
    }

    const formTypes = ['OVERLOAD', 'PREREQ_OVERRIDE', 'SUBSTITUTION', 'LATE_ADD_DROP'];
    const caseCounters = { OVERLOAD: 0, PREREQ_OVERRIDE: 0, SUBSTITUTION: 0, LATE_ADD_DROP: 0 };

    function makeCase(student, index) {
      const type = formTypes[index % formTypes.length];
      const step = caseCounters[type]++;

      if (type === 'OVERLOAD') {
        const gpa = Number(student.gpa);
        const probation = student.standing === 'probation';
        let requested = gpa >= 3 ? 20 : 19;
        let incompletes = 0;
        if (step === 3) incompletes = 1;
        if (step === 4) requested = 22;
        if (step === 5 && probation) requested = 14;

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

    for (let i = 0; i < students.length; i++) {
      const student = students[i];
      const scenario = makeCase(student, i);
      const caseCode = `C${String(i + 1).padStart(2, '0')}`;
      const approved = scenario.expected === 'approved' || scenario.expected === 'approved_conditional';
      const status = approved ? 'approved' : 'rejected';
      const decision = approved ? 'accept' : 'reject';
      const expectedDecision = approved ? 'approved' : 'rejected';
      const advisorUserId = (i % advisors.length) + 1;
      const decidedAt = new Date(Date.now() - (i + 1) * 86400000);

      const formResult = await q(
        `INSERT INTO forms (student_id, type, term, status, submitted_at, data_json, assigned_advisor_id, decision, decided_by, decided_at, reason)
         VALUES ($1, $2, $3, $4, NOW() - ($5 || ' days')::interval, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [student.id, scenario.type, '2026-Fall', status, String(i % 5), JSON.stringify(scenario.data), advisors[i % advisors.length], decision, advisorUserId, decidedAt, scenario.reason]
      );

      await q(
        `INSERT INTO test_cases (form_id, case_code, expected_decision, expected_rule, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [formResult.rows[0].id, caseCode, expectedDecision, scenario.rule, scenario.reason]
      );

      await q(
        `INSERT INTO decisions (form_id, actor_id, action, reason, agent_recommendation, created_at)
         VALUES ($1, $2, $3, $4, NULL, $5)`,
        [formResult.rows[0].id, advisorUserId, decision, scenario.reason, decidedAt]
      );
    }

    for (let i = 0; i < 6; i++) {
      const professorId = professors[i % professors.length];
      const section = fallSections.find((s) => s.professorId === professorId) || fallSections[i];
      await q(
        `INSERT INTO overrides (student_id, section_id, professor_id, type, status, reason, submitted_at)
         VALUES ($1, $2, $3, 'PREREQ', 'pending', $4, NOW() - ($5 || ' days')::interval)`,
        [students[15 + i].id, section.id, professorId, 'Completed an equivalent prerequisite at another university.', String(2 + i)]
      );
    }

    for (let i = 0; i < 6; i++) {
      await q(
        `INSERT INTO appointments (student_id, advisor_id, start_at, end_at, status, reason)
         VALUES ($1, $2, $3, $4, 'booked', 'Course planning')`,
        [students[i].id, advisors[i % advisors.length], `2026-11-${String(18 + i).padStart(2, '0')}T10:00:00Z`, `2026-11-${String(18 + i).padStart(2, '0')}T10:30:00Z`]
      );
    }

    await q(
      `INSERT INTO messages (student_id, advisor_id, sender_role, body)
       VALUES ($1, $2, 'advisor', 'Your advising form is ready for review.')`,
      [students[0].id, advisors[0]]
    );
    await q(
      `INSERT INTO messages (student_id, advisor_id, sender_role, body)
       VALUES ($1, $2, 'student', 'Thank you. I will check it today.')`,
      [students[0].id, advisors[0]]
    );

    const intentFile = path.join(TESTDATA, 'advising_chat', 'zenodo', 'dataset_intent.csv');
    if (fs.existsSync(intentFile)) {
      const intents = readCsv(intentFile).slice(0, 120);
      for (const row of intents) {
        await q(
          'INSERT INTO advising_intents (intent, text, lang, source) VALUES ($1, $2, $3, $4)',
          [row.intent, row.text, row.lang || 'id', 'Zenodo 23657403']
        );
      }
    }

    const counts = {
      users: (await one('SELECT COUNT(*)::int AS n FROM users')).n,
      students: (await one('SELECT COUNT(*)::int AS n FROM students')).n,
      advisors: (await one('SELECT COUNT(*)::int AS n FROM advisors')).n,
      professors: (await one('SELECT COUNT(*)::int AS n FROM professors')).n,
      courses: (await one('SELECT COUNT(*)::int AS n FROM courses')).n,
      sections: (await one('SELECT COUNT(*)::int AS n FROM sections')).n,
      forms: (await one('SELECT COUNT(*)::int AS n FROM forms')).n,
      templates: (await one('SELECT COUNT(*)::int AS n FROM form_templates')).n,
      cases: (await one('SELECT COUNT(*)::int AS n FROM test_cases')).n,
      overrides: (await one('SELECT COUNT(*)::int AS n FROM overrides')).n,
      intents: (await one('SELECT COUNT(*)::int AS n FROM advising_intents')).n
    };

    console.log('Seeded pseudoportal');
    console.table(counts);
    console.log('Logins: student1 / advisor1 / prof1');
    console.log('Password for every account: 1234');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
