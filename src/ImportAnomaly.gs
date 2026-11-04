/**
 * Detektor anomalii liczby wierszy importu (#43, #180, #281).
 *
 * Ocena jest wyłącznie w obrębie profilu: źródło + typ runu (trigger / ręczny) +
 * liczba dni zakresu. Wyjątek: zero wierszy po historii z danymi alarmuje także
 * wtedy, gdy profil nie ma jeszcze próbek (przebieg uzupełniający lukę).
 * Wywołuje go `recordImportRunLocked_` (Status.gs) przed zapisem rekordu.
 */

function medianOf_(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Próbki bazy porównawczej: udane przebiegi profilu z okna retencji, po
 * deduplikacji po zakresie danych (#180), od najstarszej.
 *
 * - z próbek o tym samym niepustym zakresie zostaje najnowsza;
 * - próbki zakresu bieżącego przebiegu są wykluczone: bieżący je zastępuje,
 *   a nie porównuje się sam ze sobą;
 * - próbki bez zakresu (wiersze sprzed zmiany) liczą się każda osobno.
 *
 * 09.09.2026 ten sam dzień danych GA4 zaimportowano dwa razy w odstępie 31 s
 * i oba wpisy weszły do mediany; bez tego duplikatu żaden z dwóch fałszywych
 * alarmów „mało danych” z 14–15.09 by nie powstał.
 */
function importAnomalySamples_(source, run, history, now) {
  const cutoff = importLogCutoff_(now || new Date(run.finishedAt));
  // Tylko udane runy tego profilu z okna retencji, posortowane po czasie:
  // kolejność wierszy w arkuszu nie ma znaczenia (mógł być posortowany ręcznie),
  // a wpisy starsze niż retencja nie liczą się, nawet jeśli jeszcze nie zostały usunięte.
  const profile = history
    .filter(h =>
      h.ok && h.source === source && h.trigger === Boolean(run.trigger) && h.days === (Number(run.days) || 0) &&
      !isNaN(h.at.getTime()) && h.at.getTime() >= cutoff
    )
    .sort((a, b) => a.at - b.at);

  return newestPerRange_(profile, importRangeKey_(run));
}

/**
 * Z przebiegów posortowanych rosnąco po czasie zostawia najnowszy dla każdego
 * niepustego zakresu, pomijając zakres `current` (#180, #281); przebiegi bez
 * zakresu liczą się każdy osobno. Wspólne dla bazy profilu i bazy źródła: ponowny
 * import zakresu zastępuje poprzedni wynik, w obu bazach.
 */
function newestPerRange_(sorted, current) {
  const seen = {};
  const samples = [];
  // Od najnowszej, żeby z duplikatów zakresu została właśnie ona.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const key = sorted[i].rangeKey;
    if (key) {
      if (key === current || seen[key]) continue;
      seen[key] = true;
    }
    samples.unshift(sorted[i]);
  }
  return samples;
}

/**
 * Okno i rozgrzewka baz klasowych GA4 (#180, etap 2, wariant 6A). Dni robocze
 * zbierają 5 próbek w tydzień, weekend 4 w dwa tygodnie — obie bazy zaczynają
 * działać po mniej więcej tym czasie.
 */
const IMPORT_ANOMALY_CLASS_WINDOW = { roboczy: 5, weekend: 4 };
const IMPORT_ANOMALY_CLASS_LABEL = { roboczy: 'dni robocze', weekend: 'weekend' };

/**
 * Klasa dnia DANYCH z klucza zakresu: sobota i niedziela → `weekend`, reszta →
 * `roboczy`; '' gdy zakresu brak. Z daty danych, nie z daty uruchomienia: import
 * z poniedziałku pobiera sobotę. Dzień tygodnia liczony z daty kalendarzowej
 * w UTC, więc nie zależy od strefy skryptu ani maszyny.
 */
function importDataClass_(rangeKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.\./.exec(String(rangeKey || ''));
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 || day === 6 ? 'weekend' : 'roboczy';
}

/**
 * Klasa dnia danych i okno bazy porównawczej (#180, etap 2, 6A). Sezonowość
 * tygodniowa dotyczy wyłącznie GA4 i wyłącznie profili jednodniowych: test
 * kompletności z 19.09.2026 pokazał, że niski weekend jest prawdziwy (12 i 13.09
 * po ponownym imporcie - co do wiersza to samo), a mediana z kolejnych dni jest
 * zawsze wartością z dnia roboczego, więc weekend leżał tuż przy progu. GSC
 * takiego wzoru nie pokazało i zostaje przy jednej bazie. Próbki bez zakresu
 * (wiersze sprzed v2.36.11) nie mają klasy i nie wchodzą do baz klasowych.
 */
function importAnomalyScope_(source, run) {
  const cls = source === 'GA4' && (Number(run.days) || 0) === 1 ? importDataClass_(importRangeKey_(run)) : '';
  return { cls: cls, size: cls ? IMPORT_ANOMALY_CLASS_WINDOW[cls] : IMPORT_ANOMALY_MIN_RUNS };
}

/** Mediana ostatnich `size` próbek bazy (klasowej albo całego profilu); null, gdy baza jeszcze się nie rozgrzała. */
function importAnomalyMedian_(samples, scope) {
  const base = scope.cls ? samples.filter(h => importDataClass_(h.rangeKey) === scope.cls) : samples;
  return base.length >= scope.size ? medianOf_(base.slice(-scope.size).map(h => h.rows)) : null;
}

/**
 * Udane przebiegi źródła z okna retencji, tego samego typu uruchomienia (trigger
 * albo ręczny), z dowolną liczbą dni, od najstarszego, po deduplikacji po zakresie
 * danych jak w profilu (#281). Baza dla zera
 * wierszy: przebieg uzupełniający lukę ma własny profil bez próbek, a brak danych
 * po przerwie nie przestaje być brakiem danych. Zakres bieżącego przebiegu jest
 * wykluczony, jak w profilu: ponowny import dnia, który wcześniej dał dane, nie ma
 * z czym się porównać.
 */
function importSourceSamples_(source, run, history, now) {
  const cutoff = importLogCutoff_(now || new Date(run.finishedAt));
  const sorted = history
    .filter(h => h.ok && h.source === source && h.trigger === Boolean(run.trigger) && !isNaN(h.at.getTime()) && h.at.getTime() >= cutoff)
    .sort((a, b) => a.at - b.at);
  return newestPerRange_(sorted, importRangeKey_(run));
}

/**
 * Zero wierszy, gdy mediana profilu nie rozstrzyga (#180, punkt 3; #281): cały
 * profil, nie tylko klasa - zero po dniach roboczych z danymi jest alarmem także
 * w pierwszą sobotę. Gdy profil nie ma próbek z danymi, liczy się historia źródła
 * z dowolną liczbą dni.
 */
function importZeroAnomaly_(profileSamples, sourceSamples) {
  const profile = profileSamples.filter(h => h.rows > 0);
  if (profile.length) {
    return 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio ' + profile[profile.length - 1].rows + ')';
  }
  const anyDays = sourceSamples.filter(h => h.rows > 0);
  if (anyDays.length) {
    return 'mało danych: 0 wierszy, a wcześniej to źródło zwracało dane (ostatnio ' + anyDays[anyDays.length - 1].rows + ')';
  }
  return '';
}

