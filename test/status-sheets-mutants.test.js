'use strict';

/**
 * #287: spłata po metodach - pomocniki arkuszy i IMPORT LOG w `Status.gs`.
 *
 * Zbiegłe mutanty z pilotażu #234: warunki `lastRow`/`maxColumns`, wstawianie
 * wiersza nagłówka, konflikty nagłówka (dokładne komunikaty), historia i
 * przycinanie logu (granice, bloki, daty), pola wiersza logu. Arkusz-atrapa
 * zapisuje każde wywołanie, więc testy sprawdzają dokładne argumenty.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const projekt = () => loadProject({});
const LOG_HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga', 'Zakres danych'];

/**
 * Arkusz-atrapa. `grid`: wiersze (od 1), `formulas`: opcjonalna siatka formuł,
 * `lastRow`/`maxRows`/`maxColumns` jawnie. Zakres o zerowej liczbie wierszy rzuca.
 */
function arkusz({ grid = [], formulas = [], lastRow: lastRow0 = grid.length, maxRows = 1000, maxColumns = 26, lastColumn } = {}) {
  const calls = [];
  let lastRow = lastRow0;
  // Komórka poza wierszem to pusty napis; jawne `undefined` w wierszu zostaje `undefined`.
  const komorka = (r, c) => {
    const wiersz = grid[r - 1];
    return wiersz && (c - 1) in wiersz ? wiersz[c - 1] : '';
  };
  const formula = (r, c) => {
    const v = (formulas[r - 1] || [])[c - 1];
    return v === undefined ? '' : v;
  };
  const zapisz = (r, c, m) => {
    m.forEach((wiersz, i) => {
      grid[r - 1 + i] = grid[r - 1 + i] || [];
      wiersz.forEach((v, j) => { grid[r - 1 + i][c - 1 + j] = v; });
    });
    lastRow = Math.max(lastRow, r - 1 + m.length);
  };
  const matryca = (r, c, nr, nc, fn) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => fn(r + i, c + j)));
  return {
    calls,
    getLastRow: () => lastRow,
    getMaxRows: () => maxRows,
    getMaxColumns: () => maxColumns,
    getLastColumn: () => (lastColumn === undefined ? maxColumns : lastColumn),
    getRange(r, c, nr = 1, nc = 1) {
      if (nr === 0 || nc === 0) throw new Error('zakres o zerowym rozmiarze: ' + [r, c, nr, nc]);
      return {
        getValue: () => komorka(r, c),
        getValues: () => matryca(r, c, nr, nc, komorka),
        getFormulas: () => matryca(r, c, nr, nc, formula),
        isBlank: () => matryca(r, c, nr, nc, komorka).every(w => w.every(v => v === '' || v === null || v === undefined)),
        setValue: v => { calls.push(['setValue', r, c, v]); zapisz(r, c, [[v]]); },
        setValues: m => { calls.push(['setValues', r, c, nr, nc, m]); zapisz(r, c, m); }
      };
    },
    insertRowBefore: n => { calls.push(['insertRowBefore', n]); },
    insertRowsAfter: (...a) => { calls.push(['insertRowsAfter', ...a]); },
    insertColumnsAfter: (...a) => { calls.push(['insertColumnsAfter', ...a]); },
    setFrozenRows: n => { calls.push(['setFrozenRows', n]); },
    deleteRows: (...a) => { calls.push(['deleteRows', ...a]); }
  };
}
const wywolania = (sheet, nazwa) => plain(sheet.calls.filter(c => c[0] === nazwa));

/** Podmienia `SpreadsheetApp.getActive()` na rejestr arkuszy; `insertThrows`: błąd insertSheet z wyścigu. */
function zRejestrem(gas, arkusze, { wstaw, insertThrows } = {}) {
  const wstawione = [];
  gas.SpreadsheetApp.getActive = () => ({
    getSheetByName: n => arkusze[n] || null,
    insertSheet: n => {
      wstawione.push(n);
      if (insertThrows) throw insertThrows;
      arkusze[n] = wstaw || arkusz({ lastRow: 0 });
      return arkusze[n];
    }
  });
  return wstawione;
}

