/* =============================================================================
 * background.js -- MV3 service worker (classic, because of importScripts)
 *
 * Responsibilities:
 *   1. install / update a registry item with the content script's file list
 *   2. seed the default ruleset on first install
 *   3. keep the registry item alive on every worker wakeup
 *   4. push the current config into every open tab when it changes
 * ========================================================================== */

importScripts('engine.js');

const STORAGE_KEY = 'paywallConfig';
const CONTENT_FILES = ['engine.js', 'content.js'];

/* -------------------------------------------------------------------------- */
/* config storage                                                              */
/* -------------------------------------------------------------------------- */

async function readConfig() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = data && data[STORAGE_KEY];
    if (cfg && Array.isArray(cfg.scripts)) return cfg;
  } catch (e) {
    console.error('[paywall-scripts] readConfig failed:', e);
  }
  return cloneConfig(DEFAULT_CONFIG);
}

async function writeConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
  return cfg;
}

async function seedDefaultConfig(force) {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  if (!force && existing && existing[STORAGE_KEY]) return existing[STORAGE_KEY];
  let seeded = null;
  try {
    const res = await fetch(chrome.runtime.getURL('scripts/default-config.json'));
    seeded = await res.json();
  } catch (e) {
    console.warn('[paywall-scripts] could not load default-config.json:', e);
  }
  return writeConfig(seeded || cloneConfig(DEFAULT_CONFIG));
}

/* -------------------------------------------------------------------------- */
/* dynamic content script registration                                         */
/* -------------------------------------------------------------------------- */

const REG_ID = 'paywall-main';

/** The canonical definition of the one content script the extension needs. */
function contentScriptSpec() {
  return {
    id: REG_ID,
    js: CONTENT_FILES,
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
    matchOriginAsFallback: true
  };
}

/**
 * Make sure REG_ID is registered exactly once, and with the *current* file list.
 *
 * Both the top-level startup call and the onInstalled listener call this, and a
 * service worker can be woken for several reasons at once, so two invocations
 * can overlap. The old "getRegisteredContentScripts, then register" pair is a
 * check-then-act race: both calls see nothing registered and both try to
 * register, and the loser throws "Duplicate script ID 'paywall-main'"
 * (reported in the wild; that error is exactly this race).
 *
 * Three guards:
 *   1. `inflight` serialises overlapping calls inside this worker instance.
 *   2. a duplicate-ID error falls back to updateContentScripts, so a
 *      registration left over from another session or an older version heals
 *      instead of breaking startup forever.
 *   3. the existing registration is compared against the current definition, so
 *      changing CONTENT_FILES still takes effect after an extension update.
 */
let inflight = null;

function ensureRegistered(opts) {
  if (inflight) return inflight;
  inflight = ensureRegisteredNow(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

function sameSpec(existing, want) {
  if (!existing) return false;
  const sorted = (a) => JSON.stringify((a || []).slice().sort());
  return (
    sorted(existing.js) === sorted(want.js) &&
    sorted(existing.matches) === sorted(want.matches) &&
    existing.runAt === want.runAt &&
    !!existing.allFrames === !!want.allFrames &&
    existing.persistAcrossSessions !== false
  );
}

async function ensureRegisteredNow(opts) {
  const force = !!(opts && opts.force);
  const want = contentScriptSpec();

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [REG_ID] });
  } catch (e) {
    console.warn('[paywall-scripts] could not read registrations:', e);
  }

  if (existing && existing.length) {
    if (!force && sameSpec(existing[0], want)) return 'already-registered';
    try {
      await chrome.scripting.updateContentScripts([want]);
      return 'updated';
    } catch (e) {
      // Could not update (rare): try to replace it outright.
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [REG_ID] });
        await chrome.scripting.registerContentScripts([want]);
        return 'replaced';
      } catch (e2) {
        console.error('[paywall-scripts] could not update the content script:', e2);
        return 'error';
      }
    }
  }

  try {
    await chrome.scripting.registerContentScripts([want]);
    return 'registered';
  } catch (e) {
    if (/duplicate|already exists/i.test(String(e && e.message))) {
      try {
        await chrome.scripting.updateContentScripts([want]);
        return 'updated';
      } catch (e2) {
        console.error('[paywall-scripts] could not update the content script:', e2);
        return 'error';
      }
    }
    console.error('[paywall-scripts] could not register the content script:', e);
    return 'error';
  }
}

