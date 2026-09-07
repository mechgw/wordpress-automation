/**
 * Google Business Profile: import wydajności i fraz wyszukiwania (#123).
 *
 * Etap pierwszy: wszystko poza samym dostępem do API. Konfiguracja, zakładki,
 * budowa żądań, parsowanie odpowiedzi, idempotentny zapis i czytelne błędy.
 * Dzięki temu włączenie funkcji sprowadza się później do dwóch kroków po
 * stronie Google, bez pisania kodu.
 *
 * Czego tu świadomie NIE ma:
 *
 *   1. Zakresu OAuth w appsscript.json. Dopisanie go wymusza ponowną
 *      autoryzację całego projektu, a nie ma powodu robić tego, zanim Google
 *      przyzna dostęp do Business Profile API. Do tego czasu import kończy się
 *      komunikatem mówiącym wprost, czego brakuje.
 *   2. Automatycznej edycji profilu. Czytamy i porównujemy, nie zmieniamy.
 *
 * Kształt odpowiedzi jest odwzorowany według dokumentacji Business Profile
 * Performance API v1, nie sprawdzony na żywym ruchu. Pierwszy prawdziwy przebieg
 * może wymagać korekty parsowania i to jest oczekiwane.
 */

const GBP_PERFORMANCE_SHEET = 'GBP PERFORMANCE RAW';
const GBP_KEYWORDS_SHEET = 'GBP SEARCH KEYWORDS';
const GBP_PERFORMANCE_HEADER = ['Data', 'Lokalizacja', 'Metryka', 'Wartość', 'Pobrano'];
const GBP_KEYWORDS_HEADER = ['Miesiąc', 'Lokalizacja', 'Fraza', 'Wyświetlenia', 'Rodzaj wartości', 'Pobrano'];

const GBP_API_BASE = 'https://businessprofileperformance.googleapis.com/v1/';

/**
 * Metryki dzienne o wartości marketingowej. Lista jest jawna, bo API zwraca
 * tylko to, o co poprosimy, a cicha zmiana zestawu rozjechałaby historię.
 */
const GBP_DAILY_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS'
];

/** Lokalizacja w formacie `locations/<id>`; identyfikator instalacji trzyma Script Property. */
const GBP_LOCATION_PATTERN = /^locations\/[A-Za-z0-9_-]+$/;

/**
 * Konfiguracja z Script Properties. Brak lokalizacji nie jest błędem, tylko
 * informacją, że funkcja nie jest używana: import odmawia z jasnym powodem,
 * a monitoring traktuje zadanie jako nieużywane.
 */
function getGbpConfig_() {
  const location = String(PropertiesService.getScriptProperties().getProperty('GBP_LOCATION') || '').trim();
  if (!location) {
    throw new Error(
      'Brak Script Property: GBP_LOCATION. Wpisz identyfikator lokalizacji w formacie ' +
      'locations/<id>, żeby włączyć import Business Profile.'
    );
  }
  if (!GBP_LOCATION_PATTERN.test(location)) {
    throw new Error('Nieprawidłowa Script Property GBP_LOCATION: oczekiwano formatu locations/<id>, jest „' + location + '”.');
  }
  return { location: location };
}

/** Czy funkcja jest w ogóle skonfigurowana; bez rzucania wyjątkiem. */
function isGbpConfigured_() {
  const location = String(PropertiesService.getScriptProperties().getProperty('GBP_LOCATION') || '').trim();
  return GBP_LOCATION_PATTERN.test(location);
}

/** Data jako obiekt API: rok, miesiąc, dzień w osobnych polach. */
function gbpDateParams_(prefix, date) {
  return prefix + '.year=' + date.getFullYear() +
    '&' + prefix + '.month=' + (date.getMonth() + 1) +
    '&' + prefix + '.day=' + date.getDate();
}

/** Adres żądania metryk dziennych dla zakresu dat. */
function gbpDailyUrl_(location, start, end) {
  return GBP_API_BASE + location + ':fetchMultiDailyMetricsTimeSeries' +
    '?' + GBP_DAILY_METRICS.map(function (m) { return 'dailyMetrics=' + m; }).join('&') +
    '&' + gbpDateParams_('dailyRange.start_date', start) +
    '&' + gbpDateParams_('dailyRange.end_date', end);
}

/** Adres żądania miesięcznych fraz wyszukiwania. */
function gbpKeywordsUrl_(location, pageToken) {
  return GBP_API_BASE + location + '/searchkeywords/impressions/monthly' +
    (pageToken ? '?pageToken=' + encodeURIComponent(pageToken) : '');
}

