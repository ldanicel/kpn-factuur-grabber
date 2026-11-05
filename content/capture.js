// Runs in the page's own JS world. Chrome lets a page start one download by script, then blocks the rest
// behind an "automatic downloads" prompt nobody sees in a background tab. So while armed, this catches the
// file KPN is about to download and hands it to the extension, which saves it through chrome.downloads.
(() => {
  if (window.__fgCapture) return;
  const state = (window.__fgCapture = { armed: false });
  const send = (payload) => window.postMessage({ __fg: 'capture', ...payload }, location.origin);

  // KPN's CSP forbids fetch() of blob: URLs, so keep the Blob objects themselves and read them locally.
  const blobs = new Map();
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.call(URL, obj);
    if (obj instanceof Blob) {
      blobs.set(url, obj);
      setTimeout(() => blobs.delete(url), 120000);
    }
    return url;
  };

  async function grab(href, name) {
    state.armed = false;
    try {
      const url = new URL(href, location.href).href;
      if (url.startsWith('data:')) {
        send({ dataUrl: url, name });
      } else if (url.startsWith('blob:')) {
        const blob = blobs.get(url);
        if (!blob) throw new Error('blob not captured');
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        send({ dataUrl, name });
      } else {
        send({ url, name });
      }
    } catch (e) {
      send({ error: String((e && e.message) || e) });
    }
  }

  const isDownloadLink = (a) => a.hasAttribute('download') || /^blob:/.test(a.href);

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (state.armed && isDownloadLink(this)) return void grab(this.href, this.getAttribute('download') || '');
    return origClick.call(this);
  };

  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a');
    if (state.armed && a && isDownloadLink(a)) {
      e.preventDefault();
      grab(a.href, a.getAttribute('download') || '');
    }
  }, true);

  const origOpen = window.open;
  window.open = function (url, ...rest) {
    if (state.armed && url) { grab(String(url), ''); return null; }
    return origOpen.call(this, url, ...rest);
  };

  // Pages revoke the blob right after clicking; keep it alive long enough to read it.
  const origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (u) { setTimeout(() => origRevoke.call(URL, u), 60000); };
})();
