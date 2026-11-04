'use strict';

/**
 * #229: dotknięte funkcje pętli po kolumnie A `GSC RAW` w pełni zabijają mutanty.
 *
 * Stryker (pilotaż #234) pokazał na `gscLastDataDay_`, `appendGscDays_`,
 * `replaceRange_` i `diagnozaDatGsc` zbiegłe mutanty stanu sprzed zmiany: teksty
 * etapów logu, warunki `lastRow`, położenie dopisanych wierszy, formaty liczbowe.
 * Testy używają arkusza-atrapy, który zapisuje każde wywołanie, więc sprawdzają
 * dokładne argumenty, a nie tylko wynik.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const projekt = () => loadProject({ sheets: { 'Konfiguracja GSC': [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/']] } });

/** Arkusz-atrapa: zapisuje wywołania `[metoda, ...argumenty]`. */
function arkusz({ lastRow, values = [], maxRows = 1000 }) {
  const calls = [];
  const range = args => ({
    getValues: () => { calls.push(['getValues', ...args]); return values; },
    clearContent: () => { calls.push(['clearContent', ...args]); },
    setValues: v => { calls.push(['setValues', ...args, v]); },
    setNumberFormat: f => { calls.push(['setNumberFormat', ...args, f]); }
  });
  return {
    calls,
    getLastRow: () => lastRow,
    getRange: (...args) => range(args),
    deleteRows: (...args) => { calls.push(['deleteRows', ...args]); },
    getMaxRows: () => maxRows,
    insertRowsAfter: (...args) => { calls.push(['insertRowsAfter', ...args]); }
  };
}
const kolumna = wartosci => wartosci.map(v => [v]);
const etapy = () => {
  const msgs = [];
  const stage = m => msgs.push(m);
  stage.msgs = msgs;
  return stage;
};
const metody = (sheet, nazwa) => sheet.calls.filter(c => c[0] === nazwa);

describe('#229: gscLastDataDay_', () => {
  test('brak zakładki: puste day i before, bez etapów', () => {
    const gas = projekt();
    const stage = etapy();

    assert.deepEqual(plain(gas.gscLastDataDay_(null, stage, '2026-10-03')), { day: '', before: '' });
    assert.deepEqual(stage.msgs, []);
  });

  test('zakładka z samym nagłówkiem: nic nie czyta, etapy z zerami i "brak"', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 1 });

    const out = plain(gas.gscLastDataDay_(sheet, stage, '2026-10-03'));

    assert.deepEqual(out, { day: '', before: '' });
    assert.deepEqual(sheet.calls, [], 'getRange nie jest wołany');
    assert.deepEqual(stage.msgs, [
      'odczyt kolumny A do zakresu (0 wierszy)',
      'ostatni dzień z danymi (0 wierszy, w tym 0 dat, brak)'
    ]);
  });

  test('zakładka zupełnie pusta (lastRow 0): jak nagłówek', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 0 });

    assert.deepEqual(plain(gas.gscLastDataDay_(sheet, etapy(), '2026-10-03')), { day: '', before: '' });
    assert.deepEqual(sheet.calls, []);
  });

  test('czyta kolumnę A od wiersza 2, a "before" to największa data przed celem niezależnie od kolejności', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 4, values: kolumna(['2026-10-02', '2026-10-05', '2026-09-30']) });

    const out = plain(gas.gscLastDataDay_(sheet, stage, '2026-10-03'));

    assert.deepEqual(out, { day: '2026-10-05', before: '2026-10-02' });
    assert.deepEqual(plain(metody(sheet, 'getValues')), [['getValues', 2, 1, 3, 1]]);
    assert.deepEqual(stage.msgs, [
      'odczyt kolumny A do zakresu (3 wierszy)',
      'ostatni dzień z danymi (3 wierszy, w tym 0 dat, 2026-10-05)'
    ]);
  });

  test('data równa celowi nie jest "before"', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 3, values: kolumna(['2026-10-03', '2026-10-01']) });

    assert.deepEqual(plain(gas.gscLastDataDay_(sheet, etapy(), '2026-10-03')), { day: '2026-10-03', before: '2026-10-01' });
  });

  test('tekst z prefiksem przed datą nie jest datą (regex zakotwiczony), bez wyjątku', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 4, values: kolumna(['abc2026-10-05', '2026-10-01', '2026-10-05x']) });

    assert.deepEqual(plain(gas.gscLastDataDay_(sheet, etapy(), '2026-10-03')), { day: '2026-10-01', before: '2026-10-01' });
  });

  test('kolumna bez poprawnej daty: etap kończy się słowem "brak"', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 3, values: kolumna(['notatka', '2026-02-31']) });

    assert.deepEqual(plain(gas.gscLastDataDay_(sheet, stage, '2026-10-03')), { day: '', before: '' });
    assert.equal(stage.msgs[1], 'ostatni dzień z danymi (2 wierszy, w tym 0 dat, brak)');
  });
});

