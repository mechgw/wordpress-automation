'use strict';

/**
 * #152: PERFORMANCE SUMMARY — historia median z surowych prób.
 *
 * Numeracja odpowiada macierzy z opisu #152. Sedno: agregat jest HISTORIĄ,
 * a nie widokiem „ostatni wynik”. Klucz zawiera `Pomiar`, więc nowy pomiar
 * dokłada wiersz zamiast nadpisywać poprzedni baseline — inaczej porównanie
 * przed/po przestałoby być możliwe, zwłaszcza po przycięciu surowych prób.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const SUMMARY = 'PERFORMANCE SUMMARY';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const SUMMARY_HEADER = ['Pomiar', 'URL', 'Strategia', 'Metryka', 'Mediana', 'Liczba prób', 'Źródło', 'Pobrano'];

const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };

const COL = { pomiar: 0, url: 1, strategy: 2, metric: 3, median: 4, count: 5 };

const psi = lcp => ({
  lighthouseResult: {
    categories: { performance: { score: 0.87 } },
    audits: { 'largest-contentful-paint': { numericValue: lcp } }
  }
});

/** Surowy wiersz `PAGESPEED LAB`, w kształcie, jaki produkuje `parsePsiRun_`. */
const lab = (pomiar, strategy, attempt, metric, value) =>
  [pomiar, URL, strategy, attempt, metric, value, 'PSI_LAB', '2026-09-12'];

const rowsOf = gas => gas.$sheet(SUMMARY).slice(1).filter(row => String(row[COL.url] || '') !== '');

function run({ fetch, urls = [[URL, 'homepage', '']] } = {}) {
  return loadProject({
    properties: KEY,
    sheets: { [URLS]: [URLS_HEADER].concat(urls) },
    fetch: fetch || (url => (String(url).indexOf('pagespeedonline') >= 0
      ? { code: 200, text: JSON.stringify(psi(2500)) }
      : { code: 404, text: '{}' }))
  });
}

describe('#152: mediana i liczba prób', () => {
  test('1: trzy udane próby dają medianę z trzech i Liczba prób = 3', () => {
    const wartosci = [3000, 1000, 2000];
    let call = 0;
    const gas = run({
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        return { code: 200, text: JSON.stringify(psi(wartosci[call++ % wartosci.length])) };
      }
    });
    gas.runPsiMeasurement_();

    const lcp = rowsOf(gas).filter(row => row[COL.metric] === 'LCP' && row[COL.strategy] === 'mobile');
    assert.equal(lcp.length, 1, 'jeden wiersz na pomiar, URL, strategię i metrykę');
    assert.equal(lcp[0][COL.median], 2000, 'mediana z 1000, 2000, 3000');
    assert.equal(lcp[0][COL.count], 3);
  });

  test('2 i 4: dwie udane próby dają medianę jako średnią dwóch środkowych', () => {
    let call = 0;
    const gas = run({
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        call++;
        // Trzecia próba każdej strategii pada; Lighthouse robi to losowo.
        if (call % 3 === 0) return { code: 500, text: 'lighthouseError' };
        return { code: 200, text: JSON.stringify(psi(call % 3 === 1 ? 2000 : 3000)) };
      }
    });
    gas.runPsiMeasurement_();

    const lcp = rowsOf(gas).filter(row => row[COL.metric] === 'LCP' && row[COL.strategy] === 'mobile');
    assert.equal(lcp[0][COL.count], 2, 'liczba prób pokazuje słabszą podstawę');
    assert.equal(lcp[0][COL.median], 2500, 'przy parzystej liczbie — średnia dwóch środkowych');
  });

  test('3: zero udanych prób nie daje wiersza — ani zera, ani pustego', () => {
    const gas = run({
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 500, text: 'lighthouseError' }
        : { code: 404, text: '{}' })
    });
    gas.runPsiMeasurement_();
    assert.deepEqual(rowsOf(gas), [], 'zero byłoby doskonałym wynikiem, a pusty wiersz — pomiarem, którego nie było');
  });

  test('7: metryka nieobecna w części prób — mediana z tych, które ją mają', () => {
    const gas = run();
    const now = '2026-09-12';
    const rows = [
      lab('2026-09-12 10:00', 'mobile', 1, 'LCP', 1000),
      lab('2026-09-12 10:00', 'mobile', 2, 'LCP', 3000),
      // Trzecia próba nie zwróciła LCP, za to zwróciła CLS.
      lab('2026-09-12 10:00', 'mobile', 3, 'CLS', 0.02)
    ];
    const out = plain(gas.psiSummaryRows_(rows, now));
    const lcp = out.find(row => row[COL.metric] === 'LCP');
    const cls = out.find(row => row[COL.metric] === 'CLS');
    assert.equal(lcp[COL.median], 2000);
    assert.equal(lcp[COL.count], 2, 'licznik jest per metryka, nie per para');
    assert.equal(cls[COL.count], 1);
  });
});

