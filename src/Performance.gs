/**
 * Pomiar wydajności publicznych adresów: CrUX i PageSpeed Insights (#124).
 *
 * Dwa źródła są celowo trzymane osobno i nigdy nie uśredniane w jedną liczbę.
 * CrUX to dane terenowe od prawdziwych użytkowników, PSI to laboratorium
 * z jednego przebiegu. Zlepienie ich dałoby wskaźnik, który nie znaczy nic.
 *
 * Lighthouse jest zmienny, więc pomiar laboratoryjny zapisuje każdą próbę
 * osobno i porównuje przez medianę, a nie przez ostatni wynik. Pojedynczy słaby
 * przebieg nie jest regresją.
 *
 * Obie usługi działają na klucz API w parametrze zapytania, bez OAuth, więc
 * włączenie funkcji nie wymaga ponownej autoryzacji projektu ani nowego
 * zakresu w appsscript.json.
 */

const PERF_FIELD_SHEET = 'CWV FIELD';
const PERF_LAB_SHEET = 'PAGESPEED LAB';
const PERF_URLS_SHEET = 'PERFORMANCE URLS';

const PERF_URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const PERF_FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const PERF_LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano'];

const CRUX_API = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const PSI_API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** Ile prób Lighthouse na adres i strategię; mediana z nich jest podstawą porównań. */
const PSI_ATTEMPTS = 3;

/**
 * Budżet czasu na pomiar laboratoryjny w jednym przebiegu.
 *
 * Jedno wywołanie PSI trwa kilkanaście do kilkudziesięciu sekund, a przy trzech
 * próbach i dwóch strategiach daje sześć wywołań na adres. Nawet kilka adresów
 * przekroczyłoby limit czasu wykonania Apps Script, a przerwany przebieg
 * zostawiłby część pomiarów bez zapisu.
 *
 * Zamiast tego mierzymy tyle adresów, ile mieści się w budżecie, i zapamiętujemy,
 * gdzie skończyliśmy. Kolejny przebieg zaczyna od następnego adresu, więc przy
 * cyklicznym uruchamianiu wszystkie doczekają się pomiaru.
 */
const PSI_TIME_BUDGET_MS = 4 * 60 * 1000;
const PSI_CURSOR_PROP = 'PAGESPEED_CURSOR';

/** Adres, od którego zacząć ten przebieg; rotacja po kolejnych uruchomieniach. */
function psiStartIndex_(total) {
  const raw = Number(PropertiesService.getScriptProperties().getProperty(PSI_CURSOR_PROP) || 0);
  return total > 0 && raw > 0 ? raw % total : 0;
}

function savePsiCursor_(index) {
  PropertiesService.getScriptProperties().setProperty(PSI_CURSOR_PROP, String(index));
}

/** Metryki terenowe, w nazwach CrUX. */
const CRUX_METRICS = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'];

/** Audyty PSI, które zapisujemy; klucz to nazwa audytu, wartość to etykieta. */
function psiAudits_() {
  return {
    'largest-contentful-paint': 'LCP',
    'cumulative-layout-shift': 'CLS',
    'total-blocking-time': 'TBT',
    'first-contentful-paint': 'FCP',
    'speed-index': 'Speed Index',
    'server-response-time': 'TTFB',
    'total-byte-weight': 'Transfer'
  };
}

/** Klucz API z konfiguracji; bez niego funkcja jest po prostu nieużywana. */
function performanceApiKey_() {
  const key = String(PropertiesService.getScriptProperties().getProperty('PAGESPEED_API_KEY') || '').trim();
  if (!key) {
    throw new Error(
      'Brak Script Property: PAGESPEED_API_KEY. Utwórz klucz API w Google Cloud i włącz dla niego ' +
      'PageSpeed Insights API oraz Chrome UX Report API. Klucz wystarcza; OAuth nie jest potrzebny.'
    );
  }
  return key;
}

/** Czy funkcja jest skonfigurowana; bez rzucania wyjątkiem. */
function isPerformanceConfigured_() {
  return String(PropertiesService.getScriptProperties().getProperty('PAGESPEED_API_KEY') || '').trim() !== '';
}

