/* =============================================================================
 * engine.js  --  the userscript rules engine (shared by EVERY world)
 *
 * This file is deliberately world-agnostic: the background service worker loads
 * it with importScripts(), the content script loads it via the manifest, and the
 * content script ALSO injects its source into the page's own JS world, where it
 * has access to window.localStorage / window.sessionStorage.
 *
 * Everything the engine needs is passed in explicitly (params), because:
 *   - a page can null out window.chrome, so we must not reference `chrome` here
 *   - chrome.scripting serializes params, so no closures survive
 * ========================================================================== */

/* eslint-disable no-unused-vars */
const DEFAULT_CONFIG = {
  version: 1,
  scripts: []
};

/* -------------------------------------------------------------------------- */
/* config helpers                                                              */
/* -------------------------------------------------------------------------- */

function cloneConfig(cfg) {
  try {
    return JSON.parse(JSON.stringify(cfg || DEFAULT_CONFIG));
  } catch (e) {
    return { version: 1, scripts: [] };
  }
}

function getEnabledScripts(cfg) {
  return (cfg && Array.isArray(cfg.scripts) ? cfg.scripts : [])
    .filter((s) => s && s.enabled !== false && Array.isArray(s.rules));
}

function scriptsForUrl(cfg, url, includeDisabled) {
  return (cfg && Array.isArray(cfg.scripts) ? cfg.scripts : []).filter((s) => {
    if (!s || !Array.isArray(s.rules)) return false;
    if (!includeDisabled && s.enabled === false) return false;
    return (s.matches || []).some((p) => urlMatches(url, p));
  });
}

/**
 * Strip the actions the PAGE's own world can never perform.
 *
 * `chrome.cookies` is granted to the extension service worker only; the MAIN
 * world used to get `chrome` at all. So a `cookie` rule there can only ever hit
 * "unknown rule type" in the console, once per page, forever. Cookies are
 * deleted by the worker instead (content.js asks it to). Filtering here keeps
 * the console clean and stops the main world from printing noise about rules it
 * was never able to run.
 */
const MAIN_WORLD_UNRUNNABLE = ['cookie'];

function mainWorldConfig(cfg) {
  const source = Array.isArray(cfg) ? cfg : (cfg && cfg.scripts) || [];
  const scripts = source
    .map((s) => {
      if (!s || !Array.isArray(s.rules)) return null;
      const rules = s.rules.filter((r) => r && !MAIN_WORLD_UNRUNNABLE.includes(r.type));
      if (!rules.length) return null; // nothing left for this world to do
      return Object.assign({}, s, { rules });
    })
    .filter(Boolean);

  if (Array.isArray(cfg)) return scripts;
  return Object.assign({}, cfg, { scripts });
}

/* -------------------------------------------------------------------------- */
/* match patterns (same syntax as a Chrome extension content script)           */
/* -------------------------------------------------------------------------- */

function patternToRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern;

  const p = String(pattern || '').trim();
  if (!p) return null;

  // An explicit regex is allowed: "/^https:\/\/example\.com\//i"
  if (p.length > 2 && p[0] === '/') {
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash > 0) {
      const body = p.slice(1, lastSlash);
      const flags = p.slice(lastSlash + 1);
      try {
        return new RegExp(body, flags);
      } catch (e) {
        /* fall through to glob handling */
      }
    }
  }

  // Chrome match pattern: <scheme>://<host><path>
  const m = p.match(/^(\*|https?|file|ftp|urn):\/\/([^/]*)(\/.*)$/);
  if (m) {
    const [, scheme, host, pathRaw] = m;
    const schemeRe = scheme === '*' ? '(?:https?|file|ftp|urn)' : scheme;
    let hostRe;
    if (host === '*') {
      hostRe = '[^/]+';
    } else if (host.startsWith('*.')) {
      const base = escapeRegExp(host.slice(2));
      hostRe = '(?:[^/]+\\.)?' + base; // *.site.com also matches site.com
    } else {
      hostRe = escapeRegExp(host);
    }
    const pathRe = escapeRegExp(pathRaw).replace(/\\\*/g, '.*');
    try {
      return new RegExp('^' + schemeRe + '://' + hostRe + pathRe + '$', 'i');
    } catch (e) {
      return null;
    }
  }

  // Plain wildcard glob, e.g. "*paywall*" or "*://*/*meter*"
  try {
    return new RegExp('^' + escapeRegExp(p).replace(/\\\*/g, '.*') + '$', 'i');
  } catch (e) {
    return null;
  }
}