describe('#229: appendGscDays_', () => {
  const nowe = [['2026-10-02', 'a', '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, ''], ['2026-10-02', 'b', '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, '']];

  test('zakładka z samym nagłówkiem i brak nowych wierszy: nic nie czyta, nic nie zapisuje, trzy etapy', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 1 });

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', [], stage);

    assert.deepEqual(sheet.calls, []);
    assert.deepEqual(stage.msgs, [
      'odczyt kolumny A (0 wierszy)',
      'rozpoznanie importowanych dni (0 wierszy)',
      'usunięcie wierszy importowanych dni (0)'
    ]);
  });

  test('dopisuje za ostatnią niepustą komórką kolumny A bez usuniętych wierszy; formaty i etapy dokładne', () => {
    const gas = projekt();
    const stage = etapy();
    // wiersze arkusza 2..6: 1.10, 2.10 (usuwany), 1.10, '', null
    const sheet = arkusz({ lastRow: 6, values: kolumna(['2026-10-01', '2026-10-02', '2026-10-01', '', null]), maxRows: 5 });

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', nowe, stage);

    assert.deepEqual(plain(metody(sheet, 'deleteRows')), [['deleteRows', 3, 1]]);
    const zapis = plain(metody(sheet, 'setValues'));
    assert.deepEqual(zapis, [['setValues', 4, 1, 2, 10, nowe]], 'trzy niepuste wiersze zostają, nowe od wiersza 4');
    assert.deepEqual(plain(metody(sheet, 'insertRowsAfter')), [], 'maxRows == potrzebne: bez dopisywania wierszy siatki');
    assert.deepEqual(plain(metody(sheet, 'setNumberFormat')), [
      ['setNumberFormat', 4, 8, 2, 1, '0.00%'],
      ['setNumberFormat', 4, 9, 2, 1, '0.0'],
      ['setNumberFormat', 4, 10, 2, 1, 'yyyy-mm-dd hh:mm']
    ]);
    assert.deepEqual(stage.msgs, [
      'odczyt kolumny A (5 wierszy)',
      'rozpoznanie importowanych dni (5 wierszy)',
      'usunięcie wierszy importowanych dni (1)',
      'dopisanie wierszy (2)',
      'formaty'
    ]);
  });

  test('siatka za mała: dopisuje dokładnie brakujące wiersze za ostatnim wierszem siatki', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 6, values: kolumna(['2026-10-01', '2026-10-02', '2026-10-01', '', null]), maxRows: 4 });

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', nowe, etapy());

    assert.deepEqual(plain(metody(sheet, 'insertRowsAfter')), [['insertRowsAfter', 4, 1]]);
  });

  test('kolejne bloki usuwane od dołu: dwa osobne bloki i jeden ciągły', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 8, values: kolumna(['2026-10-02', '2026-10-01', '2026-10-02', '2026-10-02', '2026-10-01', '2026-10-02', '2026-10-01']) });

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', [], etapy());

    assert.deepEqual(plain(metody(sheet, 'deleteRows')), [['deleteRows', 7, 1], ['deleteRows', 4, 2], ['deleteRows', 2, 1]]);
  });

  test('cała kolumna pusta po usunięciu: nowe od wiersza 2', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 3, values: kolumna(['2026-10-02', '']) });

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', nowe, etapy());

    assert.deepEqual(plain(metody(sheet, 'setValues')), [['setValues', 2, 1, 2, 10, nowe]]);
  });
});

