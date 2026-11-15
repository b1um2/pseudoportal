const express = require('express');
const session = require('express-session');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { one, many, query, tx, init } = require('./db');
const { hashPassword, verifyPassword, requireRole, requireAnyRole, requireAgentKey, requireDashboardKey } = require('./lib/auth');
const { verifyGrant } = require('./lib/grant');
const { SLOTS, availableSlots, nextWeekday } = require('./lib/schedule');
const { renderMarkdown, plainMarkdown } = require('./lib/markdown');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TRUE_ANSWERS = path.join(__dirname, 'true-answers.json');
const TRUE_MEETING_ANSWERS = path.join(__dirname, 'true-meeting-answers.json');
const SAFETY_SERVICE_URL = process.env.SAFETY_SERVICE_URL || 'http://127.0.0.1:3003';

async function safetyCheck(text, { kind = 'request', direction = 'inbound', context = '' } = {}) {
  const content = String(text || '').trim();
  if (!content) return { safe: true, category: 'empty', reason: 'Empty content.' };
  try {
    const response = await fetch(`${SAFETY_SERVICE_URL}/guard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content.slice(0, 6000), kind, direction, context }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`guard HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('safety guard unavailable', error.message);
    return {
      safe: false,
      category: 'guard_unavailable',
      reason: 'The safety check is unavailable right now. Please try again.',
    };
  }
}

function guardTextFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const pieces = [];
  for (const key of ['body', 'message', 'reason', 'reasoning', 'summary', 'comment', 'text']) {
    if (body[key] !== undefined && body[key] !== null) pieces.push(String(body[key]));
  }
  for (const key of ['data', 'payload', 'details']) {
    if (body[key] && typeof body[key] === 'object') pieces.push(JSON.stringify(body[key]));
  }
  return pieces.join('\n').trim().slice(0, 6000);
}

function guardKind(pathname) {
  if (pathname.includes('meeting')) return 'meeting';
  if (pathname.includes('form') || pathname.includes('case')) return 'form';
  if (pathname.includes('message') || pathname.includes('suggest')) return 'message';
  return 'request';
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: process.env.SESSION_COOKIE_NAME || `ayadvi.sid.${PORT}`,
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.fmtDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : '';
  res.locals.fmtTime = (value) => value ? new Date(value).toISOString().slice(11, 16) : '';
  res.locals.fmtDateTime = (value) => value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '';
  next();
});

app.use(async (req, res, next) => {
  if (req.method !== 'POST') return next();
  const guardedPath = req.path.startsWith('/student/')
    || req.path.startsWith('/advisor/messages')
    || req.path.startsWith('/advisor/meetings')
    || req.path.startsWith('/api/');
  if (!guardedPath) return next();

  const text = guardTextFromBody(req.body);
  if (!text) return next();

  const result = await safetyCheck(text, {
    kind: guardKind(req.path),
    direction: 'inbound',
    context: `${req.method} ${req.path}`,
  });
  if (result.safe) {
    req.safety = result;
    return next();
  }

  const wantsJson = String(req.get('accept') || '').includes('application/json')
    || req.path.startsWith('/api/');
  const message = result.reason || 'This request was blocked by the safety check.';
  if (wantsJson) {
    return res.status(422).json({ status: 'blocked', message, category: result.category || 'unsafe' });
  }
  return res.status(422).render('error', { title: 'Request blocked', message });
});

function readTrueAnswers() {
  return JSON.parse(fs.readFileSync(TRUE_ANSWERS, 'utf8'));
}

function readMeetingAnswers() {
  return JSON.parse(fs.readFileSync(TRUE_MEETING_ANSWERS, 'utf8'));
}

function grantAllows(grant, role, objectType, objectId, action) {
  return Boolean(grant)
    && grant.role === role
    && grant.object_type === objectType
    && Number(grant.object_id) === Number(objectId)
    && grant.action === action;
}

function asObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

async function approvalActor(objectType, objectId, action) {
  if (objectType === 'message') {
    const row = await one(`
      SELECT a.user_id AS actor_id
      FROM students s JOIN advisors a ON a.id = s.advisor_id
      WHERE s.id = $1
    `, [objectId]);
    return row ? { actor_id: row.actor_id, role: 'advisor' } : null;
  }

  if (objectType === 'form') {
    if (action === 'submit') {
      const row = await one('SELECT user_id AS actor_id FROM students WHERE id = $1', [objectId]);
      return row ? { actor_id: row.actor_id, role: 'student' } : null;
    }
    const row = await one(`
      SELECT a.user_id AS actor_id
      FROM forms f JOIN advisors a ON a.id = f.assigned_advisor_id
      WHERE f.id = $1
    `, [objectId]);
    return row ? { actor_id: row.actor_id, role: 'advisor' } : null;
  }

  if (objectType === 'meeting') {
    if (action === 'create_professor_meeting' || action === 'request') {
      const row = await one(`
        SELECT u.id AS user_id, a.user_id AS advisor_user_id
        FROM students s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN advisors a ON a.id = s.advisor_id
        WHERE s.id = $1
      `, [objectId]);
      if (!row) return null;
      return action === 'request'
        ? { actor_id: row.user_id, role: 'student' }
        : (row.advisor_user_id ? { actor_id: row.advisor_user_id, role: 'advisor' } : null);
    }
    const row = await one(`
      SELECT a.user_id AS actor_id
      FROM appointments ap JOIN advisors a ON a.id = ap.advisor_id
      WHERE ap.id = $1
    `, [objectId]);
    return row ? { actor_id: row.actor_id, role: 'advisor' } : null;
  }

  if (objectType === 'override') {
    const row = await one(`
      SELECT p.user_id AS actor_id
      FROM overrides o JOIN professors p ON p.id = o.professor_id
      WHERE o.id = $1
    `, [objectId]);
    return row ? { actor_id: row.actor_id, role: 'professor' } : null;
  }

  return null;
}

async function approvalStudentId(objectType, objectId, action) {
  if (objectType === 'message') return Number(objectId) || null;
  if (objectType === 'form') {
    if (action === 'submit') return Number(objectId) || null;
    const row = await one('SELECT student_id FROM forms WHERE id = $1', [objectId]);
    return row?.student_id || null;
  }
  if (objectType === 'meeting') {
    if (action === 'create_professor_meeting' || action === 'request') {
      return Number(objectId) || null;
    }
    const row = await one('SELECT student_id FROM appointments WHERE id = $1', [objectId]);
    return row?.student_id || null;
  }
  return null;
}

