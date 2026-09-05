/**
 * Inspekcja URL (#45): stan kluczowych adresów W INDEKSIE GOOGLE z API
 * Search Console (urlInspection.index.inspect).
 *
 * Ograniczenie API: wynik opisuje to, co Google ma w indeksie z ostatniego
 * crawlu, NIE stan aktualnie opublikowanej strony. Po zmianie noindex,
 * canonicala czy treści wynik zmieni się dopiero po ponownym crawlu.
 * Stan „live” strony to osobne narzędzie (#53).
 *
 * Arkusz `URL INSPEKCJA`: adresy w kolumnie A, wyniki w tym samym wierszu.
 * Limit API: 2000 inspekcji dziennie na witrynę; jeden przebieg sprawdza
 * najwyżej URL_INSPECTION_MAX_PER_RUN adresów, resztę zgłasza jako pominiętą.
 */

const URL_INSPECTION_SHEET = 'URL INSPEKCJA';
const URL_INSPECTION_HEADER = [
  'URL',
  'Werdykt (indeks Google)',
  'Stan pokrycia',
  'Kanoniczny wg Google',
  'Kanoniczny wg strony',
  'Ostatni crawl',
  'Robots.txt',
  'Sprawdzono',
  'Zmiana',
  'Błąd'
];
const URL_INSPECTION_MAX_PER_RUN = 150;
const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const URL_INSPECTION_TRIGGER_HANDLER = 'sprawdzIndeksowanieTrigger';
const URL_INSPECTION_TRIGGER_HOUR = 7;