describe('#287: rangeIsEmpty_, ensureSheetRows_, ensureSheetColumns_', () => {
  const zakres = (wartosci, formuly) => ({ getValues: () => wartosci, getFormulas: () => formuly || wartosci.map(w => w.map(() => '')) });

  test('rangeIsEmpty_: puste komórki (undefined, null, napis pusty) to pusty zakres; zero i tekst nie', () => {
    const gas = projekt();

    assert.equal(gas.rangeIsEmpty_(zakres([[undefined, null, '']])), true);
    assert.equal(gas.rangeIsEmpty_(zakres([[0]])), false);
    assert.equal(gas.rangeIsEmpty_(zakres([['', 'x']])), false);
    assert.equal(gas.rangeIsEmpty_(zakres([['', ''], ['x', '']])), false);
    assert.equal(gas.rangeIsEmpty_(zakres([[null]])), true);
    assert.equal(gas.rangeIsEmpty_(zakres([[undefined]])), true);
  });

  test('rangeIsEmpty_: formuła zwracająca pusty tekst nie jest pustą komórką', () => {
    const gas = projekt();

    assert.equal(gas.rangeIsEmpty_(zakres([['']], [['=IF(1;"";1)']])), false);
  });

  test('ensureSheetRows_: dopisuje brakujące wiersze dokładnie za ostatnim wierszem siatki; równe maksimum nic nie dopisuje', () => {
    const gas = projekt();
    const rowne = arkusz({ maxRows: 100 });
    const mniejsze = arkusz({ maxRows: 100 });

    gas.ensureSheetRows_(rowne, 100);
    gas.ensureSheetRows_(mniejsze, 130);

    assert.deepEqual(wywolania(rowne, 'insertRowsAfter'), []);
    assert.deepEqual(wywolania(mniejsze, 'insertRowsAfter'), [['insertRowsAfter', 100, 30]]);
    assert.equal(gas.ensureSheetRows_(rowne, 1), rowne);
  });

  test('ensureSheetColumns_: to samo dla kolumn', () => {
    const gas = projekt();
    const rowne = arkusz({ maxColumns: 8 });
    const mniejsze = arkusz({ maxColumns: 8 });

    gas.ensureSheetColumns_(rowne, 8);
    gas.ensureSheetColumns_(mniejsze, 12);

    assert.deepEqual(wywolania(rowne, 'insertColumnsAfter'), []);
    assert.deepEqual(wywolania(mniejsze, 'insertColumnsAfter'), [['insertColumnsAfter', 8, 4]]);
  });
});

