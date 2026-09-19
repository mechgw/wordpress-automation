/**
 * Status importów GSC i GA4.
 *
 * Każde uruchomienie importu (ręczne z menu albo z triggera) zostawia rekord
 * w Script Properties (LAST_IMPORT_GSC / LAST_IMPORT_GA4):
 *   { lastRun: {...}, lastOk: {...} }
 * gdzie run = { finishedAt, ok, trigger, rows, detail, warning, error, durationMs }.
 *
 * Na tej podstawie:
 *   - komórki Konfiguracja GSC!B8 i Konfiguracja GA4!B9 dostają jedną linię
 *     statusu czytelną także przez API arkusza (dla ludzi i agentów),
 *   - menu „Dane” → „Status danych” pokazuje szczegóły w oknie dialogowym.
 *
 * Format linii statusu:
 *   AKTYWNE – ostatni import: 2026-09-05 06:02 | 1234 wierszy | trigger: TAK
 *   BŁĄD 2026-09-06 06:01: <komunikat> | ostatni poprawny import: 2026-09-05 06:02 | trigger: TAK
 *   NIEAKTUALNE – ostatni import: 2026-09-01 06:02 | 1234 wierszy | trigger: NIE
 *   BRAK IMPORTU – uruchom import z menu | trigger: NIE
 * Prefiks NIEAKTUALNE pojawia się, gdy ostatni poprawny import jest starszy
 * niż IMPORT_STALE_AFTER_HOURS.
 */

const IMPORT_STALE_AFTER_HOURS = 36;
/**
 * Zadania tygodniowe: 8 dni. Doba zapasu wystarcza na przesunięcie okna
 * triggera i na jeden pominięty przebieg, a nie ukrywa zadania, które stanęło.
 */
const WEEKLY_STALE_AFTER_HOURS = 8 * 24;

/**
 * Historia runów (#43): zakładka IMPORT LOG dopisywana przy każdym uruchomieniu.
 * Anomalia liczby wierszy jest oceniana wyłącznie w obrębie tego samego
 * profilu: źródło + typ runu (trigger / ręczny) + liczba dni zakresu. Import
 * dzienny (1 dzień) nigdy nie jest porównywany z ręcznym importem 90 dni.
 */
const IMPORT_LOG_SHEET = 'IMPORT LOG';
// `Zakres danych` jest OSTATNIĄ kolumną (#180), żeby kolumny A–I istniejących
// zakładek nie zmieniły pozycji; istniejącej zakładce etykietę dopisuje
// `importLogRangeColumnReady_()`.
const IMPORT_LOG_HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga', 'Zakres danych'];
const IMPORT_LOG_RANGE_COL = IMPORT_LOG_HEADER.length;
const IMPORT_LOG_RETENTION_DAYS = 90;
// Liczba PRÓBEK profilu, a nie runów: po #180 kilka importów tego samego zakresu
// danych to jedna próbka (nazwa stałej zostaje, żeby nie mnożyć zmian).
const IMPORT_ANOMALY_MIN_RUNS = 7;

/** Definicje źródeł; funkcja (nie stała), bo stałe innych plików mogą nie być jeszcze załadowane. */
function importSources_() {
  return {
    GSC: { key: 'LAST_IMPORT_GSC', label: 'Search Console (GSC)', sheet: CONFIG_SHEET, cell: 'B8', trigger: 'importDzienny', schedule: 'codziennie ok. 05:00' },
    GA4: { key: 'LAST_IMPORT_GA4', label: 'Google Analytics 4 (GA4)', sheet: GA4_CONFIG_SHEET, cell: 'B9', trigger: 'importGA4Dzienny', schedule: 'codziennie ok. 06:00' }
  };
}

/**
 * Jedno źródło prawdy o zadaniach cyklicznych (#100).
 *
 * Każdy handler triggera musi tu być wymieniony. Korzysta z tego diagnostyka,
 * a docelowo także monitoring świeżości. Wcześniej lista zadań istniała
 * w kilku miejscach i najnowsze zadania trafiały tylko do części z nich, przez
 * co diagnostyka meldowała komplet, nie sprawdzając dwóch triggerów.
 *
 * Test `scheduled-jobs` skanuje pliki `*.gs` i pada, gdy istnieje handler
 * triggera spoza tej listy.
 */
function scheduledJobs_() {
  // staleAfterHours: próg per zadanie. Zadanie tygodniowe oceniane progiem
  // dobowym zgłaszałoby incydent przez sześć dni z siedmiu.
  //
  // optional: zadanie monitorujące, które użytkownik może świadomie zostawić
  // wyłączone. Import jest zawsze oczekiwany, więc brak importu to incydent
  // nawet wtedy, gdy nie ma triggera.
  return [
    { key: 'GSC', handler: 'importDzienny', label: 'import GSC', schedule: 'codziennie ok. 05:00', prop: 'LAST_IMPORT_GSC', staleAfterHours: IMPORT_STALE_AFTER_HOURS },
    { key: 'GA4', handler: 'importGA4Dzienny', label: 'import GA4', schedule: 'codziennie ok. 06:00', prop: 'LAST_IMPORT_GA4', staleAfterHours: IMPORT_STALE_AFTER_HOURS },
    { key: 'ALERTS', handler: ALERT_GUARD_HANDLER, label: 'strażnik alertów', schedule: 'codziennie ok. 08:00', prop: 'LAST_RUN_ALERTS', staleAfterHours: IMPORT_STALE_AFTER_HOURS },
    { key: 'SITEMAP_URLS', handler: SITEMAP_SYNC_TRIGGER_HANDLER, label: 'adresy z sitemap', schedule: 'poniedziałek ok. 06:00', prop: 'LAST_RUN_SITEMAP_URLS', staleAfterHours: WEEKLY_STALE_AFTER_HOURS, optional: true },
    { key: 'URL_INSPECTION', handler: URL_INSPECTION_TRIGGER_HANDLER, label: 'inspekcja URL', schedule: 'poniedziałek ok. 07:00', prop: 'LAST_RUN_URL_INSPECTION', staleAfterHours: WEEKLY_STALE_AFTER_HOURS, optional: true },
    { key: 'SEO_LIVE', handler: SEO_LIVE_TRIGGER_HANDLER, label: 'live check SEO', schedule: 'codziennie ok. 09:00', prop: 'LAST_RUN_SEO_LIVE', staleAfterHours: IMPORT_STALE_AFTER_HOURS, optional: true },
    { key: 'RECRAWL', handler: RECRAWL_TRIGGER_HANDLER, label: 'kolejka recrawl', schedule: 'codziennie ok. 10:00', prop: 'LAST_RUN_RECRAWL', staleAfterHours: IMPORT_STALE_AFTER_HOURS, optional: true },
    { key: 'PERFORMANCE', handler: PSI_TRIGGER_HANDLER, label: 'pomiar wydajności', schedule: 'co 6 godz. (interwał konfigurowalny)', prop: 'LAST_RUN_PERFORMANCE', staleAfterHours: IMPORT_STALE_AFTER_HOURS, optional: true, log: true }
  ];
}

