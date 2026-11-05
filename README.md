# Factuur Grabber

Browser extension (Chrome/Edge/Brave, Manifest V3) that saves your KPN invoices as PDFs, using the MijnKPN session you're already logged into.

> Not affiliated with or endorsed by KPN. "KPN" and "MijnKPN" are trademarks of KPN B.V., used here only to describe what the extension works with.

## How it works
- **Login status:** the popup shows whether this browser is logged in to MijnKPN, and as which KPN ID (e-mail or klantnummer, best effort).
- **Get last month's invoices:** downloads every invoice from the newest month MijnKPN lists (for example internet + mobile).
- **Download all available invoices:** downloads everything MijnKPN lists: the overview, then each product's "Bekijk alle facturen" page (falls back to /mijn/producten), expanding "toon meer" paging.
- **Page outline for support:** saves a masked JSON outline of the invoices page (labels and paths; e-mails, amounts, long numbers masked) to fix layout changes without account access.
- **File names:** `Downloads/Facturen/KPN/DDMMYYYY_<KPN's own file name>`, e.g. `15102026_download.pdf`.
- **Automatic:** per product it expects a new invoice 28 days after the last one. When one is due and you're logged in, it fetches it in a background tab; if you're logged out, it reminds you once a day, and fetches right after you log in yourself.
- **No keep-alive:** KPN ends idle sessions after about an hour and has no API or tokens for customers, so the extension doesn't try to defeat that; it works around it with the reminder + fetch-on-login flow.
- If MijnKPN asks for a login, it shows a notification. You log in yourself as usual (tick "Onthoud dit apparaat"), and it carries on.

## Privacy
Full policy: [PRIVACY.md](PRIVACY.md).
- No servers. The extension makes no network requests of its own, only to `*.kpn.com` in your browser.
- It never sees or stores your KPN password or SMS codes.
- It stores only invoice keys (date + amount) and file names in `chrome.storage.local`, to avoid duplicates.

## Install (dev)
1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this folder.
2. Log in to MijnKPN in the same browser, open the extension, click **Get last month's invoices**.

## Develop
```
npm test                                       # unit tests (no deps)
NODE_PATH=$(npm root -g) node test/e2e-smoke.js   # full flow against a fake MijnKPN, needs Playwright + Chromium
npm run zip                                    # build factuur-grabber.zip for the store
```
CI (`.github/workflows/test.yml`) runs the unit tests, the E2E smoke test and a manifest/package version check on every push and PR.

## Layout
- `lib/core.js`: pure helpers (Dutch dates, amounts, ranking, file names, scheduling)
- `content/kpn.js`: scans the MijnKPN page, clicks download buttons
- `background.js`: schedule, tab handling, downloads, notifications
- `popup/`: UI

## Not yet
- Email delivery (needs Gmail/Outlook OAuth, phase 2)
- Licence check and payments (yearly plan)
- Other providers (Odido, Ziggo, energy)
- Dutch UI strings

## License
MIT, see [LICENSE](LICENSE).
