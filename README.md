# AyADVI pseudoportal

A test portal for the advising agent. Student, advisor, and professor logins; PostgreSQL; a REST API; and mock data built from open datasets. The agent is a separate project.

The portal does **not** ask for a password to accept or reject. The portal
accepts a short-lived signed grant. For petition-form decisions and meeting
scheduling, the portal creates an approval row and executes the stored action
only after a human reviews a one-time code on the local agent dashboard. The code
is never returned to the agent/MCP. Message replies do not require approval.

## Requirements

- Node.js 26+
- PostgreSQL 18 (the project can start its own local cluster on port 5433)

## Run

Run everything from the code folder:

```bash
cd ..
source ./run.sh
```

Or run both portal instances only:

```bash
./run1.sh &
./run2.sh
```

- Student: `http://localhost:3000`
- Advisor / professor: `http://localhost:3001`

Or run one portal at a time:

```bash
source ./run1.sh   # student only, port 3000
source ./run2.sh   # advisor / professor only, port 3001
```

`run.sh`, `run1.sh`, and `run2.sh` install dependencies if needed and start PostgreSQL. They seed only when the database is empty, then add the extra 25 cases if missing. Use `npm run seed` only when you want to reset everything.

The individual commands are still available:

```bash
npm install
npm run db:start
npm run seed
npm start
```

Stop the local database with:

```bash
npm run db:stop
```

If you already have a PostgreSQL server, set `DATABASE_URL` and skip `db:start`.

## Logins

All accounts use password **1234**.

| Login | Role |
|---|---|
| `student1` | student |
| `advisor1` | advisor |
| `prof1` | professor |

## Two instances at once

From the code folder, `source ./run.sh` starts both portals against the same PostgreSQL database:

- `http://localhost:3000` — student
- `http://localhost:3001` — advisor / professor

They use different session cookie names (`ayadvi.sid.3000` and `ayadvi.sid.3001`), so you can stay logged in as `student1` in one tab and `advisor1` in another. A message or decision written through one instance appears in the other because both share the database.

The run scripts seed only when the database is empty. They then add the extra 25 cases if they are missing. Use `npm run seed` only when you want to reset everything.

## What `npm run seed` does

`seed` is the database seeding script. It drops the current test tables and reloads the base 25 students, courses, sections, enrollments, degree evaluations, forms, overrides, appointments, messages, and advising intents. `npm run add-cases` then adds 25 more students and form cases from the two higher-education UCI datasets. `npm run add-meeting-cases` adds 24 meeting test cases. Neither deletes the base data.

It does not touch the agent and does not touch a real portal. It is how you reset the test environment.

## The 50 students and their data

Full source list, licences, and the case-to-source-record map: `../../DATASETS.md`.

- 20 students come from the **Open University Learning Analytics Dataset (OULAD)**.
- 5 students come from the **UCI Student Performance** dataset.
- 15 students come from **UCI Predict Students' Dropout and Academic Success**.
- 10 students come from **UCI Higher Education Students Performance Evaluation**.
- Each `students` row stores `source_dataset` and `source_record_id` for provenance.

GPA is derived from real records:

- OULAD: average of the student's real assessment scores, mapped to a 4.0 scale.
- UCI Student Performance: the real `G3` final grade, mapped to a 4.0 scale.
- UCI Dropout/Success: the average of the two real semester grades, mapped to a 4.0 scale.
- UCI Higher Education Performance: the real `GRADE`, mapped to a 4.0 scale.

The degree evaluation is generated from the student's real enrollment and grade records, using a CAPP-style program structure. It is a test evaluation, not an official LAU audit.

## Real forms and advising chats

The `form_templates` table holds five real public form layouts:

- Course overload: Simmons University
- Change of major: Middle Georgia State University
- Course substitution: Shoreline Community College
- Prerequisite waiver: Cal State San Marcos
- Drop/add: University of Rochester

