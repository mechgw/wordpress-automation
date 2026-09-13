/**
 * Jednorazowa kanonizacja znacznika `Pomiar` w zakładkach PSI (#168).
 *
 * Ustawienie kolumnie formatu tekstowego NIE konwertuje komórek zapisanych
 * wcześniej jako data — one zostają datą aż do przepisania. Dlatego samo
 * poprawienie ścieżki zapisu nie wystarcza: historia dalej trzymałaby dwa typy,
 * a kryterium „zakładki dają się połączyć po kluczu” dotyczy też formuł
 * w arkuszu i eksportów, czyli konsumentów spoza tego kodu.
 *
 * Migracja jest osobną, jawną komendą menu, a nie efektem ubocznym pomiaru:
 * przepisanie trzech zakładek (samo „PAGESPEED LAB” to tysiące wierszy) zjadłoby
 * budżet czasu przebiegu PSI, zanim poszłoby pierwsze zapytanie.
 */

/** Wersja, nie flaga: następna migracja tej kolumny nie będzie zgadywać, czy ta poszła. */
const PERF_MIGRATION_PROP = 'POMIAR_CANONICAL_MIGRATION';
const PERF_MIGRATION_VERSION = 1;

/**
 * Zakładki objęte migracją — wszystkie trzy z kolumną `Pomiar`.
 *
 * „PAGESPEED FINDINGS” jest tu wymieniona osobno, bo nie idzie przez upsert:
 * pominięcie jej zostawiłoby ustalenia niezłączalne z metrykami, czyli dokładnie
 * tę szkodę, o którą chodzi.
 *
 * Funkcja, nie stała: nagłówki są w innym pliku, a Apps Script ładuje pliki
 * w kolejności projektu, więc stała na górze tego pliku mogłaby powstać, zanim
 * tamte istnieją.
 */
function perfMigrationSheets_() {
  return [
    { name: PERF_LAB_SHEET, header: PERF_LAB_HEADER },
    { name: PERF_FINDINGS_SHEET, header: PERF_FINDINGS_HEADER },
    { name: PERF_SUMMARY_SHEET, header: PERF_SUMMARY_HEADER }
  ];
}

/**
 * Stan migracji: `zakładka → ukończona wersja`.
 *
 * Uszkodzony zapis czytamy jako „nic nie zmigrowano”, a nie jako błąd: migracja
 * jest idempotentna, więc powtórzenie jej kosztuje przebieg, a nie dane —
 * przeciwnie niż uznanie niepewnego stanu za ukończony.
 */
function perfMigrationState_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty(PERF_MIGRATION_PROP) || '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function savePerfMigrationState_(state) {
  PropertiesService.getScriptProperties().setProperty(PERF_MIGRATION_PROP, JSON.stringify(state));
}

function perfMigrationDone_(state, name) {
  return Number(state[name]) >= PERF_MIGRATION_VERSION;
}

/**
 * Ile wierszy w której zakładce zostanie przepisanych — LICZONE PRZED zmianą,
 * żeby dialog mówił, na co operator się zgadza.
 *
 * Zakładka oznaczona aktualną wersją NIE jest czytana: ponowne uruchomienie ma
 * być no-opem, a nie przemiałem kilku tysięcy wierszy dla potwierdzenia, że nie
 * ma nic do roboty.
 */
function perfMigrationPlan_() {
  const state = perfMigrationState_();
  const timeZone = performanceTimeZone_();
  const ss = SpreadsheetApp.getActive();
  const sheets = perfMigrationSheets_().map(function (entry) {
    if (perfMigrationDone_(state, entry.name)) {
      return { name: entry.name, done: true, exists: true, rows: 0, changed: 0 };
    }
    const sheet = ss.getSheetByName(entry.name);
    const lastRow = sheet ? sheet.getLastRow() : 0;
    if (!sheet || lastRow < 2) {
      return { name: entry.name, done: false, exists: Boolean(sheet), rows: 0, changed: 0 };
    }
    const column = entry.header.indexOf(PERF_MEASUREMENT_COLUMN);
    const values = sheet.getRange(2, column + 1, lastRow - 1, 1).getValues();
    let changed = 0;
    values.forEach(function (row) {
      if (!perfValueIsCanonical_(row[0], timeZone)) changed++;
    });
    return { name: entry.name, done: false, exists: true, rows: values.length, changed: changed };
  });

  const pending = sheets.filter(function (s) { return !s.done; });
  return {
    sheets: sheets,
    pending: pending.length,
    changed: pending.reduce(function (sum, s) { return sum + s.changed; }, 0)
  };
}

/**
 * Czy wartość jest już kanoniczna.
 *
 * Musi BYĆ tekstem, nie dać się na niego sprowadzić: data sformatowana do tego
 * samego łańcucha nadal jest datą i nadal rozjeżdża klucz po stronie arkusza.
 */
function perfValueIsCanonical_(value, timeZone) {
  return typeof value === 'string' &&
    value === performanceCanonicalDate_(value, PERF_CANONICAL_MEASUREMENT, timeZone);
}

/**
 * Przepisanie jednej zakładki. Zwraca liczbę zmienionych wartości.
 *
 * Format tekstowy ustawiamy ZAWSZE, także gdy żadna wartość nie wymaga zmiany:
 * bez niego kolumna zbiera dwa typy przy następnym zapisie, a wtedy migracja
 * wyleczyłaby objaw na jeden przebieg.
 */
