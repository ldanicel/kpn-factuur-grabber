const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../lib/core.js');

test('parseDutchDate handles KPN-style formats', () => {
  assert.deepEqual(FG.parseDutchDate('Factuur 12 oktober 2026'), { y: 2026, m: 10, d: 12 });
  assert.deepEqual(FG.parseDutchDate('3 okt. 2026'), { y: 2026, m: 10, d: 3 });
  assert.deepEqual(FG.parseDutchDate('september 2026'), { y: 2026, m: 9, d: 1 });
  assert.deepEqual(FG.parseDutchDate('datum 05-03-2026'), { y: 2026, m: 3, d: 5 });
  assert.deepEqual(FG.parseDutchDate('2026-01-31'), { y: 2026, m: 1, d: 31 });
  assert.equal(FG.parseDutchDate('Download PDF'), null);
  assert.equal(FG.parseDutchDate('31-13-2026'), null);
});

test('parseAmount reads euro amounts', () => {
  assert.equal(FG.parseAmount('Totaal € 45,67'), 45.67);
  assert.equal(FG.parseAmount('€1.234,50'), 1234.5);
  assert.equal(FG.parseAmount('62,00 euro'), 62);
  assert.equal(FG.parseAmount('geen bedrag'), null);
});

test('rankCandidates groups per invoice, newest first, best button wins', () => {
  const ranked = FG.rankCandidates([
    { index: 0, text: 'Menu', href: null, context: '' },
    { index: 1, text: 'Bekijk', href: null, context: 'September 2026 € 61,20 Betaald' },
    { index: 2, text: 'Download PDF', href: 'https://www.kpn.com/mijn/api/invoice/2.pdf', context: 'September 2026 € 61,20 Betaald' },
    { index: 3, text: 'Download PDF', href: null, context: 'Factuur 12 oktober 2026 € 62,00 Open' },
    { index: 4, text: 'Contact', href: 'https://www.kpn.com/service', context: '12 oktober 2026' },
    { index: 5, text: 'Bekijk alle facturen', href: 'https://www.kpn.com/mijn/producten/x/facturen', context: 'Factuur 12 oktober 2026 € 62,00' },
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].date, '2026-10-12');
  assert.equal(ranked[0].index, 3);
  assert.equal(ranked[1].index, 2);
  assert.equal(ranked[1].key, 'kpn:2026-09-01:61.20');
});

test('buildFilename uses DDMMYYYY_ plus KPN original name', () => {
  assert.equal(FG.buildFilename({ folder: 'Facturen', date: '2026-10-15', original: 'download.pdf' }), 'Facturen/KPN/15102026_download.pdf');
  assert.equal(FG.buildFilename({ folder: '../x:/', date: '2026-01-05', original: 'Factuur 123.pdf' }), 'x/KPN/05012026_Factuur 123.pdf');
  assert.equal(FG.buildFilename({ folder: 'F', date: '2026-01-05', original: '.pdf' }), 'F/KPN/05012026_factuur.pdf');
  assert.equal(FG.buildFilename({ folder: 'F', date: '2026-01-05', original: '' }), 'F/KPN/05012026_factuur.pdf');
  assert.equal(FG.buildFilename({ folder: 'F', date: '2026-01-05', original: 'a/b/inv' }), 'F/KPN/05012026_inv.pdf');
});

test('latestMonth keeps every invoice of the newest month', () => {
  const inv = [{ date: '2026-10-15' }, { date: '2026-10-02' }, { date: '2026-09-15' }];
  assert.deepEqual(FG.latestMonth(inv).map((i) => i.date), ['2026-10-15', '2026-10-02']);
  assert.deepEqual(FG.latestMonth([]), []);
});

test('extractAccountId prefers JWT claims, then klantnummer, then e-mail', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'jan@example.nl' })).toString('base64url');
  assert.equal(FG.extractAccountId('', [`{"token":"eyJhbGciOiJub25lIn0.${payload}.sig"}`]), 'jan@example.nl');
  assert.equal(FG.extractAccountId('Mijn gegevens Klantnummer: 12345678', []), 'klantnummer 12345678');
  assert.equal(FG.extractAccountId('Ingelogd als piet@kpnmail.nl', ['not a token']), 'piet@kpnmail.nl');
  assert.equal(FG.extractAccountId('Welkom', []), null);
});

test('isDue waits until a product\'s next invoice is expected', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  const seen = { 'kpn:2026-10-15:-:0612345678': {}, 'kpn:2026-09-25:-:0698765432': {}, 'kpn:2026-10-04:-:teststraat1': {} };
  assert.equal(FG.isDue({}, now), true);
  assert.equal(FG.isDue({ seen }, now), false);                       // 25 sep + 28d = 23 oct
  assert.equal(FG.isDue({ seen }, new Date(2026, 9, 23, 9).getTime()), true);
  assert.equal(FG.isDue({ seen, lastAttempt: new Date(2026, 9, 23, 8).getTime() }, new Date(2026, 9, 23, 9).getTime()), false);
  assert.equal(FG.isDue({ seen, lastAttempt: 1 }, new Date(2026, 9, 23, 9).getTime(), 0), true);
});

test('looksLikeLogin', () => {
  assert.equal(FG.looksLikeLogin('https://login.kpn.com/x', false), true);
  assert.equal(FG.looksLikeLogin('https://www.kpn.com/mijn/facturen', false), false);
  assert.equal(FG.looksLikeLogin('https://www.kpn.com/mijn/facturen', true), true);
});