describe('#287: ensureSheetWithHeader_ i ensureImportLogSheet_', () => {
  const NAGLOWEK = ['A', 'B', 'C'];

  test('brak arkusza: powstaje, dostaje nagłówek w wierszu 1 i zamrożony wiersz', () => {
    const gas = projekt();
    const rejestr = {};
    const wstawione = zRejestrem(gas, rejestr);

    const sheet = gas.ensureSheetWithHeader_('NOWY', NAGLOWEK);

    assert.deepEqual(wstawione, ['NOWY']);
    assert.equal(sheet, rejestr.NOWY);
    assert.deepEqual(wywolania(sheet, 'setValues'), [['setValues', 1, 1, 1, 3, [NAGLOWEK]]]);
    assert.deepEqual(wywolania(sheet, 'setFrozenRows'), [['setFrozenRows', 1]]);
    assert.deepEqual(wywolania(sheet, 'insertRowBefore'), []);
  });

  test('arkusz z poprawnym nagłówkiem: bez zapisu i bez zamrażania', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'B', 'C']], maxColumns: 5 });
    zRejestrem(gas, { ISTNIEJE: sheet });

    gas.ensureSheetWithHeader_('ISTNIEJE', NAGLOWEK);

    assert.deepEqual(sheet.calls, []);
  });

  test('wyścig: insertSheet rzuca, ale arkusz już istnieje - używa istniejącego; gdy go nie ma, rzuca oryginalny błąd', () => {
    const gas = projekt();
    const istnieje = arkusz({ grid: [['A', 'B', 'C']] });
    let wolane = 0;
    gas.SpreadsheetApp.getActive = () => ({
      getSheetByName: () => (wolane++ === 0 ? null : istnieje),
      insertSheet: () => { throw new Error('duplikat'); }
    });
    assert.equal(gas.ensureSheetWithHeader_('X', NAGLOWEK), istnieje);

    const blad = new Error('inny powód');
    zRejestrem(gas, {}, { insertThrows: blad });
    assert.throws(() => gas.ensureSheetWithHeader_('X', NAGLOWEK), err => err === blad);
  });

  test('dane bez nagłówka: wiersz nagłówka wstawiony NAD dane; pusty pierwszy wiersz nie powoduje wstawiania', () => {
    const gas = projekt();
    const zDanymi = arkusz({ grid: [['x', 'y'], ['1', '2']] });
    const zPustym = arkusz({ grid: [['', ''], ['1', '2']], lastRow: 2 });
    zRejestrem(gas, { D: zDanymi, P: zPustym });

    gas.ensureSheetWithHeader_('D', NAGLOWEK);
    gas.ensureSheetWithHeader_('P', NAGLOWEK);

    assert.deepEqual(wywolania(zDanymi, 'insertRowBefore'), [['insertRowBefore', 1]]);
    assert.deepEqual(wywolania(zPustym, 'insertRowBefore'), []);
    assert.deepEqual(wywolania(zDanymi, 'setValues'), [['setValues', 1, 1, 1, 3, [NAGLOWEK]]]);
    assert.deepEqual(wywolania(zPustym, 'setFrozenRows'), [['setFrozenRows', 1]]);
  });

  test('zakładka bez wierszy nie pyta o pustość pierwszego wiersza i nie wstawia wiersza', () => {
    const gas = projekt();
    const pusty = arkusz({ lastRow: 0 });
    const oryginal = pusty.getRange;
    pusty.getRange = (r, c, nr, nc) => {
      const zakres = oryginal(r, c, nr, nc);
      zakres.isBlank = () => { throw new Error('nie wolno pytać o pustość przy lastRow 0'); };
      return zakres;
    };
    zRejestrem(gas, { PUSTY: pusty });

    assert.doesNotThrow(() => gas.ensureSheetWithHeader_('PUSTY', NAGLOWEK));
  });

  test('arkusz za wąski: siatka poszerzona do długości nagłówka', () => {
    const gas = projekt();
    const waski = arkusz({ lastRow: 0, maxColumns: 2 });
    zRejestrem(gas, { W: waski });

    gas.ensureSheetWithHeader_('W', NAGLOWEK);

    assert.deepEqual(wywolania(waski, 'insertColumnsAfter'), [['insertColumnsAfter', 2, 1]]);
  });

  test('ensureImportLogSheet_: nowy arkusz dostaje nagłówek i zamrożony wiersz; istniejący z nagłówkiem nie jest ruszany', () => {
    const gas = projekt();
    const rejestr = {};
    zRejestrem(gas, rejestr);

    const sheet = gas.ensureImportLogSheet_();

    assert.deepEqual(wywolania(sheet, 'setValues'), [['setValues', 1, 1, 1, 10, [LOG_HEADER]]]);
    assert.deepEqual(wywolania(sheet, 'setFrozenRows'), [['setFrozenRows', 1]]);

    const gotowy = arkusz({ grid: [LOG_HEADER] });
    zRejestrem(gas, { 'IMPORT LOG': gotowy });
    gas.ensureImportLogSheet_();
    assert.deepEqual(gotowy.calls, []);
  });

  test('ensureImportLogSheet_: arkusz bez wierszy dostaje nagłówek; wyścig: błąd tylko gdy arkusza nadal nie ma', () => {
    const gas = projekt();
    const pusty = arkusz({ lastRow: 0 });
    zRejestrem(gas, { 'IMPORT LOG': pusty });
    gas.ensureImportLogSheet_();
    assert.equal(wywolania(pusty, 'setValues').length, 1);

    const istnieje = arkusz({ grid: [LOG_HEADER] });
    let wolane = 0;
    gas.SpreadsheetApp.getActive = () => ({
      getSheetByName: () => (wolane++ === 0 ? null : istnieje),
      insertSheet: () => { throw new Error('duplikat'); }
    });
    assert.equal(gas.ensureImportLogSheet_(), istnieje);

    const blad = new Error('inny powód');
    zRejestrem(gas, {}, { insertThrows: blad });
    assert.throws(() => gas.ensureImportLogSheet_(), err => err === blad);
  });
});