function urlMatches(url, pattern) {
  const re = patternToRegExp(pattern);
  if (!re) return false;
  try {
    return re.test(url);
  } catch (e) {
    return false;
  }
}

let __pcEscRe = null;
function escapeRegExp(s) {
  if (!__pcEscRe) __pcEscRe = /[.*+?^${}()|[\]\\]/g;
  return String(s).replace(__pcEscRe, '\\$&');
}

/* -------------------------------------------------------------------------- */
/* small utilities                                                             */
/* -------------------------------------------------------------------------- */

function hostHas(host, value) {
  if (!value) return true;
  const h = String(host || '').replace(/^\./, '').toLowerCase();
  const v = String(value).replace(/^\./, '').toLowerCase();
  return h === v || h.endsWith('.' + v);
}

function globMatch(str, pattern) {
  const re = patternToRegExp(pattern);
  if (!re) return false;
  try {
    return re.test(String(str));
  } catch (e) {
    return false;
  }
}

function safeQueryAll(selector) {
  try {
    return Array.from(document.querySelectorAll(selector));
  } catch (e) {
    return [];
  }
}

// Accepts "div.x" or { selector: "div.x", style: "display:block!important" }
function normalizeSelector(item) {
  if (typeof item === 'string') return { selector: item, style: '' };
  if (item && typeof item === 'object' && typeof item.selector === 'string') {
    return { selector: item.selector, style: item.style || '' };
  }
  return null;
}

function looksLikeElementList(v) {
  return v && typeof v === 'object' && typeof v.length === 'number' && !Array.isArray(v);
}

/* -------------------------------------------------------------------------- */
/* content protection                                                          */
/*                                                                            */
/* Paywall CSS class names are machine-generated and change constantly, so a   */
/* selector like [class*="Paywall"] can easily match the article wrapper. This */
/* is the one failure mode that ruins a page permanently (and would be         */
/* re-applied on every mutation), so destructive actions refuse to touch a     */
/* node that is, or wraps, the actual article body.                            */
/* -------------------------------------------------------------------------- */

const ARTICLE_BODY_SELECTOR =
  '[data-testid="articleBody"], [name="articleBody"], article, main, ' +
  '[class*="article-body" i], [class*="articleBody" i], [itemprop="articleBody"]';