/**
 * Nazwa zadania w komunikatach dla człowieka. Importy zachowują swoją pełną
 * nazwę („Search Console (GSC)”), bo tak są opisane w mailach i w komórkach
 * konfiguracji; rejestr trzyma krótką etykietę na potrzeby jednej linii
 * diagnostyki.
 */
function jobLabel_(key) {
  const source = importSources_()[key];
  return source ? source.label : scheduledJob_(key).label;
}

/** Definicja zadania cyklicznego; nieznany klucz to błąd programisty, nie danych. */
function scheduledJob_(key) {
  const job = scheduledJobs_().filter(j => j.key === key)[0];
  if (!job) throw new Error('Nieznane zadanie cykliczne: ' + key);
  return job;
}

function importSource_(source) {
  const def = importSources_()[source];
  if (!def) throw new Error('Nieznane źródło importu: ' + source);
  return def;
}

function readJobRecord_(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(scheduledJob_(key).prop);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeJobRecord_(key, record) {
  PropertiesService.getScriptProperties().setProperty(scheduledJob_(key).prop, JSON.stringify(record));
}

/**
 * Uruchamia import i zapisuje wynik. `fn` zwraca { rows, detail?, warning? }.
 * Błąd jest zapisywany (z zachowaniem ostatniego poprawnego runu) i rzucany dalej,
 * żeby trigger i użytkownik nadal widzieli go w Apps Script.
 */
function recordImportRun_(source, trigger, fn) {
  const startedAt = Date.now();
  const record = readJobRecord_(source);
  let result;

  try {
    result = fn();
  } catch (e) {
    record.lastRun = {
      finishedAt: new Date().toISOString(),
      ok: false,
      trigger: Boolean(trigger),
      error: String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 300),
      durationMs: Date.now() - startedAt
    };
    writeJobRecord_(source, record);
    appendImportLog_(source, record.lastRun);
    writeImportStatusCell_(source);
    updateImportIncident_(source, record);
    throw e;
  }

  const summary = result && typeof result === 'object' ? result : {};
  const run = {
    finishedAt: new Date().toISOString(),
    ok: true,
    trigger: Boolean(trigger),
    days: Number(summary.days) || 0,
    // Zakres danych, który import faktycznie pobrał (#180). Bez niego baza
    // porównawcza liczyła runy, a nie dni danych: ten sam dzień zaimportowany
    // dwa razy wchodził do mediany dwa razy.
    dataFrom: String(summary.dataFrom || ''),
    dataTo: String(summary.dataTo || ''),
    rows: Number(summary.rows) || 0,
    detail: String(summary.detail || ''),
    warning: String(summary.warning || ''),
    durationMs: Date.now() - startedAt
  };

  // Anomalia liczona z historii TEGO profilu, zanim bieżący run do niej trafi.
  const anomaly = importAnomaly_(source, run, importLogHistory_());
  if (anomaly) {
    run.anomaly = anomaly;
    run.warning = [run.warning, anomaly].filter(Boolean).join(' | ');
  }

  record.lastRun = run;
  record.lastOk = run;
  writeJobRecord_(source, record);
  appendImportLog_(source, run);
  writeImportStatusCell_(source);
  updateImportIncident_(source, record);
  return result;
}

// --- IMPORT LOG ---------------------------------------------------------------

/**
 * Zwraca arkusz IMPORT LOG, tworząc go z nagłówkiem, gdy go nie ma.
 * Odporne na wyścig: gdy dwa wykonania równocześnie nie widzą arkusza, drugie
 * insertSheet rzuca błąd o duplikacie, a wtedy bierzemy arkusz utworzony przez
 * pierwsze. Logowanie nie może zamienić udanego importu w błąd.
 */
function ensureImportLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(IMPORT_LOG_SHEET);

  if (!sheet) {
    try {
      sheet = ss.insertSheet(IMPORT_LOG_SHEET);
    } catch (e) {
      // Duplikat z równoległego wykonania: bierzemy arkusz, który już istnieje.
      // Jeśli go nadal nie ma, insertSheet zawiódł z innego powodu i to jest błąd.
      sheet = ss.getSheetByName(IMPORT_LOG_SHEET);
      if (!sheet) throw e;
    }
  }

  // Nagłówek dopisuje ten, kto zastanie arkusz pusty: także przegrany wyścigu,
  // żeby appendRow nigdy nie trafił do wiersza 1 zanim zwycięzca zapisze nagłówek.
  if (sheet.getLastRow() < 1 || String(sheet.getRange(1, 1).getValue() || '') !== IMPORT_LOG_HEADER[0]) {
    sheet.getRange(1, 1, 1, IMPORT_LOG_HEADER.length).setValues([IMPORT_LOG_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Arkusz o podanej nazwie z nagłówkiem w wierszu 1; tworzony, gdy go nie ma
 * (odporne na wyścig: duplikat przy insertSheet kończy się użyciem istniejącego).
 * Arkusz z danymi bez nagłówka dostaje nagłówek wstawiony NAD dane.
 */
function ensureSheetWithHeader_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(name);
    } catch (e) {
      sheet = ss.getSheetByName(name);
      if (!sheet) throw e;
    }
  }
  // Nagłówek szerszy niż siatka rzuca wyjątkiem o zakresie, a arkusz przycięty
  // do kilkunastu kolumn to realny przypadek. Miejsce robimy tutaj, bo każda inna
  // ścieżka zapisu nagłówka i tak przechodzi tędy — wywołujący nie musi pamiętać.
  ensureSheetColumns_(sheet, header.length);
  if (sheet.getLastRow() < 1 || String(sheet.getRange(1, 1).getValue() || '') !== header[0]) {
    if (sheet.getLastRow() >= 1 && !sheet.getRange(1, 1, 1, header.length).isBlank()) {
      sheet.insertRowBefore(1);
    }
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Powiększa siatkę arkusza, gdy zapis wymaga więcej wierszy niż arkusz ma.
 * Nowy arkusz Google ma 1000 wierszy, a `setValues` poza siatką rzuca wyjątkiem
 * zamiast ją rozszerzyć, więc każdy zapis hurtowy musi przejść tędy.
 */
function ensureSheetRows_(sheet, rowsNeeded) {
  const max = sheet.getMaxRows();
  if (rowsNeeded > max) sheet.insertRowsAfter(max, rowsNeeded - max);
  return sheet;
}

/** To samo dla kolumn: rozszerzenie schematu bywa szersze niż siatka arkusza. */
function ensureSheetColumns_(sheet, columnsNeeded) {
  const max = sheet.getMaxColumns();
  if (columnsNeeded > max) sheet.insertColumnsAfter(max, columnsNeeded - max);
  return sheet;
}

/**
 * Czy zakres jest naprawdę pusty.
 *
 * Sama wartość nie wystarcza: formuła zwracająca `""` wraca z `getValues()` jako
 * pustka, więc kolumna z cudzą formułą wyglądałaby na wolną i zostałaby przejęta
 * razem z nią (uwaga z audytu #154). Komórka z formułą nie jest pusta, nawet gdy
 * formuła nic nie wypisuje.
 */
function rangeIsEmpty_(range) {
  const blank = function (value) { return value === undefined || value === null || String(value) === ''; };
  const all = function (rows) { return rows.every(function (row) { return row.every(blank); }); };
  return all(range.getValues()) && all(range.getFormulas());
}

/**
 * Stan kolumn nagłówka SPRZED jakiejkolwiek zmiany.
 *
 * Kolejność ma znaczenie: `ensureSheetWithHeader_()` potrafi wstawić wiersz nad
 * danymi i wpisać komplet etykiet. Gdyby zajętość badać po nim, cudza treść
 * leżałaby już pod świeżo wpisaną etykietą i przeszłaby walidację.
 *
 * `headed` mówi, czy arkusz ma w ogóle wiersz nagłówka. Bez niego nie ma czego
 * uzupełniać — nagłówek zakłada wtedy `ensureSheetWithHeader_()` swoją starą
 * ścieżką naprawczą, a ta funkcja nie rości sobie do niczego prawa.
 *
 * Kolumna poza siatką arkusza jest z definicji pusta; czytanie jej rzuciłoby
 * wyjątkiem o zakresie zamiast dać odpowiedź.
 */
function headerColumnsState_(sheet, header) {
  const maxColumns = sheet.getMaxColumns();
  const lastRow = sheet.getLastRow();
  const headed = lastRow >= 1 && String(sheet.getRange(1, 1).getValue() || '') === header[0];
  if (!headed) return { headed: false, columns: [] };

  const width = Math.min(header.length, maxColumns);
  const labels = sheet.getRange(1, 1, 1, width).getValues()[0];
  const headerFormulas = sheet.getRange(1, 1, 1, width).getFormulas()[0];
  const dataRows = lastRow - 1;

  return {
    headed: true,
    columns: header.map(function (label, i) {
      const column = i + 1;
      if (column > maxColumns) return { label: '', headerBlank: true, usedBelow: false };
      const current = String(labels[i] === undefined || labels[i] === null ? '' : labels[i]).trim();

      // Kolumna z etykietą nie jest kandydatem do migracji, więc nie ma czego badać
      // pod nią. To nie kosmetyka: `PAGESPEED LAB` rośnie bez ograniczeń, a ten helper
      // wchodzi na początku każdego cyklicznego pomiaru — czytanie całej historii
      // przy każdym przebiegu zjadałoby budżet czasu, niczego nie ustalając.
      if (current !== '') return { label: current, headerBlank: false, usedBelow: false };

      return {
        label: '',
        // Formuła zwracająca `""` daje pustą wartość, ale komórka pusta nie jest:
        // wpisanie w nią etykiety skasowałoby cudzą formułę.
        headerBlank: String(headerFormulas[i] || '') === '',
        usedBelow: dataRows > 0 && !rangeIsEmpty_(sheet.getRange(2, column, dataRows, 1))
      };
    })
  };
}

/**
 * Nagłówek istniejącej zakładki uzupełniony o brakujące kolumny (#156, #154).
 *
 * `ensureSheetWithHeader_()` przepisuje nagłówek tylko wtedy, gdy `A1` różni się
 * od pierwszej nazwy. Przy rozszerzeniu schematu `A1` się nie zmienia, więc
 * istniejąca zakładka zostałaby ze starym, węższym nagłówkiem, a zapis wkładałby
 * wartości do kolumny bez etykiety.
 *
 * Kolumnę z pustą etykietą uznajemy za wolną tylko wtedy, gdy pusta jest także
 * używana część kolumny pod nią. Sam nagłówek nie wystarcza: `M1` bywa puste,
 * a `M2:M20` trzyma notatki albo formuły operatora. Wpisanie tam etykiety nie
 * nadpisałoby tych wartości, ale zaczęłoby je **czytać jako konfigurację** — to
 * nadal przejęcie cudzej kolumny, tylko cichsze.
 *
 * Walidacja idzie PRZED jakimkolwiek zapisem: konflikt ma zatrzymać operację,
 * a nie zostawić arkusza w połowie zmienionego — także przy rozszerzeniu o dwie
 * kolumny naraz.
 */
function ensureHeaderColumns_(sheetName, header) {
  const existing = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const state = existing ? headerColumnsState_(existing, header) : null;

  // Tylko arkusz, który MA nagłówek, ma luki do uzupełnienia — i tylko wtedy da się
  // powiedzieć, która kolumna jest nowa: ta z pustą etykietą. W arkuszu bez nagłówka
  // nic nie odróżnia „naszej” kolumny od cudzej, a zablokowanie zapisu odebrałoby
  // `ensureSheetWithHeader_()` jego starą ścieżkę naprawczą, z której korzystają też
  // zakładki prowadzone przez skrypt.
  if (state && state.headed) {
    const conflicts = [];
    state.columns.forEach(function (column, i) {
      if (column.label === header[i]) return;
      if (column.label !== '') {
        conflicts.push('kolumna ' + (i + 1) + ': jest „' + column.label + '”, oczekiwano „' + header[i] + '”');
        return;
      }
      if (!column.headerBlank) {
        conflicts.push('kolumna ' + (i + 1) + ': komórka nagłówka nie jest pusta (formuła) — nie nadpisujemy jej etykietą „' + header[i] + '”');
        return;
      }
      if (column.usedBelow) {
        conflicts.push('kolumna ' + (i + 1) + ': nagłówek pusty, ale pod nim są dane — nie przejmujemy jej pod „' + header[i] + '”');
      }
    });
    if (conflicts.length) {
      throw new Error(
        'Niezgodny nagłówek zakładki „' + sheetName + '”: ' + conflicts.join('; ') +
        '. Nic nie zostało zmienione — popraw nagłówek albo zmień nazwę zakładki.'
      );
    }
  }

  const sheet = ensureSheetWithHeader_(sheetName, header);
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  header.forEach(function (label, i) {
    if (String(current[i] === undefined || current[i] === null ? '' : current[i]).trim() !== label) {
      sheet.getRange(1, i + 1).setValue(label);
    }
  });
  return sheet;
}

function importRunType_(run) {
  return run.trigger ? 'trigger' : 'ręczny';
}

/** `RRRR-MM-DD..RRRR-MM-DD` — klucz zakresu danych przebiegu; '' gdy nieznany (#180). */
function importRangeKey_(run) {
  return run && run.dataFrom && run.dataTo ? run.dataFrom + '..' + run.dataTo : '';
}

/**
 * Czy kolumna `Zakres danych` jest nasza i można do niej pisać (#180).
 *
 * Nagłówek istniejącej zakładki jest przepisywany tylko wtedy, gdy różni się
 * `A1` (`ensureImportLogSheet_`), więc nowa etykieta sama by nie powstała.
 * Dopisujemy ją wyłącznie do PUSTEJ komórki nad PUSTĄ kolumną — cokolwiek
 * innego (cudza treść, zakładka przycięta do 9 kolumn) znaczy, że kolumna nie
 * jest nasza, i wiersz idzie bez zakresu. Bez wyjątku: logowanie nie może
 * zamienić udanego importu w błąd.
 */
function importLogRangeColumnReady_(sheet) {
  const label = IMPORT_LOG_HEADER[IMPORT_LOG_RANGE_COL - 1];
  if (sheet.getMaxColumns() < IMPORT_LOG_RANGE_COL) return false;
  const current = String(sheet.getRange(1, IMPORT_LOG_RANGE_COL).getValue() || '');
  if (current === label) return true;
  if (current !== '') return false;
  const below = sheet.getLastRow() > 1
    ? sheet.getRange(2, IMPORT_LOG_RANGE_COL, sheet.getLastRow() - 1, 1).getValues()
    : [];
  if (below.some(function (row) { return String(row[0] || '') !== ''; })) return false;
  sheet.getRange(1, IMPORT_LOG_RANGE_COL).setValue(label);
  return true;
}

/** Dopisuje wiersz historii i usuwa wpisy starsze niż IMPORT_LOG_RETENTION_DAYS. */
function appendImportLog_(source, run) {
  const sheet = ensureImportLogSheet_();
  const row = [
    new Date(run.finishedAt),
    source,
    importRunType_(run),
    Number(run.days) || 0,
    // `UWAGA` tylko dla zadań monitorujących. Import z anomalią zostaje `OK`,
    // bo `importLogHistory_()` czyta tę kolumnę jako „udany run” i inna wartość
    // wypadłaby z bazy porównawczej anomalii — wpis o anomalii jest w kolumnie obok.
    run.ok ? (run.warning && !importSources_()[source] ? 'UWAGA' : 'OK') : 'BŁĄD',
    run.ok ? Number(run.rows) || 0 : '',
    // Czas nieznany zostaje pustą komórką, nie zerem: `0` to prawdziwa wartość
    // („trwało zero sekund”). Tak jest przy przebiegu porzuconym (#189) — znamy
    // start, nie znamy chwili ubicia.
    typeof run.durationMs === 'number' ? Math.round(run.durationMs / 1000) : '',
    run.ok ? String(run.detail || '') : '',
    run.ok ? String(run.warning || '') : String(run.error || '')
  ];
  // Przebiegi bez zakresu (błąd, zadania monitorujące) dostają pustą komórkę.
  if (importLogRangeColumnReady_(sheet)) row.push(importRangeKey_(run));
  sheet.appendRow(row);
  pruneImportLog_(sheet, new Date(run.finishedAt));
}

function importLogCutoff_(now) {
  return (now || new Date()).getTime() - IMPORT_LOG_RETENTION_DAYS * 86400 * 1000;
}

/**
 * Usuwa wszystkie wiersze spoza okna retencji, niezależnie od ich położenia
 * (arkusz mógł zostać ręcznie posortowany). Ciągłe bloki wygasłych wierszy
 * są usuwane jednym wywołaniem, od dołu, żeby numery wierszy nie przesuwały
 * się w trakcie i żeby nie mnożyć wywołań usługi Spreadsheet.
 */
function pruneImportLog_(sheet, now) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const cutoff = importLogCutoff_(now);
  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const stale = dates.map(r => {
    const d = new Date(r[0]);
    return !isNaN(d.getTime()) && d.getTime() < cutoff;
  });

  let removed = 0;
  let i = stale.length - 1;
  while (i >= 0) {
    if (!stale[i]) { i--; continue; }
    let start = i;
    while (start > 0 && stale[start - 1]) start--;
    const count = i - start + 1;
    sheet.deleteRows(start + 2, count);
    removed += count;
    i = start - 1;
  }
  return removed;
}

/**
 * Historia jako tablica obiektów { at, source, trigger, days, ok, rows, rangeKey }.
 * `rangeKey` czytamy z kolumny `Zakres danych` tylko wtedy, gdy jej nagłówek jest
 * nasz — cudza treść w tej kolumnie nie może udawać zakresu danych (#180).
 * Wiersz bez zakresu (sprzed zmiany) ma `rangeKey = ''`.
 */
function importLogHistory_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(IMPORT_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const width = Math.max(6, Math.min(sheet.getLastColumn(), IMPORT_LOG_RANGE_COL));
  const ours = width === IMPORT_LOG_RANGE_COL &&
    String(sheet.getRange(1, IMPORT_LOG_RANGE_COL).getValue() || '') === IMPORT_LOG_HEADER[IMPORT_LOG_RANGE_COL - 1];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues().map(r => ({
    at: new Date(r[0]),
    source: String(r[1] || ''),
    trigger: String(r[2] || '') === 'trigger',
    days: Number(r[3]) || 0,
    ok: String(r[4] || '') === 'OK',
    rows: Number(r[5]) || 0,
    rangeKey: ours ? String(r[IMPORT_LOG_RANGE_COL - 1] || '') : ''
  }));
}

function medianOf_(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Próbki bazy porównawczej: udane przebiegi profilu z okna retencji, po
 * deduplikacji po zakresie danych (#180), od najstarszej.
 *
 * - z próbek o tym samym niepustym zakresie zostaje najnowsza;
 * - próbki zakresu bieżącego przebiegu są wykluczone: bieżący je zastępuje,
 *   a nie porównuje się sam ze sobą;
 * - próbki bez zakresu (wiersze sprzed zmiany) liczą się każda osobno.
 *
 * 09.09.2026 ten sam dzień danych GA4 zaimportowano dwa razy w odstępie 31 s
 * i oba wpisy weszły do mediany; bez tego duplikatu żaden z dwóch fałszywych
 * alarmów „mało danych” z 14–15.09 by nie powstał.
 */
function importAnomalySamples_(source, run, history, now) {
  const cutoff = importLogCutoff_(now || new Date(run.finishedAt));
  // Tylko udane runy tego profilu z okna retencji, posortowane po czasie:
  // kolejność wierszy w arkuszu nie ma znaczenia (mógł być posortowany ręcznie),
  // a wpisy starsze niż retencja nie liczą się, nawet jeśli jeszcze nie zostały usunięte.
  const profile = history
    .filter(h =>
      h.ok && h.source === source && h.trigger === Boolean(run.trigger) && h.days === (Number(run.days) || 0) &&
      !isNaN(h.at.getTime()) && h.at.getTime() >= cutoff
    )
    .sort((a, b) => a.at - b.at);

  const current = importRangeKey_(run);
  const seen = {};
  const samples = [];
  // Od najnowszej, żeby z duplikatów zakresu została właśnie ona.
  for (let i = profile.length - 1; i >= 0; i--) {
    const key = profile[i].rangeKey;
    if (key) {
      if (key === current || seen[key]) continue;
      seen[key] = true;
    }
    samples.unshift(profile[i]);
  }
  return samples;
}

/**
 * Okno i rozgrzewka baz klasowych GA4 (#180, etap 2, wariant 6A). Dni robocze
 * zbierają 5 próbek w tydzień, weekend 4 w dwa tygodnie — obie bazy zaczynają
 * działać po mniej więcej tym czasie.
 */
const IMPORT_ANOMALY_CLASS_WINDOW = { roboczy: 5, weekend: 4 };
const IMPORT_ANOMALY_CLASS_LABEL = { roboczy: 'dni robocze', weekend: 'weekend' };

/**
 * Klasa dnia DANYCH z klucza zakresu: sobota i niedziela → `weekend`, reszta →
 * `roboczy`; '' gdy zakresu brak. Z daty danych, nie z daty uruchomienia: import
 * z poniedziałku pobiera sobotę. Dzień tygodnia liczony z daty kalendarzowej
 * w UTC, więc nie zależy od strefy skryptu ani maszyny.
 */
function importDataClass_(rangeKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.\./.exec(String(rangeKey || ''));
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'roboczy';
}

/**
 * Tekst ostrzeżenia, gdy liczba wierszy odstaje od mediany ostatnich
 * IMPORT_ANOMALY_MIN_RUNS próbek tego samego profilu; '' gdy w normie albo
 * historia zbyt krótka (bez fałszywych alarmów na starcie).
 *
 * Wyjątek od rozgrzewki (#180): ZERO wierszy alarmuje, gdy profil wcześniej
 * zwracał dane — bez względu na liczbę próbek. Warunek zera stał dawniej za
 * warunkiem rozgrzewki, więc import zwracający nic przy krótkiej historii
 * przechodził bez śladu; każdy podział bazy na klasy wydłużyłby tę lukę.
 */
function importAnomaly_(source, run, history, now) {
  const samples = importAnomalySamples_(source, run, history, now);
  const rows = Number(run.rows) || 0;

  // Sezonowość tygodniowa (#180, etap 2, 6A) — wyłącznie GA4 i wyłącznie profile
  // jednodniowe: test kompletności z 19.09.2026 pokazał, że niski weekend jest
  // prawdziwy (12 i 13.09 po ponownym imporcie — co do wiersza to samo), a mediana
  // z kolejnych dni jest zawsze wartością z dnia roboczego, więc weekend leżał
  // tuż przy progu. GSC takiego wzoru nie pokazało i zostaje przy jednej bazie.
  // Próbki bez zakresu (wiersze sprzed v2.36.11) nie mają klasy i nie wchodzą
  // do baz klasowych.
  const cls = source === 'GA4' && (Number(run.days) || 0) === 1 ? importDataClass_(importRangeKey_(run)) : '';
  const base = cls ? samples.filter(h => importDataClass_(h.rangeKey) === cls) : samples;
  const size = cls ? IMPORT_ANOMALY_CLASS_WINDOW[cls] : IMPORT_ANOMALY_MIN_RUNS;
  const median = base.length >= size ? medianOf_(base.slice(-size).map(h => h.rows)) : null;
  const versus = rowsCount => 'mało danych: ' + rowsCount + ' wierszy vs mediana ' + median +
    (cls ? ' (' + IMPORT_ANOMALY_CLASS_LABEL[cls] + ')' : '');

  if (rows === 0) {
    if (median > 0) return versus(0);
    // Alarm zera bez zmian (punkt 3): cały profil, nie tylko klasa — zero po
    // dniach roboczych z danymi jest alarmem także w pierwszą sobotę.
    const withData = samples.filter(h => h.rows > 0);
    if (withData.length) {
      return 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio ' +
        withData[withData.length - 1].rows + ')';
    }
    return '';
  }
  if (median > 0 && rows < median / 2) return versus(rows);
  return '';
}

function hasImportTrigger_(source) {
  const handler = scheduledJob_(source).handler;
  return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === handler);
}

function formatImportTime_(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm');
}

/** lastOk rekordu; udany lastRun bez lastOk (starszy/częściowy rekord) liczy się jako ostatni poprawny import. */
function effectiveLastOk_(record) {
  const lastRun = record && record.lastRun;
  return (record && record.lastOk) || (lastRun && lastRun.ok ? lastRun : null);
}

/**
 * true, gdy funkcję wywołał trigger czasowy: Apps Script przekazuje wtedy obiekt
 * zdarzenia z triggerUid. Wywołanie z menu lub edytora nie ma argumentu → ręczne.
 */
function isTriggerRun_(e) {
  return !!(e && typeof e === 'object' && (e.triggerUid || e['trigger-uid']));
}

function isJobStale_(key, lastOk, now) {
  if (!lastOk || !lastOk.finishedAt) return true;
  const age = (now || new Date()).getTime() - new Date(lastOk.finishedAt).getTime();
  return !(age >= 0 && age <= scheduledJob_(key).staleAfterHours * 3600 * 1000);
}

/** Jedna linia statusu dla komórki konfiguracji. */
function importStatusText_(source, now) {
  const record = readJobRecord_(source);
  const lastRun = record.lastRun;
  // Rekord częściowy (np. ręcznie edytowany albo z wcześniejszej wersji): udany
  const lastOk = effectiveLastOk_(record);
  const triggerPart = ' | trigger: ' + (hasImportTrigger_(source) ? 'TAK' : 'NIE');

  if (!lastOk && !lastRun) {
    return 'BRAK IMPORTU – uruchom import z menu' + triggerPart;
  }

  const stale = isJobStale_(source, lastOk, now);
  let text;

  if (lastRun && !lastRun.ok) {
    text = 'BŁĄD ' + formatImportTime_(lastRun.finishedAt) + ': ' + lastRun.error +
      (lastOk ? ' | ostatni poprawny import: ' + formatImportTime_(lastOk.finishedAt) : ' | brak poprawnego importu');
  } else {
    text = 'AKTYWNE – ostatni import: ' + formatImportTime_(lastOk.finishedAt) +
      ' | ' + (lastOk.detail || (lastOk.rows + ' wierszy')) +
      (lastOk.warning ? ' | UWAGA: ' + lastOk.warning : '');
  }

  if (stale) {
    text = 'NIEAKTUALNE – ' + text.replace(/^AKTYWNE – /, '');
  }
  return text + triggerPart;
}

/**
 * Status zadania cyklicznego. Importy zachowują własną, bogatszą treść
 * (liczba wierszy, anomalie, komórka konfiguracji); pozostałe zadania mają
 * wersję neutralną, bo „ostatni import” nie opisuje inspekcji URL.
 */
function jobStatusText_(key, now) {
  if (importSources_()[key]) return importStatusText_(key, now);

  const record = readJobRecord_(key);
  const lastRun = record.lastRun;
  const lastOk = effectiveLastOk_(record);
  const triggerPart = ' | trigger: ' + (hasImportTrigger_(key) ? 'TAK' : 'NIE');

  if (!lastOk && !lastRun) {
    // Zadanie z triggerem, które jeszcze nie zapisało przebiegu, czeka na
    // pierwsze uruchomienie; to nie to samo co zadanie w ogóle nieużywane.
    const waiting = record.waitingSince && hasImportTrigger_(key);
    return (waiting
      ? 'BRAK PRZEBIEGU – zadanie jest włączone i czeka na pierwszy przebieg'
      : 'BRAK PRZEBIEGU – uruchom zadanie z menu') + triggerPart;
  }

  let text;
  if (lastRun && !lastRun.ok) {
    text = 'BŁĄD ' + formatImportTime_(lastRun.finishedAt) + ': ' + lastRun.error +
      (lastOk ? ' | ostatni poprawny przebieg: ' + formatImportTime_(lastOk.finishedAt) : ' | brak poprawnego przebiegu');
  } else {
    text = 'AKTYWNE – ostatni przebieg: ' + formatImportTime_(lastOk.finishedAt) +
      (lastOk.detail ? ' | ' + lastOk.detail : '');
  }

  if (isJobStale_(key, lastOk, now)) {
    text = 'NIEAKTUALNE – ' + text.replace(/^AKTYWNE – /, '');
  }
  return text + triggerPart;
}

// --- Znaczniki wykonań (#189) ------------------------------------------------
//
// Wykonanie ubite twardym limitem Apps Script (6 min) nie przechodzi ani przez
// `catch`, ani przez `finally`, więc bez znacznika nie zostawia żadnego śladu:
// ani rekordu, ani wiersza w IMPORT LOG, ani maila. 19.09.2026 tak zniknął
// przebieg pomiaru wydajności — widać go było tylko w rejestrze wykonań.

/** Prefiks Script Property ze znacznikiem trwającego wykonania: `RUNNING_<zadanie>_<runId>`. */
const RUN_MARKER_PREFIX = 'RUNNING_';
/**
 * Wiek, po którym znacznik na pewno nie należy do żyjącego wykonania: limit
 * wykonania Apps Script (6 min) plus margines. Młodszy może należeć do wykonania,
 * które wciąż trwa, i nie jest ruszany.
 */
const RUN_MARKER_STALE_MS = 7 * 60 * 1000;
/** Ile czekamy na blokadę przy odzysku. Odzysk to diagnostyka i nie może blokować zadania. */
const RUN_MARKER_LOCK_MS = 3000;

function runMarkerKey_(key, runId) {
  return RUN_MARKER_PREFIX + key + '_' + runId;
}

/**
 * Znacznik wykonania to OSOBNA Script Property, a nie pole rekordu zadania.
 * Rekord to jeden JSON, który zapisuje nie tylko `recordJobRun_()`, ale też obsługa
 * incydentów ze swojej kopii (Alerts.gs), a znacznik powstaje przed przejęciem
 * blokady — w rekordzie ginąłby przy nakładających się wykonaniach (lost update).
 * Własny klucz dopisuje i usuwa się jedną operacją, niezależnie od cudzych zapisów.
 */
function startRunMarker_(key, trigger, startedAt) {
  const runId = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(runMarkerKey_(key, runId), JSON.stringify({
    job: key,
    runId: runId,
    startedAt: new Date(startedAt).toISOString(),
    trigger: Boolean(trigger)
  }));
  return runId;
}

/** Usuwa WYŁĄCZNIE znacznik własnego wykonania — cudzy mógłby należeć do żyjącego. */
function clearRunMarker_(key, runId) {
  PropertiesService.getScriptProperties().deleteProperty(runMarkerKey_(key, runId));
}

/**
 * Porzucone znaczniki zadania `key` w bieżącym stanie Script Properties, od najstarszego.
 * Zadanie rozpoznajemy po polu `job`, a nie po prefiksie klucza: prefiks jednego
 * klucza zadania bywa początkiem innego (`SEO_LIVE` i hipotetyczne `SEO_LIVE_X`).
 * Wartość, której nie da się odczytać, nie jest naszym znacznikiem i zostaje nietknięta.
 */
function abandonedRunMarkers_(key, now) {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter(function (name) { return name.indexOf(RUN_MARKER_PREFIX) === 0; })
    .map(function (name) {
      let marker;
      try { marker = JSON.parse(all[name]); } catch (e) { marker = null; }
      return { name: name, marker: marker };
    })
    .filter(function (found) {
      return Boolean(found.marker) && found.marker.job === key &&
        now - Date.parse(found.marker.startedAt) > RUN_MARKER_STALE_MS;
    })
    .sort(function (a, b) { return Date.parse(a.marker.startedAt) - Date.parse(b.marker.startedAt); });
}

/**
 * Odbiera porzucone znaczniki zadania — usuwa je i zwraca do raportu — dokładnie raz.
 *
 * Decyzja zapada pod krótką blokadą, na świeżym odczycie: drugie wykonanie
 * startujące w tej samej chwili zobaczy stan już po usunięciu. Blokadę bierzemy
 * tylko wtedy, gdy wstępny odczyt bez niej w ogóle coś znalazł, więc zwykły
 * przebieg nie dokłada rywalizacji o blokadę, którą współdzielą wszystkie zadania.
 * Gdy blokady nie da się przejąć, odzysk czeka na kolejny przebieg.
 */
function reclaimAbandonedRuns_(key, now) {
  if (!abandonedRunMarkers_(key, now).length) return [];
  const lock = LockService.getScriptLock();
  // Wywołanie pod blokadą już trzymaną (jak w `withScriptLock_`) nie może jej zwolnić.
  const owned = lock.hasLock();
  if (!owned && !lock.tryLock(RUN_MARKER_LOCK_MS)) return [];
  try {
    const props = PropertiesService.getScriptProperties();
    return abandonedRunMarkers_(key, now).map(function (found) {
      props.deleteProperty(found.name);
      return found.marker;
    });
  } finally {
    if (!owned) lock.releaseLock();
  }
}

/**
 * Treść o porzuconym wykonaniu. Znacznik dowodzi tylko jednego: wykonanie nie
 * przeszło przez kontrolowane zakończenie `recordJobRun_()`. Nie przesądza ani
 * przyczyny, ani losu danych — po #151 i #187 dane zapisują się W TRAKCIE
 * przebiegu, więc ubity przebieg mógł zdążyć zapisać część albo całość.
 */
function abandonedRunNote_(marker) {
  return 'poprzedni przebieg (start ' + formatImportTime_(marker.startedAt) + ') nie zakończył się kontrolowanie — ' +
    'możliwe przerwanie przez limit czasu wykonania Apps Script; zakres zapisanych danych jest niepewny';
}

/**
 * Zapisuje przebieg zadania monitorującego i aktualizuje jego incydent.
 * Lżejsze niż recordImportRun_: bez anomalii i komórki statusu, bo dla tych zadań
 * liczy się fakt i czas ostatniego udanego przebiegu; do IMPORT LOG piszą tylko
 * zadania z `log: true` (#179). Błąd jest zapisywany i rzucany dalej, żeby był
 * widoczny w Apps Script.
 *
 * Każde wykonanie zakłada znacznik przed pracą i usuwa go po niej (#189), a przy
 * starcie odbiera znaczniki wykonań, które nie doszły ani do `return`, ani do `catch`.
 */
function recordJobRun_(key, trigger, fn) {
  const startedAt = Date.now();
  const job = scheduledJob_(key);
  // Najpierw odzysk cudzych porzuconych znaczników, dopiero potem własny.
  const abandoned = reclaimAbandonedRuns_(key, startedAt);
  const runId = startRunMarker_(key, trigger, startedAt);
  const notes = abandoned.map(abandonedRunNote_);
  // Wiersz za porzucone wykonanie od razu, przed pracą: gdyby i to wykonanie
  // zostało ubite, ślad poprzedniego już by nie zginął. Czas = start porzuconego,
  // czas trwania nieznany.
  if (job.log) {
    abandoned.forEach(function (marker, i) {
      appendImportLog_(key, { finishedAt: marker.startedAt, ok: false, trigger: marker.trigger, error: notes[i] });
    });
  }
  const record = readJobRecord_(key);
  let result;

  try {
    result = fn();
  } catch (e) {
    clearRunMarker_(key, runId);
    record.lastRun = {
      finishedAt: new Date().toISOString(),
      ok: false,
      trigger: Boolean(trigger),
      // Treść o porzuconym poprzednim przebiegu dołącza do błędu bieżącego (#189).
      error: [String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 300)].concat(notes).join(' | '),
      durationMs: Date.now() - startedAt
    };
    writeJobRecord_(key, record);
    if (job.log) appendImportLog_(key, record.lastRun);
    updateImportIncident_(key, record);
    throw e;
  }

  // Kontrolowane zakończenie: znacznik znika zaraz po pracy, przed obsługą wyniku.
  clearRunMarker_(key, runId);
  const summary = result && typeof result === 'object' ? result : {};
  record.lastRun = {
    finishedAt: new Date().toISOString(),
    ok: true,
    trigger: Boolean(trigger),
    rows: Number(summary.rows) || 0,
    detail: String(summary.detail || ''),
    // Ostrzeżenie zadania: przebieg się udał, ale coś w nim wymaga uwagi.
    // Otwiera incydent `warning` (Alerts.gs), a nie błąd — dane są zapisane.
    // Porzucony poprzedni przebieg też jest takim ostrzeżeniem (#189): bieżący
    // się udał, a osobny incydent `error` dałby otwarcie i zamknięcie w kilka minut.
    warning: [String(summary.warning || '')].concat(notes).filter(Boolean).join(' | '),
    durationMs: Date.now() - startedAt
  };
  record.lastOk = record.lastRun;
  // Znacznik oczekiwania na pierwszy przebieg przestaje być potrzebny: od teraz
  // świeżość liczy się od ostatniego udanego uruchomienia.
  delete record.waitingSince;
  writeJobRecord_(key, record);
  // Ślad przebiegu dla zadań, które go potrzebują (#179): przy otwartym
  // incydencie kolejne awarie milkną, więc bez wpisu w logu znikają bez śladu.
  if (job.log) appendImportLog_(key, record.lastRun);
  updateImportIncident_(key, record);
  return result;
}

/** Zapisuje linię statusu do komórki konfiguracji; brak arkusza nie przerywa importu. */
function writeImportStatusCell_(source) {
  const def = importSource_(source);
  const sheet = SpreadsheetApp.getActive().getSheetByName(def.sheet);
  if (!sheet) return '';
  const text = importStatusText_(source);
  sheet.getRange(def.cell).setValue(text);
  return text;
}

/** Odświeża obie komórki statusu, np. po włączeniu triggera. */
function refreshImportStatusCells() {
  return Object.keys(importSources_()).map(source => writeImportStatusCell_(source));
}

/**
 * Widoczność flag zapisu (#104).
 *
 * WP_ALLOW_WRITES jest jedynym wyłącznikiem chroniącym produkcyjny WordPress
 * przed niezamierzonym zapisem, ale zostaje włączony na stałe, bo tak jest
 * wygodniej. Wyłącznik zawsze włączony nie chroni przed niczym. WP_DRY_RUN daje
 * problem odwrotny: zapomniany sprawia, że komendy tylko udają zapis.
 *
 * Świadomie NIE wyłączamy niczego automatycznie. Flaga gasnąca sama w losowym
 * momencie zamieniłaby przewidywalny system w taki, który odmawia zapisu
 * w środku pracy. Pokazujemy stan i czas jego trwania, decyzję zostawiamy
 * człowiekowi.
 */
const WRITE_FLAGS = [
  { key: 'WP_ALLOW_WRITES', label: 'Zapisy do WordPressa', on: 'WŁĄCZONE', off: 'wyłączone', warn: 'wyłącznik chroni tylko wtedy, gdy bywa wyłączany' },
  { key: 'WP_DRY_RUN', label: 'Tryb próbny', on: 'WŁĄCZONY', off: 'wyłączony', warn: 'komendy tylko udają zapis' }
];
const WRITE_FLAG_WARN_DAYS = 7;
const WRITE_FLAG_STATE_PROP = 'WRITE_FLAGS_SINCE';

function readWriteFlagState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(WRITE_FLAG_STATE_PROP);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * Zapamiętuje moment włączenia każdej flagi. Flagi zmienia człowiek wprost
 * w Script Properties, więc nie ma zdarzenia, na którym można by się oprzeć:
 * stan obserwujemy przy okazji uruchomień, które i tak zapisują.
 * Zapis następuje wyłącznie przy zmianie.
 */
function observeWriteFlags_(now) {
  const props = PropertiesService.getScriptProperties();
  const state = readWriteFlagState_();
  const stamp = (now || new Date()).toISOString();
  let changed = false;

  WRITE_FLAGS.forEach(function (flag) {
    const isOn = props.getProperty(flag.key) === 'TRUE';
    if (isOn && !state[flag.key]) { state[flag.key] = stamp; changed = true; }
    if (!isOn && state[flag.key]) { delete state[flag.key]; changed = true; }
  });

  if (changed) props.setProperty(WRITE_FLAG_STATE_PROP, JSON.stringify(state));
  return state;
}

/** Pełne dni od podanej chwili; ujemna różnica (zegar) liczy się jako zero. */
function daysSince_(iso, now) {
  const start = new Date(iso).getTime();
  if (!start || isNaN(start)) return 0;
  return Math.max(0, Math.floor(((now || new Date()).getTime() - start) / 86400000));
}

/** Po jednej linii na flagę: stan, czas trwania i ostrzeżenie po progu. */
function writeFlagsStatusLines_(now) {
  const props = PropertiesService.getScriptProperties();
  const state = readWriteFlagState_();

  return WRITE_FLAGS.map(function (flag) {
    if (props.getProperty(flag.key) !== 'TRUE') {
      return flag.label + ' (' + flag.key + '): ' + flag.off + '.';
    }
    if (!state[flag.key]) {
      return flag.label + ' (' + flag.key + '): ' + flag.on + ', czas włączenia nieznany (pierwsza obserwacja).';
    }
    const days = daysSince_(state[flag.key], now);
    const duration = days === 0 ? 'od dziś' : 'od ' + days + ' dni';
    const warning = days >= WRITE_FLAG_WARN_DAYS ? ' UWAGA: ' + flag.warn + '.' : '';
    return flag.label + ' (' + flag.key + '): ' + flag.on + ' ' + duration + '.' + warning;
  });
}

/** Menu „Dane” obok pozostałych menu projektu. */
function addStatusMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('Dane')
    .addItem('Status danych', 'showImportStatus')
    .addItem('Odśwież status w komórkach', 'refreshImportStatusCells')
    .addSeparator()
    .addItem('Sprawdź aktualność teraz (alerty)', 'sprawdzAktualnoscImportowZMenu')
    .addItem('Włącz codzienne alerty e-mail', 'ustawCodzienneAlerty')
    .addSeparator()
    .addItem('Diagnostyka systemu (tylko odczyt)', 'diagnostykaSystemu')
    .addSeparator()
    .addItem('Zajętość arkusza', 'pokazZajetoscArkusza')
    .addItem('Wyczyść stare snapshoty, wyniki i próby PSI', 'wyczyscStareSnapshotyIWyniki')
    .addItem('Przytnij puste wiersze', 'przytnijPusteWiersze')
    .addItem('Kanonizuj znaczniki Pomiar', 'kanonizujZnacznikiPomiaru')
    .addSeparator()
    .addItem('Uporządkuj arkusze', 'uporzadkujArkuszeZMenu')
    .addItem('Ukryj arkusze techniczne', 'ukryjArkuszeTechniczne')
    .addItem('Pokaż arkusze techniczne', 'pokazArkuszeTechniczne')
    .addToUi();
}

