// --- Znaczniki wykonań (#189) ------------------------------------------------
//
// Wykonanie ubite twardym limitem Apps Script (6 min) nie przechodzi ani przez
// `catch`, ani przez `finally`, więc bez znacznika nie zostawia żadnego śladu:
// ani rekordu, ani wiersza w IMPORT LOG, ani maila. 19.09.2026 tak zniknął
// przebieg pomiaru wydajności — widać go było tylko w rejestrze wykonań.

/** Prefiks Script Property ze znacznikiem trwającego wykonania: `RUNNING_<zadanie>_<runId>`. */
const RUN_MARKER_PREFIX = 'RUNNING_';
/**
 * Wiek, po którym znacznik na pewno nie należy do żyjącego wykonania: limit
 * wykonania Apps Script (6 min) plus margines. Młodszy może należeć do wykonania,
 * które wciąż trwa, i nie jest ruszany.
 */
const RUN_MARKER_STALE_MS = 7 * 60 * 1000;
/** Ile czekamy na blokadę przy odzysku. Odzysk to diagnostyka i nie może blokować zadania. */
const RUN_MARKER_LOCK_MS = 3000;

function runMarkerKey_(key, runId) {
  return RUN_MARKER_PREFIX + key + '_' + runId;
}

/**
 * Znacznik wykonania to OSOBNA Script Property, a nie pole rekordu zadania.
 * Rekord to jeden JSON, który zapisuje nie tylko `recordJobRun_()`, ale też obsługa
 * incydentów ze swojej kopii (Alerts.gs). Od #204 znacznik powstaje już pod
 * blokadą rejestratora, ale własny klucz nadal dopisuje i usuwa się jedną
 * operacją, niezależnie od zapisów rekordu, więc przetrwa ubicie w dowolnej chwili.
 */
function startRunMarker_(key, trigger, startedAt) {
  const runId = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty(runMarkerKey_(key, runId), JSON.stringify({
    job: key,
    runId: runId,
    startedAt: new Date(startedAt).toISOString(),
    trigger: Boolean(trigger)
  }));
  return runId;
}

/** Usuwa WYŁĄCZNIE znacznik własnego wykonania — cudzy mógłby należeć do żyjącego. */
function clearRunMarker_(key, runId) {
  PropertiesService.getScriptProperties().deleteProperty(runMarkerKey_(key, runId));
}

/**
 * Porzucone znaczniki zadania `key` w bieżącym stanie Script Properties, od najstarszego.
 * Zadanie rozpoznajemy po polu `job`, a nie po prefiksie klucza: prefiks jednego
 * klucza zadania bywa początkiem innego (`SEO_LIVE` i hipotetyczne `SEO_LIVE_X`).
 * Wartość, której nie da się odczytać, nie jest naszym znacznikiem i zostaje nietknięta.
 */
function abandonedRunMarkers_(key, now) {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter(function (name) { return name.indexOf(RUN_MARKER_PREFIX) === 0; })
    .map(function (name) {
      let marker;
      try { marker = JSON.parse(all[name]); } catch (e) { marker = null; }
      return { name: name, marker: marker };
    })
    .filter(function (found) {
      return Boolean(found.marker) && found.marker.job === key &&
        now - Date.parse(found.marker.startedAt) > RUN_MARKER_STALE_MS;
    })
    .sort(function (a, b) { return Date.parse(a.marker.startedAt) - Date.parse(b.marker.startedAt); });
}

/**
 * Porzucone znaczniki zadania do raportu: `{ name, marker }`, od najstarszego.
 * Niczego nie usuwa (#221): znacznik schodzi w `settleAbandonedRuns_`, dopiero
 * po zapisie śladu. Wcześniej odzysk usuwał go od razu i awaria przed zapisem
 * wiersza gubiła porzucony przebieg bez śladu.
 *
 * Wszystkie wywołania biegną pod blokadą rejestratora albo strażnika (#204), więc
 * dwa wykonania nie zgłoszą tego samego znacznika naraz. Bez trzymanej blokady
 * odczyt idzie pod krótką własną, a gdy ta jest zajęta, odzysk czeka na kolejny
 * przebieg. Blokadę bierzemy tylko wtedy, gdy wstępny odczyt w ogóle coś znalazł.
 */
