'use strict';

/**
 * Pozycje menu klikane ręcznie, dotąd bez testów: SEO / GSC → Sprawdź połączenie,
 * menu wersji → Szczegóły wdrożenia, GA4 / Ads → Diagnozuj zdarzenia GA4.
 * Bez nich awaria którejkolwiek wychodziła dopiero w arkuszu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const SITES = 'webmasters/v3/sites';

function gscSheets() {
  return {
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']]
  };
}

function ga4Sheets() {
  return {
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 90], ['dailyLagDays', 2], ['rowLimit', 100000], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

const cell = (gas, sheet, a1) => gas.$cell(sheet, a1);

describe('Kod.gs showDeployedVersion', () => {
  test('ostemplowany Version.gs → okno z tagiem, commitem, czasem i autorem wdrożenia', () => {
    const gas = loadProject({
      sheets: gscSheets(),
      override: { 'Version.gs': 'const DEPLOYED_VERSION = { tag: "v9.9.9", commit: "abc1234", deployedAt: "2026-09-05T09:14:42Z", deployedBy: "mechgw" };' }
    });
    gas.showDeployedVersion();
    assert.equal(gas.$alerts[0][0], [
      'Wersja: v9.9.9',
      'Commit: abc1234',
      'Wdrożono: 2026-09-05T09:14:42Z',
      'Przez: mechgw',
      '',
      'Lista wydań: https://github.com/mechgw/wordpress-automation/releases'
    ].join('\n'));
  });

  test('kod z edytora (placeholder) → okno mówi wprost, że to nie jest wdrożenie', () => {
    const gas = loadProject({ sheets: gscSheets() });
    gas.showDeployedVersion();
    const text = gas.$alerts[0][0];
    assert.match(text, /^Wersja: dev\nCommit: brak \(kod z edytora, nie z wdrożenia\)\nWdrożono: -\nPrzez: -\n/);
  });
});

describe('Kod.gs testPolaczenia', () => {
  const sites = list => fetchRouter([[SITES, { code: 200, json: list === null ? {} : { siteEntry: list } }]]);

  test('lista właściwości trafia do E1:F100 z nagłówkiem, status w B8, żądanie GET z tokenem', () => {
    const gas = loadProject({
      sheets: gscSheets(),
      fetch: sites([
        { siteUrl: 'sc-domain:example.pl', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://www.example.pl/', permissionLevel: 'siteFullUser' }
      ])
    });
    gas.testPolaczenia();

    assert.equal(cell(gas, GSC_SHEET, 'E1'), 'Dostępne właściwości GSC');
    assert.equal(cell(gas, GSC_SHEET, 'F1'), 'Uprawnienie');
    assert.equal(cell(gas, GSC_SHEET, 'E2'), 'sc-domain:example.pl');
    assert.equal(cell(gas, GSC_SHEET, 'F2'), 'siteOwner');
    assert.equal(cell(gas, GSC_SHEET, 'E3'), 'https://www.example.pl/');
    assert.equal(cell(gas, GSC_SHEET, 'F3'), 'siteFullUser');
    assert.equal(cell(gas, GSC_SHEET, 'B8'), 'POŁĄCZENIE OK');

    assert.equal(gas.$fetchCalls.length, 1);
    assert.match(gas.$fetchCalls[0].url, /^https:\/\/www\.googleapis\.com\/webmasters\/v3\/sites$/);
    assert.equal(gas.$fetchCalls[0].params.method, 'get');
    assert.equal(gas.$fetchCalls[0].params.headers.Authorization, 'Bearer test-token');
  });

  test('konto bez właściwości → nagłówek jest, wierszy nie ma, status mówi o braku', () => {
    const gas = loadProject({ sheets: gscSheets(), fetch: sites(null) });
    gas.testPolaczenia();
    assert.equal(cell(gas, GSC_SHEET, 'E1'), 'Dostępne właściwości GSC');
    assert.equal(cell(gas, GSC_SHEET, 'E2') || '', '');
    assert.equal(cell(gas, GSC_SHEET, 'B8'), 'POŁĄCZENIE OK – BRAK WŁAŚCIWOŚCI');
  });

  test('poprzednia, dłuższa lista jest czyszczona, nie nadpisywana częściowo', () => {
    const s = gscSheets();
    // Trzy stare wiersze w E:F, nowa odpowiedź ma jeden.
    s[GSC_SHEET][1] = ['siteUrl', 'https://www.example.pl/', '', '', 'stary 1', 'x'];
    s[GSC_SHEET][2] = ['daysBack', 3, '', '', 'stary 2', 'y'];
    s[GSC_SHEET][3] = ['dailyLagDays', 2, '', '', 'stary 3', 'z'];
    const gas = loadProject({ sheets: s, fetch: sites([{ siteUrl: 'sc-domain:example.pl', permissionLevel: 'siteOwner' }]) });
    gas.testPolaczenia();
    assert.equal(cell(gas, GSC_SHEET, 'E2'), 'sc-domain:example.pl');
    assert.equal(cell(gas, GSC_SHEET, 'E3'), '', 'the second stale row is gone');
    assert.equal(cell(gas, GSC_SHEET, 'E4'), '', 'the third stale row is gone');
    assert.equal(cell(gas, GSC_SHEET, 'B2'), 'https://www.example.pl/', 'configuration columns untouched');
  });

  test('błąd API jest przekazywany dalej i nie zostawia statusu OK', () => {
    const gas = loadProject({
      sheets: gscSheets(),
      fetch: fetchRouter([[SITES, { code: 403, text: '{"error":{"message":"Insufficient Permission"}}' }]])
    });
    assert.throws(() => gas.testPolaczenia(), /Search Console API HTTP 403/);
    assert.equal(cell(gas, GSC_SHEET, 'B8'), '', 'status not set to OK on failure');
  });
});

describe('GA4.gs diagnozujZdarzeniaGA4', () => {
  /** Jedna strona raportu; rowCount równy liczbie wierszy kończy stronicowanie. */
  const report = rows => fetchRouter([[':runReport', (url, params) => {
    const req = JSON.parse(params.payload);
    const page = rows.slice(req.offset, req.offset + req.limit);
    return {
      code: 200,
      json: {
        rowCount: rows.length,
        rows: page.map(r => ({ dimensionValues: [{ value: r[0] }], metricValues: [{ value: String(r[1]) }, { value: String(r[2]) }, { value: String(r[3]) }] }))
      }
    };
  }]]);

  test('wszystkie zdarzenia z 30 dni trafiają do E20:H120 z nagłówkiem, status i liczba eventów w B9', () => {
    const gas = loadProject({
      sheets: ga4Sheets(),
      fetch: report([['page_view', 1200, 0, 800], ['b2b_lead_submit', 9, 9, 9], ['scroll', 400, 0, 300]])
    });
    gas.diagnozujZdarzeniaGA4();

    assert.deepEqual(plain(gas.$sheet(GA4_SHEET)[19].slice(4, 8)), ['Zdarzenie (30d)', 'Event count', 'Key events', 'Użytkownicy']);
    assert.deepEqual(plain(gas.$sheet(GA4_SHEET)[20].slice(4, 8)), ['page_view', 1200, 0, 800]);
    assert.deepEqual(plain(gas.$sheet(GA4_SHEET)[21].slice(4, 8)), ['b2b_lead_submit', 9, 9, 9]);
    assert.deepEqual(plain(gas.$sheet(GA4_SHEET)[22].slice(4, 8)), ['scroll', 400, 0, 300]);
    assert.match(cell(gas, GA4_SHEET, 'B9'), /^DIAGNOSTYKA ZDARZEŃ OK – \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| eventy: 3$/);

    const req = JSON.parse(gas.$fetchCalls[0].params.payload);
    assert.deepEqual(req.dimensions, [{ name: 'eventName' }]);
    assert.deepEqual(req.metrics.map(m => m.name), ['eventCount', 'keyEvents', 'totalUsers']);
    assert.deepEqual(req.orderBys, [{ metric: { metricName: 'eventCount' }, desc: true }]);
    assert.equal(req.limit, 10000, 'rowLimit 100000 is capped at 10000 for the diagnostic report');
    assert.match(req.dateRanges[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(gas.$fetchCalls[0].url, /properties\/111:runReport$/);
  });

  test('zakres to 30 dni, a koniec przesuwa się razem z dailyLagDays', () => {
    const range = lag => {
      const s = ga4Sheets();
      s[GA4_SHEET][3] = ['dailyLagDays', lag];
      const gas = loadProject({ sheets: s, fetch: report([['page_view', 1, 0, 1]]) });
      gas.diagnozujZdarzeniaGA4();
      return JSON.parse(gas.$fetchCalls[0].params.payload).dateRanges[0];
    };
    const two = range(2);
    assert.equal((new Date(two.endDate) - new Date(two.startDate)) / 86400000, 29, '30 dni włącznie');
    const five = range(5);
    assert.equal((new Date(two.endDate) - new Date(five.endDate)) / 86400000, 3, 'większe opóźnienie cofa koniec zakresu');
    assert.equal((new Date(five.endDate) - new Date(five.startDate)) / 86400000, 29, 'okno zostaje 30-dniowe');
  });

  test('brak zdarzeń → nagłówek jest, wierszy nie ma, licznik zero', () => {
    const gas = loadProject({ sheets: ga4Sheets(), fetch: report([]) });
    gas.diagnozujZdarzeniaGA4();
    assert.deepEqual(plain(gas.$sheet(GA4_SHEET)[19].slice(4, 8)), ['Zdarzenie (30d)', 'Event count', 'Key events', 'Użytkownicy']);
    assert.equal((gas.$sheet(GA4_SHEET)[20] || [])[4] || '', '');
    assert.match(cell(gas, GA4_SHEET, 'B9'), /\| eventy: 0$/);
  });

  test('więcej niż 100 zdarzeń → do arkusza trafia pierwsze 100, licznik pokazuje wszystkie', () => {
    const many = Array.from({ length: 130 }, (_, i) => ['event_' + i, 130 - i, 0, 1]);
    const gas = loadProject({ sheets: ga4Sheets(), fetch: report(many) });
    gas.diagnozujZdarzeniaGA4();
    assert.equal(plain(gas.$sheet(GA4_SHEET)[20].slice(4, 5))[0], 'event_0');
    assert.equal(plain(gas.$sheet(GA4_SHEET)[119].slice(4, 5))[0], 'event_99', 'row 120 is the 100th event');
    assert.equal((gas.$sheet(GA4_SHEET)[120] || [])[4] || '', '', 'nothing written past E120');
    assert.match(cell(gas, GA4_SHEET, 'B9'), /\| eventy: 130$/);
  });

  test('stare wyniki są czyszczone przed zapisem nowych', () => {
    const s = ga4Sheets();
    for (let i = 0; i < 25; i++) s[GA4_SHEET].push([]);
    s[GA4_SHEET][24] = ['', '', '', '', 'stare zdarzenie', 1, 2, 3];
    const gas = loadProject({ sheets: s, fetch: report([['page_view', 5, 0, 5]]) });
    gas.diagnozujZdarzeniaGA4();
    assert.equal(plain(gas.$sheet(GA4_SHEET)[20].slice(4, 5))[0], 'page_view');
    assert.equal((gas.$sheet(GA4_SHEET)[24] || [])[4] || '', '', 'stale row cleared');
  });

  test('brak propertyId → jasny błąd przed jakimkolwiek zapytaniem', () => {
    const s = ga4Sheets();
    s[GA4_SHEET][1] = ['propertyId', ''];
    const gas = loadProject({ sheets: s, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.diagnozujZdarzeniaGA4(), /Brak propertyId/);
  });

  test('błąd Data API jest przekazywany dalej i nie zostawia statusu OK', () => {
    const gas = loadProject({ sheets: ga4Sheets(), fetch: fetchRouter([[':runReport', { code: 500, text: 'boom' }]]) });
    assert.throws(() => gas.diagnozujZdarzeniaGA4(), /Google Analytics API HTTP 500/);
    assert.equal(cell(gas, GA4_SHEET, 'B9'), '', 'no OK status written on failure');
    assert.equal((gas.$sheet(GA4_SHEET)[19] || [])[4] || '', '', 'no header written either: the report failed before any write');
  });
});
