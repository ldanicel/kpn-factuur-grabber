importScripts('lib/core.js');

const INVOICES_URL = 'https://www.kpn.com/mijn/facturen';
const PRODUCTS_URL = 'https://www.kpn.com/mijn/producten';
const DEFAULTS = { auto: true, folder: 'Facturen' };
const NOTIF_LOGIN = 'fg-login';
const NAG_HOURS = 24;            // at most one "log in to fetch your invoice" reminder per day

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  await chrome.storage.local.set({ ...DEFAULTS, ...s });
  setup();
});
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  chrome.alarms.create('check', { periodInMinutes: 360, delayInMinutes: 1 });
  await chrome.alarms.clear('keepalive'); // removed in 0.3: KPN ends idle sessions after about an hour anyway
}

// KPN logs idle sessions out after about an hour, so instead of keeping a session alive:
// when an invoice is due, fetch it if logged in, otherwise remind the user (once a day) to log in,
// and fetch right after they do (see recordAccount).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'check') return;
  const state = await chrome.storage.local.get(null);
  if (state.auto === false || !FG.isDue(state)) return;
  if (state.account?.loggedIn === false) return nagLogin(state);
  await run({ mode: 'latest-month' });
});

async function nagLogin(state) {
  if (state.lastNag && Date.now() - state.lastNag < NAG_HOURS * 3600e3) return;
  await chrome.storage.local.set({ lastNag: Date.now() });
  notify(NOTIF_LOGIN, 'New KPN invoice expected', 'Click here and log in to MijnKPN. Factuur Grabber downloads it right after.');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'run') run({ mode: msg.mode, manual: true }).then(sendResponse);
  else if (msg.type === 'open-login') openLogin().then(() => sendResponse(true));
  else if (msg.type === 'captured') { onCaptured(msg).finally(() => sendResponse(true)); }
  else if (msg.type === 'outline') saveOutline().then(sendResponse, () => sendResponse(false));
  else if (msg.type === 'check-account') checkAccount().then(sendResponse);
  else if (msg.type === 'account') recordAccount(msg.account).then(() => sendResponse(true));
  else return false;
  return true;
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIF_LOGIN) openLogin();
});

async function openLogin() {
  await chrome.tabs.create({ url: INVOICES_URL, active: true });
}

// Keeps the last known ID while logged in, even if one page didn't show it.
async function recordAccount(account) {
  if (!account) return null;
  const state = await chrome.storage.local.get(null);
  const prev = state.account;
  const next = { loggedIn: account.loggedIn, id: account.loggedIn ? account.id || prev?.id || null : null, checkedAt: Date.now() };
  await chrome.storage.local.set({ account: next });
  // Just logged in (the user did it themselves) and an invoice is due: fetch it now.
  if (next.loggedIn && prev && !prev.loggedIn && state.auto !== false && FG.isDue(state, Date.now(), 0) && !running) {
    run({ mode: 'latest-month' });
  }
  return next;
}