/** Arkusz z listą adresów; tworzony z nagłówkiem, gdy go nie ma (odporne na wyścig jak IMPORT LOG). */
function ensureUrlInspectionSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(URL_INSPECTION_SHEET);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(URL_INSPECTION_SHEET);
    } catch (e) {
      sheet = ss.getSheetByName(URL_INSPECTION_SHEET);
      if (!sheet) throw e;
    }
  }
  if (sheet.getLastRow() < 1 || String(sheet.getRange(1, 1).getValue() || '') !== URL_INSPECTION_HEADER[0]) {
    // Arkusz z danymi, ale bez nagłówka (np. wklejona lista): nagłówek idzie
    // NAD dane, żeby nie nadpisać pierwszego adresu.
    if (sheet.getLastRow() >= 1 && !sheet.getRange(1, 1, 1, URL_INSPECTION_HEADER.length).isBlank()) {
      sheet.insertRowBefore(1);
    }
    sheet.getRange(1, 1, 1, URL_INSPECTION_HEADER.length).setValues([URL_INSPECTION_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Czas z kolumny „Sprawdzono” jako liczba; brak lub nieczytelny = 0 (najpilniejszy). */
function urlInspectionCheckedAt_(value) {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(String(value).replace(' ', 'T')).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Kolejność przetwarzania: adresy nigdy niesprawdzone najpierw, potem od
 * najdawniej sprawdzonych; przy równym czasie kolejność wierszy. Dzięki temu
 * lista dłuższa niż limit jest obsługiwana w kolejnych przebiegach, a nie
 * zawsze od góry.
 */
function urlInspectionQueue_(values) {
  return values
    .map((line, i) => ({ rowNumber: i + 2, line, url: String(line[0] || '').trim(), checkedAt: urlInspectionCheckedAt_(line[7]) }))
    .filter(item => item.url)
    .sort((a, b) => (a.checkedAt - b.checkedAt) || (a.rowNumber - b.rowNumber));
}

/** Jedno zapytanie do API inspekcji; zwraca indexStatusResult (może być pusty). */
function inspectUrl_(siteUrl, url) {
  const result = apiRequest_(URL_INSPECTION_ENDPOINT, 'post', {
    inspectionUrl: url,
    siteUrl: siteUrl,
    languageCode: 'pl'
  });
  return (result && result.inspectionResult && result.inspectionResult.indexStatusResult) || {};
}

/** Werdykt API w języku arkusza; surowa wartość w nawiasie, żeby nic nie zginęło. */
function urlInspectionVerdict_(verdict) {
  const labels = {
    PASS: 'ZAINDEKSOWANY',
    NEUTRAL: 'WYKLUCZONY',
    FAIL: 'BŁĄD INDEKSOWANIA'
  };
  const raw = String(verdict || 'VERDICT_UNSPECIFIED');
  return (labels[raw] || 'NIEZNANY') + ' (' + raw + ')';
}

/**
 * Wartości kolumn B..J dla jednego adresu. `previous` to poprzedni wiersz
 * (werdykt i stan pokrycia), na tej podstawie wypełniana jest kolumna Zmiana.
 */
function urlInspectionRow_(status, previous, now) {
  const verdict = urlInspectionVerdict_(status.verdict);
  const coverage = String(status.coverageState || '');
  const prevVerdict = String((previous && previous.verdict) || '');
  const prevCoverage = String((previous && previous.coverage) || '');
  let change = '';
  if (prevVerdict && (prevVerdict !== verdict || prevCoverage !== coverage)) {
    change = 'ZMIANA: ' + prevVerdict + (prevCoverage ? ' / ' + prevCoverage : '') +
      ' → ' + verdict + (coverage ? ' / ' + coverage : '');
  }
  return [
    verdict,
    coverage,
    String(status.googleCanonical || ''),
    String(status.userCanonical || ''),
    status.lastCrawlTime ? formatImportTime_(status.lastCrawlTime) : '',
    String(status.robotsTxtState || ''),
    formatImportTime_(now.toISOString()),
    change,
    ''
  ];
}

/**
 * Przebieg inspekcji: czyta adresy z kolumny A, zapisuje wyniki w tym samym
 * wierszu. Błąd jednego adresu trafia do kolumny Błąd (poprzednie wartości
 * zostają), reszta jest przetwarzana. Zwraca podsumowanie.
 */
function runUrlInspection_() {
  const cfg = getConfig_();
  if (!cfg.siteUrl) throw new Error('Brak siteUrl w arkuszu ' + CONFIG_SHEET + '.');

  const sheet = ensureUrlInspectionSheet_();
  const summary = { checked: 0, errors: 0, changed: 0, skipped: 0, empty: false };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    summary.empty = true;
    return summary;
  }

  const width = URL_INSPECTION_HEADER.length;
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const now = new Date();

  urlInspectionQueue_(values).forEach(item => {
    const { url, line, rowNumber } = item;
    if (summary.checked + summary.errors >= URL_INSPECTION_MAX_PER_RUN) {
      summary.skipped++;
      return;
    }
    try {
      if (!/^https?:\/\//i.test(url)) throw new Error('Adres musi zaczynać się od http:// lub https://');
      const status = inspectUrl_(cfg.siteUrl, url);
      const row = urlInspectionRow_(status, { verdict: line[1], coverage: line[2] }, now);
      sheet.getRange(rowNumber, 2, 1, width - 1).setValues([row]);
      summary.checked++;
      if (row[7]) summary.changed++;
    } catch (e) {
      sheet.getRange(rowNumber, 8, 1, 3).setValues([[
        formatImportTime_(now.toISOString()),
        '',
        String(e && e.message ? e.message : e)
      ]]);
      summary.errors++;
    }
  });

  return summary;
}

/** Tekst podsumowania do okna i logu. */
function urlInspectionSummaryText_(summary) {
  if (summary.empty) {
    return 'Arkusz „' + URL_INSPECTION_SHEET + '” nie ma adresów. Wpisz adresy w kolumnie A (od wiersza 2) i uruchom ponownie.';
  }
  const lines = [
    'Inspekcja URL (stan w indeksie Google, nie stan live strony):',
    'Sprawdzono: ' + summary.checked,
    'Zmiany werdyktu lub pokrycia: ' + summary.changed,
    'Błędy (kolumna Błąd): ' + summary.errors
  ];
  if (summary.skipped) {
    lines.push('Pominięto: ' + summary.skipped + ' (limit ' + URL_INSPECTION_MAX_PER_RUN + ' adresów na przebieg; kolejny przebieg zaczyna od najdawniej sprawdzonych)');
  }
  return lines.join('\n');
}

/** Menu SEO / GSC → Sprawdź indeksowanie. */
function sprawdzIndeksowanie() {
  const summary = withScriptLock_('inspekcja URL', runUrlInspection_);
  SpreadsheetApp.getUi().alert(urlInspectionSummaryText_(summary));
  return summary;
}

/** Handler triggera tygodniowego: bez okna, wynik w arkuszu i w logu. */
function sprawdzIndeksowanieTrigger() {
  const summary = withScriptLock_('inspekcja URL', runUrlInspection_);
  Logger.log(urlInspectionSummaryText_(summary));
  return summary;
}

/** Instaluje cotygodniową inspekcję (poniedziałek, ok. 07:00), zastępując poprzednią. */
function ustawTygodniowaInspekcje() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === URL_INSPECTION_TRIGGER_HANDLER)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger(URL_INSPECTION_TRIGGER_HANDLER)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(URL_INSPECTION_TRIGGER_HOUR)
    .create();

  SpreadsheetApp.getUi().alert(
    'Cotygodniowa inspekcja URL została ustawiona (poniedziałek, ok. ' + URL_INSPECTION_TRIGGER_HOUR + ':00).\n' +
    'Adresy: arkusz „' + URL_INSPECTION_SHEET + '”, kolumna A. Limit: ' + URL_INSPECTION_MAX_PER_RUN + ' adresów na przebieg.'
  );
}
