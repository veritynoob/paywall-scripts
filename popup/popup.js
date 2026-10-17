/* =============================================================================
 * popup.js -- Sites list -> per-site editor -> optional whole-config JSON
 *
 * The config is still one array under one storage key (that is what the engine
 * consumes), but the UI never makes you look at it as a whole: you pick a site
 * from a list and edit only that site.
 * ========================================================================== */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'paywallConfig';
const DEBUG_KEY = 'paywallDebug';

let currentConfig = null;      // the saved config
let bundledConfig = null;      // the package copy, for the stale notice
let editingIndex = -1;         // index into currentConfig.scripts
let draft = null;              // the site being edited (deep copy)
let draftDirty = false;

/* -------------------------------------------------------------------------- */
/* views                                                                       */
/* -------------------------------------------------------------------------- */

const VIEWS = ['view-list', 'view-detail', 'view-config'];

function showView(id) {
  VIEWS.forEach((v) => {
    const el = $(v);
    if (el) el.hidden = v !== id;
  });
  document.body.classList.toggle('narrow', id === 'view-list');
  if (id === 'view-list') refreshMatches();
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function setDetailStatus(text, kind) {
  const el = $('detailStatus');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function setJsonStatus(text, kind) {
  const el = $('jsonStatus');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function setConfigStatus(text, kind) {
  const el = $('configStatus');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/* -------------------------------------------------------------------------- */
/* storage                                                                     */
/* -------------------------------------------------------------------------- */

async function readConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const cfg = data[STORAGE_KEY] || cloneConfig(DEFAULT_CONFIG);
  if (!Array.isArray(cfg.scripts)) cfg.scripts = [];
  return cfg;
}

async function loadBundled() {
  if (bundledConfig) return bundledConfig;
  try {
    const res = await fetch(chrome.runtime.getURL('scripts/default-config.json'));
    bundledConfig = await res.json();
  } catch (e) {
    bundledConfig = DEFAULT_CONFIG;
  }
  return bundledConfig;
}

/** Persist a config through the background worker (pushes to open tabs). */
async function persist(cfg, why) {
  cfg.debug = $('debug').checked;
  const res = await chrome.runtime.sendMessage({ type: 'PC_SET_CONFIG', config: cfg });
  if (!res || !res.ok) {
    const msg = (why || 'Save') + ' failed: ' + ((res && res.error) || 'unknown');
    setStatus(msg, 'bad');
    setDetailStatus(msg, 'bad');
    return false;
  }
  currentConfig = cfg;
  renderCounts(cfg);
  renderStaleNotice(cfg);
  if (!$('view-config').hidden) $('editor').value = JSON.stringify(cfg, null, 2);
  return true;
}

function renderCounts(cfg) {
  const scripts = (cfg && cfg.scripts) || [];
  const enabled = scripts.filter((s) => s && s.enabled !== false).length;
  $('count').textContent = scripts.length + ' site' + (scripts.length === 1 ? '' : 's');
  $('enabled').textContent = enabled + ' enabled';
}

/* -------------------------------------------------------------------------- */
/* stale-config notice                                                         */
/* -------------------------------------------------------------------------- */

function renderStaleNotice(cfg) {
  const el = $('staleNotice');
  const have = new Set(((cfg && cfg.scripts) || []).map((s) => s && s.id));
  const bundled = (bundledConfig || DEFAULT_CONFIG).scripts || [];
  const missing = bundled.map((s) => s.id).filter((id) => !have.has(id));
  const storedVersion = Number((cfg && cfg.version) || 0);
  const bundledVersion = Number((bundledConfig || {}).version || 0);

  if (!missing.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  el.hidden = false;
  el.textContent = '';

  const head = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = missing.length + ' shipped site(s) missing from your config';
  head.appendChild(b);
  if (bundledVersion > storedVersion) {
    head.appendChild(document.createTextNode('  (yours: v' + storedVersion + ', bundled: v' + bundledVersion + ')'));
  }
  el.appendChild(head);

  const ids = document.createElement('div');
  ids.className = 'mono tiny';
  ids.textContent = missing.join(', ');
  el.appendChild(ids);

  const why = document.createElement('div');
  why.style.marginTop = '4px';
  why.textContent =
    'Your saved config outlives reloading the extension, so new defaults never reach you. ' +
    'Loading the bundled examples replaces everything below.';
  el.appendChild(why);

  const btn = document.createElement('button');
  btn.textContent = 'Load bundled examples';
  btn.addEventListener('click', async () => {
    if (!confirm('Replace ALL your sites with the bundled examples?')) return;
    const res = await chrome.runtime.sendMessage({ type: 'PC_RESET_CONFIG' });
    if (res && res.ok) {
      await init();
      setStatus('Loaded the bundled examples.', 'ok');
    } else {
      setStatus('Reset failed: ' + ((res && res.error) || 'unknown'), 'bad');
    }
  });
  el.appendChild(btn);
}

/* -------------------------------------------------------------------------- */
/* site list                                                                   */
/* -------------------------------------------------------------------------- */

function siteSummary(site) {
  const hosts = (site.matches || [])
    .map((m) => String(m).replace(/^[a-z*]+:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const uniq = [...new Set(hosts)];
  return uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ' +' + (uniq.length - 3) : '');
}

function renderSiteList(cfg) {
  const list = $('scriptList');
  list.textContent = '';
  const scripts = (cfg && cfg.scripts) || [];

  if (!scripts.length) {
    const empty = document.createElement('div');
    empty.className = 'lead';
    empty.textContent = 'No sites yet. Use “+ Add site” or “Reset to examples”.';
    list.appendChild(empty);
    return;
  }

  scripts.forEach((site, index) => {
    const on = site.enabled !== false;
    const row = document.createElement('div');
    row.className = 'site-row' + (on ? '' : ' off');

    const sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.className = 'sw';
    sw.checked = on;
    sw.title = on ? 'Disable this site' : 'Enable this site';
    sw.addEventListener('click', (e) => e.stopPropagation());
    sw.addEventListener('change', () => toggleSite(index, sw.checked));

    const body = document.createElement('button');
    body.className = 'site-open';
    body.type = 'button';
    body.addEventListener('click', () => openDetail(index));

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = site.name || site.id || '(unnamed)';
    if (!on) {
      const t = document.createElement('span');
      t.className = 'tag off';
      t.textContent = 'off';
      title.appendChild(t);
    }
    if ((site.rules || []).some((r) => r && r.type === 'redirect')) {
      const t = document.createElement('span');
      t.className = 'tag redirect';
      t.textContent = 'redirect';
      title.appendChild(t);
    }
    body.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = siteSummary(site) + '  ·  ' + (site.rules || []).length + ' rules';
    body.appendChild(sub);

    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '›';

    row.appendChild(sw);
    row.appendChild(body);
    row.appendChild(chev);
    list.appendChild(row);
  });
}

async function toggleSite(index, enabled) {
  const site = currentConfig.scripts[index];
  if (!site) return;
  site.enabled = !!enabled;
  const ok = await persist(currentConfig, (site.name || site.id) + (enabled ? ' enabled' : ' disabled'));
  if (ok) {
    renderSiteList(currentConfig);
    setStatus((site.name || site.id) + (enabled ? ' enabled' : ' disabled') + ' — pushed to open tabs.', 'ok');
  } else {
    await init();
  }
}

/* -------------------------------------------------------------------------- */
/* per-site editor                                                             */
/* -------------------------------------------------------------------------- */

function markDirty() {
  draftDirty = true;
  const btn = $('apply');
  btn.classList.add('primary');
  btn.textContent = 'Apply ●';
}

function openDetail(index) {
  editingIndex = index;
  const site = currentConfig.scripts[index];
  draft = JSON.parse(JSON.stringify(site));
  if (!Array.isArray(draft.matches)) draft.matches = [];
  if (!Array.isArray(draft.rules)) draft.rules = [];
  draftDirty = false;
  $('apply').textContent = 'Apply';
  $('detailId').textContent = draft.id || '';
  $('detailStatus').textContent = '';
  renderDetail();
  $('d-json').value = '';
  setJsonStatus('');
  showView('view-detail');
}

function renderDetail() {
  $('d-name').value = draft.name || '';
  $('d-enabled').checked = draft.enabled !== false;
  $('d-runAt').value = draft.runAt || '';
  renderPatterns();
  renderRules();
}

function renderPatterns() {
  const list = $('patternList');
  list.textContent = '';
  draft.matches.forEach((pattern, i) => {
    const row = document.createElement('div');
    row.className = 'line-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = pattern;
    input.placeholder = 'https://*.example.com/*';
    input.addEventListener('input', () => {
      draft.matches[i] = input.value;
      markDirty();
    });

    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = '✕';
    del.title = 'Remove pattern';
    del.addEventListener('click', () => {
      draft.matches.splice(i, 1);
      renderPatterns();
      markDirty();
    });

    row.appendChild(input);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderRules() {
  const list = $('ruleList');
  list.textContent = '';

  if (!draft.rules.length) {
    const empty = document.createElement('div');
    empty.className = 'lead';
    empty.textContent = 'No rules — this site matches but does nothing.';
    list.appendChild(empty);
    return;
  }

  draft.rules.forEach((rule, i) => {
    const spec = RULE_SCHEMA[rule.type];
    const card = document.createElement('div');
    card.className = 'rule-card';

    const head = document.createElement('div');
    head.className = 'rule-head';

    const num = document.createElement('span');
    num.className = 'rule-num';
    num.textContent = i + 1;
    head.appendChild(num);

    const sel = document.createElement('select');
    RULE_TYPES.forEach((t) => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = RULE_SCHEMA[t].label;
      if (t === rule.type) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      draft.rules[i] = defaultRule(sel.value);
      renderRules();
      markDirty();
    });
    head.appendChild(sel);

    const summary = document.createElement('span');
    summary.className = 'rule-summary';
    summary.textContent = summarizeRule(rule);
    summary.title = summarizeRule(rule);
    head.appendChild(summary);

    const up = document.createElement('button');
    up.className = 'mini';
    up.textContent = '↑';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      const [r] = draft.rules.splice(i, 1);
      draft.rules.splice(i - 1, 0, r);
      renderRules();
      markDirty();
    });

    const down = document.createElement('button');
    down.className = 'mini';
    down.textContent = '↓';
    down.disabled = i === draft.rules.length - 1;
    down.addEventListener('click', () => {
      const [r] = draft.rules.splice(i, 1);
      draft.rules.splice(i + 1, 0, r);
      renderRules();
      markDirty();
    });

    const del = document.createElement('button');
    del.className = 'mini danger';
    del.textContent = '✕';
    del.title = 'Remove rule';
    del.addEventListener('click', () => {
      draft.rules.splice(i, 1);
      renderRules();
      markDirty();
    });

    head.appendChild(up);
    head.appendChild(down);
    head.appendChild(del);
    card.appendChild(head);

    if (spec) {
      const help = document.createElement('div');
      help.className = 'rule-help';
      help.textContent = spec.help;
      card.appendChild(help);
      renderRuleFields(card, rule, spec);
    } else {
      const warn = document.createElement('div');
      warn.className = 'rule-help';
      warn.textContent = 'Unknown rule type — edit it as JSON on the site card below.';
      card.appendChild(warn);
    }

    list.appendChild(card);
  });
}

function renderRuleFields(card, rule, spec) {
  const advancedBox = document.createElement('div');
  let advancedCount = 0;

  spec.fields.forEach((f) => {
    if (f.advanced) advancedCount++;
    const target = f.advanced ? advancedBox : card;
    target.appendChild(buildField(rule, f));
  });

  if (advancedCount) {
    const fold = document.createElement('details');
    fold.className = 'fold tiny';
    const sum = document.createElement('summary');
    sum.textContent = advancedCount + ' optional field' + (advancedCount === 1 ? '' : 's');
    fold.appendChild(sum);
    fold.appendChild(advancedBox);
    card.appendChild(fold);
  }
}

function buildField(rule, f) {
  const key = f.field || f.key;
  const wrap = document.createElement('label');
  wrap.className = 'field' + (f.kind === 'bool' ? ' inline' : '');

  if (f.kind === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule[key] === true;
    cb.addEventListener('change', () => {
      if (cb.checked) rule[key] = true;
      else delete rule[key];
      markDirty();
    });
    const span = document.createElement('span');
    span.textContent = f.label;
    wrap.appendChild(cb);
    wrap.appendChild(span);
    return wrap;
  }

  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = f.label;
  wrap.appendChild(lbl);

  let input;
  if (f.kind === 'select') {
    input = document.createElement('select');
    (f.options || []).forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      input.appendChild(opt);
    });
    input.value = rule[key] || '';
  } else if (f.kind === 'lines' || f.kind === 'pairs' || f.kind === 'css') {
    input = document.createElement('textarea');
    input.spellcheck = false;
    input.rows = f.kind === 'css' ? 4 : Math.min(6, Math.max(2, (valueToFormText(f.kind, rule[key]) || '').split('\n').length));
    input.placeholder = f.placeholder || '';
    input.value = valueToFormText(f.kind, rule[key]);
  } else if (f.kind === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.placeholder = f.placeholder || '';
    input.value = valueToFormText(f.kind, rule[key]);
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = f.placeholder || '';
    input.value = valueToFormText(f.kind, rule[key]);
  }

  if (f.kind !== 'select') {
    input.addEventListener('input', () => {
      const v = formTextToValue(f.kind, input.value);
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete rule[key];
      else rule[key] = v;
      markDirty();
    });
  } else {
    input.addEventListener('change', () => {
      if (input.value) rule[key] = input.value;
      else delete rule[key];
      markDirty();
    });
  }

  if (f.kind === 'lines' || f.kind === 'pairs') {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      f.kind === 'pairs' ? 'One per line:  name | .domain.com   (domain optional)' : 'One per line.';
    wrap.appendChild(hint);
  }
  wrap.appendChild(input);
  return wrap;
}

async function applyDraft() {
  draft.name = $('d-name').value.trim();
  draft.enabled = $('d-enabled').checked;
  const runAt = $('d-runAt').value;
  if (runAt) draft.runAt = runAt;
  else delete draft.runAt;

  draft.rules = draft.rules.map(normalizeRule).filter(Boolean);
  draft.matches = draft.matches.map((m) => String(m).trim()).filter(Boolean);

  try {
    validateSite(draft, [].concat(currentConfig.scripts.filter((_, i) => i !== editingIndex), [draft]));
  } catch (e) {
    setDetailStatus(e.message, 'bad');
    return;
  }

  currentConfig.scripts[editingIndex] = draft;
  const ok = await persist(currentConfig, (draft.name || draft.id) + ' applied');
  if (!ok) return;
  draftDirty = false;
  $('apply').textContent = 'Apply';
  renderDetail();
  renderSiteList(currentConfig);
  setDetailStatus('Applied — pushed to open tabs.', 'ok');
  setStatus('Applied "' + (draft.name || draft.id) + '".', 'ok');
}

/* -------------------------------------------------------------------------- */
/* whole-config JSON                                                           */
/* -------------------------------------------------------------------------- */

function parseConfigText() {
  let cfg;
  try {
    cfg = JSON.parse($('editor').value);
  } catch (e) {
    throw new Error('JSON error: ' + e.message);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Top level must be an object: { "scripts": [...] }');
  }
  if (!Array.isArray(cfg.scripts)) throw new Error('Missing "scripts" array');
  const ids = new Set();
  cfg.scripts.forEach((s, i) => {
    if (!s || typeof s !== 'object') throw new Error('scripts[' + i + '] is not an object');
    if (!s.id) throw new Error('scripts[' + i + '] needs an "id"');
    if (ids.has(s.id)) throw new Error('duplicate site id "' + s.id + '"');
    ids.add(s.id);
    if (!Array.isArray(s.matches) || !s.matches.length) {
      throw new Error('scripts[' + i + '] ("' + s.id + '") needs a non-empty "matches" array');
    }
    if (!Array.isArray(s.rules)) throw new Error('scripts[' + i + '] ("' + s.id + '") needs a "rules" array');
  });
  return cfg;
}

/* -------------------------------------------------------------------------- */
/* per-tab diagnostics                                                         */
/* -------------------------------------------------------------------------- */

let currentUrl = '';
let currentTabId = null;

async function refreshMatches() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab && tab.id;
  currentUrl = (tab && tab.url) || '';

  const dot = $('dot');
  const list = $('matchList');

  if (!currentUrl || !/^https?:/i.test(currentUrl)) {
    $('pageInfo').textContent = currentUrl || 'no active tab';
    dot.className = 'dot off';
    $('matchStatus').textContent = 'This tab is not a normal web page, so no rules apply.';
    list.textContent = '';
    return;
  }

  $('pageInfo').textContent = currentUrl;
  $('matchStatus').textContent = 'Checking…';

  const cfg = currentConfig || (await readConfig());
  const rows = describeMatch(cfg, currentUrl);
  const hits = rows.filter((r) => r.matched && r.enabled);

  dot.className = 'dot ' + (hits.length ? 'on' : 'off');
  list.textContent = '';

  rows.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'match ' + (r.enabled ? (r.matched ? 'hit' : 'miss') : 'off');
    const title = document.createElement('b');
    title.textContent = r.id;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const site = (cfg.scripts || []).find((s) => s.id === r.id) || {};
    sub.textContent =
      (r.enabled ? (r.matched ? 'MATCH  ' : 'skip   ') : 'off    ') +
      r.rules + ' rules  ·  ' + (site.matches || []).join(', ');
    div.appendChild(title);
    div.appendChild(sub);
    list.appendChild(div);
  });

  if (!rows.length) {
    $('matchStatus').textContent = 'No sites defined yet.';
    return;
  }

  try {
    const status = await chrome.tabs.sendMessage(currentTabId, { type: 'PC_STATUS' });
    if (status && status.ok) {
      $('matchStatus').textContent =
        hits.length + ' site(s) matched · content script live · main-world engine: ' +
        (status.engineLoaded ? 'yes' : 'no') + ' · blocked scripts: ' + (status.blockedScripts || 0);
      return;
    }
  } catch (e) {
    /* no content script in this tab */
  }

  $('matchStatus').textContent =
    hits.length + ' site(s) matched · content script not responding (reload the page)';
}

