const M = globalThis.ApplyPilotMatcher;

const form = document.getElementById('profile-form');
const groupsEl = document.getElementById('profile-groups');
const answersEl = document.getElementById('answers');
const answerTemplate = document.getElementById('answer-template');
const statusEl = document.getElementById('status');

function buildProfileFields() {
  const groups = [...new Set(M.FIELDS.map((f) => f.group))];
  for (const group of groups) {
    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `<legend>${group}</legend><div class="grid"></div>`;
    const grid = fieldset.querySelector('.grid');
    for (const field of M.FIELDS.filter((f) => f.group === group)) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<label for="${field.key}"></label><input id="${field.key}" name="${field.key}" type="${field.type || 'text'}">`;
      wrap.querySelector('label').textContent = field.label;
      grid.appendChild(wrap);
    }
    groupsEl.appendChild(fieldset);
  }
}

function addAnswerRow(entry = {}) {
  const row = answerTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('.question').value = entry.question || '';
  row.querySelector('.answer-text').value = entry.answer || '';
  row.querySelector('.remove').addEventListener('click', () => row.remove());
  answersEl.appendChild(row);
}

function readForm() {
  const profile = {};
  for (const field of M.FIELDS) profile[field.key] = form.elements[field.key].value.trim();
  profile.resumeText = form.elements.resumeText.value.trim();

  const savedAnswers = [...answersEl.querySelectorAll('.answer')]
    .map((row) => ({ question: row.querySelector('.question').value.trim(), answer: row.querySelector('.answer-text').value.trim() }))
    .filter((a) => a.question && a.answer);

  const settings = {
    aiEnabled: document.getElementById('aiEnabled').checked,
    apiKey: document.getElementById('apiKey').value.trim(),
  };
  return { profile, savedAnswers, settings };
}

function fillForm({ profile = {}, savedAnswers = [], settings = {} }) {
  for (const field of M.FIELDS) form.elements[field.key].value = profile[field.key] || '';
  form.elements.resumeText.value = profile.resumeText || '';
  answersEl.replaceChildren();
  savedAnswers.forEach(addAnswerRow);
  if (!savedAnswers.length) addAnswerRow();
  document.getElementById('aiEnabled').checked = Boolean(settings.aiEnabled);
  document.getElementById('apiKey').value = settings.apiKey || '';
}

function flash(message, isError) {
  statusEl.textContent = message;
  statusEl.className = isError ? 'error' : '';
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (statusEl.textContent = ''), 3000);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = readForm();
  if (data.settings.aiEnabled && !data.settings.apiKey) return flash('Add an API key to turn on AI drafting.', true);
  await chrome.storage.local.set(data);
  flash('Saved.');
});

document.getElementById('add-answer').addEventListener('click', () => addAnswerRow());

// Export leaves the API key out so the file is safe to keep as a backup.
document.getElementById('export').addEventListener('click', () => {
  const { profile, savedAnswers } = readForm();
  const blob = new Blob([JSON.stringify({ app: 'ApplyPilot', version: 1, profile, savedAnswers }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'applypilot-profile.json';
  link.click();
  URL.revokeObjectURL(link.href);
});

document.getElementById('import').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.profile !== 'object') throw new Error('Not an ApplyPilot export.');
    fillForm({ profile: data.profile, savedAnswers: data.savedAnswers || [], settings: readForm().settings });
    flash('Imported. Click Save to keep it.');
  } catch (err) {
    flash(`Import failed: ${err.message}`, true);
  }
});

buildProfileFields();
chrome.storage.local.get(['profile', 'savedAnswers', 'settings']).then(fillForm);
