/**
 * Porządek w pliku (#78): kategorie, kolory zakładek, kolejność i arkusz START.
 *
 * Plik ma ponad dwadzieścia zakładek i rośnie z każdą funkcją. Zamiast
 * porządkować je ręcznie po każdej zmianie, robi to skrypt, idempotentnie:
 * kolejne uruchomienie na uporządkowanym pliku niczego nie zmienia.
 *
 * Zasada bezpieczeństwa: skrypt dotyka WYŁĄCZNIE arkuszy, które sam tworzy
 * (katalog niżej). Arkusze własne użytkownika zachowują swoje kolory i nigdy
 * nie są ukrywane; dostają tylko miejsce zaraz za START, bo to one są czytane
 * na co dzień. Ukrywanie arkuszy technicznych jest osobną, jawną pozycją menu.
 */

const START_SHEET = 'START';
/** Podpis w A1 dowodzący, że arkusz START wygenerował skrypt. */
const START_SIGNATURE = 'START – spis arkuszy';
const START_HEADER = ['Arkusz', 'Kategoria', 'Prowadzi', 'Co tu jest'];

/** Kategorie w kolejności wyświetlania. `color: null` = nie zmieniaj koloru zakładki. */
const SHEET_CATEGORIES = [
  { key: 'start', label: 'Start', color: '#674ea7' },
  { key: 'wlasne', label: 'Analiza (arkusze własne)', color: null },
  { key: 'monitoring', label: 'Monitoring', color: '#38761d' },
  { key: 'sterowanie', label: 'Sterowanie', color: '#e69138' },
  { key: 'konfiguracja', label: 'Konfiguracja', color: '#999999' },
  { key: 'dane', label: 'Dane surowe i logi', color: '#434343' }
];

/**
 * Nazwy arkuszy GA4 zgodne z konfiguracją: `Konfiguracja GA4` pozwala nadpisać
 * landingSheet / eventsSheet / businessEventsSheet / adsSheet, a import zapisuje
 * pod tymi nazwami. Katalog musi patrzeć na to samo, inaczej nadpisane arkusze
 * uchodziłyby za własne użytkownika. Brak arkusza konfiguracji = wartości domyślne.
 */
function ga4SheetNames_() {
  const fallback = { landingSheet: GA4_RAW_SHEET, eventsSheet: GA4_EVENTS_SHEET, businessEventsSheet: GA4_BUSINESS_SHEET, adsSheet: GA4_ADS_SHEET };
  let cfg;
  try {
    cfg = getGa4Config_();
  } catch (e) {
    return fallback;
  }
  return {
    landingSheet: String(cfg.landingSheet || fallback.landingSheet),
    eventsSheet: String(cfg.eventsSheet || fallback.eventsSheet),
    businessEventsSheet: String(cfg.businessEventsSheet || fallback.businessEventsSheet),
    adsSheet: String(cfg.adsSheet || fallback.adsSheet)
  };
}

/** Arkusze tworzone przez skrypt. Nowa funkcja = jeden wpis tutaj. */
function sheetCatalog_() {
  const ga4 = ga4SheetNames_();
  return [
    { name: URL_INSPECTION_SHEET, category: 'monitoring', owner: 'człowiek + skrypt', description: 'Adresy do monitorowania w kolumnie A; skrypt dopisuje stan w indeksie Google.' },
    { name: SEO_LIVE_SHEET, category: 'monitoring', owner: 'człowiek + skrypt', description: 'Adresy i oczekiwania w B..H; skrypt dopisuje wynik porównania ze stanem live.' },
    { name: SITEMAPS_SHEET, category: 'monitoring', owner: 'skrypt', description: 'Migawka sitemap z Search Console; przepisywana przy każdym sprawdzeniu.' },
    { name: WP_COMMANDS_SHEET, category: 'sterowanie', owner: 'człowiek + skrypt', description: 'Polecenia do WordPressa; status PENDING uruchamia, skrypt wpisuje wynik.' },
    { name: WP_RESULTS_SHEET, category: 'sterowanie', owner: 'skrypt', description: 'Wyniki wykonanych poleceń; podstawa idempotencji (command_id).' },
    { name: WP_SNAPSHOTS_SHEET, category: 'sterowanie', owner: 'skrypt', description: 'Stan stron sprzed zapisu; źródło dla RESTORE_SNAPSHOT.' },
    { name: FORMINATOR_HISTORY_SHEET, category: 'sterowanie', owner: 'skrypt', description: 'Historia zgłoszeń Forminatora pobrana z WordPressa.' },
    { name: ADS_EXPERIMENT_SHEET, category: 'sterowanie', owner: 'skrypt', description: 'Wynik eksperymentu zgodności kosztów Ads w GA4 Data API (#46).' },
    { name: CONFIG_SHEET, category: 'konfiguracja', owner: 'człowiek', description: 'Konfiguracja Search Console; B8 pokazuje status importu.' },
    { name: GA4_CONFIG_SHEET, category: 'konfiguracja', owner: 'człowiek', description: 'Konfiguracja GA4; B9 pokazuje status importu.' },
    { name: RAW_SHEET, category: 'dane', owner: 'skrypt', description: 'Surowe dane Search Console. Nie edytuj ręcznie.' },
    { name: ga4.landingSheet, category: 'dane', owner: 'skrypt', description: 'Surowe dane GA4: strony docelowe. Nie edytuj ręcznie.' },
    { name: ga4.eventsSheet, category: 'dane', owner: 'skrypt', description: 'Surowe dane GA4: key events. Nie edytuj ręcznie.' },
    { name: ga4.businessEventsSheet, category: 'dane', owner: 'skrypt', description: 'Surowe dane GA4: zdarzenia biznesowe. Nie edytuj ręcznie.' },
    { name: ga4.adsSheet, category: 'dane', owner: 'skrypt', description: 'Surowe dane GA4: ruch z Google Ads. Nie edytuj ręcznie.' },
    { name: IMPORT_LOG_SHEET, category: 'dane', owner: 'skrypt', description: 'Historia importów i podstawa wykrywania anomalii; retencja 90 dni.' }
  ];
}

