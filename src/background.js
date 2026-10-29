/*
 * ApplyPilot service worker.
 *
 * Drafts answers to open questions ("Why do you want to work here?") with the
 * Claude API, using the user's own API key. The extension has no build step,
 * so it calls the Messages API over fetch rather than bundling the SDK.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-5-5';

const SYSTEM_PROMPT = `You help a job applicant draft answers to questions on application forms.
Write in the first person, as the applicant, in a warm and specific professional voice.
Use only facts found in the applicant's profile and resume. Never invent employers, job titles, dates, degrees, numbers or achievements.
Where an answer needs a fact you do not have, leave a short placeholder in square brackets, such as [ADD: a project you led], so the applicant fills it in.
Tailor the answer to the role and company when the job page makes them clear.
Return only the answer text: no preamble, no headings, no markdown.
The applicant reviews and edits every draft before submitting.`;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'draftAnswer') return false;
  draftAnswer(message).then(
    (text) => sendResponse({ ok: true, text }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // keep the channel open for the async response
});

async function draftAnswer({ question, maxLength, page }) {
  const { profile = {}, settings = {} } = await chrome.storage.local.get(['profile', 'settings']);
  if (!settings.aiEnabled || !settings.apiKey) {
    throw new Error('Turn on AI drafting and add your Anthropic API key in ApplyPilot settings.');
  }

  const { resumeText = '', ...fields } = profile;
  const limit = maxLength ? `Keep the answer under ${maxLength} characters.` : 'Keep the answer under 200 words.';
  const userContent = [
    `<profile>\n${JSON.stringify(fields, null, 2)}\n</profile>`,
    `<resume>\n${resumeText || '(none provided)'}\n</resume>`,
    `<job_page title="${escapeAttr(page?.title)}" url="${escapeAttr(page?.url)}">\n${page?.text || ''}\n</job_page>`,
    `<question>${question}</question>`,
    limit,
  ].join('\n\n');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      // Required for calls made from a browser context with the user's own key.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || response.statusText;
    if (response.status === 401) throw new Error('Your Anthropic API key was rejected. Check it in ApplyPilot settings.');
    if (response.status === 429) throw new Error('Rate limited by the Claude API. Wait a moment and try again.');
    throw new Error(`Claude API error ${response.status}: ${detail}`);
  }
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to draft this one. Please answer it yourself.');
  }

  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new Error('Claude returned an empty draft. Try again.');
  if (data.stop_reason === 'max_tokens') return `${text} [DRAFT CUT OFF: finish this answer]`;
  return maxLength ? text.slice(0, maxLength) : text;
}

function escapeAttr(value) {
  return String(value || '').replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}
