'use strict';

/**
 * Import status (Status.gs) and its wiring into the GSC / GA4 import entry
 * points: every run leaves a record, the config cells carry a one-line status
 * readable through the Sheets API, the "Dane" menu shows the details.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';

function statusSheets() {
  return {
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

function record(gas, source) {
  const key = source === 'GSC' ? 'LAST_IMPORT_GSC' : 'LAST_IMPORT_GA4';
  return JSON.parse(gas.$properties[key]);
}

describe('Status.gs recordImportRun_', () => {
  test('a successful run stores lastRun and lastOk, writes the cell and returns the result', () => {
    const gas = loadProject({ sheets: statusSheets(), triggers: ['importDzienny'] });
    const out = gas.recordImportRun_('GSC', true, () => ({ rows: 42, detail: '42 wierszy (2026-09-03 – 2026-09-03)' }));
    assert.equal(plain(out).rows, 42);
    const rec = record(gas, 'GSC');
    assert.equal(rec.lastRun.ok, true);
    assert.equal(rec.lastRun.trigger, true);
    assert.equal(rec.lastRun.rows, 42);
    assert.equal(rec.lastRun.detail, '42 wierszy (2026-09-03 – 2026-09-03)');
    assert.deepEqual(rec.lastOk, rec.lastRun);
    assert.match(rec.lastRun.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /^AKTYWNE – ostatni import: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| 42 wierszy \(2026-09-03 – 2026-09-03\) \| trigger: TAK$/);
  });

  test('a failing run stores the error, keeps the previous lastOk, writes BŁĄD to the cell and rethrows', () => {
    const gas = loadProject({
      sheets: statusSheets(),
      properties: { LAST_IMPORT_GA4: JSON.stringify({ lastOk: { finishedAt: new Date().toISOString(), ok: true, rows: 7, detail: '', warning: '' } }) }
    });
    assert.throws(() => gas.recordImportRun_('GA4', true, () => { throw new Error('Google Analytics API HTTP 500:\nboom'); }), /HTTP 500/);
    const rec = record(gas, 'GA4');
    assert.equal(rec.lastRun.ok, false);
    assert.equal(rec.lastRun.error, 'Google Analytics API HTTP 500: boom');
    assert.equal(rec.lastOk.rows, 7, 'previous successful run preserved');
    assert.match(gas.$cell(GA4_SHEET, 'B9'), /^BŁĄD \d{4}-\d{2}-\d{2} \d{2}:\d{2}: Google Analytics API HTTP 500: boom \| ostatni poprawny import: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \| trigger: NIE$/);
  });

  test('a failing first run reports that no successful import exists yet', () => {
    const gas = loadProject({ sheets: statusSheets() });
    assert.throws(() => gas.recordImportRun_('GSC', false, () => { throw new Error('nope'); }), /nope/);
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /^NIEAKTUALNE – BŁĄD .*: nope \| brak poprawnego importu \| trigger: NIE$/);
  });

  test('a run without a summary object counts as 0 rows', () => {
    const gas = loadProject({ sheets: statusSheets() });
    gas.recordImportRun_('GSC', false, () => undefined);
    assert.equal(record(gas, 'GSC').lastOk.rows, 0);
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /\| 0 wierszy \|/);
  });

  test('unknown source is rejected', () => {
    const gas = loadProject({ sheets: statusSheets() });
    assert.throws(() => gas.recordImportRun_('ADS', false, () => ({})), /Nieznane źródło importu: ADS/);
  });
});

describe('Status.gs importStatusText_', () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const withRecord = (rec, triggers = []) => loadProject({ sheets: statusSheets(), triggers, properties: { LAST_IMPORT_GSC: JSON.stringify(rec) } });

  test('no record at all', () => {
    const gas = loadProject({ sheets: statusSheets() });
    assert.equal(gas.importStatusText_('GSC'), 'BRAK IMPORTU – uruchom import z menu | trigger: NIE');
  });

  test('malformed record behaves like no record', () => {
    const gas = loadProject({ sheets: statusSheets(), properties: { LAST_IMPORT_GSC: '{not json' } });
    assert.match(gas.importStatusText_('GSC'), /^BRAK IMPORTU/);
  });

  test('fresh success with trigger installed', () => {
    const gas = withRecord({ lastOk: { finishedAt: hoursAgo(1), ok: true, rows: 5, detail: '', warning: '' }, lastRun: { finishedAt: hoursAgo(1), ok: true } }, ['importDzienny']);
    assert.match(gas.importStatusText_('GSC'), /^AKTYWNE – ostatni import: .* \| 5 wierszy \| trigger: TAK$/);
  });

  test('detail wins over the row count and a warning is appended', () => {
    const gas = withRecord({ lastOk: { finishedAt: hoursAgo(1), ok: true, rows: 9, detail: 'landing: 4 | ads: 5', warning: 'ADS: HTTP 400' }, lastRun: { ok: true } });
    assert.match(gas.importStatusText_('GSC'), /\| landing: 4 \| ads: 5 \| UWAGA: ADS: HTTP 400 \| trigger: NIE$/);
  });

  test('a partial record with a successful lastRun but no lastOk still renders', () => {
    const gas = withRecord({ lastRun: { finishedAt: hoursAgo(2), ok: true, rows: 11 } });
    assert.match(gas.importStatusText_('GSC'), /^AKTYWNE – ostatni import: .* \| 11 wierszy \| trigger: NIE$/);
    assert.doesNotThrow(() => gas.showImportStatus());
  });

  test('older than the staleness window is flagged NIEAKTUALNE', () => {
    const gas = withRecord({ lastOk: { finishedAt: hoursAgo(40), ok: true, rows: 5, detail: '', warning: '' }, lastRun: { ok: true } }, ['importDzienny']);
    assert.match(gas.importStatusText_('GSC'), /^NIEAKTUALNE – ostatni import: .* \| 5 wierszy \| trigger: TAK$/);
  });

  test('exactly at the window edge is still fresh, one second later is stale', () => {
    const gas = loadProject({ sheets: statusSheets() });
    const edge = gas.$get('IMPORT_STALE_AFTER_HOURS') * 3600 * 1000;
    const now = new gas.$Date(2026, 8, 5, 12, 0, 0);
    const okAt = { finishedAt: new Date(now.getTime() - edge).toISOString() };
    assert.equal(gas.isImportStale_(okAt, now), false);
    assert.equal(gas.isImportStale_({ finishedAt: new Date(now.getTime() - edge - 1000).toISOString() }, now), true);
    assert.equal(gas.isImportStale_({ finishedAt: new Date(now.getTime() + 60000).toISOString() }, now), true, 'a future timestamp is not trusted');
    assert.equal(gas.isImportStale_(null, now), true);
  });

  test('failed run after an old success combines both flags', () => {
    const gas = withRecord({ lastOk: { finishedAt: hoursAgo(50), ok: true, rows: 5 }, lastRun: { finishedAt: hoursAgo(1), ok: false, error: 'timeout' } });
    assert.match(gas.importStatusText_('GSC'), /^NIEAKTUALNE – BŁĄD .*: timeout \| ostatni poprawny import: .* \| trigger: NIE$/);
  });

  test('invalid timestamps render as ? instead of throwing', () => {
    const gas = withRecord({ lastOk: { finishedAt: 'garbage', ok: true, rows: 1 }, lastRun: { ok: true } });
    assert.match(gas.importStatusText_('GSC'), /ostatni import: \? \|/);
  });
});

describe('Status.gs cells, menu and dialog', () => {
  test('writeImportStatusCell_ skips silently when the config sheet is missing', () => {
    const gas = loadProject({ sheets: {} });
    assert.equal(gas.writeImportStatusCell_('GSC'), '');
  });

  test('refreshImportStatusCells writes both cells and returns their texts', () => {
    const gas = loadProject({ sheets: statusSheets(), triggers: ['importGA4Dzienny'] });
    const texts = gas.refreshImportStatusCells();
    assert.equal(texts.length, 2);
    assert.equal(gas.$cell(GSC_SHEET, 'B8'), 'BRAK IMPORTU – uruchom import z menu | trigger: NIE');
    assert.equal(gas.$cell(GA4_SHEET, 'B9'), 'BRAK IMPORTU – uruchom import z menu | trigger: TAK');
  });

  test('onOpen adds the Dane menu with both items', () => {
    const gas = loadProject({ sheets: statusSheets() });
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.ok(dane, 'Dane menu present');
    assert.deepEqual(dane.items.map(i => i.fn), ['showImportStatus', 'refreshImportStatusCells']);
    assert.deepEqual(gas.$menus.map(m => m.title), ['SEO / GSC', 'GA4 / Ads', 'WordPress', 'Dane', 'dev']);
  });

  test('showImportStatus lists both sources with schedule, last run and the staleness rule', () => {
    const gas = loadProject({
      sheets: statusSheets(),
      triggers: ['importDzienny'],
      properties: { LAST_IMPORT_GSC: JSON.stringify({ lastOk: { finishedAt: new Date().toISOString(), ok: true, rows: 3 }, lastRun: { finishedAt: new Date().toISOString(), ok: true, trigger: true, durationMs: 4200 } }) }
    });
    gas.showImportStatus();
    const text = gas.$alerts[0][0];
    assert.match(text, /^Search Console \(GSC\)\n {2}AKTYWNE – ostatni import: .* \| 3 wierszy \| trigger: TAK\n {2}Harmonogram: codziennie ok\. 05:00 \(Konfiguracja GSC!B8\)\n {2}Ostatnie uruchomienie: .* \| OK \| trigger \| 4 s\n/);
    assert.match(text, /Google Analytics 4 \(GA4\)\n {2}BRAK IMPORTU – uruchom import z menu \| trigger: NIE\n {2}Harmonogram: codziennie ok\. 06:00 \(Konfiguracja GA4!B9\)\n/);
    assert.match(text, /nieaktualne po 36 h/);
  });
});

describe('Status.gs trigger installers refresh the cells', () => {
  test('ustawAutomatycznyImport installs a daily 05:00 trigger, replaces an old one and shows trigger: TAK', () => {
    const gas = loadProject({ sheets: statusSheets(), triggers: ['importDzienny', 'importGA4Dzienny'] });
    gas.ustawAutomatycznyImport();
    const handlers = gas.$triggers.map(t => t.getHandlerFunction());
    assert.deepEqual(handlers.sort(), ['importDzienny', 'importGA4Dzienny']);
    const created = gas.$triggers.find(t => t.$spec);
    assert.deepEqual(created.$spec, { handler: 'importDzienny', everyDays: 1, atHour: 5 });
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /\| trigger: TAK$/);
    assert.equal(gas.$alerts[0][0], 'Codzienny import został ustawiony.');
  });

  test('ustawAutomatycznyImportGA4 installs a daily 06:00 trigger and writes the status cell', () => {
    const gas = loadProject({ sheets: statusSheets() });
    gas.ustawAutomatycznyImportGA4();
    assert.deepEqual(gas.$triggers[0].$spec, { handler: 'importGA4Dzienny', everyDays: 1, atHour: 6 });
    assert.equal(gas.$cell(GA4_SHEET, 'B9'), 'BRAK IMPORTU – uruchom import z menu | trigger: TAK');
  });
});

/** yyyy-MM-dd of (today - days) in local time, matching the sources' formatting. */
function localDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('Kod.gs GSC import end to end', () => {
  const gscRows = [
    { keys: ['2026-09-03', 'kurier', '/oferta', 'pol', 'MOBILE'], clicks: 3, impressions: 40, ctr: 0.075, position: 4.2 },
    { keys: ['2026-09-03', 'przesyłka', '/cennik', 'pol', 'DESKTOP'], clicks: 1, impressions: 10, ctr: 0.1, position: 8 }
  ];

  function project(extraRaw = []) {
    const sheets = statusSheets();
    sheets['GSC RAW'] = [['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded']].concat(extraRaw);
    return loadProject({ sheets, fetch: () => ({ code: 200, json: { rows: gscRows } }) });
  }

  test('importDzienny fetches one day, replaces that day in GSC RAW, records the run and writes B8', () => {
    const day = localDate(2);
    const keep = [localDate(10), 'old', '/x', 'pol', 'MOBILE', 1, 1, 0.1, 1, ''];
    const replaced = [day, 'stale', '/y', 'pol', 'MOBILE', 9, 9, 0.9, 9, ''];
    const gas = project([keep, replaced]);

    const out = gas.importDzienny();

    const payload = JSON.parse(gas.$fetchCalls[0].params.payload);
    assert.match(gas.$fetchCalls[0].url, /webmasters\/v3\/sites\/https%3A%2F%2Fwww\.example\.pl%2F\/searchAnalytics\/query$/);
    assert.deepEqual([payload.startDate, payload.endDate], [day, day]);
    assert.deepEqual(payload.dimensions, ['date', 'query', 'page', 'country', 'device']);
    assert.equal(payload.rowLimit, 100);
    assert.equal(gas.$fetchCalls[0].params.headers.Authorization, 'Bearer test-token');

    const raw = gas.$sheet('GSC RAW');
    assert.equal(raw.length, 4, 'header + kept row + 2 imported rows');
    assert.equal(raw[1][1], 'old', 'row outside the imported day kept');
    assert.deepEqual(raw[2].slice(0, 9), ['2026-09-03', 'kurier', '/oferta', 'pol', 'MOBILE', 3, 40, 0.075, 4.2]);
    assert.equal(raw.some(r => r[1] === 'stale'), false, 'row inside the imported day replaced');

    assert.equal(plain(out).rows, 2);
    const rec = record(gas, 'GSC');
    assert.equal(rec.lastOk.trigger, true);
    assert.equal(rec.lastOk.detail, `2 wierszy (${day} – ${day})`);
    assert.match(gas.$cell(GSC_SHEET, 'B8'), new RegExp(`^AKTYWNE – ostatni import: .* \\| 2 wierszy \\(${day} – ${day}\\) \\| trigger: NIE$`));
  });

  test('importOstatniZakres covers daysBack days ending at the lag and is recorded as manual', () => {
    const gas = project();
    gas.importOstatniZakres();
    const payload = JSON.parse(gas.$fetchCalls[0].params.payload);
    assert.deepEqual([payload.startDate, payload.endDate], [localDate(4), localDate(2)]);
    assert.equal(record(gas, 'GSC').lastOk.trigger, false);
  });

  test('an API failure is recorded, surfaces in B8 and is rethrown', () => {
    const sheets = statusSheets();
    sheets['GSC RAW'] = [['date']];
    const gas = loadProject({ sheets, fetch: () => ({ code: 403, text: 'quota' }) });
    assert.throws(() => gas.importDzienny(), /Search Console API HTTP 403/);
    assert.equal(record(gas, 'GSC').lastRun.ok, false);
    assert.match(gas.$cell(GSC_SHEET, 'B8'), /^NIEAKTUALNE – BŁĄD .*Search Console API HTTP 403: quota \| brak poprawnego importu/);
  });
});

