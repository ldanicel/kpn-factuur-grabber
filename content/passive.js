// Declared content script: whenever the user opens a MijnKPN page, report login state and ID.
(async function () {
  if (window.top !== window || !/\/mijn\b|login|inloggen/i.test(location.href)) return;
  // Give the SPA a moment to render the account header or redirect to the login form.
  await new Promise((r) => setTimeout(r, 4000));
  try { chrome.runtime.sendMessage({ type: 'account', account: FGAccount() }); } catch (_) { /* extension reloaded */ }
})();
