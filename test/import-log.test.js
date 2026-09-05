'use strict';

/**
 * #43: historia runów w IMPORT LOG i wykrywanie anomalii liczby wierszy w
 * obrębie profilu źródło + typ runu + dni zakresu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const LOG = 'IMPORT LOG';
const HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];

function baseSheets() {
  return {
    [GSC_SHEET]: [['k', 'v'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['k', 'v'], ['propertyId', 'properties/111'], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

/** Wiersz historii: n dni temu, profil i liczba wierszy. */
const logRow = (daysAgo, source, type, days, rows, ok = true) =>
  [new Date(Date.now() - daysAgo * 86400000), source, type, days, ok ? 'OK' : 'BŁĄD', ok ? rows : '', 3, '', ''];

const history = (n, rows, source = 'GSC', type = 'trigger', days = 1) =>
  Array.from({ length: n }, (_, i) => logRow(n - i, source, type, days, rows));

describe('IMPORT LOG: zapis historii', () => {
  test('udany run dopisuje wiersz z profilem, wynikiem i szczegółami; arkusz powstaje sam', () => {
    const gas = loadProject({ sheets: baseSheets() });
    gas.recordImportRun_('GSC', true, () => ({ rows: 42, days: 1, detail: '42 wierszy' }));
    const log = gas.$sheet(LOG);
    assert.deepEqual(plain(log[0]), HEADER);
    const row = log[1];
    assert.ok(row[0] instanceof gas.$Date);
    assert.deepEqual(plain(row.slice(1, 9)), ['GSC', 'trigger', 1, 'OK', 42, 0, '42 wierszy', '']);
  });

  test('nieudany run dopisuje wiersz BŁĄD z komunikatem i bez liczby wierszy', () => {
    const gas = loadProject({ sheets: baseSheets() });
    assert.throws(() => gas.recordImportRun_('GA4', false, () => { throw new Error('HTTP 500'); }), /HTTP 500/);
    const row = gas.$sheet(LOG)[1];
    assert.deepEqual(plain(row.slice(1, 9)), ['GA4', 'ręczny', 0, 'BŁĄD', '', 0, '', 'HTTP 500']);
  });

  test('istniejący arkusz nie jest nadpisywany, wiersze są dopisywane chronologicznie', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, logRow(1, 'GSC', 'trigger', 1, 10)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 11, days: 1 }));
    assert.equal(gas.$sheet(LOG).length, 3);
    assert.equal(gas.$sheet(LOG)[2][5], 11);
  });

  test('retencja usuwa wpisy starsze niż 90 dni, zostawia nowsze', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, logRow(120, 'GSC', 'trigger', 1, 5), logRow(95, 'GSC', 'trigger', 1, 5), logRow(30, 'GSC', 'trigger', 1, 5)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 5, days: 1 }));
    const rows = gas.$sheet(LOG).slice(1);
    assert.equal(rows.length, 2, 'two old rows pruned, recent one and the new one kept');
  });

  test('importy przekazują liczbę dni zakresu do historii', () => {
    const sheets = baseSheets();
    sheets['GSC RAW'] = [['date']];
    const gas = loadProject({ sheets, fetch: () => ({ code: 200, json: { rows: [] } }) });
    gas.importOstatniZakres();
    assert.equal(gas.$sheet(LOG)[1][3], 3, 'daysBack = 3');
    gas.importDzienny();
    assert.equal(gas.$sheet(LOG)[2][3], 1);
  });
});

describe('IMPORT LOG: anomalie', () => {
  test('poniżej 7 runów w profilu nie ma alarmu, nawet przy 0 wierszy', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(6, 300)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 1 }));
    assert.equal(JSON.parse(gas.$properties.LAST_IMPORT_GSC).lastRun.anomaly, undefined);
    assert.doesNotMatch(gas.$cell(GSC_SHEET, 'B8'), /UWAGA/);
  });

  test('0 wierszy przy medianie > 0 → UWAGA w rekordzie, komórce i historii', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 1, detail: '0 wierszy' }));
    const run = JSON.parse(gas.$properties.LAST_IMPORT_GSC).lastRun;
    assert.equal(run.anomaly, 'mało danych: 0 wierszy vs mediana 300');
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /\| 0 wierszy \| UWAGA: mało danych: 0 wierszy vs mediana 300 \|/);
    assert.equal(gas.$sheet(LOG).slice(-1)[0][8], 'mało danych: 0 wierszy vs mediana 300');
  });

  test('spadek poniżej połowy mediany → UWAGA; powyżej połowy → cisza', () => {
    let sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300)];
    let gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 149, days: 1 }));
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /UWAGA: mało danych: 149 wierszy vs mediana 300/);

    sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300)];
    gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 150, days: 1 }));
    assert.doesNotMatch(gas.$cell(GSC_SHEET, 'B8'), /UWAGA/);
  });

  test('mediana liczona z ostatnich 7 udanych runów, nieudane pomijane', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(3, 1000), ...history(7, 300), logRow(0.5, 'GSC', 'trigger', 1, 0, false)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 100, days: 1 }));
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /vs mediana 300/, 'older 1000-row runs fall outside the last 7');
  });

  test('profile są rozłączne: ręczny import 90 dni nie zaburza mediany triggera 1 dnia i odwrotnie', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300, 'GSC', 'trigger', 1), ...history(7, 20000, 'GSC', 'ręczny', 90)];
    let gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', false, () => ({ rows: 19000, days: 90 }));
    assert.doesNotMatch(gas.$cell(GSC_SHEET, 'B8'), /UWAGA/, 'manual 90-day run compared with manual 90-day history');

    gas = loadProject({ sheets: JSON.parse(JSON.stringify(sheets), (k, v) => (k === '0' && typeof v === 'string' && /^\d{4}-/.test(v) ? new Date(v) : v)) });
    gas.recordImportRun_('GSC', true, () => ({ rows: 300, days: 1 }));
    assert.doesNotMatch(gas.$cell(GSC_SHEET, 'B8'), /UWAGA/, 'trigger 1-day run compared with its own profile');
  });

  test('inne źródło z tym samym profilem nie wpływa na ocenę', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300, 'GA4', 'trigger', 1)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 1 }));
    assert.doesNotMatch(gas.$cell(GSC_SHEET, 'B8'), /UWAGA/);
  });

  test('istniejące ostrzeżenie (np. Ads) i anomalia są łączone', () => {
    const sheets = baseSheets();
    sheets[LOG] = [HEADER, ...history(7, 300, 'GA4', 'trigger', 1)];
    const gas = loadProject({ sheets });
    gas.recordImportRun_('GA4', true, () => ({ rows: 10, days: 1, warning: 'ADS: HTTP 400' }));
    assert.match(gas.$cell(GA4_SHEET, 'B9'), /UWAGA: ADS: HTTP 400 \| mało danych: 10 wierszy vs mediana 300/);
  });

  test('medianOf_ dla parzystej i nieparzystej liczby', () => {
    const gas = loadProject();
    assert.equal(gas.medianOf_([5, 1, 3]), 3);
    assert.equal(gas.medianOf_([4, 1, 3, 2]), 2.5);
  });
});
