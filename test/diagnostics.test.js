'use strict';

/**
 * #54: diagnostyka systemu z menu (smokeTest) – wyłącznie odczyt, raport per krok.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';

function sheets(extra = {}) {
  return Object.assign({
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']],
    'GSC RAW': [['date']],
    'GA4 RAW': [['date']],
    'GA4 KEY EVENTS': [['date']],
    'GA4 BUSINESS EVENTS': [['date']],
    'GA4 ADS RAW': [['date']],
    'WP COMMANDS': [['command_id']],
    'WP RESULTS': [['command_id']],
    'WP SNAPSHOTS': [['command_id']]
  }, extra);
}

const PROPS = { WP_BASE_URL: 'https://www.example.pl', WP_USERNAME: 'bot', WP_APP_PASSWORD: 'x', WP_REST_NAMESPACE: 'acme', ALERT_EMAIL: 'alerty@example.pl' };

function routes(over = {}) {
  return fetchRouter([
    ['webmasters/v3/sites', over.gsc || { code: 200, json: { siteEntry: [{ siteUrl: 'https://www.example.pl/', permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:other.pl', permissionLevel: 'siteFullUser' }] } }],
    ['/metadata', over.ga4 || { code: 200, json: { dimensions: new Array(200).fill({}), metrics: new Array(90).fill({}) } }],
    ['/wp-json/wp/v2/users/me', over.wp || { code: 200, json: { slug: 'bot', name: 'Bot', capabilities: { edit_pages: true } } }]
  ]);
}

const project = (opts = {}) => loadProject(Object.assign({ sheets: sheets(opts.extraSheets), properties: Object.assign({}, PROPS, opts.properties), fetch: routes(opts.routes), triggers: opts.triggers || [] }, opts.load || {}));
const byName = steps => Object.fromEntries(plain(steps).map(s => [s.name, s]));

describe('smokeTest: kroki', () => {
  test('T1: wszystko OK → 7 kroków zielonych, raport z wersją i szczegółami', () => {
    const gas = project({ triggers: ['importDzienny', 'importGA4Dzienny', 'sprawdzAktualnoscImportow'] });
    const steps = gas.diagnostykaSystemu();
    const s = byName(steps);
    assert.equal(steps.length, 7);
    assert.ok(plain(steps).every(x => x.ok), JSON.stringify(plain(steps)));
    assert.equal(s['Script Properties'].detail, 'wymagane: 4/4 | opcjonalne: ALERT_EMAIL');
    assert.match(s['Zakładki i konfiguracja'].detail, /^siteUrl: https:\/\/www\.example\.pl\/ \| propertyId: 111 \| zakładki skryptu obecne: żadna/);
    assert.equal(s['GSC odczyt'].detail, '2 właściwości, https://www.example.pl/: siteOwner');
    assert.equal(s['GA4 odczyt'].detail, 'właściwość 111: Data API odpowiada (200 wymiarów, 90 metryk)');
    assert.equal(s['WordPress odczyt'].detail, 'https://www.example.pl: zalogowany jako bot | edycja stron: TAK | zapisy: wyłączone');
    assert.equal(s['Triggery'].detail, 'import GSC: TAK | import GA4: TAK | strażnik alertów: TAK | inspekcja URL: NIE | live check SEO: NIE');
    assert.equal(s['Alerty i sitemapy'].detail.split(' | ')[0], 'adresat: skonfigurowany i poprawny (1 adres, wartość w Script Properties)');
    assert.doesNotMatch(gas.$alerts[0][0], /alerty@example\.pl/, 'the address itself is never printed');
    assert.match(s['Alerty i sitemapy'].detail, /\| Sitemapy: nie sprawdzano/);
    const text = gas.$alerts[0][0];
    assert.match(text, /^Diagnostyka systemu \(tylko odczyt\) – wersja dev: wszystkie 7 kroków OK\n\nOK {4}Script Properties: /);
    assert.doesNotMatch(text, /Nic nie zostało zmienione/);
  });

  test('T2: brak Script Property → krok czerwony z nazwą, reszta wykonana (WordPress też czerwony, bo bez konfiguracji)', () => {
    const gas = project({ properties: { WP_APP_PASSWORD: '' } });
    const s = byName(gas.diagnostykaSystemu());
    assert.equal(s['Script Properties'].ok, false);
    assert.equal(s['Script Properties'].detail, 'brak wymaganych: WP_APP_PASSWORD');
    assert.equal(s['GSC odczyt'].ok, true, 'other steps still run');
    assert.equal(s['GA4 odczyt'].ok, true);
    assert.equal(s['WordPress odczyt'].ok, false);
    assert.match(s['WordPress odczyt'].detail, /WP_APP_PASSWORD/);
    assert.match(gas.$alerts[0][0], /2 z 7 kroków z błędem[\s\S]*BŁĄD {2}Script Properties: brak wymaganych: WP_APP_PASSWORD[\s\S]*Nic nie zostało zmienione/);
  });

  test('T2b: nieprawidłowy ALERT_EMAIL i opcjonalne właściwości są opisane; ani adres, ani błędna wartość nie są wypisywane', () => {
    const gas = project({ properties: { ALERT_EMAIL: 'sekret@example.pl x', WP_ALLOW_WRITES: 'TRUE', WP_DRY_RUN: 'TRUE' } });
    const s = byName(gas.diagnostykaSystemu());
    assert.equal(s['Script Properties'].ok, false);
    assert.match(s['Script Properties'].detail, /opcjonalne: ALERT_EMAIL, WP_ALLOW_WRITES=TRUE, WP_DRY_RUN=TRUE \| ALERT_EMAIL nie jest adresem \(popraw Script Property\)$/);
    assert.equal(s['Alerty i sitemapy'].detail.split(' | ')[0], 'adresat: NIEPRAWIDŁOWY (wartość nie jest adresem)');
    assert.doesNotMatch(gas.$alerts[0][0], /sekret@example\.pl/, 'not even a malformed value reaches the report');
    assert.match(s['WordPress odczyt'].detail, /zapisy: WŁĄCZONE \| DRY_RUN$/);
  });

  test('T2c: brak ALERT_EMAIL to nie błąd, lista adresów jest liczona bez ujawniania adresów', () => {
    const none = project({ properties: { ALERT_EMAIL: '' } });
    const sn = byName(none.smokeTest());
    assert.equal(sn['Script Properties'].ok, true);
    assert.equal(sn['Script Properties'].detail, 'wymagane: 4/4 | opcjonalne: brak');
    assert.equal(sn['Alerty i sitemapy'].detail.split(' | ')[0], 'adresat: brak (ALERT_EMAIL nieustawione, alerty wyłączone)');

    const many = project({ properties: { ALERT_EMAIL: 'a@example.pl, b@example.pl' } });
    const sm = byName(many.smokeTest());
    assert.equal(sm['Alerty i sitemapy'].detail.split(' | ')[0], 'adresat: skonfigurowany i poprawny (2 adresy, wartość w Script Properties)');
    assert.doesNotMatch(JSON.stringify(plain(many.smokeTest())), /@example\.pl/, 'no address in any step');
  });

  test('T3: błędy HTTP w GSC, GA4 i WordPress → kroki czerwone z kodem, pozostałe zielone', () => {
    const gas = project({ routes: {
      gsc: { code: 403, text: '{"error":{"message":"Insufficient Permission"}}' },
      ga4: { code: 404, text: 'not found' },
      wp: { code: 401, json: { code: 'rest_not_logged_in' } }
    } });
    const s = byName(gas.diagnostykaSystemu());
    assert.equal(s['GSC odczyt'].ok, false);
    assert.match(s['GSC odczyt'].detail, /^Search Console API HTTP 403/);
    assert.equal(s['GA4 odczyt'].ok, false);
    assert.match(s['GA4 odczyt'].detail, /^Google Analytics API HTTP 404/);
    assert.equal(s['WordPress odczyt'].ok, false);
    assert.equal(s['WordPress odczyt'].detail, 'HTTP 401 dla https://www.example.pl/wp-json/wp/v2/users/me (login lub hasło aplikacji)');
    assert.equal(s['Script Properties'].ok, true);
    assert.equal(s['Triggery'].ok, true);
    assert.match(gas.$alerts[0][0], /3 z 7 kroków z błędem/);
  });

  test('T3b: siteUrl spoza listy właściwości, konto bez właściwości, użytkownik WP bez edit_pages', () => {
    const noSite = project({ routes: { gsc: { code: 200, json: { siteEntry: [{ siteUrl: 'sc-domain:other.pl', permissionLevel: 'siteFullUser' }] } } } });
    assert.equal(byName(noSite.smokeTest())['GSC odczyt'].detail, 'siteUrl „https://www.example.pl/” nie jest wśród 1 dostępnych właściwości');
    const empty = project({ routes: { gsc: { code: 200, json: {} } } });
    assert.equal(byName(empty.smokeTest())['GSC odczyt'].detail, 'konto nie ma żadnej właściwości Search Console');
    const reader = project({ routes: { wp: { code: 200, json: { slug: 'viewer', capabilities: { read: true } } } } });
    assert.match(byName(reader.smokeTest())['WordPress odczyt'].detail, /zalogowany jako viewer \| edycja stron: NIE \(brak edit_pages\)/);
  });

  test('brak zakładek i pusta konfiguracja → krok „Zakładki i konfiguracja” czerwony z listą', () => {
    const fewer = sheets();
    delete fewer['WP SNAPSHOTS'];
    delete fewer['GA4 ADS RAW'];
    const missing = loadProject({ sheets: fewer, properties: PROPS, fetch: routes() });
    const s = byName(missing.smokeTest());
    assert.equal(s['Zakładki i konfiguracja'].ok, false);
    assert.match(s['Zakładki i konfiguracja'].detail, /^brak zakładek: GA4 ADS RAW, WP SNAPSHOTS \| siteUrl:/);

    const noSiteUrl = sheets(); noSiteUrl[GSC_SHEET][1] = ['siteUrl', ''];
    const g2 = loadProject({ sheets: noSiteUrl, properties: PROPS, fetch: routes() });
    assert.equal(byName(g2.smokeTest())['Zakładki i konfiguracja'].detail, 'Konfiguracja GSC: pusty siteUrl');

    const noCfg = sheets(); delete noCfg[GSC_SHEET];
    const g3 = loadProject({ sheets: noCfg, properties: PROPS, fetch: routes() });
    const s3 = byName(g3.smokeTest());
    assert.equal(s3['Zakładki i konfiguracja'].detail, 'brak zakładki Konfiguracja GSC');
    assert.equal(s3['GSC odczyt'].ok, false, 'reading config without the sheet fails too, but the step reports instead of throwing');
  });

  test('zakładki skryptu (IMPORT LOG, URL INSPEKCJA, SEO LIVE, SITEMAPY) są wymienione, gdy istnieją; stan sitemap z SITEMAPS_STATUS', () => {
    const gas = project({
      extraSheets: { 'IMPORT LOG': [['Czas']], 'SEO LIVE': [['URL']] },
      properties: { SITEMAPS_STATUS: JSON.stringify({ checkedAt: '2026-09-06T07:00:00Z', count: 1, problems: [] }) }
    });
    const s = byName(gas.smokeTest());
    assert.match(s['Zakładki i konfiguracja'].detail, /zakładki skryptu obecne: IMPORT LOG, SEO LIVE$/);
    assert.match(s['Alerty i sitemapy'].detail, /\| Sitemapy: 1 \| OK \(sprawdzono /);
  });
});

describe('smokeTest: tylko odczyt', () => {
  test('T4: żaden krok nie zapisuje: arkusze, Script Properties i wysyłane żądania bez zmian, wszystkie żądania GET', () => {
    const gas = project({ triggers: ['importDzienny'] });
    const before = JSON.stringify({ sheets: Object.fromEntries(Object.keys(sheets()).map(n => [n, plain(gas.$sheet(n))])), props: plain(gas.$properties) });
    gas.diagnostykaSystemu();
    const after = JSON.stringify({ sheets: Object.fromEntries(Object.keys(sheets()).map(n => [n, plain(gas.$sheet(n))])), props: plain(gas.$properties) });
    assert.equal(after, before, 'no sheet or property mutated');
    assert.equal(gas.$fetchCalls.length, 3);
    gas.$fetchCalls.forEach(c => assert.equal(String(c.params.method || 'get').toLowerCase(), 'get', c.url));
    assert.equal(gas.$mails.length, 0);
    assert.equal(gas.$triggers.length, 1, 'no trigger created or deleted');
  });

  test('WP_DRY_RUN nie blokuje odczytu, a lock nie jest brany (diagnostyka może działać obok importu)', () => {
    const gas = project({ properties: { WP_DRY_RUN: 'TRUE' }, load: { lockHeld: true } });
    const s = byName(gas.smokeTest());
    assert.equal(s['WordPress odczyt'].ok, true);
    assert.deepEqual(plain(gas.$lock), []);
  });
});

describe('smokeTest: menu', () => {
  test('Dane ma pozycję Diagnostyka systemu na końcu', () => {
    const gas = project();
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.equal(dane.items[dane.items.length - 1].fn, 'diagnostykaSystemu');
  });
});
