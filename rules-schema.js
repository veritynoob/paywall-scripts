/* =============================================================================
 * rules-schema.js -- the rule vocabulary, as data.
 *
 * The popup builds its per-site editor from this table instead of hand-coding a
 * form for each action, so adding a new action type means adding one entry here.
 * It is deliberately free of DOM and chrome.* so it can be unit-tested in Node.
 *
 * Field kinds:
 *   text     single-line string
 *   number   numeric
 *   lines    array of strings, one per line            (selectors, patterns, keys)
 *   pairs    array of {name, domain}, one per line      ("name | .domain.com")
 *   bool     checkbox
 *   select   dropdown, uses `options`
 *   css      long text (kept as `field` also accepts this for `css`)
 *
 * `field`  = the key this maps to inside the rule object. Defaults to `key`.
 * `advanced` = hidden behind the card's "more" toggle, to keep the common case
 *              short. Nothing is ever unreachable.
 * ========================================================================== */

/* eslint-disable no-unused-vars */
const RULE_SCHEMA = {
  css: {
    label: 'Inject CSS',
    help: 'Hides the paywall and unlocks scrolling. Runs before the first paint.',
    fields: [
      { key: 'hide', kind: 'lines', label: 'Hide these selectors', placeholder: '.paywall, [class*="Regwall" i]' },
      { key: 'css', kind: 'css', label: 'Extra CSS', advanced: true, placeholder: 'body { overflow: auto !important; }' }
    ]
  },
  unhide: {
    label: 'Unhide content',
    help: 'Removes hidden / aria-hidden / inert and inline display:none from real content.',
    fields: [
      { key: 'selectors', kind: 'lines', label: 'Selectors', placeholder: 'article, [class*="article-body" i]' },
      { key: 'attrs', kind: 'lines', label: 'Attributes to strip', advanced: true, placeholder: 'hidden, aria-hidden, inert' }
    ]
  },
  untruncate: {
    label: 'Clear truncation flags',
    help: 'Drops marker attributes like isAccessibleForFree="false".',
    fields: [
      { key: 'selectors', kind: 'lines', label: 'Selectors', placeholder: 'html, body, article' },
      { key: 'attrs', kind: 'lines', label: 'Attributes', advanced: true }
    ]
  },
  nukeSelector: {
    label: 'Delete elements',
    help: 'Removes matching nodes. Refuses to delete the article body itself — that guard is built in.',
    fields: [{ key: 'selectors', kind: 'lines', label: 'Selectors', placeholder: 'div[data-testid="paywall"]' }]
  },
  cookie: {
    label: 'Delete cookies',
    help: 'Runs in the service worker (content scripts cannot reach the cookie API).',
    fields: [
      { key: 'cookies', kind: 'pairs', label: 'Cookies', placeholder: 'meterCount | .example.com' }
    ]
  },
  storage: {
    label: 'Clear stored keys',
    help: 'Each entry matches an exact key or a prefix.',
    fields: [
      { key: 'local', kind: 'lines', label: 'localStorage keys / prefixes', placeholder: 'articleCount, meter, nytd_' },
      { key: 'session', kind: 'lines', label: 'sessionStorage keys / prefixes', advanced: true }
    ]
  },
  text: {
    label: 'Strip paywall wording',
    help: 'Removes leftover "Subscribe to continue reading" blocks.',
    fields: [
      { key: 'selectors', kind: 'lines', label: 'Search inside', placeholder: '#gateway-content, [role="dialog"]' },
      { key: 'phrases', kind: 'lines', label: 'Phrases', advanced: true, placeholder: 'subscribe to continue reading' }
    ]
  },
  click: {
    label: 'Click buttons',
    help: 'Polls for the buttons and clicks each one once.',
    fields: [
      { key: 'selectors', kind: 'lines', label: 'Selectors', placeholder: 'button[data-testid="ContinueReading"]' },
      { key: 'tries', kind: 'number', label: 'Attempts', advanced: true, placeholder: '10' },
      { key: 'gap', kind: 'number', label: 'Gap (ms)', advanced: true, placeholder: '300' }
    ]
  },
  blockScripts: {
    label: 'Block scripts',
    help: 'Stops matching <script src> from ever loading. Globs, e.g. *meter*.',
    fields: [{ key: 'patterns', kind: 'lines', label: 'URL patterns', placeholder: '*meter*, *paywall*' }]
  },
  deScrim: {
    label: 'Remove dimming overlays',
    help:
      'Finds full-page gradient layers painted over the article (hashed class names, so they are matched by shape) and strips their gradient. Nothing to configure.',
    fields: [
      { key: 'minCoverage', kind: 'number', label: 'Minimum coverage of the viewport (0-1)', advanced: true, placeholder: '0.25' }
    ]
  },
  preserveBody: {
    label: 'Keep the full body',
    help:
      'For sites that ship the whole article and then delete most of it after load: snapshots the body while it is complete and restores it when it shrinks.',
    fields: [
      { key: 'selectors', kind: 'lines', label: 'Body selectors', advanced: true, placeholder: '[data-testid="articleBody"], article' },
      { key: 'watchMs', kind: 'number', label: 'How long to watch (ms)', advanced: true, placeholder: '20000' },
      { key: 'maxRestores', kind: 'number', label: 'Max restores', advanced: true, placeholder: '6' }
    ]
  },
  redirect: {
    label: 'Redirect elsewhere',
    help:
      'Sends the tab to another URL. The only honest answer to a server-side wall: {href} = the raw page URL, {url} = percent-encoded.',
    fields: [
      { key: 'toUrl', kind: 'text', label: 'Send to', placeholder: 'https://archive.ph/newest/{href}' },
      { key: 'when', kind: 'lines', label: 'Only from these URLs', placeholder: 'https://*.bloomberg.com/news/articles/*' },
      { key: 'onlyIfGated', kind: 'bool', label: 'Only when something is actually covering the page' },
      { key: 'alsoIfThin', kind: 'bool', label: 'Or when the body looks truncated', advanced: true },
      { key: 'minChars', kind: 'number', label: '“Thin” threshold (chars)', advanced: true },
      { key: 'waitMs', kind: 'number', label: 'How long to watch (ms)', advanced: true }
    ]
  },
  main: {
    label: 'Raw JS (page world)',
    help: 'Runs in the page’s own JS world. Blocked by a strict page CSP — prefer the other actions.',
    fields: [{ key: 'js', kind: 'css', label: 'JavaScript' }]
  }
};