function reclaimAbandonedRuns_(key, now) {
  if (!abandonedRunMarkers_(key, now).length) return [];
  const lock = LockService.getScriptLock();
  // Wywołanie pod blokadą już trzymaną (jak w `withScriptLock_`) nie może jej zwolnić.
  const owned = lock.hasLock();
  if (!owned && !lock.tryLock(RUN_MARKER_LOCK_MS)) return [];
  try {
    return abandonedRunMarkers_(key, now);
  } finally {
    if (!owned) lock.releaseLock();
  }
}

/**
 * Zapisuje ślad każdego porzuconego znacznika (`report(marker)`) i dopiero potem
 * go usuwa (#221). Każdy znacznik osobno, jak wpisy oczekujące w
 * `takeOverPendingRuns_`: błąd zapisu albo usunięcia zostawia znacznik na kolejny
 * odzysk i nie przerywa przebiegu, bo odzysk to diagnostyka. Ubicie między
 * zapisem a usunięciem daje najwyżej zduplikowany wiersz, nie utracony ślad.
 * Zwraca znaczniki, których ślad się zapisał i które zeszły.
 */
function settleAbandonedRuns_(found, report) {
  const props = PropertiesService.getScriptProperties();
  return found.filter(function (item) {
    try {
      report(item.marker);
      props.deleteProperty(item.name);
      return true;
    } catch (e) {
      Logger.log('Porzucony znacznik ' + item.name + ' czeka na kolejny odzysk: ' + (e && e.message ? e.message : e));
      return false;
    }
  }).map(function (item) { return item.marker; });
}

/** Ślad porzuconego przebiegu zadania `key`: wiersz `BŁĄD` w IMPORT LOG (#221). */
function logAbandonedRun_(key) {
  return function (marker) {
    appendImportLog_(key, abandonedRunEntry_(marker, abandonedRunNote_(marker)));
  };
}

/**
 * Treść o porzuconym wykonaniu. Znacznik dowodzi tylko jednego: wykonanie nie
 * przeszło przez kontrolowane zakończenie `recordJobRun_()`. Nie przesądza ani
 * przyczyny, ani losu danych - po #151 i #187 dane zapisują się W TRAKCIE
 * przebiegu, więc ubity przebieg mógł zdążyć zapisać część albo całość.
 *
 * Znacznik z adnotacją `failure` (#275) mówi więcej: praca się skończyła, a wyjątek
 * wyszedł z obsługi wyniku. Tylko wtedy podajemy tę przyczynę zamiast domysłu
 * o limicie czasu; bez adnotacji (ubicie albo nieudany zapis adnotacji) tekst
 * zostaje ostrożny.
 */
function abandonedRunNote_(marker) {
  const head = 'poprzedni przebieg (start ' + formatImportTime_(marker.startedAt) + ') nie zakończył się kontrolowanie';
  const failure = marker.failure && typeof marker.failure.message === 'string' ? marker.failure.message : '';
  if (failure) return head + ' — obsługa wyniku przerwana wyjątkiem: ' + failure + '; praca zakończona';
  return head + ' — możliwe przerwanie przez limit czasu wykonania Apps Script; zakres zapisanych danych jest niepewny';
}

/** Przebieg porzucony jako wpis rejestru: czas = start porzuconego, czas trwania nieznany. */
function abandonedRunEntry_(marker, note) {
  return { finishedAt: marker.startedAt, ok: false, trigger: marker.trigger, error: note };
}

/** Najdłuższa adnotacja wyjątku w znaczniku, po redakcji (#275). */
const RUN_MARKER_FAILURE_MAX = 200;