/** Monitorowane adresy z arkusza; kod nie zna żadnej domeny. */
function performanceUrls_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PERF_URLS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, PERF_URLS_HEADER.length).getValues()
    .map(function (row) { return { url: String(row[0] || '').trim(), role: String(row[1] || '').trim() }; })
    .filter(function (entry) { return /^https?:\/\//i.test(entry.url); });
}

/**
 * Wywołanie API z rozróżnieniem powodów odmowy. 403 przy tych usługach znaczy
 * najczęściej niewłączone API dla klucza, a 429 wyczerpany limit; jedno i drugie
 * wymaga innego działania niż zwykły błąd.
 */
function performanceApiRequest_(url) {
  const res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  const code = res.getResponseCode();
  const text = res.getContentText() || '';

  if (code === 403) {
    throw new Error(
      'Odmowa dostępu (403). Sprawdź, czy klucz z PAGESPEED_API_KEY ma włączone PageSpeed Insights API ' +
      'i Chrome UX Report API oraz czy jego ograniczenia nie blokują wywołań z Apps Script.\n\n' + text.slice(0, 400)
    );
  }
  if (code === 429) {
    throw new Error('Przekroczony limit zapytań (429). Ponów pomiar później albo zmniejsz liczbę adresów.');
  }
  if (code < 200 || code >= 300) {
    // Lighthouse potrafi wywrócić się na pojedynczym adresie i zwraca wtedy 500
    // z domeną „lighthouse”. To awaria jednej próby, a nie konfiguracji ani
    // klucza, więc nie może przerywać całego pomiaru.
    const error = new Error('HTTP ' + code + ':\n' + text.slice(0, 800));
    error.transient = code >= 500;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

/** Zapytanie CrUX o jeden adres i jeden form factor. */
function cruxRequest_(target, formFactor, key, byOrigin) {
  const scope = byOrigin ? { origin: target } : { url: target };
  const res = UrlFetchApp.fetch(CRUX_API + '?key=' + encodeURIComponent(key), {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(Object.assign({ formFactor: formFactor, metrics: CRUX_METRICS }, scope))
  });
  const code = res.getResponseCode();
  const text = res.getContentText() || '';

  // 404 znaczy „za mało danych dla tego adresu”, a nie awarię. Brak danych
  // terenowych to informacja o ruchu, nie błąd strony.
  if (code === 404) return null;
  if (code === 403) {
    throw new Error('CrUX odmówił dostępu (403). Włącz Chrome UX Report API dla klucza z PAGESPEED_API_KEY.\n\n' + text.slice(0, 400));
  }
  if (code === 429) throw new Error('CrUX: przekroczony limit zapytań (429).');
  if (code < 200 || code >= 300) throw new Error('CrUX HTTP ' + code + ':\n' + text.slice(0, 800));
  return text ? JSON.parse(text) : null;
}

/** Domena adresu w postaci, której oczekuje CrUX: schemat i host, bez ścieżki. */
function cruxOrigin_(url) {
  const match = /^(https?:\/\/[^/?#]+)/i.exec(String(url || '').trim());
  return match ? match[1] : '';
}

/** Ostatni dzień okresu zbiorczego CrUX jako `RRRR-MM-DD`. */
function cruxPeriodEnd_(record) {
  const last = record && record.collectionPeriod && record.collectionPeriod.lastDate;
  if (!last || !last.year || !last.month || !last.day) return '';
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return last.year + '-' + pad(last.month) + '-' + pad(last.day);
}

/**
 * Wiersze danych terenowych. Brak metryki jest zapisywany jako
 * INSUFFICIENT_DATA, nigdy jako zero: zero znaczyłoby doskonały wynik.
 */
function parseCruxRecord_(record, url, formFactor, now, source) {
  const period = cruxPeriodEnd_(record && record.record);
  const metrics = (record && record.record && record.record.metrics) || {};
  return CRUX_METRICS.map(function (name) {
    const metric = metrics[name];
    const p75 = metric && metric.percentiles ? metric.percentiles.p75 : undefined;
    const has = p75 !== undefined && p75 !== null && p75 !== '';
    return [
      period,
      url,
      formFactor,
      name,
      has ? Number(p75) : '',
      has ? 'OK' : 'INSUFFICIENT_DATA',
      source || 'CRUX',
      now
    ];
  });
}

/** Wiersze pomiaru laboratoryjnego z jednej próby. */
function parsePsiRun_(response, url, strategy, attempt, measuredAt, now) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const categories = (response && response.lighthouseResult && response.lighthouseResult.categories) || {};
  const rows = [];

  const score = categories.performance && categories.performance.score;
  if (score !== undefined && score !== null) {
    rows.push([measuredAt, url, strategy, attempt, 'Performance score', Math.round(Number(score) * 100), 'PSI_LAB', now]);
  }

  const wanted = psiAudits_();
  Object.keys(wanted).forEach(function (id) {
    const audit = audits[id];
    const value = audit && audit.numericValue;
    if (value === undefined || value === null) return;
    rows.push([measuredAt, url, strategy, attempt, wanted[id], Number(value), 'PSI_LAB', now]);
  });

  return rows;
}

/** Mediana wartości; pusta lista daje pusty wynik, nie zero. */
function medianOfValues_(values) {
  const sorted = values.slice().filter(function (v) { return typeof v === 'number' && !isNaN(v); }).sort(function (a, b) { return a - b; });
  if (!sorted.length) return '';
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mediany metryk z prób jednego pomiaru; podstawa porównań pre/post. */
function psiMedians_(rows) {
  const byMetric = {};
  rows.forEach(function (row) {
    const metric = row[4];
    if (!byMetric[metric]) byMetric[metric] = [];
    byMetric[metric].push(row[5]);
  });
  const out = {};
  Object.keys(byMetric).forEach(function (metric) { out[metric] = medianOfValues_(byMetric[metric]); });
  return out;
}

/**
 * Zapis idempotentny po kluczu z pierwszych `keyColumns` kolumn. Ponowny pomiar
 * tego samego okresu CrUX podmienia wiersze zamiast je dublować, a historia
 * wcześniejszych okresów zostaje.
 */
function upsertPerformanceRows_(sheetName, header, keyColumns, rows) {
  const sheet = ensureSheetWithHeader_(sheetName, header);
  const keyOf = function (row) { return keyColumns.map(function (i) { return String(row[i]); }).join(' '); };
  const incoming = {};
  rows.forEach(function (row) { incoming[keyOf(row)] = true; });

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, header.length).getValues() : [];
  const kept = existing.filter(function (row) {
    return String(row[1] || '') !== '' && !incoming[keyOf(row)];
  });

  const combined = kept.concat(rows);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, header.length).clearContent();
  if (combined.length) {
    ensureSheetRows_(sheet, combined.length + 1);
    sheet.getRange(2, 1, combined.length, header.length).setValues(combined);
  }
  return { written: rows.length, kept: kept.length };
}

/** Pomiar danych terenowych dla wszystkich adresów i obu form factorów. */
function runCruxMeasurement_() {
  const key = performanceApiKey_();
  const urls = performanceUrls_();
  if (!urls.length) return { rows: 0, urls: 0, missing: 0, detail: 'brak adresów w „' + PERF_URLS_SHEET + '”' };

  const now = new Date();
  const rows = [];
  let missing = 0;
  let fromOrigin = 0;
  // Dane dla całej domeny są takie same dla każdego adresu, więc pytamy o nie
  // raz na domenę i form factor, zamiast raz na adres.
  const originCache = {};

  urls.forEach(function (entry) {
    ['PHONE', 'DESKTOP'].forEach(function (formFactor) {
      const record = cruxRequest_(entry.url, formFactor, key);
      if (record) {
        parseCruxRecord_(record, entry.url, formFactor, now, 'CRUX').forEach(function (row) { rows.push(row); });
        return;
      }

      // Pojedyncza podstrona rzadko ma dość ruchu, żeby CrUX ją opisał, a cała
      // domena zwykle ma. Dane domeny są mniej precyzyjne, więc zapisujemy je
      // z innym źródłem: liczba opisuje serwis, nie tę stronę.
      const origin = cruxOrigin_(entry.url);
      const cacheKey = origin + ' ' + formFactor;
      if (!Object.prototype.hasOwnProperty.call(originCache, cacheKey)) {
        originCache[cacheKey] = origin ? cruxRequest_(origin, formFactor, key, true) : null;
      }
      const originRecord = originCache[cacheKey];

      if (originRecord) {
        fromOrigin++;
        parseCruxRecord_(originRecord, entry.url, formFactor, now, 'CRUX (domena)').forEach(function (row) { rows.push(row); });
        return;
      }

      missing++;
      rows.push(['', entry.url, formFactor, 'wszystkie', '', 'INSUFFICIENT_DATA', 'CRUX', now]);
    });
  });

  upsertPerformanceRows_(PERF_FIELD_SHEET, PERF_FIELD_HEADER, [0, 1, 2, 3], rows);
  return {
    rows: rows.length,
    urls: urls.length,
    missing: missing,
    fromOrigin: fromOrigin,
    detail: rows.length + ' pomiarów terenowych dla ' + urls.length + ' adresów' +
      (fromOrigin ? ', w tym ' + fromOrigin + ' z danych całej domeny zamiast pojedynczej strony' : '') +
      (missing ? ', ' + missing + ' bez wystarczających danych' : '')
  };
}

/** Pomiar laboratoryjny: trzy próby na adres i strategię, zapisywane osobno. */
function runPsiMeasurement_() {
  const key = performanceApiKey_();
  const urls = performanceUrls_();
  if (!urls.length) return { rows: 0, urls: 0, detail: 'brak adresów w „' + PERF_URLS_SHEET + '”' };

  const now = new Date();
  const measuredAt = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const startedAt = Date.now();
  const rows = [];
  const start = psiStartIndex_(urls.length);
  let measured = 0;
  let index = start;

  // Budżet sprawdzamy PRZED rozpoczęciem adresu, nie w trakcie: przerwanie
  // w połowie zostawiłoby adres z częścią prób, a mediana z dwóch prób jest
  // gorsza niż jej brak.
  const failures = [];

  while (measured < urls.length && Date.now() - startedAt < PSI_TIME_BUDGET_MS) {
    const entry = urls[index % urls.length];
    ['mobile', 'desktop'].forEach(function (strategy) {
      let ok = 0;
      for (let attempt = 1; attempt <= PSI_ATTEMPTS; attempt++) {
        const url = PSI_API + '?url=' + encodeURIComponent(entry.url) +
          '&strategy=' + strategy + '&category=performance&key=' + encodeURIComponent(key);
        try {
          const response = performanceApiRequest_(url);
          parsePsiRun_(response, entry.url, strategy, attempt, measuredAt, now)
            .forEach(function (row) { rows.push(row); });
          ok++;
        } catch (e) {
          // Błąd systemowy (klucz, limit) przerywa pomiar, bo kolejne próby dadzą
          // to samo i tylko zużyją limit. Awaria pojedynczego przebiegu nie:
          // Lighthouse wywraca się losowo i to normalne.
          if (!e.transient) throw e;
        }
      }
      if (ok < PSI_ATTEMPTS) {
        failures.push(entry.url + ' (' + strategy + '): ' + ok + ' z ' + PSI_ATTEMPTS + ' prób');
      }
    });
    measured++;
    index++;
  }

  savePsiCursor_(index % urls.length);
  upsertPerformanceRows_(PERF_LAB_SHEET, PERF_LAB_HEADER, [0, 1, 2, 3, 4], rows);

  const skipped = urls.length - measured;
  return {
    rows: rows.length,
    urls: urls.length,
    measured: measured,
    skipped: skipped,
    failures: failures,
    medians: psiMedians_(rows),
    detail: rows.length + ' pomiarów dla ' + measured + ' z ' + urls.length + ' adresów (' +
      PSI_ATTEMPTS + ' próby na adres i strategię)' +
      (skipped ? '; ' + skipped + ' zostanie zmierzonych w kolejnym przebiegu' : '') +
      (failures.length ? '; nieudane próby: ' + failures.join(', ') : '')
  };
}

/** Menu: zakłada arkusze i mówi, czego brakuje do uruchomienia. */
function przygotujPomiarWydajnosci() {
  ensureSheetWithHeader_(PERF_URLS_SHEET, PERF_URLS_HEADER);
  ensureSheetWithHeader_(PERF_FIELD_SHEET, PERF_FIELD_HEADER);
  ensureSheetWithHeader_(PERF_LAB_SHEET, PERF_LAB_HEADER);
  const configured = isPerformanceConfigured_();
  const urls = performanceUrls_().length;

  SpreadsheetApp.getUi().alert([
    'Arkusze pomiaru wydajności są gotowe.',
    '',
    'Klucz API: ' + (configured ? 'ustawiony.' : 'brak Script Property PAGESPEED_API_KEY.'),
    'Monitorowane adresy: ' + urls + ' (kolumna A w „' + PERF_URLS_SHEET + '”).',
    '',
    'Do uruchomienia potrzebny jest klucz API z Google Cloud z włączonymi',
    'PageSpeed Insights API oraz Chrome UX Report API. Klucz wystarcza,',
    'OAuth nie jest potrzebny, więc nie trzeba autoryzować projektu ponownie.',
    '',
    'CrUX to dane od prawdziwych użytkowników, PSI to pomiar laboratoryjny.',
    'Są trzymane osobno i nigdy nie uśredniane w jedną liczbę.'
  ].join('\n'));
  return configured;
}

/** Menu: pomiar terenowy i laboratoryjny, z podsumowaniem. */
function zmierzWydajnosc() {
  const field = runCruxMeasurement_();
  const lab = runPsiMeasurement_();
  SpreadsheetApp.getUi().alert([
    'Pomiar wydajności zakończony.',
    '',
    'Dane terenowe (CrUX): ' + field.detail + '.',
    'Dane laboratoryjne (PSI): ' + lab.detail + '.',
    '',
    'Brak danych terenowych nie jest błędem strony, tylko informacją o zbyt małym ruchu.',
    (lab.failures && lab.failures.length
      ? 'Nieudane przebiegi Lighthouse zdarzają się losowo po stronie Google. Pomiar zapisał to, ' +
        'co się udało, a mediana liczy się z udanych prób.'
      : '')
  ].join('\n'));
  return { field: field, lab: lab };
}
