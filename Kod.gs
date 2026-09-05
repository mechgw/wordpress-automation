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

/** Import jednego dnia: handler codziennego triggera i pozycja menu (wtedy liczony jako ręczny). */
function importDzienny(e) {
  return recordImportRun_('GSC', isTriggerRun_(e), () => withScriptLock_('import GSC', () => {
    const cfg = getConfig_();

    const targetDate = przesunDate_(
      new Date(),
      -cfg.dailyLagDays
    );

    const date = formatujDate_(targetDate);

    return importRange_(date, date);
  }));
}

function importRange_(startDate, endDate) {
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

  replaceRange_(startDate, endDate, output);

  // Status komórki B8 zapisuje recordImportRun_() na podstawie tego wyniku.
  const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
  return { rows: output.length, days: days, detail: output.length + ' wierszy (' + startDate + ' – ' + endDate + ')' };
}

function replaceRange_(startDate, endDate, newRows) {
  const sheet = SpreadsheetApp.getActive()
    .getSheetByName(RAW_SHEET);

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

    sheet
      .getRange(2, 1, lastRow - 1, 10)
      .clearContent();
  }

  const combined = keepRows.concat(newRows);

  if (combined.length) {
    sheet
      .getRange(2, 1, combined.length, 10)
      .setValues(combined);

    sheet
      .getRange(2, 8, combined.length, 1)
      .setNumberFormat('0.00%');

    sheet
      .getRange(2, 9, combined.length, 1)
      .setNumberFormat('0.0');

    sheet
      .getRange(2, 10, combined.length, 1)
      .setNumberFormat('yyyy-mm-dd hh:mm');
  }
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