/* -------------------------------------------------------------------------- */
/* fan-out to open tabs                                                        */
/* -------------------------------------------------------------------------- */

async function pushConfigToTabs() {
  const cfg = await readConfig();
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'PC_CONFIG_UPDATED', config: cfg });
      } catch (e) {
        /* no content script in that tab (chrome://, web store, ...) */
      }
    })
  );
}

/* -------------------------------------------------------------------------- */
/* cookie deletion (only the service worker gets the cookies API)              */
/* -------------------------------------------------------------------------- */

/**
 * Build the url chrome.cookies.remove() needs.
 *
 * The port matters: a cookie is not scoped to a port, but Chromium only accepts
 * a url that is valid for the cookie's host, and it does NOT accept an
 * https url for a host-only cookie created over http. So try the cookie's own
 * scheme first, then the tab's url (which carries the real port), then a bare
 * origin. Verified against a live browser: passing the tab url is what makes a
 * host-only cookie on http://localhost:8123 deletable.
 */
function cookieUrlCandidates(cookie, tabUrl) {
  const host = String(cookie.domain || '').replace(/^\./, '');
  const path = cookie.path || '/';
  const scheme = cookie.secure ? 'https' : 'http';
  const out = [];
  if (tabUrl) {
    try {
      const u = new URL(tabUrl);
      if (u.hostname === host || u.hostname.endsWith('.' + host)) {
        const s = cookie.secure ? 'https' : u.protocol.replace(':', '');
        out.push(s + '://' + u.host + path);
      }
    } catch (e) {
      /* ignore malformed tab url */
    }
  }
  out.push(scheme + '://' + host + path);
  out.push('http://' + host + path);
  out.push('https://' + host + path);
  return [...new Set(out)];
}

/**
 * Cookie names that must never be deleted, whatever a rule says.
 *
 * This is the difference between "reset the meter" and "log the user out", and
 * getting it wrong is not recoverable from inside the extension: NYT-S is the
 * signed-in session (delete it and every navigation bounces you back to the
 * regwall), and datadome is the bot-protection token (delete it and DataDome
 * re-challenges every request, which looks exactly like "the login page is
 * stuck"). DJSESSION and signed_in are the same story on WSJ / The Economist.
 *
 * Why a guard in the engine rather than trusting the shipped ruleset: the rules
 * live in chrome.storage.local, which outlives the extension code, so a config
 * saved by an older version would otherwise keep nuking the session after an
 * update. The guard makes every config safe, including hand-edited ones.
 */
const AUTH_COOKIE_RE = /(session|sess|sid|auth|token|jwt|login|signin|signed|logged|csrf|xsrf|nyt-s|datadome)/i;

function isAuthCookie(name) {
  return AUTH_COOKIE_RE.test(String(name || ''));
}

/**
 * @param {Array<{name: string, domain?: string}>} descriptors  rule cookies
 */
