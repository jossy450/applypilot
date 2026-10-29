// Records docs/demo.png: an animated PNG of ApplyPilot working through the
// demo form, frame by frame in headless Chromium. Run: npm run demo:record
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { animate } = require('./png');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'demo.png');

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+44 7700 900000',
  city: 'London',
  country: 'UK',
  linkedin: 'https://linkedin.com/in/ada',
  currentTitle: 'Senior Frontend Engineer',
  currentCompany: 'Analytical Engines Ltd',
  yearsExperience: '8',
  workAuthorization: 'Yes',
  sponsorship: 'No',
};
const SAVED_ANSWERS = [{
  question: 'Why do you want to work here?',
  answer: 'I want my work to make day-to-day life easier for people who care for others, and Northwind builds exactly that.',
}];
const DRAFT = 'At Analytical Engines I rebuilt our booking flow in React and cut drop-off by [ADD: percentage]. I am proud of it because I worked directly with reception staff to find where the old form confused them.';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(ROOT, 'demo', 'index.html')).href);

  await page.evaluate(({ profile, savedAnswers, draft }) => {
    window.chrome = {
      storage: { local: { get: async () => ({ profile, savedAnswers, settings: { aiEnabled: true, apiKey: 'demo' } }) } },
      runtime: { sendMessage: async () => ({ ok: true, text: draft }) },
    };
    const caption = document.createElement('div');
    caption.id = 'caption';
    caption.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;max-width:90%;' +
      'background:#0f172a;color:#fff;padding:10px 18px;border-radius:999px;font:600 15px system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(15,23,42,.3);white-space:nowrap';
    document.body.appendChild(caption);
  }, { profile: PROFILE, savedAnswers: SAVED_ANSWERS, draft: DRAFT });
  await page.addScriptTag({ path: path.join(ROOT, 'src', 'matcher.js') });

  const panel = () => page.evaluateHandle(() => document.getElementById('applypilot-host').shadowRoot);
  const frames = [];
  const frame = async (caption, delayMs = 2400) => {
    await page.evaluate((text) => (document.getElementById('caption').textContent = text), caption);
    await page.waitForTimeout(400); // let smooth scrolls settle
    frames.push({ png: await page.screenshot(), delayMs });
  };
  const scrollTo = (selector) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), selector);
  const showRow = async (text) => (await panel()).evaluate((root, t) => {
    const row = [...root.querySelectorAll('.row')].find((r) => r.textContent.includes(t));
    const list = root.querySelector('.list');
    list.scrollTop = row.offsetTop - list.offsetTop - 8;
  }, text);

  await frame('1 · Open a job application and click ApplyPilot', 2000);

  await page.evaluate((code) => (0, eval)(code), fs.readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8'));
  await frame('2 · It fills what it knows from your profile');

  await scrollTo('input[name=auth]');
  await frame('3 · Yes/No questions answered, saved answers reused');

  await (await panel()).evaluate((root) =>
    [...root.querySelectorAll('[data-action=draft]')].find((b) => b.previousElementSibling.textContent.includes('proud')).click());
  await page.waitForFunction(() => document.getElementById('proud').value !== '');
  await scrollTo('#proud');
  await showRow('proud');
  await frame('4 · Open questions drafted with Claude, with gaps marked [ADD: …]', 3000);

  await scrollTo('#gender');
  await frame('5 · Your CV and equal-opportunity answers stay with you');

  await page.setInputFiles('#cv', { name: 'Ada-Lovelace-CV.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await page.check('input[name=consent]');
  await page.click('button[type=submit]');
  await frame('6 · Submit is held until you approve', 2600);

  await (await panel()).evaluate((root) => {
    const box = root.querySelector('input[name=reviewed]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await frame('7 · You check the highlighted fields and approve', 2000);

  await (await panel()).evaluate((root) => root.querySelector('[data-action=approve]').click());
  await page.waitForSelector('#submitted', { state: 'visible' });
  await scrollTo('#submitted');
  await frame('✓ Submitted, on your terms', 3200);

  await browser.close();
  fs.writeFileSync(OUT, animate(frames));
  console.log(`${path.relative(ROOT, OUT)}: ${frames.length} frames, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