The `advising_intents` table holds 120 real advising questions from the Zenodo academic advising chatbot dataset (DOI 10.5281/zenodo.23657403).

## Meetings

Students can request a meeting from the dashboard with a reason and optional preferred date.

Advisors see **Meetings** in the navigation:

- Pending student requests, with **Schedule** and manual **Reject** actions.
- A date picker that shows only slots free for the student and the advisor.
- Scheduling a student–professor meeting after checking both the student's classes and the professor's classes.
- **Reset meetings**, **Apply true meetings**, and **Check meetings** controls, mirroring the form controls.
- A meeting case summary and the latest scheduled/rejected meeting decisions.

**Reset meetings** only returns the 24 meeting test cases to `requested`; form
decisions are untouched. The scheduling agent polls every 0.5 seconds, reasons
over the verified slots with the model, assigns a conflict-free time to each
request, and writes the result back through the grant-protected API. **Apply true
meetings** restores only the meeting outcomes
from `true-meeting-answers.json`. **Check meetings** compares the 24 meetings and
should show `24/24`.

When a student asks the messaging agent to schedule a meeting, the agent creates
a meeting request with `source = message`. Professor requests are linked to a
professor from the student's enrolled sections. The scheduling agent proposes a
conflict-free time and sends it to the agent dashboard for manual approval before
writing the schedule.

The conflict check uses the student's enrolled sections, the advisor's meetings,
the professor's sections and meetings, and existing scheduled meetings. One-hour
slots are offered between 09:00 and 16:00 on weekdays. If a requested time is
busy, the agent asks the model to choose the closest conflict-free alternative;
the manual scheduling page still asks the advisor to pick another slot when their
chosen time conflicts.

## Live updates

Student, advisor, and professor pages keep their message lists, forms, meetings,
override requests, and status summaries fresh without a browser reload. The page
polls the same URL every 1.5 seconds and replaces only the `data-live` sections,
so input forms and scroll position are left alone. Message panels show only the
latest five messages. Sending a student message uses a background request and
updates the live panel without a page reload.

## Advisor messages

Advisors see **Messages** in the navigation. Each thread is scoped to a student in their caseload. The advisor can read the student's messages and send a reply; the reply appears immediately in the student's dashboard.

## Creating a student

Advisors and professors see **New student** in the navigation. The form creates:

- a student user with a generated username,
- a student profile,
- a zero-credit degree evaluation,
- an audit row.

The new account uses password `1234`.

## Manual decisions vs agent decisions

There are two decision paths:

**Manual portal decision.** The advisor or professor opens a pending case and clicks Accept or Reject. No password is required. The portal records the decision and an audit row.

**Agent / MCP decision.** The agent calls the portal API with `X-API-Key` and a
short-lived `X-Agent-Grant`. The portal writes only with a valid grant.

For **petition-form decisions and meeting scheduling**, the flow does not use a
password:

1. The MCP tool creates an approval request.
2. The portal generates a 6-digit review code.
3. The code appears only on the local agent dashboard at `localhost:3002`.
4. A human enters the code and approves or rejects the exact action.
5. The MCP calls the portal execution endpoint. The portal claims the approved
   row exactly once and performs the stored write.

The code and approval record never enter the model context. A prompt injection in
a CAPP PDF, student message, or form cannot read the dashboard code or execute an
unapproved form decision or meeting. Normal message replies are sent directly and
are not approval-gated.

The messaging agent can also fill a petition form on a student's behalf. It
creates a `form submit` approval; after the dashboard code is approved, the
portal creates a pending form marked **filled by agent**, and the advisor can
review it in the queue.

Anti-spam limits are enforced by the portal: a student can have at most three
pending approvals, at most three approval requests per minute, and only one
message-sourced meeting request per 24 hours. A duplicate request for the same
action reuses the existing pending approval instead of creating another.

