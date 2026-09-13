'use strict';

/**
 * #152: retencja surowych prób w „PAGESPEED LAB”.
 *
 * Przycinanie jest bezpieczne dopiero dlatego, że mediany żyją osobno i na stałe.
 * Twarda reguła ze specyfikacji: surowych prób danego przebiegu nie wolno usunąć,
 * dopóki dla TEGO SAMEGO przebiegu nie ma median w „PERFORMANCE SUMMARY” dla każdej
 * pary (adres, strategia), która miała udaną próbę. Inaczej przycinanie kasowałoby
 * jedyny nośnik wyniku — czyli dokładnie to, czemu agregat miał zapobiec.
 *
 * Stan produkcji 2026-09-13 pokazał, dlaczego to nie jest ostrożność na wyrost:
 * zakładka miała 51 przebiegów, a agregat mediany tylko z 7. Czterdzieści cztery
 * przebiegi są więc chronione przed usunięciem mimo wieku.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const LAB = 'PAGESPEED LAB';
const SUMMARY = 'PERFORMANCE SUMMARY';
const LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano', 'Wyzwolenie'];
const SUMMARY_HEADER = ['Pomiar', 'URL', 'Strategia', 'Metryka', 'Mediana', 'Liczba prób', 'Źródło', 'Pobrano'];

const A = 'https://www.example.pl/a/';
const B = 'https://www.example.pl/b/';
/** Ile pomiarów zostaje niezależnie od pokrycia — musi zgadzać się z kodem. */
const KEEP = 8;

const znacznik = n => '2026-09-' + String(n).padStart(2, '0') + ' 06:00:00';

/** Trzy próby jednej metryki dla pary (adres, strategia) w danym przebiegu. */
const proby = (pomiar, url, strategia) => [1, 2, 3].map(n =>
  [pomiar, url, strategia, n, 'LCP', 2000 + n, 'PSI_LAB', '2026-09-13', 'cykliczny']);

const mediana = (pomiar, url, strategia) =>
  [pomiar, url, strategia, 'LCP', 2001, 3, 'PSI_LAB', '2026-09-13'];

function project({ lab, summary = [] } = {}) {
  return loadProject({
    properties: {},
    sheets: {
      [LAB]: [LAB_HEADER].concat(lab || []),
      [SUMMARY]: [SUMMARY_HEADER].concat(summary)
    },
    fetch: () => ({ code: 404, text: '{}' })
  });
}

/** Przebiegi 1..n, każdy z jedną parą; opcjonalnie z medianami. */
function historia(n, { zMedianami = true, url = A } = {}) {
  const lab = [];
  const summary = [];
  for (let i = 1; i <= n; i++) {
    proby(znacznik(i), url, 'mobile').forEach(row => lab.push(row));
    if (zMedianami) summary.push(mediana(znacznik(i), url, 'mobile'));
  }
  return { lab, summary };
}

describe('#152: polityka retencji', () => {
  test('1: mniej przebiegów niż próg → nie ma czego przycinać', () => {
    const gas = project(historia(KEEP));
    const plan = plain(gas.planLabCleanup_());
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.measurements, KEEP);
  });

  test('2: powyżej progu przycinane są najstarsze, najnowsze zostają', () => {
    const gas = project(historia(KEEP + 3));
    const plan = plain(gas.planLabCleanup_());

    assert.equal(plan.trimmed, 3, 'trzy najstarsze przebiegi');
    assert.equal(plan.remove.length, 9, 'po trzy wiersze na przebieg');
    // Wiersze najstarszych przebiegów leżą na początku zakładki.
    assert.deepEqual(plan.remove, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(plan.keep, KEEP * 3);
  });

  test('3: kolejność wyznacza znacznik, nie pozycja w zakładce', () => {
    // Zapis idzie raz na adres (#151), więc wiersze nie są chronologiczne.
    const h = historia(KEEP + 1);
    const przetasowane = h.lab.slice().reverse();
    const gas = project({ lab: przetasowane, summary: h.summary });
    const plan = plain(gas.planLabCleanup_());

    assert.equal(plan.trimmed, 1);
    const usuwane = plan.remove.map(row => przetasowane[row - 2][0]);
    assert.deepEqual([...new Set(usuwane)], [znacznik(1)], 'usunięty najstarszy znacznik');
  });
});