describe('#152: agregat jest historią, nie widokiem „ostatni wynik”', () => {
  test('5: ponowne przetworzenie tego samego pomiaru podmienia wiersz', () => {
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']], [SUMMARY]: [SUMMARY_HEADER] }
    });
    const rows = [lab('2026-09-12 10:00', 'mobile', 1, 'LCP', 1000)];
    const key = [0, 1, 2, 3];
    gas.upsertPerformanceRows_(SUMMARY, SUMMARY_HEADER, key, gas.psiSummaryRows_(rows, '2026-09-12'));
    gas.upsertPerformanceRows_(SUMMARY, SUMMARY_HEADER, key, gas.psiSummaryRows_(rows, '2026-09-12'));

    assert.equal(rowsOf(gas).length, 1, 'ten sam pomiar nie dubluje się');
  });

  test('6: nowy pomiar dokłada wiersz i nie rusza poprzedniego baseline’u', () => {
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']], [SUMMARY]: [SUMMARY_HEADER] }
    });
    const key = [0, 1, 2, 3];
    gas.upsertPerformanceRows_(SUMMARY, SUMMARY_HEADER, key,
      gas.psiSummaryRows_([lab('2026-09-10 08:00', 'mobile', 1, 'LCP', 9000)], '2026-09-10'));
    gas.upsertPerformanceRows_(SUMMARY, SUMMARY_HEADER, key,
      gas.psiSummaryRows_([lab('2026-09-12 10:00', 'mobile', 1, 'LCP', 2000)], '2026-09-12'));

    const rows = rowsOf(gas);
    assert.equal(rows.length, 2, 'historia median, nie nadpisanie');
    assert.deepEqual(
      rows.map(row => [row[COL.pomiar], row[COL.median]]).sort(),
      [['2026-09-10 08:00', 9000], ['2026-09-12 10:00', 2000]],
      'stary baseline przetrwał — bez niego porównanie przed/po jest niemożliwe'
    );
  });
});

describe('#152: kompletność zakresu', () => {
  test('9: przerwany przebieg daje wiersze tylko dla par przetworzonych i podaje X / Y par', () => {
    const many = [1, 2, 3, 4].map(n => ['https://www.example.pl/' + n + '/', 'landing', '']);
    let elapsed = 0;
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER].concat(many) },
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        elapsed += 30000;
        return { code: 200, text: JSON.stringify(psi(2500)) };
      }
    });
    const base = gas.$Date.now();
    gas.$Date.now = () => base + elapsed;

    const out = plain(gas.runPsiMeasurement_());
    assert.ok(out.measured < many.length, 'budżet przerwał przebieg');
    assert.equal(out.pairsExpected, many.length * 2);
    assert.equal(out.pairs, out.measured * 2, 'para na każdą strategię przetworzonego adresu');
    assert.match(out.detail, /mediany dla \d+ z \d+ par/);

    const zmierzone = [...new Set(rowsOf(gas).map(row => row[COL.url]))];
    assert.equal(zmierzone.length, out.measured, 'brak wierszy dla adresów, do których przebieg nie dotarł');
  });
});

describe('#152/Codex: kompletność liczona z median, nie z braku błędu', () => {
  test('odpowiedź 200 bez liczbowych audytów nie liczy się jako para z medianą', () => {
    // `performanceApiRequest_` toleruje pustą odpowiedź, więc próba jest „udana”,
    // ale nie powstaje z niej ani surowy wiersz, ani mediana.
    const gas = run({
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 200, text: '{}' }
        : { code: 404, text: '{}' })
    });
    const out = plain(gas.runPsiMeasurement_());

    assert.deepEqual(rowsOf(gas), [], 'brak median');
    assert.equal(out.pairs, 0, 'para bez mediany nie jest parą przetworzoną');
    assert.match(out.detail, /mediany dla 0 z 2 par/, 'komunikat nie może obiecywać median, których nie ma');
  });
});
