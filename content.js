/* =============================================================================
 * content.js -- runs in the ISOLATED world, at document_start, on every page.
 *
 * Two jobs:
 *   1. run the matching rules here (chrome.cookies / chrome.storage live here)
 *   2. hand the same rules to the PAGE's own world, where localStorage and
 *      sessionStorage are reachable
 * ========================================================================== */

const PC_STORAGE_KEY = 'paywallConfig';
const PC_SENTINEL = '__PC_MAIN_WORLD_ENGINE__';

let pcConfig = cloneConfig(DEFAULT_CONFIG);
let pcMatched = [];
let pcObserver = null;
let pcTimer = null;
let pcLastUrl = '';
const pcRuleState = {};
const pcDone = {};

/* -------------------------------------------------------------------------- */
/* apply                                                                       */
/* -------------------------------------------------------------------------- */

function pcRunTiers(tier) {
  const list = scriptsForUrl(pcConfig, location.href, false).filter(
    (s) => !s.runAt || s.runAt === tier || s.runAt === undefined
  );
  list.forEach((s) => applyScript(s, { debug: pcConfig.debug !== false, state: pcRuleState }));
  if (tier === 'document_start') {
    pcMatched = scriptsForUrl(pcConfig, location.href, false).map((s) => s.id);
  }
}

function pcUnlockScroll() {
  [document.documentElement, document.body].forEach((el) => {
    if (!el) return;
    ['overflow', 'overflow-y', 'position', 'height'].forEach((prop) => {
      try {
        el.style.removeProperty(prop);
      } catch (e) {
        /* ignore */
      }
    });
    try {
      el.classList.remove('fade-in', 'nytd-modal-open', 'modal-open');
      const cls = el.getAttribute && el.getAttribute('class');
      if (cls && /(clamp|truncat|locked|regwall|paywall|gate)/i.test(cls)) {
        // Leave the class alone; CSS rules handle the visuals. Only report.
      }
    } catch (e) {
      /* ignore */
    }
  });
}

function pcReapply() {
  // The MutationObserver fires constantly on a busy news page. Destructive and
  // expensive rules only need to run once per (soft) navigation, so remember
  // what was already handled instead of re-walking the DOM thirty times.
  if (location.href !== pcLastUrl) {
    pcLastUrl = location.href;
    pcDone.nuked = false;
    pcDone.text = false;
    pcRuleState.blockPatched = false;
  }

  scriptsForUrl(pcConfig, location.href, false).forEach((s) => {
    (s.rules || []).forEach((rule) => {
      if (!rule || typeof rule !== 'object') return;
      const t = rule.type;
      if (t === 'css' || t === 'click' || t === 'blockScripts') return; // already done at start
      if (t === 'nukeSelector' && pcDone.nuked) return;
      if (t === 'text' && pcDone.text) return;
      try {
        const merged = Object.assign({}, rule, { debug: false, state: pcRuleState });
        ACTION_HANDLERS[t](merged);
        // Only treat a destructive sweep as finished once it actually matched
        // something. Paywalls that appear later (very common) must still be
        // removed, so "nothing matched yet" must not latch the rule off.
        if (t === 'nukeSelector' && merged.removed) pcDone.nuked = true;
        if (t === 'text' && merged.removed) pcDone.text = true;
      } catch (e) {
        /* ignore */
      }
    });
  });
  pcUnlockScroll();
}

function pcObserve() {
  if (pcObserver || !document.documentElement) return;
  pcObserver = new MutationObserver(() => {
    if (pcTimer) return;
    pcTimer = setTimeout(() => {
      pcTimer = null;
      try {
        pcReapply();
      } catch (e) {
        /* ignore */
      }
    }, 250);
  });
  pcObserver.observe(document.documentElement, { childList: true, subtree: true });
}

/* -------------------------------------------------------------------------- */
/* cookie hygiene                                                              */
/*                                                                            */
/* IMPORTANT: `chrome.cookies` is NOT exposed to content scripts -- the         */
/* "cookies" permission grants it to the extension's service worker only.       */
/* (Verified in a real browser: `chrome.cookies` is undefined in the content    */
/* script's isolated world.) So cookie rules are delegated to the worker.       */
/* -------------------------------------------------------------------------- */

function pcApplyCookies(params) {
  const rules = (params && params.cookies) || [];
  const names = rules.filter((r) => r && r.name).map((r) => r.name);
  if (!names.length) return Promise.resolve({ ok: true, skipped: true });

  try {
    return Promise.resolve(
      chrome.runtime.sendMessage({ type: 'PC_APPLY_COOKIES', names, all: !!params.all })
    ).catch((e) => {
      console.warn('[paywall-scripts] cookie delegation failed:', e && e.message);
      return { ok: false, error: String(e && e.message) };
    });
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e && e.message) });
  }
}

