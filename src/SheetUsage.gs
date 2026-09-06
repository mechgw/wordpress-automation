/**
 * Zużycie arkusza i retencja zakładek, które rosną bez końca (#101).
 *
 * Arkusz Google ma twardy limit 10 mln komórek na CAŁY plik, dzielony przez
 * wszystkie zakładki. Po jego przekroczeniu przestaje działać nie jedna funkcja,
 * tylko cały arkusz: importy, monitoring i komendy naraz. Dlatego zajętość musi
 * być widoczna, zanim zrobi się problemem.
 *
 * Rosną tylko trzy zakładki dopisywane wierszami: IMPORT LOG (ma własną
 * retencję 90 dni), WP RESULTS i WP SNAPSHOTS. SEO LIVE, URL INSPEKCJA
 * i RECRAWL QUEUE mają jeden wiersz na adres, aktualizowany w miejscu, więc
 * rosną tylko wraz z serwisem i retencji nie potrzebują.
 *
 * Czyszczenie NIE jest automatyczne. Snapshot jest siatką bezpieczeństwa dla
 * rollbacku, a jego skasowanie jest nieodwracalne, więc usuwa je wyłącznie
 * człowiek z menu, po zobaczeniu dokładnej liczby wierszy do usunięcia.
 */

/** Limit komórek na plik. Google liczy całą siatkę, nie tylko wypełnione komórki. */
const SPREADSHEET_CELL_LIMIT = 10000000;
const SHEET_USAGE_WARN_RATIO = 0.7;
const SHEET_USAGE_CRITICAL_RATIO = 0.9;

/** Snapshoty: ile najnowszych zostaje na stronę i czego nie ruszamy nigdy. */
const SNAPSHOT_KEEP_PER_PAGE = 5;
const SNAPSHOT_KEEP_MIN_DAYS = 30;
/** Wyniki są informacyjne, więc wystarczy próg wieku. */
const RESULTS_KEEP_DAYS = 180;

/** Zajętość komórek per zakładka, posortowana malejąco. */
function sheetUsage_() {
  const sheets = SpreadsheetApp.getActive().getSheets().map(sheet => {
    const rows = sheet.getMaxRows();
    const cols = sheet.getMaxColumns();
    return { name: sheet.getName(), rows: rows, cols: cols, cells: rows * cols };
  });
  const cells = sheets.reduce((sum, s) => sum + s.cells, 0);
  sheets.sort((a, b) => b.cells - a.cells);
  return {
    sheets: sheets,
    cells: cells,
    limit: SPREADSHEET_CELL_LIMIT,
    ratio: cells / SPREADSHEET_CELL_LIMIT,
    level: cells >= SPREADSHEET_CELL_LIMIT * SHEET_USAGE_CRITICAL_RATIO
      ? 'KRYTYCZNE'
      : (cells >= SPREADSHEET_CELL_LIMIT * SHEET_USAGE_WARN_RATIO ? 'UWAGA' : 'OK')
  };
}

/** Jedna linia do „Status danych”: stan i procent zajętości pliku. */
function sheetUsageLine_() {
  const usage = sheetUsage_();
  return 'Zajętość arkusza: ' + usage.level + ' – ' +
    Math.round(usage.ratio * 1000) / 10 + '% limitu (' +
    usage.cells + ' z ' + usage.limit + ' komórek).';
}

/** Czy wiersz jest starszy niż `days`; kolumna „at” to 10. w obu zakładkach. */
function rowOlderThan_(values, days, now) {
  const at = values[9];
  const time = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!time || isNaN(time)) return false;
  return (now.getTime() - time) > days * 86400 * 1000;
}

/**
 * Plan czyszczenia snapshotów: numery wierszy do usunięcia. Zasady, od
 * najostrożniejszej: snapshot młodszy niż SNAPSHOT_KEEP_MIN_DAYS zostaje
 * zawsze, a poza tym zostaje SNAPSHOT_KEEP_PER_PAGE najnowszych na stronę.
 * Wiersz bez czytelnej daty jest traktowany jak świeży i nie jest usuwany.
 */
function planSnapshotCleanup_(now) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(WP_SNAPSHOTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { remove: [], keep: 0, pages: 0 };

  const width = Math.max(10, sheet.getLastColumn());
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const byPage = {};

  values.forEach(function (row, i) {
    const page = String(row[2] || '(brak)');
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push({ row: i + 2, values: row });
  });

  const remove = [];
  let keep = 0;
  Object.keys(byPage).forEach(function (page) {
    // Najnowsze pierwsze: wiersze są dopisywane chronologicznie.
    const rows = byPage[page].slice().reverse();
    rows.forEach(function (entry, index) {
      const youngEnough = !rowOlderThan_(entry.values, SNAPSHOT_KEEP_MIN_DAYS, now);
      if (index < SNAPSHOT_KEEP_PER_PAGE || youngEnough) { keep++; return; }
      remove.push(entry.row);
    });
  });

  remove.sort(function (a, b) { return a - b; });
  return { remove: remove, keep: keep, pages: Object.keys(byPage).length };
}