**Hybrid agent decisions (local benchmark).** The advising agent uses a
deterministic rule engine for routine forms. The scheduling agent sends the
verified availability slots to the cheap language model, which reasons about
the request and assigns a conflict-free date and time. The portal rechecks the
slot before writing, and partial unique indexes prevent overlapping meetings for
the student, advisor, or professor. The scheduling agent does not reject a
request just because the preferred time is busy; it assigns an alternative.

The advising and scheduling paths use a short-lived service grant minted from
`AGENT_GRANT_SECRET` in the local test harness. This is deliberately a test-only
credential: it is never shown to the model. Messaging writes go through the
dashboard approval-code flow instead. For production, set
`ENGINE_ENABLED=false`, remove the service secret from the agent runtime, and let
the host app mint grants only after authentication.

After **Reset queue** and **Reset meetings**, one full pass produces:

```
74/74
```

That is 100% on the prepared 74-case benchmark (50 forms + 24 meetings), not a
guarantee for unseen cases. The model's meeting reasoning is stored and shown in
the advisor portal's latest meeting decisions.

## Test cases

`npm run seed` creates 25 base form cases, `C01` to `C25`. `npm run add-cases` appends 25 more, `C26` to `C50`. `npm run add-meeting-cases` adds 24 meeting cases, `M01` to `M24`.

- overload: GPA, credits, probation, incompletes
- prerequisite: completed, minimum grade, missing, incomplete, in progress
- substitution: credits, level, documentation, Arabic/MEHE
- late add/drop: window, hold, capacity, credit cap

All 50 form cases are **already decided** as approved or rejected. The 24
meeting test cases are seeded as benchmark requests; after the scheduling agent
runs, every one has a conflict-free assigned time. `true-meeting-answers.json`
records those assigned times, so **Apply true meetings** restores a non-overlapping
schedule. The student data supports the recorded reason; for example, a rejected
overload has a GPA, credit count, probation status, or incomplete that justifies
rejection.

Form expectations are in `test_cases`; meeting expectations are in `meeting_test_cases`. After the scheduling agent assigns times, `npm run sync-meeting-answers` records the actual non-overlapping times and model reasoning in `true-meeting-answers.json`. `npm run cases` lists the 50 form cases.

```bash
npm run cases
npm run cases -- --json
```

To compare the agent's output, fill `agent-results.json` (see `agent-results.example.json`) and run:

```bash
npm run evaluate -- agent-results.json
```

The script reports matches, mismatches, agreement rate, expected approval rate, agent approval rate, and a confusion matrix. Results can use `case_code` or `form_id`, and decisions are normalised (`approve`, `accepted`, `yes` all count as approved; `decline`, `denied`, `no` all count as rejected).

## Preparing cases for an agent run

The advisor queue page has a **Reset queue** button and a **Check** button. The
Meetings page has the equivalent **Reset meetings**, **Apply true meetings**,
and **Check meetings** controls for only the 24 meeting cases.

**Reset queue**:

1. Deletes the current form `decisions` rows.
2. Sets every form back to `pending` with no decision.
3. Leaves every meeting appointment unchanged.

Use **Reset meetings** on the Meetings page to reset only the 24 meeting cases.

It does **not** archive or delete students, courses, messages, enrollments, degree evaluations, or `test_cases`.

The true answers are saved in **`true-answers.json`** and **`true-meeting-answers.json`**. Reset does not change those files.

**Apply true answers** reads both JSON files and restores every form decision and every meeting schedule/rejection. It is the fastest way to restore the baseline after a reset.

**Check** compares the current decisions with `true-answers.json` (forms) and `true-meeting-answers.json` (meetings). Its label updates to `Check x/total` — currently `Check 74/74` (50 forms + 24 meetings). Clicking it prints the mismatches to the browser console with case code, record id, expected result, actual result, status, and rule.

After the agent processes the pending cases, you can also fill `agent-results.json` and compare:

```bash
npm run evaluate -- agent-results.json
```

## Advisor test endpoints

