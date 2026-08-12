/**
 * A tiny DOM/browser harness for pay.html.
 *
 * The interesting security logic in pay.html lives in a plain <script>
 * block, not in a module we can import. Grepping the file for the right
 * strings (which scripts/pay-html-amount-validation.test.mjs does) pins
 * the wiring, but it cannot answer the question that actually matters:
 *
 *     "given THIS url, does the customer see a pay form, and what
 *      amount does the page try to charge?"
 *
 * So we extract the script, run it inside node:vm against a stub DOM,
 * and assert on the observable outcome: which card is visible, what the
 * amount line says, what got POSTed to /api/initialize-payment, and what
 * was beaconed to /api/log/bad-amount.
 *
 * The stub is deliberately minimal — just the handful of DOM APIs
 * pay.html touches. If pay.html starts using something else, the test
 * fails loudly rather than silently passing.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAY_HTML_PATH = path.join(REPO_ROOT, 'pay.html');

/** The boot line we strip so the harness controls when the page loads. */
const BOOT_CALL = 'loadPaymentDetails();';

/** Pull the last (and only) <script> block that has no src attribute. */
export function extractPayHtmlScript(html = fs.readFileSync(PAY_HTML_PATH, 'utf8')) {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (!blocks.length) throw new Error('pay.html: no inline <script> block found');
  return blocks[blocks.length - 1][1];
}

// ─── Stub DOM ─────────────────────────────────────────────────────────

class StubClassList {
  constructor(initial = []) { this.set = new Set(initial); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toString() { return [...this.set].join(' '); }
}

class StubElement {
  constructor(id, classes = []) {
    this.id = id;
    this.classList = new StubClassList(classes);
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.href = '';
    this.disabled = false;
    this.readOnly = false;
    this.focused = false;
  }
  focus() { this.focused = true; }
  get hidden() { return this.classList.contains('hidden'); }
  get visible() { return !this.classList.contains('hidden'); }
}

/**
 * Elements that start hidden in pay.html's markup. Everything else
 * defaults to visible, which mirrors the real page closely enough for
 * "which card is the customer looking at?" assertions.
 */
const INITIALLY_HIDDEN = new Set([
  'errorState', 'paymentCard', 'successState', 'closeHint', 'lockedInfo', 'phoneError'
]);

function makeDocument() {
  const elements = new Map();
  return {
    title: '',
    referrer: '',
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, new StubElement(id, INITIALLY_HIDDEN.has(id) ? ['hidden'] : []));
      }
      return elements.get(id);
    },
    createElement() {
      // Only used by sanitize(): set .textContent, read escaped .innerHTML.
      const el = new StubElement('synthetic');
      return new Proxy(el, {
        set(target, prop, value) {
          if (prop === 'textContent') {
            target.textContent = value;
            target.innerHTML = String(value == null ? '' : value)
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return true;
          }
          target[prop] = value;
          return true;
        }
      });
    },
    addEventListener() {},
    _elements: elements
  };
}

/**
 * Load pay.html into a stub browser.
 *
 * @param {object} options
 * @param {string} options.url        - the URL the customer opened.
 * @param {function} options.fetch    - async (url, init) => ({ok, json})
 * @param {object}  [options.paystack]- stub for PaystackPop.
 * @returns {object} handle with { document, requests, beacons, run, ... }
 */
export function loadPayHtml({ url, fetch: fetchImpl, paystack } = {}) {
  const source = extractPayHtmlScript();
  if (!source.includes(BOOT_CALL)) {
    throw new Error(`pay.html: expected a "${BOOT_CALL}" boot call to strip`);
  }
  // Strip the boot call so the harness decides when the page loads.
  const scriptSource = source.replace(BOOT_CALL, '/* boot suppressed by test harness */');

  const parsed = new URL(url);
  const document = makeDocument();

  /** Every fetch()/sendBeacon() the page made, in order. */
  const requests = [];
  const beacons = [];
  const alerts = [];
  const consoleWarnings = [];
  const navigations = [];

  const location = {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    hash: parsed.hash,
    get search() { return parsed.search; },
    set search(value) { navigations.push({ type: 'search', value }); }
  };

  const wrappedFetch = async (input, init = {}) => {
    const request = { url: String(input), init, body: safeJson(init.body) };
    requests.push(request);
    if (!fetchImpl) throw new Error(`unexpected fetch(${request.url}) — no stub supplied`);
    return fetchImpl(request.url, init, request);
  };

  const context = {
    console: {
      log: () => {},
      error: () => {},
      warn: (...args) => consoleWarnings.push(args.join(' '))
    },
    document,
    fetch: wrappedFetch,
    URL,
    URLSearchParams,
    Blob: class Blob {
      constructor(parts) { this.parts = parts; this.text = parts.join(''); }
    },
    Number, Math, JSON, Date, String, Boolean, Array, Object, Error, parseFloat, parseInt, isNaN,
    encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    alert: message => alerts.push(String(message)),
    PaystackPop: paystack || class PaystackPop {
      resumeTransaction() { throw new Error('PaystackPop used without a stub'); }
    },
    navigator: {
      userAgent: 'valmont-pay-test-harness',
      sendBeacon: (endpoint, blob) => {
        beacons.push({ url: String(endpoint), body: safeJson(blob && blob.text) });
        return true;
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  context.window.location = location;
  context.location = location;
  context.window.close = () => navigations.push({ type: 'close' });

  vm.createContext(context);
  vm.runInContext(scriptSource, context, { filename: 'pay.html<script>' });

  return {
    context,
    document,
    requests,
    beacons,
    alerts,
    consoleWarnings,
    navigations,
    /** Run the page's boot sequence and wait for it to settle. */
    async load() {
      await vm.runInContext('loadPaymentDetails()', context, { filename: 'pay.html<boot>' });
      await settle();
    },
    /** Invoke an in-page function by name, e.g. payWithValmontPay(). */
    async call(expression) {
      const result = await vm.runInContext(expression, context, { filename: 'pay.html<call>' });
      await settle();
      return result;
    },
    /** Convenience accessors for the three cards. */
    get showsPayForm() { return document.getElementById('paymentCard').visible; },
    get showsError() { return document.getElementById('errorState').visible; },
    get errorTitle() { return document.getElementById('errorTitle').textContent; },
    get errorMessage() { return document.getElementById('errorMessage').textContent; },
    get amountDisplayed() { return document.getElementById('amountDisplay').textContent; },
    /** The body of the POST to /api/initialize-payment, if any. */
    get initializeCall() {
      return requests.find(r => r.url.includes('/api/initialize-payment')) || null;
    },
    /** Beacons sent to the bad-amount audit endpoint. */
    get badAmountReports() {
      return beacons
        .filter(b => b.url.includes('/api/log/bad-amount'))
        .concat(requests.filter(r => r.url.includes('/api/log/bad-amount')).map(r => ({ url: r.url, body: r.body })));
    }
  };
}

function safeJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch (_) { return value; }
}

/** Let queued microtasks/timers drain so async page logic finishes. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export { PAY_HTML_PATH, REPO_ROOT };