function sheetCategory_(key) {
  return SHEET_CATEGORIES.filter(c => c.key === key)[0] || { key: key, label: key, color: null };
}

/**
 * Docelowy stan każdej zakładki pliku: wpis z katalogu albo pozycja własna
 * użytkownika. Kolejność wynikowa: START, arkusze własne (w dotychczasowej
 * kolejności względnej), potem kategorie z katalogu.
 */
function sheetPlan_() {
  const ss = SpreadsheetApp.getActive();
  const catalog = {};
  sheetCatalog_().forEach(entry => { catalog[entry.name] = entry; });

  const existing = ss.getSheets().map(s => s.getName());
  const known = existing.filter(name => catalog[name]);
  const own = existing.filter(name => name !== START_SHEET && !catalog[name]);

  const plan = [{ name: START_SHEET, category: 'start', owner: 'skrypt', description: 'Ten spis: co jest w pliku, kto to prowadzi i gdzie wpisywać dane.' }];
  own.forEach(name => plan.push({ name: name, category: 'wlasne', owner: 'człowiek', description: 'Arkusz własny, nie zarządzany przez skrypt.' }));
  SHEET_CATEGORIES.forEach(cat => {
    if (cat.key === 'start' || cat.key === 'wlasne') return;
    sheetCatalog_().forEach(entry => {
      if (entry.category === cat.key && known.indexOf(entry.name) >= 0) plan.push(entry);
    });
  });
  return plan;
}

/** Buduje treść arkusza START z planu. */
function startSheetRows_(plan) {
  const url = spreadsheetUrl_().replace(/#.*$/, '').replace(/\/edit.*$/, '/edit');
  const ss = SpreadsheetApp.getActive();
  const rows = [
    [START_SIGNATURE + ' (wersja skryptu: ' + versionLabel_() + ')'],
    ['Odświeżany przez Dane → Uporządkuj arkusze. Stan danych: Dane → Status danych.'],
    [],
    START_HEADER
  ];
  plan.forEach(item => {
    if (item.name === START_SHEET) return;
    const sheet = ss.getSheetByName(item.name);
    // Cudzysłów w nazwie arkusza podwajamy, jak każdy tekst w formule Sheets.
    const label = String(item.name).replace(/"/g, '""');
    const link = sheet ? '=HYPERLINK("' + url + '#gid=' + sheet.getSheetId() + '","' + label + '")' : item.name;
    rows.push([link, sheetCategory_(item.category).label, item.owner, item.description]);
  });
  return rows;
}

/**
 * Czy arkusz START jest tym, który wygenerował skrypt. Pusty arkusz przechodzi
 * (świeżo wstawiony); arkusz z treścią musi mieć w A1 podpis z START_SIGNATURE.
 * Bez tego cudza zakładka o tej nazwie zostałaby wyczyszczona bez ostrzeżenia.
 */
function isGeneratedStartSheet_(sheet) {
  if (sheet.getLastRow() < 1) return true;
  return String(sheet.getRange(1, 1).getValue() || '').indexOf(START_SIGNATURE) === 0;
}

function writeStartSheet_(plan) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(START_SHEET);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(START_SHEET);
    } catch (e) {
      sheet = ss.getSheetByName(START_SHEET);
      if (!sheet) throw e;
    }
  }
  if (!isGeneratedStartSheet_(sheet)) {
    throw new Error('Arkusz „' + START_SHEET + '” istnieje i nie został utworzony przez skrypt (A1 nie zaczyna się od „' +
      START_SIGNATURE + '”). Zmień jego nazwę albo opróżnij go, potem uruchom porządkowanie ponownie. Nic nie zostało zmienione.');
  }
  const rows = startSheetRows_(plan);
  const width = START_HEADER.length;
  sheet.clear();
  rows.forEach((row, i) => {
    const padded = row.concat(new Array(Math.max(0, width - row.length)).fill(''));
    sheet.getRange(i + 1, 1, 1, width).setValues([padded]);
  });
  sheet.setFrozenRows(4);
  return rows.length;
}