describe('#229: replaceRange_', () => {
  const wiersz = (data, q) => [data, q, '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, ''];
  const nowe = [wiersz('2026-10-02', 'n1')];

  test('zakładka z samym nagłówkiem i brak nowych wierszy: żadnego zapisu ani etapu', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 1 });

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-02', [], stage);

    assert.deepEqual(sheet.calls, []);
    assert.deepEqual(stage.msgs, []);
  });

  test('zakładka z samym nagłówkiem i nowe wiersze: tylko zapis i formaty', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 1 });

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-02', nowe, stage);

    assert.deepEqual(plain(metody(sheet, 'getValues')), []);
    assert.deepEqual(plain(metody(sheet, 'clearContent')), []);
    assert.deepEqual(plain(metody(sheet, 'setValues')), [['setValues', 2, 1, 1, 10, nowe]]);
    assert.deepEqual(stage.msgs, ['zapis całej zakładki (1 wierszy)', 'formaty']);
  });

  test('zachowuje wiersze spoza zakresu, odrzuca wiersze z zakresu i z pustą datą, dopisuje nowe na końcu', () => {
    const gas = projekt();
    const stage = etapy();
    const istniejace = [wiersz('2026-10-01', 'stary1'), wiersz('2026-10-02', 'wZakresie'), wiersz('', 'bezDaty'), wiersz('2026-10-03', 'stary2')];
    const sheet = arkusz({ lastRow: 5, values: istniejace });

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-02', nowe, stage);

    assert.deepEqual(plain(metody(sheet, 'getValues')), [['getValues', 2, 1, 4, 10]]);
    assert.deepEqual(plain(metody(sheet, 'clearContent')), [['clearContent', 2, 1, 4, 10]]);
    assert.deepEqual(plain(metody(sheet, 'setValues')), [['setValues', 2, 1, 3, 10, [istniejace[0], istniejace[3], nowe[0]]]]);
    assert.deepEqual(plain(metody(sheet, 'setNumberFormat')), [
      ['setNumberFormat', 2, 8, 3, 1, '0.00%'],
      ['setNumberFormat', 2, 9, 3, 1, '0.0'],
      ['setNumberFormat', 2, 10, 3, 1, 'yyyy-mm-dd hh:mm']
    ]);
    assert.deepEqual(stage.msgs, [
      'odczyt arkusza (4 wierszy)',
      'czyszczenie',
      'zapis całej zakładki (3 wierszy)',
      'formaty'
    ]);
  });

  test('wszystko usunięte i brak nowych: czyści, ale nie zapisuje i nie formatuje', () => {
    const gas = projekt();
    const stage = etapy();
    const sheet = arkusz({ lastRow: 2, values: [wiersz('2026-10-02', 'wZakresie')] });

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-02', [], stage);

    assert.deepEqual(plain(metody(sheet, 'clearContent')), [['clearContent', 2, 1, 1, 10]]);
    assert.deepEqual(plain(metody(sheet, 'setValues')), []);
    assert.deepEqual(plain(metody(sheet, 'setNumberFormat')), []);
    assert.deepEqual(stage.msgs, ['odczyt arkusza (1 wierszy)', 'czyszczenie']);
  });

  test('daty przed i po zakresie są zachowane, granice zakresu usuwane', () => {
    const gas = projekt();
    const istniejace = [wiersz('2026-10-01', 'przed'), wiersz('2026-10-02', 'start'), wiersz('2026-10-04', 'koniec'), wiersz('2026-10-05', 'po')];
    const sheet = arkusz({ lastRow: 5, values: istniejace });

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-04', [], etapy());

    assert.deepEqual(plain(metody(sheet, 'setValues'))[0][5], [istniejace[0], istniejace[3]]);
  });
});

describe('#229: diagnozaDatGsc', () => {
  /** Projekt z atrapą zakładki GSC RAW; `gas.SpreadsheetApp.getActive` podmienione. */
  function zAtrapa(sheet) {
    const gas = projekt();
    gas.SpreadsheetApp.getActive = () => ({ getSheetByName: nazwa => (nazwa === 'GSC RAW' ? sheet : null) });
    return gas;
  }
  const linie = gas => gas.$console.map(([, t]) => t).filter(t => t.startsWith('[diagnoza dat GSC] '));

  test('zakładka z samym nagłówkiem: nic nie czyta, zerowe wyniki', () => {
    const sheet = arkusz({ lastRow: 1 });
    const gas = zAtrapa(sheet);

    assert.deepEqual(plain(gas.diagnozaDatGsc()), { rows: 0, dates: 0, distinct: 0, same: true });
    assert.deepEqual(sheet.calls, []);
    assert.ok(linie(gas).some(l => l.startsWith('[diagnoza dat GSC] pierwszy odczyt kolumny A (0 wierszy): ')));
  });

  test('czyta kolumnę dokładnie dwa razy (pierwszy i drugi odczyt)', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 3, values: [] });
    sheet.getRange = (...args) => ({ getValues: () => { sheet.calls.push(['getValues', ...args]); return [[new gas.$Date(2026, 9, 1)], ['x']]; } });
    gas.SpreadsheetApp.getActive = () => ({ getSheetByName: () => sheet });

    const out = plain(gas.diagnozaDatGsc());

    assert.deepEqual(plain(metody(sheet, 'getValues')), [['getValues', 2, 1, 2, 1], ['getValues', 2, 1, 2, 1]]);
    assert.deepEqual(out, { rows: 2, dates: 1, distinct: 1, same: true });
    assert.ok(linie(gas).includes('[diagnoza dat GSC] wyniki zgodne: tak'));
  });

  test('gdy wariant z pamięcią daje inny wynik, same=false i komunikat "NIE"', () => {
    const gas = projekt();
    const sheet = arkusz({ lastRow: 3, values: [] });
    sheet.getRange = () => ({ getValues: () => [[new gas.$Date(2026, 9, 1)], [new gas.$Date(2026, 9, 2)]] });
    gas.SpreadsheetApp.getActive = () => ({ getSheetByName: () => sheet });
    gas.cachedFormatDate_ = () => () => 'inna';

    const out = plain(gas.diagnozaDatGsc());

    assert.equal(out.same, false);
    assert.ok(linie(gas).includes('[diagnoza dat GSC] wyniki zgodne: NIE'));
  });
});
