/**
 * Google Business Profile: import wydajności i fraz wyszukiwania (#123).
 *
 * Konfiguracja, zakładki, budowa żądań, parsowanie odpowiedzi, idempotentny
 * zapis i czytelne błędy. Zakres OAuth `business.manage` trafił do
 * appsscript.json dopiero po tym, jak Google przyznał projektowi dostęp do
 * Business Profile API: dopisanie zakresu wymusza ponowną autoryzację całego
 * projektu, więc wcześniej nie było powodu tego robić.
 *
 * Codzienny import idzie przez rejestr zadań cyklicznych (`scheduledJobs_()`,
 * klucz `GBP`), więc strażnik aktualności, diagnostyka i `IMPORT LOG` widzą go
 * tak samo jak każde inne zadanie.
 *
 * Czego tu świadomie NIE ma: automatycznej edycji profilu. Czytamy
 * i porównujemy, nie zmieniamy.
 *
 * Kształt odpowiedzi jest odwzorowany według dokumentacji Business Profile
 * Performance API v1, nie sprawdzony na żywym ruchu. Pierwszy prawdziwy przebieg
 * może wymagać korekty parsowania i to jest oczekiwane.
 */

const GBP_PERFORMANCE_SHEET = 'GBP PERFORMANCE RAW';
const GBP_KEYWORDS_SHEET = 'GBP SEARCH KEYWORDS';
const GBP_PERFORMANCE_HEADER = ['Data', 'Lokalizacja', 'Metryka', 'Wartość', 'Pobrano'];
const GBP_KEYWORDS_HEADER = ['Miesiąc', 'Lokalizacja', 'Fraza', 'Wyświetlenia', 'Rodzaj wartości', 'Pobrano'];

/**
 * Klucze zapisu. Arkusz zamienia zapisany tekst `RRRR-MM-DD` i `RRRR-MM` na datę
 * i przy odczycie oddaje obiekt `Date`, więc pierwsza kolumna wymaga postaci
 * kanonicznej po obu stronach porównania — ta sama pułapka co #155. Bez tego
 * każdy import dopisywał wszystko od nowa: 26.09.2026 po trzech importach obie
 * zakładki miały po trzy kopie każdego wiersza.
 *
 * Formaty są literałami, a nie stałymi z Performance.gs: ten plik ładuje się
 * wcześniej, a stała z innego pliku na najwyższym poziomie nie jest jeszcze
 * zdefiniowana.
 */
const GBP_PERFORMANCE_KEY = [{ column: 0, dateFormat: 'yyyy-MM-dd' }, 1, 2];
const GBP_KEYWORDS_KEY = [{ column: 0, dateFormat: 'yyyy-MM' }, 1, 2];

const GBP_API_BASE = 'https://businessprofileperformance.googleapis.com/v1/';

/**
 * Codzienny import (#123). Godzina po importach GSC (05:00) i GA4 (06:00),
 * a przed strażnikiem aktualności (08:00), żeby strażnik widział dzisiejszy przebieg.
 */
const GBP_TRIGGER_HANDLER = 'importBusinessProfileTrigger';
const GBP_TRIGGER_HOUR = 7;

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

/** Miesiąc jako obiekt API: rok i miesiąc w osobnych polach. */
function gbpMonthParams_(prefix, month) {
  return prefix + '.year=' + month.year + '&' + prefix + '.month=' + month.month;
}

/**
 * Ostatni pełny miesiąc przed `now`. Frazy są agregatem miesięcznym, a bieżący
 * miesiąc nie jest zamknięty, więc jego liczby byłyby częściowe.
 */
function gbpLastFullMonth_(now) {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { year: first.getFullYear(), month: first.getMonth() + 1 };
}

/** Miesiąc jako klucz wiersza `RRRR-MM`. */
function gbpMonthKey_(month) {
  return month.year + '-' + (month.month < 10 ? '0' : '') + month.month;
}

/**
 * Adres żądania miesięcznych fraz wyszukiwania dla jednego miesiąca.
 * `monthlyRange` jest wymagane, a API sumuje wyświetlenia z całego zakresu,
 * więc historia miesiąc po miesiącu wymaga osobnego zapytania o każdy miesiąc.
 */
