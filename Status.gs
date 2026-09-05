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

function importSource_(source) {
  const def = importSources_()[source];
  if (!def) throw new Error('Nieznane źródło importu: ' + source);
  return def;
}

function readImportRecord_(source) {
  const raw = PropertiesService.getScriptProperties().getProperty(importSource_(source).key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeImportRecord_(source, record) {
  PropertiesService.getScriptProperties().setProperty(importSource_(source).key, JSON.stringify(record));
}

/**
 * Uruchamia import i zapisuje wynik. `fn` zwraca { rows, detail?, warning? }.
 * Błąd jest zapisywany (z zachowaniem ostatniego poprawnego runu) i rzucany dalej,
 * żeby trigger i użytkownik nadal widzieli go w Apps Script.
 */
function recordImportRun_(source, trigger, fn) {
  const startedAt = Date.now();
  const record = readImportRecord_(source);
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
    writeImportRecord_(source, record);
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
  writeImportRecord_(source, record);
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
  const handler = importSource_(source).trigger;
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

function isImportStale_(lastOk, now) {
  if (!lastOk || !lastOk.finishedAt) return true;
  const age = (now || new Date()).getTime() - new Date(lastOk.finishedAt).getTime();
  return !(age >= 0 && age <= IMPORT_STALE_AFTER_HOURS * 3600 * 1000);
}

/** Jedna linia statusu dla komórki konfiguracji. */
function importStatusText_(source, now) {
  const record = readImportRecord_(source);
  const lastRun = record.lastRun;
  // Rekord częściowy (np. ręcznie edytowany albo z wcześniejszej wersji): udany
  const lastOk = effectiveLastOk_(record);
  const triggerPart = ' | trigger: ' + (hasImportTrigger_(source) ? 'TAK' : 'NIE');

  if (!lastOk && !lastRun) {
    return 'BRAK IMPORTU – uruchom import z menu' + triggerPart;
  }

  const stale = isImportStale_(lastOk, now);
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
    .addToUi();
}

/** Szczegóły ostatnich importów w oknie dialogowym. */
function showImportStatus() {
  const now = new Date();
  const lines = [];

  Object.keys(importSources_()).forEach(source => {
    const def = importSource_(source);
    const record = readImportRecord_(source);
    const lastRun = record.lastRun;
    lines.push(def.label);
    lines.push('  ' + importStatusText_(source, now));
    lines.push('  Harmonogram: ' + def.schedule + ' (' + def.sheet + '!' + def.cell + ')');
    if (lastRun) {
      lines.push('  Ostatnie uruchomienie: ' + formatImportTime_(lastRun.finishedAt) +
        ' | ' + (lastRun.ok ? 'OK' : 'BŁĄD') +
        ' | ' + (lastRun.trigger ? 'trigger' : 'ręcznie') +
        ' | ' + Math.round((lastRun.durationMs || 0) / 1000) + ' s');
    }
    lines.push('  ' + incidentSummary_(record));
    lines.push('');
  });

  lines.push('Dane uznajemy za nieaktualne po ' + IMPORT_STALE_AFTER_HOURS + ' h od ostatniego poprawnego importu.');
  lines.push('Alerty e-mail: ' + alertRecipientText_() + ' | strażnik: ' + (hasAlertGuardTrigger_() ? 'TAK' : 'NIE'));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
