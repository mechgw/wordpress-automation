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

const PERF_FINDINGS_SHEET = 'PAGESPEED FINDINGS';
// Nazwy czterech pierwszych kolumn są celowo takie same jak w PAGESPEED LAB:
// dzięki temu ustalenie da się połączyć z konkretnym wierszem metryki.
const PERF_FINDINGS_HEADER = [
  'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół',
  // KiB, nie KB: przeliczamy przez 1024, tak samo jak raport PageSpeed, więc
  // liczby są wprost porównywalne z tym, co widać w interfejsie.
  'Czas (ms)', 'Transfer (KiB)', 'Potencjalna oszczędność (ms)', 'Potencjalna oszczędność (KiB)',
  'Źródło', 'Pobrano'
];

const PSI_FINDING_LCP = 'ELEMENT LCP';
const PSI_FINDING_OPPORTUNITY = 'SZANSA';
const PSI_FINDING_THIRD_PARTY = 'THIRD-PARTY';

// Ile szans zapisujemy na parę URL/strategia i od jakiej wielkości w ogóle je
// bierzemy pod uwagę. Bez progu arkusz zapełniłby się pozycjami wartymi
// kilkanaście milisekund, które niczego nie zmieniają.
const PSI_OPPORTUNITY_LIMIT = 5;
const PSI_OPPORTUNITY_MIN_MS = 50;
const PSI_OPPORTUNITY_MIN_BYTES = 20 * 1024;

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

/**
 * Zapytanie CrUX o jeden form factor. Domyślnie pyta o konkretny adres;
 * z `byOrigin` o całą domenę, co jest jedynym sensownym wyjściem, gdy
 * pojedyncza podstrona ma za mało ruchu.
 */
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

/**
 * Węzeł elementu LCP z audytu; `null`, gdy audyt go nie zawiera.
 *
 * Kształt `details.items` bywa jedno- albo dwupoziomowy w zależności od wersji
 * Lighthouse, więc szukamy węzła na obu poziomach zamiast zakładać jeden.
 */
function psiLcpNode_(audit) {
  const groups = (audit && audit.details && audit.details.items) || [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group && group.node) return group.node;
    const inner = (group && group.items) || [];
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] && inner[j].node) return inner[j].node;
    }
  }
  return null;
}

/** Czytelny opis węzła: selektor, a gdy go brak — etykieta albo fragment HTML. */
function psiNodeLabel_(node) {
  if (!node) return '';
  return String((node.selector || node.nodeLabel || node.snippet) || '').trim();
}

/** Nazwa podmiotu third-party; API zwraca ją raz jako tekst, raz jako obiekt. */
function psiEntityName_(entity) {
  if (!entity) return '';
  if (typeof entity === 'string') return entity.trim();
  return String((entity.text || entity.name) || '').trim();
}

/**
 * Szanse warte zapisania, w deterministycznej kolejności.
 *
 * Jedna szansa może mieć oszczędność w milisekundach, w bajtach albo w obu,
 * więc porządek musi być zdefiniowany jawnie: milisekundy malejąco, przy remisie
 * bajty malejąco, a przy pełnym remisie identyfikator audytu — inaczej wynik
 * zależałby od kolejności kluczy w odpowiedzi API.
 */