/**
 * Porządkuje plik: kolory zakładek arkuszy skryptu, kolejność wszystkich
 * zakładek, odświeżony START. Nie ukrywa niczego i nie dotyka kolorów arkuszy
 * własnych. Zwraca { recolored, moved, startRows, own, known }.
 */
function uporzadkujArkusze() {
  const ss = SpreadsheetApp.getActive();
  const plan = sheetPlan_();
  const summary = { recolored: [], moved: [], startRows: 0, own: 0, known: 0, rehidden: 0 };

  summary.startRows = writeStartSheet_(plan);

  plan.forEach(item => {
    const color = sheetCategory_(item.category).color;
    if (item.category === 'wlasne') summary.own++; else summary.known++;
    if (color === null) return;
    const sheet = ss.getSheetByName(item.name);
    if (!sheet) return;
    if (String(sheet.getTabColor() || '').toLowerCase() !== color.toLowerCase()) {
      sheet.setTabColor(color);
      summary.recolored.push(item.name);
    }
  });

  // Ukrytej zakładki nie da się uaktywnić, a bez aktywacji nie da się jej
  // przenieść: na czas porządkowania pokazujemy ją i przywracamy ukrycie.
  const hiddenAgain = [];
  plan.forEach(item => {
    const sheet = ss.getSheetByName(item.name);
    if (sheet && sheet.isSheetHidden()) {
      sheet.showSheet();
      hiddenAgain.push(sheet);
    }
  });

  try {
    plan.forEach((item, index) => {
      const sheet = ss.getSheetByName(item.name);
      if (!sheet) return;
      const current = ss.getSheets().map(s => s.getName()).indexOf(item.name);
      if (current === index) return;
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(index + 1);
      summary.moved.push(item.name);
    });
  } finally {
    hiddenAgain.forEach(sheet => sheet.hideSheet());
  }

  summary.rehidden = hiddenAgain.length;
  return summary;
}

function sheetOrderSummaryText_(summary) {
  const lines = [
    'Porządek w pliku:',
    'Arkusze skryptu: ' + summary.known + ' | arkusze własne: ' + summary.own + ' (kolory i widoczność bez zmian)',
    'Pokolorowane teraz: ' + (summary.recolored.length ? summary.recolored.join(', ') : 'żaden (już były)'),
    'Przesunięte teraz: ' + (summary.moved.length ? summary.moved.join(', ') : 'żaden (kolejność już poprawna)'),
    'Arkusz START odświeżony: ' + summary.startRows + ' wierszy.'
  ];
  if (!summary.recolored.length && !summary.moved.length) {
    lines.push('', 'Plik był już uporządkowany.');
  }
  lines.push('', 'Dane surowe i logi możesz schować: Dane → Ukryj arkusze techniczne.');
  return lines.join('\n');
}

/** Menu Dane → Uporządkuj arkusze. */
function uporzadkujArkuszeZMenu() {
  const summary = uporzadkujArkusze();
  SpreadsheetApp.getUi().alert(sheetOrderSummaryText_(summary));
  return summary;
}

/** Ukrywa albo pokazuje arkusze kategorii „dane”; zwraca listę nazw. */
function setTechnicalSheetsHidden_(hidden) {
  const ss = SpreadsheetApp.getActive();
  const touched = [];
  sheetCatalog_().forEach(entry => {
    if (entry.category !== 'dane') return;
    const sheet = ss.getSheetByName(entry.name);
    if (!sheet || sheet.isSheetHidden() === hidden) return;
    if (hidden) sheet.hideSheet(); else sheet.showSheet();
    touched.push(entry.name);
  });
  return touched;
}

/** Menu Dane → Ukryj arkusze techniczne. */
function ukryjArkuszeTechniczne() {
  const touched = setTechnicalSheetsHidden_(true);
  SpreadsheetApp.getUi().alert(touched.length
    ? 'Ukryte arkusze z danymi surowymi: ' + touched.join(', ') + '.\nPokażesz je z Dane → Pokaż arkusze techniczne.'
    : 'Wszystkie arkusze z danymi surowymi są już ukryte.');
  return touched;
}

/** Menu Dane → Pokaż arkusze techniczne. */
function pokazArkuszeTechniczne() {
  const touched = setTechnicalSheetsHidden_(false);
  SpreadsheetApp.getUi().alert(touched.length
    ? 'Widoczne arkusze z danymi surowymi: ' + touched.join(', ') + '.'
    : 'Żaden arkusz z danymi surowymi nie był ukryty.');
  return touched;
}