describe('GA4.gs import end to end', () => {
  const row = (dims, metrics) => ({ dimensionValues: dims.map(v => ({ value: v })), metricValues: metrics.map(v => ({ value: v })) });
  const reportByDims = (url, params) => {
    const dims = JSON.parse(params.payload).dimensions.map(d => d.name);
    if (dims.includes('sessionGoogleAdsCampaignName')) return { code: 400, text: 'ads dims not allowed' };
    if (dims.includes('eventName') && dims.includes('landingPagePlusQueryString')) return { code: 400, text: 'incompatible' };
    if (dims.includes('eventName')) {
      return { code: 200, json: { rows: [row(['20260903', 'phone_click', 'Organic Search', 'google / organic'], ['2', '2'])], rowCount: 1 } };
    }
    return { code: 200, json: { rows: [row(['20260903', '/oferta?utm=x', 'Organic Search', 'google / organic', '(not set)', 'mobile'], ['10', '8', '9', '1', '0.1'])], rowCount: 1 } };
  };

  function project() {
    const sheets = statusSheets();
    for (const name of ['GA4 RAW', 'GA4 KEY EVENTS', 'GA4 BUSINESS EVENTS', 'GA4 ADS RAW']) sheets[name] = [['header']];
    return loadProject({ sheets, fetch: fetchRouter([[':runReport', reportByDims]]) });
  }

  test('importGA4Dzienny imports one day into all four sheets, falls back for business events, degrades Ads to a warning', () => {
    const gas = project();
    const out = gas.importGA4Dzienny();

    const reports = gas.$fetchCalls.filter(c => c.url.includes(':runReport')).map(c => JSON.parse(c.params.payload));
    assert.equal(reports.length, 5, 'landing, key events, business (detailed, fallback), ads');
    const day = localDate(2);
    assert.deepEqual(reports[0].dateRanges, [{ startDate: day, endDate: day }]);

    assert.equal(gas.$sheet('GA4 RAW').length, 2);
    assert.equal(gas.$sheet('GA4 RAW')[1][1], '/oferta', 'query string stripped from landing page');
    assert.equal(gas.$sheet('GA4 KEY EVENTS').length, 2);
    assert.deepEqual(gas.$sheet('GA4 BUSINESS EVENTS')[1].slice(1, 3), ['phone_click', ''], 'fallback rows have no landing page');
    assert.equal(gas.$sheet('GA4 ADS RAW').length, 1, 'no ads rows');

    assert.equal(plain(out).rows, 3);
    assert.equal(plain(out).detail, 'landing: 1 | key events: 1 | business: 1 | ads: 0');
    assert.match(plain(out).warning, /^ADS: Google Analytics API HTTP 400: ads dims not allowed$/);
    assert.match(gas.$cell(GA4_SHEET, 'B9'), /^AKTYWNE – ostatni import: .* \| landing: 1 \| key events: 1 \| business: 1 \| ads: 0 \| UWAGA: ADS: Google Analytics API HTTP 400: ads dims not allowed \| trigger: NIE$/);
    assert.equal(gas.$cell(GA4_SHEET, 'A11'), 'businessEventsSheet', 'config row added by ensureGa4BusinessSheet_');
  });

  test('importGA4OstatniZakres spans daysBack days and is recorded as manual', () => {
    const gas = project();
    gas.importGA4OstatniZakres();
    const first = JSON.parse(gas.$fetchCalls.find(c => c.url.includes(':runReport')).params.payload);
    assert.deepEqual(first.dateRanges, [{ startDate: localDate(4), endDate: localDate(2) }]);
    assert.equal(record(gas, 'GA4').lastOk.trigger, false);
  });

  test('a missing propertyId is recorded as a failed run', () => {
    const sheets = statusSheets();
    sheets[GA4_SHEET][1][1] = '';
    const gas = loadProject({ sheets });
    assert.throws(() => gas.importGA4Dzienny(), /Brak propertyId/);
    assert.match(gas.$cell(GA4_SHEET, 'B9'), /^NIEAKTUALNE – BŁĄD .*Brak propertyId/);
  });
});