const RULE_TYPES = Object.keys(RULE_SCHEMA);

/** Actions that change where you end up, worth warning about in the UI. */
const DESTRUCTIVE_OR_EXTERNAL = ['redirect', 'nukeSelector'];

/* -------------------------------------------------------------------------- */
/* value <-> form-text conversion                                              */
/* -------------------------------------------------------------------------- */

/** Read one form field's text back into the rule's value shape. */
function formTextToValue(kind, text) {
  if (kind === 'lines') {
    return String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (kind === 'pairs') {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, domain] = line.split('|').map((s) => s.trim());
        const entry = { name: name || '' };
        if (domain) entry.domain = domain;
        return entry;
      })
      .filter((e) => e.name);
  }
  if (kind === 'bool') return !!text;
  if (kind === 'number') {
    if (text === '' || text === null || text === undefined) return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return text === '' || text === undefined ? undefined : text;
}

/** Render a rule's value into the form's text shape. */
function valueToFormText(kind, value) {
  if (kind === 'lines') return Array.isArray(value) ? value.join('\n') : '';
  if (kind === 'pairs') {
    return Array.isArray(value)
      ? value.map((c) => (c && c.domain ? c.name + ' | ' + c.domain : (c && c.name) || '')).join('\n')
      : '';
  }
  if (kind === 'bool') return !!value;
  if (kind === 'number') return value === undefined || value === null ? '' : String(value);
  return value === undefined || value === null ? '' : String(value);
}

/** Normalise a rule against the schema: drop empty fields, coerce types. */
function normalizeRule(rule) {
  if (!rule || !rule.type) return null;
  const spec = RULE_SCHEMA[rule.type];
  const out = { type: rule.type };
  if (!spec) {
    // Unknown type: keep it verbatim rather than silently deleting user work.
    Object.keys(rule).forEach((k) => {
      if (k !== 'type') out[k] = rule[k];
    });
    return out;
  }
  spec.fields.forEach((f) => {
    const key = f.field || f.key;
    const v = formTextToValue(f.kind, valueToFormText(f.kind, rule[key]));
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return;
    out[key] = v;
  });
  return out;
}

/** A safe default rule object for a newly added action. */
function defaultRule(type) {
  const seeds = {
    css: { hide: [] },
    unhide: { selectors: [] },
    untruncate: { selectors: [] },
    nukeSelector: { selectors: [] },
    cookie: { cookies: [] },
    storage: { local: [] },
    text: { selectors: [] },
    click: { selectors: [] },
    blockScripts: { patterns: [] },
    deScrim: {},
    preserveBody: {},
    redirect: { toUrl: '', when: [] },
    main: { js: '' }
  };
  return Object.assign({ type }, seeds[type] || {});
}

/** Short one-line summary of a rule, for collapsed cards. */
function summarizeRule(rule) {
  if (!rule || !rule.type) return '(empty)';
  const spec = RULE_SCHEMA[rule.type];
  if (!spec) return rule.type + ' (unknown)';
  for (const f of spec.fields) {
    const key = f.field || f.key;
    const v = rule[key];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) return v.length + ' ' + (v.length === 1 ? 'item' : 'items');
    return String(v).slice(0, 60);
  }
  return 'no values yet';
}

/** Validate a whole site entry. Throws with a human-readable message. */
function validateSite(site, allSites) {
  if (!site || typeof site !== 'object') throw new Error('site must be an object');
  if (!site.id || typeof site.id !== 'string') throw new Error('site needs an "id"');
  if (!Array.isArray(site.matches) || !site.matches.length) {
    throw new Error('add at least one URL pattern');
  }
  if (!Array.isArray(site.rules)) throw new Error('site needs a "rules" array');
  if (Array.isArray(allSites)) {
    const clash = allSites.filter((s) => s && s.id === site.id).length > 1;
    if (clash) throw new Error('duplicate site id "' + site.id + '"');
  }
  return true;
}

/* Node export for the unit tests; harmless in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RULE_SCHEMA,
    RULE_TYPES,
    DESTRUCTIVE_OR_EXTERNAL,
    formTextToValue,
    valueToFormText,
    normalizeRule,
    defaultRule,
    summarizeRule,
    validateSite
  };
}
