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
const PERF_LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano', 'Wyzwolenie'];

/**
 * Agregat median — jeden wiersz na (pomiar, URL, strategia, metryka) (#152).
 *
 * Klucz zawiera `Pomiar` celowo: agregat jest HISTORIĄ median, nie widokiem
 * „ostatni wynik”. Klucz bez pomiaru nadpisywałby poprzedni baseline, a wtedy
 * porównanie przed/po — jedyny powód istnienia tej zakładki — przestałoby być
 * możliwe, zwłaszcza po przycięciu surowych prób.
 *
 * `Liczba prób` nie jest ozdobna: mediana z dwóch prób jest słabszą podstawą
 * niż z trzech i czytający musi to widzieć bez zaglądania w surowe dane.
 */
const PERF_SUMMARY_SHEET = 'PERFORMANCE SUMMARY';
const PERF_SUMMARY_HEADER = ['Pomiar', 'URL', 'Strategia', 'Metryka', 'Mediana', 'Liczba prób', 'Źródło', 'Pobrano'];

const PERF_FINDINGS_SHEET = 'PAGESPEED FINDINGS';
// Nazwy czterech pierwszych kolumn są celowo takie same jak w PAGESPEED LAB:
// dzięki temu ustalenie da się połączyć z konkretnym wierszem metryki.
const PERF_FINDINGS_HEADER = [
  'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół',
  // KiB, nie KB: przeliczamy przez 1024, tak samo jak raport PageSpeed, więc
  // liczby są wprost porównywalne z tym, co widać w interfejsie.
  'Czas (ms)', 'Transfer (KiB)', 'Potencjalna oszczędność (ms)', 'Potencjalna oszczędność (KiB)',
  'Źródło', 'Pobrano',
  // Ostatnia kolumna, nie w środku: cztery pierwsze muszą zostać zgodne
  // z PAGESPEED LAB, a klucz upsertu opiera się na ich pozycjach (#156 D3).
  'Wyzwolenie'
];

/**
 * Identyfikatory audytów: aktualny, potem wycofany (#157).
 *
 * Zmierzone sondą na produkcji 2026-09-13, Lighthouse 13.4.1: wycofane
 * `largest-contentful-paint-element` i `third-party-summary` NIE wracają,
 * wracają ich następcy. Stare zostają jako fallback, bo PSI uruchamia wersję
 * przypiętą i nic nie gwarantuje, że wszędzie jest ta sama.
 */
const PSI_LCP_AUDIT_IDS = ['lcp-breakdown-insight', 'largest-contentful-paint-element'];
const PSI_THIRD_PARTY_AUDIT_IDS = ['third-parties-insight', 'third-party-summary'];

const PSI_FINDING_LCP = 'ELEMENT LCP';
/** Adnotacja, gdy PSI nie wskazał węzła LCP — brak też jest ustaleniem (#153). */
const PSI_LCP_UNKNOWN = 'PSI nie wskazał elementu LCP w tej próbie';
/** Fazy rozkładu LCP z tego samego audytu co węzeł (#165). */
const PSI_FINDING_LCP_PHASE = 'FAZA LCP';
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

/** Źródło wyzwolenia przebiegu; atrybut, NIE element klucza upsertu (#156 D4). */
const PSI_TRIGGER_MANUAL = 'ręczny';
const PSI_TRIGGER_SCHEDULED = 'cykliczny';

/** Funkcja rejestrowana w wyzwalaczu czasowym; bez UI (#156 D6). */
const PSI_TRIGGER_HANDLER = 'pomiarWydajnosciCykliczny';

/**
 * Dozwolone interwały wyzwalacza czasowego (#156 D5).
 *
 * To ograniczenie API Apps Script, nie nasze: `everyHours()` przyjmuje tylko
 * te wartości. Dowolna liczba godzin zostałaby odrzucona dopiero przy tworzeniu
 * wyzwalacza, czyli po zapisaniu konfiguracji — walidujemy wcześniej.
 */
const PSI_ALLOWED_INTERVALS = [1, 2, 4, 6, 8, 12];
const PSI_DEFAULT_INTERVAL_HOURS = 6;
const PSI_INTERVAL_PROP = 'PAGESPEED_INTERVAL_HOURS';