/* -------------------------------------------------------------------------- */
/* wiring                                                                      */
/* -------------------------------------------------------------------------- */

$('back').addEventListener('click', () => {
  if (draftDirty && !confirm('Discard unsaved changes to this site?')) return;
  draftDirty = false;
  showView('view-list');
  renderSiteList(currentConfig);
});

$('revert').addEventListener('click', () => {
  if (!draftDirty || confirm('Discard unsaved changes?')) openDetail(editingIndex);
});

$('apply').addEventListener('click', applyDraft);

$('addPattern').addEventListener('click', () => {
  draft.matches.push('');
  renderPatterns();
  markDirty();
  const inputs = $('patternList').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('addRule').addEventListener('click', () => {
  draft.rules.push(defaultRule('css'));
  renderRules();
  markDirty();
});

$('deleteSite').addEventListener('click', async () => {
  const site = currentConfig.scripts[editingIndex];
  if (!confirm('Delete "' + ((site && (site.name || site.id)) || '') + '"?')) return;
  currentConfig.scripts.splice(editingIndex, 1);
  if (await persist(currentConfig, 'Site deleted')) {
    draftDirty = false;
    showView('view-list');
    renderSiteList(currentConfig);
    setStatus('Site deleted.', 'ok');
  }
});

$('loadJson').addEventListener('click', () => {
  $('d-json').value = JSON.stringify(draft, null, 2);
  setJsonStatus('Loaded the current draft.', 'ok');
});

$('saveJson').addEventListener('click', () => {
  let parsed;
  try {
    parsed = JSON.parse($('d-json').value);
  } catch (e) {
    setJsonStatus('JSON error: ' + e.message, 'bad');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    setJsonStatus('A site must be an object.', 'bad');
    return;
  }
  parsed.id = draft.id; // the id is the storage identity; do not let it drift here
  draft = parsed;
  if (!Array.isArray(draft.matches)) draft.matches = [];
  if (!Array.isArray(draft.rules)) draft.rules = [];
  renderDetail();
  markDirty();
  setJsonStatus('Parsed into the form above. Press Apply to save.', 'ok');
});

$('addSite').addEventListener('click', async () => {
  const host = prompt('Which site? Enter a domain (e.g. example.com) or a full match pattern:', 'example.com');
  if (!host) return;
  const trimmed = host.trim();
  const pattern = /:\/\//.test(trimmed) ? trimmed : 'https://*.' + trimmed.replace(/^\*\./, '') + '/*';
  const base = trimmed.replace(/^[a-z*]+:\/\//i, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/[^a-z0-9.-]/gi, '');
  let id = base || 'site';
  let n = 2;
  while (currentConfig.scripts.some((s) => s.id === id)) id = base + '-' + n++;

  const site = {
    id,
    name: base || 'New site',
    enabled: true,
    runAt: 'document_start',
    matches: [pattern],
    rules: [
      {
        type: 'css',
        hide: ['[id*="paywall" i]', '[class*="paywall" i]', '[class*="Regwall" i]', '[id*="gateway" i]']
      },
      { type: 'unhide', selectors: ['article', 'main'] }
    ]
  };

  currentConfig.scripts.push(site);
  if (await persist(currentConfig, 'Site added')) {
    renderSiteList(currentConfig);
    setStatus('Added ' + id + '. Use “Find paywall elements” on the page to get real selectors.', 'ok');
    openDetail(currentConfig.scripts.length - 1);
  }
});

$('back2').addEventListener('click', () => {
  showView('view-list');
  renderSiteList(currentConfig);
});

$('openConfig').addEventListener('click', async () => {
  $('editor').value = JSON.stringify(currentConfig, null, 2);
  setConfigStatus('Loaded.');
  showView('view-config');
});

$('saveConfig').addEventListener('click', async () => {
  let cfg;
  try {
    cfg = parseConfigText();
  } catch (e) {
    setConfigStatus(e.message, 'bad');
    return;
  }
  cfg.debug = $('debug').checked;
  await chrome.storage.local.set({ [DEBUG_KEY]: cfg.debug });
  if (await persist(cfg, 'Config saved')) {
    setConfigStatus('Saved and applied.', 'ok');
    setStatus('Config saved.', 'ok');
  }
});

$('format').addEventListener('click', () => {
  try {
    const cfg = parseConfigText();
    $('editor').value = JSON.stringify(cfg, null, 2);
    setConfigStatus('Formatted.', 'ok');
  } catch (e) {
    setConfigStatus(e.message, 'bad');
  }
});

$('export').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('editor').value);
    setConfigStatus('Copied to clipboard.', 'ok');
  } catch (e) {
    setConfigStatus('Clipboard blocked: ' + e.message, 'bad');
  }
});

