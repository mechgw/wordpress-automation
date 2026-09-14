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
const proby = (pomiar, url, strategia, metryka = 'LCP', wartosc = 2000) => [1, 2, 3].map(n =>
  [pomiar, url, strategia, n, metryka, wartosc + n, 'PSI_LAB', '2026-09-13', 'cykliczny']);

const mediana = (pomiar, url, strategia, metryka = 'LCP', wartosc = 2001) =>
  [pomiar, url, strategia, metryka, wartosc, 3, 'PSI_LAB', '2026-09-13'];

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

describe('#152: pokrycie znaczy użyteczna mediana, nie sam wiersz', () => {
  test('wiersz agregatu z pustą medianą nie odblokowuje usunięcia', () => {
    // Ręczna edycja albo przerwany zapis zostawia wiersz bez wartości. Uznanie go
    // za pokrycie pozwoliłoby skasować surowe próby bezpowrotnie — a to jedyny
    // nośnik wyniku, skoro mediany nie ma.
    const h = historia(KEEP + 1);
    h.summary[0][4] = '';
    const gas = project(h);
    const plan = plain(gas.planLabCleanup_());
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.blocked, 1);
  });

  test('mediana zero jest poprawna — CLS bywa zerem', () => {
    const h = historia(KEEP + 1);
    h.summary[0][4] = 0;
    const gas = project(h);
    assert.equal(plain(gas.planLabCleanup_()).trimmed, 1, 'zero to wartość, nie brak');
  });

  test('mediana nieliczbowa nie odblokowuje usunięcia', () => {
    const h = historia(KEEP + 1);
    h.summary[0][4] = 'błąd';
    const gas = project(h);
    assert.deepEqual(plain(gas.planLabCleanup_()).remove, []);
  });

  test('checkbox albo data w kolumnie Mediana nie są medianą', () => {
    // `Number(false)`, `Number(true)` i `Number(data)` są skończone, więc koercja
    // przepuszczałaby komórkę, która medianą nie jest — i pozwalała skasować próby.
    [false, true].forEach(wartosc => {
      const h = historia(KEEP + 1);
      h.summary[0][4] = wartosc;
      assert.deepEqual(plain(project(h).planLabCleanup_()).remove, [], 'wartość: ' + wartosc);
    });

    const zDatą = historia(KEEP + 1);
    const gas = project(zDatą);
    gas.$sheet(SUMMARY)[1][4] = new gas.$Date(2026, 8, 1);
    assert.deepEqual(plain(gas.planLabCleanup_()).remove, [], 'data też nie jest medianą');
  });

  test('wiersz agregatu bez znacznika albo bez strategii nie liczy się jako pokrycie', () => {
    const h = historia(KEEP + 1);
    h.summary[0][2] = '';
    const gas = project(h);
    assert.deepEqual(plain(gas.planLabCleanup_()).remove, []);
  });
});

describe('#152: plan po potwierdzeniu nie obejmuje więcej, niż pokazał dialog', () => {
  test('ograniczenie do potwierdzonych znaczników', () => {
    // Między dialogiem a usunięciem może wejść kolejny pomiar i wypchnąć starszy poza
    // próg. Świeży plan usunąłby go wtedy bez pytania — i to jest zabronione.
    const h = historia(KEEP + 2);
    const gas = project(h);
    const pelny = plain(gas.planLabCleanup_());
    assert.equal(pelny.trimmed, 2, 'bez ograniczeń dwa przebiegi');

    const ograniczony = plain(gas.planLabCleanup_([pelny.keys[0]]));
    assert.equal(ograniczony.trimmed, 1, 'tylko potwierdzony przebieg');
    assert.deepEqual(ograniczony.keys, [pelny.keys[0]]);
    assert.equal(ograniczony.keep, pelny.keep + 3, 'reszta policzona jako zostająca');
  });

  test('nieznany znacznik nie usuwa niczego', () => {
    const gas = project(historia(KEEP + 2));
    assert.deepEqual(plain(gas.planLabCleanup_(['2020-01-01 00:00:00'])).remove, []);
  });
});

