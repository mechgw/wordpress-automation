'use strict';

/**
 * #221: odzysk porzuconego przebiegu usuwał znacznik `RUNNING_…`, zanim ślad
 * trafił do `IMPORT LOG`. Awaria pomiędzy (wyjątek usługi, ubicie limitem)
 * gubiła porzucony przebieg bez śladu. Teraz znacznik schodzi dopiero po
 * zapisie wiersza: w najgorszym razie powstaje duplikat, ale ślad nie ginie.
 *
 * Numeracja odpowiada macierzy z #221.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const RAW = 'GSC RAW';
const LOG = 'IMPORT LOG';
const MIN = 60 * 1000;
const NOTA = /nie zakończył się kontrolowanie — możliwe przerwanie przez limit czasu wykonania Apps Script/;
const HEADER = ['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded'];
const MAIL_GSC = '[wordpress-automation] BŁĄD importu: Search Console (GSC)';

function konfiguracja() {
  return {
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']]
  };
}

/** API GSC: jeden wiersz na każdy dzień zakresu. */
function gscApi(url, params) {
  const p = JSON.parse(params.payload);
  return { code: 200, json: { rows: [{ keys: [p.endDate, 'fraza', '/s', 'pol', 'MOBILE'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }] } };
}

const projekt = () => loadProject({
  sheets: Object.assign(konfiguracja(), { [RAW]: { rows: [HEADER] } }),
  properties: { ALERT_EMAIL: 'alerty@example.pl' },
  triggers: ['importDzienny', 'importGA4Dzienny'],
  fetch: gscApi
});

const znaczniki = gas => Object.keys(gas.$properties).filter(k => k.indexOf('RUNNING_') === 0).sort();
/** Porzucony znacznik `RUNNING_<job>_<runId>` sprzed `minut` minut; zwraca jego startedAt. */
const porzuc = (gas, job, runId, minut) => {
  const startedAt = new Date(gas.$Date.now() - minut * MIN).toISOString();
  gas.$properties['RUNNING_' + job + '_' + runId] = JSON.stringify({ job, runId, startedAt, trigger: true });
  return startedAt;
};
const logi = gas => (gas.$sheet(LOG) || []).slice(1).filter(r => String(r[1] || '') !== '');
/** Wiersze za porzucone przebiegi źródła o danym starcie. */
const wierszeZa = (gas, zrodlo, startedAt) => logi(gas).filter(r => r[1] === zrodlo && r[4] === 'BŁĄD' && NOTA.test(String(r[8])) &&
  String(r[8]).includes('start ' + gas.formatImportTime_(startedAt)));
const rekord = (gas, prop) => JSON.parse(gas.$properties[prop]);
const udany = () => ({ rows: 1, detail: 'ok' });
const mailiGsc = gas => gas.$mails.filter(m => m.subject === MAIL_GSC).length;

/** `appendImportLog_` rzuca dla wierszy, które wskaże `kiedy`; pozostałe zapisuje normalnie. */
function psujLog(gas, kiedy) {
  const oryginal = gas.appendImportLog_;
  gas.appendImportLog_ = function (source, run) {
    if (kiedy(source, run)) throw new Error('Service Spreadsheets failed');
    return oryginal.apply(this, arguments);
  };
  return () => { gas.appendImportLog_ = oryginal; };
}

describe('#221: rejestratory — znacznik schodzi po wierszu', () => {
  test('1: import GSC, wiersz A rzuca wyjątek — B pracuje, A zostaje z pierwotnym runId i startem, następny przebieg go zgłasza', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'GSC', 'A', 30);
    const przed = gas.$properties.RUNNING_GSC_A;
    const napraw = psujLog(gas, (s, run) => run.finishedAt === startA);

    const wynik = gas.importDzienny({ triggerUid: 't' });
    napraw();

    assert.equal(wynik.rows, 1, 'B wykonał pracę');
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_A']);
    assert.equal(gas.$properties.RUNNING_GSC_A, przed, 'pierwotny runId i startedAt');
    assert.doesNotMatch(String(rekord(gas, 'LAST_IMPORT_GSC').lastRun.warning), NOTA, 'bez noty o niezapisanym A');

    gas.importDzienny({ triggerUid: 't' });
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 1);
    assert.deepEqual(znaczniki(gas), []);
  });

  test('2: PERFORMANCE (log: true), wiersz A rzuca wyjątek — jak 1', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'PERFORMANCE', 'A', 30);
    const przed = gas.$properties.RUNNING_PERFORMANCE_A;
    const napraw = psujLog(gas, (s, run) => run.finishedAt === startA);
    let pracowal = false;

    gas.recordJobRun_('PERFORMANCE', true, () => { pracowal = true; return udany(); });
    napraw();

    assert.ok(pracowal);
    assert.equal(gas.$properties.RUNNING_PERFORMANCE_A, przed);
    assert.doesNotMatch(String(rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.warning), NOTA);
    gas.recordJobRun_('PERFORMANCE', true, udany);
    assert.equal(wierszeZa(gas, 'PERFORMANCE', startA).length, 1);
    assert.deepEqual(znaczniki(gas), []);
  });

  test('3: SEO_LIVE (bez log) — wiersz BŁĄD za A, znacznik usunięty po wierszu, zwykły przebieg bez wiersza', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'SEO_LIVE', 'A', 30);
    const oryginal = gas.appendImportLog_;
    let znacznikPrzyZapisie = null;
    gas.appendImportLog_ = function () {
      znacznikPrzyZapisie = 'RUNNING_SEO_LIVE_A' in gas.$properties;
      return oryginal.apply(this, arguments);
    };

    gas.recordJobRun_('SEO_LIVE', true, udany);

    assert.equal(znacznikPrzyZapisie, true, 'wiersz powstał, gdy znacznik jeszcze istniał');
    assert.deepEqual(znaczniki(gas), []);
    assert.equal(wierszeZa(gas, 'SEO_LIVE', startA).length, 1);
    assert.equal(logi(gas).length, 1, 'udany przebieg zadania bez log nie dopisuje wiersza');
    assert.match(rekord(gas, 'LAST_RUN_SEO_LIVE').lastRun.warning, NOTA, 'nota w ostrzeżeniu jak dotąd');
  });

  test('4: SEO_LIVE — A porzucony → B → C: wiersz za A przetrwał dwa nadpisania lastRun, bez duplikatu', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'SEO_LIVE', 'A', 30);
    gas.recordJobRun_('SEO_LIVE', true, udany);
    gas.recordJobRun_('SEO_LIVE', true, udany);
    gas.recordJobRun_('SEO_LIVE', true, udany);

    assert.equal(wierszeZa(gas, 'SEO_LIVE', startA).length, 1);
    assert.equal(rekord(gas, 'LAST_RUN_SEO_LIVE').lastRun.warning, '', 'lastRun już nie wspomina A');
  });

  test('5: wyjątek w startRunMarker_ — znacznik A nietknięty', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'GSC', 'A', 30);
    const przed = gas.$properties.RUNNING_GSC_A;
    gas.$faults.setProperty = name => name.indexOf('RUNNING_GSC_') === 0 && name !== 'RUNNING_GSC_A';

    assert.throws(() => gas.importDzienny({ triggerUid: 't' }), /setProperty\(RUNNING_GSC_/);
    assert.equal(gas.$properties.RUNNING_GSC_A, przed);
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 0);
  });

  test('6: awaria po wierszu A, przed usunięciem znacznika — następny przebieg dopisuje drugi wiersz, rekord się nie cofa', () => {
    const gas = projekt();
    const startA = porzuc(gas, 'GSC', 'A', 30);
    let kills = 1;
    gas.$faults.deleteProperty = name => name === 'RUNNING_GSC_A' && kills-- > 0;

    gas.importDzienny({ triggerUid: 't' });
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_A']);
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 1);

    gas.importDzienny({ triggerUid: 't' });
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 2, 'dopuszczony duplikat');
    assert.deepEqual(znaczniki(gas), []);
    const ostatni = rekord(gas, 'LAST_IMPORT_GSC').lastRun;
    assert.equal(ostatni.ok, true);
    assert.ok(Date.parse(ostatni.finishedAt) > Date.parse(startA), 'rekord to bieżący przebieg, nie porzucony');
  });

  test('8: dwa porzucone, wiersz pierwszego się nie zapisuje — drugi zgłoszony i usunięty, pierwszy czeka', () => {
    const gas = projekt();
    const start1 = porzuc(gas, 'PERFORMANCE', 'A1', 40);
    const start2 = porzuc(gas, 'PERFORMANCE', 'A2', 30);
    const napraw = psujLog(gas, (s, run) => run.finishedAt === start1);

    gas.recordJobRun_('PERFORMANCE', true, udany);
    napraw();

    assert.deepEqual(znaczniki(gas), ['RUNNING_PERFORMANCE_A1']);
    assert.equal(wierszeZa(gas, 'PERFORMANCE', start2).length, 1);
    assert.equal(wierszeZa(gas, 'PERFORMANCE', start1).length, 0);
    const warning = rekord(gas, 'LAST_RUN_PERFORMANCE').lastRun.warning;
    assert.ok(warning.includes('start ' + gas.formatImportTime_(start2)), warning);
    assert.ok(!warning.includes('start ' + gas.formatImportTime_(start1)), warning);
  });
});