$('enableAll').addEventListener('click', async () => {
  currentConfig.scripts.forEach((s) => {
    if (s) s.enabled = true;
  });
  if (await persist(currentConfig, 'All sites enabled')) {
    renderSiteList(currentConfig);
    setStatus('All sites enabled.', 'ok');
  }
});

$('disableAll').addEventListener('click', async () => {
  currentConfig.scripts.forEach((s) => {
    if (s) s.enabled = false;
  });
  if (await persist(currentConfig, 'All sites disabled')) {
    renderSiteList(currentConfig);
    setStatus('All sites disabled.', 'ok');
  }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Replace ALL your sites with the bundled examples?')) return;
  const res = await chrome.runtime.sendMessage({ type: 'PC_RESET_CONFIG' });
  if (res && res.ok) {
    await init();
    setStatus('Reset to the bundled examples.', 'ok');
  } else {
    setStatus('Reset failed: ' + ((res && res.error) || 'unknown'), 'bad');
  }
});

$('rerun').addEventListener('click', async () => {
  if (currentTabId == null) return;
  try {
    await chrome.tabs.sendMessage(currentTabId, { type: 'PC_RUN_NOW' });
    $('matchStatus').textContent = 'Re-ran the rules on this tab.';
    refreshMatches();
  } catch (e) {
    $('matchStatus').textContent = 'No content script in that tab — reload the page first.';
  }
});