describe('#287: headerColumnsState_', () => {
  const NAGLOWEK = ['A', 'B', 'C'];

  test('arkusz bez nagłówka (pusty albo z innym A1): headed=false i pusta lista kolumn', () => {
    const gas = projekt();

    assert.deepEqual(plain(gas.headerColumnsState_(arkusz({ lastRow: 0, grid: [['A']] }), NAGLOWEK)), { headed: false, columns: [] });
    assert.deepEqual(plain(gas.headerColumnsState_(arkusz({ grid: [['inny']] }), NAGLOWEK)), { headed: false, columns: [] });
  });

  test('etykiety: przycięte, null i undefined to puste; niepusta etykieta nie bada kolumny pod spodem', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', ' B ', undefined], ['x', 'y', 'z']], maxColumns: 3 });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.equal(out.headed, true);
    assert.deepEqual(out.columns[0], { label: 'A', headerBlank: false, usedBelow: false });
    assert.deepEqual(out.columns[1], { label: 'B', headerBlank: false, usedBelow: false });
    assert.deepEqual(out.columns[2], { label: '', headerBlank: true, usedBelow: true });
  });

  test('null w komórce nagłówka to pusta etykieta', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', null, '']], lastRow: 1, maxColumns: 3 });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.deepEqual(out.columns[1], { label: '', headerBlank: true, usedBelow: false });
  });

  test('kolumna poza siatką jest pusta bez czytania; kolumna na krawędzi siatki jest czytana', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'B']], lastRow: 1, maxColumns: 2 });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.deepEqual(out.columns[1], { label: 'B', headerBlank: false, usedBelow: false });
    assert.deepEqual(out.columns[2], { label: '', headerBlank: true, usedBelow: false });
  });

  test('formuła w komórce nagłówka: headerBlank=false; pusta etykieta pod którą są dane: usedBelow=true', () => {
    const gas = projekt();
    const sheet = arkusz({
      grid: [['A', '', ''], ['x', 'dane', '']],
      formulas: [['', '=FORMULA()', ''], ['', '', '']],
      maxColumns: 3
    });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.deepEqual(out.columns[1], { label: '', headerBlank: false, usedBelow: true });
    assert.deepEqual(out.columns[2], { label: '', headerBlank: true, usedBelow: false });
  });

  test('sam nagłówek (lastRow 1): nie czyta kolumn pod nagłówkiem', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', '', '']], lastRow: 1, maxColumns: 3 });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.deepEqual(out.columns.map(c => c.usedBelow), [false, false, false]);
  });
});