describe('#221: strażnik — znacznik schodzi po incydencie', () => {
  /** Świeży udany import sprzed porzuconego: strażnik nie zgłasza nieaktualności i nadpisze rekord. */
  const swiezy = gas => {
    const run = { finishedAt: new Date(gas.$Date.now() - 20 * 60 * MIN).toISOString(), ok: true, trigger: true, rows: 5 };
    gas.$properties.LAST_IMPORT_GSC = JSON.stringify({ lastRun: run, lastOk: run });
  };

  test('7: wyjątek w appendImportLog_ (przed wysyłką) — znacznik zostaje, kolejny strażnik kończy raport, jeden mail', () => {
    const gas = projekt();
    swiezy(gas);
    const startA = porzuc(gas, 'GSC', 'A', 180);
    const napraw = psujLog(gas, (s, run) => run.finishedAt === startA);

    gas.sprawdzAktualnoscImportow();
    napraw();
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_A']);
    assert.equal(mailiGsc(gas), 0);

    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), []);
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 1);
    assert.equal(rekord(gas, 'LAST_IMPORT_GSC').lastRun.finishedAt, startA);
    assert.equal(mailiGsc(gas), 1);
  });

  test('7: wyjątek w writeJobRecord_ przed incydentem — duplikat wiersza, jeden mail', () => {
    const gas = projekt();
    swiezy(gas);
    const startA = porzuc(gas, 'GSC', 'A', 180);
    let kills = 1;
    gas.$faults.setProperty = name => name === 'LAST_IMPORT_GSC' && kills-- > 0;

    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_A']);
    assert.equal(mailiGsc(gas), 0);

    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), []);
    assert.equal(wierszeZa(gas, 'GSC', startA).length, 2, 'dopuszczony duplikat wiersza');
    assert.equal(mailiGsc(gas), 1);
  });

  test('7a: awaria po wysyłce maila, przed zapisem notifiedAt — znacznik zostaje, ponowienie wysyła drugi mail (dopuszczony duplikat)', () => {
    const gas = projekt();
    swiezy(gas);
    porzuc(gas, 'GSC', 'A', 180);
    let wyslany = false;
    let kills = 1;
    const wyslij = gas.sendIncidentOpenedAlert_;
    gas.sendIncidentOpenedAlert_ = function () {
      const out = wyslij.apply(this, arguments);
      wyslany = true;
      return out;
    };
    gas.$faults.setProperty = name => name === 'LAST_IMPORT_GSC' && wyslany && kills-- > 0;

    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), ['RUNNING_GSC_A']);
    assert.equal(mailiGsc(gas), 1);

    gas.sprawdzAktualnoscImportow();
    assert.deepEqual(znaczniki(gas), []);
    assert.equal(mailiGsc(gas), 2, 'okno wysyłka → notifiedAt: duplikat dopuszczony kontraktem #221');
  });
});