/* -------------------------------------------------------------------------- */
/* main-world injection                                                        */
/* -------------------------------------------------------------------------- */

// A content script cannot executeScript() into its own tab, and it cannot read
// the page's localStorage. The background worker can do both, so we ask it and
// it targets the sender's tabId/frameId.
function pcRequestMainWorld() {
  try {
    const p = chrome.runtime.sendMessage({ type: 'PC_INJECT_MAIN', config: pcConfig });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

async function pcBoot() {
  try {
    const data = await chrome.storage.local.get(PC_STORAGE_KEY);
    const cfg = data && data[PC_STORAGE_KEY];
    if (cfg && Array.isArray(cfg.scripts)) pcConfig = cfg;
  } catch (e) {
    /* keep defaults */
  }

  const matched = scriptsForUrl(pcConfig, location.href, false);
  pcMatched = matched.map((s) => s.id);

  // 1) cookie deletion (async, fire and forget -- but never let a rejection
  //    escape and kill the rest of the boot sequence)
  matched.forEach((s) => {
    (s.rules || [])
      .filter((r) => r && r.type === 'cookie')
      .forEach((r) => {
        Promise.resolve(pcApplyCookies(r)).catch((e) => {
          console.warn('[paywall-scripts] cookie rule failed:', e && e.message);
        });
      });
  });

  // 2) everything else, synchronously, at document_start.
  //    Cookie rules are deliberately NOT passed to the engine here: the engine
  //    has no cookie handler, and content scripts cannot reach chrome.cookies.
  //    They were already delegated to the worker in step 1.
  matched.forEach((s) => {
    const startRules = (s.rules || []).filter((r) => r && r.type !== 'cookie');
    if (!startRules.length) return;
    applyScript(Object.assign({}, s, { rules: startRules }), {
      debug: pcConfig.debug !== false,
      state: pcRuleState
    });
  });

  // 3) the page's own world: localStorage/sessionStorage live there
  pcRequestMainWorld();

  // 4) end / idle passes + watch for late-injected paywall DOM
  const later = () => {
    try {
      pcRunTiers('document_end');
      pcReapply();
      pcObserve();
    } catch (e) {
      /* ignore */
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', later, { once: true });
  } else {
    later();
  }
  window.addEventListener('load', () => {
    try {
      pcReapply();
    } catch (e) {
      /* ignore */
    }
  });
}

/* -------------------------------------------------------------------------- */
/* paywall element reporter (helps you WRITE rules for a new site)             */
/* -------------------------------------------------------------------------- */

function pcCssPath(el) {
  const bits = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 4) {
    let part = node.tagName.toLowerCase();
    if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
      bits.unshift(part + '#' + node.id);
      break;
    }
    const cls = String(node.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c && c.length < 40 && /^[A-Za-z][\w-]*$/.test(c))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    }
    bits.unshift(part);
    node = parent;
    depth++;
  }
  return bits.join(' > ');
}

/**
 * Is the element actually visible right now?
 * This is what separates "the body is in the HTML and merely hidden" (fixable
 * with rules) from "the server never sent the body" (only a mirror can help).
 */
function pcVisibleState(el) {
  if (!el) return 'missing';
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.display === 'none') return 'display-none';
    if (cs.visibility === 'hidden') return 'visibility-hidden';
    if (node.hasAttribute && node.hasAttribute('hidden')) return 'hidden-attr';
    if (node.hasAttribute && node.hasAttribute('inert')) return 'inert';
    if (cs.opacity !== '' && parseFloat(cs.opacity) === 0) return 'opacity-0';
    if (node === document.body) break;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 'zero-size';
  return 'visible';
}

/**
 * A body can be "hidden" in ways that have nothing to do with display:none.
 * The Economist, for example, fades the text to white with a gradient and then
 * stops, which no display/visibility check will notice. These are the tell-tale
 * signs, and each one is fixable with a CSS rule.
 */