describe('#287: ensureHeaderColumns_', () => {
  const NAGLOWEK = ['A', 'B', 'C'];
  const komunikat = (konflikty) => 'Niezgodny nagłówek zakładki „T”: ' + konflikty + '. Nic nie zostało zmienione — popraw nagłówek albo zmień nazwę zakładki.';

  test('uzupełnia brakującą etykietę, nie ruszając poprawnych (także z białymi znakami)', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', ' B ', '']], lastRow: 1, maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    gas.ensureHeaderColumns_('T', NAGLOWEK);

    assert.deepEqual(wywolania(sheet, 'setValue'), [['setValue', 1, 3, 'C']]);
  });

  test('komórka nagłówka z undefined traktowana jak pusta: etykieta zapisana', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'B']], lastRow: 1, maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    gas.ensureHeaderColumns_('T', NAGLOWEK);

    assert.deepEqual(wywolania(sheet, 'setValue'), [['setValue', 1, 3, 'C']]);
  });

  test('inna etykieta w kolumnie: wyjątek z numerem kolumny, obecną i oczekiwaną etykietą, bez zapisu', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'X', 'C']], lastRow: 1, maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    assert.throws(() => gas.ensureHeaderColumns_('T', NAGLOWEK), err => err.message === komunikat('kolumna 2: jest „X”, oczekiwano „B”'));
    assert.deepEqual(sheet.calls, []);
  });

  test('formuła w komórce nagłówka: wyjątek z numerem kolumny i etykietą', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', '', 'C']], formulas: [['', '=F()', '']], lastRow: 1, maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    assert.throws(() => gas.ensureHeaderColumns_('T', NAGLOWEK), err => err.message === komunikat('kolumna 2: komórka nagłówka nie jest pusta (formuła) — nie nadpisujemy jej etykietą „B”'));
  });

  test('pusty nagłówek z danymi pod spodem: wyjątek z numerem kolumny i etykietą', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'B', ''], ['x', 'y', 'dane']], maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    assert.throws(() => gas.ensureHeaderColumns_('T', NAGLOWEK), err => err.message === komunikat('kolumna 3: nagłówek pusty, ale pod nim są dane — nie przejmujemy jej pod „C”'));
  });

  test('kilka konfliktów naraz: połączone średnikiem, w kolejności kolumn', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', 'X', ''], ['x', 'y', 'dane']], maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    assert.throws(() => gas.ensureHeaderColumns_('T', NAGLOWEK), err => err.message === komunikat('kolumna 2: jest „X”, oczekiwano „B”; kolumna 3: nagłówek pusty, ale pod nim są dane — nie przejmujemy jej pod „C”'));
  });

  test('brak arkusza: powstaje z pełnym nagłówkiem, bez dopisywania etykiet', () => {
    const gas = projekt();
    const rejestr = {};
    zRejestrem(gas, rejestr);

    gas.ensureHeaderColumns_('NOWY', NAGLOWEK);

    assert.deepEqual(wywolania(rejestr.NOWY, 'setValue'), []);
    assert.deepEqual(wywolania(rejestr.NOWY, 'setValues'), [['setValues', 1, 1, 1, 3, [NAGLOWEK]]]);
  });

  test('arkusz bez nagłówka (A1 inne): walidacja konfliktów pominięta', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['inny', 'X'], ['1', '2']], maxColumns: 3 });
    zRejestrem(gas, { T: sheet });

    assert.doesNotThrow(() => gas.ensureHeaderColumns_('T', NAGLOWEK));
    assert.deepEqual(wywolania(sheet, 'insertRowBefore'), [['insertRowBefore', 1]]);
  });
});

