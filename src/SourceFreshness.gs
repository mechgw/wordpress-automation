/**
 * Świeżość zewnętrznego źródła danych (#197): ACTIVE, STALE albo ERROR.
 *
 * Sygnał w arkuszu daje NATYWNA formuła z `NOW()`, którą buduje
 * `sourceFreshnessFormula_()`. Arkusze przeliczają ją same, zgodnie z ustawieniem
 * przeliczania pliku, więc przejście do STALE nie wymaga żadnego przebiegu Apps
 * Script. Między 19 a 26.09.2026 stały wszystkie wyzwalacze projektu naraz (#198):
 * status zapisywany przez wyzwalacz albo liczony w funkcji niestandardowej
 * zamarzłby wtedy na ACTIVE. Funkcja niestandardowa nie może też dostać `NOW()`
 * jako argumentu, bo jej argumenty muszą być deterministyczne.
 *
 * `sourceFreshness_()` to ta sama semantyka w JS, do testów poza arkuszem. Obie
 * implementacje muszą dawać identyczny wynik na tej samej tabeli przypadków.
 * Dlatego JS liczy dokładnie tak, jak arkusz:
 * - wiek w czasie ściennym strefy arkusza (arkusz trzyma daty jako numer seryjny
 *   czasu lokalnego, więc wokół zmiany czasu różnica ma ±1 h, tak samo w obu);
 * - w pełnych sekundach, zaokrąglanych od zera jak `ROUND`, bo porównanie ułamków
 *   doby rozjeżdża się na granicy progu o błąd zmiennoprzecinkowy.
 *
 * STALE mówi tylko, że od progu nie pojawił się nowszy rekord. Nie dowodzi awarii
 * formularza ani integracji, ani braku zdarzeń. Mechanizm dostaje wyłącznie
 * znacznik czasu i próg, nigdy treści wierszy.
 */

const SOURCE_FRESHNESS_ACTIVE = 'ACTIVE';
const SOURCE_FRESHNESS_STALE = 'STALE';
const SOURCE_FRESHNESS_ERROR = 'ERROR';

/** Jedyny obsługiwany format tekstowego znacznika: `YYYY-MM-DD HH:MM:SS`. */
const SOURCE_FRESHNESS_TEXT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * Stan świeżości źródła.
 *
 * @param {*} lastTimestamp data albo tekst `YYYY-MM-DD HH:MM:SS` w strefie arkusza
 * @param {*} maxAgeHours próg w godzinach, liczba > 0
 * @param {Date} now bieżąca chwila
 * @param {string} timeZone strefa arkusza
 * @return {string} ACTIVE, STALE albo ERROR
 */
function sourceFreshness_(lastTimestamp, maxAgeHours, now, timeZone) {
  if (typeof maxAgeHours !== 'number' || !isFinite(maxAgeHours) || maxAgeHours <= 0) {
    return SOURCE_FRESHNESS_ERROR;
  }
  const last = freshnessWallSeconds_(lastTimestamp, timeZone);
  const current = isValidDate_(now) ? freshnessWallSeconds_(now, timeZone) : null;
  if (last === null || current === null) return SOURCE_FRESHNESS_ERROR;

  const ageSeconds = roundHalfAwayFromZero_(current - last);
  // Znacznik z przyszłości to niespójność zegara albo danych, a nie świeże źródło.
  if (ageSeconds < 0) return SOURCE_FRESHNESS_ERROR;
  return ageSeconds <= maxAgeHours * 3600 ? SOURCE_FRESHNESS_ACTIVE : SOURCE_FRESHNESS_STALE;
}

/** Sekundy czasu ściennego w strefie arkusza albo null dla wartości spoza kontraktu. */
function freshnessWallSeconds_(value, timeZone) {
  if (isValidDate_(value)) {
    const wall = parseFreshnessText_(Utilities.formatDate(value, timeZone, 'yyyy-MM-dd HH:mm:ss'));
    return wall + value.getMilliseconds() / 1000;
  }
  // Każdy inny typ, w tym liczba bez formatu daty, jest poza kontraktem.
  return typeof value === 'string' ? parseFreshnessText_(value) : null;
}

/**
 * Tekst `YYYY-MM-DD HH:MM:SS` czytany strukturalnie, bez parsera zależnego
 * od ustawień regionalnych. Data nieistniejąca (31 kwietnia, 13. miesiąc, 24:00)
 * jest błędem, a nie przeniesieniem na następny dzień, jak w `DATE()`. Rok poniżej
 * 1900 też, bo `DATE()` w arkuszu dodałby do niego 1900.
 */