function isProtectedContent(el, selectorText) {
  if (!el || typeof el.closest !== 'function') return true;
  const name = (el.tagName || '').toLowerCase();
  if (name === 'html' || name === 'body' || name === 'main' || name === 'article') return true;

  // The element itself looks like the article body...
  try {
    if (el.matches(ARTICLE_BODY_SELECTOR)) return true;
  } catch (e) {
    /* ignore */
  }

  // ...or it wraps one. (A paywall overlay never contains the article body.)
  try {
    if (el.querySelector && el.querySelector(ARTICLE_BODY_SELECTOR)) return true;
  } catch (e) {
    /* ignore */
  }

  if (typeof selectorText === 'string') {
    const sel = selectorText.toLowerCase();
    if (sel.includes('articlebody')) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* actions                                                                     */
/* -------------------------------------------------------------------------- */

const ACTION_HANDLERS = {
  /* Inject a <style> tag. Runs at document_start, so it lands before paint.  */
  css(params) {
    const parts = [];
    (params.hide || []).forEach((item) => {
      const n = normalizeSelector(item);
      if (!n) return;
      const style = n.style || 'display: none !important;';
      parts.push(n.selector + ' { ' + style + ' }');
    });
    if (params.css) parts.push(params.css);
    if (!parts.length) return;
    const style = document.createElement('style');
    style.setAttribute('data-paywall-scripts', params.scriptId || '');
    style.textContent = parts.join('\n');
    (document.head || document.documentElement).appendChild(style);
  },

  /* Undo a hidden/inert state a paywall applied to real content.             */
  unhide(params) {
    const attrs = Array.isArray(params.attrs) ? params.attrs : ['hidden', 'aria-hidden', 'inert'];
    (params.selectors || []).forEach((sel) => {
      safeQueryAll(sel).forEach((el) => {
        attrs.forEach((a) => el.removeAttribute(a));
        el.style.removeProperty('display');
        el.style.removeProperty('visibility');
        el.style.removeProperty('opacity');
        el.removeAttribute('data-paywall-scripts-hidden');
      });
    });
  },

  /* Strip leftover paywall wording out of text nodes.                       */
  text(params) {
    const phrases = (params.phrases || ['Subscribe to continue reading']).map((p) => String(p).toLowerCase());

    // Cheap pre-check over the whole document: on a busy page the observer fires
    // constantly, and walking every text node each time is wasteful.
    let bodyText = '';
    try {
      bodyText = (document.body ? document.body.textContent || '' : '').toLowerCase();
    } catch (e) {
      bodyText = '';
    }
    if (!phrases.some((p) => bodyText.includes(p))) {
      params.removed = 0;
      return 0;
    }

    const nodes = params.selectors && params.selectors.length
      ? params.selectors.reduce((acc, sel) => acc.concat(safeQueryAll(sel)), [])
      : [document.body].filter(Boolean);

    let removed = 0;
    nodes.forEach((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const hits = [];
      let node;
      while ((node = walker.nextNode())) {
        const value = (node.nodeValue || '').trim().toLowerCase();
        if (!value) continue;
        if (phrases.some((p) => value.includes(p))) hits.push(node);
      }
      hits.forEach((n) => {
        const el = n.parentElement;
        if (el && el.closest('script, style, noscript')) return;
        // Remove the whole containing block, not just the bare text: paywalls
        // usually render "Subscribe to continue reading" inside its own wrapper.
        const target = el && el.parentElement ? el : n;
        if (el && isProtectedContent(target)) {
          // Paywall wording inside the article itself: drop the text, not the node.
          n.nodeValue = '';
          removed++;
          return;
        }
        target.remove();
        removed++;
      });
    });
    params.removed = removed;
    return removed;
  },

  /* Clear localStorage / sessionStorage keys by exact name or prefix.        */
  storage(params) {
    let local = null;
    let session = null;
    try {
      local = window.localStorage;
    } catch (e) {
      /* storage can be blocked by policy */
    }
    try {
      session = window.sessionStorage;
    } catch (e) {
      /* ignore */
    }
    applyStorageClear(params, local, 'local');
    applyStorageClear(params, session, 'session');
  },

  /* Remove truncation flags such as isAccessibleForFree="false".            */
  untruncate(params) {
    (params.selectors || []).forEach((sel) => {
      safeQueryAll(sel).forEach((el) => {
        (params.attrs || []).forEach((a) => el.removeAttribute(a));
      });
    });
    // Google/News paywall convention: itemprop="isAccessibleForFree" = false.
    // A <meta> is safe to drop; when the flag sits on a real container
    // (<article itemprop="..."> is very common) we must NOT remove the element,
    // we just flip the flag to true.
    safeQueryAll('[itemprop="isAccessibleForFree"]').forEach((el) => {
      const name = (el.tagName || '').toUpperCase();
      if (name === 'META' || name === 'LINK') {
        el.remove();
      } else {
        el.setAttribute('itemprop', 'isAccessibleForFree');
        el.setAttribute('content', 'true');
        el.setAttribute('data-paywall-scripts-untruncated', '1');
      }
    });
  },

  /* Poll for a button and click it (already-clicked elements are tracked).   */
  click(params) {
    const tries = Number.isFinite(params.tries) ? params.tries : 10;
    const gap = Number.isFinite(params.gap) ? params.gap : 250;
    const selectors = params.selectors || [];
    const state = (params.state = params.state || {});

    const attempt = () => {
      selectors.forEach((sel) => {
        safeQueryAll(sel).forEach((el) => {
          if (el.dataset && el.dataset.paywallScriptsClicked === '1') return;
          if (el.disabled) return;
          // No visibility gate on purpose: paywall buttons are frequently inside
          // a container the rules just hid, and a stray click on a "show all"
          // link is harmless compared to a click that never happens.
          try {
            if (el.dataset) el.dataset.paywallScriptsClicked = '1';
            el.click();
          } catch (e) {
            /* ignore */
          }
        });
      });
    };

    attempt();
    if (tries <= 1) return;
    let left = tries - 1;
    const timer = setInterval(() => {
      attempt();
      if (--left <= 0) clearInterval(timer);
    }, Math.max(50, gap));
  },

  /* Stop matching <script src> from ever reaching the network.              */
  blockScripts(params) {
    if (params.state && params.state.blockPatched) return;
    if (params.state) params.state.blockPatched = true;

    const patterns = params.patterns || [];
    const state = params.state || (params.state = {});
    state.blocked = 0;

    const wanted = (url) => patterns.some((p) => globMatch(String(url), p));
    const disabled = new WeakSet();

    const flag = (el, url) => {
      if (!el || disabled.has(el)) return;
      disabled.add(el);
      state.blocked++;
      // A failed <script src> fires error; this keeps the console quiet.
      el.addEventListener('error', (e) => e.stopImmediatePropagation(), true);
      if (params.debug) console.debug('[paywall-scripts] blocked script:', url);
    };

    // 1) block already-existing tags (document_start catches most of them)
    safeQueryAll('script[src]').forEach((s) => {
      if (wanted(s.src)) flag(s, s.src);
    });

    // 2) intercept property assignment:  script.src = "..."
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
      if (desc && desc.configurable && typeof desc.set === 'function' && typeof desc.get === 'function') {
        Object.defineProperty(HTMLScriptElement.prototype, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get() {
            return desc.get.call(this);
          },
          set(value) {
            if (wanted(value)) {
              flag(this, value);
              return; // swallow the assignment: no request, no inline script
            }
            return desc.set.call(this, value);
          }
        });
      }
    } catch (e) {
      /* leave native behaviour intact */
    }

    // 3) intercept setAttribute('src', ...): some bundles use this path
    try {
      const nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (
          this instanceof HTMLScriptElement &&
          typeof name === 'string' &&
          name.toLowerCase() === 'src' &&
          wanted(value)
        ) {
          flag(this, value);
          return;
        }
        return nativeSetAttribute.call(this, name, value);
      };
    } catch (e) {
      /* ignore */
    }
  },

  /* Hard-remove matching elements (also used by the MutationObserver pass).  */
  nukeSelector(params) {
    let removed = 0;
    (params.selectors || []).forEach((sel) => {
      safeQueryAll(sel).forEach((el) => {
        if (isProtectedContent(el, sel)) {
          if (params.debug) console.debug('[paywall-scripts] nukeSelector refused (protected):', sel);
          return;
        }
        try {
          el.remove();
          removed++;
        } catch (e) {
          /* ignore */
        }
      });
    });
    // Report whether anything matched, so a caller can tell "nothing to do yet"
    // apart from "already handled". Paywalls are often injected after load, and
    // the observer must keep looking.
    params.removed = removed;
    return removed;
  },

  /* Run raw JS inside the world the engine is currently running in.          */
  main(params) {
    if (!params.js) return;
    // NOTE: inside the page's MAIN world this is subject to the page's own CSP.
    // A site with a strict script-src (no 'unsafe-eval') will refuse it, which
    // is expected, not a bug.
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(params.js);
    } catch (e) {
      console.warn(
        '[paywall-scripts] "main" rule blocked by the page CSP (' + (e && e.message) + '). ' +
          'Use click / css / unhide / storage / redirect rules instead.'
      );
      return;
    }
    try {
      fn.call(window);
    } catch (e) {
      console.warn('[paywall-scripts] "main" rule threw:', e && e.message);
    }
  },

  /**
   * Send the tab to a different url.
   *
   * This is the only honest tool for a hard (server-side) paywall: no amount of
   * DOM work can materialise a body the server refused to send. For those sites
   * the workable move is to fetch the same article from a source that does serve
   * it (an archive mirror), which is what this action is for.
   *
   * Use `onlyIfGated` to avoid hijacking a page you can already read.
   */
  redirect(params) {
    if (params.state && params.state.redirected) return;

    // `url` may be supplied explicitly (keeps the decision logic testable, and
    // makes it obvious which url the `when` patterns are tested against).
    const url = params.url || location.href;
    const target = resolveRedirect(params, url);
    if (!target) return;

    const go = () => {
      if (params.state) params.state.redirected = true;
      if (params.debug) console.debug('[paywall-scripts] redirecting to', target);
      try {
        location.replace(target);
      } catch (e) {
        location.href = target;
      }
    };

    // onlyIfGated: paywalls often appear a moment after load, so wait a little.
    if (params.onlyIfGated) {
      const sel = params.gateSelector || '[class*="paywall" i], [id*="paywall" i], [class*="Regwall" i], [class*="gateway" i]';
      const deadline = Date.now() + (Number.isFinite(params.waitMs) ? params.waitMs : 2500);
      const check = () => {
        let gated = false;
        try {
          gated = Array.from(document.querySelectorAll(sel)).some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 80 && r.height > 80;
          });
        } catch (e) {
          gated = false;
        }
        const thin = (document.body ? (document.body.textContent || '').trim().length : 0) < (params.minChars || 1200);
        if (gated || (params.alsoIfThin && thin)) return go();
        if (Date.now() < deadline) return void (params.state && (params.state._redirectTimer = setTimeout(check, 300)));
      };
      check();
      return;
    }
    go();
  }
};