function psiOpportunities_(audits) {
  const found = [];
  Object.keys(audits || {}).forEach(function (id) {
    const audit = audits[id];
    const details = audit && audit.details;
    if (!details || details.type !== 'opportunity') return;
    const ms = Number(details.overallSavingsMs || 0);
    const bytes = Number(details.overallSavingsBytes || 0);
    if (ms < PSI_OPPORTUNITY_MIN_MS && bytes < PSI_OPPORTUNITY_MIN_BYTES) return;
    found.push({ id: id, title: String(audit.title || ''), ms: ms, bytes: bytes });
  });
  found.sort(function (a, b) {
    return (b.ms - a.ms) || (b.bytes - a.bytes) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return found.slice(0, PSI_OPPORTUNITY_LIMIT);
}

/**
 * Ustalenia diagnostyczne z jednego przebiegu PSI.
 *
 * Koszt i potencjalna oszczędność mają OSOBNE kolumny. `third-party-summary`
 * opisuje rzeczywisty transfer i czas wątku głównego, a nie to, co da się
 * zaoszczędzić; wpisanie go do kolumn oszczędności sprawiłoby, że arkusz
 * kłamałby semantycznie.
 */
function parsePsiFindings_(response, url, strategy, attempt, measuredAt, now) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const rows = [];
  const add = function (kind, name, detail, timeMs, transferKb, savingsMs, savingsKb) {
    rows.push([
      measuredAt, url, strategy, attempt, kind, name, cellSafeText_(detail).text,
      timeMs, transferKb, savingsMs, savingsKb, 'PSI_LAB', now
    ]);
  };

  // Brak audytu albo brak użytecznego węzła nie jest błędem i nie tworzy pustego
  // wiersza: PSI nie zawsze potrafi wskazać element LCP.
  const label = psiNodeLabel_(psiLcpNode_(audits['largest-contentful-paint-element']));
  if (label) add(PSI_FINDING_LCP, 'largest-contentful-paint-element', label, '', '', '', '');

  psiOpportunities_(audits).forEach(function (o) {
    add(PSI_FINDING_OPPORTUNITY, o.id, o.title, '', '',
      o.ms ? Math.round(o.ms) : '', o.bytes ? Math.round(o.bytes / 1024) : '');
  });

  const thirdParty = ((audits['third-party-summary'] || {}).details || {}).items || [];
  thirdParty.forEach(function (item) {
    const name = psiEntityName_(item && item.entity);
    const time = Number((item && item.mainThreadTime) || 0);
    const bytes = Number((item && item.transferSize) || 0);
    if (!name || (!time && !bytes)) return;
    add(PSI_FINDING_THIRD_PARTY, name, '', Math.round(time), Math.round(bytes / 1024), '', '');
  });

  return rows;
}

/**
 * Zapis ustaleń jako SNAPSHOT bieżącej diagnozy, nie jako historii.
 *
 * Udany pomiar zastępuje CAŁY zakres (URL, strategia), więc ustalenie, którego
 * nie ma w nowej odpowiedzi, znika z arkusza. Zwykły upsert po kluczach
 * przychodzących zostawiłby nieistniejące już szanse jako bieżącą diagnozę.
 * Zakres bez ani jednej udanej próby nie jest ruszany: nieudany przebieg nie
 * może skasować ostatniej dobrej diagnozy. Historia liczb jest w PAGESPEED LAB.
 */
function replaceFindingsScopes_(rows, scopes) {
  const sheet = ensureSheetWithHeader_(PERF_FINDINGS_SHEET, PERF_FINDINGS_HEADER);
  const width = PERF_FINDINGS_HEADER.length;
  const scopeOf = function (row) { return String(row[1]) + ' ' + String(row[2]); };
  const replaced = {};
  (scopes || []).forEach(function (scope) { replaced[scope] = true; });

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
  const kept = existing.filter(function (row) {
    return String(row[1] || '') !== '' && !replaced[scopeOf(row)];
  });

  const combined = kept.concat(rows);
  writeRowsThenTrim_(sheet, width, combined, lastRow);
  return { written: rows.length, kept: kept.length };
}

/**
 * Podmiana zawartości zakładki BEZ okna, w którym jest ona pusta.
 *
 * Najpierw zapis pełnego zestawu, dopiero potem wyczyszczenie nadmiarowego
 * ogona. Kolejność odwrotna — „wyczyść wszystko, potem zapisz” — zostawia
 * moment, w którym zakładka nie ma ani jednego wiersza. Przerwanie wykonania
 * wtedy kasuje całą historię, a nie tylko bieżący zapis.
 *
 * Ma to znaczenie od #151: zapis idzie raz na adres, czyli kilka razy w jednym
 * przebiegu i coraz bliżej limitu czasu Apps Script — czyli dokładnie wtedy,
 * gdy wykonanie najchętniej jest przerywane. Przerwanie w nowej kolejności
 * zostawia najwyżej powtórzone wiersze na końcu, co jest odwracalne.
 */
function writeRowsThenTrim_(sheet, width, combined, lastRow) {
  if (combined.length) {
    ensureSheetRows_(sheet, combined.length + 1);
    sheet.getRange(2, 1, combined.length, width).setValues(combined);
  }
  const surplus = lastRow - 1 - combined.length;
  if (surplus > 0) sheet.getRange(combined.length + 2, 1, surplus, width).clearContent();
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
  writeRowsThenTrim_(sheet, header.length, combined, lastRow);
  return { written: rows.length, kept: kept.length };
}

/** Pomiar danych terenowych dla wszystkich adresów i obu form factorów. */
function runCruxMeasurement_() {
  const key = performanceApiKey_();
  const urls = performanceUrls_();
  // Kształt wyniku jest ten sam niezależnie od tego, czy było co mierzyć:
  // wywołujący nie powinien sprawdzać obecności pól.
  if (!urls.length) {
    return { rows: 0, urls: 0, missing: 0, fromOrigin: 0, detail: 'brak adresów w „' + PERF_URLS_SHEET + '”' };
  }

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
  const findings = [];
  const complete = [];

  // Zakładki muszą istnieć także po przebiegu, w którym nic się nie udało.
  // Wcześniej gwarantował to zapis na końcu, wołany bezwarunkowo; po przejściu
  // na zapis warunkowy per adres trzeba to powiedzieć wprost.
  ensureSheetWithHeader_(PERF_LAB_SHEET, PERF_LAB_HEADER);
  ensureSheetWithHeader_(PERF_FINDINGS_SHEET, PERF_FINDINGS_HEADER);

  while (measured < urls.length && Date.now() - startedAt < PSI_TIME_BUDGET_MS) {
    const entry = urls[index % urls.length];
    // Dorobek JEDNEGO adresu, zapisywany zanim przejdziemy do następnego (#151).
    // Wcześniej wszystko leżało w pamięci do końca pętli, więc przerwanie przez
    // limit czasu Apps Script kasowało cały przebieg naraz.
    const addressRows = [];
    const addressFindings = [];
    const addressScopes = [];
    let addressOk = 0;

    ['mobile', 'desktop'].forEach(function (strategy) {
      let ok = 0;
      // Ustalenia są jakościowe i stabilne między próbami, więc trzy komplety
      // byłyby szumem. Bierzemy ostatnią UDANĄ próbę: późniejsza nieudana nie
      // zmienia wyboru, bo przypisujemy tylko po powodzeniu.
      let lastGood = null;
      for (let attempt = 1; attempt <= PSI_ATTEMPTS; attempt++) {
        const url = PSI_API + '?url=' + encodeURIComponent(entry.url) +
          '&strategy=' + strategy + '&category=performance&key=' + encodeURIComponent(key);
        try {
          const response = performanceApiRequest_(url);
          parsePsiRun_(response, entry.url, strategy, attempt, measuredAt, now)
            .forEach(function (row) { addressRows.push(row); });
          ok++;
          lastGood = { response: response, attempt: attempt };
        } catch (e) {
          // Błąd systemowy (klucz, limit) przerywa pomiar, bo kolejne próby dadzą
          // to samo i tylko zużyją limit. Awaria pojedynczego przebiegu nie:
          // Lighthouse wywraca się losowo i to normalne.
          if (!e.transient) throw e;
        }
      }
      if (lastGood) {
        addressScopes.push(entry.url + ' ' + strategy);
        parsePsiFindings_(lastGood.response, entry.url, strategy, lastGood.attempt, measuredAt, now)
          .forEach(function (row) { addressFindings.push(row); });
      }
      if (ok < PSI_ATTEMPTS) {
        failures.push(entry.url + ' (' + strategy + '): ' + ok + ' z ' + PSI_ATTEMPTS + ' prób');
      }
      addressOk += ok;
    });

    // Kolejność jest istotna: najpierw dane, potem kursor. Kursor przesunięty
    // przed zapisem oznaczyłby adres jako zrobiony mimo utraconych wyników.
    if (addressRows.length) {
      upsertPerformanceRows_(PERF_LAB_SHEET, PERF_LAB_HEADER, [0, 1, 2, 3, 4], addressRows);
      addressRows.forEach(function (row) { rows.push(row); });
    }
    // Zakres bez ani jednej udanej próby nie jest ruszany — inaczej nieudany
    // przebieg skasowałby ostatnią dobrą diagnozę (#140).
    if (addressScopes.length) {
      replaceFindingsScopes_(addressFindings, addressScopes);
      addressFindings.forEach(function (row) { findings.push(row); });
    }

    measured++;
    index++;
    savePsiCursor_(index % urls.length);

    if (addressOk === PSI_ATTEMPTS * 2) complete.push(entry.url);
  }

  const skipped = urls.length - measured;
  // Adres, od którego ruszy kolejny przebieg — tylko gdy jest co wznawiać.
  const resumeAt = skipped ? urls[index % urls.length].url : '';
  return {
    rows: rows.length,
    urls: urls.length,
    measured: measured,
    skipped: skipped,
    complete: complete,
    failures: failures,
    findings: findings.length,
    resumeAt: resumeAt,
    medians: psiMedians_(rows),
    // „Kompletny” i „budżet wyczerpany” muszą wyglądać inaczej: wcześniej oba
    // kończyły się tym samym zdaniem i operator nie wiedział, czy ma baseline.
    detail: rows.length + ' pomiarów dla ' + measured + ' z ' + urls.length + ' adresów (' +
      PSI_ATTEMPTS + ' próby na adres i strategię)' +
      (skipped
        ? '; budżet wyczerpany, ' + skipped + ' zostanie zmierzonych w kolejnym przebiegu, zaczynając od ' + resumeAt
        : '; przebieg kompletny') +
      (complete.length ? '; komplet ' + (PSI_ATTEMPTS * 2) + ' prób: ' + complete.join(', ') : '') +
      (failures.length ? '; nieudane próby: ' + failures.join(', ') : '')
  };
}

/** Menu: zakłada arkusze i mówi, czego brakuje do uruchomienia. */
function przygotujPomiarWydajnosci() {
  ensureSheetWithHeader_(PERF_URLS_SHEET, PERF_URLS_HEADER);
  ensureSheetWithHeader_(PERF_FIELD_SHEET, PERF_FIELD_HEADER);
  ensureSheetWithHeader_(PERF_LAB_SHEET, PERF_LAB_HEADER);
  ensureSheetWithHeader_(PERF_FINDINGS_SHEET, PERF_FINDINGS_HEADER);
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
    'Ustalenia diagnostyczne: ' + (lab.findings || 0) + ' w arkuszu „' + PERF_FINDINGS_SHEET + '”.',
    '',
    'Brak danych terenowych nie jest błędem strony, tylko informacją o zbyt małym ruchu.',
    (lab.failures && lab.failures.length
      ? 'Nieudane przebiegi Lighthouse zdarzają się losowo po stronie Google. Pomiar zapisał to, ' +
        'co się udało, a mediana liczy się z udanych prób.'
      : '')
  ].join('\n'));
  return { field: field, lab: lab };
}
