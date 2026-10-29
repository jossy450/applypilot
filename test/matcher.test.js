const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/matcher.js');

const key = (signals) => (M.matchField(signals) || {}).key;

test('matches common labels to profile fields', () => {
  const cases = {
    'First name *': 'firstName',
    'Last Name': 'lastName',
    Surname: 'lastName',
    'Full legal name': 'fullName',
    Name: 'fullName',
    'Email address': 'email',
    'E-mail': 'email',
    'Mobile number': 'phone',
    'LinkedIn Profile': 'linkedin',
    'GitHub URL': 'github',
    'Portfolio / Website': 'website',
    'Current job title': 'currentTitle',
    'Current employer': 'currentCompany',
    'Street address': 'addressLine1',
    'Address line 2': 'addressLine2',
    'Town/City': 'city',
    'Postcode': 'postcode',
    'ZIP code': 'postcode',
    'County': 'state',
    'Country of residence': 'country',
    'Desired salary': 'salary',
    'What is your notice period?': 'noticePeriod',
    'How did you hear about this job?': 'howDidYouHear',
    'Years of professional experience': 'yearsExperience',
  };
  for (const [label, expected] of Object.entries(cases)) {
    assert.equal(key({ label, tag: 'input' }), expected, label);
  }
});

test('question rules win over location rules', () => {
  assert.equal(key({ label: 'Are you legally authorized to work in the United States?' }), 'workAuthorization');
  assert.equal(key({ label: 'Will you now or in the future require visa sponsorship to work in the UK?' }), 'sponsorship');
  assert.equal(key({ label: 'Are you willing to relocate to our London office?' }), 'relocate');
  assert.equal(key({ label: 'Email address' }), 'email');
});

test('autocomplete beats a misleading label', () => {
  assert.deepEqual(M.matchField({ label: 'Field 3', autocomplete: 'given-name' }), { key: 'firstName', confidence: 'high' });
  assert.equal(key({ autocomplete: 'shipping postal-code' }), 'postcode');
});

test('falls back to name/id with medium confidence', () => {
  assert.deepEqual(M.matchField({ name: 'job_application[first_name]' }), { key: 'firstName', confidence: 'medium' });
  assert.deepEqual(M.matchField({ id: 'candidateEmail' }), { key: 'email', confidence: 'medium' });
});

test('never matches sensitive or equal-opportunity fields', () => {
  for (const label of ['Gender', 'Race / ethnicity', 'Do you have a disability?', 'Veteran status', 'Date of birth', 'Social Security Number', 'Pronouns']) {
    assert.deepEqual(M.matchField({ label }), { sensitive: true }, label);
  }
  assert.deepEqual(M.matchField({ label: 'Choose one', name: 'eeo_gender' }), { sensitive: true });
});

test('does not mistake similar words for sensitive ones', () => {
  assert.equal(M.isSensitive('Homepage URL'), false);
  assert.equal(M.isSensitive('Tracing experience'), false);
  assert.equal(M.isSensitive('Your age'), true);
});

test('treats textareas as open questions', () => {
  assert.equal(M.matchField({ label: 'Tell us about a GitHub project you are proud of', tag: 'textarea' }), null);
  assert.equal(key({ label: 'Address', tag: 'textarea' }), 'addressLine1');
});

test('leaves unknown fields alone', () => {
  assert.equal(M.matchField({ label: 'Why do you want to work here?' }), null);
  assert.equal(M.matchField({}), null);
});

test('picks select and radio options', () => {
  const countries = [
    { text: 'Select a country', value: '' },
    { text: 'Nigeria', value: 'NG' },
    { text: 'United Kingdom', value: 'GB' },
    { text: 'United States of America', value: 'US' },
  ];
  assert.equal(M.pickOption(countries, 'UK'), 2);
  assert.equal(M.pickOption(countries, 'united kingdom'), 2);
  assert.equal(M.pickOption(countries, 'USA'), 3);
  assert.equal(M.pickOption(countries, 'NG'), 1);
  assert.equal(M.pickOption(countries, 'Mars'), -1);
  assert.equal(M.pickOption(countries, ''), -1);

  const yesNo = [
    { text: 'Yes, I am authorized to work', value: 'a' },
    { text: 'No, I will need sponsorship', value: 'b' },
  ];
  assert.equal(M.pickOption(yesNo, 'Yes'), 0);
  assert.equal(M.pickOption(yesNo, 'no'), 1);
  assert.equal(M.pickOption(yesNo, 'true'), 0);
});

test('derives names from whichever fields the profile has', () => {
  assert.equal(M.deriveValue({ firstName: 'Ada', lastName: 'Lovelace' }, 'fullName'), 'Ada Lovelace');
  assert.equal(M.deriveValue({ fullName: 'Ada King Lovelace' }, 'firstName'), 'Ada');
  assert.equal(M.deriveValue({ fullName: 'Ada King Lovelace' }, 'lastName'), 'Lovelace');
  assert.equal(M.deriveValue({ fullName: 'Ada' }, 'lastName'), '');
  assert.equal(M.deriveValue({ yearsExperience: 7 }, 'yearsExperience'), '7');
  assert.equal(M.deriveValue(undefined, 'email'), '');
});

test('finds saved answers by meaning-bearing words', () => {
  const saved = [
    { question: 'Why do you want to work here?', answer: 'Because…' },
    { question: 'Describe your biggest professional achievement', answer: 'I led…' },
    { question: 'Empty one', answer: '' },
  ];
  assert.equal(M.findSavedAnswer('Why do you want to work at Acme?', saved).answer, 'Because…');
  assert.equal(M.findSavedAnswer('What is your biggest professional achievement?', saved).answer, 'I led…');
  assert.equal(M.findSavedAnswer('What is your favourite colour?', saved), null);
  assert.equal(M.findSavedAnswer('Empty one', saved), null);
});

test('every rule key is a profile field', () => {
  const keys = new Set(M.FIELDS.map((f) => f.key));
  for (const label of ['First name', 'Email', 'Postcode', 'Country', 'Salary', 'Sponsorship']) {
    assert.ok(keys.has(key({ label })), label);
  }
});