async function expiredApproval(row) {
  if (row.status !== 'pending') return row;
  if (new Date(row.expires_at).getTime() >= Date.now()) return row;
  await query(`UPDATE agent_approvals SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [row.id]);
  return { ...row, status: 'expired' };
}

async function executeApprovedAction(row) {
  const payload = asObject(row.payload, {});

  if (row.action === 'send' && row.object_type === 'message') {
    const studentId = Number(row.object_id);
    const body = String(payload.body || '').trim().slice(0, 1000);
    const student = await one('SELECT * FROM students WHERE id = $1', [studentId]);
    if (!student || !body) throw new Error('invalid approved message');
    const replyTo = Number(payload.reply_to_message_id);
    return tx(async (client) => {
      const inserted = await client.query(`
        INSERT INTO messages (student_id, advisor_id, sender_role, body)
        VALUES ($1, $2, 'advisor', $3) RETURNING id
      `, [studentId, student.advisor_id, body]);
      if (Number.isInteger(replyTo)) {
        await client.query(`
          UPDATE messages SET read_at = NOW()
          WHERE id = $1 AND student_id = $2 AND sender_role = 'student'
        `, [replyTo, studentId]);
      }
      await audit(row.actor_id, 'message_sent', 'student', studentId,
        { source: 'approval_code', request_id: row.request_id, reply_to_message_id: Number.isInteger(replyTo) ? replyTo : null },
        null, client);
      return { message_id: inserted.rows[0].id };
    });
  }

  if (row.action === 'submit' && row.object_type === 'form') {
    const studentId = Number(row.object_id);
    const student = await one('SELECT * FROM students WHERE id = $1', [studentId]);
    const formType = String(payload.type || '').toUpperCase();
    if (!student || !['OVERLOAD', 'PREREQ_OVERRIDE', 'SUBSTITUTION', 'LATE_ADD_DROP'].includes(formType)) {
      throw new Error('invalid form payload');
    }
    const data = payload.data && typeof payload.data === 'object' ? { ...payload.data } : {};
    data.reason = String(payload.reason || data.reason || 'Requested through a message').slice(0, 1000);
    const term = String(payload.term || '2026-Fall').slice(0, 20);
    return tx(async (client) => {
      const inserted = await client.query(`
        INSERT INTO forms (
          student_id, type, term, status, submitted_at, data_json, assigned_advisor_id
        ) VALUES ($1, $2, $3, 'pending', NOW(), $4, $5)
        RETURNING id
      `, [studentId, formType, term, JSON.stringify(data), student.advisor_id]);
      await audit(row.actor_id, 'form_submitted', 'form', inserted.rows[0].id,
        { source: 'approval_code', request_id: row.request_id, type: formType }, null, client);
      return { form_id: inserted.rows[0].id };
    });
  }

  if ((row.action === 'accept' || row.action === 'reject') && row.object_type === 'form') {
    const formId = Number(row.object_id);
    const advisor = await one('SELECT * FROM advisors WHERE user_id = $1', [row.actor_id]);
    const form = await one(`
      SELECT f.*, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing
      FROM forms f JOIN students s ON s.id = f.student_id
      WHERE f.id = $1 AND f.assigned_advisor_id = $2
    `, [formId, advisor?.id]);
    if (!form || form.status !== 'pending') throw new Error('form is not pending');
    const reason = String(payload.reason || '').slice(0, 500);
    return tx(async (client) => {
      const updated = await client.query(`
        UPDATE forms
        SET status = $1, decision = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $5 AND status = 'pending'
      `, [row.action === 'accept' ? 'approved' : 'rejected', row.action, row.actor_id, reason, formId]);
      if (updated.rowCount !== 1) throw new Error('form state changed');
      await insertDecision(client, {
        formId, actorId: row.actor_id, advisorId: advisor.id, action: row.action,
        reason, form, aiSuggestionId: row.ai_suggestion_id || null
      });
      await audit(row.actor_id, row.action === 'accept' ? 'form_approved_agent' : 'form_rejected_agent',
        'form', formId, { reason, source: 'approval_code', request_id: row.request_id }, null, client);
      return {};
    });
  }

  if (row.action === 'schedule' && row.object_type === 'meeting') {
    const meetingId = Number(row.object_id);
    const meeting = await one('SELECT * FROM appointments WHERE id = $1 AND advisor_id = $2', [meetingId, await advisorIdForUser(row.actor_id)]);
    if (!meeting || meeting.status !== 'requested') throw new Error('meeting is not requested');
    const date = String(payload.date || '').slice(0, 10);
    const time = String(payload.time || '');
    const staffType = meeting.meeting_type === 'professor' ? 'professor' : 'advisor';
    const staffId = staffType === 'professor' ? meeting.professor_id : meeting.advisor_id;
    const slots = await availableSlots({
      date,
      studentId: meeting.student_id,
      staffType,
      staffId,
      advisorId: meeting.meeting_type === 'professor' ? meeting.advisor_id : null
    });
    if (!slots.includes(time)) throw new Error('meeting slot conflicts');
    const start = new Date(`${date}T${time}:00Z`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return tx(async (client) => {
      await client.query(`
        UPDATE appointments
        SET status = 'scheduled', start_at = $1, end_at = $2, scheduled_by = $3,
            agent_reasoning = $4
        WHERE id = $5 AND status = 'requested'
      `, [start.toISOString(), end.toISOString(), row.actor_id, String(payload.reason || '').slice(0, 1000) || null, meetingId]);
      await client.query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
        [meeting.student_id, meeting.advisor_id, `Your meeting is scheduled for ${date} at ${time}.`]);
      await audit(row.actor_id, 'meeting_scheduled', 'appointment', meetingId,
        { date, time, reason: payload.reason || '', source: 'approval_code', request_id: row.request_id }, null, client);
      return {};
    });
  }

  if (row.action === 'create_professor_meeting' && row.object_type === 'meeting') {
    const studentId = Number(row.object_id);
    const advisorId = await advisorIdForUser(row.actor_id);
    const student = await one('SELECT * FROM students WHERE id = $1 AND advisor_id = $2', [studentId, advisorId]);
    const professorId = Number(payload.professor_id);
    const professor = await one('SELECT * FROM professors WHERE id = $1', [professorId]);
    if (!student || !professor) throw new Error('invalid professor meeting');
    const date = String(payload.date || '').slice(0, 10);
    const time = String(payload.time || '');
    const slots = await availableSlots({ date, studentId, staffType: 'professor', staffId: professorId, advisorId });
    if (!slots.includes(time)) throw new Error('meeting slot conflicts');
    const start = new Date(`${date}T${time}:00Z`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return tx(async (client) => {
      const inserted = await client.query(`
        INSERT INTO appointments (student_id, advisor_id, professor_id, meeting_type, requested_by, status, start_at, end_at, scheduled_by, reason)
        VALUES ($1, $2, $3, 'professor', 'advisor', 'scheduled', $4, $5, $6, $7)
        RETURNING id
      `, [studentId, advisorId, professorId, start.toISOString(), end.toISOString(), row.actor_id, String(payload.reason || 'Meeting with professor')]);
      await client.query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
        [studentId, advisorId, `Your meeting with a professor is scheduled for ${date} at ${time}.`]);
      await audit(row.actor_id, 'meeting_scheduled', 'appointment', inserted.rows[0].id,
        { date, time, type: 'professor', source: 'approval_code', request_id: row.request_id }, null, client);
      return { meeting_id: inserted.rows[0].id };
    });
  }

  throw new Error('unsupported approved action');
}

async function advisorIdForUser(userId) {
  const row = await one('SELECT id FROM advisors WHERE user_id = $1', [userId]);
  return row?.id;
}

async function audit(actorId, action, objectType, objectId, details = {}, ip = null, client = null) {
  const sql = `INSERT INTO audit_log (actor_id, action, object_type, object_id, details, ip, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW())`;
  const params = [actorId, action, objectType, objectId, JSON.stringify(details), ip];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

function decisionSnapshot(form) {
  const data = asObject(form.data_json, {});
  const credits = data.requested_credits ?? data.current_credits ?? null;
  return {
    gpa: form.cumulative_gpa == null ? null : Number(form.cumulative_gpa),
    credits: credits == null ? null : Number(credits),
    standing: form.standing || null,
    prereq_status: data.prerequisite_status || null,
    deadline_status: data.window_open === true ? 'open' : data.window_open === false ? 'closed' : null
  };
}

async function insertDecision(client, {
  formId, actorId, advisorId, action, reason, form, aiSuggestionId = null
}) {
  const outcome = action === 'accept' ? 'approved' : 'rejected';
  await client.query(`
    INSERT INTO decisions (
      form_id, actor_id, action, reason, agent_recommendation, created_at,
      request_id, advisor_id, form_type, outcome, comment, decided_at,
      ai_suggestion_id, ai_suggestion_accepted, student_snapshot_json
    ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, NOW(), $11, $12, $13)
  `, [
    formId,
    actorId,
    action,
    reason,
    aiSuggestionId ? 'Approved on advisor interface' : null,
    `FORM-${formId}`,
    advisorId == null ? null : String(advisorId),
    String(form.type || '').toLowerCase(),
    outcome,
    reason,
    aiSuggestionId,
    aiSuggestionId ? true : null,
    JSON.stringify(decisionSnapshot(form))
  ]);
  await client.query(`
    UPDATE ai_suggestions SET status = 'superseded', decided_at = NOW()
    WHERE kind = 'form' AND form_id = $1 AND status = 'pending'
      AND id <> COALESCE($2, -1)
  `, [formId, aiSuggestionId]);
}

async function supersedeMeetingSuggestions(meetingId, keepId = null) {
  const meeting = await one(`
    SELECT student_id, advisor_id, professor_id, start_at
    FROM appointments WHERE id = $1
  `, [meetingId]);
  if (!meeting || !meeting.start_at) return;
  const date = new Date(meeting.start_at).toISOString().slice(0, 10);
  const time = new Date(meeting.start_at).toISOString().slice(11, 16);
  await query(`
    UPDATE ai_suggestions ai SET status = 'superseded', decided_at = NOW()
    WHERE ai.kind = 'meeting' AND ai.status = 'pending'
      AND ai.id <> COALESCE($1, -1)
      AND (
        ai.appointment_id = $2
        OR (
          ai.payload_json->>'date' = $3 AND ai.payload_json->>'time' = $4
          AND EXISTS (
            SELECT 1 FROM appointments other
            WHERE other.id = ai.appointment_id
              AND (other.student_id = $5 OR other.advisor_id = $6 OR other.professor_id = $7)
          )
        )
      )
  `, [keepId, meetingId, date, time, meeting.student_id, meeting.advisor_id, meeting.professor_id]);
}

async function studentForUser(userId) {
  return one(`
    SELECT s.*, s.cumulative_gpa::float8 AS cumulative_gpa,
           a.user_id AS advisor_user_id, u.display_name AS advisor_name
    FROM students s
    LEFT JOIN advisors a ON a.id = s.advisor_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE s.user_id = $1
  `, [userId]);
}

async function advisorForUser(userId) {
  return one('SELECT * FROM advisors WHERE user_id = $1', [userId]);
}

async function professorForUser(userId) {
  return one('SELECT * FROM professors WHERE user_id = $1', [userId]);
}

function emptyCapp(program) {
  return {
    source: 'Created in the portal',
    program,
    catalog_year: '2025-2026',
    total_required: 120,
    total_earned: 0,
    gpa: 0,
    groups: [
      { id: 'MAJOR', name: 'Major Core', required: 45, applied: 0, status: 'in_progress' },
      { id: 'LAS', name: 'LAS Core', required: 30, applied: 0, status: 'in_progress' },
      { id: 'FREE', name: 'Free Electives', required: 15, applied: 0, status: 'in_progress' },
      { id: 'RES', name: 'Residency', required: 30, applied: 0, status: 'in_progress' }
    ],
    courses: []
  };
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const role = req.session.user.role;
  return res.redirect(role === 'student' ? '/student' : role === 'advisor' ? '/advisor' : '/professor');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in', error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await one('SELECT * FROM users WHERE username = $1', [username]);
  if (!user || !verifyPassword(user.password_hash, password)) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  await audit(user.id, 'login', 'user', user.id, { role: user.role }, req.ip);
  return res.redirect(user.role === 'student' ? '/student' : user.role === 'advisor' ? '/advisor' : '/professor');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/student', requireRole('student'), async (req, res) => {
  const student = await studentForUser(req.session.user.id);
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'No student record for this account.' });

  const auditRow = await one('SELECT * FROM degree_audits WHERE student_id = $1', [student.id]);
  const capp = asObject(auditRow?.data_json, null);
  const enrollments = await many(`
    SELECT e.*, c.code, c.title, sec.term, sec.crn
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    WHERE e.student_id = $1
    ORDER BY e.status DESC, c.code
  `, [student.id]);
  const forms = await many('SELECT * FROM forms WHERE student_id = $1 ORDER BY submitted_at DESC', [student.id]);
  const appointments = await many(`
    SELECT mt.case_code, ap.*, au.display_name AS advisor_name, pu.display_name AS professor_name
    FROM appointments ap
    LEFT JOIN meeting_test_cases mt ON mt.appointment_id = ap.id
    LEFT JOIN advisors a ON a.id = ap.advisor_id
    LEFT JOIN users au ON au.id = a.user_id
    LEFT JOIN professors p ON p.id = ap.professor_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE ap.student_id = $1
    ORDER BY COALESCE(ap.start_at, ap.requested_at) DESC
  `, [student.id]);
  const messages = (await many(`
    SELECT * FROM (
      SELECT m.*, u.display_name AS advisor_name
      FROM messages m
      LEFT JOIN advisors a ON a.id = m.advisor_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE m.student_id = $1
      ORDER BY m.created_at DESC
      LIMIT 5
    ) recent
    ORDER BY recent.created_at ASC
  `, [student.id])).map((message) => ({ ...message, body_html: renderMarkdown(message.body) }));

  res.render('student/dashboard', { title: 'Student', student, capp, enrollments, forms, appointments, messages });
});

app.post('/student/forms', requireRole('student'), async (req, res) => {
  const student = await studentForUser(req.session.user.id);
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'No student record.' });

  const type = String(req.body.type || 'OVERLOAD');
  const allowed = ['OVERLOAD', 'PREREQ_OVERRIDE', 'SUBSTITUTION', 'LATE_ADD_DROP'];
  if (!allowed.includes(type)) return res.status(400).render('error', { title: 'Bad request', message: 'Unknown form type.' });

  const reason = String(req.body.reason || '').slice(0, 500);
  const data = { reason, term: '2026-Fall' };
  if (type === 'OVERLOAD') data.credits_requested = Number(req.body.credits || 19);
  if (type === 'PREREQ_OVERRIDE') {
    data.course = String(req.body.course || 'CSC310');
    data.prerequisite = String(req.body.prerequisite || 'CSC245');
  }
  if (type === 'SUBSTITUTION') {
    data.required_course = String(req.body.course || 'CSC490');
    data.substitute_course = String(req.body.substitute || 'CSC399');
  }
  if (type === 'LATE_ADD_DROP') {
    data.course = String(req.body.course || 'CSC326');
    data.action = String(req.body.action || 'add');
  }

  const row = await one(`
    INSERT INTO forms (student_id, type, term, status, submitted_at, data_json, assigned_advisor_id)
    VALUES ($1, $2, $3, 'pending', NOW(), $4, $5) RETURNING id
  `, [student.id, type, '2026-Fall', JSON.stringify(data), student.advisor_id]);

  await audit(req.session.user.id, 'form_submitted', 'form', row.id, { type }, req.ip);
  res.redirect('/student');
});

app.post('/student/messages', requireRole('student'), async (req, res) => {
  const student = await studentForUser(req.session.user.id);
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'No student record.' });
  const body = String(req.body.body || '').trim().slice(0, 1000);
  const wantsJson = String(req.get('accept') || '').includes('application/json');
  if (!body) {
    return wantsJson
      ? res.status(400).json({ status: 'failed', message: 'Write a message first.' })
      : res.redirect('/student');
  }

  const row = await one(`
    INSERT INTO messages (student_id, advisor_id, sender_role, body)
    VALUES ($1, $2, 'student', $3) RETURNING id
  `, [student.id, student.advisor_id, body]);
  await audit(req.session.user.id, 'message_sent', 'student', student.id, { message_id: row.id }, req.ip);

  if (wantsJson) return res.json({ status: 'accepted', message_id: row.id });
  res.redirect('/student');
});


app.post('/student/meetings', requireRole('student'), async (req, res) => {
  const student = await studentForUser(req.session.user.id);
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'No student record.' });

  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const preferredDate = String(req.body.preferred_date || '').trim().slice(0, 20) || null;
  if (!reason) return res.redirect('/student');

  const row = await one(`
    INSERT INTO appointments (student_id, advisor_id, meeting_type, requested_by, preferred_date, status, reason, source)
    VALUES ($1, $2, 'advisor', 'student', $3, 'requested', $4, 'portal') RETURNING id
  `, [student.id, student.advisor_id, preferredDate, reason]);

  await audit(req.session.user.id, 'meeting_requested', 'appointment', row.id, { preferredDate }, req.ip);
  res.redirect('/student');
});

app.get('/advisor', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(404).render('error', { title: 'Not found', message: 'No advisor record.' });

  const queue = await many(`
    SELECT f.*, s.student_no, s.program, u.display_name AS student_name
    FROM forms f
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    WHERE f.assigned_advisor_id = $1 AND f.status = 'pending'
    ORDER BY f.submitted_at
  `, [advisor.id]);

  const counts = await many(`
    SELECT status, COUNT(*)::int AS n FROM forms WHERE assigned_advisor_id = $1 GROUP BY status
  `, [advisor.id]);

  const templates = await many('SELECT * FROM form_templates ORDER BY id');
  const reset = req.query.reset === '1';
  const applied = req.query.applied === '1';
  const history = await many(`
    SELECT f.*, s.student_no, u.display_name AS student_name
    FROM forms f
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    WHERE f.assigned_advisor_id = $1 AND f.status <> 'pending'
    ORDER BY f.decided_at DESC NULLS LAST
    LIMIT 25
  `, [advisor.id]);

  res.render('advisor/queue', { title: 'Advisor queue', advisor, queue, counts, templates, history, reset, applied });
});

app.get('/advisor/cases/:id', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const form = await one(`
    SELECT f.*, s.student_no, s.program, s.catalog_year, s.campus,
           s.cumulative_gpa::float8 AS cumulative_gpa, s.standing,
           u.display_name AS student_name, u.email AS student_email
    FROM forms f
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    WHERE f.id = $1 AND f.assigned_advisor_id = $2
  `, [Number(req.params.id), advisor?.id]);

  if (!form) return res.status(404).render('error', { title: 'Not found', message: 'Case not found in your queue.' });

  const auditRow = await one('SELECT * FROM degree_audits WHERE student_id = $1', [form.student_id]);
  const capp = asObject(auditRow?.data_json, null);
  const decisions = await many('SELECT * FROM decisions WHERE form_id = $1 ORDER BY created_at', [form.id]);

  res.render('advisor/case', { title: 'Case ' + form.id, advisor, form, capp, decisions, data: asObject(form.data_json) });
});


app.get('/advisor/meetings', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(404).render('error', { title: 'Not found', message: 'No advisor record.' });

  const pending = await many(`
    SELECT ap.*, s.student_no, u.display_name AS student_name
    FROM appointments ap
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    WHERE ap.advisor_id = $1 AND ap.status = 'requested'
    ORDER BY ap.requested_at
  `, [advisor.id]);

  const upcoming = await many(`
    SELECT ap.*, s.student_no, u.display_name AS student_name, pu.display_name AS professor_name
    FROM appointments ap
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN professors p ON p.id = ap.professor_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE ap.advisor_id = $1 AND ap.status IN ('scheduled', 'booked')
    ORDER BY ap.start_at
  `, [advisor.id]);

  const students = await many(`
    SELECT s.id, s.student_no, u.display_name
    FROM students s JOIN users u ON u.id = s.user_id
    WHERE s.advisor_id = $1 ORDER BY u.display_name
  `, [advisor.id]);

  const professors = await many(`
    SELECT p.id, p.department, u.display_name
    FROM professors p JOIN users u ON u.id = p.user_id
    ORDER BY u.display_name
  `);

  const counts = await many(`
    SELECT status, COUNT(*)::int AS n
    FROM appointments
    WHERE id IN (SELECT appointment_id FROM meeting_test_cases)
    GROUP BY status
  `);

  const history = await many(`
    SELECT mt.case_code, ap.*, s.student_no, u.display_name AS student_name, pu.display_name AS professor_name
    FROM appointments ap
    JOIN meeting_test_cases mt ON mt.appointment_id = ap.id
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN professors p ON p.id = ap.professor_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE ap.status IN ('scheduled', 'booked', 'rejected')
    ORDER BY mt.case_code DESC
    LIMIT 30
  `);

  res.render('advisor/meetings', {
    title: 'Meetings',
    advisor,
    pending,
    upcoming,
    students,
    professors,
    times: SLOTS,
    counts,
    history,
    reset: req.query.reset === '1',
    applied: req.query.applied === '1',
    error: req.query.error || null
  });
});

app.get('/advisor/meetings/:id', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const meeting = await one(`
    SELECT ap.*, s.student_no, s.program, u.display_name AS student_name
    FROM appointments ap
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    WHERE ap.id = $1 AND ap.advisor_id = $2
  `, [Number(req.params.id), advisor?.id]);

  if (!meeting) return res.status(404).render('error', { title: 'Not found', message: 'Meeting request not found.' });

  const date = String(req.query.date || nextWeekday()).slice(0, 10);
  const slots = await availableSlots({ date, studentId: meeting.student_id, staffType: 'advisor', staffId: advisor.id });
  res.render('advisor/meeting', { title: 'Schedule meeting', advisor, meeting, date, slots, error: req.query.error || null });
});

app.post('/advisor/meetings/:id/schedule', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const meeting = await one('SELECT * FROM appointments WHERE id = $1 AND advisor_id = $2', [Number(req.params.id), advisor?.id]);
  if (!meeting || meeting.status !== 'requested') {
    return res.status(404).render('error', { title: 'Not found', message: 'Meeting request not found or already scheduled.' });
  }

  const date = String(req.body.date || '').slice(0, 10);
  const time = String(req.body.time || '');
  const slots = await availableSlots({ date, studentId: meeting.student_id, staffType: 'advisor', staffId: advisor.id });
  if (!slots.includes(time)) {
    return res.redirect(`/advisor/meetings/${meeting.id}?date=${date}&error=conflict`);
  }

  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  try {
    await query(`
      UPDATE appointments
      SET status = 'scheduled', start_at = $1, end_at = $2, scheduled_by = $3
      WHERE id = $4
    `, [start.toISOString(), end.toISOString(), req.session.user.id, meeting.id]);
  } catch (error) {
    if (error.code === '23505') {
      return res.redirect(`/advisor/meetings/${meeting.id}?date=${date}&error=conflict`);
    }
    throw error;
  }

  await query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
    [meeting.student_id, advisor.id, `Your meeting is scheduled for ${date} at ${time}.`]);
  await audit(req.session.user.id, 'meeting_scheduled', 'appointment', meeting.id, { date, time, type: 'advisor' }, req.ip);
  await supersedeMeetingSuggestions(meeting.id);
  res.redirect('/advisor/meetings');
});

app.post('/advisor/meetings/:id/reject', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const meeting = await one('SELECT * FROM appointments WHERE id = $1 AND advisor_id = $2', [Number(req.params.id), advisor?.id]);
  if (!meeting || meeting.status !== 'requested') {
    return res.status(404).render('error', { title: 'Not found', message: 'Meeting request not found or already decided.' });
  }

  const reason = String(req.body.reason || 'Rejected by the advisor.').trim().slice(0, 500);
  await tx(async (client) => {
    await client.query(`
      UPDATE appointments
      SET status = 'rejected', start_at = NULL, end_at = NULL, scheduled_by = $1, reason = $2
      WHERE id = $3
    `, [req.session.user.id, reason, meeting.id]);
    await client.query(`
      INSERT INTO messages (student_id, advisor_id, sender_role, body)
      VALUES ($1, $2, 'advisor', $3)
    `, [meeting.student_id, advisor.id, `Your meeting request could not be scheduled: ${reason}`]);
    await audit(req.session.user.id, 'meeting_rejected_manual', 'appointment', meeting.id, { reason, source: 'manual_portal' }, req.ip, client);
  });
  await supersedeMeetingSuggestions(meeting.id);

  res.redirect('/advisor/meetings');
});

app.post('/advisor/meetings/professor', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const studentId = Number(req.body.student_id);
  const professorId = Number(req.body.professor_id);
  const date = String(req.body.date || '').slice(0, 10);
  const time = String(req.body.time || '');
  const reason = String(req.body.reason || 'Meeting with professor').slice(0, 500);

  const student = await one('SELECT * FROM students WHERE id = $1 AND advisor_id = $2', [studentId, advisor?.id]);
  const professor = await one('SELECT * FROM professors WHERE id = $1', [professorId]);
  if (!student || !professor) return res.status(400).render('error', { title: 'Bad request', message: 'Choose a student in your caseload and a professor.' });

  const slots = await availableSlots({ date, studentId, staffType: 'professor', staffId: professorId, advisorId: advisor.id });
  if (!slots.includes(time)) {
    return res.redirect('/advisor/meetings?error=conflict');
  }

  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  let row;
  try {
    row = await one(`
      INSERT INTO appointments (student_id, advisor_id, professor_id, meeting_type, requested_by, status, start_at, end_at, scheduled_by, reason)
      VALUES ($1, $2, $3, 'professor', 'advisor', 'scheduled', $4, $5, $6, $7)
      RETURNING id
    `, [studentId, advisor.id, professorId, start.toISOString(), end.toISOString(), req.session.user.id, reason]);
  } catch (error) {
    if (error.code === '23505') return res.redirect('/advisor/meetings?error=conflict');
    throw error;
  }

  await query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
    [studentId, advisor.id, `Your meeting with a professor is scheduled for ${date} at ${time}.`]);
  await audit(req.session.user.id, 'meeting_scheduled', 'appointment', row.id, { date, time, type: 'professor' }, req.ip);
  res.redirect('/advisor/meetings');
});

app.get('/advisor/audit', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const rows = await many(`
    SELECT al.*, u.display_name AS actor_name
    FROM audit_log al
    LEFT JOIN users u ON u.id = al.actor_id
    ORDER BY al.created_at DESC
    LIMIT 100
  `);
  res.render('advisor/audit', { title: 'Audit log', advisor, rows });
});



app.get('/api/advisor/check-results', requireRole('advisor'), async (req, res) => {
  const formAnswers = readTrueAnswers();
  const forms = await many('SELECT id, status, decision, reason FROM forms');
  const byForm = new Map(forms.map((row) => [row.id, row]));

  const cases = formAnswers.map((answer) => {
    const form = byForm.get(answer.form_id);
    const actual = form?.status === 'approved' ? 'approved' : form?.status === 'rejected' ? 'rejected' : null;
    return {
      kind: 'form',
      case: answer.case_code,
      form: answer.form_id,
      expected: answer.expected_decision,
      actual,
      status: form?.status || 'missing',
      correct: actual === answer.expected_decision,
      rule: answer.expected_rule,
      reason: form?.reason || null
    };
  });

  res.json({
    total: cases.length,
    decided: cases.filter((row) => row.actual).length,
    correct: cases.filter((row) => row.correct).length,
    wrong: cases.filter((row) => !row.correct)
  });
});

app.get('/api/advisor/check-meetings', requireRole('advisor'), async (req, res) => {
  const meetingAnswers = readMeetingAnswers();
  const appointments = await many('SELECT id, status, reason FROM appointments');
  const byAppointment = new Map(appointments.map((row) => [row.id, row]));

  const cases = meetingAnswers.map((answer) => {
    const appointment = byAppointment.get(answer.appointment_id);
    const actual = appointment?.status === 'scheduled' || appointment?.status === 'booked'
      ? 'scheduled'
      : appointment?.status === 'rejected' ? 'rejected' : null;
    return {
      kind: 'meeting',
      case: answer.case_code,
      form: answer.appointment_id,
      expected: answer.expected_decision,
      actual,
      status: appointment?.status || 'missing',
      correct: actual === answer.expected_decision,
      rule: answer.expected_rule,
      reason: appointment?.reason || null
    };
  });

  res.json({
    total: cases.length,
    decided: cases.filter((row) => row.actual).length,
    correct: cases.filter((row) => row.correct).length,
    wrong: cases.filter((row) => !row.correct)
  });
});

app.post('/api/advisor/cases/:id/decision', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const id = Number(req.params.id);
  const action = String(req.body.action || '');
  const reason = String(req.body.reason || '').slice(0, 500);

  if (!advisor || !['accept', 'reject'].includes(action)) {
    return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const form = await one(`
    SELECT f.*, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing
    FROM forms f JOIN students s ON s.id = f.student_id
    WHERE f.id = $1 AND f.assigned_advisor_id = $2
  `, [id, advisor.id]);
  if (!form || form.status !== 'pending') {
    return res.json({ status: 'failed', message: 'failed and data not stored' });
  }

  try {
    await tx(async (client) => {
      const updated = await client.query(`
        UPDATE forms SET status = $1, decision = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $5 AND status = 'pending'
      `, [action === 'accept' ? 'approved' : 'rejected', action, req.session.user.id, reason, id]);

      if (updated.rowCount !== 1) throw new Error('case state changed');

      await insertDecision(client, {
        formId: id, actorId: req.session.user.id, advisorId: advisor.id,
        action, reason, form
      });

      await audit(req.session.user.id, action === 'accept' ? 'form_approved_manual' : 'form_rejected_manual', 'form', id, { reason, source: 'manual_portal' }, req.ip, client);
    });
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  } catch {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }
});

app.post('/api/professor/overrides/:id/decision', requireRole('professor'), async (req, res) => {
  const professor = await professorForUser(req.session.user.id);
  const id = Number(req.params.id);
  const action = String(req.body.action || '');
  const reason = String(req.body.reason || '').slice(0, 500);

  if (!professor || !['approve', 'deny'].includes(action)) {
    return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const override = await one('SELECT * FROM overrides WHERE id = $1 AND professor_id = $2', [id, professor.id]);
  if (!override || override.status !== 'pending') {
    return res.json({ status: 'failed', message: 'failed and data not stored' });
  }

  try {
    await tx(async (client) => {
      const updated = await client.query(`
        UPDATE overrides SET status = $1, decision = $2, decided_at = NOW(), reason = $3
        WHERE id = $4 AND status = 'pending'
      `, [action === 'approve' ? 'approved' : 'denied', action, reason, id]);

      if (updated.rowCount !== 1) throw new Error('override state changed');
      await audit(req.session.user.id, action === 'approve' ? 'override_approved_manual' : 'override_denied_manual', 'override', id, { reason, source: 'manual_portal' }, req.ip, client);
    });
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  } catch {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }
});


app.get('/advisor/messages', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(404).render('error', { title: 'Not found', message: 'No advisor record.' });

  const threads = (await many(`
    SELECT s.id AS student_id, s.student_no, u.display_name AS student_name,
           lm.body AS last_body, lm.created_at AS last_at, COALESCE(unread.n, 0) AS unread
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT body, created_at FROM messages m WHERE m.student_id = s.id ORDER BY m.created_at DESC LIMIT 1
    ) lm ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n FROM messages m
      WHERE m.student_id = s.id AND m.sender_role = 'student' AND m.read_at IS NULL
    ) unread ON TRUE
    WHERE s.advisor_id = $1
    ORDER BY lm.created_at DESC NULLS LAST
  `, [advisor.id])).map((thread) => ({ ...thread, last_body_text: plainMarkdown(thread.last_body) }));

  res.render('advisor/messages', { title: 'Messages', advisor, threads });
});

app.get('/advisor/messages/:studentId', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const student = await one(`
    SELECT s.*, u.display_name AS student_name, u.email AS student_email
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.advisor_id = $2
  `, [Number(req.params.studentId), advisor?.id]);

  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'Student is not in your caseload.' });

  await query(`
    UPDATE messages SET read_at = NOW()
    WHERE student_id = $1 AND sender_role = 'student' AND read_at IS NULL
  `, [student.id]);

  const messages = (await many(`
    SELECT * FROM (
      SELECT * FROM messages WHERE student_id = $1 ORDER BY created_at DESC LIMIT 5
    ) recent ORDER BY recent.created_at ASC
  `, [student.id])).map((message) => ({ ...message, body_html: renderMarkdown(message.body) }));
  res.render('advisor/thread', { title: 'Messages · ' + student.student_name, advisor, student, messages });
});

app.post('/advisor/messages/:studentId', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  const student = await one('SELECT * FROM students WHERE id = $1 AND advisor_id = $2', [Number(req.params.studentId), advisor?.id]);
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'Student is not in your caseload.' });

  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (body) {
    await query('INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, $3, $4)',
      [student.id, advisor.id, 'advisor', body]);
    await audit(req.session.user.id, 'message_sent', 'student', student.id, { source: 'advisor_portal' }, req.ip);
  }
  res.redirect(`/advisor/messages/${student.id}`);
});


app.post('/advisor/reset-cases', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(403).render('error', { title: 'Forbidden', message: 'No advisor record.' });

  await tx(async (client) => {
    await client.query(`
      CREATE TEMP TABLE reset_forms ON COMMIT DROP AS
      SELECT form_id FROM test_cases
      ORDER BY random()
      LIMIT (SELECT GREATEST(1, CEIL(COUNT(*) * 0.5)::int) FROM test_cases)
    `);
    await client.query('DELETE FROM decisions WHERE form_id IN (SELECT form_id FROM reset_forms)');
    await client.query('DELETE FROM ai_suggestions WHERE form_id IN (SELECT form_id FROM reset_forms)');
    await client.query(`
      UPDATE forms
      SET status = 'pending', decision = NULL, decided_by = NULL, decided_at = NULL, reason = NULL
      WHERE id IN (SELECT form_id FROM reset_forms)
    `);
    await audit(req.session.user.id, 'queue_reset_for_review', 'evaluation_run', null,
      { source: 'advisor_portal', scope: 'forms', reset_fraction: 0.5 }, req.ip, client);
  });

  res.redirect('/advisor?reset=1');
});

app.post('/advisor/reset-meetings', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(403).render('error', { title: 'Forbidden', message: 'No advisor record.' });

  await tx(async (client) => {
    await client.query(`
      CREATE TEMP TABLE reset_meetings ON COMMIT DROP AS
      SELECT appointment_id FROM meeting_test_cases
      ORDER BY random()
      LIMIT (SELECT GREATEST(1, CEIL(COUNT(*) * 0.5)::int) FROM meeting_test_cases)
    `);
    await client.query('DELETE FROM ai_suggestions WHERE appointment_id IN (SELECT appointment_id FROM reset_meetings)');
    await client.query(`
      UPDATE appointments
      SET status = 'requested', start_at = NULL, end_at = NULL,
          scheduled_by = NULL, reason = NULL, agent_reasoning = NULL
      WHERE id IN (SELECT appointment_id FROM reset_meetings)
    `);
    await audit(req.session.user.id, 'meetings_reset_for_review', 'evaluation_run', null,
      { source: 'advisor_portal', reset_fraction: 0.5 }, req.ip, client);
  });

  res.redirect('/advisor/meetings?reset=1');
});

app.post('/advisor/apply-true-meetings', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(403).render('error', { title: 'Forbidden', message: 'No advisor record.' });

  const meetingAnswers = readMeetingAnswers();
  await tx(async (client) => {
    await client.query('DELETE FROM ai_suggestions WHERE appointment_id IS NOT NULL');
    // Clear the old slots first so moving a case cannot collide with its own
    // previous schedule while the true answers are being restored.
    await client.query(`
      UPDATE appointments
      SET status = 'requested', start_at = NULL, end_at = NULL,
          scheduled_by = NULL, reason = NULL, agent_reasoning = NULL
      WHERE id IN (SELECT appointment_id FROM meeting_test_cases)
    `);
    for (const answer of meetingAnswers) {
      if (answer.expected_decision === 'scheduled') {
        const start = new Date(`${answer.preferred_date}T${answer.preferred_time}:00Z`);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        await client.query(`
          UPDATE appointments
          SET status = 'scheduled', start_at = $1, end_at = $2,
              scheduled_by = $3, agent_reasoning = $4
          WHERE id = $5
        `, [start.toISOString(), end.toISOString(), req.session.user.id, answer.expected_reason, answer.appointment_id]);
      } else {
        await client.query(`
          UPDATE appointments
          SET status = 'rejected', start_at = NULL, end_at = NULL,
              scheduled_by = $1, agent_reasoning = $2
          WHERE id = $3
        `, [req.session.user.id, answer.expected_reason, answer.appointment_id]);
      }
    }

    await audit(req.session.user.id, 'true_meetings_applied', 'evaluation_run', null,
      { meetings: meetingAnswers.length, source: 'advisor_portal' }, req.ip, client);
  });

  res.redirect('/advisor/meetings?applied=1');
});


app.post('/advisor/apply-true-answers', requireRole('advisor'), async (req, res) => {
  const advisor = await advisorForUser(req.session.user.id);
  if (!advisor) return res.status(403).render('error', { title: 'Forbidden', message: 'No advisor record.' });

  const answers = readTrueAnswers();
  await tx(async (client) => {
    await client.query('DELETE FROM decisions');
    await client.query('DELETE FROM ai_suggestions WHERE form_id IS NOT NULL');
    for (const answer of answers) {
      const status = answer.expected_decision === 'approved' ? 'approved' : 'rejected';
      const decision = status === 'approved' ? 'accept' : 'reject';
      const form = await client.query(`
        SELECT f.*, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing
        FROM forms f JOIN students s ON s.id = f.student_id
        WHERE f.id = $1
      `, [answer.form_id]);
      if (!form.rowCount) continue;
      const row = form.rows[0];

      await client.query(`
        UPDATE forms
        SET status = $1, decision = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $5
      `, [status, decision, req.session.user.id, answer.expected_reason, answer.form_id]);

      await insertDecision(client, {
        formId: answer.form_id, actorId: req.session.user.id, advisorId: row.assigned_advisor_id,
        action: decision, reason: answer.expected_reason, form: row
      });
    }

    await audit(req.session.user.id, 'true_answers_applied', 'evaluation_run', null,
      { forms: answers.length, scope: 'forms', source: 'advisor_portal' }, req.ip, client);
  });

  res.redirect('/advisor?applied=1');
});

app.get('/professor', requireRole('professor'), async (req, res) => {
  const professor = await professorForUser(req.session.user.id);
  if (!professor) return res.status(404).render('error', { title: 'Not found', message: 'No professor record.' });

  const sections = await many(`
    SELECT sec.*, c.code, c.title, c.credits
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    WHERE sec.professor_id = $1
    ORDER BY sec.term DESC, c.code
  `, [professor.id]);

  const overrides = await many(`
    SELECT o.*, u.display_name AS student_name, s.student_no, c.code, c.title, sec.term
    FROM overrides o
    JOIN students s ON s.id = o.student_id
    JOIN users u ON u.id = s.user_id
    JOIN sections sec ON sec.id = o.section_id
    JOIN courses c ON c.id = sec.course_id
    WHERE o.professor_id = $1
    ORDER BY o.submitted_at
  `, [professor.id]);

  const meetings = await many(`
    SELECT ap.*, s.student_no, u.display_name AS student_name
    FROM appointments ap
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    WHERE ap.professor_id = $1 AND ap.status IN ('scheduled', 'booked')
    ORDER BY ap.start_at
  `, [professor.id]);

  res.render('professor/dashboard', { title: 'Professor', professor, sections, overrides, meetings });
});

app.get('/students/new', requireAnyRole(['advisor', 'professor']), (req, res) => {
  res.render('students/new', { title: 'New student' });
});

app.post('/students/new', requireAnyRole(['advisor', 'professor']), async (req, res) => {
  const displayName = String(req.body.display_name || '').trim().slice(0, 120);
  const program = String(req.body.program || '');
  const campus = String(req.body.campus || '');
  const email = String(req.body.email || '').trim().slice(0, 160) || null;

  if (!displayName) return res.status(400).render('error', { title: 'Bad request', message: 'Name is required.' });
  if (!['BS Computer Science', 'BS Business Administration'].includes(program)) {
    return res.status(400).render('error', { title: 'Bad request', message: 'Choose a program.' });
  }
  if (!['Beirut', 'Byblos'].includes(campus)) {
    return res.status(400).render('error', { title: 'Bad request', message: 'Choose a campus.' });
  }

  const creator = req.session.user;
  let advisorId;
  if (creator.role === 'advisor') {
    advisorId = (await advisorForUser(creator.id))?.id;
  } else {
    advisorId = (await one('SELECT id FROM advisors ORDER BY id LIMIT 1'))?.id;
  }

  let seq = Number((await one('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM students')).next);
  let username = `student${seq}`;
  while (await one('SELECT 1 FROM users WHERE username = $1', [username])) {
    seq += 1;
    username = `student${seq}`;
  }
  const studentNo = `S2026${String(seq).padStart(4, '0')}`;
  const passwordHash = hashPassword('1234');
  const capp = emptyCapp(program);

  const created = await tx(async (client) => {
    const userRow = await client.query(
      'INSERT INTO users (username, password_hash, role, display_name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [username, passwordHash, 'student', displayName, email]
    );
    const userId = userRow.rows[0].id;

    const studentRow = await client.query(
      `INSERT INTO students (user_id, student_no, program, catalog_year, campus, advisor_id, cumulative_gpa, standing, source_dataset, source_record_id)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'good', 'Created in portal', NULL) RETURNING id`,
      [userId, studentNo, program, '2025-2026', campus, advisorId]
    );
    const studentId = studentRow.rows[0].id;

    await client.query(
      `INSERT INTO degree_audits (student_id, catalog_year, program, total_required, total_earned, gpa, data_json, source_dataset)
       VALUES ($1, $2, $3, 120, 0, 0, $4, 'Created in portal')`,
      [studentId, '2025-2026', program, JSON.stringify(capp)]
    );

    await audit(creator.id, 'student_created', 'student', studentId, { username, program }, req.ip, client);
    return { username, studentNo, studentId };
  });

  res.render('students/created', {
    title: 'Student created',
    student: { display_name: displayName, program, campus, student_no: created.studentNo },
    username: created.username
  });
});

app.use('/api/agent/v1', requireAgentKey);

app.get('/api/agent/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'pseudoportal', database: 'postgresql', time: new Date().toISOString() });
});

// External API callers can request approval, but they never receive the review code.
// Only the local dashboard, using the dashboard key, can see the code and
// approve or reject the exact action.
app.post('/api/agent/v1/approvals', async (req, res) => {
  const action = String(req.body.action || '').trim().slice(0, 80);
  const objectType = String(req.body.object_type || '').trim().slice(0, 40);
  const objectId = Number(req.body.object_id);
  const summary = String(req.body.summary || '').trim().slice(0, 500);
  const details = req.body.details && typeof req.body.details === 'object' ? req.body.details : {};
  const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  if (!action || !objectType || !Number.isInteger(objectId)) {
    return res.status(400).json({ status: 'failed', message: 'invalid approval request' });
  }

  // Only form decisions and meeting scheduling require a review code. Message
  // replies are deliberately not approval-gated.
  const reviewable = (objectType === 'form' && (action === 'submit' || action === 'accept' || action === 'reject'))
    || (objectType === 'meeting' && (action === 'schedule' || action === 'create_professor_meeting'));
  if (!reviewable) {
    return res.status(400).json({ status: 'failed', message: 'this action does not require review' });
  }

  const actor = await approvalActor(objectType, objectId, action);
  if (!actor) {
    return res.status(400).json({ status: 'failed', message: 'cannot determine the authorizing account' });
  }
  const studentId = await approvalStudentId(objectType, objectId, action);

  const duplicate = await one(`
    SELECT request_id, expires_at FROM agent_approvals
    WHERE status = 'pending' AND object_type = $1 AND object_id = $2 AND action = $3
      AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 1
  `, [objectType, objectId, action]);
  if (duplicate) {
    return res.json({
      status: 'pending',
      request_id: duplicate.request_id,
      expires_at: duplicate.expires_at,
      message: 'This action is already waiting for review.'
    });
  }

  if (studentId) {
    const pending = await one(`
      SELECT COUNT(*)::int AS n FROM agent_approvals
      WHERE student_id = $1 AND status = 'pending' AND expires_at > NOW()
    `, [studentId]);
    if (pending.n >= 3) {
      return res.status(429).json({
        status: 'rate_limited',
        message: 'Too many actions are already waiting for review for this student.'
      });
    }
    const recent = await one(`
      SELECT COUNT(*)::int AS n FROM agent_approvals
      WHERE student_id = $1 AND created_at > NOW() - INTERVAL '1 minute'
    `, [studentId]);
    if (recent.n >= 3) {
      return res.status(429).json({
        status: 'rate_limited',
        message: 'Too many approval requests in a short time. Please wait before trying again.'
      });
    }
  }

  const requestId = crypto.randomUUID();
  const code = String(crypto.randomInt(100000, 1000000));
  const row = await one(`
    INSERT INTO agent_approvals (
      request_id, code, status, action, object_type, object_id, student_id,
      actor_id, actor_role, summary, details, payload, expires_at
    ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + INTERVAL '5 minutes')
    RETURNING request_id, expires_at
  `, [requestId, code, action, objectType, objectId, studentId, actor.actor_id, actor.role, summary, JSON.stringify(details), JSON.stringify(payload)]);

  await audit(actor.actor_id, 'approval_requested', objectType, objectId, { action, request_id: requestId }, req.ip);
  return res.json({ status: 'pending', request_id: row.request_id, expires_at: row.expires_at });
});

app.get('/api/agent/v1/approvals/:requestId', async (req, res) => {
  let row = await one('SELECT * FROM agent_approvals WHERE request_id = $1', [String(req.params.requestId)]);
  if (!row) return res.status(404).json({ status: 'failed', message: 'approval not found' });
  row = await expiredApproval(row);

  return res.json({
    status: row.status,
    request_id: row.request_id,
    action: row.action,
    object_type: row.object_type,
    object_id: row.object_id,
    expires_at: row.expires_at,
    used_at: row.used_at || null
  });
});

// The portal, not the external caller, performs the write. It claims the
// approved row exactly once, then executes the action stored with that row.
app.post('/api/agent/v1/approvals/:requestId/execute', async (req, res) => {
  let row = await one('SELECT * FROM agent_approvals WHERE request_id = $1', [String(req.params.requestId)]);
  if (!row) return res.status(404).json({ status: 'failed', message: 'approval not found' });
  row = await expiredApproval(row);
  if (row.status !== 'approved') {
    return res.status(409).json({ status: 'failed', message: `approval is ${row.status}` });
  }
  if (row.used_at) {
    return res.status(409).json({ status: 'failed', message: 'approval already used' });
  }

  const claimed = await query(`
    UPDATE agent_approvals
    SET used_at = NOW()
    WHERE id = $1 AND status = 'approved' AND used_at IS NULL
    RETURNING *
  `, [row.id]);
  if (!claimed.rowCount) {
    return res.status(409).json({ status: 'failed', message: 'approval already used' });
  }

  try {
    const result = await executeApprovedAction(claimed.rows[0]);
    return res.json({ status: 'accepted', message: 'accepted and data stored', ...result });
  } catch (error) {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored', reason: error.message });
  }
});

app.get('/api/approvals', requireDashboardKey, async (req, res) => {
  await query(`
    UPDATE agent_approvals SET status = 'expired'
    WHERE status = 'pending' AND expires_at < NOW()
  `);
  const rows = await many(`
    SELECT request_id, code, status, action, object_type, object_id, actor_role,
           summary, details, created_at, expires_at
    FROM agent_approvals
    WHERE status = 'pending'
    ORDER BY created_at
  `);
  res.json({ approvals: rows });
});

app.post('/api/approvals/:requestId/approve', requireDashboardKey, async (req, res) => {
  const row = await one('SELECT * FROM agent_approvals WHERE request_id = $1', [String(req.params.requestId)]);
  if (!row) return res.status(404).json({ status: 'failed', message: 'approval not found' });
  const current = await expiredApproval(row);
  if (current.status !== 'pending') {
    return res.status(409).json({ status: 'failed', message: `approval is ${current.status}` });
  }
  if (String(req.body.code || '') !== String(row.code)) {
    return res.status(403).json({ status: 'failed', message: 'wrong review code' });
  }

  await query(`
    UPDATE agent_approvals
    SET status = 'approved', approved_at = NOW()
    WHERE id = $1 AND status = 'pending'
  `, [row.id]);
  await audit(row.actor_id, 'approval_approved', row.object_type, row.object_id,
    { action: row.action, request_id: row.request_id, source: 'review_dashboard' }, req.ip);
  res.json({ status: 'approved', request_id: row.request_id });
});

app.post('/api/approvals/:requestId/reject', requireDashboardKey, async (req, res) => {
  const row = await one('SELECT * FROM agent_approvals WHERE request_id = $1', [String(req.params.requestId)]);
  if (!row) return res.status(404).json({ status: 'failed', message: 'approval not found' });
  const current = await expiredApproval(row);
  if (current.status !== 'pending') {
    return res.status(409).json({ status: 'failed', message: `approval is ${current.status}` });
  }

  await query(`
    UPDATE agent_approvals
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = $1 AND status = 'pending'
  `, [row.id]);
  if (row.action === 'schedule' && row.object_type === 'meeting') {
    await query(`
      UPDATE appointments
      SET status = 'rejected', start_at = NULL, end_at = NULL, scheduled_by = NULL,
          agent_reasoning = NULL, reason = 'Meeting request rejected during review.'
      WHERE id = $1 AND status = 'requested'
    `, [row.object_id]);
  }
  await audit(row.actor_id, 'approval_rejected', row.object_type, row.object_id,
    { action: row.action, request_id: row.request_id, source: 'review_dashboard' }, req.ip);
  res.json({ status: 'rejected', request_id: row.request_id });
});

app.get('/api/agent/v1/suggestions', async (req, res) => {
  const rows = await many(`
    SELECT ai.*, f.type AS form_type_value, s.student_no, u.display_name AS student_name
    FROM ai_suggestions ai
    LEFT JOIN forms f ON f.id = ai.form_id
    LEFT JOIN appointments ap ON ap.id = ai.appointment_id
    LEFT JOIN students s ON s.id = ai.student_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE ai.status = 'pending'
    ORDER BY ai.created_at DESC
    LIMIT 100
  `);
  res.json({ suggestions: rows });
});

app.post('/api/agent/v1/suggestions', async (req, res) => {
  const kind = String(req.body.kind || '');
  if (!['form', 'meeting'].includes(kind)) return res.status(400).json({ status: 'failed', message: 'invalid kind' });
  const action = String(req.body.action || '').slice(0, 40);
  const payload = req.body.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
  const formId = req.body.form_id || null;
  const appointmentId = req.body.appointment_id || null;
  try {
    const suggestionId = await tx(async (client) => {
      if (kind === 'form') {
        const target = await client.query('SELECT status FROM forms WHERE id = $1', [formId]);
        if (!target.rowCount || target.rows[0].status !== 'pending') throw new Error('form is no longer pending');
      }
      if (kind === 'meeting') {
        // Serialize suggestion creation and reject any suggestion that would
        // overlap another pending suggestion for the same participant.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ayadvi_ai_meeting_suggestions'))");
        const meeting = await client.query(`
          SELECT student_id, advisor_id, professor_id FROM appointments WHERE id = $1
        `, [appointmentId]);
        if (!meeting.rowCount) throw new Error('meeting not found');
        const current = meeting.rows[0];
        const target = await client.query('SELECT status FROM appointments WHERE id = $1', [appointmentId]);
        if (!target.rowCount || target.rows[0].status !== 'requested') throw new Error('meeting is no longer pending');
        const parties = new Set([
          `student:${current.student_id}`,
          current.advisor_id ? `advisor:${current.advisor_id}` : null,
          current.professor_id ? `professor:${current.professor_id}` : null,
        ].filter(Boolean));
        const stamp = new Date(`${payload.date}T${payload.time}:00Z`).toISOString();
        const scheduled = await client.query(`
          SELECT student_id, advisor_id, professor_id FROM appointments
          WHERE status IN ('scheduled','booked') AND start_at = $1
        `, [stamp]);
        for (const row of scheduled.rows) {
          const otherParties = new Set([
            `student:${row.student_id}`,
            row.advisor_id ? `advisor:${row.advisor_id}` : null,
            row.professor_id ? `professor:${row.professor_id}` : null,
          ].filter(Boolean));
          if ([...parties].some((party) => otherParties.has(party))) {
            throw new Error('suggested slot conflicts with an existing meeting');
          }
        }
        const pending = await client.query(`
          SELECT ai.payload_json, ap.student_id, ap.advisor_id, ap.professor_id
          FROM ai_suggestions ai
          JOIN appointments ap ON ap.id = ai.appointment_id
          WHERE ai.kind = 'meeting' AND ai.status = 'pending'
        `);
        for (const row of pending.rows) {
          const other = row.payload_json || {};
          if (other.date !== payload.date || other.time !== payload.time) continue;
          const otherParties = new Set([
            `student:${row.student_id}`,
            row.advisor_id ? `advisor:${row.advisor_id}` : null,
            row.professor_id ? `professor:${row.professor_id}` : null,
          ].filter(Boolean));
          if ([...parties].some((party) => otherParties.has(party))) {
            throw new Error('suggested slot conflicts with another pending suggestion');
          }
        }
      }
      const inserted = await client.query(`
        INSERT INTO ai_suggestions (
          kind, form_id, appointment_id, advisor_id, student_id, action,
          payload_json, reasoning, model, profile_version, cold_start
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        kind, formId, appointmentId, String(req.body.advisor_id || ''),
        req.body.student_id || null, action, JSON.stringify(payload),
        String(req.body.reasoning || '').slice(0, 2000),
        String(req.body.model || '').slice(0, 100), req.body.profile_version || null,
        Boolean(req.body.cold_start)
      ]);
      return inserted.rows[0]?.id || null;
    });
    return res.json({ status: 'accepted', suggestion_id: suggestionId });
  } catch (error) {
    return res.status(409).json({ status: 'failed', message: error.message });
  }
});

