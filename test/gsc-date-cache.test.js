'use strict';

/**
 * #229: pętle po kolumnie A `GSC RAW` formatują każdą chwilę raz.
 *
 * Kolumna ma kilkadziesiąt różnych dat na ponad 22 tys. komórek, a
 * `Utilities.formatDate` bywa wolne (do 160 s na przebieg). Numeracja
 * odpowiada macierzy testów z #229.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const RAW = 'GSC RAW';
const HEADER = ['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded'];
const CELLS = 20000;

function projekt() {
  return loadProject({
    sheets: {
      'Konfiguracja GSC': [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/']],
      [RAW]: { rows: [HEADER] }
    }
  });
}

/** Zlicza wywołania `Utilities.formatDate` w danym projekcie. */
function licznik(gas) {
  const oryginal = gas.Utilities.formatDate;
  const stan = { n: 0 };
  gas.Utilities.formatDate = (...args) => { stan.n++; return oryginal(...args); };
  return stan;
}

/** `Date` z realmu projektu (kod sprawdza `instanceof Date`). */
const chwila = (gas, y, m, d, h = 0, ms = 0) => new gas.$Date(y, m - 1, d, h, 0, 0, ms);

/** Kolumna A (bez nagłówka) jako tablica jednokolumnowych wierszy `getValues()`. */
function kolumna(wartosci) {
  return wartosci.map(v => [v]);
}

/** Arkusz atrapa: tylko to, czego używają trzy pętle. */
function arkusz(wartosci, wiersze10) {
  const calls = { deleted: [] };
  return {
    calls,
    getLastRow: () => wartosci.length + 1,
    getRange: (row, col, rows, cols) => ({
      getValues: () => (cols === 1 ? kolumna(wartosci) : wiersze10),
      clearContent() {},
      setNumberFormat() {},
      setValues() {}
    }),
    deleteRows: (start, count) => calls.deleted.push([start, count]),
    getMaxRows: () => wartosci.length + 100,
    insertRowsAfter() {}
  };
}

/** Wzorzec odniesienia: implementacja sprzed zmiany (formatowanie każdej komórki). */
function wzorzecLastDay(gas, wartosci, target) {
  let day = '';
  let before = '';
  wartosci.forEach(v => {
    const date = v instanceof gas.$Date ? gas.formatujDate_(v) : String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || gas.shiftDay_(date, 0) !== date) return;
    if (date > day) day = date;
    if (date < target && date > before) before = date;
  });
  return { day, before };
}

const stage = () => {};