/**
 * Wywołanie API z rozróżnieniem powodów odmowy. Bez tego pierwszy kontakt
 * z tym API kończy się surowym 403 i godziną szukania, czy to brak zakresu,
 * brak przyznanego dostępu, czy zła lokalizacja.
 */
function gbpApiRequest_(url) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText() || '';

  if (code === 401) {
    throw new Error(
      'Business Profile API odmówiło uwierzytelnienia (401). Najczęstsza przyczyna to brak zakresu ' +
      'OAuth w appsscript.json: dopisz zakres Business Profile i autoryzuj projekt ponownie.'
    );
  }
  if (code === 403) {
    throw new Error(
      'Business Profile API odmówiło dostępu (403). Włączenie API w Google Cloud nie wystarcza: ' +
      'Google przyznaje dostęp do Business Profile na osobny wniosek, a do tego czasu limit wynosi zero.\n\n' +
      text.slice(0, 500)
    );
  }
  if (code === 404) {
    throw new Error(
      'Business Profile API nie zna tej lokalizacji (404). Sprawdź GBP_LOCATION; ' +
      'oczekiwany format to locations/<id>.'
    );
  }
  if (code < 200 || code >= 300) {
    throw new Error('Business Profile API HTTP ' + code + ':\n' + text.slice(0, 1000));
  }

  return text ? JSON.parse(text) : {};
}

/** Data z odpowiedzi (rok/miesiąc/dzień) jako `RRRR-MM-DD`. */
function gbpDateKey_(date) {
  if (!date || !date.year || !date.month || !date.day) return '';
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return date.year + '-' + pad(date.month) + '-' + pad(date.day);
}

/**
 * Spłaszcza odpowiedź metryk dziennych do wierszy { date, metric, value }.
 *
 * Brak wartości NIE jest zamieniany na zero: API pomija dni bez danych, a to
 * nie to samo co dzień z zerem. Zapisujemy tylko to, co odpowiedź naprawdę
 * zawiera, żeby wykres nie mylił braku pomiaru z pomiarem równym zeru.
 */
function parseGbpDailySeries_(response) {
  const rows = [];
  const multi = (response && response.multiDailyMetricTimeSeries) || [];
  multi.forEach(function (group) {
    ((group && group.dailyMetricTimeSeries) || []).forEach(function (series) {
      const metric = String((series && series.dailyMetric) || '');
      const dated = (series && series.timeSeries && series.timeSeries.datedValues) || [];
      dated.forEach(function (entry) {
        const key = gbpDateKey_(entry && entry.date);
        if (!key || !metric) return;
        if (entry.value === undefined || entry.value === null || entry.value === '') return;
        rows.push({ date: key, metric: metric, value: Number(entry.value) });
      });
    });
  });
  return rows;
}

/**
 * Frazy miesięczne. `insightsValue` jest unią: dokładna liczba albo próg,
 * poniżej którego Google nie podaje wartości. Zapisujemy oba, wraz z rodzajem,
 * bo potraktowanie progu jak dokładnej liczby zawyżałoby sumy.
 */
function parseGbpKeywords_(response) {
  const rows = [];
  ((response && response.searchKeywordsCounts) || []).forEach(function (entry) {
    const keyword = String((entry && entry.searchKeyword) || '').trim();
    if (!keyword) return;
    const insights = (entry && entry.insightsValue) || {};
    if (insights.value !== undefined && insights.value !== null) {
      rows.push({ keyword: keyword, value: Number(insights.value), kind: 'dokładna' });
    } else if (insights.threshold !== undefined && insights.threshold !== null) {
      rows.push({ keyword: keyword, value: Number(insights.threshold), kind: 'próg (co najmniej)' });
    } else {
      rows.push({ keyword: keyword, value: '', kind: 'brak wartości' });
    }
  });
  return rows;
}

/**
 * Zapis idempotentny: wiersze o tym samym kluczu są podmieniane, reszta
 * zostaje. Ponowny import tego samego zakresu nie tworzy duplikatów, a backfill
 * starszego okresu nie kasuje nowszych danych.
 */