app.get('/api/suggestions', requireDashboardKey, async (req, res) => {
  const rows = await many(`
    SELECT ai.*, f.type AS form_type_value, s.student_no, u.display_name AS student_name,
           ap.meeting_type, ap.preferred_date, ap.preferred_time
    FROM ai_suggestions ai
    LEFT JOIN forms f ON f.id = ai.form_id
    LEFT JOIN appointments ap ON ap.id = ai.appointment_id
    LEFT JOIN students s ON s.id = ai.student_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE ai.status = 'pending'
    ORDER BY ai.created_at DESC
    LIMIT 100
  `);
  res.json({ suggestions: rows });
});

app.post('/api/suggestions/:id/approve', requireDashboardKey, async (req, res) => {
  const id = Number(req.params.id);
  const suggestion = await one("SELECT * FROM ai_suggestions WHERE id = $1 AND status = 'pending'", [id]);
  if (!suggestion) return res.status(404).json({ status: 'failed', message: 'suggestion not found or already decided' });
  const payload = asObject(suggestion.payload_json, {});
  const advisor = Number(suggestion.advisor_id)
    ? await one('SELECT user_id FROM advisors WHERE id = $1', [Number(suggestion.advisor_id)])
    : null;
  const actorId = advisor?.user_id || 1;

  if (suggestion.kind === 'form') {
    const form = await one(`
      SELECT f.*, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing
      FROM forms f JOIN students s ON s.id = f.student_id
      WHERE f.id = $1
    `, [suggestion.form_id]);
    if (!form || form.status !== 'pending') {
      await query("UPDATE ai_suggestions SET status='superseded', decided_at=NOW() WHERE id=$1", [suggestion.id]);
      return res.status(409).json({ status: 'failed', message: 'form is no longer pending' });
    }
    const action = suggestion.action === 'accept' ? 'accept' : 'reject';
    const reason = String(payload.reason || suggestion.reasoning || 'Suggestion approved during review.').slice(0, 500);
    await tx(async (client) => {
      await client.query(`
        UPDATE forms SET status = $1, decision = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $5 AND status = 'pending'
      `, [action === 'accept' ? 'approved' : 'rejected', action, actorId, reason, form.id]);
      await insertDecision(client, {
        formId: form.id, actorId, advisorId: suggestion.advisor_id,
        action, reason, form, aiSuggestionId: suggestion.id
      });
      await client.query("UPDATE ai_suggestions SET status='approved', decided_at=NOW(), decided_by=$1 WHERE id=$2", [actorId, suggestion.id]);
      await audit(actorId, 'ai_suggestion_approved', 'form', form.id, { suggestion_id: suggestion.id }, req.ip, client);
    });
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  }

  if (suggestion.kind === 'meeting') {
    const meeting = await one("SELECT * FROM appointments WHERE id = $1 AND status = 'requested'", [suggestion.appointment_id]);
    if (!meeting) {
      await query("UPDATE ai_suggestions SET status='superseded', decided_at=NOW() WHERE id=$1", [suggestion.id]);
      return res.status(409).json({ status: 'failed', message: 'meeting is no longer pending' });
    }
    const date = String(payload.date || '').slice(0, 10);
    const time = String(payload.time || '');
    const staffType = meeting.meeting_type === 'professor' ? 'professor' : 'advisor';
    const staffId = staffType === 'professor' ? meeting.professor_id : meeting.advisor_id;
    const slots = await availableSlots({ date, studentId: meeting.student_id, staffType, staffId, advisorId: meeting.meeting_type === 'professor' ? meeting.advisor_id : null });
    if (!slots.includes(time)) return res.status(409).json({ status: 'failed', message: 'suggested slot is no longer available' });
    const start = new Date(`${date}T${time}:00Z`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await tx(async (client) => {
      await client.query(`
        UPDATE appointments SET status='scheduled', start_at=$1, end_at=$2,
          scheduled_by=$3, agent_reasoning=$4
        WHERE id=$5 AND status='requested'
      `, [start.toISOString(), end.toISOString(), actorId, suggestion.reasoning || null, meeting.id]);
      await client.query("INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1,$2,'advisor',$3)",
        [meeting.student_id, meeting.advisor_id, `Your meeting is scheduled for ${date} at ${time}.`]);
      await client.query("UPDATE ai_suggestions SET status='approved', decided_at=NOW(), decided_by=$1 WHERE id=$2", [actorId, suggestion.id]);
      await audit(actorId, 'ai_suggestion_approved', 'appointment', meeting.id, { suggestion_id: suggestion.id, date, time }, req.ip, client);
    });
    await supersedeMeetingSuggestions(meeting.id, suggestion.id);
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  }

  return res.status(400).json({ status: 'failed', message: 'unsupported suggestion' });
});

app.post('/api/suggestions/:id/reject', requireDashboardKey, async (req, res) => {
  const id = Number(req.params.id);
  const suggestion = await one("SELECT * FROM ai_suggestions WHERE id = $1 AND status = 'pending'", [id]);
  if (!suggestion) return res.status(404).json({ status: 'failed', message: 'suggestion not found or already decided' });
  await query("UPDATE ai_suggestions SET status='rejected', decided_at=NOW(), decided_by=1 WHERE id=$1", [id]);
  res.json({ status: 'rejected', suggestion_id: id });
});

app.get('/api/agent/v1/students', async (req, res) => {
  const rows = await many(`
    SELECT s.id, s.student_no, s.program, s.catalog_year, s.campus,
           s.cumulative_gpa::float8 AS cumulative_gpa, s.standing,
           s.source_dataset, s.source_record_id,
           u.display_name, u.email, a.id AS advisor_id, au.display_name AS advisor_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN advisors a ON a.id = s.advisor_id
    LEFT JOIN users au ON au.id = a.user_id
    ORDER BY s.id
  `);
  res.json({ students: rows });
});

app.get('/api/agent/v1/students/:id/snapshot', async (req, res) => {
  const student = await one(`
    SELECT s.*, s.cumulative_gpa::float8 AS cumulative_gpa,
           u.display_name, u.email, a.id AS advisor_id, au.display_name AS advisor_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN advisors a ON a.id = s.advisor_id
    LEFT JOIN users au ON au.id = a.user_id
    WHERE s.id = $1
  `, [Number(req.params.id)]);
  if (!student) return res.status(404).json({ error: 'student not found' });

  const enrollments = await many(`
    SELECT e.*, c.code, c.title, sec.term, sec.crn
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    WHERE e.student_id = $1
  `, [student.id]);
  const auditRow = await one('SELECT * FROM degree_audits WHERE student_id = $1', [student.id]);
  res.json({ student, enrollments, capp: asObject(auditRow?.data_json, null) });
});

app.get('/api/agent/v1/students/:id/capp', async (req, res) => {
  const row = await one('SELECT * FROM degree_audits WHERE student_id = $1', [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'capp not found' });
  res.json({ audit: asObject(row.data_json, null), source_dataset: row.source_dataset });
});

app.get('/api/agent/v1/cases', async (req, res) => {
  const rows = await many(`
    SELECT f.id, f.type, f.term, f.status, f.submitted_at, f.data_json,
           s.id AS student_id, s.student_no, s.cumulative_gpa::float8 AS cumulative_gpa,
           s.standing, u.display_name AS student_name, f.assigned_advisor_id
    FROM forms f
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    ORDER BY f.submitted_at
  `);
  res.json({ cases: rows.map((row) => ({ ...row, data: asObject(row.data_json) })) });
});

app.get('/api/agent/v1/cases/:id', async (req, res) => {
  const row = await one(`
    SELECT f.*, s.student_no, s.program, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing,
           u.display_name AS student_name
    FROM forms f
    JOIN students s ON s.id = f.student_id
    JOIN users u ON u.id = s.user_id
    WHERE f.id = $1
  `, [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'case not found' });
  const decisions = await many('SELECT * FROM decisions WHERE form_id = $1', [row.id]);
  res.json({ case: { ...row, data: asObject(row.data_json) }, decisions });
});

app.get('/api/agent/v1/courses', async (req, res) => {
  const rows = await many('SELECT * FROM courses ORDER BY code');
  res.json({ courses: rows });
});

app.get('/api/agent/v1/overrides', async (req, res) => {
  const rows = await many(`
    SELECT o.*, s.student_no, u.display_name AS student_name, c.code, c.title
    FROM overrides o
    JOIN students s ON s.id = o.student_id
    JOIN users u ON u.id = s.user_id
    JOIN sections sec ON sec.id = o.section_id
    JOIN courses c ON c.id = sec.course_id
    ORDER BY o.submitted_at
  `);
  res.json({ overrides: rows });
});

app.get('/api/agent/v1/form-templates', async (req, res) => {
  const rows = await many('SELECT * FROM form_templates ORDER BY id');
  res.json({ templates: rows });
});

app.get('/api/agent/v1/intents', async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
  const rows = await many('SELECT id, intent, text, lang, source FROM advising_intents ORDER BY id LIMIT $1', [limit]);
  res.json({ intents: rows });
});


