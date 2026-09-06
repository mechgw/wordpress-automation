/**
 * Stan map witryny z Search Console (#47): czy sitemapy są zgłoszone,
 * kiedy Google je ostatnio pobrał, ile adresów zawierają, czy zgłaszają
 * błędy. Pierwszy sygnał, że architektura stron się rozjechała.
 *
 * Arkusz `SITEMAPY` jest przepisywany przy każdym sprawdzeniu (API jest
 * źródłem prawdy, nie arkusz). Podsumowanie trafia też do Script Property
 * SITEMAPS_STATUS i do okna „Status danych”.
 *
 * Alarm (UWAGA) wyłącznie przy: errors > 0, isPending utrzymującym się
 * dłużej niż SITEMAPS_PENDING_MAX_DAYS od zgłoszenia, braku sitemapy z listy
 * oczekiwanych (Script Property EXPECTED_SITEMAPS, adresy po przecinku)
 * i błędzie API. Data ostatniego pobrania jest tylko informacją: Google nie
 * definiuje „dawno niepobrana” jako stanu błędnego (korekta po audycie).
 */

const SITEMAPS_SHEET = 'SITEMAPY';
const SITEMAPS_HEADER = [
  'Sitemapa',
  'Typ',
  'Zgłoszona',
  'Pobrana przez Google',
  'Oczekuje',
  'Adresy zgłoszone',
  'Ostrzeżenia',
  'Błędy',
  'Stan',
  'Sprawdzono'
];
const SITEMAPS_PENDING_MAX_DAYS = 7;
const SITEMAPS_STATUS_KEY = 'SITEMAPS_STATUS';

function listSitemaps_(siteUrl) {
  const response = apiRequest_(
    'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl) + '/sitemaps',
    'get'
  );
  return (response && response.sitemap) || [];
}

/** Oczekiwane sitemapy z EXPECTED_SITEMAPS (po przecinku); pusta lista = nic nie wymagamy. */
function expectedSitemaps_() {
  const raw = PropertiesService.getScriptProperties().getProperty('EXPECTED_SITEMAPS') || '';
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function sitemapKey_(path) {
  return String(path || '').trim().toLowerCase().replace(/\/+$/, '');
}

/** Wiersz arkusza i lista problemów dla jednej sitemapy. */
function sitemapRow_(sm, now, checkedText) {
  const errors = Number(sm.errors) || 0;
  const warnings = Number(sm.warnings) || 0;
  const submittedUrls = (sm.contents || []).reduce((sum, c) => sum + (Number(c.submitted) || 0), 0);
  const problems = [];

  if (errors > 0) problems.push('błędy: ' + errors);
  if (sm.isPending) {
    const submittedAt = sm.lastSubmitted ? new Date(sm.lastSubmitted).getTime() : NaN;
    const days = isNaN(submittedAt) ? null : Math.floor((now.getTime() - submittedAt) / 86400000);
    if (days === null || days > SITEMAPS_PENDING_MAX_DAYS) {
      problems.push('oczekuje na przetworzenie' + (days === null ? '' : ' od ' + days + ' dni'));
    }
  }

  return {
    problems,
    values: [
      String(sm.path || ''),
      sm.isSitemapsIndex ? 'indeks sitemap' : 'sitemapa',
      sm.lastSubmitted ? formatImportTime_(sm.lastSubmitted) : '',
      sm.lastDownloaded ? formatImportTime_(sm.lastDownloaded) : 'nigdy',
      sm.isPending ? 'TAK' : 'NIE',
      submittedUrls,
      warnings,
      errors,
      problems.length ? 'UWAGA: ' + problems.join('; ') : 'OK',
      checkedText
    ]
  };
}

/**
 * Pobiera listę sitemap, przepisuje arkusz SITEMAPY, zapisuje podsumowanie
 * w SITEMAPS_STATUS. Błąd API jest zapisany jako problem i rzucony dalej,
 * żeby użytkownik go zobaczył, a Status danych nie udawał, że jest OK.
 */
function runSitemapsCheck_() {
  const cfg = getConfig_();
  if (!cfg.siteUrl) throw new Error('Brak siteUrl w arkuszu ' + CONFIG_SHEET + '.');

  const now = new Date();
  const checkedText = formatImportTime_(now.toISOString());
  const props = PropertiesService.getScriptProperties();

  let sitemaps;
  try {
    sitemaps = listSitemaps_(cfg.siteUrl);
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    props.setProperty(SITEMAPS_STATUS_KEY, JSON.stringify({ checkedAt: now.toISOString(), count: null, problems: ['błąd API: ' + message] }));
    throw e;
  }

  const sheet = ensureSheetWithHeader_(SITEMAPS_SHEET, SITEMAPS_HEADER);
  const problems = [];
  const rows = sitemaps.map(sm => {
    const row = sitemapRow_(sm, now, checkedText);
    row.problems.forEach(p => problems.push(sm.path + ': ' + p));
    return row.values;
  });

  const present = {};
  sitemaps.forEach(sm => { present[sitemapKey_(sm.path)] = true; });
  expectedSitemaps_().forEach(path => {
    if (!present[sitemapKey_(path)]) {
      problems.push(path + ': brak w Search Console (oczekiwana wg EXPECTED_SITEMAPS)');
      rows.push([path, 'oczekiwana', '', '', '', '', '', '', 'UWAGA: brak w Search Console', checkedText]);
    }
  });

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, SITEMAPS_HEADER.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, SITEMAPS_HEADER.length).setValues(rows);

  const summary = { checkedAt: now.toISOString(), count: sitemaps.length, problems };
  props.setProperty(SITEMAPS_STATUS_KEY, JSON.stringify(summary));
  return summary;
}

function readSitemapsStatus_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SITEMAPS_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** Jedna linia do okna „Status danych”. */
function sitemapsStatusLine_() {
  const status = readSitemapsStatus_();
  if (!status) return 'Sitemapy: nie sprawdzano (SEO / GSC → Sprawdź sitemapy)';
  const head = status.count === null ? 'Sitemapy: błąd API' : 'Sitemapy: ' + status.count;
  const problems = status.problems || [];
  return head + ' | ' + (problems.length ? 'UWAGA: ' + problems.join('; ') : 'OK') +
    ' (sprawdzono ' + formatImportTime_(status.checkedAt) + ')';
}

function sitemapsSummaryText_(summary) {
  const lines = [];
  if (summary.count === 0) {
    lines.push('Search Console nie zwraca żadnej sitemapy dla tej witryny. Zgłoś sitemapę w Search Console albo sprawdź siteUrl.');
  } else {
    lines.push('Sitemapy w Search Console: ' + summary.count + ' (szczegóły w arkuszu „' + SITEMAPS_SHEET + '”).');
  }
  if (summary.problems.length) {
    lines.push('', 'UWAGA:');
    summary.problems.forEach(p => lines.push('- ' + p));
  } else if (summary.count > 0) {
    lines.push('Bez błędów i bez zaległych przetworzeń.');
  }
  return lines.join('\n');
}

/** Menu SEO / GSC → Sprawdź sitemapy. */
function sprawdzSitemapy() {
  const summary = withScriptLock_('sitemapy', runSitemapsCheck_);
  SpreadsheetApp.getUi().alert(sitemapsSummaryText_(summary));
  return summary;
}
