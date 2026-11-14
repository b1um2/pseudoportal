const fs = require('node:fs');
const path = require('node:path');

const ANSWERS = path.join(__dirname, '..', 'true-answers.json');

function normalize(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['approve', 'approved', 'accept', 'accepted', 'yes', 'true'].includes(text)) return 'approved';
  if (['reject', 'rejected', 'decline', 'declined', 'deny', 'denied', 'no', 'false'].includes(text)) return 'rejected';
  return null;
}

function main() {
  const file = process.argv[2] || 'agent-results.example.json';
  const absolute = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(absolute)) {
    console.error(`Result file not found: ${absolute}`);
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const list = Array.isArray(input) ? input : input.results;
  if (!Array.isArray(list)) {
    console.error('Expected a JSON array, or an object with a "results" array.');
    process.exit(1);
  }

  const expected = JSON.parse(fs.readFileSync(ANSWERS, 'utf8')).map((answer) => ({
    ...answer,
    notes: answer.expected_reason,
    rule: answer.expected_rule
  }));

  const byCase = new Map(expected.map((row) => [row.case_code, row]));
  const byForm = new Map(expected.map((row) => [String(row.form_id), row]));
  const results = new Map();

  for (const item of list) {
    const row = item.case_code ? byCase.get(String(item.case_code)) : byForm.get(String(item.form_id));
    if (row) results.set(row.case_code, normalize(item.decision || item.verdict || item.action));
  }

  const rows = expected.map((row) => {
    const agent = results.get(row.case_code) || null;
    return {
      case: row.case_code,
      form: row.form_id,
      type: row.type,
      expected: row.expected_decision,
      agent,
      match: agent === row.expected_decision,
      rule: row.expected_rule,
      notes: row.expected_reason
    };
  });

  const provided = rows.filter((row) => row.agent);
  const matches = rows.filter((row) => row.match);
  const mismatches = rows.filter((row) => row.agent && !row.match);
  const missing = rows.filter((row) => !row.agent);

  const expectedApproved = rows.filter((row) => row.expected === 'approved').length;
  const agentApproved = provided.filter((row) => row.agent === 'approved').length;

  const confusion = {
    expectedApproved_agentApproved: rows.filter((row) => row.expected === 'approved' && row.agent === 'approved').length,
    expectedApproved_agentRejected: rows.filter((row) => row.expected === 'approved' && row.agent === 'rejected').length,
    expectedRejected_agentApproved: rows.filter((row) => row.expected === 'rejected' && row.agent === 'approved').length,
    expectedRejected_agentRejected: rows.filter((row) => row.expected === 'rejected' && row.agent === 'rejected').length
  };

  console.log('\nAgent comparison against true-answers.json');
  console.log('============================================');
  console.log(`Cases:              ${rows.length}`);
  console.log(`Agent results:      ${provided.length}`);
  console.log(`Matches:            ${matches.length}`);
  console.log(`Mismatches:         ${mismatches.length}`);
  console.log(`Missing:            ${missing.length}`);
  console.log(`Agreement rate:     ${provided.length ? ((matches.length / provided.length) * 100).toFixed(1) : '0.0'}%`);
  console.log(`Expected approvals: ${expectedApproved}/${rows.length} (${((expectedApproved / rows.length) * 100).toFixed(1)}%)`);
  console.log(`Agent approvals:    ${agentApproved}/${provided.length || 0} (${provided.length ? ((agentApproved / provided.length) * 100).toFixed(1) : '0.0'}%)`);
  console.log('\nConfusion matrix');
  console.log(confusion);

  if (mismatches.length) {
    console.log('\nMismatches');
    console.table(mismatches.map((row) => ({
      case: row.case,
      type: row.type,
      expected: row.expected,
      agent: row.agent,
      rule: row.rule
    })));
  }

  if (missing.length) {
    console.log('\nMissing cases');
    console.log(missing.map((row) => row.case).join(', '));
  }
}

main();
