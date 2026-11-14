const { many } = require('../db');

const SLOTS = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayKey(date) {
  return DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function normalizeTime(value) {
  const [hour, minute] = String(value).split(':');
  return `${String(hour).padStart(2, '0')}:${String(minute || '00').padStart(2, '0')}`;
}

function parseSchedule(text) {
  if (!text) return null;
  const parts = String(text).trim().split(/\s+/);
  const time = normalizeTime(parts.pop());
  const days = parts.join(' ').split('/').map((day) => day.trim());
  return { days, time };
}

function matchesSchedule(schedule, date, time) {
  const parsed = parseSchedule(schedule);
  if (!parsed) return false;
  return parsed.days.includes(dayKey(date)) && parsed.time === normalizeTime(time);
}

function slotKey(date, time) {
  return `${date}T${time}:00.000Z`;
}

function appointmentKey(value) {
  return new Date(value).toISOString().slice(0, 16) + ':00.000Z';
}

async function studentBusy(studentId, date, time) {
  const sections = await many(`
    SELECT sec.schedule FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    WHERE e.student_id = $1 AND e.status = 'enrolled'
  `, [studentId]);
  if (sections.some((row) => matchesSchedule(row.schedule, date, time))) return true;

  const appointments = await many(`
    SELECT start_at FROM appointments
    WHERE student_id = $1 AND status IN ('scheduled', 'booked') AND start_at IS NOT NULL
  `, [studentId]);
  return appointments.some((row) => appointmentKey(row.start_at) === slotKey(date, time));
}

async function advisorBusy(advisorId, date, time) {
  const appointments = await many(`
    SELECT start_at FROM appointments
    WHERE advisor_id = $1 AND status IN ('scheduled', 'booked') AND start_at IS NOT NULL
  `, [advisorId]);
  return appointments.some((row) => appointmentKey(row.start_at) === slotKey(date, time));
}

async function professorBusy(professorId, date, time) {
  const sections = await many(`
    SELECT schedule FROM sections
    WHERE professor_id = $1 AND term = '2026-Fall'
  `, [professorId]);
  if (sections.some((row) => matchesSchedule(row.schedule, date, time))) return true;

  const appointments = await many(`
    SELECT start_at FROM appointments
    WHERE professor_id = $1 AND status IN ('scheduled', 'booked') AND start_at IS NOT NULL
  `, [professorId]);
  return appointments.some((row) => appointmentKey(row.start_at) === slotKey(date, time));
}

async function availableSlots({ date, studentId, staffType, staffId, advisorId = null }) {
  const result = [];
  for (const time of SLOTS) {
    if (await studentBusy(studentId, date, time)) continue;
    const busy = staffType === 'professor'
      ? await professorBusy(staffId, date, time)
      : await advisorBusy(staffId, date, time);
    if (busy) continue;
    // A professor meeting is arranged by the student's advisor. Treat the
    // advisor as a participant too, so we never book over their calendar.
    if (advisorId && await advisorBusy(advisorId, date, time)) continue;
    result.push(time);
  }
  return result;
}

function nextWeekday() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

module.exports = { SLOTS, availableSlots, nextWeekday, slotKey, studentBusy, advisorBusy, professorBusy };
