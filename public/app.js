document.querySelectorAll('.demo-btn').forEach((button) => {
  button.addEventListener('click', () => {
    const username = button.getAttribute('data-user');
    document.getElementById('username').value = username;
    document.getElementById('password').value = '1234';
    document.getElementById('password').focus();
  });
});

async function decideCase(action) {
  const reason = document.getElementById('decision-reason').value;
  const result = document.getElementById('decision-result');
  result.textContent = 'Working...';
  try {
    const response = await fetch(`/api/advisor/cases/${window.CASE_ID}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason })
    });
    const data = await response.json();
    result.textContent = data.message;
    if (data.status === 'accepted') {
      setTimeout(() => window.refreshLiveRegions ? window.refreshLiveRegions() : window.location.reload(), 400);
    }
  } catch {
    result.textContent = 'failed and data not stored';
  }
}

async function decideOverride(id, action) {
  const reason = document.getElementById('override-reason').value;
  const result = document.getElementById('override-result');
  result.textContent = 'Working...';
  try {
    const response = await fetch(`/api/professor/overrides/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason })
    });
    const data = await response.json();
    result.textContent = data.message;
    if (data.status === 'accepted') {
      setTimeout(() => window.refreshLiveRegions ? window.refreshLiveRegions() : window.location.reload(), 400);
    }
  } catch {
    result.textContent = 'failed and data not stored';
  }
}

window.decideCase = decideCase;
window.decideOverride = decideOverride;

function bindCheck(button, endpoint) {
  if (!button) return;

  const runCheck = async (logDetails) => {
    try {
      const response = await fetch(endpoint);
      const data = await response.json();
      button.textContent = `Check ${data.correct}/${data.total}`;
      button.title = `${data.decided} of ${data.total} cases decided`;

      if (logDetails) {
        console.log(`Check ${data.correct}/${data.total} · ${data.decided}/${data.total} decided`);
        if (data.wrong.length) {
          console.log(`${data.wrong.length} case(s) do not match the expected result:`);
          console.table(data.wrong.map((row) => ({
            kind: row.kind,
            case: row.case,
            record: row.form,
            expected: row.expected,
            actual: row.actual || 'pending',
            status: row.status,
            rule: row.rule
          })));
        } else {
          console.log('All cases match the expected result.');
        }
      }
    } catch (error) {
      button.textContent = 'Check failed';
      if (logDetails) console.error(error);
    }
  };

  button.addEventListener('click', () => runCheck(true));
  runCheck(false);
  setInterval(() => runCheck(false), 5000);
}

bindCheck(document.getElementById('check-results'), '/api/advisor/check-results');
bindCheck(document.getElementById('check-meetings'), '/api/advisor/check-meetings');

// Continuously refresh display-only regions without reloading the page.
const liveRegions = [...document.querySelectorAll('[data-live]')];
if (liveRegions.length) {
  let liveBusy = false;
  const syncLiveRegions = async (force = false) => {
    if (document.hidden || liveBusy) return;
    liveBusy = true;
    try {
      const response = await fetch(window.location.pathname + window.location.search, {
        cache: 'no-store',
        headers: { 'X-Live-Poll': '1' }
      });
      if (!response.ok) return;
      const documentText = await response.text();
      const nextDocument = new DOMParser().parseFromString(documentText, 'text/html');
      liveRegions.forEach((region) => {
        if (!region.id) return;
        if (!force && region.contains(document.activeElement)) return;
        const next = nextDocument.getElementById(region.id);
        if (next && next.hasAttribute('data-live') && next.innerHTML !== region.innerHTML) {
          region.innerHTML = next.innerHTML;
        }
      });
    } catch {
      // Keep the last good view; the next poll will retry.
    } finally {
      liveBusy = false;
    }
  };
  window.refreshLiveRegions = () => syncLiveRegions(true);
  setInterval(() => syncLiveRegions(false), 1500);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncLiveRegions(false);
  });
}

// Send a student message without a page reload.
const studentMessageForm = document.getElementById('student-message-form');
if (studentMessageForm) {
  studentMessageForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const textarea = document.getElementById('student-message-body');
    const result = document.getElementById('student-message-result');
    const button = studentMessageForm.querySelector('button[type="submit"]');
    const body = textarea.value.trim();
    if (!body) return;

    if (button) button.disabled = true;
    if (result) result.textContent = 'Sending...';
    try {
      const response = await fetch(studentMessageForm.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ body })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Send failed.');
      textarea.value = '';
      if (result) result.textContent = 'Message sent.';
      if (window.refreshLiveRegions) window.refreshLiveRegions();
    } catch (error) {
      if (result) result.textContent = error.message || 'Send failed.';
    } finally {
      if (button) button.disabled = false;
    }
  });
}