function applyStorageClear(params, store, kind) {
  const wanted = (params && params[kind]) || [];
  if (!store || !wanted.length) return;
  const doomed = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key == null) continue;
      if (wanted.some((w) => key === w || key.indexOf(w) === 0)) doomed.push(key);
    }
  } catch (e) {
    return;
  }
  doomed.forEach((k) => {
    try {
      store.removeItem(k);
    } catch (e) {
      /* ignore */
    }
  });
  if (params.debug && doomed.length) {
    console.debug('[paywall-scripts] cleared ' + kind + 'Storage:', doomed);
  }
}

/**
 * Decide where a `redirect` rule should send the tab, or null for "stay put".
 *
 * Extracted as a pure function on purpose: the decision (which url patterns
 * qualify, and how `{href}` is substituted) is the part worth testing, and a
 * browser will not let you probe a real navigation after the fact.
 *
 * `{href}` is replaced with the RAW url, not percent-encoded: mirrors take the
 * plain form, and encoding it would double-escape query strings.
 */
function resolveRedirect(params, currentUrl) {
  if (!params || (!params.to && !params.toUrl)) return null;
  const url = params.url || currentUrl || '';

  if (Array.isArray(params.when) && params.when.length) {
    if (!params.when.some((p) => globMatch(url, p))) return null;
  }

  const target = String(params.toUrl || params.to);
  return target.replace(/\{url\}/g, encodeURIComponent(url)).replace(/\{href\}/g, url);
}