describe('#152: twarda reguła — brak mediany blokuje usunięcie', () => {
  test('8: przebieg bez median w agregacie zostaje mimo wieku', () => {
    const gas = project(historia(KEEP + 3, { zMedianami: false }));
    const plan = plain(gas.planLabCleanup_());

    assert.deepEqual(plan.remove, [], 'nic nie usunięte');
    assert.equal(plan.blocked, 3, 'trzy przebiegi zablokowane');
    assert.equal(plan.blockedRows, 9);
  });

  test('8a: brakuje mediany dla JEDNEJ pary → cały przebieg zostaje', () => {
    const h = historia(KEEP + 1);
    // Najstarszy przebieg ma drugi adres w surowych próbach, ale bez mediany.
    proby(znacznik(1), B, 'mobile').forEach(row => h.lab.push(row));
    const gas = project(h);
    const plan = plain(gas.planLabCleanup_());

    assert.deepEqual(plan.remove, [], 'niepełny przebieg w surowych próbach byłby gorszy niż pełny');
    assert.equal(plan.blocked, 1);
  });

  test('8b: mediana innej strategii nie wystarcza', () => {
    const h = historia(KEEP + 1);
    proby(znacznik(1), A, 'desktop').forEach(row => h.lab.push(row));
    const gas = project(h);
    assert.deepEqual(plain(gas.planLabCleanup_()).remove, []);

    h.summary.push(mediana(znacznik(1), A, 'desktop'));
    const zPelnym = project(h);
    assert.equal(plain(zPelnym.planLabCleanup_()).trimmed, 1, 'komplet par odblokowuje przebieg');
  });

  test('8c: mediana z INNEGO przebiegu nie odblokowuje starszego', () => {
    const h = historia(KEEP + 1, { zMedianami: false });
    // Agregat ma mediany, ale wyłącznie dla najnowszego przebiegu.
    h.summary.push(mediana(znacznik(KEEP + 1), A, 'mobile'));
    const gas = project(h);
    assert.deepEqual(plain(gas.planLabCleanup_()).remove, [], 'klucz obejmuje znacznik przebiegu');
  });
});

describe('#152: znacznik przebiegu po obu stronach', () => {
  test('data w surowych próbach i tekst w agregacie to ten sam przebieg', () => {
    // Realny stan produkcji: „PAGESPEED LAB” trzyma Pomiar datą, a
    // „PERFORMANCE SUMMARY” tekstem (#168). Retencja musi je zestawić.
    const gas = project(historia(KEEP + 1));
    const grid = gas.$sheet(LAB);
    grid.slice(1).forEach(row => {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(row[0]));
      if (m) row[0] = new gas.$Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    });
    assert.ok(gas.$sheet(LAB)[1][0] instanceof gas.$Date, 'warunek produkcyjny odtworzony');

    assert.equal(plain(gas.planLabCleanup_()).trimmed, 1, 'data i tekst zestawione jako ten sam przebieg');
  });

  test('znacznik sprzed sekund (#156) zestawia się ze znacznikiem z sekundami', () => {
    const gas = project({
      lab: [['2026-09-01 06:00', A, 'mobile', 1, 'LCP', 2000, 'PSI_LAB', '2026-09-13', 'ręczny']],
      summary: [['2026-09-01 06:00:00', A, 'mobile', 'LCP', 2000, 1, 'PSI_LAB', '2026-09-13']]
    });
    // Jeden przebieg, więc mieści się w progu — sprawdzamy sam klucz.
    assert.equal(gas.perfMeasurementKey_('2026-09-01 06:00'), '2026-09-01 06:00:00');
    assert.equal(plain(gas.planLabCleanup_()).measurements, 1);
  });
});

describe('#152: komunikat mówi, czego NIE usunięto', () => {
  test('liczba zablokowanych przebiegów jest w opisie polityki', () => {
    const gas = project(historia(KEEP + 3, { zMedianami: false }));
    const opis = gas.labPolicyLine_(plain(gas.planLabCleanup_()));

    assert.match(opis, /zostaje 8 najnowszych pomiarów z 11/);
    assert.match(opis, /3 starszych pomiarów \(9 wierszy\) zostaje mimo wieku/);
    assert.match(opis, /nie są usuwane nigdy/, 'agregat nie podlega tej retencji');
  });

  test('bez zablokowanych opis jest krótki', () => {
    const gas = project(historia(KEEP));
    const opis = gas.labPolicyLine_(plain(gas.planLabCleanup_()));
    assert.ok(opis.indexOf('mimo wieku') < 0, opis);
  });

  test('pusta zakładka nie wywraca planu', () => {
    const gas = project({ lab: [] });
    const plan = plain(gas.planLabCleanup_());
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.measurements, 0);
  });
});
