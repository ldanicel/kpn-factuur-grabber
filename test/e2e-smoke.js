// End-to-end smoke test against a fake MijnKPN page. Run: node test/e2e-smoke.js
// Needs Playwright + Chromium (NODE_PATH pointing at a playwright install is fine).
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const ext = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-'));
  // Serve the fake MijnKPN over local HTTPS and point www.kpn.com at it.
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=www.kpn.com -days 1 -keyout ${profile}/k.pem -out ${profile}/c.pem 2>/dev/null`);
  const server = https.createServer({ key: fs.readFileSync(`${profile}/k.pem`), cert: fs.readFileSync(`${profile}/c.pem`) }, (req, res) => {
    // Like KPN: a strict CSP, so the page (and anything injected into it) can't fetch blob: URLs.
    const html = (f) => { res.setHeader('content-type', 'text/html'); res.setHeader('content-security-policy', "default-src 'self' 'unsafe-inline'; connect-src 'self'"); res.end(fs.readFileSync(path.join(__dirname, 'fixtures', f))); };
    if (req.url.startsWith('/mijn/facturen')) html('facturen.html');
    else if (req.url.startsWith('/mijn/producten/internet/facturen')) html('product-facturen.html');
    else if (req.url.startsWith('/mijn/api/invoice/')) {
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${req.url.split('/').pop()}"`);
      res.end('%PDF-1.4 fake');
    }
    else { res.statusCode = 404; res.end(); }
  }).listen(8443);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, env: { ...process.env, HOME: profile },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--host-resolver-rules=MAP www.kpn.com 127.0.0.1:8443', '--ignore-certificate-errors', '--no-proxy-server'],
  });

  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  // Playwright captures downloads itself; hand them back to Chrome so the extension's filenames apply.
  const cdp = await ctx.newCDPSession(ctx.pages()[0] || await ctx.newPage());
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const account = await sw.evaluate(() => checkAccount());
  const listFiles = () => sw.evaluate(() => chrome.downloads.search({}).then((d) => d.map((x) => x.filename.split('/').slice(-3).join('/'))));
  const last = await sw.evaluate(() => run({ mode: 'latest-month', manual: true }));
  await new Promise((r) => setTimeout(r, 2000));
  const afterLast = await listFiles();
  // Page-initiated downloads must be re-issued by the extension (Chrome blocks repeated page downloads).
  const dl = await sw.evaluate(() => chrome.downloads.search({}).then((d) => d.map((x) => [x.url.slice(0, 30), x.finalUrl && x.finalUrl.slice(0, 30), x.byExtensionId])));
  const viaExtension = dl.filter((x) => x[2]).length;
  await sw.evaluate(() => chrome.downloads.erase({}));
  const all = await sw.evaluate(() => run({ mode: 'all', manual: true }));
  await new Promise((r) => setTimeout(r, 2000));
  const afterAll = await listFiles();
  // Logging in while an invoice is due triggers a fetch by itself.
  await sw.evaluate(() => chrome.downloads.erase({}));
  await sw.evaluate(() => chrome.storage.local.set({ seen: {}, account: { loggedIn: false, id: null, checkedAt: 0 } }));
  await sw.evaluate(() => recordAccount({ loggedIn: true, id: 'A Test' }));
  await sw.evaluate(async () => { await new Promise((r) => setTimeout(r, 500)); while (running) await running; });
  const afterLogin = (await listFiles()).length;
  console.log('afterLogin', afterLogin);
  await sw.evaluate(() => chrome.downloads.erase({}));
  const outlineOk = await sw.evaluate(() => saveOutline());
  await new Promise((r) => setTimeout(r, 1000));
  const outlineFile = (await listFiles())[0];
  const outline = JSON.parse(fs.readFileSync(path.join(profile, 'Downloads', 'factuur-grabber-outline.json'), 'utf8'));
  console.log(JSON.stringify({ account, last, afterLast, all, afterAll, outlineOk, outlineFile, outlineSample: outline.clickables.slice(1, 3) }, null, 2));
  await ctx.close();
  server.close();
  const has = (list, names) => names.every((n) => list.includes(`Facturen/KPN/${n}`));
  console.log('viaExtension', viaExtension);
  const ok = afterLogin === 2 && viaExtension === 2 && account.loggedIn && account.id === 'A Test'
    && last.saved === 2 && afterLast.length === 2
    && has(afterLast, ['15102026_KPN_2026_oktober_06-12345678.pdf', '04102026_KPN_2026_oktober_Teststraat1.pdf'])
    && all.saved === 8 && afterAll.length === 8
    && has(afterAll, ['25092026_KPN_2026_september_06-98765432.pdf', '15092026_KPN_2026_september_06-12345678.pdf',
      '15082026_KPN_2026_augustus_06-12345678.pdf', '15072026_KPN_2026_juli_06-12345678.pdf',
      '04082026_KPN_2026_augustus_Teststraat1.pdf', '04072026_KPN_2026_juli_Teststraat1.pdf'])
    && !JSON.stringify(outline).includes('A Test') && !JSON.stringify(outline).includes('06-12');
  console.log(ok ? 'E2E OK' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})();