describe('#229: pamięć formatowania dat w pętlach po kolumnie A', () => {
  test('1: gscLastDataDay_ — 20 000 komórek Date z 3 chwil: ten sam wynik, najwyżej 3 wywołania usługi', () => {
    const gas = projekt();
    const a = chwila(gas, 2026, 10, 1);
    const b = chwila(gas, 2026, 10, 2);
    const c = chwila(gas, 2026, 10, 3);
    const wartosci = Array.from({ length: CELLS }, (_, i) => [a, b, c][i % 3]);
    const n = licznik(gas);

    const out = plain(gas.gscLastDataDay_(arkusz(wartosci), stage, '2026-10-03'));

    assert.deepEqual(out, { day: '2026-10-03', before: '2026-10-02' });
    assert.ok(n.n <= 3, `wywołań usługi: ${n.n}`);
    assert.deepEqual(out, plain(wzorzecLastDay(gas, wartosci, '2026-10-03')));
  });

  test('2: appendGscDays_ — 20 000 komórek Date z 3 chwil, jedna w importowanym zakresie: ten sam zestaw usuwanych wierszy, najwyżej 3 wywołania', () => {
    const gas = projekt();
    const a = chwila(gas, 2026, 10, 1);
    const b = chwila(gas, 2026, 10, 2);
    const c = chwila(gas, 2026, 10, 3);
    const wartosci = Array.from({ length: CELLS }, (_, i) => [a, b, c][i % 3]);
    const sheet = arkusz(wartosci);
    const n = licznik(gas);

    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-02', [], stage);

    assert.ok(n.n <= 3, `wywołań usługi: ${n.n}`);
    const usuniete = sheet.calls.deleted.reduce((s, [, count]) => s + count, 0);
    assert.equal(usuniete, wartosci.filter(v => v === b).length);
    assert.equal(sheet.calls.deleted.length, wartosci.filter(v => v === b).length, 'wiersze rozrzucone, każdy blok po jednym wierszu');
  });

  test('3: replaceRange_ — to samo: ten sam zestaw zachowanych wierszy, najwyżej 3 wywołania', () => {
    const gas = projekt();
    const a = chwila(gas, 2026, 10, 1);
    const b = chwila(gas, 2026, 10, 2);
    const c = chwila(gas, 2026, 10, 3);
    const wiersze = Array.from({ length: CELLS }, (_, i) => [[a, b, c][i % 3], 'q' + i, '/p', 'pol', 'MOBILE', 1, 1, 0.1, 1, '']);
    const zapisane = [];
    const sheet = arkusz(wiersze.map(r => r[0]), wiersze);
    sheet.getRange = () => ({
      getValues: () => wiersze,
      clearContent() {},
      setNumberFormat() {},
      setValues: v => zapisane.push(v)
    });
    const n = licznik(gas);

    gas.replaceRange_(sheet, '2026-10-02', '2026-10-02', [], stage);

    assert.ok(n.n <= 3, `wywołań usługi: ${n.n}`);
    const oczekiwane = wiersze.filter(r => r[0] !== b);
    assert.equal(zapisane[0].length, oczekiwane.length);
    assert.ok(zapisane[0].every((r, i) => r === oczekiwane[i]), 'zachowane te same wiersze w tej samej kolejności');
  });

  test('4: mieszana kolumna — wyniki gscLastDataDay_ i appendGscDays_ identyczne z implementacją sprzed zmiany', () => {
    const gas = projekt();
    const wartosci = [
      chwila(gas, 2026, 10, 1), '2026-10-05', '', null, 'notatka', '9999-12-31 notatka', '2026-02-31', chwila(gas, 2026, 10, 2), '2026-10-04 12:00'
    ];
    const oczekiwane = wzorzecLastDay(gas, wartosci, '2026-10-03');

    const out = plain(gas.gscLastDataDay_(arkusz(wartosci), stage, '2026-10-03'));

    assert.deepEqual(out, plain(oczekiwane));
    assert.deepEqual(out, { day: '2026-10-05', before: '2026-10-02' });

    const sheet = arkusz(wartosci);
    gas.appendGscDays_(sheet, '2026-10-02', '2026-10-04', [], stage);
    // usuwane: Date 2.10 (indeks 7), napis z 4.10 (indeks 8) i '2026-10-04 12:00' jako 4.10; blok 7-8 od dołu
    assert.deepEqual(plain(sheet.calls.deleted), [[9, 2]]);
  });

  test('5: dwie różne instancje Date o tym samym getTime — jedno wywołanie usługi', () => {
    const gas = projekt();
    const n = licznik(gas);
    const format = gas.cachedFormatDate_();
    const a = chwila(gas, 2026, 10, 1, 8);
    const b = new gas.$Date(a.getTime());

    assert.equal(format(a), '2026-10-01');
    assert.equal(format(b), '2026-10-01');
    assert.equal(n.n, 1);
  });

  test('6: dwie Date różniące się o 1 ms tego samego dnia — dwa wywołania usługi, ten sam wynik', () => {
    const gas = projekt();
    const n = licznik(gas);
    const format = gas.cachedFormatDate_();

    assert.equal(format(chwila(gas, 2026, 10, 1, 8, 0)), '2026-10-01');
    assert.equal(format(chwila(gas, 2026, 10, 1, 8, 1)), '2026-10-01');
    assert.equal(n.n, 2);
  });

  test('7: pamięć nie przeżywa wywołania — kolejne wywołanie funkcji z tą samą datą woła usługę', () => {
    const gas = projekt();
    const a = chwila(gas, 2026, 10, 1);
    const n = licznik(gas);

    gas.gscLastDataDay_(arkusz([a, a]), stage, '2026-10-03');
    assert.equal(n.n, 1);
    gas.gscLastDataDay_(arkusz([a, a]), stage, '2026-10-03');
    assert.equal(n.n, 2, 'drugie wywołanie nie korzysta z pamięci pierwszego');

    const f1 = gas.cachedFormatDate_();
    const f2 = gas.cachedFormatDate_();
    f1(a);
    f2(a);
    assert.equal(n.n, 4, 'dwa pomocniki mają osobną pamięć');
  });

  test('8: new Date(NaN) — skutek jak bez pamięci, pozostałe komórki obsłużone, NaN nie trafia do pamięci', () => {
    const gas = projekt();
    const zly = new gas.$Date(NaN);
    const n = licznik(gas);
    const format = gas.cachedFormatDate_();

    const bezPamieci = gas.formatujDate_(zly);
    const wywolania = n.n;
    assert.equal(format(zly), bezPamieci);
    assert.equal(format(zly), bezPamieci);
    assert.equal(n.n - wywolania, 2, 'każde wywołanie z NaN idzie do usługi');
    assert.equal(format(chwila(gas, 2026, 10, 1)), '2026-10-01');

    const out = plain(gas.gscLastDataDay_(arkusz([zly, chwila(gas, 2026, 10, 2)]), stage, '2026-10-03'));
    assert.deepEqual(out, { day: '2026-10-02', before: '2026-10-02' });
  });

  test('normalizujDate_: bez drugiego argumentu formatuje jak dotąd, z argumentem używa podanej funkcji', () => {
    const gas = projekt();
    const a = chwila(gas, 2026, 10, 1);

    assert.equal(gas.normalizujDate_(a), '2026-10-01');
    assert.equal(gas.normalizujDate_(a, () => 'X'), 'X');
    assert.equal(gas.normalizujDate_('2026-10-05 12:00', () => 'X'), '2026-10-05');
    assert.equal(gas.normalizujDate_('', () => 'X'), '');
  });
});