These use the advisor session cookie, not the agent API key:

```
GET  /api/advisor/check-results   # 50 forms + 24 meetings
GET  /api/advisor/check-meetings  # 24 meetings
```

## Agent dashboard approval API

These endpoints use `X-Dashboard-Key`, not the agent API key. The dashboard is
the only place the review code is returned.

```
GET  /api/approvals
POST /api/approvals/:requestId/approve   {"code":"123456"}
POST /api/approvals/:requestId/reject
```

## Agent API

Read endpoints use `X-API-Key`. Decision endpoints also require `X-Agent-Grant`.
Messaging MCP write tools first use the approval endpoints; the review code is
only available to the dashboard with `X-Dashboard-Key`.

```
GET  /api/agent/v1/health
POST /api/agent/v1/approvals
GET  /api/agent/v1/approvals/:requestId
POST /api/agent/v1/approvals/:requestId/execute
GET  /api/agent/v1/advisors
GET  /api/agent/v1/students
GET  /api/agent/v1/students/:id/snapshot
GET  /api/agent/v1/students/:id/capp
GET  /api/agent/v1/cases
GET  /api/agent/v1/cases/:id
GET  /api/agent/v1/courses
GET  /api/agent/v1/overrides
GET  /api/agent/v1/form-templates
GET  /api/agent/v1/intents
GET  /api/agent/v1/meetings?student_id=
GET  /api/agent/v1/students/:id/meetings
GET  /api/agent/v1/meetings/:id/availability?date=
GET  /api/agent/v1/students/:id/messages
GET  /api/agent/v1/messages?unread=true

POST /api/agent/v1/cases/:id/decision
POST /api/agent/v1/overrides/:id/decision
POST /api/agent/v1/meetings/:id/schedule
POST /api/agent/v1/meetings/professor
POST /api/agent/v1/students/:id/meetings
POST /api/agent/v1/students/:id/messages
POST /api/agent/v1/students/:id/forms
```

Every write endpoint requires `X-API-Key` and an `X-Agent-Grant`. A grant is bound to the actor, role, object type, object id, action, and expiry.

| Action | Grant type | Object id | Action |
|---|---|---|---|
| Schedule an advisor meeting | `meeting` | appointment id | `schedule` |
| Create a professor meeting | `meeting` | student id | `create_professor_meeting` |
| Student requests a meeting | `meeting` | student id | `request` |
| Send a message | `message` | student id | `send` |
| Submit a form | `form` | student id | `submit` |
| Approve or reject a form | `form` | case id | `accept` or `reject` |
| Approve or deny an override | `override` | override id | `approve` or `deny` |

Example read:

```bash
curl -H "X-API-Key: dev-agent-key" \
  http://localhost:3000/api/agent/v1/students/1/snapshot
```

Example decision. The grant is minted by the host after authentication, or by
the portal after dashboard approval for messaging writes. For local testing
only, `scripts/make-grant.js` mints a two-minute grant:

```bash
GRANT=$(node scripts/make-grant.js --actor 1 --role advisor --type form --id 1 --action accept)

curl -X POST \
  -H "X-API-Key: dev-agent-key" \
  -H "X-Agent-Grant: $GRANT" \
  -H "Content-Type: application/json" \
  -d '{"action":"accept","reason":"meets requirements"}' \
  http://localhost:3000/api/agent/v1/cases/1/decision
```

The grant is bound to the actor, role, object type, object id, action, and expiry. A grant for case 1 cannot be reused on case 2.

## Notes

- All names are pseudonyms. All passwords are `1234`.
- No real LAU data is in this project.
- Advisors and professors can decide manually in the portal without a password. Other agent/MCP writes use a short-lived grant. Petition-form decisions and meeting scheduling use a review code shown only on the agent dashboard; normal message replies do not. The code never reaches the model.
- The project uses `pg` and PostgreSQL, not SQLite.
# pseudoportal
