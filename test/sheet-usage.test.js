'use strict';

/**
 * #101: pomiar zajętości arkusza i retencja zakładek dopisywanych wierszami.
 * Arkusz ma twardy limit 10 mln komórek na cały plik; po jego przekroczeniu
 * przestaje działać wszystko naraz, więc zajętość musi być widoczna wcześniej.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SNAPSHOTS = 'WP SNAPSHOTS';
const RESULTS = 'WP RESULTS';
const SNAP_HEADER = ['snapshot_id', 'command_id', 'wp_id', 'slug', 'title', 'excerpt', 'content', 'status', 'modified', 'at', 'rm_title', 'rm_desc', 'rm_captured', 'snapshot_kind', 'media_before_json', 'rank_math_robots', 'rank_math_robots_captured'];
const RES_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];

const daysAgo = d => new Date(Date.now() - d * 86400 * 1000);
/** Wiersz snapshotu: liczy się kolumna 3 (wp_id) i 10 (at). */
const snap = (id, page, days) => [id, 'CMD', page, 'slug', 'T', 'E', 'C', 'publish', '', daysAgo(days), '', '', 'TRUE', 'PAGE', '', '', 'FALSE'];
const res = (id, days) => [id, 'CMD', 7, 'slug', 'publish', '', 'T', '', '', daysAgo(days), '', '', 'PAGE'];

function project(snapshots = [], results = [], answer) {
  const gas = loadProject({
    sheets: {
      [SNAPSHOTS]: [SNAP_HEADER, ...snapshots],
      [RESULTS]: [RES_HEADER, ...results]
    }
  });
  if (answer) gas.$ui.$answer = answer;
  return gas;
}

describe('#101: pomiar zajętości arkusza', () => {
  test('liczy całą siatkę każdej zakładki, sortuje malejąco i sumuje', () => {
    const gas = project();
    const usage = plain(gas.sheetUsage_());
    // Nowa zakładka w stubie ma 1000 x 26 komórek, jak w Arkuszach.
    assert.equal(usage.sheets.length, 2);
    assert.equal(usage.sheets[0].cells, 1000 * 26);
    assert.equal(usage.cells, 2 * 1000 * 26);
    assert.equal(usage.limit, 10000000);
  });

  test('poziom rośnie dopiero po przekroczeniu progów, nie przy pierwszej zakładce', () => {
    const gas = project();
    assert.equal(plain(gas.sheetUsage_()).level, 'OK');

    // 8 mln komórek to 80% limitu: ostrzeżenie, ale jeszcze nie stan krytyczny.
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(SNAPSHOTS);
    sheet.insertRowsAfter(sheet.getMaxRows(), 8000000 / 26 - sheet.getMaxRows());
    assert.equal(plain(gas.sheetUsage_()).level, 'UWAGA');

    sheet.insertRowsAfter(sheet.getMaxRows(), 2000000 / 26);
    assert.equal(plain(gas.sheetUsage_()).level, 'KRYTYCZNE');
  });

  test('linia statusu podaje poziom i procent limitu', () => {
    const gas = project();
    assert.match(gas.sheetUsageLine_(), /^Zajętość arkusza: OK – 0\.5% limitu \(52000 z 10000000 komórek\)\.$/);
  });
});