/**
 * Lokalny budżet wywołań PSI na dobę (#156 D7).
 *
 * To NASZ licznik, nie stan limitu po stronie Google — tego nie odczytujemy
 * z żadnego API i specyfikacja nie może sugerować, że go znamy. Liczymy
 * żądania RZECZYWIŚCIE wykonane, także nieudane: one również konsumują limit
 * u dostawcy.
 */
const PSI_DAILY_BUDGET_PROP = 'PAGESPEED_DAILY_BUDGET';
const PSI_BUDGET_STATE_PROP = 'PAGESPEED_BUDGET_STATE';
const PSI_DEFAULT_DAILY_BUDGET = 500;

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
function parsePsiRun_(response, url, strategy, attempt, measuredAt, now, trigger) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const categories = (response && response.lighthouseResult && response.lighthouseResult.categories) || {};
  const rows = [];

  const score = categories.performance && categories.performance.score;
  if (score !== undefined && score !== null) {
    rows.push([measuredAt, url, strategy, attempt, 'Performance score', Math.round(Number(score) * 100), 'PSI_LAB', now, trigger]);
  }

  const wanted = psiAudits_();
  Object.keys(wanted).forEach(function (id) {
    const audit = audits[id];
    const value = audit && audit.numericValue;
    if (value === undefined || value === null) return;
    rows.push([measuredAt, url, strategy, attempt, wanted[id], Number(value), 'PSI_LAB', now, trigger]);
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
    // Lighthouse 13 kładzie węzeł jako POZYCJĘ, bez opakowania w `node`:
    // `lcp-breakdown-insight` ma na pierwszym miejscu tabelę faz, a na drugim
    // goły węzeł (`selector`, `nodeLabel`, `snippet`, `boundingRect`, `path`).
    // Zmierzone na produkcji 2026-09-13, Lighthouse 13.4.1 (#157).
    if (psiLooksLikeNode_(group)) return group;
    const inner = (group && group.items) || [];
    for (let j = 0; j < inner.length; j++) {
      if (inner[j] && inner[j].node) return inner[j].node;
      if (psiLooksLikeNode_(inner[j])) return inner[j];
    }
  }
  return null;
}

/**
 * Czy obiekt JEST węzłem DOM, a nie opakowaniem niosącym węzeł.
 *
 * Rozstrzygamy po polach opisujących element, nie po `type`: Lighthouse używa
 * `type: 'node'` dla węzłów, ale to samo pole niesie też `type: 'table'` dla
 * opakowań, a nazwy typów bywają zmieniane między wersjami. Pola opisujące
 * element są stabilne, bo czyta je interfejs raportu.
 */
function psiLooksLikeNode_(item) {
  if (!item || typeof item !== 'object') return false;
  return ['selector', 'nodeLabel', 'snippet'].some(function (field) {
    return String(item[field] || '').trim() !== '';
  });
}

/**
 * Pierwszy obecny audyt z listy identyfikatorów.
 *
 * Lighthouse wycofuje identyfikatory po cichu i przenosi audyty do `insights`
 * (`replacesAudits`). PSI uruchamia WERSJĘ PRZYPIĘTĄ, więc w jednym środowisku
 * wraca nowy identyfikator, a w innym może jeszcze stary. Kolejność w liście
 * jest więc istotna: najpierw aktualny, potem wycofany.
 */
function psiAuditByIds_(audits, ids) {
  for (let i = 0; i < ids.length; i++) {
    const audit = (audits || {})[ids[i]];
    if (audit) return { id: ids[i], audit: audit };
  }
  return { id: ids[ids.length - 1], audit: null };
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
/**
 * Element LCP jednej próby — zawsze jeden wiersz, także gdy PSI go nie wskazał (#153).
 *
 * Pozostałe ustalenia bierzemy z ostatniej udanej próby, bo są jakościowe
 * i stabilne. Element LCP stabilny NIE jest: produkcja pokazała rozkład
 * dwutrybowy, w którym w jednym trybie element był raportowany, a w drugim
 * nie było go wcale. Zapis z jednej próby opisywał wtedy jedno losowanie
 * i nic w arkuszu nie mówiło, które.
 *
 * Brak węzła jest więc ustaleniem, nie brakiem danych, i dostaje własny wiersz
 * z czytelną adnotacją. Wcześniej nie powstawał żaden — a wtedy cisza znaczyła
 * trzy rzeczy naraz: „PSI nie wskazał”, „kolektor tu nie dotarł” i „zapis
 * działa, tylko ten rodzaj nigdy nie powstaje”.
 */
function psiLcpFindingRow_(response, url, strategy, attempt, measuredAt, now, trigger) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const found = psiAuditByIds_(audits, PSI_LCP_AUDIT_IDS);
  const label = psiNodeLabel_(psiLcpNode_(found.audit));
  // W kolumnie `Nazwa` zapisujemy identyfikator, który NAPRAWDĘ wrócił — inaczej
  // arkusz twierdziłby, że dane pochodzą z audytu, którego Lighthouse nie ma.
  return [
    measuredAt, url, strategy, attempt, PSI_FINDING_LCP, found.id,
    cellSafeText_(label || PSI_LCP_UNKNOWN).text, '', '', '', '', 'PSI_LAB', now, trigger
  ];
}

