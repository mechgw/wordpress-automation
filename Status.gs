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
const IMPORT_LOG_HEADER = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];
const IMPORT_LOG_RETENTION_DAYS = 90;
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
    { key: 'RECRAWL', handler: RECRAWL_TRIGGER_HANDLER, label: 'kolejka recrawl', schedule: 'codziennie ok. 10:00', prop: 'LAST_RUN_RECRAWL', staleAfterHours: IMPORT_STALE_AFTER_HOURS, optional: true }
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

function importRunType_(run) {
  return run.trigger ? 'trigger' : 'ręczny';
}

/** Dopisuje wiersz historii i usuwa wpisy starsze niż IMPORT_LOG_RETENTION_DAYS. */
function appendImportLog_(source, run) {
  const sheet = ensureImportLogSheet_();
  sheet.appendRow([
    new Date(run.finishedAt),
    source,
    importRunType_(run),
    Number(run.days) || 0,
    run.ok ? 'OK' : 'BŁĄD',
    run.ok ? Number(run.rows) || 0 : '',
    Math.round((run.durationMs || 0) / 1000),
    run.ok ? String(run.detail || '') : '',
    run.ok ? String(run.warning || '') : String(run.error || '')
  ]);
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

/** Historia jako tablica obiektów { at, source, trigger, days, ok, rows }. */
function importLogHistory_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(IMPORT_LOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().map(r => ({
    at: new Date(r[0]),
    source: String(r[1] || ''),
    trigger: String(r[2] || '') === 'trigger',
    days: Number(r[3]) || 0,
    ok: String(r[4] || '') === 'OK',
    rows: Number(r[5]) || 0
  }));
}

function medianOf_(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Tekst ostrzeżenia, gdy liczba wierszy odstaje od mediany ostatnich
 * IMPORT_ANOMALY_MIN_RUNS udanych runów tego samego profilu; '' gdy w normie
 * albo historia zbyt krótka (bez fałszywych alarmów na starcie).
 */
function importAnomaly_(source, run, history, now) {
  const cutoff = importLogCutoff_(now || new Date(run.finishedAt));
  // Tylko udane runy tego profilu z okna retencji, posortowane po czasie:
  // kolejność wierszy w arkuszu nie ma znaczenia (mógł być posortowany ręcznie),
  // a wpisy starsze niż retencja nie liczą się, nawet jeśli jeszcze nie zostały usunięte.
  const same = history
    .filter(h =>
      h.ok && h.source === source && h.trigger === Boolean(run.trigger) && h.days === (Number(run.days) || 0) &&
      !isNaN(h.at.getTime()) && h.at.getTime() >= cutoff
    )
    .sort((a, b) => a.at - b.at);
  if (same.length < IMPORT_ANOMALY_MIN_RUNS) return '';

  const recent = same.slice(-IMPORT_ANOMALY_MIN_RUNS).map(h => h.rows);
  const median = medianOf_(recent);
  const rows = Number(run.rows) || 0;

  if (median > 0 && rows === 0) {
    return 'mało danych: 0 wierszy vs mediana ' + median;
  }
  if (median > 0 && rows < median / 2) {
    return 'mało danych: ' + rows + ' wierszy vs mediana ' + median;
  }
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
    return 'BRAK PRZEBIEGU – uruchom zadanie z menu' + triggerPart;
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

/**
 * Zapisuje przebieg zadania monitorującego i aktualizuje jego incydent.
 * Lżejsze niż recordImportRun_: bez IMPORT LOG, anomalii i komórki statusu,
 * bo dla tych zadań liczy się fakt i czas ostatniego udanego przebiegu.
 * Błąd jest zapisywany i rzucany dalej, żeby był widoczny w Apps Script.
 */
function recordJobRun_(key, trigger, fn) {
  const startedAt = Date.now();
  const record = readJobRecord_(key);
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
    writeJobRecord_(key, record);
    updateImportIncident_(key, record);
    throw e;
  }

  const summary = result && typeof result === 'object' ? result : {};
  record.lastRun = {
    finishedAt: new Date().toISOString(),
    ok: true,
    trigger: Boolean(trigger),
    detail: String(summary.detail || ''),
    durationMs: Date.now() - startedAt
  };
  record.lastOk = record.lastRun;
  writeJobRecord_(key, record);
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
  lines.push(sitemapsStatusLine_());
  lines.push('Alerty e-mail: ' + alertRecipientText_() + ' | strażnik: ' + (hasAlertGuardTrigger_() ? 'TAK' : 'NIE'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