/**
 * Tekst ostrzeżenia, gdy liczba wierszy odstaje od mediany ostatnich
 * IMPORT_ANOMALY_MIN_RUNS próbek tego samego profilu; '' gdy w normie albo
 * historia zbyt krótka (bez fałszywych alarmów na starcie).
 *
 * Wyjątek od rozgrzewki (#180): ZERO wierszy alarmuje, gdy profil wcześniej
 * zwracał dane - bez względu na liczbę próbek. Od #281 także wtedy, gdy dane
 * zwracało źródło w profilu o innej liczbie dni (przebieg uzupełniający lukę).
 */
function importAnomaly_(source, run, history, now) {
  const samples = importAnomalySamples_(source, run, history, now);
  const rows = Number(run.rows) || 0;
  const scope = importAnomalyScope_(source, run);
  const median = importAnomalyMedian_(samples, scope);
  const versus = rowsCount => 'mało danych: ' + rowsCount + ' wierszy vs mediana ' + median +
    (scope.cls ? ' (' + IMPORT_ANOMALY_CLASS_LABEL[scope.cls] + ')' : '');

  if (rows === 0) return median > 0 ? versus(0) : importZeroAnomaly_(samples, importSourceSamples_(source, run, history, now));
  return median > 0 && rows < median / 2 ? versus(rows) : '';
}
