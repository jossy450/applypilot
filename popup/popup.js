const M = globalThis.ApplyPilotMatcher;
const CORE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'city', 'country', 'linkedin', 'currentTitle'];

const statusEl = document.getElementById('profile-status');
const fillButton = document.getElementById('fill');
const resultEl = document.getElementById('result');

document.getElementById('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function showProfileStatus() {
  const { profile = {}, savedAnswers = [], settings = {} } = await chrome.storage.local.get(['profile', 'savedAnswers', 'settings']);
  const done = CORE_FIELDS.filter((key) => M.deriveValue(profile, key)).length;
  const percent = Math.round((done / CORE_FIELDS.length) * 100);
  const name = M.deriveValue(profile, 'fullName');

  statusEl.innerHTML = `
    <strong></strong>
    <div class="meter" aria-hidden="true"><span style="width:${percent}%"></span></div>
    <small>Profile ${percent}% complete · ${savedAnswers.length} saved answer(s) · AI drafting ${settings.aiEnabled && settings.apiKey ? 'on' : 'off'}</small>`;
  statusEl.querySelector('strong').textContent = name ? `Applying as ${name}` : 'Set up your profile first';
}

function setResult(message, tone) {
  resultEl.textContent = message;
  resultEl.className = tone || '';
}

fillButton.addEventListener('click', async () => {
  fillButton.disabled = true;
  setResult('Scanning the form…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['src/matcher.js', 'src/content.js'],
    });
    const totals = frames
      .map((frame) => frame.result)
      .filter(Boolean)
      .reduce((sum, r) => ({ total: sum.total + r.total, filled: sum.filled + r.filled, review: sum.review + r.review, manual: sum.manual + r.manual }),
        { total: 0, filled: 0, review: 0, manual: 0 });

    if (!totals.total) {
      setResult('No form fields found on this page.', 'error');
      return;
    }
    setResult(`Filled ${totals.filled}, ${totals.review} to check, ${totals.manual} need you. Review the panel on the page.`, 'ok');
    setTimeout(() => window.close(), 1800);
  } catch (err) {
    const restricted = /cannot access|cannot be scripted|chrome:\/\//i.test(err.message);
    setResult(restricted ? 'Chrome does not allow extensions to run on this page.' : err.message, 'error');
  } finally {
    fillButton.disabled = false;
  }
});

showProfileStatus();
