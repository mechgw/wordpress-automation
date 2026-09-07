'use strict';

/**
 * #123, etap pierwszy: wszystko poza samym dostępem do API.
 *
 * Kształt odpowiedzi jest odwzorowany według dokumentacji Business Profile
 * Performance API v1 i nie był sprawdzony na żywym ruchu, więc te testy pilnują
 * przede wszystkim tego, co jest pod naszą kontrolą: budowy żądań, parsowania,
 * idempotencji zapisu i tego, żeby odmowa API mówiła, czego brakuje.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const PERF = 'GBP PERFORMANCE RAW';
const KEYS = 'GBP SEARCH KEYWORDS';
const PERF_HEADER = ['Data', 'Lokalizacja', 'Metryka', 'Wartość', 'Pobrano'];
const KEYS_HEADER = ['Miesiąc', 'Lokalizacja', 'Fraza', 'Wyświetlenia', 'Rodzaj wartości', 'Pobrano'];
const LOCATION = 'locations/111';

const dated = (day, value) => ({ date: { year: 2026, month: 9, day: day }, value: value });
const dailyResponse = series => ({
  multiDailyMetricTimeSeries: [{
    dailyMetricTimeSeries: series.map(s => ({ dailyMetric: s.metric, timeSeries: { datedValues: s.values } }))
  }]
});

function project({ location = LOCATION, fetch, sheets = {} } = {}) {
  return loadProject({
    properties: location ? { GBP_LOCATION: location } : {},
    sheets: sheets,
    fetch: fetch || (() => ({ code: 200, text: '{}' }))
  });
}

describe('#123: konfiguracja lokalizacji', () => {
  test('brak właściwości mówi wprost, czego brakuje i w jakim formacie', () => {
    assert.throws(() => project({ location: '' }).getGbpConfig_(), /Brak Script Property: GBP_LOCATION.*locations\/<id>/s);
  });

  test('zły format jest odrzucany razem z podaną wartością', () => {
    assert.throws(() => project({ location: '12345' }).getGbpConfig_(), /oczekiwano formatu locations\/<id>, jest „12345”/);
  });

  test('poprawna wartość przechodzi, a stan konfiguracji da się sprawdzić bez wyjątku', () => {
    assert.equal(plain(project().getGbpConfig_()).location, LOCATION);
    assert.equal(project().isGbpConfigured_(), true);
    assert.equal(project({ location: '' }).isGbpConfigured_(), false);
    assert.equal(project({ location: 'nonsens' }).isGbpConfigured_(), false);
  });
});

describe('#123: budowa żądań', () => {
  const gas = () => project();

  test('adres metryk wymienia wszystkie metryki i obie granice zakresu', () => {
    const url = gas().gbpDailyUrl_(LOCATION, new Date(2026, 8, 1), new Date(2026, 8, 7));
    assert.match(url, /^https:\/\/businessprofileperformance\.googleapis\.com\/v1\/locations\/111:fetchMultiDailyMetricsTimeSeries\?/);
    assert.match(url, /dailyMetrics=WEBSITE_CLICKS/);
    assert.match(url, /dailyMetrics=CALL_CLICKS/);
    assert.match(url, /dailyRange\.start_date\.year=2026&dailyRange\.start_date\.month=9&dailyRange\.start_date\.day=1/);
    assert.match(url, /dailyRange\.end_date\.day=7/);
    assert.equal((url.match(/dailyMetrics=/g) || []).length, 7, 'siedem metryk, bez cichych ubytków');
  });

  test('adres fraz dokłada token strony tylko wtedy, gdy istnieje', () => {
    assert.match(gas().gbpKeywordsUrl_(LOCATION, ''), /locations\/111\/searchkeywords\/impressions\/monthly$/);
    assert.match(gas().gbpKeywordsUrl_(LOCATION, 'abc def'), /\?pageToken=abc%20def$/);
  });
});

describe('#123: odmowa API mówi, czego brakuje', () => {
  const failing = code => project({ fetch: () => ({ code: code, text: '{"error":{"message":"nope"}}' }) });

  test('401 wskazuje brak zakresu OAuth i ponowną autoryzację', () => {
    assert.throws(() => failing(401).gbpApiRequest_('https://x/'), /brak zakresu OAuth.*autoryzuj projekt ponownie/s);
  });

  test('403 tłumaczy, że włączenie API nie wystarcza bez przyznanego dostępu', () => {
    assert.throws(() => failing(403).gbpApiRequest_('https://x/'), /Włączenie API w Google Cloud nie wystarcza.*limit wynosi zero/s);
  });

  test('404 kieruje do konfiguracji lokalizacji, a nie do dostępu', () => {
    assert.throws(() => failing(404).gbpApiRequest_('https://x/'), /nie zna tej lokalizacji \(404\).*GBP_LOCATION/s);
  });

  test('inny błąd podaje kod i skrócone ciało odpowiedzi', () => {
    assert.throws(() => failing(500).gbpApiRequest_('https://x/'), /Business Profile API HTTP 500/);
  });

  test('poprawna odpowiedź jest parsowana, pusta daje pusty obiekt', () => {
    const gas = project({ fetch: () => ({ code: 200, text: '{"a":1}' }) });
    assert.deepEqual(plain(gas.gbpApiRequest_('https://x/')), { a: 1 });
    const empty = project({ fetch: () => ({ code: 200, text: '' }) });
    assert.deepEqual(plain(empty.gbpApiRequest_('https://x/')), {});
  });
});

describe('#123: parsowanie odpowiedzi', () => {
  const gas = () => project();

  test('spłaszcza serie do wierszy data-metryka-wartość', () => {
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'WEBSITE_CLICKS', values: [dated(1, '5'), dated(2, '7')] },
      { metric: 'CALL_CLICKS', values: [dated(1, '2')] }
    ])));
    assert.deepEqual(out, [
      { date: '2026-09-01', metric: 'WEBSITE_CLICKS', value: 5 },
      { date: '2026-09-02', metric: 'WEBSITE_CLICKS', value: 7 },
      { date: '2026-09-01', metric: 'CALL_CLICKS', value: 2 }
    ]);
  });

  test('brak wartości nie staje się zerem', () => {
    // API pomija dni bez danych, a to nie to samo co dzień z zerem. Zamiana
    // jednego na drugie zamieniłaby brak pomiaru w pomiar.
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'WEBSITE_CLICKS', values: [dated(1, '5'), { date: { year: 2026, month: 9, day: 2 } }] }
    ])));
    assert.equal(out.length, 1);
    assert.equal(out[0].date, '2026-09-01');
  });

  test('zero podane wprost jest zapisywane, bo to prawdziwy pomiar', () => {
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([{ metric: 'CALL_CLICKS', values: [dated(3, '0')] }])));
    assert.deepEqual(out, [{ date: '2026-09-03', metric: 'CALL_CLICKS', value: 0 }]);
  });

  test('pusta i nietypowa odpowiedź nie wywraca parsowania', () => {
    assert.deepEqual(plain(gas().parseGbpDailySeries_({})), []);
    assert.deepEqual(plain(gas().parseGbpDailySeries_(null)), []);
    assert.deepEqual(plain(gas().parseGbpDailySeries_({ multiDailyMetricTimeSeries: [{}] })), []);
  });

  test('frazy rozróżniają wartość dokładną od progu', () => {
    const out = plain(gas().parseGbpKeywords_({
      searchKeywordsCounts: [
        { searchKeyword: 'kurier', insightsValue: { value: '120' } },
        { searchKeyword: 'przesyłka', insightsValue: { threshold: '15' } },
        { searchKeyword: 'bez wartości', insightsValue: {} },
        { searchKeyword: '   ' }
      ]
    }));
    assert.deepEqual(out, [
      { keyword: 'kurier', value: 120, kind: 'dokładna' },
      { keyword: 'przesyłka', value: 15, kind: 'próg (co najmniej)' },
      { keyword: 'bez wartości', value: '', kind: 'brak wartości' }
    ]);
  });
});

describe('#123: idempotentny zapis', () => {
  test('ponowny import tego samego zakresu podmienia wiersze zamiast je dublować', () => {
    const responses = [
      dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }]),
      dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '9')] }])
    ];
    let call = 0;
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(responses[Math.min(call++, 1)]) })
    });
    gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1));
    gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1));
    const rows = gas.$sheet(PERF).slice(1);
    assert.equal(rows.length, 1, 'jeden wiersz, nie dwa');
    assert.equal(rows[0][3], 9, 'z nowszą wartością');
  });

  test('backfill starszego okresu nie kasuje nowszych danych', () => {
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER, ['2026-09-05', LOCATION, 'WEBSITE_CLICKS', 3, '2026-09-05']] },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }])) })
    });
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1)));
    assert.equal(out.kept, 1, 'wcześniejszy wiersz zachowany');
    const dates = gas.$sheet(PERF).slice(1).map(r => r[0]).sort();
    assert.deepEqual(dates, ['2026-09-01', '2026-09-05']);
  });

  test('import fraz stronicuje i zapisuje rodzaj wartości', () => {
    const pages = [
      { searchKeywordsCounts: [{ searchKeyword: 'a', insightsValue: { value: '10' } }], nextPageToken: 'x' },
      { searchKeywordsCounts: [{ searchKeyword: 'b', insightsValue: { threshold: '5' } }] }
    ];
    let call = 0;
    const gas = project({
      sheets: { [KEYS]: [KEYS_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(pages[Math.min(call++, 1)]) })
    });
    const out = plain(gas.runGbpKeywordsImport_());
    assert.equal(out.rows, 2, 'obie strony');
    const rows = gas.$sheet(KEYS).slice(1);
    assert.deepEqual(rows.map(r => r[2]), ['a', 'b']);
    assert.deepEqual(rows.map(r => r[4]), ['dokładna', 'próg (co najmniej)']);
  });
});

describe('#123: menu', () => {
  test('przygotowanie zakłada obie zakładki i wymienia brakujące kroki po stronie Google', () => {
    const gas = project({ location: '' });
    assert.equal(gas.przygotujBusinessProfile(), false, 'bez GBP_LOCATION funkcja nie jest skonfigurowana');
    assert.deepEqual(gas.$sheet(PERF)[0], PERF_HEADER);
    assert.deepEqual(gas.$sheet(KEYS)[0], KEYS_HEADER);
    const text = gas.$alerts[0][0];
    assert.match(text, /brak Script Property GBP_LOCATION/);
    assert.match(text, /Przyznany dostęp do Business Profile API/);
    assert.match(text, /Zakres OAuth Business Profile w appsscript\.json/);
  });

  test('przy ustawionej lokalizacji stan konfiguracji jest podany wprost', () => {
    const gas = project();
    assert.equal(gas.przygotujBusinessProfile(), true);
    assert.match(gas.$alerts[0][0], /GBP_LOCATION ustawione/);
  });

  test('import z menu podsumowuje obie części', () => {
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER], [KEYS]: [KEYS_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }])) })
    });
    gas.importujBusinessProfile();
    const text = gas.$alerts[0][0];
    assert.match(text, /Wydajność: 1 pomiarów/);
    assert.match(text, /Frazy: 0 fraz za \d{4}-\d{2}/);
  });

  test('pozycje są w menu SEO / GSC', () => {
    const gas = project();
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    // Po sekcji Business Profile zaczyna się pomiar wydajności, więc kotwiczymy
    // się na parze, a nie na końcu menu.
    const fns = seo.items.map(i => i.fn);
    const at = fns.indexOf('przygotujBusinessProfile');
    assert.deepEqual(fns.slice(at, at + 2), ['przygotujBusinessProfile', 'importujBusinessProfile']);
  });
});