app.get('/api/agent/v1/meetings', async (req, res) => {
  const where = ['1 = 1'];
  const params = [];
  if (req.query.student_id) { params.push(Number(req.query.student_id)); where.push(`ap.student_id = $${params.length}`); }
  if (req.query.advisor_id) { params.push(Number(req.query.advisor_id)); where.push(`ap.advisor_id = $${params.length}`); }
  if (req.query.professor_id) { params.push(Number(req.query.professor_id)); where.push(`ap.professor_id = $${params.length}`); }

  const rows = await many(`
    SELECT mt.case_code, ap.*, s.student_no, u.display_name AS student_name,
           au.display_name AS advisor_name, pu.display_name AS professor_name
    FROM appointments ap
    LEFT JOIN meeting_test_cases mt ON mt.appointment_id = ap.id
    JOIN students s ON s.id = ap.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN advisors a ON a.id = ap.advisor_id
    LEFT JOIN users au ON au.id = a.user_id
    LEFT JOIN professors p ON p.id = ap.professor_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(ap.start_at, ap.requested_at), ap.id
  `, params);
  res.json({ meetings: rows });
});

app.get('/api/agent/v1/students/:id/meetings', async (req, res) => {
  const rows = await many(`
    SELECT mt.case_code, ap.*, au.display_name AS advisor_name, pu.display_name AS professor_name
    FROM appointments ap
    LEFT JOIN meeting_test_cases mt ON mt.appointment_id = ap.id
    LEFT JOIN advisors a ON a.id = ap.advisor_id
    LEFT JOIN users au ON au.id = a.user_id
    LEFT JOIN professors p ON p.id = ap.professor_id
    LEFT JOIN users pu ON pu.id = p.user_id
    WHERE ap.student_id = $1
    ORDER BY COALESCE(ap.start_at, ap.requested_at), ap.id
  `, [Number(req.params.id)]);
  res.json({ meetings: rows });
});