describe('#101: plan czyszczenia snapshotów', () => {
  test('zostaje pięć najnowszych na stronę; starsze ponad ten limit idą do usunięcia', () => {
    const rows = [];
    for (let i = 1; i <= 8; i++) rows.push(snap('S' + i, 7, 200 - i));
    const gas = project(rows);
    const plan = plain(gas.planSnapshotCleanup_(new Date()));
    assert.equal(plan.keep, 5);
    assert.equal(plan.pages, 1);
    // Do usunięcia najstarsze trzy, czyli wiersze 2, 3 i 4.
    assert.deepEqual(plan.remove, [2, 3, 4]);
  });

  test('snapshot młodszy niż 30 dni nie jest usuwany, choćby był szósty z rzędu', () => {
    const rows = [];
    for (let i = 1; i <= 8; i++) rows.push(snap('S' + i, 7, 3));
    const gas = project(rows);
    const plan = plain(gas.planSnapshotCleanup_(new Date()));
    assert.deepEqual(plan.remove, [], 'świeże snapshoty są nietykalne');
    assert.equal(plan.keep, 8);
  });

  test('limit działa osobno na każdą stronę', () => {
    const rows = [];
    for (let i = 1; i <= 6; i++) rows.push(snap('A' + i, 7, 100));
    for (let i = 1; i <= 2; i++) rows.push(snap('B' + i, 9, 100));
    const gas = project(rows);
    const plan = plain(gas.planSnapshotCleanup_(new Date()));
    assert.equal(plan.pages, 2);
    assert.equal(plan.remove.length, 1, 'tylko nadmiarowy szósty snapshot strony 7');
    assert.equal(plan.keep, 7);
  });

  test('wiersz bez czytelnej daty jest traktowany jak świeży', () => {
    const rows = [];
    for (let i = 1; i <= 7; i++) {
      const row = snap('S' + i, 7, 100);
      if (i === 1) row[9] = '';
      rows.push(row);
    }
    const gas = project(rows);
    const plan = plain(gas.planSnapshotCleanup_(new Date()));
    assert.equal(plan.remove.includes(2), false, 'wiersz bez daty zostaje');
  });

  test('pusta zakładka i brak zakładki nie są błędem', () => {
    assert.deepEqual(plain(project().planSnapshotCleanup_(new Date())).remove, []);
    const bare = loadProject({ sheets: {} });
    assert.deepEqual(plain(bare.planSnapshotCleanup_(new Date())).remove, []);
    assert.deepEqual(plain(bare.planResultsCleanup_(new Date())).remove, []);
  });
});

describe('#101: plan czyszczenia wyników', () => {
  test('usuwa wyłącznie wyniki starsze niż 180 dni', () => {
    const gas = project([], [res('R1', 200), res('R2', 179), res('R3', 400)]);
    const plan = plain(gas.planResultsCleanup_(new Date()));
    assert.deepEqual(plan.remove, [2, 4]);
    assert.equal(plan.keep, 1);
  });
});

describe('#101: czyszczenie wymaga potwierdzenia', () => {
  const oldSnapshots = () => {
    const rows = [];
    for (let i = 1; i <= 8; i++) rows.push(snap('S' + i, 7, 200 - i));
    return rows;
  };

  test('odpowiedź NO nie usuwa niczego', () => {
    const gas = project(oldSnapshots(), [res('R1', 400)], 'NO');
    const out = plain(gas.wyczyscStareSnapshotyIWyniki());
    assert.deepEqual(out, { snapshots: 0, results: 0 });
    assert.equal(gas.$sheet(SNAPSHOTS).length, 9, 'wszystkie wiersze na miejscu');
    assert.match(gas.$alerts[1][0], /Anulowano/);
  });

  test('odpowiedź YES usuwa dokładnie zaplanowane wiersze, licząc od dołu', () => {
    const gas = project(oldSnapshots(), [res('R1', 400), res('R2', 10)], 'YES');
    const out = plain(gas.wyczyscStareSnapshotyIWyniki());
    assert.deepEqual(out, { snapshots: 3, results: 1 });
    const left = gas.$sheet(SNAPSHOTS).slice(1).map(r => r[0]);
    assert.deepEqual(left, ['S4', 'S5', 'S6', 'S7', 'S8'], 'zostają najnowsze, a nie przypadkowe');
    assert.deepEqual(gas.$sheet(RESULTS).slice(1).map(r => r[0]), ['R2']);
  });

  test('dialog podaje liczby przed usunięciem, bo snapshotów nie da się odtworzyć', () => {
    const gas = project(oldSnapshots(), [], 'NO');
    gas.wyczyscStareSnapshotyIWyniki();
    const question = gas.$alerts[0].join(' ');
    assert.match(question, /Usunąć nieodwracalnie 3 snapshot\(ów\) i 0 wynik\(ów\)\?/);
    assert.match(question, /Zostanie 5 snapshot\(ów\) dla 1 stron\(y\)/);
    assert.equal(gas.$alerts[0][1], 'YES_NO', 'dialog z przyciskami TAK/NIE, nie zwykły komunikat');
  });

  test('gdy nie ma czego czyścić, nie pyta i nic nie rusza', () => {
    const gas = project([snap('S1', 7, 1)], [res('R1', 1)], 'YES');
    const out = plain(gas.wyczyscStareSnapshotyIWyniki());
    assert.deepEqual(out, { snapshots: 0, results: 0 });
    assert.equal(gas.$alerts.length, 1);
    assert.match(gas.$alerts[0][0], /^Nie ma czego czyścić\./);
  });
});

