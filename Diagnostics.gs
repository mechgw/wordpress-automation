/**
 * Diagnostyka systemu (#54): ręczny smoke test z menu, WYŁĄCZNIE odczyt.
 *
 * #44 dowodzi, że wdrożyliśmy właściwe pliki; #43 i #42 mówią, czy realne
 * procesy działają. To narzędzie odpowiada na pytanie „dlaczego coś nie
 * działa”: sprawdza krok po kroku Script Properties, zakładki, dostęp do
 * GSC, GA4 i WordPressa, triggery i konfigurację alertów, i pokazuje raport
 * per krok. Nie zapisuje niczego: ani w arkuszu, ani w Script Properties,
 * ani w WordPressie (tylko żądania GET).
 *
 * Bez integracji z CI (korekta po audycie: clasp run i odczyt komórki
 * odrzucone jako zbyt kosztowne w konfiguracji).
 */

const SMOKE_REQUIRED_PROPERTIES = ['WP_BASE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_REST_NAMESPACE'];
const SMOKE_OPTIONAL_PROPERTIES = ['SITE_DOMAIN', 'ALERT_EMAIL', 'ALERT_RECOVERY', 'WP_ALLOW_WRITES', 'WP_DRY_RUN', 'EXPECTED_SITEMAPS'];

