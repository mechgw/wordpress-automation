'use strict';

/**
 * #281: zero wierszy po uzupełnieniu luki nie zamyka incydentu.
 *
 * Przebieg uzupełniający lukę (zakres 2 dni i więcej) jest oceniany w osobnym
 * profilu. 4.10.2026 profil dwudniowy nie miał próbek, zero wierszy przeszło bez
 * alarmu i incydent z 3.10 zamknął się mailem "Dane wróciły do normy" z
 * "Wiersze: 0". Numeracja odpowiada macierzy z #281.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const OPEN = '[wordpress-automation] UWAGA, mało danych: Search Console (GSC)';
const CLOSED = '[wordpress-automation] Dane wróciły do normy: Search Console (GSC)';
const ZERO_ZRODLO = 'mało danych: 0 wierszy, a wcześniej to źródło zwracało dane (ostatnio 300)';

/** Projekt z kolejnymi dniami danych: `run(rows, days, trigger)` zapisuje przebieg GSC. */
function projekt() {
  const gas = loadProject({ properties: { ALERT_EMAIL: 'alerty@example.pl' } });
  let nextDay = 1;
  const day = n => new Date(Date.UTC(2026, 9, n)).toISOString().slice(0, 10);
  const run = (rows, days, trigger = true) => {
    const from = day(nextDay);
    const to = day(nextDay + days - 1);
    nextDay += days;
    return gas.recordImportRun_('GSC', trigger, () => ({ rows, days, dataFrom: from, dataTo: to, detail: rows + ' wierszy' }));
  };
  const record = () => JSON.parse(gas.$properties.LAST_IMPORT_GSC);
  const subjects = () => gas.$mails.map(m => m.subject);
  const last = () => gas.$mails[gas.$mails.length - 1];
  return { gas, run, record, subjects, last };
}

/** Osiem przebiegów dziennych z triggera po 300 wierszy. */
const zHistoria = (p, trigger = true) => { for (let i = 0; i < 8; i++) p.run(300, 1, trigger); };

describe('#281: zero wierszy w profilu bez próbek', () => {
  test('1: przebieg 2-dniowy z 0 wierszami po historii dziennej - anomalia, incydent otwarty, mail', () => {
    const p = projekt();
    zHistoria(p);

    p.run(0, 2);

    assert.equal(p.record().lastRun.anomaly, ZERO_ZRODLO);
    assert.equal(p.record().incident.open, true);
    assert.equal(p.record().incident.reason, 'anomaly');
    assert.deepEqual(p.subjects(), [OPEN]);
  });

  test('2: incydent otwarty zerem dziennym, potem zero dwudniowe - incydent trwa, bez maila zamknięcia', () => {
    const p = projekt();
    zHistoria(p);
    p.run(0, 1);
    assert.deepEqual(p.subjects(), [OPEN]);

    p.run(0, 2);

    assert.equal(p.record().incident.open, true);
    assert.deepEqual(p.subjects(), [OPEN], 'ani drugiego maila otwarcia, ani zamknięcia');
  });

  test('3: brak jakiejkolwiek historii z danymi - zero bez alarmu (start)', () => {
    const p = projekt();

    p.run(0, 3);

    assert.equal(p.record().lastRun.anomaly, undefined);
    assert.equal(p.record().incident, undefined);
    assert.deepEqual(p.subjects(), []);
  });

  test('4: incydent otwarty zerem, potem przebieg 2-dniowy z 600 wierszami (profil bez próbek) - zamknięcie, jeden mail "Wiersze: 600"', () => {
    const p = projekt();
    zHistoria(p);
    p.run(0, 1);

    p.run(600, 2);

    assert.equal(p.record().lastRun.anomaly, undefined, 'brak bazy w profilu: bez anomalii');
    assert.equal(p.record().incident.open, false);
    assert.deepEqual(p.subjects(), [OPEN, CLOSED]);
    assert.match(p.last().body, /Wiersze: 600 \(600 wierszy/);
  });

  test('4n: profil 2-dniowy z 7 próbkami po 600 - niski niezerowy wynik (200) nie zamyka incydentu', () => {
    const p = projekt();
    zHistoria(p);
    for (let i = 0; i < 7; i++) p.run(600, 2);
    p.run(0, 1);
    assert.deepEqual(p.subjects(), [OPEN]);

    p.run(200, 2);

    assert.equal(p.record().lastRun.anomaly, 'mało danych: 200 wierszy vs mediana 600');
    assert.equal(p.record().incident.open, true);
    assert.deepEqual(p.subjects(), [OPEN], 'bez maila zamknięcia');
  });

  test('5: historia z danymi tylko z przebiegów ręcznych - zero z triggera bez anomalii', () => {
    const p = projekt();
    zHistoria(p, false);

    p.run(0, 1, true);

    assert.equal(p.record().lastRun.anomaly, undefined);
    assert.equal(p.record().incident, undefined);
    assert.deepEqual(p.subjects(), []);
  });

  test('5p: ten sam typ uruchomienia, inne days, historia z danymi - anomalia "0 wierszy"', () => {
    const p = projekt();
    zHistoria(p);

    p.run(0, 2);

    assert.match(p.record().lastRun.anomaly, /^mało danych: 0 wierszy, a wcześniej to źródło zwracało dane \(ostatnio 300\)$/);
  });

  test('6: profil z danymi nadal daje dotychczasowy tekst o profilu (bez zmian)', () => {
    const p = projekt();
    p.run(500, 2);

    p.run(0, 2);

    assert.equal(p.record().lastRun.anomaly, 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 500)');
  });

  test('ostatnie dane źródła to najnowszy przebieg z wierszami, nie ostatni w kolejności tablicy', () => {
    const p = projekt();
    p.run(100, 1);
    p.run(300, 1);
    p.run(0, 3);

    assert.match(p.record().lastRun.anomaly, /\(ostatnio 300\)$/);
  });

  test('historia starsza niż okno retencji nie jest bazą dla zera', () => {
    const p = projekt();
    zHistoria(p);
    const sheet = p.gas.SpreadsheetApp.getActive().getSheetByName('IMPORT LOG');
    const stare = new p.gas.$Date(p.gas.$Date.now() - 100 * 24 * 3600 * 1000);
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setValues(Array.from({ length: sheet.getLastRow() - 1 }, () => [stare]));

    p.run(0, 2);

    assert.equal(p.record().lastRun.anomaly, undefined);
  });

  test('zakres bieżącego przebiegu jest wykluczony z bazy zera: ponowny import dnia, który dał dane, nie alarmuje', () => {
    const p = projekt();
    p.gas.recordImportRun_('GSC', true, () => ({ rows: 300, days: 1, dataFrom: '2026-10-01', dataTo: '2026-10-01' }));

    p.gas.recordImportRun_('GSC', true, () => ({ rows: 0, days: 2, dataFrom: '2026-10-01', dataTo: '2026-10-01' }));

    assert.equal(p.record().lastRun.anomaly, undefined);
  });
});
