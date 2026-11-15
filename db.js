const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL ||
  `postgresql://${process.env.PGUSER || process.env.USER}@127.0.0.1:5433/portal`;

const pool = new Pool({ connectionString });

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','advisor','professor')),
  display_name TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS advisors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department TEXT
);

CREATE TABLE IF NOT EXISTS professors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department TEXT
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_no TEXT UNIQUE NOT NULL,
  program TEXT NOT NULL,
  catalog_year TEXT NOT NULL,
  campus TEXT NOT NULL,
  advisor_id INTEGER REFERENCES advisors(id),
  cumulative_gpa NUMERIC(3,2) NOT NULL,
  standing TEXT NOT NULL,
  source_dataset TEXT,
  source_record_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  credits NUMERIC(4,1) NOT NULL,
  department TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  term TEXT NOT NULL,
  crn TEXT UNIQUE NOT NULL,
  professor_id INTEGER REFERENCES professors(id),
  campus TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  enrolled INTEGER NOT NULL,
  schedule TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  term TEXT NOT NULL,
  status TEXT NOT NULL,
  grade TEXT,
  credits NUMERIC(4,1) NOT NULL
);

CREATE TABLE IF NOT EXISTS degree_audits (
  id SERIAL PRIMARY KEY,
  student_id INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  catalog_year TEXT NOT NULL,
  program TEXT NOT NULL,
  total_required NUMERIC(5,1) NOT NULL,
  total_earned NUMERIC(5,1) NOT NULL,
  gpa NUMERIC(3,2) NOT NULL,
  data_json JSONB NOT NULL,
  source_dataset TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS form_templates (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  source_url TEXT,
  license TEXT,
  fields_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS forms (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  term TEXT NOT NULL,
  status TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_json JSONB NOT NULL,
  assigned_advisor_id INTEGER REFERENCES advisors(id),
  decision TEXT,
  decided_by INTEGER,
  decided_at TIMESTAMPTZ,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS test_cases (
  id SERIAL PRIMARY KEY,
  form_id INTEGER UNIQUE NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  case_code TEXT UNIQUE NOT NULL,
  expected_decision TEXT NOT NULL,
  expected_rule TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id SERIAL PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  agent_recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT,
  advisor_id TEXT,
  form_type TEXT,
  outcome TEXT,
  comment TEXT,
  decided_at TIMESTAMPTZ,
  ai_suggestion_id INTEGER,
  ai_suggestion_accepted BOOLEAN,
  student_snapshot_json JSONB
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('form', 'meeting')),
  form_id INTEGER REFERENCES forms(id) ON DELETE CASCADE,
  appointment_id INTEGER,
  advisor_id TEXT,
  student_id INTEGER,
  action TEXT NOT NULL,
  payload_json JSONB,
  reasoning TEXT,
  model TEXT,
  profile_version INTEGER,
  cold_start BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by INTEGER
);

CREATE TABLE IF NOT EXISTS overrides (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  professor_id INTEGER NOT NULL REFERENCES professors(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id INTEGER,
  details JSONB,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  advisor_id INTEGER REFERENCES advisors(id),
  professor_id INTEGER REFERENCES professors(id),
  meeting_type TEXT NOT NULL DEFAULT 'advisor',
  requested_by TEXT NOT NULL DEFAULT 'student',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_by INTEGER,
  preferred_date TEXT,
  preferred_time TEXT,
  source TEXT,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS meeting_test_cases (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  case_code TEXT UNIQUE NOT NULL,
  expected_decision TEXT NOT NULL,
  expected_rule TEXT,
  notes TEXT
);

-- Read-only meeting history view.
CREATE OR REPLACE VIEW meetings AS
SELECT
  ap.id,
  ap.advisor_id,
  ap.student_id,
  CASE WHEN ap.preferred_date IS NOT NULL
       THEN ap.preferred_date || COALESCE(' ' || ap.preferred_time, '')
       ELSE NULL END AS requested_slot,
  ap.start_at AS confirmed_slot,
  60 AS duration_min,
  ap.requested_at,
  COALESCE(ap.start_at, ap.requested_at) AS responded_at,
  ap.status
FROM appointments ap;

CREATE TABLE IF NOT EXISTS kg_nodes (
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  props_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS kg_edges (
  id TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight DOUBLE PRECISION,
  sample_size INTEGER NOT NULL DEFAULT 0,
  evidence_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  props_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS kg_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  last_decision_ts TIMESTAMPTZ,
  version INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  advisor_id INTEGER REFERENCES advisors(id),
  sender_role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS advising_intents (
  id SERIAL PRIMARY KEY,
  intent TEXT NOT NULL,
  text TEXT NOT NULL,
  lang TEXT,
  source TEXT
);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id SERIAL PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id INTEGER,
  student_id INTEGER,
  actor_id INTEGER,
  actor_role TEXT,
  summary TEXT,
  details JSONB,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_status ON agent_approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_sections_term ON sections(term);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms(status);
CREATE INDEX IF NOT EXISTS idx_forms_advisor ON forms(assigned_advisor_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

async function query(text, params = []) {
  return pool.query(text, params);
}

async function one(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function many(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function init() {
  await pool.query(schema);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS professor_id INTEGER REFERENCES professors(id)`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_type TEXT NOT NULL DEFAULT 'advisor'`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS requested_by TEXT NOT NULL DEFAULT 'student'`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS scheduled_by INTEGER`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS preferred_date TEXT`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS preferred_time TEXT`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS source TEXT`);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS agent_reasoning TEXT`);
  await pool.query(`ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS payload JSONB`);
  await pool.query(`ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE agent_approvals ADD COLUMN IF NOT EXISTS student_id INTEGER`);
  for (const [name, type] of [
    ['request_id', 'TEXT'], ['advisor_id', 'TEXT'], ['form_type', 'TEXT'], ['outcome', 'TEXT'],
    ['comment', 'TEXT'], ['decided_at', 'TIMESTAMPTZ'], ['ai_suggestion_id', 'INTEGER'],
    ['ai_suggestion_accepted', 'BOOLEAN'], ['student_snapshot_json', 'JSONB']
  ]) {
    await pool.query(`ALTER TABLE decisions ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_decisions_advisor_time ON decisions(advisor_id, decided_at)`);
  await pool.query(`
    UPDATE decisions d SET
      advisor_id = COALESCE(d.advisor_id, f.assigned_advisor_id::text),
      form_type = COALESCE(d.form_type, lower(f.type)),
      outcome = COALESCE(d.outcome, CASE d.action WHEN 'accept' THEN 'approved' WHEN 'reject' THEN 'rejected' END),
      decided_at = COALESCE(d.decided_at, d.created_at),
      student_snapshot_json = COALESCE(d.student_snapshot_json,
        jsonb_build_object('gpa', s.cumulative_gpa, 'standing', s.standing))
    FROM forms f JOIN students s ON s.id = f.student_id
    WHERE f.id = d.form_id
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_pending ON ai_suggestions(status, kind)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_suggestions_pending_form ON ai_suggestions(form_id) WHERE status = 'pending' AND form_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_suggestions_pending_meeting ON ai_suggestions(appointment_id) WHERE status = 'pending' AND appointment_id IS NOT NULL`);
  await pool.query(`ALTER TABLE kg_edges ADD COLUMN IF NOT EXISTS props_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
  // Drop review items whose request was already decided or reset elsewhere.
  await pool.query(`
    UPDATE ai_suggestions ai SET status = 'superseded', decided_at = NOW()
    WHERE ai.status = 'pending' AND (
      (ai.kind = 'form' AND EXISTS (SELECT 1 FROM forms f WHERE f.id = ai.form_id AND f.status <> 'pending'))
      OR (ai.kind = 'meeting' AND EXISTS (SELECT 1 FROM appointments a WHERE a.id = ai.appointment_id AND a.status <> 'requested'))
    )
  `);
  await pool.query(`
    UPDATE ai_suggestions ai SET status = 'superseded', decided_at = NOW()
    WHERE ai.kind = 'meeting' AND ai.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM appointments a
        JOIN appointments own ON own.id = ai.appointment_id
        WHERE a.status IN ('scheduled','booked')
          AND to_char(a.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') = ai.payload_json->>'date'
          AND to_char(a.start_at AT TIME ZONE 'UTC', 'HH24:MI') = ai.payload_json->>'time'
          AND (a.student_id = own.student_id OR a.advisor_id = own.advisor_id OR a.professor_id = own.professor_id)
      )
  `);
  await pool.query(`ALTER TABLE appointments ALTER COLUMN start_at DROP NOT NULL`);
  await pool.query(`ALTER TABLE appointments ALTER COLUMN end_at DROP NOT NULL`);

  // A student, advisor, or professor can have only one live meeting at a time.
  // Partial indexes ignore requested/rejected rows and rows without a time.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_student_start
    ON appointments(student_id, start_at)
    WHERE status IN ('scheduled', 'booked') AND start_at IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_advisor_start
    ON appointments(advisor_id, start_at)
    WHERE status IN ('scheduled', 'booked') AND start_at IS NOT NULL AND advisor_id IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_professor_start
    ON appointments(professor_id, start_at)
    WHERE status IN ('scheduled', 'booked') AND start_at IS NOT NULL AND professor_id IS NOT NULL
  `);
}

async function reset() {
  await pool.query(`
    DROP VIEW IF EXISTS meetings CASCADE;
    DROP TABLE IF EXISTS ai_suggestions CASCADE;
    DROP TABLE IF EXISTS kg_edges CASCADE;
    DROP TABLE IF EXISTS kg_nodes CASCADE;
    DROP TABLE IF EXISTS kg_runs CASCADE;
    DROP TABLE IF EXISTS agent_approvals CASCADE;
    DROP TABLE IF EXISTS messages CASCADE;
    DROP TABLE IF EXISTS meeting_test_cases CASCADE;
    DROP TABLE IF EXISTS appointments CASCADE;
    DROP TABLE IF EXISTS audit_log CASCADE;
    DROP TABLE IF EXISTS overrides CASCADE;
    DROP TABLE IF EXISTS decisions CASCADE;
    DROP TABLE IF EXISTS case_snapshots CASCADE;
    DROP TABLE IF EXISTS evaluation_runs CASCADE;
    DROP TABLE IF EXISTS test_cases CASCADE;
    DROP TABLE IF EXISTS forms CASCADE;
    DROP TABLE IF EXISTS form_templates CASCADE;
    DROP TABLE IF EXISTS degree_audits CASCADE;
    DROP TABLE IF EXISTS enrollments CASCADE;
    DROP TABLE IF EXISTS sections CASCADE;
    DROP TABLE IF EXISTS courses CASCADE;
    DROP TABLE IF EXISTS students CASCADE;
    DROP TABLE IF EXISTS professors CASCADE;
    DROP TABLE IF EXISTS advisors CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS advising_intents CASCADE;
  `);
  await init();
}

module.exports = { pool, query, one, many, tx, init, reset };
