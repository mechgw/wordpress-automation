'use strict';

/**
 * #46 krok 1: eksperyment zgodności raportu kosztów Ads w GA4 Data API
 * (checkCompatibility + próbka runReport), tylko odczyt.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GA4_SHEET = 'Konfiguracja GA4';
const SHEET = 'ADS EKSPERYMENT';
const HEADER = ['Czas', 'Wariant', 'Pole', 'Rodzaj', 'Zgodność', 'Uwagi'];
const METRICS = ['advertiserAdCost', 'advertiserAdClicks', 'advertiserAdImpressions'];

function sheets() {
  return {
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

/**
 * Odpowiedź checkCompatibility jak w prawdziwym API: opisuje CAŁY schemat
 * (tu: żądane pola plus niezwiązane, niezgodne pola schematu), nie tylko pola
 * z żądania. Żądane pola są zgodne poza tymi z `incompatible`.
 */
function compat(incompatible = []) {
  return (url, params) => {
    const req = JSON.parse(params.payload);
    return {
      code: 200,
      json: {
        dimensionCompatibilities: req.dimensions.map(d => ({ dimensionMetadata: { apiName: d.name }, compatibility: incompatible.includes(d.name) ? 'INCOMPATIBLE' : 'COMPATIBLE' }))
          .concat([{ dimensionMetadata: { apiName: 'city' }, compatibility: 'INCOMPATIBLE' }, { dimensionMetadata: { apiName: 'sessionSource' }, compatibility: 'INCOMPATIBLE' }]),
        metricCompatibilities: req.metrics.map(m => ({ metricMetadata: { apiName: m.name }, compatibility: incompatible.includes(m.name) ? 'INCOMPATIBLE' : 'COMPATIBLE' }))
          .concat([{ metricMetadata: { apiName: 'sessions' }, compatibility: 'INCOMPATIBLE' }])
      }
    };
  };
}

/** runReport: strona wierszy (do limitu) plus TOTAL po wszystkich wierszach, jak w API. */
function report(rows, opts = {}) {
  return (url, params) => {
    const req = JSON.parse(params.payload);
    const page = rows.slice(0, req.limit);
    const json = {
      rowCount: rows.length,
      rows: page.map(r => ({
        dimensionValues: req.dimensions.map((_, i) => ({ value: String(r[i]) })),
        metricValues: METRICS.map((_, i) => ({ value: String(r[req.dimensions.length + i]) }))
      }))
    };
    if (!opts.noTotals) {
      json.totals = [{ metricValues: METRICS.map((_, i) => ({ value: String(rows.reduce((s, r) => s + Number(r[req.dimensions.length + i]), 0)) })) }];
    }
    return { code: 200, json };
  };
}

const project = (routes, opts = {}) => loadProject(Object.assign({ sheets: sheets(), fetch: fetchRouter(routes) }, opts));

