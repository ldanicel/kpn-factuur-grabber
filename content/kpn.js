// Runs inside MijnKPN pages. Defines FGScan / FGClick / FGAccount for the service worker and passive.js.
(function () {
  if (globalThis.FGScan) return;
  const SELECTOR = 'a, button, [role="button"], [role="link"]';
  const MORE_RE = /^(toon|laad|bekijk) meer|meer (facturen|laden|tonen|bekijken)|oudere facturen|load more|show more/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // querySelectorAll that also looks inside open shadow roots (KPN builds its UI from web components).
  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deepAll(selector, el.shadowRoot));
    return out;
  }
  const visible = (el) => el.isConnected && (el.offsetParent !== null || el.getClientRects().length > 0);

  function labelOf(el) {
    return [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('download')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  // Walk up until the container text carries a date, so each button is tied to its invoice row.
  function contextOf(el) {
    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const text = (node.innerText || '').replace(/\s+/g, ' ');
      if (FG.parseDutchDate(text)) return text.slice(0, 400);
    }
    return '';
  }

  function collect() {
    const els = deepAll(SELECTOR);
    window.__fgEls = els;
    return els.map((el, index) => ({
      index,
      text: labelOf(el),
      href: el.href && /^https?:/.test(el.href) ? el.href : null,
      context: contextOf(el),
    }));
  }

  const isLogin = () => FG.looksLikeLogin(location.href, !!document.querySelector('input[type="password"]'));

  function storageValues() {
    const out = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      try { for (let i = 0; i < store.length; i++) out.push(store.getItem(store.key(i))); } catch (_) { /* blocked */ }
    }
    return out;
  }

  globalThis.FGAccount = function () {
    if (isLogin()) return { loggedIn: false, id: null };
    return { loggedIn: true, id: FG.extractAccountId(document.body ? document.body.innerText : '', storageValues()) };
  };

  // Expand "toon meer" style paging so older invoices are in the DOM too.
  // Any small element whose own text says "toon meer", including KPN's custom buttons and lazy lists.
  function findMore() {
    return deepAll(`${SELECTOR}, kpn-button, kpn-link, [class*="more"], [class*="meer"], span, div`)
      .filter((el) => el.children.length <= 3 && MORE_RE.test(labelOf(el)) && labelOf(el).length < 60 && visible(el))
      .sort((a, b) => a.children.length - b.children.length)[0];
  }

  async function expandAll() {
    for (let i = 0; i < 30; i++) {
      window.scrollTo(0, document.body.scrollHeight); // lazy lists load on scroll
      await sleep(800);
      const more = findMore();
      if (!more) {
        const before = deepAll(SELECTOR).length;
        await sleep(1200);
        if (deepAll(SELECTOR).length === before) return;
        continue;
      }
      more.click();
      await sleep(1500);
    }
  }

  // The product dropdown ("Alle facturen", then one option per number/address).
  function productSelect() {
    return deepAll('select').find((s) => [...s.options].some((o) => /alle facturen/i.test(o.text)));
  }
  globalThis.FGProductCount = function () {
    const s = productSelect();
    return s ? s.options.length : 0;
  };
  globalThis.FGChooseProduct = function (i) {
    const s = productSelect();
    if (!s || !s.options[i]) return false;
    s.selectedIndex = i;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  // The invoices page is a SPA: wait until rows render, a login form shows up, or we time out.
  globalThis.FGScan = async function ({ expand = false, timeoutMs = 20000 } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (isLogin()) return { status: 'login' };
      let invoices = FG.rankCandidates(collect());
      if (invoices.length) {
        if (expand) { await expandAll(); invoices = FG.rankCandidates(collect()); }
        return { status: 'ok', invoices, moreLinks: moreLinks(), account: FGAccount() };
      }
      await sleep(1000);
    }
    collect();
    return { status: 'none', url: location.href, moreLinks: moreLinks(), account: FGAccount() };
  };

  // Links to fuller invoice lists ("Bekijk alle facturen", one per product on the overview).
  function moreLinks() {
    const here = location.href.split('#')[0];
    return (window.__fgEls || [])
      .map((el, index) => ({ index, text: labelOf(el), href: el.href && /^https?:/.test(el.href) ? el.href : null }))
      .filter((l) => FG.ALL_RE.test(l.text) && l.href !== here);
  }

  // Privacy-safe page outline for debugging layout changes: labels and paths only, numbers and e-mails masked.
  globalThis.FGOutline = function () {
    // Masks e-mails, amounts and number runs (phone numbers with spaces/dashes too); dates stay readable.
    const me = (FGAccount().id || '').trim();
    const mask = (t) => (me ? String(t || '').split(me).join('<name>') : String(t || ''))
      .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
      .replace(/€\s*[\d.,]+/g, '€<amount>')
      .replace(/\b[A-Z][a-z]+(laan|straat|weg|plein|gracht|kade|singel|dijk|hof|pad)\s+\d+\w*/g, '<address>')
      .replace(/\b\d{2,4}(?:[\s-]?\d{2,}){2,}\b/g, '<n>')
      .replace(/\d{5,}/g, '<n>')
      .replace(/welkom,?\s*[^,]{2,40},/gi, 'Welkom <name>,')
      .slice(0, 120);
    return {
      url: location.origin + location.pathname,
      more: findMore() ? mask(labelOf(findMore())) : null,
      clickables: deepAll(SELECTOR).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: mask(labelOf(el)),
        href: el.href ? mask(new URL(el.href, location.href).pathname) : null,
        context: mask(contextOf(el)).slice(0, 80),
      })),
      selects: deepAll('select').map((s) => [...s.options].map((o) => mask(o.text))),
    };
  };

  // Prefer the element that carries the same label now: the list may have re-rendered since the scan.
  globalThis.FGClick = function (index, label) {
    let el = (window.__fgEls || [])[index];
    if (label && (!el || !el.isConnected || labelOf(el) !== label)) {
      el = deepAll(SELECTOR).find((x) => labelOf(x) === label) || el;
    }
    if (!el) return false;
    el.click();
    return true;
  };

  // Relay files caught by capture.js (page world) to the service worker.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__fg !== 'capture') return;
    const { dataUrl, url, name, error } = e.data;
    chrome.runtime.sendMessage({ type: 'captured', dataUrl, url, name, error });
  });
})();