/** Skraca komunikat błędu do jednej czytelnej linii (kod HTTP zostaje). */
function smokeErrorText_(e) {
  return String(e && e.message ? e.message : e).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Wykonuje krok w try/catch; wynik { name, ok, detail }. */
function smokeStep_(name, fn) {
  try {
    const detail = fn();
    return { name, ok: true, detail: String(detail || 'OK') };
  } catch (e) {
    return { name, ok: false, detail: smokeErrorText_(e) };
  }
}

function smokeProperties_() {
  const props = PropertiesService.getScriptProperties();
  const missing = SMOKE_REQUIRED_PROPERTIES.filter(k => !String(props.getProperty(k) || '').trim());
  if (missing.length) throw new Error('brak wymaganych: ' + missing.join(', '));
  const optional = SMOKE_OPTIONAL_PROPERTIES.filter(k => String(props.getProperty(k) || '').trim()).map(k => {
    const value = String(props.getProperty(k)).trim();
    return k === 'ALERT_EMAIL' ? k : k + '=' + value;
  });
  const notes = ['wymagane: ' + SMOKE_REQUIRED_PROPERTIES.length + '/' + SMOKE_REQUIRED_PROPERTIES.length];
  notes.push('opcjonalne: ' + (optional.length ? optional.join(', ') : 'brak'));
  // Sama wartość ALERT_EMAIL nigdy nie trafia do raportu: diagnostyka bywa
  // wklejana i zrzucana na ekran. Poprawną wartość pokazuje „Status danych”.
  if (!smokeAlertRecipient_().ok) throw new Error(notes.join(' | ') + ' | ALERT_EMAIL nie jest adresem (popraw Script Property)');
  return notes.join(' | ');
}

/** Stan adresata alertów bez ujawniania adresu: { ok, text }. */
function smokeAlertRecipient_() {
  const cfg = alertConfig_();
  if (!cfg.raw) return { ok: true, text: 'brak (ALERT_EMAIL nieustawione, alerty wyłączone)' };
  if (!cfg.valid) return { ok: false, text: 'NIEPRAWIDŁOWY (wartość nie jest adresem)' };
  const count = cfg.email.split(',').length;
  return { ok: true, text: 'skonfigurowany i poprawny (' + count + (count === 1 ? ' adres' : ' adresy') + ', wartość w Script Properties)' };
}

function smokeSheets_() {
  const ss = SpreadsheetApp.getActive();
  const gscCfg = ss.getSheetByName(CONFIG_SHEET);
  if (!gscCfg) throw new Error('brak zakładki ' + CONFIG_SHEET);
  const siteUrl = getConfig_().siteUrl;
  if (!siteUrl) throw new Error(CONFIG_SHEET + ': pusty siteUrl');
  const ga4 = getGa4Config_();
  if (!ga4.propertyId) throw new Error(GA4_CONFIG_SHEET + ': pusty propertyId');

  const expected = [RAW_SHEET, ga4.landingSheet, ga4.eventsSheet, ga4.businessEventsSheet, ga4.adsSheet, WP_COMMANDS_SHEET, WP_RESULTS_SHEET, WP_SNAPSHOTS_SHEET];
  const missing = expected.filter(name => !ss.getSheetByName(name));
  const optional = [IMPORT_LOG_SHEET, URL_INSPECTION_SHEET, SEO_LIVE_SHEET, SITEMAPS_SHEET].filter(name => ss.getSheetByName(name));
  const text = 'siteUrl: ' + siteUrl + ' | propertyId: ' + ga4.propertyId +
    ' | zakładki skryptu obecne: ' + (optional.length ? optional.join(', ') : 'żadna (powstaną przy pierwszym użyciu)');
  if (missing.length) throw new Error('brak zakładek: ' + missing.join(', ') + ' | ' + text);
  return text;
}

function smokeGsc_() {
  const siteUrl = getConfig_().siteUrl;
  const response = apiRequest_('https://www.googleapis.com/webmasters/v3/sites', 'get');
  const sites = (response && response.siteEntry) || [];
  const mine = sites.find(s => String(s.siteUrl) === siteUrl);
  if (!sites.length) throw new Error('konto nie ma żadnej właściwości Search Console');
  if (!mine) throw new Error('siteUrl „' + siteUrl + '” nie jest wśród ' + sites.length + ' dostępnych właściwości');
  return sites.length + ' właściwości, ' + siteUrl + ': ' + mine.permissionLevel;
}

function smokeGa4_() {
  const cfg = requireGa4Config_();
  const response = ga4ApiRequest_('https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(cfg.propertyId) + '/metadata', 'get');
  const dims = (response && response.dimensions) || [];
  const metrics = (response && response.metrics) || [];
  return 'właściwość ' + cfg.propertyId + ': Data API odpowiada (' + dims.length + ' wymiarów, ' + metrics.length + ' metryk)';
}

function smokeWordPress_() {
  const cfg = getWpConfig_();
  const response = wpFetch_('/wp-json/wp/v2/users/me?context=edit', { method: 'get' });
  if (response.code < 200 || response.code >= 300) {
    throw new Error('HTTP ' + response.code + ' dla ' + cfg.baseUrl + '/wp-json/wp/v2/users/me' + (response.code === 401 ? ' (login lub hasło aplikacji)' : ''));
  }
  const user = response.json || {};
  const caps = user.capabilities || {};
  const canEdit = caps.edit_pages === true || caps.edit_others_pages === true;
  return cfg.baseUrl + ': zalogowany jako ' + (user.slug || user.name || '?') +
    ' | edycja stron: ' + (canEdit ? 'TAK' : 'NIE (brak edit_pages)') +
    ' | zapisy: ' + (cfg.allowWrites ? 'WŁĄCZONE' : 'wyłączone') + (cfg.dryRun ? ' | DRY_RUN' : '');
}

function smokeTriggers_() {
  const installed = {};
  ScriptApp.getProjectTriggers().forEach(t => { installed[t.getHandlerFunction()] = true; });
  // Lista zadań pochodzi z jednego rejestru (scheduledJobs_), żeby nowe zadanie
  // nie mogło zniknąć z diagnostyki przez przeoczenie.
  return scheduledJobs_().map(t => t.label + ': ' + (installed[t.handler] ? 'TAK' : 'NIE')).join(' | ');
}

function smokeAlerts_() {
  return 'adresat: ' + smokeAlertRecipient_().text + ' | ' + sitemapsStatusLine_();
}

/**
 * Smoke test: lista kroków { name, ok, detail }. Każdy krok jest niezależny,
 * błąd jednego nie przerywa pozostałych. Żaden krok nie zapisuje.
 */
function smokeTest() {
  return [
    smokeStep_('Script Properties', smokeProperties_),
    smokeStep_('Zakładki i konfiguracja', smokeSheets_),
    smokeStep_('GSC odczyt', smokeGsc_),
    smokeStep_('GA4 odczyt', smokeGa4_),
    smokeStep_('WordPress odczyt', smokeWordPress_),
    smokeStep_('Triggery', smokeTriggers_),
    smokeStep_('Alerty i sitemapy', smokeAlerts_)
  ];
}

function smokeReportText_(steps) {
  const failed = steps.filter(s => !s.ok).length;
  const lines = [
    'Diagnostyka systemu (tylko odczyt) – wersja ' + versionLabel_() + ': ' +
      (failed ? failed + ' z ' + steps.length + ' kroków z błędem' : 'wszystkie ' + steps.length + ' kroków OK'),
    ''
  ];
  steps.forEach(s => lines.push((s.ok ? 'OK    ' : 'BŁĄD  ') + s.name + ': ' + s.detail));
  if (failed) {
    lines.push('', 'Nic nie zostało zmienione. Popraw wskazane elementy i uruchom diagnostykę ponownie.');
  }
  return lines.join('\n');
}

/** Menu Dane → Diagnostyka systemu. */
function diagnostykaSystemu() {
  const steps = smokeTest();
  SpreadsheetApp.getUi().alert(smokeReportText_(steps));
  return steps;
}