/**
 * Czy pozycja opisuje fazę LCP — komplet `subpart` + `label` + `duration` (#165).
 *
 * Nie sprawdzamy nazw faz. Ogólny model LCP ma cztery podczęści (TTFB, opóźnienie
 * żądania zasobu, czas pobrania zasobu, opóźnienie renderu), a przy elemencie,
 * który nie wymaga osobnego zasobu, fazy zasobowe się nie pojawiają. Whitelista
 * nazw albo stała „3” zakodowałaby jedną obserwację jako kontrakt API.
 */
function psiLooksLikePhase_(item) {
  if (!item || typeof item !== 'object') return false;
  const opisane = ['subpart', 'label'].every(function (field) {
    return String(item[field] === undefined || item[field] === null ? '' : item[field]).trim() !== '';
  });
  return opisane && typeof item.duration === 'number' && !isNaN(item.duration);
}

/**
 * Wiersze faz LCP z jednej próby; pusta lista, gdy audyt ich nie niesie.
 *
 * Czas trwania fazy to koszt RZECZYWISTY, więc idzie do kolumny `Czas (ms)`,
 * a kolumny oszczędności zostają puste — ta sama zasada, dla której #140
 * rozdzielił koszt od oszczędności przy `THIRD-PARTY`.
 *
 * Szukamy na dwóch poziomach, bo tabela faz bywa opakowana, a kolejność pozycji
 * względem węzła nie jest niczym zagwarantowana.
 */
function psiLcpPhaseRows_(audit, url, strategy, attempt, measuredAt, now, trigger) {
  const groups = (audit && audit.details && audit.details.items) || [];
  const rows = [];
  const add = function (item) {
    rows.push([
      measuredAt, url, strategy, attempt, PSI_FINDING_LCP_PHASE,
      cellSafeText_(item.subpart).text, cellSafeText_(item.label).text,
      Math.round(item.duration), '', '', '', 'PSI_LAB', now, trigger
    ]);
  };

  groups.forEach(function (group) {
    if (psiLooksLikePhase_(group)) add(group);
    ((group && group.items) || []).forEach(function (inner) {
      if (psiLooksLikePhase_(inner)) add(inner);
    });
  });
  return rows;
}

/** Element LCP i jego fazy z jednej udanej próby (#153, #165). */
function psiLcpAttemptRows_(response, url, strategy, attempt, measuredAt, now, trigger) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const found = psiAuditByIds_(audits, PSI_LCP_AUDIT_IDS);
  return [psiLcpFindingRow_(response, url, strategy, attempt, measuredAt, now, trigger)]
    .concat(psiLcpPhaseRows_(found.audit, url, strategy, attempt, measuredAt, now, trigger));
}