function pcFindClamp(el) {
  const hints = [];
  let node = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 12) {
    let cs = null;
    try {
      cs = getComputedStyle(node);
    } catch (e) {
      cs = null;
    }
    const cls = String(node.getAttribute('class') || '');
    const style = node.getAttribute('style') || '';

    // 1. height clamping: content taller than the box that shows it
    if (cs && cs.overflow !== 'visible' && node.scrollHeight > node.clientHeight + 8 && node.clientHeight > 0) {
      hints.push({ kind: 'height-clamped', selector: pcCssPath(node), overflow: cs.overflow, hiddenPx: node.scrollHeight - node.clientHeight });
    }
    // 2. a gradient / fade class or inline mask does the same thing visually
    if (/gradient|fade|faded|mask|truncat|clamp|readmore|read-more/i.test(cls + ' ' + style)) {
      hints.push({ kind: 'fade-class', selector: pcCssPath(node), cls: cls.slice(0, 90) });
    }
    if (cs) {
      const mask = (cs.maskImage || cs.webkitMaskImage || cs.getPropertyValue('-webkit-mask-image') || '').trim();
      if (mask && mask !== 'none' && mask !== 'initial') hints.push({ kind: 'css-mask', selector: pcCssPath(node), mask: String(mask).slice(0, 80) });
      // 3. a hard cap that the content exceeds
      if (cs.maxHeight && cs.maxHeight !== 'none' && node.scrollHeight > parseFloat(cs.maxHeight) + 8) {
        hints.push({ kind: 'max-height', selector: pcCssPath(node), maxHeight: cs.maxHeight });
      }
    }
    node = node.parentElement;
    depth++;
  }
  return hints;
}

/** Is the text visibly faded (e.g. white text on white) rather than removed? */
function pcFindFade(el) {
  const sample = el.querySelector('p') || el;
  try {
    const cs = getComputedStyle(sample);
    const m = String(cs.color || '').match(/rgba?\(([^)]+)\)/);
    let alpha = 1;
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      if (parts.length === 4) alpha = parts[3];
    }
    const op = parseFloat(cs.opacity);
    return {
      color: cs.color,
      alpha: Number.isFinite(alpha) ? alpha : 1,
      opacity: Number.isFinite(op) ? op : 1,
      selector: pcCssPath(sample)
    };
  } catch (e) {
    return null;
  }
}

/** Do any fixed/absolute overlays actually sit on top of the article text? */
function pcFindBlockers(el) {
  let rect;
  try {
    rect = el.getBoundingClientRect();
  } catch (e) {
    return [];
  }
  if (!rect || !rect.width) return [];
  const out = [];
  const nodes = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
  for (const n of nodes) {
    if (n === el || el.contains(n) || n.contains(el)) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(n.tagName)) continue;
    let cs;
    try {
      cs = getComputedStyle(n);
    } catch (e) {
      continue;
    }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = n.getBoundingClientRect();
    if (r.width < 120 || r.height < 120) continue;
    const overlapW = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
    const overlapH = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top);
    if (overlapW <= 0 || overlapH <= 0) continue;
    const covers = (overlapW * overlapH) / (rect.width * rect.height);
    if (covers > 0.15) {
      out.push({ selector: pcCssPath(n), position: cs.position, zIndex: cs.zIndex, coverage: Math.round(covers * 100) + '%' });
    }
  }
  return out.slice(0, 8);
}

/**
 * Measure how much article text this page actually contains, and whether it is
 * reachable. Add this to your own report when a site still looks truncated: it
 * tells you whether the problem is CSS/DOM (fixable) or the server.
 */
function pcMeasureArticle() {
  const candidates = [
    '[data-test-id="article-body"]',
    '[data-testid="articleBody"]',
    '[class*="article__body"]',
    '[class*="ArticleBody"]',
    '[class*="article-body"]',
    'article',
    'main'
  ];
  let best = null;
  for (const sel of candidates) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(sel));
    } catch (e) {
      continue;
    }
    for (const el of nodes) {
      const chars = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
      if (!best || chars > best.chars) {
        best = {
          selector: sel,
          chars,
          paragraphs: Array.from(el.querySelectorAll('p')).filter((p) => (p.textContent || '').trim().length > 40).length,
          visibility: pcVisibleState(el),
          el
        };
      }
    }
  }
  if (!best) return null;

  // How much text sits behind a gate we could remove?
  const bodyChars = (document.body.textContent || '').replace(/\s+/g, ' ').trim().length;

  // Is the rest of the story perhaps already present but late-loaded?
  const markerPhrases = ['subscriber', 'subscribe', 'sign in', 'register to continue', 'continue reading'];
  const gated = [];
  Array.from(document.querySelectorAll('body *')).slice(0, 4000).forEach((el) => {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) return;
    const t = (el.textContent || '').trim().toLowerCase();
    if (!t || t.length > 220) return;
    if (markerPhrases.some((p) => t.includes(p))) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 30) {
        gated.push({
          selector: pcCssPath(el),
          text: t.slice(0, 100),
          visibility: pcVisibleState(el),
          size: Math.round(rect.width) + 'x' + Math.round(rect.height)
        });
      }
    }
  });

  const visibleChars = best.visibility === 'visible' ? best.chars : 0;

  const clampHints = pcFindClamp(best.el);
  const fade = pcFindFade(best.el);
  const blockers = pcFindBlockers(best.el);

  // Decide what is actually wrong. Order matters: "the server sent nothing" is
  // the only verdict no rule can fix.
  let verdict;
  let explanation;
  if (best.chars < 600) {
    verdict = 'server-truncated';
    explanation =
      'The article body contains almost no text. The server did not send it, so no CSS or DOM rule can recover it.';
  } else if (best.visibility !== 'visible') {
    verdict = 'hidden-but-present';
    explanation =
      'The text IS in the page but is hidden (' + best.visibility + '). A rule can reveal it — this is fixable.';
  } else if (clampHints.length || (fade && (fade.alpha < 0.95 || fade.opacity < 0.95))) {
    verdict = 'visually-truncated';
    explanation =
      'The FULL ARTICLE IS IN THE PAGE and is rendered — but it is visually faded or clipped, which is why only the first lines look readable. A CSS rule can remove it. This is fixable.';
  } else if (blockers.length) {
    verdict = 'covered-by-overlay';
    explanation =
      'The article text is present but ' + blockers.length + ' overlay(s) cover it. A css/nukeSelector rule can remove them. This is fixable.';
  } else {
    verdict = 'readable';
    explanation = 'The article text is present and visible; the rules are not the problem here.';
  }

  return {
    selector: best.selector,
    chars: best.chars,
    paragraphs: best.paragraphs,
    visibility: best.visibility,
    visibleChars,
    bodyChars,
    clampHints,
    fade,
    blockers,
    gated: gated.slice(0, 12),
    verdict,
    explanation
  };
}