/** Plan czyszczenia wyników: wszystko starsze niż RESULTS_KEEP_DAYS. */
function planResultsCleanup_(now) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(WP_RESULTS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return { remove: [], keep: 0 };

  const width = Math.max(10, sheet.getLastColumn());
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const remove = [];
  let keep = 0;
  values.forEach(function (row, i) {
    if (rowOlderThan_(row, RESULTS_KEEP_DAYS, now)) remove.push(i + 2);
    else keep++;
  });
  return { remove: remove, keep: keep };
}

/** Usuwa wiersze od dołu, żeby numery pozostałych nie przesuwały się w trakcie. */
function deleteSheetRows_(sheet, rows) {
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (row) {
    sheet.deleteRows(row, 1);
  });
  return rows.length;
}

/** Menu: zajętość arkusza, największe zakładki i plan czyszczenia. */
function pokazZajetoscArkusza() {
  const usage = sheetUsage_();
  const lines = [sheetUsageLine_(), ''];
  usage.sheets.slice(0, 12).forEach(function (s) {
    lines.push(s.name + ': ' + s.cells + ' komórek (' + s.rows + ' x ' + s.cols + ')');
  });
  if (usage.sheets.length > 12) {
    lines.push('… i ' + (usage.sheets.length - 12) + ' mniejszych zakładek.');
  }

  const now = new Date();
  const snapshots = planSnapshotCleanup_(now);
  const results = planResultsCleanup_(now);
  lines.push('');
  lines.push('Do wyczyszczenia: ' + snapshots.remove.length + ' snapshot(ów) i ' + results.remove.length + ' wynik(ów).');
  lines.push('Snapshot młodszy niż ' + SNAPSHOT_KEEP_MIN_DAYS + ' dni zostaje zawsze, podobnie ' +
    SNAPSHOT_KEEP_PER_PAGE + ' najnowszych na stronę.');
  lines.push('Wyniki starsze niż ' + RESULTS_KEEP_DAYS + ' dni są usuwane.');
  lines.push('Czyszczenie uruchamia „Wyczyść stare snapshoty i wyniki”.');
  SpreadsheetApp.getUi().alert(lines.join('\n'));
  return usage;
}

/**
 * Menu: czyszczenie po potwierdzeniu. Dialog podaje dokładne liczby PRZED
 * usunięciem, bo snapshotów nie da się odtworzyć.
 */
function wyczyscStareSnapshotyIWyniki() {
  const ui = SpreadsheetApp.getUi();
  const now = new Date();
  const snapshots = planSnapshotCleanup_(now);
  const results = planResultsCleanup_(now);

  if (!snapshots.remove.length && !results.remove.length) {
    ui.alert('Nie ma czego czyścić. ' + sheetUsageLine_());
    return { snapshots: 0, results: 0 };
  }

  const answer = ui.alert(
    'Usunąć nieodwracalnie ' + snapshots.remove.length + ' snapshot(ów) i ' +
    results.remove.length + ' wynik(ów)?\n\n' +
    'Zostanie ' + snapshots.keep + ' snapshot(ów) dla ' + snapshots.pages + ' stron(y) i ' +
    results.keep + ' wynik(ów).\n' +
    'Snapshot młodszy niż ' + SNAPSHOT_KEEP_MIN_DAYS + ' dni oraz ' + SNAPSHOT_KEEP_PER_PAGE +
    ' najnowszych na stronę nie są usuwane.',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) {
    ui.alert('Anulowano. Nic nie zostało usunięte.');
    return { snapshots: 0, results: 0 };
  }

  const ss = SpreadsheetApp.getActive();
  const removedSnapshots = snapshots.remove.length
    ? deleteSheetRows_(ss.getSheetByName(WP_SNAPSHOTS_SHEET), snapshots.remove)
    : 0;
  const removedResults = results.remove.length
    ? deleteSheetRows_(ss.getSheetByName(WP_RESULTS_SHEET), results.remove)
    : 0;

  ui.alert('Usunięto ' + removedSnapshots + ' snapshot(ów) i ' + removedResults + ' wynik(ów).\n' + sheetUsageLine_());
  return { snapshots: removedSnapshots, results: removedResults };
}