/**
 * Bezpieczny, jednowierszowy tekst wyjątku do znacznika, `IMPORT LOG`, incydentu
 * i maila (#275). Wyjątki usług bywają z danymi żądania, identyfikatorami albo
 * tokenami. Tylko `message`, nigdy stos. Redakcja przed skróceniem, żeby ucięcie
 * nie zostawiło połowy sekretu; kolejność: nagłówek `Bearer`, pary `nazwa=wartość`
 * dla nazw z key/token/secret/password/authorization (także JSON: klucz i wartość
 * w cudzysłowie albo apostrofach, również z ukośnikiem), adresy e-mail, zapytanie
 * adresu URL, każdy ciąg 24 i więcej znaków `[A-Za-z0-9_-]`.
 *
 * Wartość w cudzysłowie czytamy ze świadomością ucieczek: `\"` i `\\` wewnątrz
 * wartości nie kończą jej (JSON z `"` w haśle: `"prefix\"ogon"`), więc wartość
 * znika w całości. W JSON-ie zagnieżdżonym w napisie (cudzysłowy jako `\"`)
 * ogranicznikiem jest dokładnie jeden ukośnik przed cudzysłowem, a seria dwóch
 * i więcej ukośników przed cudzysłowem należy do wartości. Alternatywy wzorca
 * nie nakładają się, więc długi ciąg ukośników nie wywołuje wykładniczego
 * nawrotu. Wartość bez domknięcia redagujemy do separatora (`;`, `,`, `&`, spacja).
 */
function markerFailureText_(error) {
  const raw = error && error.message !== undefined ? error.message : error;
  const text = String(raw === undefined || raw === null ? '' : raw)
    .split('')
    .map(ch => (ch < ' ' || ch === '\u007f' ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/Bearer\s+[^\s;,]+/gi, 'Bearer [ukryto]')
    .replace(/\b(\w*(?:key|token|secret|password|authorization))(\\?["']?)\s*[=:]\s*(?:\\"(?:[^\\]|\\+(?![\\"])|\\{2,}")*\\"|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,&]+)/gi, '$1$2=[ukryto]')
    .replace(/[^\s@;,]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[ukryto]')
    .replace(/(https?:\/\/\S*?)\?\S*/gi, '$1?[ukryto]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[ukryto]')
    .trim();
  // Ucięcie nie zostawia niedomkniętego `[ukryto`.
  const cut = text.slice(0, RUN_MARKER_FAILURE_MAX).replace(/\[[^\]]*$/, '').trim();
  return cut || 'nieznany wyjątek';
}

/**
 * Dopisuje do WŁASNEGO znacznika (`RUNNING_<zadanie>_<runId>`) adnotację o wyjątku
 * z obsługi wyniku (#275). Pozostałe pola znacznika zostają. Błąd zapisu nie
 * maskuje pierwotnego wyjątku: znacznik zostaje wtedy bez adnotacji, a odzysk
 * używa ostrożnego tekstu.
 */
function annotateRunMarker_(key, runId, error) {
  const props = PropertiesService.getScriptProperties();
  const name = runMarkerKey_(key, runId);
  try {
    const marker = JSON.parse(props.getProperty(name));
    marker.failure = { at: new Date().toISOString(), message: markerFailureText_(error) };
    props.setProperty(name, JSON.stringify(marker));
  } catch (e) {
    Logger.log('Adnotacja znacznika ' + name + ' nie została zapisana: ' + (e && e.message ? e.message : e));
  }
}

/**
 * Wykonuje obsługę wyniku po udanej pracy. Wyjątek zostawia znacznik (siatka
 * bezpieczeństwa z #214 i #221), dopisuje do niego przyczynę i leci dalej.
 */
function withMarkerAnnotation_(key, runId, fn) {
  try {
    return fn();
  } catch (e) {
    annotateRunMarker_(key, runId, e);
    throw e;
  }
}
