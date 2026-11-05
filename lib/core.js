// Pure helpers shared by the service worker, the content script and the tests.
// Loaded as a classic script (importScripts / executeScript) and as a CommonJS module in Node.
(function (root) {
  const MONTHS = {
    jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, maart: 3, apr: 4, april: 4,
    mei: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, augustus: 8,
    sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const pad = (n) => String(n).padStart(2, '0');

  // "12 oktober 2026", "12 okt. 2026", "oktober 2026", "12-10-2026", "12/10/2026", "2026-10-12"
  function parseDutchDate(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    let m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (m) return valid(+m[3], +m[2], +m[1]);
    m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_RE})\\.?\\s+(\\d{4})\\b`));
    if (m) return valid(+m[3], MONTHS[m[2]], +m[1]);
    m = t.match(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{4})\\b`));
    if (m) return valid(+m[2], MONTHS[m[1]], 1);
    return null;
  }
  function valid(y, mo, d) {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, m: mo, d };
  }
  const isoDate = (dt) => (dt ? `${dt.y}-${pad(dt.m)}-${pad(dt.d)}` : null);

  // "€ 45,67", "€45.67", "45,67 euro" -> 45.67
  function parseAmount(text) {
    if (!text) return null;
    const m = String(text).match(/€\s*(\d{1,5}(?:[.,]\d{3})*[.,]\d{2})|(\d{1,5}[.,]\d{2})\s*(?:euro|eur)\b/i);
    if (!m) return null;
    const raw = m[1] || m[2];
    const norm = raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
    return Math.round(parseFloat(norm) * 100) / 100;
  }

  const DOWNLOAD_RE = /download|pdf|bekijk|open|factuur|invoice/i;
  const LINK_RE = /\.pdf\b|factu|invoice|document/i;
  // Links to a fuller list ("Bekijk alle facturen"), never an invoice themselves.
  const ALL_RE = /bekijk alle facturen|alle facturen|facturen bekijken|eerdere facturen|oudere facturen|factuuroverzicht|view all invoices/i;

  // candidate: { index, text, href, context }
  // Returns invoices newest first, one per key, each with the best clickable candidate.
  function rankCandidates(candidates) {
    const byKey = new Map();
    for (const c of candidates || []) {
      const label = `${c.text || ''}`;
      if (ALL_RE.test(label)) continue;
      let score = 0;
      if (DOWNLOAD_RE.test(label)) score += 2;
      if (/download|pdf/i.test(label)) score += 2;
      if (c.href && LINK_RE.test(c.href)) score += 3;
      if (score === 0) continue;
      // A date in the button's own label (KPN: "Factuur downloaden 06-.. - 15 oktober 2026") beats row text.
      const date = parseDutchDate(label) || parseDutchDate(c.context);
      if (!date) continue;
      const amount = parseAmount(c.context);
      const key = invoiceKey(date, amount, invoiceRef(label));
      const prev = byKey.get(key);
      if (!prev || score > prev.score) byKey.set(key, { index: c.index, label, href: c.href || null, date: isoDate(date), amount, key, score });
    }
    return [...byKey.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  const invoiceKey = (date, amount, ref = '') =>
    `kpn:${isoDate(date)}:${amount == null ? '-' : amount.toFixed(2)}${ref ? `:${ref}` : ''}`;

  // What the label says beyond verbs and the date, e.g. the phone number or address of the product,
  // so "bekijken" and "downloaden" of one invoice share a key but two products on one day don't.
  function invoiceRef(label) {
    return String(label || '').toLowerCase()
      .replace(new RegExp(`\\b\\d{1,2}\\s+(${MONTH_RE})\\.?\\s+\\d{4}\\b|\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4}\\b|\\b(${MONTH_RE})\\.?\\s+\\d{4}\\b`, 'g'), '')
      .replace(/opent in (een )?nieuw venster|factuur|facturen|bekijken|bekijk|downloaden|download|openen|open|pdf|invoice/g, '')
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 40);
  }

  function sanitizeFolder(folder) {
    return String(folder || 'Facturen').split('/').map((p) => p.replace(/[<>:"\\|?*\x00-\x1f]/g, '').trim()).filter((p) => p && p !== '.' && p !== '..').join('/') || 'Facturen';
  }

  // KPN serves "download.pdf" (Chrome) or ".pdf" (Firefox); keep its name, fall back when it's empty.
  function sanitizeOriginal(name) {
    const base = String(name || '').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '').trim();
    if (!base || base.startsWith('.')) return `factuur${base.startsWith('.') ? base : '.pdf'}`;
    return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.pdf`;
  }

  // date "2026-10-15" + original "download.pdf" -> "Facturen/KPN/15102026_download.pdf"
  function buildFilename({ folder, provider = 'KPN', date, original }) {
    const [y, m, d] = String(date).split('-');
    return `${sanitizeFolder(folder)}/${provider}/${d}${m}${y}_${sanitizeOriginal(original)}`;
  }

  // All invoices in the newest month that has any (input is newest first).
  function latestMonth(invoices) {
    if (!invoices || !invoices.length) return [];
    const month = invoices[0].date.slice(0, 7);
    return invoices.filter((inv) => inv.date.slice(0, 7) === month);
  }

  const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
  // Best-effort KPN identity: JWT claims in page storage first, then visible text (klantnummer / e-mail).
  function extractAccountId(pageText, storageValues) {
    for (const v of storageValues || []) {
      for (const jwt of String(v).match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*/g) || []) {
        try {
          const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const claims = JSON.parse(typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString());
          const id = claims.email || claims.preferred_username || claims.upn || claims.name;
          if (id && typeof id === 'string') return id;
        } catch (_) { /* not a JWT we can read */ }
      }
    }
    const text = String(pageText || '');
    const klant = text.match(/klantnummer[:\s]*(\d{5,12})/i);
    if (klant) return `klantnummer ${klant[1]}`;
    const mail = text.match(EMAIL_RE);
    if (mail) return mail[0];
    const welkom = text.match(/welkom,?\s*([^,\n]{2,40}?)\s*,/i);
    return welkom ? welkom[1].trim() : null;
  }

  // When the next invoice should exist: per product (the part of the key after the amount), the newest
  // saved invoice date + 28 days; the earliest of those. Null when nothing was saved yet.
  function nextDue(seen) {
    const latest = new Map();
    for (const key of Object.keys(seen || {})) {
      const [, date, , ref = ''] = key.split(':');
      if (!latest.has(ref) || latest.get(ref) < date) latest.set(ref, date);
    }
    let next = null;
    for (const date of latest.values()) {
      const t = new Date(`${date}T00:00:00`).getTime() + 28 * 86400e3;
      if (next === null || t < next) next = t;
    }
    return next;
  }

  // Auto-run when a new invoice is expected and the last attempt is older than minGapHours.
  function isDue(state, now = Date.now(), minGapHours = 12) {
    const last = state && state.lastAttempt;
    if (last && now - last < minGapHours * 3600e3) return false;
    const next = nextDue(state && state.seen);
    return next === null || now >= next;
  }

  function looksLikeLogin(url, hasPasswordField) {
    return !!hasPasswordField || /login|inloggen|signin|auth/i.test(new URL(url).hostname + new URL(url).pathname);
  }

  const api = { ALL_RE, parseDutchDate, isoDate, parseAmount, rankCandidates, invoiceKey, invoiceRef, buildFilename, sanitizeFolder, sanitizeOriginal, latestMonth, extractAccountId, nextDue, isDue, looksLikeLogin };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FG = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
