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
    writeImportStatusCell_(source);
    throw e;
  }

  const summary = result && typeof result === 'object' ? result : {};
  const run = {
    finishedAt: new Date().toISOString(),
    ok: true,
    trigger: Boolean(trigger),
    rows: Number(summary.rows) || 0,
    detail: String(summary.detail || ''),
    warning: String(summary.warning || ''),
    durationMs: Date.now() - startedAt
  };
  record.lastRun = run;
  record.lastOk = run;
  writeImportRecord_(source, record);
  writeImportStatusCell_(source);
  return result;
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
  // lastRun bez lastOk traktujemy jako ostatni poprawny import.
  const lastOk = record.lastOk || (lastRun && lastRun.ok ? lastRun : null);
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
    lines.push('');
  });

  lines.push('Dane uznajemy za nieaktualne po ' + IMPORT_STALE_AFTER_HOURS + ' h od ostatniego poprawnego importu.');
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}