describe('#118: przycinanie pustego przydziału wierszy', () => {
  /** Zakładka z `filled` wierszami danych w siatce na `maxRows`. */
  function wide(filled, maxRows, cols) {
    const rows = [];
    for (let i = 0; i < filled; i++) rows.push(new Array(cols || 10).fill('x'));
    return { rows: rows, maxRows: maxRows, maxColumns: cols || 10 };
  }

  const project = (sheets, answer) => {
    const gas = loadProject({ sheets: sheets });
    if (answer) gas.$ui.$answer = answer;
    return gas;
  };

  test('plan wskazuje zakładki z dużym pustym przydziałem i liczy zysk w komórkach', () => {
    const gas = project({ 'GSC RAW': wide(6545, 100000, 12), 'START': wide(50, 1000, 26) });
    const plan = plain(gas.planRowTrim_());
    assert.equal(plan.sheets.length, 1, 'zakładka bez nadmiaru nie trafia do planu');
    assert.equal(plan.sheets[0].name, 'GSC RAW');
    assert.equal(plan.sheets[0].lastRow, 6545);
    assert.equal(plan.sheets[0].keep, 8545, 'dane plus 2000 wierszy zapasu');
    assert.equal(plan.sheets[0].remove, 91455);
    assert.equal(plan.cells, 91455 * 12);
  });

  test('problem nie dotyczy jednej zakładki: plan obejmuje wszystkie i sortuje po zysku', () => {
    const gas = project({
      'GSC RAW': wide(6545, 100000, 12),
      'GA4 RAW': wide(4000, 100000, 16),
      'GA4 ADS RAW': wide(0, 100000, 14)
    });
    const plan = plain(gas.planRowTrim_());
    assert.deepEqual(plan.sheets.map(s => s.name), ['GA4 RAW', 'GA4 ADS RAW', 'GSC RAW'], 'najpierw największy zysk');
    assert.equal(plan.cells, 3973460, 'razem blisko cztery miliony komórek do odzyskania');
  });

  test('zakładka bez nadmiaru i zakładka ciasno zapełniona są pomijane', () => {
    const gas = project({ 'Mała': wide(50, 1000, 26), 'Pełna': wide(9000, 10000, 12) });
    assert.deepEqual(plain(gas.planRowTrim_()).sheets, [], 'poniżej 1000 zbędnych wierszy nie warto ruszać');
  });

  /** Zakładka, w której wartości kończą się wcześnie, ale zakres danych sięga niżej. */
  function padded(filled, padTo, maxRows, cols) {
    const rows = [];
    for (let i = 0; i < filled; i++) rows.push(new Array(cols).fill('x'));
    for (let i = filled; i < padTo; i++) rows.push(new Array(cols).fill(''));
    return { rows: rows, maxRows: maxRows, maxColumns: cols };
  }

  test('#118: zawyżony getLastRow nie wyklucza zakładki; liczy się ostatnia realna treść', () => {
    // Tak wygląda GSC RAW: wartości do 6545, ale arkusz raportuje koniec danych
    // na wierszu 100000, bo sięga tam formatowanie po dawnych importach.
    const gas = project({ 'GSC RAW': padded(6545, 100000, 100000, 12) });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName('GSC RAW');
    assert.equal(sheet.getLastRow(), 100000, 'arkusz sam uważa, że dane sięgają dołu');
    assert.equal(gas.lastContentRow_(sheet), 6545, 'a realna treść kończy się dużo wyżej');

    const plan = plain(gas.planRowTrim_());
    assert.equal(plan.sheets.length, 1, 'zakładka trafia do planu mimo zawyżonego zakresu');
    assert.equal(plan.sheets[0].keep, 8545);
    assert.equal(plan.sheets[0].cells, 91455 * 12);
  });

  test('#118: formuła dająca pusty tekst jest treścią i wyznacza granicę cięcia', () => {
    const rows = [];
    for (let i = 0; i < 12000; i++) rows.push(['', '']);
    rows[0] = ['x', ''];
    const formulas = [];
    for (let i = 0; i < 12000; i++) formulas.push(['', '']);
    formulas[9000] = ['', '=IF(A1="";"";A1)'];
    const gas = project({ 'Raport': { rows: rows, formulas: formulas, maxRows: 100000, maxColumns: 2 } });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName('Raport');
    assert.equal(gas.lastContentRow_(sheet), 9001, 'formuła licząca się do pustego nie jest pustką');
    assert.equal(plain(gas.planRowTrim_()).sheets[0].keep, 11001);
  });

  test('#118: zakładka zupełnie pusta nie wywraca skanowania', () => {
    const gas = project({ 'Pusta': { rows: [], maxRows: 50000, maxColumns: 5 } });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName('Pusta');
    assert.equal(gas.lastContentRow_(sheet), 0);
    assert.equal(plain(gas.planRowTrim_()).sheets[0].keep, 2000);
  });

  test('odpowiedź NIE nie usuwa niczego', () => {
    const gas = project({ 'GSC RAW': wide(100, 100000, 12) }, 'NO');
    const out = plain(gas.przytnijPusteWiersze());
    assert.deepEqual(out, { sheets: 0, rows: 0, cells: 0 });
    assert.equal(gas.SpreadsheetApp.getActive().getSheetByName('GSC RAW').getMaxRows(), 100000);
  });

  test('odpowiedź TAK przycina siatkę i nie rusza ani jednego wiersza z danymi', () => {
    const gas = project({ 'GSC RAW': wide(6545, 100000, 12) }, 'YES');
    const before = gas.$sheet('GSC RAW').length;
    const out = plain(gas.przytnijPusteWiersze());
    assert.equal(out.rows, 91455);
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName('GSC RAW');
    assert.equal(sheet.getMaxRows(), 8545, 'zostaje ostatni wiersz danych plus zapas');
    assert.equal(gas.$sheet('GSC RAW').length, before, 'żaden wiersz z danymi nie zniknął');
    assert.equal(sheet.getLastRow(), 6545);
  });

  test('dialog wymienia zakładki, zysk i ostrzega o formułach', () => {
    const gas = project({ 'GSC RAW': wide(6545, 100000, 12) }, 'NO');
    gas.przytnijPusteWiersze();
    const question = gas.$alerts[0][0];
    assert.match(question, /GSC RAW: 100000 → 8545 wierszy \(dane do 6545\)/);
    assert.match(question, /Zwolni to 1097460 komórek/);
    assert.match(question, /żadna dana nie ginie/);
    assert.match(question, /pokaże po tym #REF!/);
    assert.equal(gas.$alerts[0][1], 'YES_NO');
  });

  test('gdy nie ma czego przycinać, nie pyta i nic nie rusza', () => {
    const gas = project({ 'START': wide(50, 1000, 26) }, 'YES');
    const out = plain(gas.przytnijPusteWiersze());
    assert.deepEqual(out, { sheets: 0, rows: 0, cells: 0 });
    assert.equal(gas.$alerts.length, 1);
    assert.match(gas.$alerts[0][0], /^Nie ma czego przycinać\./);
  });
});

describe('#118: wykrywanie odwołań do usuwanego obszaru', () => {
  const limits = { 'GSC RAW': { keep: 8545 }, 'GA4 RAW': { keep: 3315 } };
  const risky = f => plain(loadProject({}).riskyReferences_(f, limits));

  test('zakres z wpisanym numerem wiersza poza granicą jest zgłaszany', () => {
    // Realna formuła z produkcji, która przeżyłaby przycięcie i dopiero po
    // kilku tygodniach zaczęłaby po cichu gubić nowe dni.
    const found = risky("=MAP(A2:A;LAMBDA(d;JEŻELI(d=\"\";\"\";SUMA.JEŻELI('GSC RAW'!L2:L100000;d;'GSC RAW'!F2:F100000))))");
    assert.equal(found.length, 2, 'oba zakresy w jednej formule');
    assert.deepEqual(found[0], { target: 'GSC RAW', bound: 100000, keep: 8545 });
  });

  test('zakres otwarty jest bezpieczny i nie jest zgłaszany', () => {
    assert.deepEqual(risky("=SUMA.JEŻELI('GSC RAW'!L2:L;d;'GSC RAW'!F2:F)"), []);
    assert.deepEqual(risky("=SUMA('GSC RAW'!F:F)"), []);
  });

  test('zakres mieszczący się w tym, co zostaje, nie jest zgłaszany', () => {
    assert.deepEqual(risky("=SUMA('GSC RAW'!F2:F8000)"), [], 'poniżej granicy 8545');
  });

  test('odwołanie do pojedynczej komórki poza granicą jest zgłaszane', () => {
    const found = risky("='GA4 RAW'!B90000");
    assert.equal(found.length, 1);
    assert.equal(found[0].bound, 90000);
  });

  test('nazwa bez apostrofów też jest rozpoznawana', () => {
    const gas = loadProject({});
    const found = plain(gas.riskyReferences_('=SUM(Dane!A2:A99999)', { Dane: { keep: 100 } }));
    assert.equal(found.length, 1);
    assert.equal(found[0].target, 'Dane');
  });

  test('odwołanie do zakładki, której nie przycinamy, jest ignorowane', () => {
    assert.deepEqual(risky("=SUMA('SEO Calc'!F2:F100000)"), [], 'ta zakładka nie jest w planie');
  });

  test('plan wskazuje konkretną komórkę z ryzykownym odwołaniem', () => {
    const rows = [['nagłówek', 'nagłówek'], ['x', '']];
    const formulas = [['', ''], ['', "=SUMA.JEŻELI('GSC RAW'!L2:L100000;A2;'GSC RAW'!F2:F100000)"]];
    const gas = loadProject({
      sheets: {
        'GSC RAW': { rows: [['a']], maxRows: 100000, maxColumns: 12 },
        'SEO Calc': { rows: rows, formulas: formulas, maxRows: 5000, maxColumns: 2 }
      }
    });
    const risks = plain(gas.planReferenceRisks_(plain(gas.planRowTrim_())));
    assert.equal(risks.length, 2);
    assert.equal(risks[0].where, 'SEO Calc!B2');
    assert.equal(risks[0].target, 'GSC RAW');
  });

  test('dialog wymienia znalezione odwołania i mówi, że nic nie pęknie od razu', () => {
    const formulas = [['', ''], ['', "=SUMA('GSC RAW'!F2:F100000)"]];
    const gas = loadProject({
      sheets: {
        'GSC RAW': { rows: [['a']], maxRows: 100000, maxColumns: 12 },
        'SEO Calc': { rows: [['n', 'n'], ['x', '']], formulas: formulas, maxRows: 5000, maxColumns: 2 }
      }
    });
    gas.$ui.$answer = 'NO';
    gas.przytnijPusteWiersze();
    const text = gas.$alerts[0][0];
    assert.match(text, /ZNALEZIONO 1 ODWOŁANIE\(A\) DO USUWANEGO OBSZARU/);
    assert.match(text, /• SEO Calc!B2 → GSC RAW do wiersza 100000 \(zostanie 2001\)/);
    assert.match(text, /nic od razu nie pęknie/);
    assert.match(text, /najpierw zamień te zakresy na otwarte/);
  });

  test('bez ryzykownych odwołań dialog zachowuje krótkie ostrzeżenie', () => {
    const gas = loadProject({ sheets: { 'GSC RAW': { rows: [['a']], maxRows: 100000, maxColumns: 12 } } });
    gas.$ui.$answer = 'NO';
    gas.przytnijPusteWiersze();
    const text = gas.$alerts[0][0];
    assert.doesNotMatch(text, /ZNALEZIONO/);
    assert.match(text, /Zakresy typu A2:A pozostają poprawne/);
  });
});

describe('#101: okno zajętości', () => {
  test('przy wielu zakładkach okno pokazuje dwanaście największych i liczbę reszty', () => {
    const sheets = {};
    for (let i = 1; i <= 15; i++) sheets['Zakładka ' + i] = [['a']];
    const gas = loadProject({ sheets: sheets });
    gas.pokazZajetoscArkusza();
    const text = gas.$alerts[0][0];
    assert.match(text, /… i 3 mniejszych zakładek\./);
    assert.equal(text.split('komórek (').length - 1, 12, 'wypisane dokładnie dwanaście zakładek');
  });

  test('wymienia zakładki, plan czyszczenia i zasadę retencji', () => {
    const rows = [];
    for (let i = 1; i <= 8; i++) rows.push(snap('S' + i, 7, 200 - i));
    const gas = project(rows, [res('R1', 400)]);
    gas.pokazZajetoscArkusza();
    const text = gas.$alerts[0][0];
    assert.match(text, /^Zajętość arkusza: OK – /);
    assert.match(text, /WP SNAPSHOTS: 26000 komórek \(1000 x 26\)/);
    assert.match(text, /Do wyczyszczenia: 3 snapshot\(ów\) i 1 wynik\(ów\)\./);
    assert.match(text, /Snapshot młodszy niż 30 dni zostaje zawsze, podobnie 5 najnowszych na stronę\./);
  });
});