describe('#287: importLogHistory_', () => {
  const NAGLOWEK = () => LOG_HEADER.slice();

  test('brak arkusza albo sam nagłówek: pusta historia; nagłówek i jeden wiersz: jedna pozycja', () => {
    const gas = projekt();
    zRejestrem(gas, {});
    assert.deepEqual(plain(gas.importLogHistory_()), []);

    const sam = arkusz({ grid: [NAGLOWEK()], lastColumn: 10 });
    zRejestrem(gas, { 'IMPORT LOG': sam });
    assert.deepEqual(plain(gas.importLogHistory_()), []);

    const jeden = arkusz({ grid: [NAGLOWEK(), ['2026-10-01 05:00', 'GSC', 'trigger', 1, 'OK', 12, 3, 'x', '', '2026-09-30..2026-09-30']], lastColumn: 10 });
    zRejestrem(gas, { 'IMPORT LOG': jeden });
    const out = gas.importLogHistory_();
    assert.equal(out.length, 1);
  });

  test('pola wiersza: źródło, typ, dni, wynik, wiersze i zakres; puste komórki to wartości domyślne', () => {
    const gas = projekt();
    const sheet = arkusz({
      grid: [
        NAGLOWEK(),
        ['2026-10-01 05:00', 'GSC', 'trigger', 2, 'OK', 12, 3, 'x', '', '2026-09-29..2026-09-30'],
        ['2026-10-02 05:00', 'GA4', 'ręczny', 0, 'BŁĄD', '', '', '', '', ''],
        ['2026-10-03 05:00', '', '', '', '', '', '', '', '', '']
      ],
      lastColumn: 10
    });
    zRejestrem(gas, { 'IMPORT LOG': sheet });

    const out = gas.importLogHistory_().map(h => ({ source: h.source, trigger: h.trigger, days: h.days, ok: h.ok, rows: h.rows, rangeKey: h.rangeKey, czas: h.at instanceof Date || !isNaN(new Date(h.at).getTime()) }));

    assert.deepEqual(plain(out), [
      { source: 'GSC', trigger: true, days: 2, ok: true, rows: 12, rangeKey: '2026-09-29..2026-09-30', czas: true },
      { source: 'GA4', trigger: false, days: 0, ok: false, rows: 0, rangeKey: '', czas: true },
      { source: '', trigger: false, days: 0, ok: false, rows: 0, rangeKey: '', czas: true }
    ]);
  });

  test('szerokość: starszy arkusz (9 kolumn) nie czyta zakresu; 10 kolumn z obcym nagłówkiem też nie', () => {
    const gas = projekt();
    const stary = arkusz({ grid: [NAGLOWEK().slice(0, 9), ['2026-10-01 05:00', 'GSC', 'trigger', 1, 'OK', 5, 1, 'x', '']], lastColumn: 9 });
    zRejestrem(gas, { 'IMPORT LOG': stary });
    assert.equal(gas.importLogHistory_()[0].rangeKey, '');
    assert.deepEqual(stary.calls, []);

    const obcy = NAGLOWEK();
    obcy[9] = 'Obca kolumna';
    const sheet = arkusz({ grid: [obcy, ['2026-10-01 05:00', 'GSC', 'trigger', 1, 'OK', 5, 1, 'x', '', 'wartość obca']], lastColumn: 10 });
    zRejestrem(gas, { 'IMPORT LOG': sheet });
    assert.equal(gas.importLogHistory_()[0].rangeKey, '');
  });

  test('szerokość: arkusz węższy niż 6 kolumn czyta co najmniej 6; szerszy niż 10 czyta najwyżej 10', () => {
    const gas = projekt();
    let czytane = [];
    const sheet = arkusz({ grid: [NAGLOWEK(), ['2026-10-01 05:00', 'GSC', 'trigger', 1, 'OK', 5]], lastColumn: 4 });
    const oryginal = sheet.getRange;
    sheet.getRange = (...a) => { czytane.push(a); return oryginal(...a); };
    zRejestrem(gas, { 'IMPORT LOG': sheet });
    gas.importLogHistory_();
    assert.deepEqual(czytane.filter(a => a[0] === 2).map(a => a.slice(0, 4)), [[2, 1, 1, 6]]);

    czytane = [];
    const szeroki = arkusz({ grid: [NAGLOWEK(), ['2026-10-01 05:00', 'GSC', 'trigger', 1, 'OK', 5]], lastColumn: 14 });
    const oryg2 = szeroki.getRange;
    szeroki.getRange = (...a) => { czytane.push(a); return oryg2(...a); };
    zRejestrem(gas, { 'IMPORT LOG': szeroki });
    gas.importLogHistory_();
    assert.deepEqual(czytane.filter(a => a[0] === 2).map(a => a.slice(0, 4)), [[2, 1, 1, 10]]);
  });
});

