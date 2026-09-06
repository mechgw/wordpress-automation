'use strict';

/**
 * #47: stan map witryny z Search Console (sitemaps.list) w arkuszu SITEMAPY
 * i w oknie „Status danych”.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const SHEET = 'SITEMAPY';
const HEADER = ['Sitemapa', 'Typ', 'Zgłoszona', 'Pobrana przez Google', 'Oczekuje', 'Adresy zgłoszone', 'Ostrzeżenia', 'Błędy', 'Stan', 'Sprawdzono'];
const SITE = 'https://www.example.pl/';
const LIST = '/sites/https%3A%2F%2Fwww.example.pl%2F/sitemaps';

const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();

function sheets(extra = {}) {
  return Object.assign({
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', SITE], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']]
  }, extra);
}

const index = (over = {}) => Object.assign({
  path: 'https://www.example.pl/sitemap_index.xml', lastSubmitted: '2026-08-01T10:00:00.000Z', isPending: false, isSitemapsIndex: true,
  lastDownloaded: '2026-09-05T03:15:00.000Z', warnings: '0', errors: '0', contents: [{ type: 'web', submitted: '120', indexed: '0' }, { type: 'image', submitted: '30', indexed: '0' }]
}, over);
const plain1 = (over = {}) => Object.assign({
  path: 'https://www.example.pl/page-sitemap.xml', lastSubmitted: '2026-08-01T10:00:00.000Z', isPending: false, isSitemapsIndex: false,
  lastDownloaded: '2026-09-05T03:16:00.000Z', warnings: '2', errors: '0', contents: [{ type: 'web', submitted: '45', indexed: '0' }]
}, over);

function project(sitemaps, opts = {}) {
  const response = typeof sitemaps === 'function' ? sitemaps : () => ({ code: 200, json: sitemaps === null ? {} : { sitemap: sitemaps } });
  return loadProject(Object.assign({ sheets: sheets(opts.extraSheets), fetch: fetchRouter([[LIST, response]]) }, opts));
}

const fmt = (gas, iso) => gas.Utilities.formatDate(new Date(iso), 'Europe/Warsaw', 'yyyy-MM-dd HH:mm');
const status = gas => JSON.parse(gas.$properties.SITEMAPS_STATUS);

describe('sitemapy: lista w arkuszu', () => {
  test('T1: lista sitemap mapowana do wierszy: typ, daty, oczekiwanie, suma adresów, liczniki, OK, czas; stan zapisany', () => {
    const gas = project([index(), plain1()]);
    const out = plain(gas.sprawdzSitemapy());
    assert.equal(out.count, 2);
    assert.deepEqual(out.problems, []);

    const grid = plain(gas.$sheet(SHEET));
    assert.deepEqual(grid[0], HEADER);
    assert.deepEqual(grid[1].slice(0, 9), ['https://www.example.pl/sitemap_index.xml', 'indeks sitemap', fmt(gas, '2026-08-01T10:00:00.000Z'), fmt(gas, '2026-09-05T03:15:00.000Z'), 'NIE', 150, 0, 0, 'OK']);
    assert.deepEqual(grid[2].slice(0, 9), ['https://www.example.pl/page-sitemap.xml', 'sitemapa', fmt(gas, '2026-08-01T10:00:00.000Z'), fmt(gas, '2026-09-05T03:16:00.000Z'), 'NIE', 45, 2, 0, 'OK']);
    assert.match(grid[1][9], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    assert.match(gas.$fetchCalls[0].url, /webmasters\/v3\/sites\/https%3A%2F%2Fwww\.example\.pl%2F\/sitemaps$/);
    assert.equal(gas.$fetchCalls[0].params.method, 'get');
    assert.equal(status(gas).count, 2);
    assert.deepEqual(status(gas).problems, []);
    assert.equal(gas.$alerts[0][0], 'Sitemapy w Search Console: 2 (szczegóły w arkuszu „SITEMAPY”).\nBez błędów i bez zaległych przetworzeń.');
  });

  test('T2: błędy → UWAGA w wierszu, w podsumowaniu i w Status danych; ostrzeżenia same nie alarmują', () => {
    const gas = project([plain1({ errors: '3', warnings: '5' }), index()]);
    const out = plain(gas.sprawdzSitemapy());
    assert.deepEqual(out.problems, ['https://www.example.pl/page-sitemap.xml: błędy: 3']);
    assert.equal(gas.$sheet(SHEET)[1][8], 'UWAGA: błędy: 3');
    assert.equal(gas.$sheet(SHEET)[2][8], 'OK');
    assert.match(gas.$alerts[0][0], /\nUWAGA:\n- https:\/\/www\.example\.pl\/page-sitemap\.xml: błędy: 3$/);

    gas.showImportStatus();
    assert.match(gas.$alerts[1][0], /\nSitemapy: 2 \| UWAGA: https:\/\/www\.example\.pl\/page-sitemap\.xml: błędy: 3 \(sprawdzono \d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\nAlerty e-mail:/);
  });

  test('T2b: isPending dłużej niż 7 dni od zgłoszenia → UWAGA; świeże oczekiwanie → OK; oczekiwanie bez daty → UWAGA', () => {
    const gas = project([
      plain1({ path: 'https://www.example.pl/old.xml', isPending: true, lastSubmitted: daysAgo(10), lastDownloaded: undefined }),
      plain1({ path: 'https://www.example.pl/new.xml', isPending: true, lastSubmitted: daysAgo(2) }),
      plain1({ path: 'https://www.example.pl/nodate.xml', isPending: true, lastSubmitted: undefined })
    ]);
    const out = plain(gas.sprawdzSitemapy());
    assert.deepEqual(out.problems, [
      'https://www.example.pl/old.xml: oczekuje na przetworzenie od 10 dni',
      'https://www.example.pl/nodate.xml: oczekuje na przetworzenie'
    ]);
    const grid = plain(gas.$sheet(SHEET));
    assert.deepEqual(grid[1].slice(3, 5), ['nigdy', 'TAK']);
    assert.equal(grid[2][8], 'OK');
    assert.equal(grid[3][2], '', 'no submitted date');
  });

  test('T3: brak sitemap → komunikat, sam nagłówek, stan z count 0', () => {
    const gas = project(null);
    const out = plain(gas.sprawdzSitemapy());
    assert.equal(out.count, 0);
    assert.deepEqual(plain(gas.$sheet(SHEET)), [HEADER]);
    assert.match(gas.$alerts[0][0], /^Search Console nie zwraca żadnej sitemapy/);
    gas.showImportStatus();
    assert.match(gas.$alerts[1][0], /Sitemapy: 0 \| OK \(sprawdzono/);
  });

  test('T4: oczekiwana sitemapa z EXPECTED_SITEMAPS bez odpowiednika → dodatkowy wiersz i UWAGA; obecna (inna wielkość liter, ukośnik) → nic', () => {
    const gas = project([index()], { properties: { EXPECTED_SITEMAPS: 'https://www.example.pl/news-sitemap.xml, HTTPS://WWW.example.pl/sitemap_index.xml/' } });
    const out = plain(gas.sprawdzSitemapy());
    assert.deepEqual(out.problems, ['https://www.example.pl/news-sitemap.xml: brak w Search Console (oczekiwana wg EXPECTED_SITEMAPS)']);
    const grid = plain(gas.$sheet(SHEET));
    assert.equal(grid.length, 3);
    assert.deepEqual(grid[2].slice(0, 9), ['https://www.example.pl/news-sitemap.xml', 'oczekiwana', '', '', '', '', '', '', 'UWAGA: brak w Search Console']);
  });

  test('T5: arkusz jest przepisywany: stare wiersze znikają, gdy lista się skróci', () => {
    const gas = project([index()], { extraSheets: { [SHEET]: [HEADER, ['a', 'x'], ['b', 'x'], ['c', 'x']] } });
    gas.sprawdzSitemapy();
    const grid = plain(gas.$sheet(SHEET));
    assert.equal(grid[1][0], 'https://www.example.pl/sitemap_index.xml');
    assert.ok(grid.slice(2).every(r => r.every(v => v === '')), 'rows 3..4 cleared');
  });

  test('T6: błąd API → wyjątek dla użytkownika, stan zapisany jako błąd API, Status danych to pokazuje, arkusz nietknięty', () => {
    const gas = project(() => ({ code: 403, text: '{"error":{"message":"User does not have sufficient permission"}}' }));
    assert.throws(() => gas.sprawdzSitemapy(), /Search Console API HTTP 403/);
    assert.equal(status(gas).count, null);
    assert.match(status(gas).problems[0], /^błąd API: Search Console API HTTP 403/);
    assert.equal(gas.$sheet(SHEET), undefined, 'sheet not created on API failure');
    gas.showImportStatus();
    assert.match(gas.$alerts[0][0], /Sitemapy: błąd API \| UWAGA: błąd API: Search Console API HTTP 403/);
  });

  test('brak siteUrl → jasny błąd przed zapytaniem; Status danych bez sprawdzenia mówi „nie sprawdzano”; uszkodzony stan traktowany jak brak', () => {
    const s = sheets();
    s[GSC_SHEET][1] = ['siteUrl', ''];
    const gas = loadProject({ sheets: s, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.sprawdzSitemapy(), /Brak siteUrl w arkuszu Konfiguracja GSC/);
    gas.showImportStatus();
    assert.match(gas.$alerts[0][0], /Sitemapy: nie sprawdzano \(SEO \/ GSC → Sprawdź sitemapy\)/);
    const broken = loadProject({ sheets: sheets(), properties: { SITEMAPS_STATUS: '{not json' } });
    broken.showImportStatus();
    assert.match(broken.$alerts[0][0], /Sitemapy: nie sprawdzano/);
  });

  test('przebieg pod wspólnym lockiem; zajęty lock → odmowa bez zapytań; menu ma pozycję', () => {
    const gas = project([index()]);
    gas.sprawdzSitemapy();
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
    const busy = project([index()], { lockHeld: true });
    assert.throws(() => busy.sprawdzSitemapy(), /Inne uruchomienie jeszcze trwa \(sitemapy\)/);
    assert.equal(busy.$fetchCalls.length, 0);
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.ok(seo.items.map(i => i.fn).includes('sprawdzSitemapy'));
  });
});
