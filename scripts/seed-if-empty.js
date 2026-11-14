const { one, pool } = require('../db');

(async () => {
  const row = await one('SELECT COUNT(*)::int AS n FROM students');
  if (row.n === 0) {
    console.log('No students found; base seed needed.');
    await pool.end();
    process.exit(1);
  }
  console.log(`Database already has ${row.n} students; skipping base seed.`);
  await pool.end();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