function gbpKeywordsUrl_(location, month, pageToken) {
  return GBP_API_BASE + location + '/searchkeywords/impressions/monthly' +
    '?' + gbpMonthParams_('monthlyRange.start_month', month) +
    '&' + gbpMonthParams_('monthlyRange.end_month', month) +
    (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
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
      'Business Profile API odmówiło uwierzytelnienia (401). Sprawdź, czy appsscript.json zawiera zakres ' +
      'business.manage i czy projekt został po jego dodaniu ponownie autoryzowany.'
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
 * Punkt z datą, ale bez `value`, to zero: dokumentacja DatedValue mówi, że
 * wartość „nie występuje, gdy wynosi zero”. Tak samo wyglądają jednak dni,
 * których Google jeszcze nie przetworzył. W pierwszym imporcie ostatnie dwa
 * dni zakresu nie miały wartości w żadnej metryce, także w tej, która
 * wcześniej miała ją codziennie. Zero wpisujemy więc tylko do horyzontu:
 * ostatniego dnia, dla którego odpowiedź zawiera jakąkolwiek wartość.
 * Późniejsze dni pomijamy, a kolejny import je uzupełni.
 */
function parseGbpDailySeries_(response) {
  const points = [];
  const multi = (response && response.multiDailyMetricTimeSeries) || [];
  multi.forEach(function (group) {
    ((group && group.dailyMetricTimeSeries) || []).forEach(function (series) {
      const metric = String((series && series.dailyMetric) || '');
      const dated = (series && series.timeSeries && series.timeSeries.datedValues) || [];
      dated.forEach(function (entry) {
        const key = gbpDateKey_(entry && entry.date);
        if (!key || !metric) return;
        const present = entry.value !== undefined && entry.value !== null && entry.value !== '';
        points.push({ date: key, metric: metric, value: present ? Number(entry.value) : null });
      });
    });
  });
  const horizon = points.reduce(function (max, p) {
    return p.value !== null && p.date > max ? p.date : max;
  }, '');
  return points
    .filter(function (p) { return p.value !== null || p.date <= horizon; })
    .map(function (p) { return { date: p.date, metric: p.metric, value: p.value === null ? 0 : p.value }; });
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
 *
 * Pole klucza to numer kolumny („porównuj tekst”) albo `{ column, dateFormat }`
 * („sprowadź datę z komórki do tej postaci w strefie arkusza”) — kontrakt
 * `performanceKeyPart_()` z #155. Duplikaty, które już są w zakładce, scalamy
 * przy każdym zapisie, także poza zakresem bieżącego importu — inaczej dni,
 * które wyszły z okna importu, zostałyby zdublowane na zawsze.
 */
function upsertGbpRows_(sheetName, header, keySpec, rows) {
  const sheet = ensureSheetWithHeader_(sheetName, header);
  const timeZone = performanceTimeZone_();
  const keyOf = function (row) {
    return keySpec.map(function (part) {
      return typeof part === 'number'
        ? String(row[part])
        : performanceKeyPart_(row[part.column], part.dateFormat, timeZone);
    }).join('\u0000');
  };
  const incoming = {};
  rows.forEach(function (row) { incoming[keyOf(row)] = true; });

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, header.length).getValues() : [];
  // Zostaje kopia z najnowszym `Pobrano`, a nie ta najniżej w arkuszu: pozycja
  // wiersza nie jest chronologią, bo zakładkę wolno posortować. Przy równym albo
  // nieczytelnym `Pobrano` rozstrzyga pozycja — ta sama reguła co w upsercie
  // pomiaru wydajności.
  const fetchedAt = header.indexOf('Pobrano');
  const best = {};
  let present = 0;
  existing.forEach(function (row, index) {
    if (String(row[0] || '') === '') return;
    present++;
    const key = keyOf(row);
    const previous = best[key];
    if (previous === undefined ||
        performanceRowTime_(row[fetchedAt]) >= performanceRowTime_(existing[previous][fetchedAt])) {
      best[key] = index;
    }
  });
  const merged = present - Object.keys(best).length;
  const chosen = {};
  Object.keys(best).forEach(function (key) { if (!incoming[key]) chosen[best[key]] = true; });
  const kept = existing.filter(function (row, index) { return chosen[index] === true; });

  const combined = kept.concat(rows);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, header.length).clearContent();
  if (combined.length) {
    ensureSheetRows_(sheet, combined.length + 1);
    sheet.getRange(2, 1, combined.length, header.length).setValues(combined);
  }
  return { written: rows.length, kept: kept.length, merged: merged };
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

  const out = upsertGbpRows_(GBP_PERFORMANCE_SHEET, GBP_PERFORMANCE_HEADER, GBP_PERFORMANCE_KEY, rows);
  const from = gbpDateKey_({ year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() });
  const to = gbpDateKey_({ year: end.getFullYear(), month: end.getMonth() + 1, day: end.getDate() });
  // Ostatnie dni zakresu bywają jeszcze nieprzetworzone; mówimy, do kiedy są dane,
  // żeby brak wierszy za te dni nie wyglądał na błąd importu.
  const last = rows.reduce(function (max, r) { return r[0] > max ? r[0] : max; }, '');
  const horizon = !last ? '; Google nie podał jeszcze danych z tego zakresu' : (last < to ? '; dane Google do ' + last : '');
  return {
    rows: rows.length,
    kept: out.kept,
    merged: out.merged,
    detail: rows.length + ' pomiarów (' + from + ' – ' + to + horizon + ')'
  };
}

/**
 * Import fraz za ostatni pełny miesiąc, ze stronicowaniem. Wiersze dostają
 * miesiąc, o który pytaliśmy, a nie miesiąc uruchomienia. Na początku miesiąca
 * dane bywają jeszcze niepełne; ponowny import podmienia je dzięki upsertowi.
 */
function runGbpKeywordsImport_() {
  const config = getGbpConfig_();
  const now = new Date();
  const target = gbpLastFullMonth_(now);
  const month = gbpMonthKey_(target);
  let pageToken = '';
  const rows = [];
  let pages = 0;

  do {
    const response = gbpApiRequest_(gbpKeywordsUrl_(config.location, target, pageToken));
    parseGbpKeywords_(response).forEach(function (r) {
      rows.push([month, config.location, r.keyword, r.value, r.kind, now]);
    });
    pageToken = String((response && response.nextPageToken) || '');
    pages++;
  } while (pageToken && pages < 20);

  const out = upsertGbpRows_(GBP_KEYWORDS_SHEET, GBP_KEYWORDS_HEADER, GBP_KEYWORDS_KEY, rows);
  return { rows: rows.length, kept: out.kept, merged: out.merged, detail: rows.length + ' fraz za ' + month };
}

/** Dopisek o scalonych duplikatach; pusty, gdy zakładka ich nie miała. */
function gbpMergedNote_(result) {
  return result.merged ? ', scalono ' + result.merged + ' zdublowanych' : '';
}

/**
 * Obie części importu w kontrakcie `recordJobRun_()`: { rows, detail, warning }.
 *
 * Ostrzeżenie tylko wtedy, gdy w całym oknie 7 dni nie ma żadnego pomiaru.
 * Zwykłe opóźnienie Google to 2–3 dni i horyzont danych opisuje je w `detail`;
 * pusty tydzień to już coś innego niż opóźnienie, ale nie błąd — import się udał.
 * Brak fraz za ostatni miesiąc nie ostrzega, bo w pierwszych dniach miesiąca
 * Google jeszcze ich nie podaje.
 */
function runGbpImport_() {
  const performance = runGbpPerformanceImport_();
  const keywords = runGbpKeywordsImport_();
  return {
    performance: performance,
    keywords: keywords,
    rows: performance.rows + keywords.rows,
    detail: 'wydajność: ' + performance.detail + ' | frazy: ' + keywords.detail,
    warning: performance.rows ? '' : 'Google nie podał żadnych pomiarów wydajności z ostatnich 7 dni'
  };
}

/** Handler codziennego triggera; przebieg trafia do rekordu zadania i `IMPORT LOG`. */
function importBusinessProfileTrigger() {
  return recordJobRun_('GBP', true, () => withScriptLock_('import Business Profile', runGbpImport_));
}

/**
 * Menu: import z ręki, z podsumowaniem w oknie. Pod blokadą skryptu, bo upsert
 * przepisuje całą zakładkę, a równoległy przebieg z triggera zgubiłby zapis.
 * Bez rekordu zadania, jak ręczny live check SEO: ręczny przebieg bez triggera
 * wyglądałby po dobie dla strażnika jak zadanie, które przestało działać.
 */
function importujBusinessProfile() {
  const result = withScriptLock_('import Business Profile', runGbpImport_);
  const performance = result.performance;
  const keywords = result.keywords;
  SpreadsheetApp.getUi().alert([
    'Business Profile: import zakończony.',
    '',
    'Wydajność: ' + performance.detail + ', zachowano ' + performance.kept + ' wcześniejszych wierszy' + gbpMergedNote_(performance) + '.',
    'Frazy: ' + keywords.detail + ', zachowano ' + keywords.kept + ' wcześniejszych wierszy' + gbpMergedNote_(keywords) + '.'
  ].join('\n'));
  return result;
}

/**
 * Menu: instaluje codzienny import (ok. 07:00), zastępując poprzedni. Bez
 * `GBP_LOCATION` odmawia, bo trigger kończyłby się co dzień błędem konfiguracji.
 */
function ustawCodziennyImportBusinessProfile() {
  const ui = SpreadsheetApp.getUi();
  if (!isGbpConfigured_()) {
    ui.alert(
      'Codzienny import Business Profile NIE został włączony: brak poprawnej Script Property GBP_LOCATION ' +
      '(format locations/<id>). Ustaw ją i uruchom tę pozycję ponownie.'
    );
    return false;
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === GBP_TRIGGER_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(GBP_TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(GBP_TRIGGER_HOUR)
    .create();

  ui.alert(
    'Codzienny import Business Profile został ustawiony (ok. ' + GBP_TRIGGER_HOUR + ':00): wydajność z ostatnich 7 dni ' +
    'i frazy za ostatni pełny miesiąc.\n' +
    'Brak udanego przebiegu dłużej niż ' + IMPORT_STALE_AFTER_HOURS + ' h zgłosi strażnik aktualności; e-mail na adres: ' +
    alertRecipientText_()
  );
  return true;
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
    'Po stronie Google import wymaga dwóch rzeczy, których nie da się załatwić kodem:',
    '1. Włączone Business Profile Performance API w projekcie Google Cloud.',
    '2. Przyznany dostęp do Business Profile API; samo włączenie nie wystarcza,',
    '   bez wniosku limit wynosi zero.',
    'Zakres OAuth Business Profile jest już w appsscript.json.',
    '',
    'GBP_LOCATION ma format locations/<id>. Import jest idempotentny:',
    'ponowne uruchomienie tego samego zakresu nie tworzy duplikatów.'
  ].join('\n'));
  return configured;
}
