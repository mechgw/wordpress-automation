const CONFIG_SHEET = 'Konfiguracja GSC';
const RAW_SHEET = 'GSC RAW';
const TZ = 'Europe/Warsaw';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('SEO / GSC')
    .addItem('Sprawdź połączenie', 'testPolaczenia')
    .addItem('Importuj ostatni zakres', 'importOstatniZakres')
    .addItem('Importuj dzień', 'importDzienny')
    .addSeparator()
    .addItem('Włącz codzienny import', 'ustawAutomatycznyImport')
    .addSeparator()
    .addItem('Sprawdź indeksowanie (URL INSPEKCJA)', 'sprawdzIndeksowanie')
    .addItem('Włącz cotygodniową inspekcję URL', 'ustawTygodniowaInspekcje')
    .addItem('Sprawdź strony live (SEO LIVE)', 'sprawdzStronyLive')
    .addItem('Włącz codzienny live check SEO', 'ustawCodziennyLiveCheck')
    .addItem('Przygotuj reguły schema (SEO SCHEMA)', 'przygotujRegulySchema')
    .addSeparator()
    .addItem('Sprawdź sitemapy (SITEMAPY)', 'sprawdzSitemapy')
    .addItem('Odśwież adresy z sitemap (SITEMAP URLS)', 'odswiezMonitoringZSitemap')
    .addItem('Włącz cotygodniowe odświeżanie z sitemap', 'ustawTygodnioweOdswiezanieSitemap')
    .addSeparator()
    .addItem('Kolejka recrawl (RECRAWL QUEUE)', 'kolejkaRecrawl')
    .addItem('Włącz codzienną kolejkę recrawl', 'ustawCodziennaKolejkeRecrawl')
    .addSeparator()
    .addItem('Przygotuj Business Profile', 'przygotujBusinessProfile')
    .addItem('Importuj Business Profile', 'importujBusinessProfile')
    .addItem('Włącz codzienny import Business Profile', 'ustawCodziennyImportBusinessProfile')
    .addItem('Przygotuj pomiar wydajności', 'przygotujPomiarWydajnosci')
    .addItem('Zmierz wydajność (CrUX + PSI)', 'zmierzWydajnosc')
    .addItem('Włącz cykliczny pomiar wydajności', 'ustawCyklicznyPomiarWydajnosci')
    .addItem('Wyłącz cykliczny pomiar wydajności', 'usunCyklicznyPomiarWydajnosci')
    .addItem('Zbadaj kształt odpowiedzi PSI', 'zbadajKsztaltOdpowiedziPsi')
    .addToUi();

    addGa4Menu_();
    addWpMenu_();
    addStatusMenu_();
    addVersionMenu_();
}

/**
 * Dane wdrożenia z Version.gs. Guard przez typeof: bez tego pliku (np. stare
 * wdrożenie albo niepełny zestaw plików) menu i testy nadal mają działać.
 */
function deployedVersion_() {
  return typeof DEPLOYED_VERSION === 'object' && DEPLOYED_VERSION ? DEPLOYED_VERSION : {};
}

/** Etykieta wdrożonej wersji, np. "v2.9.4" albo "dev" w edytorze. */
function versionLabel_() {
  return deployedVersion_().tag || 'dev';
}

/** Menu z numerem wersji w tytule, obok pozostałych menu projektu. */
function addVersionMenu_() {
  SpreadsheetApp.getUi()
    .createMenu(versionLabel_())
    .addItem('Szczegóły wdrożenia', 'showDeployedVersion')
    .addToUi();
}