function upsertGbpRows_(sheetName, header, keyColumns, rows) {
  const sheet = ensureSheetWithHeader_(sheetName, header);
  const keyOf = function (row) { return keyColumns.map(function (i) { return String(row[i]); }).join(' '); };
  const incoming = {};
  rows.forEach(function (row) { incoming[keyOf(row)] = true; });

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, header.length).getValues() : [];
  const kept = existing.filter(function (row) {
    return String(row[0] || '') !== '' && !incoming[keyOf(row)];
  });

  const combined = kept.concat(rows);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, header.length).clearContent();
  if (combined.length) {
    ensureSheetRows_(sheet, combined.length + 1);
    sheet.getRange(2, 1, combined.length, header.length).setValues(combined);
  }
  return { written: rows.length, kept: kept.length };
}

/** Import metryk dziennych za podany zakres; domyślnie ostatnie 7 dni do wczoraj. */
function runGbpPerformanceImport_(startDate, endDate) {
  const config = getGbpConfig_();
  const end = endDate || new Date(Date.now() - 86400000);
  const start = startDate || new Date(end.getTime() - 6 * 86400000);

  const response = gbpApiRequest_(gbpDailyUrl_(config.location, start, end));
  const now = new Date();
  const rows = parseGbpDailySeries_(response).map(function (r) {
    return [r.date, config.location, r.metric, r.value, now];
  });

  const out = upsertGbpRows_(GBP_PERFORMANCE_SHEET, GBP_PERFORMANCE_HEADER, [0, 1, 2], rows);
  return {
    rows: rows.length,
    kept: out.kept,
    detail: rows.length + ' pomiarów (' + gbpDateKey_({ year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() }) +
      ' – ' + gbpDateKey_({ year: end.getFullYear(), month: end.getMonth() + 1, day: end.getDate() }) + ')'
  };
}

/** Import miesięcznych fraz wyszukiwania, ze stronicowaniem. */
function runGbpKeywordsImport_() {
  const config = getGbpConfig_();
  const now = new Date();
  const month = now.getFullYear() + '-' + ((now.getMonth() + 1) < 10 ? '0' : '') + (now.getMonth() + 1);
  let pageToken = '';
  const rows = [];
  let pages = 0;

  do {
    const response = gbpApiRequest_(gbpKeywordsUrl_(config.location, pageToken));
    parseGbpKeywords_(response).forEach(function (r) {
      rows.push([month, config.location, r.keyword, r.value, r.kind, now]);
    });
    pageToken = String((response && response.nextPageToken) || '');
    pages++;
  } while (pageToken && pages < 20);

  const out = upsertGbpRows_(GBP_KEYWORDS_SHEET, GBP_KEYWORDS_HEADER, [0, 1, 2], rows);
  return { rows: rows.length, kept: out.kept, detail: rows.length + ' fraz za ' + month };
}

/** Menu: import z ręki, z podsumowaniem w oknie. */
function importujBusinessProfile() {
  const performance = runGbpPerformanceImport_();
  const keywords = runGbpKeywordsImport_();
  SpreadsheetApp.getUi().alert([
    'Business Profile: import zakończony.',
    '',
    'Wydajność: ' + performance.detail + ', zachowano ' + performance.kept + ' wcześniejszych wierszy.',
    'Frazy: ' + keywords.detail + ', zachowano ' + keywords.kept + ' wcześniejszych wierszy.'
  ].join('\n'));
  return { performance: performance, keywords: keywords };
}

/** Menu: zakłada obie zakładki i tłumaczy, czego jeszcze brakuje do działania. */
function przygotujBusinessProfile() {
  ensureSheetWithHeader_(GBP_PERFORMANCE_SHEET, GBP_PERFORMANCE_HEADER);
  ensureSheetWithHeader_(GBP_KEYWORDS_SHEET, GBP_KEYWORDS_HEADER);
  const configured = isGbpConfigured_();
  SpreadsheetApp.getUi().alert([
    'Zakładki „' + GBP_PERFORMANCE_SHEET + '” i „' + GBP_KEYWORDS_SHEET + '” są gotowe.',
    '',
    'Stan konfiguracji: ' + (configured ? 'GBP_LOCATION ustawione.' : 'brak Script Property GBP_LOCATION.'),
    '',
    'Do uruchomienia importu potrzebne są jeszcze trzy rzeczy po stronie Google:',
    '1. Włączone Business Profile Performance API w projekcie Google Cloud.',
    '2. Przyznany dostęp do Business Profile API; samo włączenie nie wystarcza,',
    '   bez wniosku limit wynosi zero.',
    '3. Zakres OAuth Business Profile w appsscript.json i ponowna autoryzacja.',
    '',
    'GBP_LOCATION ma format locations/<id>. Import jest idempotentny:',
    'ponowne uruchomienie tego samego zakresu nie tworzy duplikatów.'
  ].join('\n'));
  return configured;
}
