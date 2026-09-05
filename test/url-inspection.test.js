'use strict';

/**
 * #45: inspekcja URL – stan kluczowych adresów w indeksie Google.
 * Atrapa API urlInspection.index.inspect przez fetchRouter.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const SHEET = 'URL INSPEKCJA';
const HEADER = ['URL', 'Werdykt (indeks Google)', 'Stan pokrycia', 'Kanoniczny wg Google', 'Kanoniczny wg strony', 'Ostatni crawl', 'Robots.txt', 'Sprawdzono', 'Zmiana', 'Błąd'];
const INSPECT = 'urlInspection/index:inspect';

function sheets(rows) {
  const s = {
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']]
  };
  if (rows) s[SHEET] = [HEADER, ...rows];
  return s;
}

const indexed = (url, extra = {}) => ({
  code: 200,
  json: {
    inspectionResult: {
      inspectionResultLink: 'https://search.google.com/search-console/inspect?resource_id=x',
      indexStatusResult: Object.assign({
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        lastCrawlTime: '2026-09-01T03:04:05Z',
        pageFetchState: 'SUCCESSFUL',
        googleCanonical: url,
        userCanonical: url,
        crawledAs: 'MOBILE'
      }, extra)
    }
  }
});

const noindex = () => ({
  code: 200,
  json: { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag", robotsTxtState: 'ALLOWED', indexingState: 'BLOCKED_BY_META_TAG', lastCrawlTime: '2026-08-30T10:00:00Z', googleCanonical: '', userCanonical: 'https://www.example.pl/a/' } } }
});

const byUrl = responses => (url, params) => {
  const body = JSON.parse(params.payload);
  const r = responses[body.inspectionUrl];
  if (!r) throw new Error('no fixture for ' + body.inspectionUrl);
  return typeof r === 'function' ? r(body) : r;
};

function project(rows, responses, opts = {}) {
  return loadProject(Object.assign({
    sheets: sheets(rows),
    fetch: fetchRouter([[INSPECT, byUrl(responses)]])
  }, opts));
}

describe('inspekcja URL: wyniki w wierszu', () => {
  test('T1: adres zaindeksowany → werdykt, pokrycie, kanoniczne, ostatni crawl, robots, data sprawdzenia', () => {
    const gas = project([['https://www.example.pl/a/']], { 'https://www.example.pl/a/': indexed('https://www.example.pl/a/') });
    const out = plain(gas.sprawdzIndeksowanie());
    assert.deepEqual(out, { checked: 1, errors: 0, changed: 0, skipped: 0, empty: false });

    const row = plain(gas.$sheet(SHEET)[1]);
    assert.equal(row[0], 'https://www.example.pl/a/');
    assert.equal(row[1], 'ZAINDEKSOWANY (PASS)');
    assert.equal(row[2], 'Submitted and indexed');
    assert.equal(row[3], 'https://www.example.pl/a/');
    assert.equal(row[4], 'https://www.example.pl/a/');
    // The harness formats in the runner's local zone (UTC in CI, Warsaw on the dev box), so compare through the same formatter.
    assert.equal(row[5], gas.Utilities.formatDate(new Date('2026-09-01T03:04:05Z'), 'Europe/Warsaw', 'yyyy-MM-dd HH:mm'), 'crawl time parsed from ISO and formatted');
    assert.equal(row[6], 'ALLOWED');
    assert.match(row[7], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(row[8], '');
    assert.equal(row[9], '');

    const call = gas.$fetchCalls[0];
    assert.match(call.url, /searchconsole\.googleapis\.com\/v1\/urlInspection\/index:inspect$/);
    assert.equal(call.params.method, 'post');
    assert.equal(call.params.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(JSON.parse(call.params.payload), { inspectionUrl: 'https://www.example.pl/a/', siteUrl: 'https://www.example.pl/', languageCode: 'pl' });
    assert.match(gas.$alerts[0][0], /stan w indeksie Google, nie stan live strony/);
    assert.match(gas.$alerts[0][0], /Sprawdzono: 1\nZmiany werdyktu lub pokrycia: 0\nBłędy \(kolumna Błąd\): 0$/);
  });

  test('T2: adres z noindex → WYKLUCZONY z powodem, pusty kanoniczny Google', () => {
    const gas = project([['https://www.example.pl/a/']], { 'https://www.example.pl/a/': noindex() });
    gas.sprawdzIndeksowanie();
    const row = plain(gas.$sheet(SHEET)[1]);
    assert.equal(row[1], 'WYKLUCZONY (NEUTRAL)');
    assert.equal(row[2], "Excluded by 'noindex' tag");
    assert.equal(row[3], '');
    assert.equal(row[4], 'https://www.example.pl/a/');
  });

  test('werdykt FAIL i nieznany są opisane, brak lastCrawlTime daje pustą komórkę', () => {
    const gas = project(
      [['https://www.example.pl/f/'], ['https://www.example.pl/u/']],
      {
        'https://www.example.pl/f/': indexed('https://www.example.pl/f/', { verdict: 'FAIL', coverageState: 'Server error (5xx)', lastCrawlTime: undefined }),
        'https://www.example.pl/u/': { code: 200, json: { inspectionResult: {} } }
      }
    );
    gas.sprawdzIndeksowanie();
    assert.equal(gas.$sheet(SHEET)[1][1], 'BŁĄD INDEKSOWANIA (FAIL)');
    assert.equal(gas.$sheet(SHEET)[1][5], '');
    assert.equal(gas.$sheet(SHEET)[2][1], 'NIEZNANY (VERDICT_UNSPECIFIED)');
    assert.equal(gas.$sheet(SHEET)[2][2], '');
  });

  test('T3: błąd API dla jednego adresu → wiersz z błędem i datą, poprzednie wartości zostają; reszta przetworzona', () => {
    const gas = project(
      [
        ['https://www.example.pl/a/'],
        ['https://www.example.pl/b/', 'ZAINDEKSOWANY (PASS)', 'Submitted and indexed', 'https://www.example.pl/b/', 'https://www.example.pl/b/', '2026-08-01 10:00', 'ALLOWED', '2026-08-02 07:00', '', ''],
        ['https://www.example.pl/c/']
      ],
      {
        'https://www.example.pl/a/': indexed('https://www.example.pl/a/'),
        'https://www.example.pl/b/': { code: 429, text: '{"error":{"message":"Quota exceeded"}}' },
        'https://www.example.pl/c/': indexed('https://www.example.pl/c/')
      }
    );
    const out = plain(gas.sprawdzIndeksowanie());
    assert.deepEqual(out, { checked: 2, errors: 1, changed: 0, skipped: 0, empty: false });
    const b = plain(gas.$sheet(SHEET)[2]);
    assert.equal(b[1], 'ZAINDEKSOWANY (PASS)', 'old verdict kept');
    assert.equal(b[5], '2026-08-01 10:00', 'old crawl kept');
    assert.match(b[7], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'checked time updated');
    assert.equal(b[8], '');
    assert.match(b[9], /Search Console API HTTP 429/);
    assert.equal(gas.$sheet(SHEET)[3][1], 'ZAINDEKSOWANY (PASS)');
    assert.match(gas.$alerts[0][0], /Błędy \(kolumna Błąd\): 1/);
  });

  test('adres bez http(s):// nie generuje zapytania i dostaje błąd w wierszu', () => {
    const gas = project([['example.pl/x'], ['https://www.example.pl/a/']], { 'https://www.example.pl/a/': indexed('https://www.example.pl/a/') });
    const out = plain(gas.sprawdzIndeksowanie());
    assert.equal(out.errors, 1);
    assert.equal(out.checked, 1);
    assert.match(gas.$sheet(SHEET)[1][9], /musi zaczynać się od http/);
    assert.equal(gas.$fetchCalls.length, 1);
  });
});

describe('inspekcja URL: zmiana werdyktu', () => {
  const prevRow = (url, verdict, coverage) => [url, verdict, coverage, url, url, '2026-08-01 10:00', 'ALLOWED', '2026-08-02 07:00', 'ZMIANA: stare', ''];

  test('T4: inny werdykt niż poprzednio → kolumna Zmiana z „stare → nowe”', () => {
    const gas = project([prevRow('https://www.example.pl/a/', 'ZAINDEKSOWANY (PASS)', 'Submitted and indexed')], { 'https://www.example.pl/a/': noindex() });
    const out = plain(gas.sprawdzIndeksowanie());
    assert.equal(out.changed, 1);
    assert.equal(gas.$sheet(SHEET)[1][8], "ZMIANA: ZAINDEKSOWANY (PASS) / Submitted and indexed → WYKLUCZONY (NEUTRAL) / Excluded by 'noindex' tag");
    assert.match(gas.$alerts[0][0], /Zmiany werdyktu lub pokrycia: 1/);
  });

  test('ten sam werdykt, inne pokrycie → też zmiana; identyczny stan → stara flaga zmiany jest czyszczona', () => {
    const gas = project(
      [
        prevRow('https://www.example.pl/a/', 'ZAINDEKSOWANY (PASS)', 'Indexed, not submitted in sitemap'),
        prevRow('https://www.example.pl/b/', 'ZAINDEKSOWANY (PASS)', 'Submitted and indexed')
      ],
      { 'https://www.example.pl/a/': indexed('https://www.example.pl/a/'), 'https://www.example.pl/b/': indexed('https://www.example.pl/b/') }
    );
    const out = plain(gas.sprawdzIndeksowanie());
    assert.equal(out.changed, 1);
    assert.equal(gas.$sheet(SHEET)[1][8], 'ZMIANA: ZAINDEKSOWANY (PASS) / Indexed, not submitted in sitemap → ZAINDEKSOWANY (PASS) / Submitted and indexed');
    assert.equal(gas.$sheet(SHEET)[2][8], '', 'no change → flag cleared');
  });

  test('pierwsze sprawdzenie (brak poprzedniego werdyktu) nie jest zmianą', () => {
    const gas = project([['https://www.example.pl/a/']], { 'https://www.example.pl/a/': noindex() });
    assert.equal(plain(gas.sprawdzIndeksowanie()).changed, 0);
    assert.equal(gas.$sheet(SHEET)[1][8], '');
  });
});

describe('inspekcja URL: lista, limit, lock, konfiguracja', () => {
  test('T5: brak arkusza → arkusz z nagłówkiem, komunikat, zero zapytań', () => {
    const gas = project(null, {});
    const out = plain(gas.sprawdzIndeksowanie());
    assert.equal(out.empty, true);
    assert.deepEqual(plain(gas.$sheet(SHEET)), [HEADER]);
    assert.equal(gas.$fetchCalls.length, 0);
    assert.match(gas.$alerts[0][0], /nie ma adresów\. Wpisz adresy w kolumnie A/);
  });

  test('arkusz z samym nagłówkiem albo pustymi wierszami → zero zapytań', () => {
    const gas = project([], {});
    assert.equal(plain(gas.sprawdzIndeksowanie()).empty, true);
    const blanks = project([[''], ['   ']], {});
    const out = plain(blanks.sprawdzIndeksowanie());
    assert.deepEqual(out, { checked: 0, errors: 0, changed: 0, skipped: 0, empty: false });
    assert.equal(blanks.$fetchCalls.length, 0);
  });

  test('istniejący arkusz bez nagłówka dostaje nagłówek, dane zostają; wyścig o insertSheet kończy się użyciem istniejącego', () => {
    const s = sheets(null);
    s[SHEET] = [['https://www.example.pl/a/']];
    const gas = loadProject({ sheets: s, fetch: fetchRouter([[INSPECT, byUrl({ 'https://www.example.pl/a/': indexed('https://www.example.pl/a/') })]]) });
    const out = plain(gas.sprawdzIndeksowanie());
    assert.deepEqual(plain(gas.$sheet(SHEET)[0]), HEADER, 'header inserted above the data');
    assert.equal(gas.$sheet(SHEET)[1][0], 'https://www.example.pl/a/', 'the pasted URL moved to row 2, not overwritten');
    assert.equal(gas.$sheet(SHEET)[1][1], 'ZAINDEKSOWANY (PASS)', 'and was inspected');
    assert.equal(out.checked, 1);

    const race = project(null, {});
    const ss = race.SpreadsheetApp.getActive();
    const realGet = ss.getSheetByName;
    let calls = 0;
    ss.getSheetByName = name => { calls++; return calls === 1 ? null : realGet(name); };
    ss.insertSheet = () => { throw new Error('A sheet with the name "URL INSPEKCJA" already exists.'); };
    ss.getSheetByName = (name => { calls++; if (calls === 1) return null; ss.insertSheet(name === SHEET ? SHEET : name); return realGet(name); });
    ss.insertSheet = (name => { if (!race.$sheet(name)) realGet(name); throw new Error('exists'); });
    assert.throws(() => race.ensureUrlInspectionSheet_(), /exists/, 'a genuine insert failure is not hidden');
  });

  test('limit na przebieg: nadmiarowe adresy są pomijane i zgłoszone w oknie', () => {
    const rows = Array.from({ length: 152 }, (_, i) => ['https://www.example.pl/p' + i + '/']);
    const gas = loadProject({
      sheets: sheets(rows),
      fetch: fetchRouter([[INSPECT, (url, params) => indexed(JSON.parse(params.payload).inspectionUrl)]])
    });
    const out = plain(gas.sprawdzIndeksowanie());
    assert.deepEqual(out, { checked: 150, errors: 0, changed: 0, skipped: 2, empty: false });
    assert.equal(gas.$fetchCalls.length, 150);
    assert.equal(gas.$sheet(SHEET)[151][1] ?? '', '', 'row 151 untouched');
    assert.equal(gas.$sheet(SHEET)[150][1], 'ZAINDEKSOWANY (PASS)', 'row 150 processed');
    assert.match(gas.$alerts[0][0], /Pominięto: 2 \(limit 150 adresów na przebieg; kolejny przebieg zaczyna od najdawniej sprawdzonych\)/);

    // Drugi przebieg: najpierw 2 nigdy niesprawdzone, potem 148 najdawniej sprawdzonych (wiersze 2..149).
    gas.$fetchCalls.length = 0;
    const second = plain(gas.sprawdzIndeksowanie());
    assert.deepEqual(second, { checked: 150, errors: 0, changed: 0, skipped: 2, empty: false });
    const inspected = gas.$fetchCalls.map(c => JSON.parse(c.params.payload).inspectionUrl);
    assert.deepEqual(inspected.slice(0, 2), ['https://www.example.pl/p150/', 'https://www.example.pl/p151/'], 'tail first');
    assert.equal(inspected[2], 'https://www.example.pl/p0/');
    assert.equal(inspected[149], 'https://www.example.pl/p147/');
    assert.ok(!inspected.includes('https://www.example.pl/p148/') && !inspected.includes('https://www.example.pl/p149/'), 'the two most recently checked wait for the next run');
  });

  test('kolejka: nigdy niesprawdzone przed najdawniej sprawdzonymi, błędne wiersze rotują jak inne, nieczytelna data = najpilniejsza', () => {
    const rows = [
      ['https://www.example.pl/recent/', 'ZAINDEKSOWANY (PASS)', '', '', '', '', '', '2026-09-05 10:00', '', ''],
      ['https://www.example.pl/old/', 'ZAINDEKSOWANY (PASS)', '', '', '', '', '', '2026-08-01 10:00', '', ''],
      ['https://www.example.pl/never/'],
      ['https://www.example.pl/errored/', '', '', '', '', '', '', '2026-08-15 10:00', '', 'HTTP 429'],
      ['https://www.example.pl/garbage/', '', '', '', '', '', '', 'kiedyś', '', '']
    ];
    const gas = loadProject({ sheets: sheets(rows) });
    const queue = plain(gas.urlInspectionQueue_(gas.$sheet(SHEET).slice(1))).map(q => q.url.replace('https://www.example.pl/', ''));
    assert.deepEqual(queue, ['never/', 'garbage/', 'old/', 'errored/', 'recent/']);
    assert.equal(gas.urlInspectionCheckedAt_(new gas.$Date(2026, 0, 1)), new Date(2026, 0, 1).getTime(), 'Date cell');
  });

  test('brak siteUrl → jasny błąd przed jakimkolwiek zapytaniem', () => {
    const s = sheets([['https://www.example.pl/a/']]);
    s[GSC_SHEET][1] = ['siteUrl', ''];
    const gas = loadProject({ sheets: s, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.sprawdzIndeksowanie(), /Brak siteUrl w arkuszu Konfiguracja GSC/);
  });

  test('przebieg działa pod wspólnym lockiem i odmawia, gdy inne uruchomienie trwa', () => {
    const gas = project([['https://www.example.pl/a/']], { 'https://www.example.pl/a/': indexed('https://www.example.pl/a/') });
    gas.sprawdzIndeksowanie();
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
    const busy = project([['https://www.example.pl/a/']], {}, { lockHeld: true });
    assert.throws(() => busy.sprawdzIndeksowanie(), /Inne uruchomienie jeszcze trwa \(inspekcja URL\)/);
    assert.equal(busy.$fetchCalls.length, 0);
  });
});

describe('inspekcja URL: menu i trigger', () => {
  test('menu SEO / GSC ma obie pozycje po separatorze', () => {
    const gas = project(null, {});
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn), ['testPolaczenia', 'importOstatniZakres', 'importDzienny', 'ustawAutomatycznyImport', 'sprawdzIndeksowanie', 'ustawTygodniowaInspekcje']);
  });

  test('ustawTygodniowaInspekcje instaluje trigger poniedziałek 07:00 i zastępuje stary', () => {
    const gas = project(null, {}, { triggers: ['sprawdzIndeksowanieTrigger', 'importDzienny'] });
    gas.ustawTygodniowaInspekcje();
    const mine = gas.$triggers.filter(t => t.getHandlerFunction() === 'sprawdzIndeksowanieTrigger');
    assert.equal(mine.length, 1);
    assert.deepEqual(plain(mine[0].$spec), { handler: 'sprawdzIndeksowanieTrigger', everyDays: null, atHour: 7, weekDay: 'MONDAY' });
    assert.equal(gas.$triggers.length, 2, 'other triggers untouched');
    assert.match(gas.$alerts[0][0], /poniedziałek, ok\. 7:00/);
  });

  test('handler triggera nie otwiera okna, loguje podsumowanie i zwraca je', () => {
    const gas = project([['https://www.example.pl/a/']], { 'https://www.example.pl/a/': indexed('https://www.example.pl/a/') });
    const out = plain(gas.sprawdzIndeksowanieTrigger());
    assert.equal(out.checked, 1);
    assert.equal(gas.$alerts.length, 0);
    assert.equal(gas.$sheet(SHEET)[1][1], 'ZAINDEKSOWANY (PASS)');
  });
});