/** Pokazuje tag, commit i datę wdrożenia zapisane przez workflow deployu. */
function showDeployedVersion() {
  const v = deployedVersion_();
  const lines = [
    'Wersja: ' + versionLabel_(),
    'Commit: ' + (v.commit || 'brak (kod z edytora, nie z wdrożenia)'),
    'Wdrożono: ' + (v.deployedAt || '-'),
    'Przez: ' + (v.deployedBy || '-'),
    '',
    'Lista wydań: https://github.com/mechgw/wordpress-automation/releases'
  ];
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

function testPolaczenia() {
  const response = apiRequest_(
    'https://www.googleapis.com/webmasters/v3/sites',
    'get'
  );

  const sheet = SpreadsheetApp.getActive()
    .getSheetByName(CONFIG_SHEET);

  sheet.getRange('E1:F100').clearContent();
  sheet.getRange('E1:F1').setValues([
    ['Dostępne właściwości GSC', 'Uprawnienie']
  ]);

  const sites = response.siteEntry || [];

  if (sites.length) {
    const rows = sites.map(site => [
      site.siteUrl,
      site.permissionLevel
    ]);

    sheet.getRange(2, 5, rows.length, 2).setValues(rows);
  }

  ustawStatus_(
    sites.length
      ? 'POŁĄCZENIE OK'
      : 'POŁĄCZENIE OK – BRAK WŁAŚCIWOŚCI'
  );
}

/** Ręczny import z menu: ostatnie daysBack dni z opóźnieniem dailyLagDays. */
function importOstatniZakres() {
  return recordImportRun_('GSC', false, () => withScriptLock_('import GSC', () => {
    const cfg = getConfig_();

    const end = przesunDate_(new Date(), -cfg.dailyLagDays);
    const start = przesunDate_(end, -(cfg.daysBack - 1));

    return importRange_(
      formatujDate_(start),
      formatujDate_(end)
    );
  }));
}

/**
 * Import dzienny: handler codziennego triggera i pozycja menu (wtedy liczony jako ręczny).
 * Pobiera dzień `dziś − dailyLagDays` i dni brakujące od ostatniego dnia z danymi
 * w `GSC RAW`, najwyżej GSC_DAILY_MAX_DAYS (#209, #215).
 */
function importDzienny(e) {
  return recordImportRun_('GSC', isTriggerRun_(e), () => withScriptLock_('import GSC', () => {
    const cfg = getConfig_();
    const stage = importStageTimer_('import GSC');
    const target = formatujDate_(przesunDate_(new Date(), -cfg.dailyLagDays));
    const lastDay = gscLastDataDay_(SpreadsheetApp.getActive().getSheetByName(RAW_SHEET), stage);
    const range = dailyGscRange_(target, lastDay);
    return importRange_(range.from, range.to, { daily: true, warning: range.warning, stage: stage });
  }));
}

/** Najdłuższa luka, którą import dzienny uzupełnia sam (#209). */
const GSC_DAILY_MAX_DAYS = 7;

/**
 * Ostatni dzień z danymi w `GSC RAW`: największa poprawna data w kolumnie A;
 * '' gdy zakładka nie ma żadnej (#215).
 *
 * Od niego liczy się zakres importu dziennego. Wcześniej był to `lastOk.dataTo`,
 * czyli koniec zakresu ZAPYTANIA: 03.10.2026 Google nie opublikował jeszcze dnia
 * 30.09, API zwróciło zero wierszy, przebieg zapisał się jako udany i następny
 * zaczął od 01.10 — dzień opublikowany z opóźnieniem został luką. Zakładka jest
 * źródłem prawdy o tym, co zaimportowano, i nie ma stanu do zepsucia.
 */
function gscLastDataDay_(sheet, stage) {
  // Brak zakładki zgłasza zapis, jak dotąd: błąd API ma pierwszeństwo przed nim.
  if (!sheet) return '';
  const lastRow = sheet.getLastRow();
  const column = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues() : [];
  let day = '';
  column.forEach(row => {
    // Tekst musi być datą w całości: `normalizujDate_` obcina go do 10 znaków,
    // więc „9999-12-31 notatka” udawałoby datę z przyszłości i wyłączało
    // uzupełnianie luki (PR #217).
    const date = row[0] instanceof Date ? formatujDate_(row[0]) : String(row[0]);
    // Kształt i istnienie w kalendarzu: tekst niebędący datą nie może zostać „największą datą”.
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && shiftDay_(date, 0) === date && date > day) day = date;
  });
  stage('ostatni dzień z danymi (' + column.length + ' wierszy, ' + (day || 'brak') + ')');
  return day;
}