app.get('/api/agent/v1/students/:id/meetings/availability', async (req, res) => {
  const student = await one('SELECT * FROM students WHERE id = $1', [Number(req.params.id)]);
  if (!student) return res.status(404).json({ error: 'student not found' });

  let meetingType = String(req.query.meeting_type || 'advisor') === 'professor' ? 'professor' : 'advisor';
  let professorId = Number(req.query.professor_id) || null;
  if (meetingType === 'professor' && !professorId) {
    const professor = await one(`
      SELECT sec.professor_id
      FROM enrollments e
      JOIN sections sec ON sec.id = e.section_id
      WHERE e.student_id = $1 AND e.status = 'enrolled' AND sec.professor_id IS NOT NULL
      ORDER BY CASE WHEN sec.term = '2026-Fall' THEN 0 ELSE 1 END, sec.id
      LIMIT 1
    `, [student.id]);
    professorId = professor?.professor_id || null;
    if (!professorId) meetingType = 'advisor';
  }

  const days = Math.min(5, Math.max(1, Number(req.query.days) || 3));
  const requestedDate = String(req.query.date || nextWeekday()).slice(0, 10);
  const cursor = new Date(`${requestedDate}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) return res.status(400).json({ error: 'invalid date' });

  const options = [];
  for (let checked = 0; checked < days * 2 && options.length < 3; checked += 1) {
    if (![0, 6].includes(cursor.getUTCDay())) {
      const date = cursor.toISOString().slice(0, 10);
      const staffId = meetingType === 'professor' ? professorId : student.advisor_id;
      const slots = await availableSlots({
        date,
        studentId: student.id,
        staffType: meetingType,
        staffId,
        advisorId: meetingType === 'professor' ? student.advisor_id : null,
      });
      if (slots.length) options.push({ date, slots });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  res.json({
    meeting_type: meetingType,
    staff_type: meetingType,
    staff_id: meetingType === 'professor' ? professorId : student.advisor_id,
    options,
  });
});


app.get('/api/agent/v1/advisors', async (req, res) => {
  const rows = await many(`
    SELECT a.id, a.user_id, a.department, u.display_name, u.email
    FROM advisors a JOIN users u ON u.id = a.user_id
    ORDER BY a.id
  `);
  res.json({ advisors: rows });
});

app.post('/api/agent/v1/meetings/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  if (!grantAllows(grant, 'advisor', 'meeting', id, 'reject')) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const advisor = await one('SELECT * FROM advisors WHERE user_id = $1', [Number(grant.actor_id)]);
  const meeting = await one('SELECT * FROM appointments WHERE id = $1 AND advisor_id = $2', [id, advisor?.id]);
  if (!meeting || meeting.status !== 'requested') {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }

  await query(`
    UPDATE appointments
    SET status = 'rejected', start_at = NULL, end_at = NULL, scheduled_by = $1, reason = $2
    WHERE id = $3
  `, [Number(grant.actor_id), String(req.body.reason || 'No available slot.').slice(0, 500), id]);
  await audit(Number(grant.actor_id), 'meeting_rejected', 'appointment', id, { source: 'api_grant' }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored' });
});

app.get('/api/agent/v1/meetings/:id/availability', async (req, res) => {
  const meeting = await one('SELECT * FROM appointments WHERE id = $1', [Number(req.params.id)]);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });

  const date = String(req.query.date || nextWeekday()).slice(0, 10);
  const staffType = meeting.meeting_type === 'professor' ? 'professor' : 'advisor';
  const staffId = staffType === 'professor' ? meeting.professor_id : meeting.advisor_id;
  const slots = await availableSlots({ date, studentId: meeting.student_id, staffType, staffId, advisorId: meeting.meeting_type === 'professor' ? meeting.advisor_id : null });
  res.json({ date, slots });
});

app.post('/api/agent/v1/meetings/:id/schedule', async (req, res) => {
  const id = Number(req.params.id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  if (!grantAllows(grant, 'advisor', 'meeting', id, 'schedule')) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const advisor = await one('SELECT * FROM advisors WHERE user_id = $1', [Number(grant.actor_id)]);
  const meeting = await one('SELECT * FROM appointments WHERE id = $1 AND advisor_id = $2', [id, advisor?.id]);
  if (!meeting || meeting.status !== 'requested') {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const date = String(req.body.date || '').slice(0, 10);
  const time = String(req.body.time || '');
  const staffType = meeting.meeting_type === 'professor' ? 'professor' : 'advisor';
  const staffId = staffType === 'professor' ? meeting.professor_id : meeting.advisor_id;
  const slots = await availableSlots({ date, studentId: meeting.student_id, staffType, staffId, advisorId: meeting.meeting_type === 'professor' ? meeting.advisor_id : null });
  if (!slots.includes(time)) {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored', reason: 'conflict', slots });
  }

  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const reasoning = String(req.body.reason || req.body.reasoning || '').trim().slice(0, 1000);
  try {
    await tx(async (client) => {
      await client.query(`
        UPDATE appointments
        SET status = 'scheduled', start_at = $1, end_at = $2, scheduled_by = $3, agent_reasoning = $5
        WHERE id = $4 AND status = 'requested'
      `, [start.toISOString(), end.toISOString(), Number(grant.actor_id), id, reasoning || null]);
      await client.query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
        [meeting.student_id, advisor.id, `Your meeting is scheduled for ${date} at ${time}.`]);
      await audit(Number(grant.actor_id), 'meeting_scheduled', 'appointment', id, { date, time, reason: reasoning, source: 'api_grant' }, req.ip, client);
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ status: 'failed', message: 'failed and data not stored', reason: 'conflict' });
    }
    throw error;
  }
  return res.json({ status: 'accepted', message: 'accepted and data stored' });
});

app.post('/api/agent/v1/meetings/professor', async (req, res) => {
  const studentId = Number(req.body.student_id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  if (!grantAllows(grant, 'advisor', 'meeting', studentId, 'create_professor_meeting')) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const advisor = await one('SELECT * FROM advisors WHERE user_id = $1', [Number(grant.actor_id)]);
  const student = await one('SELECT * FROM students WHERE id = $1 AND advisor_id = $2', [studentId, advisor?.id]);
  const professor = await one('SELECT * FROM professors WHERE id = $1', [Number(req.body.professor_id)]);
  if (!student || !professor) return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });

  const date = String(req.body.date || '').slice(0, 10);
  const time = String(req.body.time || '');
  const slots = await availableSlots({ date, studentId, staffType: 'professor', staffId: professor.id, advisorId: advisor.id });
  if (!slots.includes(time)) {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored', reason: 'conflict', slots });
  }

  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const row = await one(`
    INSERT INTO appointments (student_id, advisor_id, professor_id, meeting_type, requested_by, status, start_at, end_at, scheduled_by, reason)
    VALUES ($1, $2, $3, 'professor', 'advisor', 'scheduled', $4, $5, $6, $7) RETURNING id
  `, [studentId, advisor.id, professor.id, start.toISOString(), end.toISOString(), Number(grant.actor_id), String(req.body.reason || 'Meeting with professor')]);

  await query(`INSERT INTO messages (student_id, advisor_id, sender_role, body) VALUES ($1, $2, 'advisor', $3)`,
    [studentId, advisor.id, `Your meeting with a professor is scheduled for ${date} at ${time}.`]);
  await audit(Number(grant.actor_id), 'meeting_scheduled', 'appointment', row.id, { date, time, type: 'professor', source: 'api_grant' }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored', meeting_id: row.id });
});

app.post('/api/agent/v1/students/:id/meetings', async (req, res) => {
  const studentId = Number(req.params.id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  if (!grantAllows(grant, 'student', 'meeting', studentId, 'request')) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const student = await one('SELECT * FROM students WHERE id = $1 AND user_id = $2', [studentId, Number(grant.actor_id)]);
  if (!student) return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });

  const source = String(req.body.source || '').trim().slice(0, 40) || null;
  if (source === 'message') {
    const existing = await one(`
      SELECT id FROM appointments
      WHERE student_id = $1 AND source = 'message'
        AND status IN ('requested', 'scheduled', 'booked')
        AND requested_at > NOW() - INTERVAL '24 hours'
      ORDER BY requested_at DESC LIMIT 1
    `, [student.id]);
    if (existing) {
      return res.status(429).json({
        status: 'rate_limited',
        message: 'A meeting request from messaging already exists for this student.',
        meeting_id: existing.id
      });
    }
  }

  let meetingType = req.body.meeting_type === 'professor' ? 'professor' : 'advisor';
  let professorId = Number(req.body.professor_id) || null;
  if (meetingType === 'professor' && !professorId) {
    const professor = await one(`
      SELECT sec.professor_id
      FROM enrollments e
      JOIN sections sec ON sec.id = e.section_id
      WHERE e.student_id = $1 AND e.status = 'enrolled' AND sec.professor_id IS NOT NULL
      ORDER BY CASE WHEN sec.term = '2026-Fall' THEN 0 ELSE 1 END, sec.id
      LIMIT 1
    `, [student.id]);
    professorId = professor?.professor_id || null;
    if (!professorId) meetingType = 'advisor';
  }

  const row = await one(`
    INSERT INTO appointments (
      student_id, advisor_id, professor_id, meeting_type, requested_by,
      preferred_date, preferred_time, status, reason, source
    ) VALUES ($1, $2, $3, $4, 'student', $5, $6, 'requested', $7, $8)
    RETURNING id
  `, [
    student.id,
    student.advisor_id,
    meetingType === 'professor' ? professorId : null,
    meetingType,
    String(req.body.preferred_date || '').slice(0, 20) || null,
    String(req.body.preferred_time || '').slice(0, 10) || null,
    String(req.body.reason || 'Meeting request').slice(0, 500),
    source
  ]);

  await audit(Number(grant.actor_id), 'meeting_requested', 'appointment', row.id,
    { source: source || 'api_grant', meeting_type: meetingType }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored', meeting_id: row.id });
});

app.get('/api/agent/v1/students/:id/messages', async (req, res) => {
  const rows = await many('SELECT * FROM messages WHERE student_id = $1 ORDER BY created_at', [Number(req.params.id)]);
  res.json({ messages: rows });
});

app.post('/api/agent/v1/students/:id/messages', async (req, res) => {
  const studentId = Number(req.params.id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  const advisorAllowed = grantAllows(grant, 'advisor', 'message', studentId, 'send');
  const studentAllowed = grantAllows(grant, 'student', 'message', studentId, 'send');
  if (!advisorAllowed && !studentAllowed) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const student = await one('SELECT * FROM students WHERE id = $1', [studentId]);
  if (!student) return res.status(404).json({ status: 'failed', message: 'failed and data not stored' });

  if (advisorAllowed) {
    const advisor = await one('SELECT * FROM advisors WHERE user_id = $1 AND id = $2', [Number(grant.actor_id), student.advisor_id]);
    if (!advisor) return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  } else if (student.user_id !== Number(grant.actor_id)) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });

  const replyTo = Number(req.body.reply_to_message_id);
  const row = await one(`
    INSERT INTO messages (student_id, advisor_id, sender_role, body)
    VALUES ($1, $2, $3, $4) RETURNING id
  `, [studentId, student.advisor_id, advisorAllowed ? 'advisor' : 'student', body]);

  if (Number.isInteger(replyTo)) {
    await query(`
      UPDATE messages SET read_at = NOW()
      WHERE id = $1 AND student_id = $2 AND sender_role = 'student'
    `, [replyTo, studentId]);
  }

  await audit(Number(grant.actor_id), 'message_sent', 'student', studentId,
    { source: 'api_grant', reply_to_message_id: Number.isInteger(replyTo) ? replyTo : null }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored', message_id: row.id });
});

// Replies are intentionally not approval-gated. The portal still validates the
// student, the assigned advisor, the body, and the message being answered.
app.post('/api/agent/v1/students/:id/messages/reply', async (req, res) => {
  const studentId = Number(req.params.id);
  const student = await one(`
    SELECT s.*, a.user_id AS advisor_user_id
    FROM students s JOIN advisors a ON a.id = s.advisor_id
    WHERE s.id = $1
  `, [studentId]);
  if (!student || !student.advisor_user_id) {
    return res.status(404).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  const replyTo = Number(req.body.reply_to_message_id);

  const row = await one(`
    INSERT INTO messages (student_id, advisor_id, sender_role, body)
    VALUES ($1, $2, 'advisor', $3) RETURNING id
  `, [studentId, student.advisor_id, body]);

  if (Number.isInteger(replyTo)) {
    await query(`
      UPDATE messages SET read_at = NOW()
      WHERE id = $1 AND student_id = $2 AND sender_role = 'student'
    `, [replyTo, studentId]);
  }

  await audit(student.advisor_user_id, 'message_sent', 'student', studentId,
    { source: 'api_reply', reply_to_message_id: Number.isInteger(replyTo) ? replyTo : null }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored', message_id: row.id });
});

app.post('/api/agent/v1/students/:id/forms', async (req, res) => {
  const studentId = Number(req.params.id);
  const grant = verifyGrant(req.get('x-agent-grant'));
  if (!grantAllows(grant, 'student', 'form', studentId, 'submit')) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const student = await one('SELECT * FROM students WHERE id = $1 AND user_id = $2', [studentId, Number(grant.actor_id)]);
  if (!student) return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });

  const type = String(req.body.type || 'OVERLOAD');
  if (!['OVERLOAD', 'PREREQ_OVERRIDE', 'SUBSTITUTION', 'LATE_ADD_DROP'].includes(type)) {
    return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const data = { ...req.body, type: undefined };
  delete data.type;
  const row = await one(`
    INSERT INTO forms (student_id, type, term, status, submitted_at, data_json, assigned_advisor_id)
    VALUES ($1, $2, '2026-Fall', 'pending', NOW(), $3, $4) RETURNING id
  `, [studentId, type, JSON.stringify(data), student.advisor_id]);

  await audit(Number(grant.actor_id), 'form_submitted', 'form', row.id, { type, source: 'api_grant' }, req.ip);
  return res.json({ status: 'accepted', message: 'accepted and data stored', form_id: row.id });
});


app.get('/api/agent/v1/messages', async (req, res) => {
  const unread = req.query.unread === 'true';
  const rows = await many(`
    SELECT m.*, s.student_no, u.display_name AS student_name
    FROM messages m
    JOIN students s ON s.id = m.student_id
    JOIN users u ON u.id = s.user_id
    WHERE ($1::boolean = false OR (m.sender_role = 'student' AND m.read_at IS NULL))
    ORDER BY m.created_at
  `, [unread]);
  res.json({ messages: rows });
});

app.post('/api/agent/v1/cases/:id/decision', async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body.action || '');
  const reason = String(req.body.reason || '').slice(0, 500);
  const grant = verifyGrant(req.get('x-agent-grant'));

  if (!grant || grant.role !== 'advisor' || grant.object_type !== 'form' || Number(grant.object_id) !== id || grant.action !== action) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const advisor = await one('SELECT * FROM advisors WHERE user_id = $1', [Number(grant.actor_id)]);
  const form = await one(`
    SELECT f.*, s.cumulative_gpa::float8 AS cumulative_gpa, s.standing
    FROM forms f JOIN students s ON s.id = f.student_id
    WHERE f.id = $1 AND f.assigned_advisor_id = $2
  `, [id, advisor?.id]);
  if (!form || form.status !== 'pending') {
    await audit(Number(grant.actor_id), 'decision_failed', 'form', id, { action, reason: 'not_found_or_not_pending' }, req.ip);
    return res.json({ status: 'failed', message: 'failed and data not stored' });
  }

  try {
    await tx(async (client) => {
      const updated = await client.query(`
        UPDATE forms SET status = $1, decision = $2, decided_by = $3, decided_at = NOW(), reason = $4
        WHERE id = $5 AND status = 'pending'
      `, [action === 'accept' ? 'approved' : 'rejected', action, Number(grant.actor_id), reason, id]);

      if (updated.rowCount !== 1) throw new Error('case state changed');

      await insertDecision(client, {
        formId: id, actorId: Number(grant.actor_id), advisorId: advisor.id,
        action, reason, form
      });

      await audit(Number(grant.actor_id), action === 'accept' ? 'form_approved' : 'form_rejected', 'form', id, { reason }, req.ip, client);
    });
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  } catch {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }
});

app.post('/api/agent/v1/overrides/:id/decision', async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body.action || '');
  const reason = String(req.body.reason || '').slice(0, 500);
  const grant = verifyGrant(req.get('x-agent-grant'));

  if (!grant || grant.role !== 'professor' || grant.object_type !== 'override' || Number(grant.object_id) !== id || grant.action !== action) {
    return res.status(403).json({ status: 'failed', message: 'failed and data not stored' });
  }
  if (!['approve', 'deny'].includes(action)) {
    return res.status(400).json({ status: 'failed', message: 'failed and data not stored' });
  }

  const professor = await one('SELECT * FROM professors WHERE user_id = $1', [Number(grant.actor_id)]);
  const override = await one('SELECT * FROM overrides WHERE id = $1 AND professor_id = $2', [id, professor?.id]);
  if (!override || override.status !== 'pending') {
    await audit(Number(grant.actor_id), 'override_failed', 'override', id, { action, reason: 'not_found_or_not_pending' }, req.ip);
    return res.json({ status: 'failed', message: 'failed and data not stored' });
  }

  try {
    await tx(async (client) => {
      const updated = await client.query(`
        UPDATE overrides SET status = $1, decision = $2, decided_at = NOW(), reason = $3
        WHERE id = $4 AND status = 'pending'
      `, [action === 'approve' ? 'approved' : 'denied', action, reason, id]);

      if (updated.rowCount !== 1) throw new Error('override state changed');
      await audit(Number(grant.actor_id), action === 'approve' ? 'override_approved' : 'override_denied', 'override', id, { reason }, req.ip, client);
    });
    return res.json({ status: 'accepted', message: 'accepted and data stored' });
  } catch {
    return res.status(409).json({ status: 'failed', message: 'failed and data not stored' });
  }
});

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'The page does not exist.' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', { title: 'Server error', message: 'Something went wrong.' });
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Pseudoportal running on http://localhost:${PORT}`);
      console.log('PostgreSQL connection:', process.env.DATABASE_URL || 'local project cluster on 5433');
    });
  })
  .catch((error) => {
    console.error('Database init failed:', error.message);
    process.exit(1);
  });