describe('#287: pruneImportLog_', () => {
  const NOW = new Date('2026-10-20T10:00:00Z');
  const DAY = 86400 * 1000;
  const wiersze = daty => arkusz({ grid: [['Czas']].concat(daty.map(d => [d])), lastRow: daty.length + 1 });
  const stara = new Date(NOW.getTime() - 91 * DAY);
  const swieza = new Date(NOW.getTime() - 5 * DAY);

  test('sam nagłówek: nic do usunięcia', () => {
    const gas = projekt();
    const sheet = wiersze([]);

    assert.equal(gas.pruneImportLog_(sheet, NOW), 0);
    assert.deepEqual(sheet.calls, []);
  });

  test('jeden wiersz (lastRow 2): wygasły jest usuwany, świeży zostaje', () => {
    const gas = projekt();
    const wygasly = wiersze([stara]);
    const zywy = wiersze([swieza]);

    assert.equal(gas.pruneImportLog_(wygasly, NOW), 1);
    assert.equal(gas.pruneImportLog_(zywy, NOW), 0);
    assert.deepEqual(wywolania(wygasly, 'deleteRows'), [['deleteRows', 2, 1]]);
    assert.deepEqual(wywolania(zywy, 'deleteRows'), []);
  });

  test('granica retencji: dokładnie na granicy zostaje, milisekundę starszy jest usuwany; nieczytelna data zostaje', () => {
    const gas = projekt();
    const cutoff = gas.importLogCutoff_(NOW);
    const sheet = wiersze([new Date(cutoff), new Date(cutoff - 1), 'nie data']);

    const usuniete = gas.pruneImportLog_(sheet, NOW);

    assert.equal(usuniete, 1);
    assert.deepEqual(wywolania(sheet, 'deleteRows'), [['deleteRows', 3, 1]]);
  });

  test('bloki usuwane od dołu: ciągłe naraz, rozdzielone osobno, bez przesuwania numerów', () => {
    const gas = projekt();
    // wiersze danych 2..8: S S F S F S S (S = stary)
    const sheet = wiersze([stara, stara, swieza, stara, swieza, stara, stara]);

    const usuniete = gas.pruneImportLog_(sheet, NOW);

    assert.equal(usuniete, 5);
    assert.deepEqual(wywolania(sheet, 'deleteRows'), [['deleteRows', 7, 2], ['deleteRows', 5, 1], ['deleteRows', 2, 2]]);
  });

  test('wszystkie wiersze wygasłe: jeden blok od pierwszego wiersza danych', () => {
    const gas = projekt();
    const sheet = wiersze([stara, stara, stara]);

    assert.equal(gas.pruneImportLog_(sheet, NOW), 3);
    assert.deepEqual(wywolania(sheet, 'deleteRows'), [['deleteRows', 2, 3]]);
  });
});

describe('#287: appendImportLog_ i importLogRangeColumnReady_', () => {
  const NAGLOWEK = () => LOG_HEADER.slice();

  test('wiersz udanego przebiegu bez opisu i ostrzeżenia ma puste komórki, nie wartości zastępcze', () => {
    const gas = projekt();
    gas.appendImportLog_('GSC', { finishedAt: '2026-10-20T10:00:00Z', ok: true, trigger: true, rows: 3 });

    const wiersz = gas.$sheet('IMPORT LOG')[1];
    assert.equal(wiersz[4], 'OK');
    assert.equal(wiersz[7], '');
    assert.equal(wiersz[8], '');
  });

  test('wiersz nieudanego przebiegu bez błędu ma pustą uwagę', () => {
    const gas = projekt();
    gas.appendImportLog_('GSC', { finishedAt: '2026-10-20T10:00:00Z', ok: false, trigger: false });

    const wiersz = gas.$sheet('IMPORT LOG')[1];
    assert.equal(wiersz[4], 'BŁĄD');
    assert.equal(wiersz[7], '');
    assert.equal(wiersz[8], '');
  });

  test('importLogRangeColumnReady_: arkusz o dokładnie 10 kolumnach z pustą etykietą dostaje etykietę zakresu', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [NAGLOWEK().slice(0, 9)], lastRow: 1, maxColumns: 10 });

    assert.equal(gas.importLogRangeColumnReady_(sheet), true);
    assert.deepEqual(wywolania(sheet, 'setValue'), [['setValue', 1, 10, 'Zakres danych']]);
  });

  test('importLogRangeColumnReady_: 9 kolumn to false; etykieta już jest to true bez zapisu; cudza etykieta to false', () => {
    const gas = projekt();
    assert.equal(gas.importLogRangeColumnReady_(arkusz({ lastRow: 1, maxColumns: 9 })), false);

    const gotowy = arkusz({ grid: [NAGLOWEK()], lastRow: 1, maxColumns: 10 });
    assert.equal(gas.importLogRangeColumnReady_(gotowy), true);
    assert.deepEqual(gotowy.calls, []);

    const obcy = NAGLOWEK();
    obcy[9] = 'Obca';
    assert.equal(gas.importLogRangeColumnReady_(arkusz({ grid: [obcy], lastRow: 1, maxColumns: 10 })), false);
  });

  test('importLogRangeColumnReady_: dane pod pustą etykietą blokują; sam nagłówek (lastRow 1) nie czyta kolumny', () => {
    const gas = projekt();
    const zDanymi = arkusz({ grid: [NAGLOWEK().slice(0, 9), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'cudze']], maxColumns: 10 });
    const bez = arkusz({ grid: [NAGLOWEK().slice(0, 9), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', '']], maxColumns: 10 });

    assert.equal(gas.importLogRangeColumnReady_(zDanymi), false);
    assert.deepEqual(zDanymi.calls, []);
    assert.equal(gas.importLogRangeColumnReady_(bez), true);
  });
});