/**
 * Zakres importu dziennego (#209). 27.09 ubity import zostawił lukę 24.09, a import
 * dzienny pobierał tylko jeden dzień, więc luka sama się nie zapełniała. Zakres
 * zaczyna się dzień po ostatnim dniu z danymi (`gscLastDataDay_`, #215). Bez danych
 * albo gdy dane sięgają już celu — jeden dzień, jak dawniej. Dłuższa luka:
 * 7 najnowszych dni i ostrzeżenie.
 */
function dailyGscRange_(target, lastDay) {
  if (!lastDay || lastDay >= target) return { from: target, to: target, warning: '' };
  const missing = dayDiff_(lastDay, target);
  if (missing <= GSC_DAILY_MAX_DAYS) return { from: shiftDay_(lastDay, 1), to: target, warning: '' };
  const from = shiftDay_(target, -(GSC_DAILY_MAX_DAYS - 1));
  return {
    from: from,
    to: target,
    warning: 'luka w danych: ' + missing + ' dni od ' + shiftDay_(lastDay, 1) + '; import dzienny pobrał ' +
      GSC_DAILY_MAX_DAYS + ' najnowszych, dni ' + shiftDay_(lastDay, 1) + ' – ' + shiftDay_(from, -1) +
      ' uzupełnij ręcznym importem zakresu (SEO / GSC → Importuj ostatni zakres)'
  };
}

/**
 * Ostrzeżenie o końcowych dniach zakresu, dla których API nie zwróciło wierszy
 * (#215); '' gdy ostatni dzień zakresu ma dane. Dzień bez wierszy w środku
 * zakresu nie liczy się: Google publikuje dni po kolei, więc taki dzień jest
 * opublikowany i pusty.
 */
function gscMissingTailWarning_(startDate, endDate, rows) {
  let last = '';
  rows.forEach(row => {
    const date = String(row[0]);
    if (date >= startDate && date <= endDate && date > last) last = date;
  });
  if (last === endDate) return '';
  const from = last ? shiftDay_(last, 1) : startDate;
  return from === endDate
    ? 'brak danych za ' + endDate + ' (API nie zwróciło wierszy); następny import dzienny pobierze ten dzień ponownie'
    : 'brak danych za ' + from + ' – ' + endDate + ' (API nie zwróciło wierszy); następny import dzienny pobierze te dni ponownie';
}