/* -------------------------------------------------------------------------- */
/* applying rules                                                              */
/* -------------------------------------------------------------------------- */
/**
 * Run one userscript's rules.
 * @param {object} script   one entry from config.scripts
 * @param {object} [params] engine params (state, debug, ...)
 */
function applyScript(script, params) {
  if (!script || !Array.isArray(script.rules)) return;
  const p = params || {};

  script.rules.forEach((rule) => {
    if (!rule || typeof rule !== 'object') return;
    const handler = ACTION_HANDLERS[rule.type];
    if (!handler) {
      if (p.debug) console.warn('[paywall-scripts] unknown rule type:', rule.type);
      return;
    }
    // Merge so a caller can pass { debug: true } / { state: {} } once.
    try {
      handler(Object.assign({}, rule, p, { scriptId: script.id }));
    } catch (e) {
      console.warn('[paywall-scripts] rule "' + rule.type + '" failed in ' + script.id + ':', e && e.message);
    }
  });
}

/** Run every matching userscript for `url`. */
function applyConfig(cfg, params) {
  const p = params || {};
  const url = p.url || (typeof location !== 'undefined' ? location.href : '');
  const list = scriptsForUrl(cfg, url, !!p.includeDisabled);
  list.forEach((s) => applyScript(s, p));
  return list.map((s) => s.id);
}

/** Debug helper used by the popup's "test on this tab" button. */
function describeMatch(cfg, url) {
  const all = (cfg && cfg.scripts) || [];
  return all.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled !== false,
    matched: (s.matches || []).some((p) => urlMatches(url, p)),
    rules: (s.rules || []).length
  }));
}