describe('#287: rozmiary zakresów i jawne undefined w nagłówku', () => {
  const NAGLOWEK = ['A', 'B', 'C'];
  const zapisane = sheet => {
    const wolane = [];
    const oryginal = sheet.getRange;
    sheet.getRange = (...a) => { wolane.push(a); return oryginal(...a); };
    return wolane;
  };

  test('headerColumnsState_: kolumny z pustą etykietą są badane na zakresie o liczbie wierszy lastRow - 1', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', '', ''], ['', 'x', ''], ['', '', ''], ['', '', '']], lastRow: 4, maxColumns: 3 });
    const wolane = zapisane(sheet);

    gas.headerColumnsState_(sheet, NAGLOWEK);

    assert.deepEqual(wolane.filter(a => a[0] === 2), [[2, 2, 3, 1], [2, 3, 3, 1]]);
  });

  test('headerColumnsState_: jawne undefined i null w komórce nagłówka to pusta etykieta, nie napis', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['A', undefined, null]], lastRow: 1, maxColumns: 3 });

    const out = plain(gas.headerColumnsState_(sheet, NAGLOWEK));

    assert.deepEqual(out.columns[1], { label: '', headerBlank: true, usedBelow: false });
    assert.deepEqual(out.columns[2], { label: '', headerBlank: true, usedBelow: false });
  });

  test('importLogRangeColumnReady_: kolumnę pod etykietą badamy na lastRow - 1 wierszach od wiersza 2', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [LOG_HEADER.slice(0, 9), [], [], []], lastRow: 4, maxColumns: 10 });
    const wolane = zapisane(sheet);

    gas.importLogRangeColumnReady_(sheet);

    assert.deepEqual(wolane.filter(a => a[0] === 2), [[2, 10, 3, 1]]);
  });

  test('pruneImportLog_: odczyt dat na lastRow - 1 wierszach od wiersza 2', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['Czas'], [new Date()], [new Date()], [new Date()]], lastRow: 4 });
    const wolane = zapisane(sheet);

    gas.pruneImportLog_(sheet, new Date());

    assert.deepEqual(wolane, [[2, 1, 3, 1]]);
  });

  test('ensureImportLogSheet_: zakładka z danymi bez nagłówka dostaje nagłówek w wierszu 1', () => {
    const gas = projekt();
    const sheet = arkusz({ grid: [['cudze'], ['dane']], maxColumns: 10 });
    zRejestrem(gas, { 'IMPORT LOG': sheet });

    gas.ensureImportLogSheet_();

    assert.deepEqual(wywolania(sheet, 'setValues'), [['setValues', 1, 1, 1, 10, [LOG_HEADER]]]);
    assert.deepEqual(wywolania(sheet, 'setFrozenRows'), [['setFrozenRows', 1]]);
  });
});