$('report').addEventListener('click', async () => {
  const out = $('reportOut');
  if (currentTabId == null) return;
  out.hidden = false;
  out.textContent = 'Scanning…';
  let rep;
  try {
    rep = await chrome.tabs.sendMessage(currentTabId, { type: 'PC_REPORT_PAYWALL' });
  } catch (e) {
    out.textContent = 'No content script in this tab — reload the page first.';
    return;
  }
  if (!rep || !rep.ok) {
    out.textContent = 'Report failed: ' + ((rep && rep.error) || 'unknown');
    return;
  }

  const lines = [];

  const m = rep.measurement;
  if (m) {
    lines.push('##### VERDICT: ' + String(m.verdict).toUpperCase().replace(/-/g, ' '));
    lines.push(m.explanation);
    lines.push('');
    lines.push('article container : ' + m.selector);
    lines.push('text it contains  : ' + m.chars + ' chars in ' + m.paragraphs + ' paragraphs');
    lines.push('currently         : ' + m.visibility);
    lines.push('whole page text   : ' + m.bodyChars + ' chars');

    if (m.fade) {
      lines.push('');
      lines.push('text colour       : ' + m.fade.color + '  (alpha ' + m.fade.alpha + ', opacity ' + m.fade.opacity + ')');
      if (m.fade.alpha < 0.95) lines.push('  ^ the text is FADED — that is the "only two lines" effect');
    }
    if (m.clampHints && m.clampHints.length) {
      lines.push('');
      lines.push('clipping / fade on ancestors (' + m.clampHints.length + '):');
      m.clampHints.forEach((h) => lines.push('  [' + h.kind + '] ' + h.selector + '  ' + JSON.stringify({ overflow: h.overflow, maxHeight: h.maxHeight, hiddenPx: h.hiddenPx, cls: h.cls })));
    }
    if (m.blockers && m.blockers.length) {
      lines.push('');
      lines.push('overlays actually covering the text (' + m.blockers.length + '):');
      m.blockers.forEach((b) => lines.push('  ' + b.position + ' z=' + b.zIndex + ' covers ' + b.coverage + '  ' + b.selector));
    }

    if (m.gated && m.gated.length) {
      lines.push('');
      lines.push('gate-like elements still present (' + m.gated.length + '):');
      m.gated.forEach((g) =>
        lines.push('  ' + g.visibility.padEnd(16) + ' ' + String(g.size).padEnd(10) + ' ' + g.selector + '\n      "' + g.text + '"')
      );
    }
    lines.push('');
    if (m.verdict === 'server-truncated') {
      lines.push('=> No rule can add text the server never sent.');
      lines.push('   Add a `redirect` rule for this site (the Bloomberg entry is a template).');
    } else if (m.verdict === 'visually-truncated') {
      lines.push('=> FIXABLE: the article is all there; drop the fade/clamp with a `css` rule.');
    } else if (m.verdict === 'hidden-but-present') {
      lines.push('=> FIXABLE: add that container to an `unhide` rule.');
    } else if (m.verdict === 'covered-by-overlay') {
      lines.push('=> FIXABLE: hide or delete the overlays listed above.');
    }
    lines.push('');
    lines.push('##### selector candidates');
  } else {
    lines.push('# no article container found on this page');
  }

  lines.push('# candidates (' + rep.candidates.length + ') — copy a selector into a rule');
  rep.candidates.forEach((c) => {
    lines.push(
      '\n' + c.selector + '\n    size=' + c.size + '  position=' + (c.position || '-') +
        (c.testid ? '  testid=' + c.testid : '') +
        '\n    "' + c.text + '"'
    );
  });
  lines.push('\n\n# containers currently hidden / inert (' + rep.hiddenContainers.length + ')');
  rep.hiddenContainers.forEach((h) => lines.push('  ' + h.selector));
  lines.push('\n# elements carrying an inline hide (' + rep.inlineStyleClamps.length + ')');
  rep.inlineStyleClamps.forEach((h) => lines.push('  ' + h.selector + '   [' + h.style + ']'));
  lines.push('\n\n# quick rules to try');
  rep.candidates.slice(0, 4).forEach((c) => {
    lines.push('  { "type": "css", "hide": [' + JSON.stringify(c.selector) + '] }');
  });
  if (rep.hiddenContainers.length) {
    lines.push('  { "type": "unhide", "selectors": [' + JSON.stringify(rep.hiddenContainers[0].selector) + '] }');
  }

  out.textContent = lines.join('\n');
  try {
    await navigator.clipboard.writeText(out.textContent);
    $('matchStatus').textContent = 'Report written and copied to clipboard.';
  } catch (e) {
    $('matchStatus').textContent = 'Report written (clipboard blocked).';
  }
});

$('openOptions').addEventListener('click', async () => {
  if (currentTabId == null) return;
  await chrome.tabs.reload(currentTabId);
  window.close();
});

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

async function init() {
  currentConfig = await readConfig();
  await loadBundled();
  renderCounts(currentConfig);
  renderStaleNotice(currentConfig);
  renderSiteList(currentConfig);
  $('editor').value = JSON.stringify(currentConfig, null, 2);
  showView('view-list');
  setStatus('Ready. Pick a site to edit it.');
}

(async function boot() {
  const { [DEBUG_KEY]: debug } = await chrome.storage.local.get(DEBUG_KEY);
  $('debug').checked = debug !== false;
  $('debug').addEventListener('change', async () => {
    await chrome.storage.local.set({ [DEBUG_KEY]: $('debug').checked });
    await persist(currentConfig, 'Debug logging ' + ($('debug').checked ? 'on' : 'off'));
  });
  await init();
})();