describe('eksperyment kosztów Ads', () => {
  test('wszystko zgodne na poziomie słowa kluczowego → jedno checkCompatibility, próbka runReport, rekomendacja GA4', () => {
    const gas = project([
      [':checkCompatibility', compat()],
      [':runReport', report([['20260901', '1', 'Brand', '11', 'Grupa A', 'kurier warszawa', '12.5', '30', '900'], ['20260902', '1', 'Brand', '11', 'Grupa A', 'kurier', '7.25', '10', '300']])]
    ]);
    const out = plain(gas.eksperymentKosztyAds());
    assert.equal(out.winner.variant, 'słowo kluczowe');
    assert.equal(out.results.length, 1, 'stops at the first compatible variant');
    assert.deepEqual(out.winner.sample.rowCount, 2);
    assert.equal(out.winner.sample.cost, 19.75);
    assert.equal(out.winner.fields.length, 9, 'only the 6 requested dimensions and 3 metrics, unrelated schema fields ignored');
    assert.ok(!out.winner.fields.some(f => f.name === 'city' || f.name === 'sessions'));

    const check = gas.$fetchCalls[0];
    assert.match(check.url, /analyticsdata\.googleapis\.com\/v1beta\/properties\/111:checkCompatibility$/);
    assert.deepEqual(JSON.parse(check.params.payload), {
      dimensions: ['date', 'googleAdsCampaignId', 'googleAdsCampaignName', 'googleAdsAdGroupId', 'googleAdsAdGroupName', 'googleAdsKeyword'].map(name => ({ name })),
      metrics: METRICS.map(name => ({ name }))
    });
    const sample = JSON.parse(gas.$fetchCalls[1].params.payload);
    assert.equal(sample.limit, 20);
    assert.deepEqual(sample.metricAggregations, ['TOTAL']);
    assert.match(sample.dateRanges[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(sample.dimensions.length, 6);

    const text = gas.$alerts[0][0];
    assert.match(text, /^Eksperyment #46: koszty Google Ads z GA4 Data API \(właściwość 111\)\n\n- słowo kluczowe: ZGODNE\n\nPróbka \(\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}\): 2 wierszy, koszt łącznie \(TOTAL z API\) 19\.75\.\nRekomendacja: krok 2 na GA4 Data API, poziom „słowo kluczowe”; Google Ads API i developer token nie są potrzebne\./);

    const grid = plain(gas.$sheet(SHEET));
    assert.deepEqual(grid[0], HEADER);
    assert.deepEqual(grid[1].slice(1, 5), ['słowo kluczowe', 'date', 'wymiar', 'COMPATIBLE']);
    assert.deepEqual(grid[9].slice(1, 5), ['słowo kluczowe', 'advertiserAdImpressions', 'metryka', 'COMPATIBLE']);
    assert.equal(grid[10][2], '(runReport)');
    assert.match(grid[10][5], /wiersze: 2 \| koszt łącznie \(TOTAL z API\): 19\.75$/);
    assert.equal(grid[11][2], '(wiersz)');
    assert.equal(grid[11][5], '20260901 | 1 | Brand | 11 | Grupa A | kurier warszawa | 12.5 | 30 | 900');
  });

  test('słowo kluczowe niezgodne → drugi wariant (grupa reklam) zgodny; okno wymienia niezgodne pola', () => {
    let calls = 0;
    const gas = project([
      [':checkCompatibility', (url, params) => { calls++; return compat(calls === 1 ? ['googleAdsKeyword', 'advertiserAdCost'] : [])(url, params); }],
      [':runReport', report([['20260901', '1', 'Brand', '11', 'Grupa A', '3', '4', '5']])]
    ]);
    const out = plain(gas.eksperymentKosztyAds());
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].compatible, false);
    assert.equal(out.winner.variant, 'grupa reklam');
    assert.match(gas.$alerts[0][0], /- słowo kluczowe: NIEZGODNE: googleAdsKeyword \(INCOMPATIBLE\), advertiserAdCost \(INCOMPATIBLE\)\n- grupa reklam: ZGODNE\n/);
    assert.match(gas.$alerts[0][0], /poziom „grupa reklam”/);
  });

  test('żaden wariant niezgodny → trzy testy, brak próbki, rekomendacja Google Ads API', () => {
    const gas = project([[':checkCompatibility', compat(['advertiserAdCost'])]]);
    const out = plain(gas.eksperymentKosztyAds());
    assert.equal(out.results.length, 3);
    assert.equal(out.winner, null);
    assert.equal(gas.$fetchCalls.length, 3, 'no runReport');
    assert.match(gas.$alerts[0][0], /Rekomendacja: żadna kombinacja nie jest zgodna w GA4 Data API; krok 2 wymaga Google Ads API do osobnego arkusza GOOGLE ADS RAW\./);
  });

  test('raport dłuższy niż limit: koszt z TOTAL po wszystkich wierszach, nie z 20-wierszowej strony; bez TOTAL koszt jawnie opisany jako próbka', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ['2026090' + (i % 7 + 1), '1', 'Brand', '11', 'Grupa A', 'kw' + i, '1.5', '1', '10']);
    const gas = project([[':checkCompatibility', compat()], [':runReport', report(rows)]]);
    const out = plain(gas.eksperymentKosztyAds());
    assert.equal(out.winner.sample.rowCount, 30);
    assert.equal(out.winner.sample.cost, 45, '30 × 1.5 from TOTAL, not 20 × 1.5');
    assert.match(gas.$alerts[0][0], /30 wierszy, koszt łącznie \(TOTAL z API\) 45\./);

    const noTotals = project([[':checkCompatibility', compat()], [':runReport', report(rows, { noTotals: true })]]);
    const out2 = plain(noTotals.eksperymentKosztyAds());
    assert.equal(out2.winner.sample.cost, 30, '20 × 1.5 of the returned page');
    assert.match(noTotals.$alerts[0][0], /30 wierszy, koszt w próbce \(20 wierszy, bez TOTAL z API\) 30\./);
  });

  test('zgodne, ale próbka pusta → rekomendacja sprawdzenia połączenia Ads z GA4; brak pola w odpowiedzi → „BRAK W ODPOWIEDZI”', () => {
    const gas = project([[':checkCompatibility', compat()], [':runReport', () => ({ code: 200, json: { rowCount: 0, rows: [] } })]]);
    gas.eksperymentKosztyAds();
    assert.match(gas.$alerts[0][0], /0 wierszy, koszt w próbce \(0 wierszy, bez TOTAL z API\) 0\.\nKombinacja zgodna, ale bez danych w próbce: sprawdź, czy konto Ads jest połączone z GA4/);

    const partial = project([
      [':checkCompatibility', () => ({ code: 200, json: { dimensionCompatibilities: [{ dimensionMetadata: { apiName: 'date' }, compatibility: 'COMPATIBLE' }], metricCompatibilities: [] } })]
    ]);
    const out = plain(partial.eksperymentKosztyAds());
    assert.equal(out.winner, null);
    const missing = out.results[0].fields.filter(f => f.compatibility === 'BRAK W ODPOWIEDZI').map(f => f.name);
    assert.ok(missing.includes('googleAdsKeyword') && missing.includes('advertiserAdCost'));
    assert.match(partial.$alerts[0][0], /googleAdsCampaignId \(BRAK W ODPOWIEDZI\)/);
  });

  test('błąd API przy checkCompatibility → wiersz BŁĄD, kolejne warianty nadal sprawdzane; błąd runReport → zapisany bez wyjątku', () => {
    let calls = 0;
    const gas = project([
      [':checkCompatibility', (url, params) => { calls++; return calls === 1 ? { code: 400, text: '{"error":{"message":"Field googleAdsKeyword is not a valid dimension."}}' } : compat()(url, params); }],
      [':runReport', () => ({ code: 429, text: 'quota' })]
    ]);
    const out = plain(gas.eksperymentKosztyAds());
    assert.match(out.results[0].error, /Google Analytics API HTTP 400/);
    assert.equal(out.winner.variant, 'grupa reklam');
    assert.match(out.winner.sampleError, /HTTP 429/);
    const grid = plain(gas.$sheet(SHEET));
    assert.deepEqual(grid[1].slice(1, 5), ['słowo kluczowe', '(zapytanie)', 'błąd API', 'BŁĄD']);
    assert.match(gas.$alerts[0][0], /- słowo kluczowe: BŁĄD API – Google Analytics API HTTP 400:/);
    assert.match(gas.$alerts[0][0], /Kombinacja zgodna, ale runReport zawiódł: Google Analytics API HTTP 429/);
  });

  test('brak propertyId → błąd przed zapytaniem; menu GA4 / Ads ma pozycję', () => {
    const s = sheets();
    s[GA4_SHEET][1] = ['propertyId', ''];
    const gas = loadProject({ sheets: s, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.eksperymentKosztyAds(), /propertyId/);
    gas.onOpen();
    const ga4 = gas.$menus.find(m => m.title === 'GA4 / Ads');
    assert.ok(ga4.items.map(i => i.fn).includes('eksperymentKosztyAds'));
  });
});