describe('#152: pokrycie liczy się per metryka, nie per para', () => {
  test('brak mediany JEDNEJ metryki blokuje cały przebieg', () => {
    // Para (adres, strategia) bywa pokryta częściowo: mediana LCP zostaje, mediana CLS
    // ginie przy ręcznej edycji. Uznanie pary za pokrytą skasowałoby jedyny ślad po CLS.
    const h = historia(KEEP + 1);
    proby(znacznik(1), A, 'mobile', 'CLS', 0).forEach(row => h.lab.push(row));
    const gas = project(h);

    assert.deepEqual(plain(gas.planLabCleanup_()).remove, [], 'LCP ma medianę, CLS nie ma');

    h.summary.push(mediana(znacznik(1), A, 'mobile', 'CLS', 0));
    assert.equal(plain(project(h).planLabCleanup_()).trimmed, 1, 'komplet metryk odblokowuje');
  });

  test('metryka bez ani jednej liczby nie blokuje na zawsze', () => {
    // Agregat takiej metryki nie policzy, więc wymaganie od niej pokrycia zamroziłoby
    // przycinanie — a ta metryka i tak nie niesie wyniku.
    const h = historia(KEEP + 1);
    h.lab.push([znacznik(1), A, 'mobile', 1, 'TBT', '', 'PSI_LAB', '2026-09-13', 'cykliczny']);
    const gas = project(h);
    assert.equal(plain(gas.planLabCleanup_()).trimmed, 1);
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
    assert.equal(
      gas.performanceCanonicalDate_('2026-09-01 06:00', gas.$get('PERF_CANONICAL_MEASUREMENT'), 'Europe/Warsaw'),
      '2026-09-01 06:00:00'
    );
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

describe('#152: usuwanie idzie pod tą samą blokadą co pomiar', () => {
  const SNAP = 'WP SNAPSHOTS';
  const RES = 'WP RESULTS';

  // Kolumna daty to INDEKS 9 w obu zakładkach (`rowOlderThan_`), nie pierwszy z brzegu —
  // fixture z datą gdzie indziej planuje zero usunięć i test blokady niczego nie dowodzi.
  const dawno = () => new Date(Date.now() - 400 * 86400000);
  const snap = (id, page) => [id, 'CMD', page, 'slug', 'T', 'E', 'C', 'publish', '', dawno(), '', '', 'TRUE', 'PAGE', '', '', 'FALSE'];
  const res = id => [id, 'CMD', 7, 'slug', 'publish', '', 'T', '', '', dawno(), '', '', 'PAGE'];
  /** Snapshoty i wyniki też mają co usunąć — bez tego test blokady niczego nie dowodzi. */
  const zProbami = (opts = {}) => {
    const h = historia(KEEP + 1);
    const snapshoty = [['id', 'action', 'page', 'slug', 'title', 'excerpt', 'content', 'status', '', 'created_at', '', '', 'confirm', 'type', '', '', 'flag']];
    for (let i = 0; i < 8; i++) snapshoty.push(snap('S' + i, 'https://www.example.pl/x/'));
    return loadProject(Object.assign({
      properties: {},
      sheets: {
        [LAB]: [LAB_HEADER].concat(h.lab),
        [SUMMARY]: [SUMMARY_HEADER].concat(h.summary),
        [SNAP]: snapshoty,
        [RES]: [['id', 'action', 'target', 'slug', 'field', 'value', 'result', '', '', 'done_at', '', '', 'type'], res('R1')]
      },
      fetch: () => ({ code: 404, text: '{}' })
    }, opts));
  };

  test('usunięcie zakłada blokadę i ją zwalnia', () => {
    const gas = zProbami();
    gas.$ui.$answer = 'YES';
    const out = plain(gas.wyczyscStareSnapshotyIWyniki());

    assert.ok(out.snapshots > 0, 'fixture naprawdę ma co usunąć: ' + JSON.stringify(out));
    assert.equal(out.lab, 3, 'trzy wiersze najstarszego przebiegu');
    const operacje = gas.$lock.map(entry => entry[0]);
    assert.ok(operacje.indexOf('tryLock') >= 0, 'blokada założona: ' + JSON.stringify(gas.$lock));
    assert.equal(operacje[operacje.length - 1], 'releaseLock', 'i zwolniona');
  });

  test('zajęta blokada nie usuwa niczego', () => {
    const gas = zProbami({ lockHeld: true });
    gas.$ui.$answer = 'YES';

    const snapshotyPrzed = gas.$sheet(SNAP).length;
    const wynikiPrzed = gas.$sheet(RES).length;

    assert.throws(() => gas.wyczyscStareSnapshotyIWyniki(), /Inne uruchomienie jeszcze trwa/);

    assert.equal(gas.$sheet(LAB).length, 1 + (KEEP + 1) * 3, 'surowe próby na miejscu');
    assert.equal(gas.$sheet(SNAP).length, snapshotyPrzed, 'snapshoty też — blokada jest PRZED każdym usunięciem');
    assert.equal(gas.$sheet(RES).length, wynikiPrzed, 'i wyniki');
  });
});

describe('#152: usuwanie mieści się w limicie czasu', () => {
  test('sąsiadujące wiersze kasowane zakresem, nie po jednym', () => {
    // „PAGESPEED LAB” rośnie najszybciej ze wszystkich zakładek, więc przycinanie
    // dotyczy setek albo tysięcy wierszy. Jedno wywołanie usługi na wiersz wyczerpuje
    // okno wykonania i zostawia plan skasowany połowicznie, bez raportu.
    const gas = project(historia(KEEP + 3));
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    const wywolania = [];
    const oryginal = sheet.deleteRows;
    sheet.deleteRows = function (row, n) {
      wywolania.push([row, n]);
      return oryginal.call(sheet, row, n);
    };

    const plan = plain(gas.planLabCleanup_());
    assert.equal(plan.remove.length, 9, 'dziewięć sąsiadujących wierszy');
    const usuniete = gas.deleteSheetRows_(sheet, plan.remove);

    assert.equal(usuniete, 9);
    assert.deepEqual(wywolania, [[2, 9]], 'jedno wywołanie na cały zakres');
    assert.equal(gas.$sheet(LAB).length, 1 + KEEP * 3, 'zostały wyłącznie najnowsze przebiegi');
  });

  test('rozłączne zakresy kasowane od dołu, każdy jednym wywołaniem', () => {
    const gas = project(historia(KEEP));
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    const wywolania = [];
    const oryginal = sheet.deleteRows;
    sheet.deleteRows = function (row, n) {
      wywolania.push([row, n]);
      return oryginal.call(sheet, row, n);
    };

    // Wiersze 2-3 oraz 6, podane w losowej kolejności i z duplikatem.
    const usuniete = gas.deleteSheetRows_(sheet, [6, 2, 3, 6]);

    assert.equal(usuniete, 3, 'duplikat policzony raz');
    assert.deepEqual(wywolania, [[6, 1], [2, 2]], 'od dołu, żeby numery się nie przesunęły');
  });
});
