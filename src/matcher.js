/*
 * ApplyPilot field matcher.
 *
 * Pure functions with no DOM access, so the same file runs in the page (as a
 * content script), on the options page, and under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApplyPilotMatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Profile fields, in the order the options page shows them.
  const FIELDS = [
    { key: 'firstName', label: 'First name', group: 'Personal' },
    { key: 'lastName', label: 'Last name', group: 'Personal' },
    { key: 'fullName', label: 'Full name (if different from first + last)', group: 'Personal' },
    { key: 'email', label: 'Email', group: 'Personal', type: 'email' },
    { key: 'phone', label: 'Phone', group: 'Personal', type: 'tel' },
    { key: 'addressLine1', label: 'Address line 1', group: 'Address' },
    { key: 'addressLine2', label: 'Address line 2', group: 'Address' },
    { key: 'city', label: 'City / town', group: 'Address' },
    { key: 'state', label: 'State / county / region', group: 'Address' },
    { key: 'postcode', label: 'Postcode / ZIP', group: 'Address' },
    { key: 'country', label: 'Country', group: 'Address' },
    { key: 'linkedin', label: 'LinkedIn URL', group: 'Online', type: 'url' },
    { key: 'github', label: 'GitHub URL', group: 'Online', type: 'url' },
    { key: 'website', label: 'Portfolio / website', group: 'Online', type: 'url' },
    { key: 'currentTitle', label: 'Current job title', group: 'Work' },
    { key: 'currentCompany', label: 'Current company', group: 'Work' },
    { key: 'yearsExperience', label: 'Years of experience', group: 'Work' },
    { key: 'salary', label: 'Salary expectation', group: 'Work' },
    { key: 'noticePeriod', label: 'Notice period / earliest start', group: 'Work' },
    { key: 'workAuthorization', label: 'Authorized to work in your target country? (Yes/No)', group: 'Work' },
    { key: 'sponsorship', label: 'Need visa sponsorship? (Yes/No)', group: 'Work' },
    { key: 'relocate', label: 'Willing to relocate? (Yes/No)', group: 'Work' },
    { key: 'howDidYouHear', label: '"How did you hear about us?" default', group: 'Work' },
  ];

  // Order matters: the first rule that matches wins. Question-style rules come
  // before location rules so "authorized to work in the United States" is not
  // read as a "state" field, and email comes before address.
  const RULES = [
    { key: 'email', pattern: /\be ?mail\b/ },
    { key: 'sponsorship', pattern: /sponsor/ },
    { key: 'workAuthorization', pattern: /authori[sz]ed to work|right to work|eligible to work|legally (able|eligible|permitted)|work (permit|authori[sz]ation)/ },
    { key: 'relocate', pattern: /relocat/ },
    { key: 'salary', pattern: /salary|compensation|desired pay|pay expectation|expected pay|rate expectation/ },
    { key: 'noticePeriod', pattern: /notice period|earliest start|start date|when can you start|availability to start/ },
    { key: 'howDidYouHear', pattern: /how did you (hear|find|learn)|where did you (hear|find|see)|referral source/ },
    { key: 'yearsExperience', pattern: /years? (of )?(relevant |professional |work )?experience|experience (in )?years|how many years/ },
    { key: 'linkedin', pattern: /linked ?in/ },
    { key: 'github', pattern: /git ?hub/ },
    { key: 'website', pattern: /portfolio|website|personal (site|url|page)|\bblog\b/ },
    { key: 'phone', pattern: /phone|mobile|\btel(ephone)?\b|\bcell\b/ },
    { key: 'firstName', pattern: /first ?name|given ?name|forename|\bfname\b/ },
    { key: 'lastName', pattern: /last ?name|surname|family ?name|\blname\b/ },
    { key: 'fullName', pattern: /\bfull ?name\b|\blegal name\b|\byour name\b|\bcandidate name\b|^name$/ },
    { key: 'currentTitle', pattern: /current (job )?title|job title|current (role|position)|^title$/ },
    { key: 'currentCompany', pattern: /current (company|employer)|^company( name)?$|\bemployer\b/ },
    { key: 'addressLine2', pattern: /address (line )?2|apartment|\bapt\b|\bsuite\b/ },
    { key: 'addressLine1', pattern: /address|street/ },
    { key: 'city', pattern: /\bcity\b|\btown\b/ },
    { key: 'postcode', pattern: /\bzip\b|post ?code|postal/ },
    { key: 'state', pattern: /\bstate\b|province|\bcounty\b|\bregion\b/ },
    { key: 'country', pattern: /country/ },
  ];

  // HTML autocomplete tokens are the most reliable signal a form can give us.
  const AUTOCOMPLETE = {
    'given-name': 'firstName',
    'family-name': 'lastName',
    name: 'fullName',
    email: 'email',
    tel: 'phone',
    'tel-national': 'phone',
    'address-line1': 'addressLine1',
    'street-address': 'addressLine1',
    'address-line2': 'addressLine2',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'postcode',
    country: 'country',
    'country-name': 'country',
    organization: 'currentCompany',
    'organization-title': 'currentTitle',
    url: 'website',
  };

  // Fields ApplyPilot never fills: equal-opportunity questions, identity
  // numbers, and anything the applicant should answer deliberately.
  const SENSITIVE = /gender|\bsex\b|\brace\b|ethnic|disabilit|veteran|sexual orientation|pronoun|religio|date of birth|\bdob\b|birth ?date|\bage\b|social security|\bssn\b|national insurance|passport|password|criminal|convict|marital/;

  const PLACEHOLDER_OPTION = /^(select|choose|please (select|choose)|pick one|none selected)/;

  const ALIASES = {
    uk: 'united kingdom',
    gb: 'united kingdom',
    'great britain': 'united kingdom',
    us: 'united states',
    usa: 'united states',
    'united states of america': 'united states',
    y: 'yes',
    true: 'yes',
    n: 'no',
    false: 'no',
  };

  const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'at', 'is', 'are', 'do', 'you', 'your', 'us', 'our', 'we', 'with', 'this', 'please', 'what', 'why', 'how', 'would', 'tell', 'about']);

  function normalize(text) {
    return String(text || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  const canon = (s) => ALIASES[s] || s;

  function isSensitive(text) {
    return SENSITIVE.test(normalize(text));
  }

  function ruleFor(text) {
    if (!text) return null;
    const rule = RULES.find((r) => r.pattern.test(text));
    return rule ? rule.key : null;
  }

  /*
   * signals: { label, name, id, placeholder, ariaLabel, autocomplete, tag }
   * Returns { key, confidence } for a profile field, { sensitive: true } for a
   * field we must leave alone, or null for anything we cannot place (usually a
   * free-text question).
   */
  function matchField(signals) {
    const s = signals || {};
    const labelText = normalize(s.label || s.ariaLabel || s.placeholder);
    const attrText = normalize([s.name, s.id].filter(Boolean).join(' '));

    if (SENSITIVE.test(labelText) || SENSITIVE.test(attrText)) return { sensitive: true };

    const token = String(s.autocomplete || '').trim().toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[token]) return { key: AUTOCOMPLETE[token], confidence: 'high' };

    // Long-form answers are never profile fields, except a multi-line address.
    if (s.tag === 'textarea') {
      return ruleFor(labelText) === 'addressLine1' ? { key: 'addressLine1', confidence: 'medium' } : null;
    }

    const fromLabel = ruleFor(labelText);
    if (fromLabel) return { key: fromLabel, confidence: 'high' };
    const fromAttr = ruleFor(attrText);
    if (fromAttr) return { key: fromAttr, confidence: 'medium' };
    return null;
  }

  // options: [{ text, value }]. Returns the index of the best option, or -1.
  function pickOption(options, wanted) {
    const w = canon(normalize(wanted));
    if (!w) return -1;
    const usable = (options || [])
      .map((o, i) => ({ i, t: canon(normalize(o.text)), v: canon(normalize(o.value)) }))
      .filter((o) => o.t && !PLACEHOLDER_OPTION.test(o.t));

    let hit = usable.find((o) => o.t === w || o.v === w);
    // "Yes, I am authorized to work…" should match a profile value of "Yes".
    if (!hit && (w === 'yes' || w === 'no')) hit = usable.find((o) => o.t.split(' ')[0] === w);
    if (!hit) hit = usable.find((o) => o.t.startsWith(w) || w.startsWith(o.t));
    if (!hit && w.length >= 3) hit = usable.find((o) => o.t.includes(w));
    return hit ? hit.i : -1;
  }

  function deriveValue(profile, key) {
    const p = profile || {};
    const parts = String(p.fullName || '').trim().split(/\s+/).filter(Boolean);
    switch (key) {
      case 'fullName':
        return p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ');
      case 'firstName':
        return p.firstName || parts[0] || '';
      case 'lastName':
        return p.lastName || (parts.length > 1 ? parts[parts.length - 1] : '');
      default:
        return p[key] == null ? '' : String(p[key]).trim();
    }
  }

  function tokens(text) {
    return new Set(normalize(text).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t)));
  }

  // Jaccard similarity over meaningful words.
  function similarity(a, b) {
    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.size || !tb.size) return 0;
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    return shared / (ta.size + tb.size - shared);
  }

  // savedAnswers: [{ question, answer }]. Returns the closest one, or null.
  function findSavedAnswer(question, savedAnswers, threshold = 0.5) {
    let best = null;
    let bestScore = threshold;
    for (const entry of savedAnswers || []) {
      if (!entry || !entry.answer) continue;
      const score = similarity(question, entry.question);
      if (score >= bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  function fieldLabel(key) {
    const field = FIELDS.find((f) => f.key === key);
    return field ? field.label : key;
  }

  return { FIELDS, normalize, isSensitive, matchField, pickOption, deriveValue, similarity, findSavedAnswer, fieldLabel };
});