// Loads MijnKPN in a background tab and reads whether it's logged in, and as whom.
async function checkAccount() {
  const tab = await chrome.tabs.create({ url: INVOICES_URL, active: false });
  try {
    await waitForLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/core.js', 'content/kpn.js'] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // Wait for the SPA to show either the login form or account content.
        for (let i = 0; i < 10; i++) {
          const a = FGAccount();
          if (!a.loggedIn || a.id) return a;
          await new Promise((r) => setTimeout(r, 800));
        }
        return FGAccount();
      },
    });
    return recordAccount(result);
  } catch (e) {
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

let running = null;
function run(opts) {
  if (!running) running = doRun(opts).finally(() => { running = null; });
  return running;
}

// mode "latest-month": every invoice in the newest month; "all": everything MijnKPN lists, including the
// "Bekijk alle facturen" pages per product. Manual runs download what was asked even if saved before;
// automatic runs skip saved ones.
async function doRun({ mode = 'latest-month', manual = false }) {
  await chrome.storage.local.set({ lastAttempt: Date.now() });
  const tab = await chrome.tabs.create({ url: INVOICES_URL, active: false });
  try {
    await progress('Opening MijnKPN…');
    await waitForLoad(tab.id);
    await progress('Looking for invoices…');
    let result = await scan(tab.id, mode === 'all');

    if (result.status === 'login') {
      await recordAccount({ loggedIn: false });
      await chrome.storage.local.set({ lastStatus: 'login' });
      notify(NOTIF_LOGIN, 'Log in to MijnKPN', 'Click here, log in as usual, and Factuur Grabber picks up your invoices next time.');
      return { status: 'login' };
    }
    if (result.account) await recordAccount(result.account);
    if (result.status !== 'ok') {
      await chrome.storage.local.set({ lastStatus: 'not-found' });
      if (manual) notify('fg-none', 'No invoices found', 'The MijnKPN page layout may have changed.');
      return { status: 'not-found' };
    }

    const { seen = {}, folder } = await chrome.storage.local.get(['seen', 'folder']);
    const done = new Set();
    const saved = [];
    let newest = result.invoices[0];
    // Download what the current page shows; invoices are clicked in place, so this runs per page.
    const failed = [];
    const take = async (invoices) => {
      const todo = invoices.filter((inv) => !done.has(inv.key) && (manual || !seen[inv.key]));
      for (const [i, inv] of todo.entries()) {
        done.add(inv.key);
        await progress(`Downloading ${i + 1} of ${todo.length}: invoice of ${inv.date}…`, saved, failed);
        const filename = await save(tab.id, inv, folder);
        if (!filename) { failed.push(inv); continue; }
        seen[inv.key] = { date: inv.date, filename, savedAt: Date.now() };
        saved.push({ ...inv, filename });
        await chrome.storage.local.set({ seen });
      }
    };

    if (mode !== 'all') {
      await take(FG.latestMonth(result.invoices));
    } else {
      await take(result.invoices);
      // Each product in the dropdown can list more history than "Alle facturen".
      const products = (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => FGProductCount() }))[0].result;
      for (let p = 1; p < Math.min(products, 20); p++) {
        await progress(`Checking product ${p} of ${products - 1} for older invoices…`, saved, failed);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (i) => FGChooseProduct(i), args: [p] });
        await sleep(2500);
        const page = await scan(tab.id, true);
        if (page.status === 'ok') {
          if (page.invoices[0].date > newest.date) newest = page.invoices[0];
          await take(page.invoices);
        }
      }
      let links = result.moreLinks || [];
      let base = INVOICES_URL;
      // Some accounts only offer "Bekijk alle facturen" from the products overview.
      if (links.length) await progress('Checking for older invoices…', saved, failed);
      if (!links.some((l) => l.href)) {
        await navigate(tab.id, PRODUCTS_URL);
        const overview = await scan(tab.id, false);
        if (overview.status === 'ok' || overview.moreLinks) {
          if (overview.status === 'ok') await take(overview.invoices);
          if ((overview.moreLinks || []).length) { links = overview.moreLinks; base = PRODUCTS_URL; }
        }
        if (base === INVOICES_URL) { await navigate(tab.id, INVOICES_URL); await scan(tab.id, false); }
      }
      for (let i = 0; i < Math.min(links.length, 10); i++) {
        const link = links[i];
        if (link.href) {
          await navigate(tab.id, link.href);
        } else {
          // SPA button: back to the overview, find the i-th link again, click it, let the route render.
          if (i > 0) { await navigate(tab.id, base); await scan(tab.id, false); }
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (n) => FGClick(n), args: [link.index] });
          await new Promise((r) => setTimeout(r, 2500));
        }
        const page = await scan(tab.id, true);
        if (page.status !== 'ok') continue;
        if (page.invoices[0].date > newest.date) newest = page.invoices[0];
        await take(page.invoices);
      }
    }

    const update = { seen, lastStatus: 'ok', lastNewest: newest.date, lastCount: saved.length };
    await chrome.storage.local.set(update);
    await progress(null);
    if (failed.length) await chrome.storage.local.set({ lastError: `${failed.length} invoice(s) didn't download: ${failed.map((i) => i.date).join(', ')}` });
    else await chrome.storage.local.remove('lastError');
    if (saved.length) notify('fg-saved', `${saved.length} KPN invoice${saved.length > 1 ? 's' : ''} saved`, saved.map((i) => i.date).join(', '));
    else if (manual) notify('fg-uptodate', 'Nothing to download', `Newest KPN invoice: ${newest.date}`);
    return { status: 'ok', saved: saved.length, failed: failed.length, newest: newest.date };
  } catch (e) {
    await progress(null);
    await chrome.storage.local.set({ lastStatus: 'error', lastError: String((e && e.message) || e) });
    return { status: 'error', error: String((e && e.message) || e) };
  } finally {
    // Give a click-triggered download a moment to start before closing its tab.
    setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 5000);
  }
}