function migratePerfSheet_(entry, timeZone) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(entry.name);
  if (!sheet) return { rows: 0, changed: 0 };
  const lastRow = sheet.getLastRow();
  const width = entry.header.length;
  const values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];

  let changed = 0;
  const column = entry.header.indexOf(PERF_MEASUREMENT_COLUMN);
  values.forEach(function (row) {
    if (!perfValueIsCanonical_(row[column], timeZone)) changed++;
  });

  // `perfCanonicalMeasurementRows_` ustawia format PRZED zapisem i kanonizuje
  // wartości — ta sama funkcja co w ścieżce zapisu, żeby „kanoniczny” znaczyło
  // w migracji dokładnie to samo co w pomiarze.
  const rows = perfCanonicalMeasurementRows_(sheet, entry.header, values, timeZone);
  if (changed) writeRowsThenTrim_(sheet, width, rows, lastRow);
  return { rows: values.length, changed: changed };
}

/**
 * Menu: kanonizacja znaczników `Pomiar` po potwierdzeniu.
 *
 * Zakładka dostaje znacznik wersji dopiero PO udanym zapisie całej zakładki.
 * Błąd w połowie zostawia ją nieoznaczoną, więc kolejne uruchomienie ją powtórzy;
 * powtórzenie jest bezpieczne, bo wartość już kanoniczna nie jest ruszana.
 */
function kanonizujZnacznikiPomiaru() {
  const ui = SpreadsheetApp.getUi();
  const NEWLINE = String.fromCharCode(10);
  const plan = perfMigrationPlan_();

  if (!plan.pending) {
    ui.alert('Znaczniki „' + PERF_MEASUREMENT_COLUMN + '” są już skanonizowane we wszystkich ' +
      plan.sheets.length + ' zakładkach (wersja ' + PERF_MIGRATION_VERSION + ').' + NEWLINE +
      'Nic nie zostało odczytane ani zapisane.');
    return { sheets: 0, changed: 0 };
  }

  const detail = plan.sheets.map(function (s) {
    if (s.done) return '• ' + s.name + ': już zmigrowana';
    if (!s.exists) return '• ' + s.name + ': zakładka nie istnieje — nie ma czego przepisywać';
    return '• ' + s.name + ': ' + s.changed + ' z ' + s.rows + ' wierszy do przepisania';
  }).join(NEWLINE);

  const answer = ui.alert(
    'Przepisać kolumnę „' + PERF_MEASUREMENT_COLUMN + '” w ' + plan.pending + ' zakładce(ach)?' +
    NEWLINE + NEWLINE + detail + NEWLINE + NEWLINE +
    'Zmienia się WYŁĄCZNIE postać zapisu: data w komórce staje się tekstem ' +
    '„' + PERF_CANONICAL_MEASUREMENT + '” w strefie arkusza. Żadna zapisana chwila, ' +
    'żadna inna kolumna ani kolejność wierszy się nie zmienia.',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) {
    ui.alert('Anulowano. Nic nie zostało zmienione.');
    return { sheets: 0, changed: 0 };
  }

  // Blokada ta sama, którą trzyma pomiar: migracja i przebieg nie mogą pisać do
  // tej samej zakładki naraz. Plan liczymy pod blokadą od nowa — nie ograniczamy
  // go jednak do tego, co operator zobaczył, bo migracja niczego nie usuwa,
  // a wiersz dopisany w międzyczasie ma być skanonizowany tak samo jak reszta.
  const result = withScriptLock_('kanonizacja znaczników ' + PERF_MEASUREMENT_COLUMN, function () {
    const timeZone = performanceTimeZone_();
    const state = perfMigrationState_();
    const done = [];
    let changed = 0;
    perfMigrationSheets_().forEach(function (entry) {
      if (perfMigrationDone_(state, entry.name)) return;
      changed += migratePerfSheet_(entry, timeZone).changed;
      // Znacznik po zapisie CAŁEJ zakładki i zapisany od razu: przerwanie przy
      // następnej zostawia tę ukończoną oznaczoną, a nie do powtórzenia.
      state[entry.name] = PERF_MIGRATION_VERSION;
      savePerfMigrationState_(state);
      done.push(entry.name);
    });
    return { sheets: done.length, changed: changed };
  });

  ui.alert('Skanonizowano ' + result.changed + ' znacznik(ów) w ' + result.sheets +
    ' zakładce(ach).' + NEWLINE + perfMigrationStatusLine_());
  return result;
}

/**
 * Jedna linia do „Status danych”.
 *
 * Migracja uruchamiana ręcznie, o której nigdzie nie widać, czy poszła, to
 * migracja, o której się zapomina. Linia czyta wyłącznie Script Properties —
 * status nie może kosztować odczytu kilku tysięcy wierszy.
 */
function perfMigrationStatusLine_() {
  const state = perfMigrationState_();
  const all = perfMigrationSheets_().map(function (entry) { return entry.name; });
  const waiting = all.filter(function (name) { return !perfMigrationDone_(state, name); });
  const base = 'Kanonizacja „' + PERF_MEASUREMENT_COLUMN + '” (#168): zmigrowane ' +
    (all.length - waiting.length) + ' z ' + all.length + ' zakładek.';
  if (!waiting.length) return base;
  return base + ' Czekają: ' + waiting.join(', ') +
    ' — uruchamia „Kanonizuj znaczniki Pomiar”.';
}