async function deleteCookies(descriptors, tabUrl, debug) {
  const results = [];
  const list = (Array.isArray(descriptors) ? descriptors : []).filter((d) => d && d.name);
  for (const rule of list) {
    const name = String(rule.name);
    if (isAuthCookie(name)) {
      // Loud on purpose: a silent skip would look like the rule mysteriously
      // stopped working, and someone would "fix" it by loosening the guard.
      console.warn(
        '[paywall-scripts] refused to delete "' + name + '": that name looks like a login, ' +
          'session or bot-protection cookie. Deleting it logs you out or triggers a challenge. ' +
          'Reset a meter with a counter cookie instead (e.g. nyt-a), never with the session.'
      );
      results.push({ name, skipped: 'auth-cookie' });
      continue;
    }
    let found = [];
    try {
      found = await chrome.cookies.getAll({ name });
    } catch (e) {
      results.push({ name, error: String(e && e.message) });
      continue;
    }
    for (const c of found) {
      // getAll({ name }) searches the WHOLE cookie store, so without this every
      // site with a cookie called "meter" would lose it. The rule's domain (and
      // path, when given) is the contract; honour it.
      if (rule.domain && !hostHas(c.domain, rule.domain)) {
        results.push({ name: c.name, domain: c.domain, skipped: 'domain-mismatch' });
        continue;
      }
      if (rule.path && c.path && c.path !== rule.path) {
        results.push({ name: c.name, domain: c.domain, skipped: 'path-mismatch' });
        continue;
      }
      let removed = false;
      let lastError = null;
      for (const url of cookieUrlCandidates(c, tabUrl)) {
        try {
          const r = await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
          if (r) {
            removed = true;
            if (debug) console.debug('[paywall-scripts] deleted cookie', c.name, 'via', url);
            break;
          }
        } catch (e) {
          lastError = String(e && e.message);
        }
      }
      results.push({ name: c.name, domain: c.domain, removed, error: removed ? null : lastError });
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    await ensureRegistered();
    if (details.reason === 'install') {
      await seedDefaultConfig(false);
    }
    await pushConfigToTabs();
  })().catch((e) => console.error('[paywall-scripts] onInstalled:', e));
});

chrome.runtime.onStartup.addListener(() => {
  ensureRegistered().catch(() => {});
});

// The worker is torn down often; re-assert the registration on every wakeup.
// (Serialised with the onInstalled path -- see ensureRegistered.)
ensureRegistered().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    pushConfigToTabs().catch(() => {});
  }
});

/* -------------------------------------------------------------------------- */
/* message API (popup <-> background, content script <-> background)           */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  switch (msg.type) {
    case 'PC_GET_CONFIG':
      readConfig()
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case 'PC_SET_CONFIG':
      (async () => {
        if (!msg.config || !Array.isArray(msg.config.scripts)) {
          throw new Error('config must be an object with a "scripts" array');
        }
        await writeConfig(msg.config);
        await pushConfigToTabs();
        return { ok: true, scripts: msg.config.scripts.length };
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true;

    case 'PC_RESET_CONFIG':
      (async () => {
        const cfg = await seedDefaultConfig(true);
        await pushConfigToTabs();
        return { ok: true, config: cfg };
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case 'PC_APPLY_COOKIES':
      (async () => {
        const descriptors = Array.isArray(msg.cookies)
          ? msg.cookies
          : // legacy shape (names only): still accepted, but it carries no
            // domain, so every same-named cookie becomes a candidate.
            (Array.isArray(msg.names) ? msg.names.map((name) => ({ name })) : []);
        const tabUrl = sender && sender.tab && sender.tab.url;
        const results = await deleteCookies(descriptors, tabUrl, msg.debug !== false);
        return { ok: true, results };
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true;

    case 'PC_INJECT_MAIN':
      (async () => {
        const tabId = sender && sender.tab && sender.tab.id;
        if (typeof tabId !== 'number') throw new Error('no sender tab');
        const results = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [sender.frameId || 0] },
          world: 'MAIN',
          files: ['engine.js'],
          injectImmediately: true
        });
        const tagged = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [sender.frameId || 0] },
          world: 'MAIN',
          func: (cfg) => {
            window.__PC_ENGINE__ = true;
            window.__PC_CONFIG__ = cfg;
            try {
              const list = scriptsForUrl(cfg, location.href, false);
              list.forEach((s) => applyScript(s, { debug: cfg.debug !== false, state: (window.__PC_STATE__ = window.__PC_STATE__ || {}) }));
              return list.map((s) => s.id);
            } catch (e) {
              return [];
            }
          },
          // cookie rules cannot run here (no chrome.cookies in the page's world),
          // so hand over only the actions this world can actually execute.
          args: [mainWorldConfig(msg.config || {})]
        });
        return { ok: true, injected: results.length, ran: (tagged[0] && tagged[0].result) || [] };
      })()
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
      return true;

    default:
      return false;
  }
});