// Live progress for the popup: current step plus the files saved so far in this run.
async function progress(text, saved = [], failed = []) {
  if (!text) return chrome.storage.local.remove('progress');
  await chrome.storage.local.set({ progress: { at: Date.now(), text, saved: saved.map((i) => i.filename.split('/').pop()), failed: failed.map((i) => i.date) } });
}

async function scan(tabId, expand) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/core.js', 'content/kpn.js'] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: (x) => FGScan({ expand: x }), args: [expand] });
  return result;
}

async function navigate(tabId, url) {
  const loaded = waitForLoad(tabId, 30000, true);
  await chrome.tabs.update(tabId, { url });
  await loaded;
}

let outlineName = null;
// Saves a masked outline of the MijnKPN invoices page, so a layout change can be fixed without account access.
async function saveOutline() {
  const tab = await chrome.tabs.create({ url: INVOICES_URL, active: false });
  try {
    await waitForLoad(tab.id);
    await scan(tab.id, true);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => FGOutline() });
    const url = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(result, null, 2))));
    outlineName = 'factuur-grabber-outline.json';
    await chrome.downloads.download({ url, saveAs: false });
    return true;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Direct links download with the browser's own cookies; otherwise click the button.
// The final name is set in onDeterminingFilename, where KPN's original file name is known.
// KPN prepares each PDF before the download starts, so wait for it to start and finish before the next one;
// otherwise a slow download gets the next invoice's name, or the next click is ignored.
let pending = null;
async function save(tabId, inv, folder) {
  let resolveStart;
  const started = new Promise((r) => { resolveStart = r; });
  pending = { inv, folder, resolveStart, original: null };
  try {
    if (inv.href) {
      await chrome.downloads.download({ url: inv.href, conflictAction: 'uniquify', saveAs: false });
    } else {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['content/capture.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { window.__fgCapture.armed = true; } });
      await chrome.scripting.executeScript({ target: { tabId }, func: (i, l) => FGClick(i, l), args: [inv.index, inv.label] });
    }
    let start = await Promise.race([started, sleep(20000).then(() => null)]);
    if (!start && pending.captureFailed) {
      // Couldn't catch the file: let the page download it itself (works unless Chrome blocks it).
      const retry = new Promise((r) => { pending.resolveStart = r; });
      await chrome.scripting.executeScript({ target: { tabId }, func: (i, l) => FGClick(i, l), args: [inv.index, inv.label] });
      start = await Promise.race([retry, sleep(20000).then(() => null)]);
    }
    if (!start) return null;
    await waitForDownload(start.id, 60000);
    return start.filename;
  } finally {
    pending = null;
    chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => { if (window.__fgCapture) window.__fgCapture.armed = false; } }).catch(() => {});
  }
}

// The page's file, caught before Chrome could block it: save it ourselves (extension downloads aren't limited).
async function onCaptured(msg) {
  if (!pending) return;
  if (msg.error || !(msg.dataUrl || msg.url)) {
    console.warn('capture failed', msg.error);
    pending.captureFailed = true;
    pending.resolveStart(null);
    return;
  }
  pending.original = msg.name || null;
  await chrome.downloads.download({ url: msg.dataUrl || msg.url, conflictAction: 'uniquify', saveAs: false });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForDownload(id, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChanged); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    function onChanged(delta) {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') done();
    }
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => { if (!item || item.state !== 'in_progress') done(); });
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const fromKpn = /kpn\.com/.test(item.referrer || '') || /kpn\.com/.test(item.url || '') || (item.url || '').startsWith('blob:https://www.kpn.com');
  if (outlineName && (item.url || '').startsWith('data:application/json')) {
    suggest({ filename: outlineName, conflictAction: 'uniquify' });
    outlineName = null;
  } else if (pending && (fromKpn || item.byExtensionId === chrome.runtime.id)) {
    const original = pending.original || item.filename;
    const filename = FG.buildFilename({ folder: pending.folder, date: pending.inv.date, original });
    suggest({ filename, conflictAction: 'uniquify' });
    pending.resolveStart({ id: item.id, filename });
    pending = null;
  } else {
    suggest();
  }
});

// fresh: ignore the tab's current state and wait for the next completed load (used right before navigating).
function waitForLoad(tabId, timeoutMs = 30000, fresh = false) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); reject(new Error('MijnKPN did not load')); }, timeoutMs);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    if (fresh) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') onUpd(tabId, { status: 'complete' });
  });
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message });
}
