// End-to-end checks in real Chromium:
//   1. the unpacked extension loads, and its options and popup pages work;
//   2. the content script fills the demo form, blocks submission, and only
//      lets it through after the user approves.
// Run with: npm run test:e2e  (needs `npx playwright install chromium` once)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const DEMO_URL = pathToFileURL(path.join(ROOT, 'demo', 'index.html')).href;
const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8');

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+44 7700 900000',
  city: 'London',
  country: 'UK',
  linkedin: 'https://linkedin.com/in/ada',
  currentTitle: 'Senior Engineer',
  currentCompany: 'Analytical Engines Ltd',
  yearsExperience: '8',
  workAuthorization: 'Yes',
  sponsorship: 'No',
};

test('extension loads; options page saves the profile; popup reads it', async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'applypilot-'));
  const context = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium', // the headless shell cannot load extensions
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.fill('#firstName', 'Ada');
    await options.fill('#lastName', 'Lovelace');
    await options.fill('#email', 'ada@example.com');
    await options.click('button[type=submit]');
    await options.waitForSelector('#status:has-text("Saved")');
    const { profile } = await worker.evaluate(() => chrome.storage.local.get('profile'));
    assert.equal(profile.email, 'ada@example.com');

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#profile-status strong:has-text("Ada Lovelace")');
  } finally {
    await context.close();
  }
});

test('fills the demo form and holds submission until approved', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto(DEMO_URL);

    // Stand-ins for the chrome.* APIs the content script uses.
    await page.evaluate((profile) => {
      window.__messages = [];
      window.chrome = {
        storage: { local: { get: async () => ({
          profile,
          savedAnswers: [{ question: 'Why do you want to work here?', answer: 'Because you help clinics.' }],
          settings: { aiEnabled: true, apiKey: 'test' },
        }) } },
        runtime: { sendMessage: async (message) => {
          window.__messages.push(message);
          return { ok: true, text: 'I built [ADD: project].' };
        } },
      };
    }, PROFILE);
    await page.addScriptTag({ path: path.join(ROOT, 'src', 'matcher.js') });
    const summary = await page.evaluate((code) => (0, eval)(code), CONTENT_JS);
    assert.equal(summary.filled, 12);

    const value = (selector) => page.inputValue(selector);
    assert.equal(await value('#fname'), 'Ada');
    assert.equal(await value('#email'), 'ada@example.com');
    assert.equal(await value('#country'), 'GB');
    assert.equal(await value('#why'), 'Because you help clinics.');
    assert.equal(await page.isChecked('input[name=auth][value="1"]'), true);
    assert.equal(await page.isChecked('input[name=sponsor][value="0"]'), true);
    assert.equal(await value('#gender'), '', 'equal-opportunity fields are left alone');

    const mark = (selector) => page.getAttribute(selector, 'data-applypilot');
    assert.equal(await mark('#fname'), 'filled');
    assert.equal(await mark('#why'), 'review');
    assert.equal(await mark('#cv'), 'file');
    assert.equal(await mark('#gender'), 'sensitive');

    const isSubmitted = () => page.isVisible('#submitted');
    const panel = await page.evaluateHandle(() => document.getElementById('applypilot-host').shadowRoot);

    // Submitting before approval is blocked.
    await page.click('button[type=submit]');
    assert.equal(await isSubmitted(), false);
    assert.match(await panel.evaluate((root) => root.querySelector('.notice').textContent), /paused/);

    // AI draft for an open question.
    await panel.evaluate((root) =>
      [...root.querySelectorAll('[data-action=draft]')].find((b) => b.previousElementSibling.textContent.includes('proud')).click());
    await page.waitForFunction(() => document.getElementById('proud').value !== '');
    assert.equal(await value('#proud'), 'I built [ADD: project].');
    assert.equal(await page.evaluate(() => window.__messages[0].question), 'Tell us about a frontend project you are proud of.');

    // Edits by the user are tracked.
    await page.fill('#city', 'Cambridge');
    assert.equal(await mark('#city'), 'edited');

    // Approve stays disabled until the review box is ticked.
    assert.equal(await panel.evaluate((root) => root.querySelector('[data-action=approve]').disabled), true);
    await panel.evaluate((root) => {
      const box = root.querySelector('input[name=reviewed]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.setInputFiles('#cv', { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    assert.equal(await mark('#cv'), 'attached');
    await page.check('input[name=consent]');
    await panel.evaluate((root) => root.querySelector('[data-action=approve]').click());
    await page.waitForSelector('#submitted', { state: 'visible' });

    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