function parsePsiFindings_(response, url, strategy, attempt, measuredAt, now, trigger) {
  const audits = (response && response.lighthouseResult && response.lighthouseResult.audits) || {};
  const rows = [];
  const add = function (kind, name, detail, timeMs, transferKb, savingsMs, savingsKb) {
    rows.push([
      measuredAt, url, strategy, attempt, kind, name, cellSafeText_(detail).text,
      timeMs, transferKb, savingsMs, savingsKb, 'PSI_LAB', now, trigger
    ]);
  };

  psiOpportunities_(audits).forEach(function (o) {
    add(PSI_FINDING_OPPORTUNITY, o.id, o.title, '', '',
      o.ms ? Math.round(o.ms) : '', o.bytes ? Math.round(o.bytes / 1024) : '');
  });

  const thirdParty = ((psiAuditByIds_(audits, PSI_THIRD_PARTY_AUDIT_IDS).audit || {}).details || {}).items || [];
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

/**
 * Wiersze agregatu z surowych prób jednego adresu (#152).
 *
 * Grupuje po `(Pomiar, URL, Strategia, Metryka)` i liczy medianę wyłącznie
 * z prób, które się udały. Para bez ani jednej udanej próby **nie dostaje
 * wiersza** — zero byłoby doskonałym wynikiem, a pusty wiersz sugerowałby
 * pomiar, którego nie było.
 *
 * Metryka nieobecna w części prób daje medianę z tych prób, które ją mają,
 * a `Liczba prób` to pokazuje — dlatego licznik jest per metryka, nie per para.
 */
function psiSummaryRows_(rows, now) {
  const order = [];
  const groups = {};
  rows.forEach(function (row) {
    const key = [row[0], row[1], row[2], row[4]].join(' ');
    if (!groups[key]) {
      groups[key] = { head: [row[0], row[1], row[2], row[4]], values: [] };
      order.push(key);
    }
    const value = row[5];
    if (typeof value === 'number' && !isNaN(value)) groups[key].values.push(value);
  });

  const out = [];
  order.forEach(function (key) {
    const group = groups[key];
    if (!group.values.length) return;
    out.push(group.head.concat([medianOfValues_(group.values), group.values.length, 'PSI_LAB', now]));
  });
  return out;
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

/** Budżet dzienny z konfiguracji; domyślny, gdy nieustawiony albo niepoprawny. */
function psiDailyBudget_() {
  const raw = Number(PropertiesService.getScriptProperties().getProperty(PSI_DAILY_BUDGET_PROP));
  return isFinite(raw) && raw > 0 ? Math.floor(raw) : PSI_DEFAULT_DAILY_BUDGET;
}

/** Dzień budżetu w strefie arkusza; licznik zeruje się przy zmianie doby. */
function psiBudgetDay_(now) {
  return Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Stan licznika: `{ day, used }`. Inny dzień znaczy licznik od zera. */
function psiBudgetState_(day) {
  const raw = String(PropertiesService.getScriptProperties().getProperty(PSI_BUDGET_STATE_PROP) || '');
  const parts = raw.split(' ');
  const used = Number(parts[1]);
  return parts[0] === day && isFinite(used) && used > 0
    ? { day: day, used: Math.floor(used) }
    : { day: day, used: 0 };
}

function savePsiBudgetState_(state) {
  PropertiesService.getScriptProperties().setProperty(PSI_BUDGET_STATE_PROP, state.day + ' ' + state.used);
}

/** Interwał z konfiguracji; poza dozwolonym zbiorem schodzimy do domyślnego. */
function psiIntervalHours_() {
  const raw = Number(PropertiesService.getScriptProperties().getProperty(PSI_INTERVAL_PROP));
  return PSI_ALLOWED_INTERVALS.indexOf(raw) >= 0 ? raw : PSI_DEFAULT_INTERVAL_HOURS;
}

/**
 * Walidacja interwału PRZED założeniem wyzwalacza.
 *
 * Bez niej `everyHours()` odrzuciłoby wartość dopiero przy tworzeniu, czyli po
 * skasowaniu poprzedniego wyzwalacza — zostawiając projekt bez żadnego.
 */
function validatePsiInterval_(hours) {
  const value = Number(hours);
  if (PSI_ALLOWED_INTERVALS.indexOf(value) < 0) {
    throw new Error(
      'Niedozwolony interwał: ' + hours + ' godz. Wyzwalacz czasowy Apps Script przyjmuje wyłącznie: ' +
      PSI_ALLOWED_INTERVALS.join(', ') + '.'
    );
  }
  return value;
}

/**
 * Nagłówek istniejącej zakładki uzupełniony o brakujące kolumny (#156).
 *
 * `ensureSheetWithHeader_()` przepisuje nagłówek tylko wtedy, gdy `A1` różni się
 * od pierwszej nazwy. Przy rozszerzeniu schematu `A1` się nie zmienia, więc
 * istniejąca zakładka zostałaby ze starym, węższym nagłówkiem, a zapis wkładałby
 * wartości do kolumny bez etykiety.
 *
 * Dopisujemy WYŁĄCZNIE puste komórki nagłówka. Komórka z inną niepustą treścią
 * to konflikt schematu: zatrzymujemy się i mówimy, co jest nie tak, zamiast
 * nadpisywać coś, czego nie zakładaliśmy.
 */
function ensureHeaderColumns_(sheetName, header) {
  const sheet = ensureSheetWithHeader_(sheetName, header);
  const current = sheet.getRange(1, 1, 1, header.length).getValues()[0];
  const conflicts = [];
  const missing = [];

  header.forEach(function (label, i) {
    const value = String(current[i] === undefined || current[i] === null ? '' : current[i]).trim();
    if (value === label) return;
    if (value === '') { missing.push(i); return; }
    conflicts.push('kolumna ' + (i + 1) + ': jest „' + value + '”, oczekiwano „' + label + '”');
  });

  if (conflicts.length) {
    throw new Error(
      'Niezgodny nagłówek zakładki „' + sheetName + '”: ' + conflicts.join('; ') +
      '. Nic nie zostało zmienione — popraw nagłówek albo zmień nazwę zakładki.'
    );
  }
  missing.forEach(function (i) { sheet.getRange(1, i + 1).setValue(header[i]); });
  return sheet;
}

/** Pomiar laboratoryjny: trzy próby na adres i strategię, zapisywane osobno. */
function runPsiMeasurement_(trigger) {
  const source = trigger || PSI_TRIGGER_MANUAL;
  const key = performanceApiKey_();
  const urls = performanceUrls_();
  if (!urls.length) return { rows: 0, urls: 0, detail: 'brak adresów w „' + PERF_URLS_SHEET + '”' };

  const now = new Date();
  // Sekundy, nie minuty (#156 D2): przy rozdzielczości minutowej przebieg ręczny
  // i cykliczny z tej samej minuty trafiały w te same klucze upsertu i jeden
  // kasował wiersze drugiego. Blokada z D1 nie dopuszcza dwóch równoległych
  // przebiegów, a jeden trwa minuty, więc sekunda wystarcza i `run_id` byłby
  // drugim mechanizmem unikalności obok istniejącego klucza.
  const measuredAt = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
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
  ensureHeaderColumns_(PERF_LAB_SHEET, PERF_LAB_HEADER);
  ensureHeaderColumns_(PERF_SUMMARY_SHEET, PERF_SUMMARY_HEADER);
  ensureHeaderColumns_(PERF_FINDINGS_SHEET, PERF_FINDINGS_HEADER);

  let pairs = 0;
  // Budżet jest NASZ, nie Google'a: liczymy żądania rzeczywiście wykonane,
  // także nieudane, bo one też konsumują limit u dostawcy (#156 D7).
  const budget = psiDailyBudget_();
  const budgetState = psiBudgetState_(psiBudgetDay_(now));
  let budgetStopped = false;

  // Koszt jednego adresu: trzy próby razy dwie strategie.
  const costPerUrl = PSI_ATTEMPTS * 2;

  // Licznik zapisujemy w `finally`: błąd niepodlegający ponowieniu (403, 429)
  // rzuca wyjątek w środku pętli, a wykonane już żądania i tak zużyły limit
  // u dostawcy. Bez tego kolejne przebiegi przekraczałyby nasz budżet.
  try {
  while (measured < urls.length && Date.now() - startedAt < PSI_TIME_BUDGET_MS && !budgetStopped) {
    // Budżet rezerwujemy na CAŁY adres, przed wejściem w pętle strategii.
    // Sprawdzanie per próba przerywałoby adres w połowie: część prób zapisana,
    // mediana policzona z niepełnego kompletu, a kursor i tak przesunięty —
    // czyli adres uznany za zrobiony wbrew zasadzie z #151.
    if (budgetState.used + costPerUrl > budget) {
      budgetStopped = true;
      break;
    }
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
      // Szanse i third-party są jakościowe i stabilne między próbami, więc trzy
      // komplety byłyby szumem. Bierzemy ostatnią UDANĄ próbę: późniejsza
      // nieudana nie zmienia wyboru, bo przypisujemy tylko po powodzeniu.
      let lastGood = null;
      // Element LCP to wyjątek — bywa różny między próbami, więc zapisujemy go
      // z KAŻDEJ udanej próby (#153). Jeden wiersz na próbę, koszt znikomy.
      const lcpRows = [];
      for (let attempt = 1; attempt <= PSI_ATTEMPTS; attempt++) {
        const url = PSI_API + '?url=' + encodeURIComponent(entry.url) +
          '&strategy=' + strategy + '&category=performance&key=' + encodeURIComponent(key);
        budgetState.used++;
        try {
          const response = performanceApiRequest_(url);
          parsePsiRun_(response, entry.url, strategy, attempt, measuredAt, now, source)
            .forEach(function (row) { addressRows.push(row); });
          ok++;
          lastGood = { response: response, attempt: attempt };
          psiLcpAttemptRows_(response, entry.url, strategy, attempt, measuredAt, now, source)
            .forEach(function (row) { lcpRows.push(row); });
        } catch (e) {
          // Błąd systemowy (klucz, limit) przerywa pomiar, bo kolejne próby dadzą
          // to samo i tylko zużyją limit. Awaria pojedynczego przebiegu nie:
          // Lighthouse wywraca się losowo i to normalne.
          if (!e.transient) throw e;
        }
      }
      if (lastGood) {
        addressScopes.push(entry.url + ' ' + strategy);
        lcpRows.forEach(function (row) { addressFindings.push(row); });
        parsePsiFindings_(lastGood.response, entry.url, strategy, lastGood.attempt, measuredAt, now, source)
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
      // Agregat PRZED surowymi próbami. To dwa osobne zapisy, nie jedna
      // transakcja: gdyby drugi się nie udał, lepiej mieć medianę bez surowych
      // prób niż surowe próby bez mediany. Mediana bez prób jest dopuszczalnym
      // stanem końcowym — po to jest retencja. Odwrotnie: pomiar zostałby
      // w `PAGESPEED LAB` bez agregatu i nigdy by go nie dostał, bo kursor nie
      // ruszył, a kolejny przebieg ma już inny `Pomiar`.
      const summaryRows = psiSummaryRows_(addressRows, now);
      upsertPerformanceRows_(PERF_SUMMARY_SHEET, PERF_SUMMARY_HEADER, [0, 1, 2, 3], summaryRows);
      upsertPerformanceRows_(PERF_LAB_SHEET, PERF_LAB_HEADER, [0, 1, 2, 3, 4], addressRows);
      addressRows.forEach(function (row) { rows.push(row); });

      // Kompletność zakresu liczymy z FAKTYCZNIE powstałych median, nie z tego,
      // że API odpowiedziało bez błędu. Odpowiedź 200 bez liczbowych audytów
      // jest tolerowana i nie tworzy ani surowych wierszy, ani mediany —
      // liczenie jej jako pary dawałoby „mediany dla 2 z 2 par” przy pustym
      // agregacie.
      const withMedian = {};
      summaryRows.forEach(function (row) { withMedian[row[2]] = true; });
      pairs += Object.keys(withMedian).length;
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
  } finally {
    savePsiBudgetState_(budgetState);
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
    // Kompletność ZAKRESU (pary URL × strategia z udaną próbą), nie kompletność
    // prób pojedynczej metryki — te dwa znaczenia „kompletnego” mylą się łatwo.
    pairs: pairs,
    pairsExpected: urls.length * 2,
    trigger: source,
    budgetUsed: budgetState.used,
    budgetLimit: budget,
    budgetStopped: budgetStopped,
    medians: psiMedians_(rows),
    // „Kompletny” i „budżet wyczerpany” muszą wyglądać inaczej: wcześniej oba
    // kończyły się tym samym zdaniem i operator nie wiedział, czy ma baseline.
    detail: rows.length + ' pomiarów dla ' + measured + ' z ' + urls.length + ' adresów (' +
      PSI_ATTEMPTS + ' próby na adres i strategię)' +
      (skipped
        ? '; budżet wyczerpany, ' + skipped + ' zostanie zmierzonych w kolejnym przebiegu, zaczynając od ' + resumeAt
        : '; przebieg kompletny') +
      '; mediany dla ' + pairs + ' z ' + (urls.length * 2) + ' par (URL × strategia)' +
      (complete.length ? '; komplet ' + (PSI_ATTEMPTS * 2) + ' prób: ' + complete.join(', ') : '') +
      (budgetStopped
        ? '; PRZERWANO: wyczerpany nasz dzienny budżet wywołań (' + budgetState.used + ' z ' + budget +
          '), reszta w kolejnym przebiegu'
        : '; budżet wywołań: ' + budgetState.used + ' z ' + budget) +
      (failures.length ? '; nieudane próby: ' + failures.join(', ') : '')
  };
}

/** Menu: zakłada arkusze i mówi, czego brakuje do uruchomienia. */
function przygotujPomiarWydajnosci() {
  ensureSheetWithHeader_(PERF_URLS_SHEET, PERF_URLS_HEADER);
  ensureSheetWithHeader_(PERF_FIELD_SHEET, PERF_FIELD_HEADER);
  ensureSheetWithHeader_(PERF_LAB_SHEET, PERF_LAB_HEADER);
  ensureSheetWithHeader_(PERF_SUMMARY_SHEET, PERF_SUMMARY_HEADER);
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

/**
 * Rdzeń pomiaru: BEZ interfejsu, więc nadaje się dla wyzwalacza czasowego (#156 D6).
 *
 * Całość pod blokadą projektu (#156 D1): `upsertPerformanceRows_` czyta i przepisuje
 * całą zakładkę, a PSI korzysta ze wspólnego kursora, więc dwa równoległe przebiegi
 * mogłyby nadpisać sobie dane albo kursor. Zgodnie z zasadą z `Lock.gs` drugie
 * uruchomienie NIE jest kolejkowane — kończy się czytelnym błędem.
 */
function runPerformanceMeasurement_(trigger) {
  return withScriptLock_('pomiar wydajności', function () {
    const field = runCruxMeasurement_();
    const lab = runPsiMeasurement_(trigger);
    return { field: field, lab: lab };
  });
}

/**
 * Handler wyzwalacza czasowego. Nie wolno tu wołać `SpreadsheetApp.getUi()` —
 * wykonanie z wyzwalacza nie ma interfejsu i wywróciłoby się na pierwszym alercie.
 */
function pomiarWydajnosciCykliczny() {
  // `recordJobRun_` zapisuje czas i wynik przebiegu, dzięki czemu „Status danych”
  // i strażnik alertów widzą to zadanie tak samo jak pozostałe cykliczne.
  // Blokadę zakłada `runPerformanceMeasurement_`, tak jak w live checku SEO.
  return recordJobRun_('PERFORMANCE', true, function () {
    return runPerformanceMeasurement_(PSI_TRIGGER_SCHEDULED);
  });
}

/** Menu: zakłada cykliczny pomiar; ponowne założenie nie duplikuje wyzwalacza. */
function ustawCyklicznyPomiarWydajnosci() {
  const hours = validatePsiInterval_(psiIntervalHours_());
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === PSI_TRIGGER_HANDLER; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger(PSI_TRIGGER_HANDLER).timeBased().everyHours(hours).create();

  SpreadsheetApp.getUi().alert([
    'Cykliczny pomiar wydajności włączony: co ' + hours + ' godz.',
    '',
    'Przebiegi cykliczne zapisują się tak samo jak ręczne, z oznaczeniem w kolumnie „Wyzwolenie”.',
    'Dozwolone interwały (ograniczenie Apps Script): ' + PSI_ALLOWED_INTERVALS.join(', ') + ' godz.',
    'Zmiana: Script Property ' + PSI_INTERVAL_PROP + ', potem ponownie ta pozycja menu.',
    '',
    'Dzienny budżet wywołań PSI: ' + psiDailyBudget_() + ' (nasz licznik, nie limit Google).'
  ].join('\n'));
  return hours;
}

/** Menu: usuwa cykliczny pomiar; brak wyzwalacza nie jest błędem. */
function usunCyklicznyPomiarWydajnosci() {
  const found = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === PSI_TRIGGER_HANDLER; });
  found.forEach(function (t) { ScriptApp.deleteTrigger(t); });

  SpreadsheetApp.getUi().alert(found.length
    ? 'Cykliczny pomiar wydajności wyłączony (usunięto wyzwalaczy: ' + found.length + ').'
    : 'Cykliczny pomiar wydajności nie był włączony. Nic nie zmieniono.');
  return found.length;
}

/** Menu: pomiar terenowy i laboratoryjny, z podsumowaniem. */
function zmierzWydajnosc() {
  const out = runPerformanceMeasurement_(PSI_TRIGGER_MANUAL);
  const field = out.field;
  const lab = out.lab;
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