/** Szczegóły ostatnich importów w oknie dialogowym. */
function showImportStatus() {
  const now = new Date();
  const lines = [];

  scheduledJobs_().forEach(job => {
    const source = job.key;
    const def = importSources_()[source];
    const record = readJobRecord_(source);
    const lastRun = record.lastRun;
    lines.push(jobLabel_(source));
    lines.push('  ' + jobStatusText_(source, now));
    lines.push('  Harmonogram: ' + job.schedule +
      (def ? ' (' + def.sheet + '!' + def.cell + ')' : '') +
      ' | nieaktualne po ' + job.staleAfterHours + ' h');
    if (lastRun) {
      lines.push('  Ostatnie uruchomienie: ' + formatImportTime_(lastRun.finishedAt) +
        ' | ' + (lastRun.ok ? 'OK' : 'BŁĄD') +
        ' | ' + (lastRun.trigger ? 'trigger' : 'ręcznie') +
        ' | ' + Math.round((lastRun.durationMs || 0) / 1000) + ' s');
    }
    lines.push('  ' + incidentSummary_(record));
    lines.push('');
  });

  lines.push('Zadanie jest nieaktualne po upływie własnego progu od ostatniego poprawnego przebiegu.');
  lines.push('Zadanie monitorujące bez triggera, które nigdy nie działało, nie jest zgłaszane jako awaria.');
  lines.push(sheetUsageLine_());
  observeWriteFlags_(now);
  writeFlagsStatusLines_(now).forEach(function (line) { lines.push(line); });
  lines.push(sitemapsStatusLine_());
  lines.push(perfMigrationStatusLine_());
  lines.push('Alerty e-mail: ' + alertRecipientText_() + ' | strażnik: ' + (hasAlertGuardTrigger_() ? 'TAK' : 'NIE'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
