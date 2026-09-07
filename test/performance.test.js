'use strict';

/**
 * #124: pomiar wydajności z CrUX i PageSpeed Insights.
 *
 * Dwie rzeczy są tu najważniejsze i mają najwięcej testów: brak danych
 * terenowych nie może stać się zerem, bo zero znaczy wynik doskonały, oraz
 * pomiar laboratoryjny musi zapisywać każdą próbę osobno, bo Lighthouse jest
 * zmienny i pojedynczy wynik nie jest dowodem regresji.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FIELD = 'CWV FIELD';
const LAB = 'PAGESPEED LAB';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano'];

const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };

const cruxRecord = (p75 = { largest_contentful_paint: 2100, interaction_to_next_paint: 180, cumulative_layout_shift: 0.05 }) => ({
  record: {
    collectionPeriod: { lastDate: { year: 2026, month: 9, day: 1 } },
    metrics: Object.keys(p75).reduce((acc, name) => {
      acc[name] = { percentiles: { p75: p75[name] } };
      return acc;
    }, {})
  }
});

const psiResponse = (lcp = 2500) => ({
  lighthouseResult: {
    categories: { performance: { score: 0.87 } },
    audits: {
      'largest-contentful-paint': { numericValue: lcp },
      'cumulative-layout-shift': { numericValue: 0.02 },
      'total-blocking-time': { numericValue: 120 },
      'first-contentful-paint': { numericValue: 900 },
      'speed-index': { numericValue: 1800 },
      'server-response-time': { numericValue: 210 },
      'total-byte-weight': { numericValue: 1500000 }
    }
  }
});

function project({ urls = [[URL, 'homepage', '']], properties = KEY, fetch } = {}) {
  return loadProject({
    properties: properties,
    sheets: { [URLS]: [URLS_HEADER, ...urls] },
    fetch: fetch || (() => ({ code: 200, text: '{}' }))
  });
}

describe('#124: konfiguracja', () => {
  test('brak klucza mówi, co utworzyć i że OAuth nie jest potrzebny', () => {
    assert.throws(
      () => project({ properties: {} }).performanceApiKey_(),
      /Brak Script Property: PAGESPEED_API_KEY.*OAuth nie jest potrzebny/s
    );
  });

  test('stan konfiguracji da się sprawdzić bez wyjątku', () => {
    assert.equal(project().isPerformanceConfigured_(), true);
    assert.equal(project({ properties: {} }).isPerformanceConfigured_(), false);
  });

  test('adresy pochodzą z arkusza, a wpisy bez protokołu są pomijane', () => {
    const gas = project({ urls: [[URL, 'homepage', ''], ['www.example.pl', 'bez protokołu', ''], ['', '', '']] });
    const urls = plain(gas.performanceUrls_());
    assert.deepEqual(urls, [{ url: URL, role: 'homepage' }]);
  });
});

describe('#124: dane terenowe z CrUX', () => {
  test('zapisuje p75 dla każdej metryki i obu form factorów', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) }) });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.rows, 6, 'trzy metryki razy dwa form factory');
    const rows = gas.$sheet(FIELD).slice(1);
    const phone = rows.filter(r => r[2] === 'PHONE');
    assert.equal(phone.length, 3);
    assert.equal(phone[0][0], '2026-09-01', 'okres zbiorczy zapisany');
    assert.equal(phone[0][5], 'OK');
    assert.equal(phone[0][6], 'CRUX');
  });

  test('brak danych dla adresu to INSUFFICIENT_DATA, nigdy zero', () => {
    // 404 z CrUX znaczy „za mało ruchu”, a nie awarię. Zero znaczyłoby wynik
    // doskonały, czyli dokładnie odwrotność prawdy.
    const gas = project({ fetch: () => ({ code: 404, text: '{}' }) });
    const out = plain(gas.runCruxMeasurement_());
    assert.equal(out.missing, 2, 'oba form factory bez danych');
    const rows = gas.$sheet(FIELD).slice(1);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][4], '', 'pusta wartość, nie zero');
    assert.equal(rows[0][5], 'INSUFFICIENT_DATA');
  });

  test('brak pojedynczej metryki też jest oznaczony, a nie zerowany', () => {
    const partial = cruxRecord({ largest_contentful_paint: 2100 });
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(partial) }) });
    gas.runCruxMeasurement_();
    const rows = gas.$sheet(FIELD).slice(1).filter(r => r[2] === 'PHONE');
    const byMetric = {};
    rows.forEach(r => { byMetric[r[3]] = r; });
    assert.equal(byMetric.largest_contentful_paint[5], 'OK');
    assert.equal(byMetric.cumulative_layout_shift[5], 'INSUFFICIENT_DATA');
    assert.equal(byMetric.cumulative_layout_shift[4], '');
  });

  test('ponowny pomiar tego samego okresu nie dubluje wierszy', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) }) });
    gas.runCruxMeasurement_();
    gas.runCruxMeasurement_();
    assert.equal(gas.$sheet(FIELD).slice(1).length, 6, 'sześć wierszy, nie dwanaście');
  });

  test('historia wcześniejszych okresów zostaje', () => {
    const gas = project({
      fetch: () => ({ code: 200, text: JSON.stringify(cruxRecord()) })
    });
    gas.runCruxMeasurement_();
    const older = gas.$sheet(FIELD).slice(1).map(r => r.slice());
    older.forEach(r => { r[0] = '2026-08-01'; });
    // Symulujemy wcześniejszy okres obok bieżącego.
    gas.$sheet(FIELD).push.apply(gas.$sheet(FIELD), older);
    gas.runCruxMeasurement_();
    const periods = gas.$sheet(FIELD).slice(1).map(r => r[0]);
    assert.ok(periods.indexOf('2026-08-01') >= 0, 'starszy okres nie został skasowany');
  });

  test('odmowa i limit mają osobne komunikaty', () => {
    assert.throws(() => project({ fetch: () => ({ code: 403, text: '{}' }) }).runCruxMeasurement_(), /Włącz Chrome UX Report API/);
    assert.throws(() => project({ fetch: () => ({ code: 429, text: '{}' }) }).runCruxMeasurement_(), /limit zapytań \(429\)/);
  });

  test('brak adresów nie jest błędem', () => {
    const out = plain(project({ urls: [] }).runCruxMeasurement_());
    assert.equal(out.rows, 0);
    assert.match(out.detail, /brak adresów/);
  });
});

describe('#124: dane laboratoryjne z PSI', () => {
  test('zapisuje każdą próbę osobno dla obu strategii', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) }) });
    const out = plain(gas.runPsiMeasurement_());
    const rows = gas.$sheet(LAB).slice(1);
    // Osiem metryk razy trzy próby razy dwie strategie.
    assert.equal(out.rows, 8 * 3 * 2);
    assert.deepEqual([...new Set(rows.map(r => r[3]))].sort(), [1, 2, 3], 'trzy numery prób');
    assert.deepEqual([...new Set(rows.map(r => r[2]))].sort(), ['desktop', 'mobile']);
    assert.equal(rows[0][6], 'PSI_LAB');
  });

  test('mediana jest liczona z prób, więc jeden odstający wynik nie decyduje', () => {
    const values = [2000, 9000, 2100];
    let call = 0;
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse(values[call++ % 3])) }) });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.medians.LCP, 2100, 'mediana, nie średnia i nie ostatni wynik');
  });

  test('mediana z pustej listy jest pusta, a nie zerowa', () => {
    const gas = project();
    assert.equal(gas.medianOfValues_([]), '');
    assert.equal(gas.medianOfValues_([3, 1, 2]), 2);
    assert.equal(gas.medianOfValues_([4, 1, 2, 3]), 2.5);
  });

  test('brakujący audyt jest pomijany, a nie zapisywany jako zero', () => {
    const thin = { lighthouseResult: { categories: {}, audits: { 'largest-contentful-paint': { numericValue: 2500 } } } };
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(thin) }) });
    gas.runPsiMeasurement_();
    const metrics = [...new Set(gas.$sheet(LAB).slice(1).map(r => r[4]))];
    assert.deepEqual(metrics, ['LCP'], 'tylko to, co API naprawdę zwróciło');
  });

  test('odmowa dostępu tłumaczy, które API włączyć', () => {
    assert.throws(() => project({ fetch: () => ({ code: 403, text: '{}' }) }).runPsiMeasurement_(), /PageSpeed Insights API/);
  });

  test('limit i inny błąd HTTP mają osobne komunikaty', () => {
    assert.throws(
      () => project({ fetch: () => ({ code: 429, text: '{}' }) }).runPsiMeasurement_(),
      /Przekroczony limit zapytań \(429\).*zmniejsz liczbę adresów/s
    );
    assert.throws(
      () => project({ fetch: () => ({ code: 500, text: 'awaria po stronie Google' }) }).runPsiMeasurement_(),
      /HTTP 500:[\s\S]*awaria po stronie Google/
    );
  });

  test('pusta odpowiedź nie wywraca pomiaru', () => {
    const gas = project({ fetch: () => ({ code: 200, text: '' }) });
    const out = plain(gas.runPsiMeasurement_());
    assert.equal(out.rows, 0, 'brak audytów to brak wierszy, nie wyjątek');
  });

  test('zapytanie zawiera strategię, kategorię i klucz', () => {
    const gas = project({ fetch: () => ({ code: 200, text: JSON.stringify(psiResponse()) }) });
    gas.runPsiMeasurement_();
    const urls = gas.$fetchCalls.map(c => c.url);
    assert.ok(urls.some(u => u.indexOf('strategy=mobile') > 0));
    assert.ok(urls.some(u => u.indexOf('strategy=desktop') > 0));
    assert.ok(urls.every(u => u.indexOf('key=klucz-testowy') > 0));
  });
});

describe('#124: menu', () => {
  test('przygotowanie zakłada trzy arkusze i mówi, czego brakuje', () => {
    const gas = project({ properties: {}, urls: [] });
    assert.equal(gas.przygotujPomiarWydajnosci(), false);
    assert.deepEqual(gas.$sheet(FIELD)[0], FIELD_HEADER);
    assert.deepEqual(gas.$sheet(LAB)[0], LAB_HEADER);
    const text = gas.$alerts[0][0];
    assert.match(text, /brak Script Property PAGESPEED_API_KEY/);
    assert.match(text, /Chrome UX Report API/);
    assert.match(text, /nigdy nie uśredniane w jedną liczbę/);
  });

  test('pomiar z menu podsumowuje oba źródła osobno', () => {
    const gas = project({
      fetch: url => ({ code: 200, text: JSON.stringify(String(url).indexOf('chromeuxreport') > 0 ? cruxRecord() : psiResponse()) })
    });
    gas.zmierzWydajnosc();
    const text = gas.$alerts[0][0];
    assert.match(text, /Dane terenowe \(CrUX\): 6 pomiarów terenowych/);
    assert.match(text, /Dane laboratoryjne \(PSI\): 48 pomiarów laboratoryjnych/);
    assert.match(text, /Brak danych terenowych nie jest błędem strony/);
  });

  test('pozycje są w menu SEO / GSC', () => {
    const gas = project();
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn).slice(-2), ['przygotujPomiarWydajnosci', 'zmierzWydajnosc']);
  });
});
