const { many, pool } = require('../db');

async function main() {
  const rows = await many(`
    SELECT tc.case_code, f.id AS form_id, s.student_no, u.display_name AS student,
           f.type, f.status, tc.expected_decision, tc.expected_rule, f.reason, f.data_json
    FROM test_cases tc
    JOIN forms f ON f.id = tc.form_id
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    ORDER BY tc.case_code
  `);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows.map((row) => ({
      case: row.case_code,
      form: row.form_id,
      student: row.student_no,
      type: row.type,
      status: row.status,
      expected: row.expected_decision,
      rule: row.expected_rule
    })));
    console.log('\nUse --json for the full case data.');
  }
}

main()
  .then(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