/** Dzień `RRRR-MM-DD` przesunięty o `n` dni, liczony w UTC: bez wpływu strefy i zmiany czasu. */
function shiftDay_(day, n) {
  const p = day.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

/** Liczba dni od `from` do `to` (`RRRR-MM-DD`). */
function dayDiff_(from, to) {
  const utc = day => { const p = day.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  return Math.round((utc(to) - utc(from)) / 86400000);
}

/**
 * Import zakresu dat GSC. `options.daily`: ścieżka importu dziennego, która może
 * zapisać same importowane dni (#209); `options.warning`: ostrzeżenie zakresu;
 * `options.stage`: licznik etapów zaczęty przed wyznaczeniem zakresu (#215).
 */
function importRange_(startDate, endDate, options) {
  const opts = options || {};
  const stage = opts.stage || importStageTimer_('import GSC');
  const cfg = getConfig_();

  const endpoint =
    'https://www.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(cfg.siteUrl) +
    '/searchAnalytics/query';

  let allRows = [];
  let startRow = 0;

  while (true) {
    const payload = {
      startDate: startDate,
      endDate: endDate,

      dimensions: [
        'date',
        'query',
        'page',
        'country',
        'device'
      ],

      type: cfg.searchType,
      dataState: 'final',
      rowLimit: cfg.rowLimit,
      startRow: startRow
    };

    const response = apiRequest_(
      endpoint,
      'post',
      payload
    );

    const rows = response.rows || [];

    allRows = allRows.concat(rows);

    if (rows.length < cfg.rowLimit) {
      break;
    }

    startRow += cfg.rowLimit;
  }
  stage('zapytania API (' + allRows.length + ' wierszy)');

  const downloadedAt = new Date();

  const output = allRows.map(row => {
    const keys = row.keys || [];

    return [
      keys[0] || '',
      keys[1] || '',
      keys[2] || '',
      keys[3] || '',
      keys[4] || '',
      row.clicks || 0,
      row.impressions || 0,
      row.ctr || 0,
      row.position || 0,
      downloadedAt
    ];
  });

  const sheet = SpreadsheetApp.getActive().getSheetByName(RAW_SHEET);
  const warnings = [opts.warning, opts.daily ? gscMissingTailWarning_(startDate, endDate, output) : ''];
  // Same importowane dni tylko w imporcie dziennym i tylko przy zatwierdzonym
  // układzie K–L; każdy inny przypadek to zapis całej zakładki, jak dawniej.
  const layout = opts.daily ? gscKlLayout_(sheet, startDate, endDate) : null;
  if (layout) stage('rozpoznanie K–L');
  if (layout && layout.ok) {
    appendGscDays_(sheet, startDate, endDate, output, stage);
  } else {
    if (layout) {
      warnings.push(layout.warning);
      // Pełny tekst kotwic: z niego właściciel zatwierdza wzorzec.
      console.log('[import GSC] kotwice K–L (pełny tekst): ' + JSON.stringify(layout.anchors));
    }
    replaceRange_(sheet, startDate, endDate, output, stage);
  }

  // Status komórki B8 zapisuje recordImportRun_() na podstawie tego wyniku.
  const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
  // `dataFrom`/`dataTo`: zakres danych dla IMPORT LOG i bazy porównawczej anomalii (#180).
  return {
    rows: output.length,
    days: days,
    dataFrom: startDate,
    dataTo: endDate,
    detail: output.length + ' wierszy (' + startDate + ' – ' + endDate + ')',
    warning: warnings.filter(Boolean).join(' | ')
  };
}

function replaceRange_(sheet, startDate, endDate, newRows, stage) {
  const lastRow = sheet.getLastRow();

  let keepRows = [];

  if (lastRow > 1) {
    const existing = sheet
      .getRange(2, 1, lastRow - 1, 10)
      .getValues();

    keepRows = existing.filter(row => {
      const date = normalizujDate_(row[0]);

      if (!date) {
        return false;
      }

      return date < startDate || date > endDate;
    });
    stage('odczyt arkusza (' + existing.length + ' wierszy)');

    sheet
      .getRange(2, 1, lastRow - 1, 10)
      .clearContent();
    stage('czyszczenie');
  }

  const combined = keepRows.concat(newRows);

  if (combined.length) {
    sheet
      .getRange(2, 1, combined.length, 10)
      .setValues(combined);
    stage('zapis całej zakładki (' + combined.length + ' wierszy)');

    sheet
      .getRange(2, 8, combined.length, 1)
      .setNumberFormat('0.00%');

    sheet
      .getRange(2, 9, combined.length, 1)
      .setNumberFormat('0.0');

    sheet
      .getRange(2, 10, combined.length, 1)
      .setNumberFormat('yyyy-mm-dd hh:mm');
    stage('formaty');
  }
}

/**
 * Wzorce kotwic K–L zatwierdzone przez właściciela (#209): JSON `{"K": "…", "L": "…"}`
 * z pełnym tekstem formuł, tak jak wypisuje je log importu.
 */
const GSC_KL_PROPERTY = 'GSC_KL_ANCHOR_FORMULAS';

/**
 * Czy import dzienny może zapisać same importowane dni (#209).
 *
 * Kolumny K–L zakładki (`Pozycja×wyświetlenia`, `Data_num`) liczy formuła spoza
 * kodu. Usunięcie i dopisanie wierszy zostawia je poprawne tylko wtedy, gdy liczy
 * je jedna formuła rozlana na całą kolumnę. Z tekstu formuły tego nie da się
 * dowieść (`=ARRAYFORMULA(SUM(A2:A))` zwraca jedną wartość), więc szybka ścieżka
 * rusza wyłącznie dla kotwic identycznych z wzorcem zatwierdzonym przez
 * właściciela. Każdy inny stan to `ok: false` i zapis całej zakładki, który K–L
 * nie dotyka. Kod nigdy nie zapisuje K–L.
 *
 * Kotwica w wierszu 2 stoi zwykle obok danych A2:J2. Usunięcie wiersza 2
 * usunęłoby ją razem z danymi, więc gdy A2 należy do importowanego zakresu,
 * szybka ścieżka odmawia (PR #214). Wiersz 1 nie jest usuwany nigdy.
 */
function gscKlLayout_(sheet, startDate, endDate) {
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const range = sheet.getRange(1, 11, lastRow, 2);
  const formulas = range.getFormulas();
  const values = range.getValues();
  const patterns = gscKlPatterns_();
  const anchors = {};
  const problems = [];
  let anchorRow = 0;
  ['K', 'L'].forEach((col, c) => {
    const found = [];
    formulas.forEach((row, i) => {
      if (row[c]) found.push({ row: i + 1, text: row[c], value: values[i][c] });
    });
    anchors[col] = found.length ? found[0].text : '';
    if (found.length) anchorRow = Math.max(anchorRow, found[0].row);
    const reason = gscKlProblem_(found, patterns ? patterns[col] : undefined);
    if (reason) {
      problems.push(col + ': ' + reason + ', kotwica: ' + (found.length ? found[0].text.slice(0, 200) : 'brak formuły'));
    }
  });
  if (!problems.length && anchorRow === 2) {
    const a2 = normalizujDate_(sheet.getRange(2, 1).getValue());
    if (a2 && a2 >= startDate && a2 <= endDate) {
      problems.push('kotwica w wierszu 2, a wiersz 2 należy do importowanego zakresu (' + a2 + ')');
    }
  }
  return {
    ok: !problems.length,
    anchors: anchors,
    warning: problems.length ? 'K–L: zapis całej zakładki, bo ' + problems.join('; ') : ''
  };
}

/** Pierwszy niespełniony warunek szybkiej ścieżki dla jednej kolumny; '' gdy spełnione wszystkie. */
function gscKlProblem_(found, pattern) {
  if (!found.length) return 'brak formuły';
  if (found.length > 1) return 'więcej niż jedna formuła (' + found.length + ')';
  if (found[0].row > 2) return 'kotwica w wierszu ' + found[0].row + ', a nie 1 albo 2';
  if (typeof pattern !== 'string') return 'brak zatwierdzonego wzorca w ' + GSC_KL_PROPERTY;
  if (found[0].text !== pattern) return 'kotwica różna od zatwierdzonego wzorca';
  if (String(found[0].value).charAt(0) === '#') return 'wartość kotwicy to błąd (' + found[0].value + ')';
  return '';
}

/** Wzorce z GSC_KL_PROPERTY; brak albo niepoprawny JSON to null (ścieżka dotychczasowa, nie błąd). */
function gscKlPatterns_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GSC_KL_PROPERTY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

/**
 * Zapis samych importowanych dni (#209): usuwa wiersze z datami z zakresu
 * blokami od dołu i dopisuje nowe za ostatnią niepustą komórką kolumny A, nie za
 * `getLastRow()` — formuła rozlana w K–L może sięgać końca arkusza. Kolejność
 * pozostałych wierszy się nie zmienia; formaty dostają tylko dopisane wiersze.
 */
function appendGscDays_(sheet, startDate, endDate, newRows, stage) {
  const lastRow = sheet.getLastRow();
  const column = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(r => r[0]) : [];
  stage('odczyt kolumny A (' + column.length + ' wierszy)');

  const removed = column.map(v => {
    const date = normalizujDate_(v);
    return Boolean(date) && date >= startDate && date <= endDate;
  });
  const blocks = [];
  removed.forEach((hit, i) => {
    if (!hit) return;
    const last = blocks[blocks.length - 1];
    if (last && last.start + last.count === i) last.count++;
    else blocks.push({ start: i, count: 1 });
  });
  for (let b = blocks.length - 1; b >= 0; b--) {
    sheet.deleteRows(blocks[b].start + 2, blocks[b].count);
  }
  stage('usunięcie wierszy importowanych dni (' + removed.filter(Boolean).length + ')');

  if (!newRows.length) return;
  const kept = column.filter((v, i) => !removed[i]);
  let filled = kept.length;
  while (filled > 0 && (kept[filled - 1] === '' || kept[filled - 1] === null)) filled--;
  const firstRow = filled + 2;
  const needed = firstRow + newRows.length - 1;
  if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
  sheet.getRange(firstRow, 1, newRows.length, 10).setValues(newRows);
  stage('dopisanie wierszy (' + newRows.length + ')');

  sheet.getRange(firstRow, 8, newRows.length, 1).setNumberFormat('0.00%');
  sheet.getRange(firstRow, 9, newRows.length, 1).setNumberFormat('0.0');
  sheet.getRange(firstRow, 10, newRows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  stage('formaty');
}

function apiRequest_(url, method, payload) {
  const options = {
    method: method,
    muteHttpExceptions: true,

    headers: {
      Authorization:
        'Bearer ' + ScriptApp.getOAuthToken()
    }
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(
    url,
    options
  );

  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(
      'Search Console API HTTP ' +
      code +
      ':\n' +
      text
    );
  }

  return text ? JSON.parse(text) : {};
}

function getConfig_() {
  const sheet = SpreadsheetApp.getActive()
    .getSheetByName(CONFIG_SHEET);

  const values = sheet
    .getRange('A2:B8')
    .getValues();

  const cfg = {};

  values.forEach(row => {
    cfg[row[0]] = row[1];
  });

  return {
    siteUrl:
      String(cfg.siteUrl || '').trim(),

    daysBack:
      Number(cfg.daysBack || 30),

    dailyLagDays:
      Number(cfg.dailyLagDays || 3),

    rowLimit:
      Math.min(
        Number(cfg.rowLimit || 25000),
        25000
      ),

    searchType:
      String(cfg.searchType || 'web')
  };
}

function ustawAutomatycznyImport() {
  ScriptApp
    .getProjectTriggers()
    .filter(trigger =>
      trigger.getHandlerFunction() === 'importDzienny'
    )
    .forEach(trigger =>
      ScriptApp.deleteTrigger(trigger)
    );

  ScriptApp
    .newTrigger('importDzienny')
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .create();

  writeImportStatusCell_('GSC');

  SpreadsheetApp.getUi().alert(
    'Codzienny import został ustawiony.'
  );
}

function ustawStatus_(status) {
  SpreadsheetApp.getActive()
    .getSheetByName(CONFIG_SHEET)
    .getRange('B8')
    .setValue(status);
}

function przesunDate_(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatujDate_(date) {
  return Utilities.formatDate(
    date,
    TZ,
    'yyyy-MM-dd'
  );
}

function formatujDateCzas_(date) {
  return Utilities.formatDate(
    date,
    TZ,
    'yyyy-MM-dd HH:mm'
  );
}

function normalizujDate_(value) {
  if (!value) return '';

  if (value instanceof Date) {
    return formatujDate_(value);
  }

  return String(value).substring(0, 10);
}