function pcReportPaywall() {
  const WORDS = /(paywall|regwall|gateway|meter|subscribe|subscription|locked|truncat|premium|membership|regi-|gate-)/i;
  const out = [];
  const seen = new Set();

  Array.from(document.querySelectorAll('body *')).some((el) => {
    if (out.length >= 40) return true;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(el.tagName)) return false;

    const id = el.id || '';
    const cls = el.getAttribute('class') || '';
    const testid = el.getAttribute('data-testid') || '';
    if (!WORDS.test(id + ' ' + cls + ' ' + testid)) return false;

    const rect = el.getBoundingClientRect();
    const text = (el.textContent || '').trim().slice(0, 90).replace(/\s+/g, ' ');
    const key = pcCssPath(el);
    if (seen.has(key)) return false;
    seen.add(key);

    out.push({
      tag: el.tagName.toLowerCase(),
      id,
      cls: cls.slice(0, 80),
      testid,
      size: Math.round(rect.width) + 'x' + Math.round(rect.height),
      position: rect.width > 0 ? getComputedStyle(el).position : '',
      text,
      selector: key
    });
    return false;
  });

  const truncated = Array.from(document.querySelectorAll('[aria-hidden="true"], [hidden], [inert], [data-truncated]')).slice(0, 12);
  return {
    ok: true,
    url: location.href,
    measurement: pcMeasureArticle(),
    candidates: out,
    hiddenContainers: truncated.map((el) => ({ selector: pcCssPath(el), tag: el.tagName.toLowerCase() })),
    inlineStyleClamps: Array.from(document.querySelectorAll('body *'))
      .filter((el) => /hidden|none/i.test(el.getAttribute('style') || ''))
      .slice(0, 12)
      .map((el) => ({ selector: pcCssPath(el), style: el.getAttribute('style') }))
  };
}

/* -------------------------------------------------------------------------- */
/* messages                                                                    */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'PC_REPORT_PAYWALL') {
    try {
      sendResponse(pcReportPaywall());
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  }

  if (msg.type === 'PC_CONFIG_UPDATED') {
    pcConfig = msg.config || pcConfig;
    pcMatched = scriptsForUrl(pcConfig, location.href, false).map((s) => s.id);
    try {
      scriptsForUrl(pcConfig, location.href, false).forEach((s) => {
        (s.rules || [])
          .filter((r) => r && r.type === 'cookie')
          .forEach((r) => pcApplyCookies(r));
        applyScript(Object.assign({}, s, { rules: (s.rules || []).filter((r) => r && r.type !== 'cookie') }), {
          debug: pcConfig.debug !== false,
          state: pcRuleState
        });
      });
      pcRequestMainWorld();
    } catch (e) {
      /* ignore */
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_STATUS') {
    sendResponse({
      ok: true,
      url: location.href,
      matched: pcMatched,
      blockedScripts: pcRuleState.blocked || 0,
      engineLoaded: !!window.__PC_ENGINE__
    });
    return false;
  }

  if (msg.type === 'PC_RUN_NOW') {
    try {
      pcReapply();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return false;
  }

  return false;
});

pcBoot();
