/*
 * ApplyPilot content script. Injected on demand (only when the user clicks
 * "Fill & review" in the popup), after src/matcher.js.
 *
 * 1. Scans the page for form fields and fills the ones it can match to the
 *    user's profile or saved answers.
 * 2. Highlights every field it touched or skipped.
 * 3. Shows a review panel and blocks submission until the user approves.
 *
 * The value of the last expression is returned to the popup via
 * chrome.scripting.executeScript.
 */
(() => {
  'use strict';

  if (window.__applyPilot) return window.__applyPilot.run();

  const M = globalThis.ApplyPilotMatcher;

  const SKIP_TYPES = new Set(['hidden', 'password', 'submit', 'button', 'reset', 'image']);
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'number']);
  const SUBMIT_TEXT = /\b(submit|apply|send application|complete application|finish)\b/i;

  const STATUS = {
    filled: { label: 'Filled', tone: 'ok' },
    review: { label: 'Check this', tone: 'warn' },
    edited: { label: 'Edited by you', tone: 'warn' },
    kept: { label: 'Already filled', tone: 'muted' },
    manual: { label: 'Needs you', tone: 'bad' },
    file: { label: 'Upload yourself', tone: 'bad' },
    attached: { label: 'Attached by you', tone: 'ok' },
    sensitive: { label: 'Left for you', tone: 'private' },
  };
  const ATTENTION = new Set(['manual', 'file', 'sensitive', 'review', 'edited']);

  const state = {
    items: [],
    approved: false,
    reviewed: false,
    filling: false,
    settings: {},
    host: null,
    root: null,
    notice: '',
  };

  // ---------- reading the page ----------

  const text = (el) => (el && el.innerText ? el.innerText.replace(/\s+/g, ' ').trim() : '');

  function isVisible(el) {
    if (el.disabled || el.readOnly) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  }

  function labelFor(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.id) {
      const t = text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (t) return t;
    }
    const wrapping = text(el.closest('label'));
    if (wrapping) return wrapping;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();

    // Fall back to the nearest label-like element in the field's container.
    let box = el.parentElement;
    for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
      const candidate = box.querySelector('label, legend, [class*="label" i], [class*="question" i]');
      if (candidate && !candidate.contains(el) && text(candidate)) return text(candidate);
    }
    return '';
  }

  function optionLabelFor(input) {
    if (input.id) {
      const t = text(document.querySelector(`label[for="${CSS.escape(input.id)}"]`));
      if (t) return t;
    }
    return text(input.closest('label')) || input.getAttribute('aria-label') || input.value || '';
  }

  // The question a radio group answers: a fieldset legend, a labelled
  // radiogroup, or the first line of text around the group that is not an option.
  function groupLabel(radios, optionTexts) {
    const group = radios[0].closest('fieldset, [role="radiogroup"]');
    if (group) {
      const legend = text(group.querySelector('legend'));
      if (legend) return legend;
      const named = group.getAttribute('aria-label') || text(document.getElementById(group.getAttribute('aria-labelledby') || ''));
      if (named) return named;
    }
    let box = radios[0].parentElement;
    while (box && !radios.every((r) => box.contains(r))) box = box.parentElement;
    for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
      const lines = (box.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const question = lines.find((l) => !optionTexts.includes(l));
      if (question) return question;
    }
    return radios[0].name;
  }

  function currentValue(el) {
    if (el.tagName === 'SELECT') return el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '';
    return el.value;
  }

  function hasValue(el) {
    if (el.tagName === 'SELECT') {
      const t = currentValue(el);
      return Boolean(el.value) && !/^(select|choose|please)/i.test(t);
    }
    return el.value.trim() !== '';
  }

  // ---------- writing to the page ----------

  // Set the value through the native setter so React/Vue/Angular notice it.
  function setNative(el, value) {
    state.filling = true;
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      state.filling = false;
    }
  }

  function setValue(el, value) {
    if (el.tagName === 'SELECT') {
      const idx = M.pickOption([...el.options].map((o) => ({ text: o.text, value: o.value })), value);
      if (idx < 0) return false;
      setNative(el, el.options[idx].value);
      return true;
    }
    setNative(el, value);
    return true;
  }

  // ---------- scanning ----------

  function scan(profile, savedAnswers) {
    const items = [];
    const seenRadioGroups = new Set();
    const add = (item) => items.push({ id: items.length, ...item });

    for (const el of document.querySelectorAll('input, select, textarea')) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const tag = el.tagName.toLowerCase();

      // File inputs are usually visually hidden behind a styled button, so
      // check them before visibility. Browsers do not let extensions attach
      // files, which is the right call: the user picks their CV.
      if (type === 'file') {
        if (!el.disabled) add({ kind: 'file', els: [el], label: labelFor(el) || 'File upload', status: 'file' });
        continue;
      }
      if (SKIP_TYPES.has(type) || !isVisible(el)) continue;

      if (type === 'checkbox') {
        // Consent and terms boxes are the applicant's to tick.
        if (el.required && !el.checked) add({ kind: 'field', els: [el], label: labelFor(el) || 'Checkbox', status: 'manual' });
        continue;
      }

      if (type === 'radio') {
        if (!el.name || seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);
        add(scanRadioGroup(el, profile));
        continue;
      }

      if (tag !== 'select' && tag !== 'textarea' && !TEXT_TYPES.has(type)) continue;
      const item = scanField(el, tag, profile, savedAnswers);
      if (item) add(item);
    }
    return items;
  }

  function scanField(el, tag, profile, savedAnswers) {
    const label = labelFor(el);
    const display = label || el.placeholder || el.name || 'Unlabelled field';
    const match = M.matchField({
      label,
      name: el.name,
      id: el.id,
      placeholder: el.placeholder,
      autocomplete: el.getAttribute('autocomplete'),
      tag,
    });
    const base = { kind: 'field', els: [el], label: display };

    if (match && match.sensitive) return { ...base, status: 'sensitive' };
    if (hasValue(el)) return { ...base, status: 'kept', value: currentValue(el) };

    if (match && match.key) {
      const value = M.deriveValue(profile, match.key);
      if (!value) return { ...base, key: match.key, status: 'manual', note: `Add "${M.fieldLabel(match.key)}" to your profile to fill this next time.` };
      if (!setValue(el, value)) return { ...base, key: match.key, status: 'manual', note: `None of the options matched "${value}".` };
      return { ...base, key: match.key, value: currentValue(el), status: match.confidence === 'high' ? 'filled' : 'review' };
    }

    if (tag === 'select') return el.required ? { ...base, status: 'manual' } : null;

    // Anything else textual is an open question.
    const question = { ...base, kind: 'question' };
    const saved = M.findSavedAnswer(display, savedAnswers);
    if (saved) {
      setValue(el, saved.answer);
      return { ...question, value: el.value, status: 'review', note: 'From your saved answers.' };
    }
    return { ...question, status: 'manual' };
  }

  function scanRadioGroup(first, profile) {
    const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(first.name)}"]`)];
    const options = radios.map((r) => ({ text: optionLabelFor(r), value: r.value }));
    const label = groupLabel(radios, options.map((o) => o.text));
    const base = { kind: 'radio', els: radios, label };
    const match = M.matchField({ label, name: first.name, tag: 'input' });

    if (match && match.sensitive) return { ...base, status: 'sensitive' };
    const checked = radios.findIndex((r) => r.checked);
    if (checked >= 0) return { ...base, status: 'kept', value: options[checked].text };
    if (!match || !match.key) return { ...base, status: 'manual' };

    const wanted = M.deriveValue(profile, match.key);
    const idx = wanted ? M.pickOption(options, wanted) : -1;
    if (idx < 0) return { ...base, key: match.key, status: 'manual', note: wanted ? `None of the options matched "${wanted}".` : `Add "${M.fieldLabel(match.key)}" to your profile.` };

    state.filling = true;
    try {
      radios[idx].click();
    } finally {
      state.filling = false;
    }
    return { ...base, key: match.key, value: options[idx].text, status: match.confidence === 'high' ? 'filled' : 'review' };
  }

  // ---------- highlighting ----------

  // Constructable stylesheets are not blocked by a page's style-src CSP the
  // way an injected <style> element can be.
  let pageSheet = null;
  function injectPageStyles() {
    if (pageSheet) return;
    pageSheet = new CSSStyleSheet();
    pageSheet.replaceSync(`
      [data-applypilot] { outline-offset: 2px !important; }
      [data-applypilot="filled"], [data-applypilot="attached"] { outline: 2px solid #16a34a !important; }
      [data-applypilot="review"], [data-applypilot="edited"] { outline: 2px solid #d97706 !important; }
      [data-applypilot="manual"], [data-applypilot="file"] { outline: 2px dashed #dc2626 !important; }
      [data-applypilot="sensitive"] { outline: 2px dashed #7c3aed !important; }
      [data-applypilot-flash] { box-shadow: 0 0 0 6px rgba(37, 99, 235, .35) !important; transition: box-shadow .3s; }
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
  }

  function mark(item) {
    for (const el of item.els) {
      if (item.status === 'kept') el.removeAttribute('data-applypilot');
      else el.setAttribute('data-applypilot', item.status);
    }
  }

  function trackEdits(item) {
    const onEdit = () => {
      if (state.filling || !state.items.includes(item)) return;
      const el = item.els.find((e) => e.type !== 'radio' || e.checked) || item.els[0];
      if (item.kind === 'file') {
        item.value = el.files && el.files.length ? [...el.files].map((f) => f.name).join(', ') : '';
        item.status = item.value ? 'attached' : 'file';
      } else {
        if (el.type === 'checkbox') item.value = el.checked ? 'Ticked' : '';
        else item.value = item.kind === 'radio' ? optionLabelFor(el) : currentValue(el);
        item.status = item.value ? 'edited' : 'manual';
      }
      mark(item);
      render();
    };
    for (const el of item.els) {
      el.addEventListener('input', onEdit);
      el.addEventListener('change', onEdit);
    }
  }

  function focusItem(item) {
    const el = item.els[0];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    el.setAttribute('data-applypilot-flash', '');
    setTimeout(() => el.removeAttribute('data-applypilot-flash'), 1200);
  }

  // ---------- submit guard ----------

  function isSubmitControl(el) {
    if (!el) return false;
    if (el.matches('input[type="submit"], input[type="image"]')) return true;
    const label = el.innerText || el.value || el.getAttribute('aria-label') || '';
    return SUBMIT_TEXT.test(label);
  }

  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    state.notice = 'ApplyPilot paused this submission. Check the highlighted fields, then approve below.';
    showPanel();
  }

  function onSubmit(event) {
    if (!state.approved) block(event);
  }

  function onClick(event) {
    if (state.approved) return;
    const control = event.target.closest && event.target.closest('button, input[type="submit"], input[type="image"], [role="button"]');
    if (isSubmitControl(control)) block(event);
  }

  function findSubmitControl() {
    const form = state.items.map((i) => i.els[0].form).find(Boolean);
    const scope = form || document;
    const candidates = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(isVisible);
    return candidates.find(isSubmitControl) || (form && candidates.find((c) => c.type === 'submit')) || null;
  }

  function approveAndSubmit() {
    state.approved = true;
    const control = findSubmitControl();
    const form = control && control.form;
    if (form && !form.checkValidity()) {
      form.reportValidity();
      state.notice = 'Approved. Some required fields are still empty. Complete them, then press the form’s Submit button.';
    } else if (control) {
      control.click();
      state.notice = 'Approved. Submitting…';
    } else {
      state.notice = 'Approved. Use the form’s own Submit button to send it.';
    }
    render();
  }

  // ---------- AI drafting ----------

  async function draftAnswer(item) {
    const el = item.els[0];
    item.drafting = true;
    item.error = '';
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'draftAnswer',
        question: item.label,
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        page: { title: document.title, url: location.href, text: (document.body.innerText || '').slice(0, 15000) },
      });
      if (!response || !response.ok) throw new Error((response && response.error) || 'No response from ApplyPilot.');
      setValue(el, response.text);
      item.value = el.value;
      item.status = 'review';
      item.note = 'AI draft. Read it and fill in anything in [brackets].';
      mark(item);
    } catch (err) {
      item.error = err.message;
    } finally {
      item.drafting = false;
      render();
    }
  }

  // ---------- review panel ----------

  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(380px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 32px)); display: flex; flex-direction: column; background: #fff; color: #0f172a;
      border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 20px 50px rgba(15, 23, 42, .25);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    header { padding: 14px 16px 10px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: start; gap: 8px; }
    header h1 { margin: 0; font-size: 15px; }
    header p { margin: 2px 0 0; color: #64748b; }
    header button { margin-left: auto; }
    .summary { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 16px 0; }
    .notice { margin: 10px 16px 0; padding: 8px 10px; border-radius: 8px; background: #eff6ff; color: #1e40af; }
    .list { overflow-y: auto; padding: 6px 8px 8px; flex: 1; }
    h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin: 12px 8px 4px; }
    .row { width: 100%; text-align: left; display: block; padding: 8px; border-radius: 8px; border: 0; background: none; cursor: pointer; font: inherit; color: inherit; }
    .row:hover, .row:focus-visible { background: #f1f5f9; outline: none; }
    .top { display: flex !important; gap: 8px; align-items: baseline; }
    .label { font-weight: 600; flex: 1; }
    .top, .value, .note, .error { display: block; }
    .value { color: #334155; margin-top: 2px; word-break: break-word; }
    .note { color: #64748b; margin-top: 2px; }
    .error { color: #b91c1c; margin-top: 2px; }
    .chip { font-size: 11px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
    .ok { background: #dcfce7; color: #166534; } .warn { background: #fef3c7; color: #92400e; }
    .bad { background: #fee2e2; color: #991b1b; } .private { background: #ede9fe; color: #5b21b6; }
    .muted { background: #f1f5f9; color: #475569; }
    .ai { margin: 4px 0 0 8px; }
    footer { border-top: 1px solid #e2e8f0; padding: 12px 16px; display: grid; gap: 10px; }
    footer label { display: flex; gap: 8px; align-items: start; cursor: pointer; }
    footer small { color: #64748b; }
    button.primary, button.ghost, button.ai { font: inherit; border-radius: 8px; cursor: pointer; padding: 6px 12px; }
    button.primary { background: #2563eb; color: #fff; border: 0; padding: 9px 12px; font-weight: 600; }
    button.primary:disabled { background: #94a3b8; cursor: not-allowed; }
    button.ghost, button.ai { background: #fff; border: 1px solid #cbd5e1; color: #0f172a; }
    .min { display: none; }
    .panel.collapsed .list, .panel.collapsed footer, .panel.collapsed .notice { display: none; }
  `;

  function ensurePanel() {
    if (state.host && document.documentElement.contains(state.host)) return;
    state.host = document.createElement('div');
    state.host.id = 'applypilot-host';
    state.root = state.host.attachShadow({ mode: 'open' });
    const panelSheet = new CSSStyleSheet();
    panelSheet.replaceSync(PANEL_CSS);
    state.root.adoptedStyleSheets = [panelSheet];
    document.documentElement.appendChild(state.host);

    state.root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const item = state.items[Number(target.dataset.id)];
      switch (target.dataset.action) {
        case 'focus': return focusItem(item);
        case 'draft': event.stopPropagation(); return draftAnswer(item);
        case 'toggle': return state.root.querySelector('.panel').classList.toggle('collapsed');
        case 'approve': return approveAndSubmit();
      }
    });
    state.root.addEventListener('change', (event) => {
      if (event.target.name === 'reviewed') {
        state.reviewed = event.target.checked;
        render();
      }
    });
  }

  function rowHtml(item) {
    const status = STATUS[item.status];
    const canDraft = item.kind === 'question' && state.settings.aiEnabled && !state.approved && ['manual', 'review'].includes(item.status);
    return `
      <button class="row" data-action="focus" data-id="${item.id}">
        <span class="top"><span class="label">${escapeHtml(clip(item.label, 90))}</span>
          <span class="chip ${status.tone}">${status.label}</span></span>
        ${item.value ? `<span class="value">${escapeHtml(clip(item.value, 140))}</span>` : ''}
        ${item.note ? `<span class="note">${escapeHtml(item.note)}</span>` : ''}
        ${item.error ? `<span class="error">${escapeHtml(item.error)}</span>` : ''}
      </button>
      ${canDraft ? `<button class="ai" data-action="draft" data-id="${item.id}" ${item.drafting ? 'disabled' : ''}>
        ${item.drafting ? 'Drafting…' : '✨ Draft an answer with AI'}</button>` : ''}`;
  }

  function render() {
    if (!state.root) return;
    const attention = state.items.filter((i) => ATTENTION.has(i.status));
    const done = state.items.filter((i) => !ATTENTION.has(i.status));
    const count = (s) => state.items.filter((i) => i.status === s).length;
    const needsYou = count('manual') + count('file');
    const collapsed = state.root.querySelector('.panel.collapsed') ? ' collapsed' : '';

    state.root.innerHTML = `
      <section class="panel${collapsed}" role="dialog" aria-label="ApplyPilot review">
        <header>
          <div><h1>ApplyPilot</h1><p>Review before you submit. Nothing is sent until you approve.</p></div>
          <button class="ghost" data-action="toggle" aria-label="Collapse or expand">–</button>
        </header>
        <div class="summary">
          <span class="chip ok">${count('filled')} filled</span>
          <span class="chip warn">${count('review') + count('edited')} to check</span>
          <span class="chip bad">${needsYou} need you</span>
          ${count('sensitive') ? `<span class="chip private">${count('sensitive')} private</span>` : ''}
        </div>
        ${state.notice ? `<div class="notice" role="status">${escapeHtml(state.notice)}</div>` : ''}
        <div class="list">
          ${attention.length ? `<h2>Needs your attention</h2>${attention.map(rowHtml).join('')}` : ''}
          ${done.length ? `<h2>Filled from your profile</h2>${done.map(rowHtml).join('')}` : ''}
        </div>
        <footer>
          <label><input type="checkbox" name="reviewed" ${state.reviewed ? 'checked' : ''} ${state.approved ? 'disabled' : ''}>
            <span>I’ve checked every highlighted field and the answers are accurate.</span></label>
          ${needsYou ? `<small>${needsYou} field(s) are still marked “Needs you”. They may be optional; check before submitting.</small>` : ''}
          <button class="primary" data-action="approve" ${!state.reviewed || state.approved ? 'disabled' : ''}>
            ${state.approved ? 'Approved' : 'Approve & submit'}</button>
        </footer>
      </section>`;
  }

  function showPanel() {
    ensurePanel();
    state.root.querySelector('.panel')?.classList.remove('collapsed');
    render();
  }

  // ---------- entry point ----------

  async function run() {
    const { profile = {}, savedAnswers = [], settings = {} } = await chrome.storage.local.get(['profile', 'savedAnswers', 'settings']);
    state.settings = settings;

    for (const el of document.querySelectorAll('[data-applypilot]')) el.removeAttribute('data-applypilot');
    state.items = scan(profile, savedAnswers);
    state.approved = false;
    state.reviewed = false;
    state.notice = '';

    const result = {
      top: window === window.top,
      total: state.items.length,
      filled: state.items.filter((i) => i.status === 'filled').length,
      review: state.items.filter((i) => i.status === 'review').length,
      manual: state.items.filter((i) => ['manual', 'file'].includes(i.status)).length,
    };
    if (!state.items.length) return result;

    injectPageStyles();
    state.items.forEach((item) => {
      mark(item);
      trackEdits(item);
    });
    window.addEventListener('submit', onSubmit, true);
    window.addEventListener('click', onClick, true);
    showPanel();
    return result;
  }

  window.__applyPilot = { run };
  return run();
})();