function parseFreshnessText_(text) {
  const m = SOURCE_FRESHNESS_TEXT_PATTERN.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

function isValidDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

/** `ROUND` z arkusza: połówki od zera, także dla liczb ujemnych (Math.round idzie w górę). */
function roundHalfAwayFromZero_(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Natywna formuła Arkuszy z tą samą semantyką co `sourceFreshness_()`.
 *
 * @param {string} timestampRef komórka ze znacznikiem czasu, np. `B2`
 * @param {string} maxAgeHoursRef komórka z progiem w godzinach, np. `C2`
 * @param {Object=} options
 *   - `now`: wyrażenie bieżącej chwili; w instalacji `NOW()` (domyślnie), w teście
 *     adres komórki ze stałą chwilą, żeby przypadek graniczny był deterministyczny;
 *   - `separator`: separator argumentów pliku: `,` (kropka dziesiętna, domyślnie)
 *     albo `;` (przecinek dziesiętny). `setValues` i ręczne wpisanie czytają formułę
 *     w ustawieniach regionalnych pliku, więc zły separator daje błąd formuły.
 * Nazwy w `LET` nie pokrywają się z nazwami funkcji: `t` i `n` to w Arkuszach
 * funkcje `T()` i `N()`.
 *
 * @return {string} formuła zaczynająca się od `=`
 */
function sourceFreshnessFormula_(timestampRef, maxAgeHoursRef, options) {
  const opts = options || {};
  const now = opts.now === undefined ? 'NOW()' : opts.now;
  const separator = opts.separator === undefined ? ',' : opts.separator;
  [timestampRef, maxAgeHoursRef, now].forEach(function (ref) {
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new Error('Formuła świeżości wymaga niepustych odwołań do komórek.');
    }
  });
  if (separator !== ',' && separator !== ';') {
    throw new Error('Separator argumentów formuły to "," albo ";", a nie "' + separator + '".');
  }
  const f = function (name) {
    return name + '(' + Array.prototype.slice.call(arguments, 1).join(separator) + ')';
  };
  const text = f('LET',
    'yr', 'VALUE(MID(stamp' + separator + '1' + separator + '4))',
    'mon', 'VALUE(MID(stamp' + separator + '6' + separator + '2))',
    'dy', 'VALUE(MID(stamp' + separator + '9' + separator + '2))',
    'hr', 'VALUE(MID(stamp' + separator + '12' + separator + '2))',
    'mnt', 'VALUE(MID(stamp' + separator + '15' + separator + '2))',
    'sek', 'VALUE(MID(stamp' + separator + '18' + separator + '2))',
    f('IF',
      f('AND', 'yr>=1900', 'mon>=1', 'mon<=12', 'dy>=1',
        'dy<=' + f('DAY', f('EOMONTH', f('DATE', 'yr', 'mon', '1'), '0')),
        'hr<=23', 'mnt<=59', 'sek<=59'),
      f('DATE', 'yr', 'mon', 'dy') + '+' + f('TIME', 'hr', 'mnt', 'sek'),
      'NA()'));
  const serial = f('IF', 'ISTEXT(stamp)',
    // Tekst tylko przez wzorzec: ISDATE uznaje za datę także np. "July 20 1969".
    f('IF', f('REGEXMATCH', 'stamp', '"^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$"'), text, 'NA()'),
    f('IF', 'ISDATE(stamp)', 'stamp', 'NA()'));
  const verdict = f('IF', f('OR', 'NOT(ISNUMBER(limit))', 'ISDATE(limit)', 'limit<=0'), '"' + SOURCE_FRESHNESS_ERROR + '"',
    f('IF', 'age<0', '"' + SOURCE_FRESHNESS_ERROR + '"',
      f('IF', 'age<=limit*3600', '"' + SOURCE_FRESHNESS_ACTIVE + '"', '"' + SOURCE_FRESHNESS_STALE + '"')));
  return '=' + f('IFERROR',
    f('LET', 'stamp', timestampRef, 'limit', maxAgeHoursRef, 'current', now,
      'serial', serial,
      'age', f('ROUND', '(current-serial)*86400'),
      verdict),
    '"' + SOURCE_FRESHNESS_ERROR + '"');
}
