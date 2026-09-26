'use strict';

/**
 * #123: import Google Business Profile.
 *
 * Kształt odpowiedzi jest odwzorowany według dokumentacji Business Profile
 * Performance API v1 i nie był sprawdzony na żywym ruchu, więc te testy pilnują
 * przede wszystkim tego, co jest pod naszą kontrolą: budowy żądań, parsowania,
 * idempotencji zapisu i tego, żeby odmowa API mówiła, czego brakuje.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProject, plain, freezeClock } = require('./helpers/gas');

const PERF = 'GBP PERFORMANCE RAW';
const KEYS = 'GBP SEARCH KEYWORDS';
const PERF_HEADER = ['Data', 'Lokalizacja', 'Metryka', 'Wartość', 'Pobrano'];
const KEYS_HEADER = ['Miesiąc', 'Lokalizacja', 'Fraza', 'Wyświetlenia', 'Rodzaj wartości', 'Pobrano'];
const LOCATION = 'locations/111';

const dated = (day, value) => ({ date: { year: 2026, month: 9, day: day }, value: value });
const bare = day => ({ date: { year: 2026, month: 9, day: day } });
const dailyResponse = series => ({
  multiDailyMetricTimeSeries: [{
    dailyMetricTimeSeries: series.map(s => ({ dailyMetric: s.metric, timeSeries: { datedValues: s.values } }))
  }]
});

function project({ location = LOCATION, fetch, sheets = {}, props = {}, lockHeld = false } = {}) {
  return loadProject({
    properties: Object.assign(location ? { GBP_LOCATION: location } : {}, props),
    sheets: sheets,
    lockHeld: lockHeld,
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

  test('adres fraz ma wymagany zakres jednego miesiąca, a token strony tylko wtedy, gdy istnieje', () => {
    const aug = { year: 2026, month: 8 };
    assert.match(
      gas().gbpKeywordsUrl_(LOCATION, aug, ''),
      /locations\/111\/searchkeywords\/impressions\/monthly\?monthlyRange\.start_month\.year=2026&monthlyRange\.start_month\.month=8&monthlyRange\.end_month\.year=2026&monthlyRange\.end_month\.month=8$/
    );
    assert.match(gas().gbpKeywordsUrl_(LOCATION, aug, 'abc def'), /monthlyRange\.end_month\.month=8&pageToken=abc%20def$/);
  });
});

describe('#123: odmowa API mówi, czego brakuje', () => {
  const failing = code => project({ fetch: () => ({ code: code, text: '{"error":{"message":"nope"}}' }) });

  test('401 wskazuje zakres w manifeście i ponowną autoryzację', () => {
    assert.throws(
      () => failing(401).gbpApiRequest_('https://x/'),
      /appsscript\.json zawiera zakres business\.manage.*ponownie autoryzowany/s
    );
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

  test('punkt bez wartości przed horyzontem danych to zero', () => {
    // Dokumentacja DatedValue: `value` nie występuje, gdy wartość wynosi zero.
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'WEBSITE_CLICKS', values: [dated(1, '5'), bare(2), dated(3, '7')] }
    ])));
    assert.deepEqual(out.map(r => [r.date, r.value]), [['2026-09-01', 5], ['2026-09-02', 0], ['2026-09-03', 7]]);
  });

  test('horyzont jest wspólny dla wszystkich metryk', () => {
    // Metryka bez żadnej wartości też dostaje zera do dnia, w którym inna metryka
    // ma już dane; dzień za horyzontem nie powstaje w żadnej metryce.
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'CALL_CLICKS', values: [bare(1), bare(2), bare(3)] },
      { metric: 'WEBSITE_CLICKS', values: [dated(1, '1'), dated(2, '2'), bare(3)] }
    ])));
    assert.deepEqual(out.map(r => [r.metric, r.date, r.value]), [
      ['CALL_CLICKS', '2026-09-01', 0],
      ['CALL_CLICKS', '2026-09-02', 0],
      ['WEBSITE_CLICKS', '2026-09-01', 1],
      ['WEBSITE_CLICKS', '2026-09-02', 2]
    ]);
  });

  test('dni za horyzontem danych są pomijane, a nie zerowane', () => {
    // Tak wyglądają dni, których Google jeszcze nie przetworzył: zero byłoby
    // fałszywym pomiarem, a kolejny import i tak je uzupełni.
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'WEBSITE_CLICKS', values: [dated(1, '5'), bare(2)] }
    ])));
    assert.deepEqual(out.map(r => [r.date, r.value]), [['2026-09-01', 5]]);
  });

  test('odpowiedź bez żadnej wartości nie tworzy zer', () => {
    const out = plain(gas().parseGbpDailySeries_(dailyResponse([
      { metric: 'WEBSITE_CLICKS', values: [bare(1), bare(2)] }
    ])));
    assert.deepEqual(out, []);
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
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1)));
    const rows = gas.$sheet(PERF).slice(1);
    assert.equal(rows.length, 1, 'jeden wiersz, nie dwa');
    assert.equal(rows[0][3], 9, 'z nowszą wartością');
    assert.equal(out.detail, '1 pomiarów (2026-09-01 – 2026-09-01)', 'dane do końca zakresu: bez dopisku o horyzoncie');
  });

  test('wynik importu mówi, do kiedy są dane, gdy ostatnie dni zakresu są jeszcze puste', () => {
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([
        { metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', values: [dated(1, '4'), dated(2, '6'), bare(3)] },
        { metric: 'CALL_CLICKS', values: [bare(1), bare(2), bare(3)] }
      ])) })
    });
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 3)));
    assert.equal(out.rows, 4, 'dwa dni po dwie metryki, trzeci dzień za horyzontem');
    assert.equal(out.detail, '4 pomiarów (2026-09-01 – 2026-09-03; dane Google do 2026-09-02)');
    const calls = gas.$sheet(PERF).slice(1).filter(r => r[2] === 'CALL_CLICKS').map(r => r[3]);
    assert.deepEqual(calls, [0, 0], 'zera zapisane jako liczby, nie puste komórki');
  });

  test('ponowny import rozpoznaje dzień, który arkusz zamienił na datę (#155)', () => {
    // Arkusz zapisuje '2026-09-01' jako datę i oddaje ją jako Date; klucz ze
    // `String()` nie rozpoznawał wtedy własnego wiersza i każdy import dopisywał wszystko.
    const responses = [
      dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }]),
      dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '9')] }])
    ];
    let call = 0;
    const gas = project({
      sheets: { [PERF]: { rows: [PERF_HEADER], parsesOnWrite: true } },
      fetch: () => ({ code: 200, text: JSON.stringify(responses[Math.min(call++, 1)]) })
    });
    gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1));
    assert.ok(gas.$sheet(PERF)[1][0] instanceof gas.$Date, 'arkusz trzyma datę, nie tekst');
    gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1));
    const rows = gas.$sheet(PERF).slice(1);
    assert.equal(rows.length, 1, 'jeden wiersz, nie dwa');
    assert.equal(rows[0][3], 9, 'z nowszą wartością');
  });

  test('ponowny import fraz rozpoznaje miesiąc, który arkusz zamienił na datę', () => {
    const gas = freezeClock(project({
      sheets: { [KEYS]: { rows: [KEYS_HEADER], parsesOnWrite: true } },
      fetch: () => ({ code: 200, text: JSON.stringify({ searchKeywordsCounts: [{ searchKeyword: 'a', insightsValue: { value: '10' } }] }) })
    }), 2026, 8, 26);
    gas.runGbpKeywordsImport_();
    assert.ok(gas.$sheet(KEYS)[1][0] instanceof gas.$Date, 'miesiąc zapisany jako data');
    const out = plain(gas.runGbpKeywordsImport_());
    assert.equal(gas.$sheet(KEYS).length - 1, 1, 'jeden wiersz, nie dwa');
    assert.equal(out.kept, 0, 'wiersz podmieniony, a nie zachowany obok nowego');
  });

  test('po posortowaniu zakładki zostaje kopia z najnowszym Pobrano, nie najniższa', () => {
    const gas = project({
      sheets: { [PERF]: { rows: [PERF_HEADER], parsesOnWrite: true } },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(2, '1')] }])) })
    });
    gas.SpreadsheetApp.getActive().getSheetByName(PERF).getRange(2, 1, 3, 5).setValues([
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 3, '2026-09-26 12:00:00'],
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 4, '2026-09-26 13:00:00'],
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 5, '2026-09-26 11:00:00']
    ]);
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 2), new Date(2026, 8, 2)));
    assert.equal(out.merged, 2);
    const kept = gas.$sheet(PERF).slice(1).filter(r => r[2] === 'WEBSITE_CLICKS' && r[3] !== 1);
    assert.deepEqual(kept.map(r => r[3]), [4], 'odczyt z 13:00, choć stał w środku');
  });

  test('przy równym Pobrano z duplikatów zostaje ostatnie wystąpienie', () => {
    const gas = project({
      sheets: { [PERF]: { rows: [PERF_HEADER], parsesOnWrite: true } },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(2, '1')] }])) })
    });
    // Stan z produkcji 26.09: ten sam dzień zapisany trzy razy, jako data.
    gas.SpreadsheetApp.getActive().getSheetByName(PERF).getRange(2, 1, 3, 5).setValues([
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 3, ''],
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 4, ''],
      ['2026-09-01', LOCATION, 'WEBSITE_CLICKS', 5, '']
    ]);
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 2), new Date(2026, 8, 2)));
    assert.equal(out.merged, 2, 'dwie nadmiarowe kopie');
    assert.equal(out.kept, 1, 'dzień spoza importu zostaje w jednej kopii');
    // clearContent zostawia w atrapie puste wiersze; getLastRow() arkusza ich nie liczy.
    const rows = gas.$sheet(PERF).slice(1).filter(r => r.some(v => v !== '' && v !== null && v !== undefined));
    assert.equal(rows.length, 2, 'jedna kopia 01.09 i nowy wiersz 02.09');
    assert.equal(rows[0][3], 5, 'ostatnie wystąpienie, czyli najnowszy odczyt');
  });

  test('bez żadnych danych w zakresie wynik importu mówi to wprost', () => {
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'CALL_CLICKS', values: [bare(1)] }])) })
    });
    const out = plain(gas.runGbpPerformanceImport_(new Date(2026, 8, 1), new Date(2026, 8, 1)));
    assert.equal(out.rows, 0);
    assert.equal(out.detail, '0 pomiarów (2026-09-01 – 2026-09-01; Google nie podał jeszcze danych z tego zakresu)');
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

  test('import fraz pyta o ostatni pełny miesiąc, stronicuje i oznacza wiersze tym miesiącem', () => {
    const pages = [
      { searchKeywordsCounts: [{ searchKeyword: 'a', insightsValue: { value: '10' } }], nextPageToken: 'x' },
      { searchKeywordsCounts: [{ searchKeyword: 'b', insightsValue: { threshold: '5' } }] }
    ];
    const urls = [];
    const gas = freezeClock(project({
      sheets: { [KEYS]: [KEYS_HEADER] },
      fetch: url => {
        urls.push(url);
        return { code: 200, text: JSON.stringify(pages[Math.min(urls.length - 1, 1)]) };
      }
    }), 2026, 8, 26);
    const out = plain(gas.runGbpKeywordsImport_());
    assert.equal(out.rows, 2, 'obie strony');
    assert.equal(out.detail, '2 fraz za 2026-08', 'wrzesień jeszcze trwa, więc sierpień');
    assert.equal(urls.length, 2);
    urls.forEach(u => assert.match(u, /monthlyRange\.start_month\.year=2026&monthlyRange\.start_month\.month=8&monthlyRange\.end_month\.year=2026&monthlyRange\.end_month\.month=8/));
    assert.match(urls[1], /&pageToken=x$/, 'druga strona: ten sam miesiąc i token');
    const rows = gas.$sheet(KEYS).slice(1);
    assert.deepEqual(rows.map(r => r[0]), ['2026-08', '2026-08'], 'miesiąc zapytania, nie miesiąc uruchomienia');
    assert.deepEqual(rows.map(r => r[2]), ['a', 'b']);
    assert.deepEqual(rows.map(r => r[4]), ['dokładna', 'próg (co najmniej)']);
  });

  test('w styczniu ostatni pełny miesiąc to grudzień poprzedniego roku', () => {
    const urls = [];
    const gas = freezeClock(project({
      sheets: { [KEYS]: [KEYS_HEADER] },
      fetch: url => { urls.push(url); return { code: 200, text: '{}' }; }
    }), 2027, 0, 15);
    assert.equal(plain(gas.runGbpKeywordsImport_()).detail, '0 fraz za 2026-12');
    assert.match(urls[0], /start_month\.year=2026&monthlyRange\.start_month\.month=12&monthlyRange\.end_month\.year=2026&monthlyRange\.end_month\.month=12/);
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
    assert.match(text, /Zakres OAuth Business Profile jest już w appsscript\.json/);
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
    assert.doesNotMatch(text, /scalono/, 'bez duplikatów bez dopisku');
  });

  test('okno importu mówi, ile zdublowanych wierszy scalono', () => {
    const gas = project({
      sheets: { [PERF]: [PERF_HEADER], [KEYS]: [KEYS_HEADER] },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }])) })
    });
    gas.SpreadsheetApp.getActive().getSheetByName(PERF).getRange(2, 1, 3, 5).setValues([
      ['2026-08-01', LOCATION, 'CALL_CLICKS', 1, ''],
      ['2026-08-01', LOCATION, 'CALL_CLICKS', 1, ''],
      ['2026-08-01', LOCATION, 'CALL_CLICKS', 1, '']
    ]);
    gas.importujBusinessProfile();
    assert.match(gas.$alerts[0][0], /Wydajność: .*zachowano 1 wcześniejszych wierszy, scalono 2 zdublowanych\./);
  });

  test('pozycje są w menu SEO / GSC', () => {
    const gas = project();
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    // Po sekcji Business Profile zaczyna się pomiar wydajności, więc kotwiczymy
    // się na parze, a nie na końcu menu.
    const fns = seo.items.map(i => i.fn);
    const at = fns.indexOf('przygotujBusinessProfile');
    assert.deepEqual(fns.slice(at, at + 3), ['przygotujBusinessProfile', 'importujBusinessProfile', 'ustawCodziennyImportBusinessProfile']);
  });
});

describe('#123: codzienny import', () => {
  const sheets = () => ({ [PERF]: [PERF_HEADER], [KEYS]: [KEYS_HEADER] });
  const ok = () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [dated(1, '5')] }])) });
  const record = gas => JSON.parse(gas.$properties.LAST_RUN_GBP || '{}');
  const lastLog = gas => { const log = gas.$sheet('IMPORT LOG'); return log[log.length - 1]; };

  test('przebieg z triggera trafia do rekordu zadania i do IMPORT LOG', () => {
    const gas = project({ sheets: sheets(), fetch: ok });
    gas.importBusinessProfileTrigger();
    const run = record(gas).lastRun;
    assert.equal(run.ok, true);
    assert.equal(run.trigger, true);
    assert.match(run.detail, /^wydajność: 1 pomiarów .* \| frazy: 0 fraz za \d{4}-\d{2}$/);
    assert.equal(run.warning, '');
    assert.deepEqual([lastLog(gas)[1], lastLog(gas)[2], lastLog(gas)[4]], ['GBP', 'trigger', 'OK']);
  });

  test('tydzień bez żadnego pomiaru kończy przebieg ostrzeżeniem z mailem, a nie błędem', () => {
    const gas = project({
      sheets: sheets(),
      props: { ALERT_EMAIL: 'alerty@example.com' },
      fetch: () => ({ code: 200, text: JSON.stringify(dailyResponse([{ metric: 'WEBSITE_CLICKS', values: [bare(1)] }])) })
    });
    gas.importBusinessProfileTrigger();
    const rec = record(gas);
    assert.equal(rec.lastRun.ok, true, 'import się udał');
    assert.equal(rec.lastRun.warning, 'Google nie podał żadnych pomiarów wydajności z ostatnich 7 dni');
    assert.equal(rec.incident.reason, 'warning');
    assert.equal(gas.$mails.length, 1);
    assert.match(gas.$mails[0].subject, /UWAGA: Business Profile \(GBP\)/);
    assert.equal(lastLog(gas)[4], 'UWAGA');
  });

  test('odmowa API zapisuje błąd w rekordzie i w IMPORT LOG, a wyjątek idzie dalej', () => {
    const gas = project({ sheets: sheets(), fetch: () => ({ code: 403, text: '{"error":{"message":"nope"}}' }) });
    assert.throws(() => gas.importBusinessProfileTrigger(), /403/);
    assert.equal(record(gas).lastRun.ok, false);
    assert.equal(lastLog(gas)[4], 'BŁĄD');
  });

  test('import z menu nie zakłada rekordu zadania', () => {
    // Ręczny przebieg bez triggera wyglądałby po dobie dla strażnika jak awaria.
    const gas = project({ sheets: sheets(), fetch: ok });
    gas.importujBusinessProfile();
    assert.equal(gas.$properties.LAST_RUN_GBP, undefined);
  });

  test('import z menu i trigger nie ruszają API, gdy blokadę trzyma inne wykonanie', () => {
    const gas = project({ sheets: sheets(), lockHeld: true, fetch: () => { throw new Error('bez blokady nie wolno pytać API'); } });
    assert.throws(() => gas.importujBusinessProfile(), /Inne uruchomienie jeszcze trwa \(import Business Profile\)/);
    assert.throws(() => gas.importBusinessProfileTrigger(), /Inne uruchomienie jeszcze trwa \(import Business Profile\)/);
  });

  test('włączenie bez GBP_LOCATION odmawia i nie zakłada triggera', () => {
    const gas = project({ location: '' });
    assert.equal(gas.ustawCodziennyImportBusinessProfile(), false);
    assert.equal(gas.$triggers.length, 0);
    assert.match(gas.$alerts[0][0], /NIE został włączony.*GBP_LOCATION/s);
  });

  test('ponowne włączenie zostawia jeden codzienny trigger o 7:00', () => {
    const gas = project();
    assert.equal(gas.ustawCodziennyImportBusinessProfile(), true);
    gas.ustawCodziennyImportBusinessProfile();
    const mine = gas.$triggers.filter(t => t.getHandlerFunction() === 'importBusinessProfileTrigger');
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].$spec.everyDays, mine[0].$spec.atHour], [1, 7]);
    assert.match(gas.$alerts[1][0], /ok\. 7:00/);
  });

  test('zadanie jest w rejestrze jako opcjonalne, z wpisem w IMPORT LOG', () => {
    const job = plain(project().scheduledJob_('GBP'));
    assert.equal(job.handler, 'importBusinessProfileTrigger');
    assert.equal(job.optional, true);
    assert.equal(job.log, true);
  });
});

describe('#123: manifest', () => {
  test('appsscript.json zawiera zakres Business Profile', () => {
    // Bez zakresu import pada dopiero na pierwszym żądaniu do API, więc
    // usunięcie go z manifestu ma paść tutaj, a nie na produkcji.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
    assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/business.manage'));
  });
});
