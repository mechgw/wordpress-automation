const GA4_CONFIG_SHEET = 'Konfiguracja GA4';
const GA4_RAW_SHEET = 'GA4 RAW';
const GA4_EVENTS_SHEET = 'GA4 KEY EVENTS';
const GA4_ADS_SHEET = 'GA4 ADS RAW';
const GA4_BUSINESS_SHEET = 'GA4 BUSINESS EVENTS';
const GA4_TZ = 'Europe/Warsaw';


/** Dodaje menu GA4 / Ads. Wywołaj addGa4Menu_() wewnątrz istniejącego onOpen(). */
function addGa4Menu_() {
  SpreadsheetApp.getUi()
    .createMenu('GA4 / Ads')
    .addItem('Sprawdź połączenie GA4', 'testGA4')
    .addItem('Importuj ostatni zakres', 'importGA4OstatniZakres')
    .addItem('Importuj dzień', 'importGA4Dzienny')
    .addItem('Diagnozuj zdarzenia GA4', 'diagnozujZdarzeniaGA4')
    .addItem('Skonfiguruj główne key events', 'konfigurujGlowneKeyEventsGA4')
    .addSeparator()
    .addItem('Włącz codzienny import', 'ustawAutomatycznyImportGA4')
    .addToUi();
}

/**
 * Sprawdza dostęp do Google Analytics Admin API i Data API.
 * Wypisuje dostępne właściwości GA4 w Konfiguracja GA4!E:G.
 * Jeśli dostępna jest dokładnie jedna właściwość, automatycznie wpisuje jej ID do B2.
 */
function testGA4() {
  const ss = SpreadsheetApp.getActive();
  const cfgSheet = ss.getSheetByName(GA4_CONFIG_SHEET);
  if (!cfgSheet) throw new Error('Brak zakładki: ' + GA4_CONFIG_SHEET);

  const properties = listGa4Properties_();
  const enriched = properties.map(p => {
    const streams = listGa4WebStreams_(p.propertyId);
    return Object.assign({}, p, {
      streamUrls: streams.map(s => s.defaultUri).filter(Boolean),
      measurementIds: streams.map(s => s.measurementId).filter(Boolean)
    });
  });

  cfgSheet.getRange('E1:H120').clearContent();
  cfgSheet.getRange('E1:H1').setValues([[
    'Dostępne właściwości GA4', 'Property ID', 'Konto', 'URL strumienia'
  ]]);

  if (enriched.length) {
    cfgSheet.getRange(2, 5, enriched.length, 4).setValues(
      enriched.map(p => [
        p.propertyDisplayName,
        p.propertyId,
        p.accountDisplayName,
        p.streamUrls.join(' | ')
      ])
    );
  }

  let cfg = getGa4Config_();

  // Jeśli propertyId nie jest jeszcze wybrane, spróbuj jednoznacznie dopasować
  // produkcyjną właściwość po URL strumienia WWW. Domena pochodzi ze Script
  // Property SITE_DOMAIN albo z hosta WP_BASE_URL; bez niej pomijamy dopasowanie.
  const siteDomain = getSiteDomain_();
  const matchesSite = p => Boolean(siteDomain) &&
    p.streamUrls.some(url => hostnameMatchesDomain_(extractHostname_(url), siteDomain));

  if (!cfg.propertyId) {
    const matching = enriched.filter(matchesSite);

    if (matching.length === 1) {
      cfgSheet.getRange('B2').setValue(matching[0].propertyId);
      cfg = getGa4Config_();
    } else if (properties.length === 1) {
      cfgSheet.getRange('B2').setValue(properties[0].propertyId);
      cfg = getGa4Config_();
    }
  }

  if (!cfg.propertyId) {
    const siteMatches = enriched.filter(matchesSite);
    cfgSheet.getRange('B9').setValue(
      !properties.length
        ? 'BRAK DOSTĘPNYCH WŁAŚCIWOŚCI GA4'
        : siteMatches.length > 1
          ? 'KILKA WŁAŚCIWOŚCI MA STRUMIEŃ ' + siteDomain.toUpperCase() + ' – WYBIERZ PROPERTY ID Z LISTY E:H'
          : 'WYBIERZ PROPERTY ID Z LISTY E:H I WPISZ DO B2'
    );
    return;
  }

  // Minimalny raport potwierdzający dostęp do Data API.
  runGa4ReportPaged_(cfg.propertyId, {
    dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }]
  }, Math.min(cfg.rowLimit, 10000));

  const selected = enriched.find(p => p.propertyId === String(cfg.propertyId));
  const label = selected ? selected.propertyDisplayName : ('property ' + cfg.propertyId);
  const uri = selected && selected.streamUrls.length ? ' | ' + selected.streamUrls.join(' | ') : '';
  cfgSheet.getRange('B9').setValue('POŁĄCZENIE OK – ' + label + ' (' + cfg.propertyId + ')' + uri);
}

/**
 * Diagnostyka zdarzeń: pokazuje WSZYSTKIE eventy z ostatnich 30 dni,
 * także te, które nie są oznaczone jako key event. Wynik trafia do
 * Konfiguracja GA4!E20:H120.
 */
function diagnozujZdarzeniaGA4() {
  const cfg = requireGa4Config_();
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(GA4_CONFIG_SHEET);
  const end = addDays_(todayGa4_(), -cfg.dailyLagDays);
  const start = addDays_(end, -29);

  const rows = runGa4ReportPaged_(cfg.propertyId, {
    dateRanges: [{ startDate: formatDate_(start), endDate: formatDate_(end) }],
    dimensions: [{ name: 'eventName' }],
    metrics: [
      { name: 'eventCount' },
      { name: 'keyEvents' },
      { name: 'totalUsers' }
    ],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }]
  }, Math.min(cfg.rowLimit, 10000));

  sheet.getRange('E20:H120').clearContent();
  sheet.getRange('E20:H20').setValues([[
    'Zdarzenie (30d)', 'Event count', 'Key events', 'Użytkownicy'
  ]]);

  const values = rows.slice(0, 100).map(r => [
    dim_(r, 0),
    num_(metric_(r, 0)),
    num_(metric_(r, 1)),
    num_(metric_(r, 2))
  ]);

  if (values.length) {
    sheet.getRange(21, 5, values.length, 4).setValues(values);
  }

  sheet.getRange('B9').setValue(
    'DIAGNOSTYKA ZDARZEŃ OK – ' +
    Utilities.formatDate(new Date(), GA4_TZ, 'yyyy-MM-dd HH:mm') +
    ' | eventy: ' + rows.length
  );
}


/**
 * Ustawia właściwe key events dla serwisu:
 * - dodaje operational_order_submit i phone_click,
 * - usuwa mikrozdarzenia pricing_pdf_click, dedicated_calculator_use i regulamin_pdf_click.
 *
 * UWAGA: wymaga zakresu OAuth https://www.googleapis.com/auth/analytics.edit.
 * Nie dodaje b2b_lead_submit, dopóki strona nie zacznie wysyłać takiego eventu.
 */
function konfigurujGlowneKeyEventsGA4() {
  const cfg = requireGa4Config_();
  const propertyId = String(cfg.propertyId);
  const desired = ['operational_order_submit', 'phone_click'];
  const remove = ['pricing_pdf_click', 'dedicated_calculator_use', 'regulamin_pdf_click'];

  let existing = listGa4KeyEvents_(propertyId);
  const existingByEvent = {};
  existing.forEach(k => existingByEvent[k.eventName] = k);

  const added = [];
  desired.forEach(eventName => {
    if (!existingByEvent[eventName]) {
      const url = 'https://analyticsadmin.googleapis.com/v1beta/properties/' +
        encodeURIComponent(propertyId) + '/keyEvents';
      ga4ApiRequest_(url, 'post', { eventName: eventName });
      added.push(eventName);
    }
  });

  // Odśwież listę po dodaniu.
  existing = listGa4KeyEvents_(propertyId);
  const removed = [];
  existing.forEach(k => {
    if (remove.indexOf(k.eventName) !== -1 && k.deletable !== false && k.name) {
      const url = 'https://analyticsadmin.googleapis.com/v1beta/' +
        k.name.split('/').map(encodeURIComponent).join('/');
      ga4ApiRequest_(url, 'delete');
      removed.push(k.eventName);
    }
  });

  const finalEvents = listGa4KeyEvents_(propertyId).map(k => k.eventName).sort();
  const msg =
    'KEY EVENTS USTAWIONE – dodano: ' + (added.length ? added.join(', ') : 'brak') +
    ' | usunięto mikro: ' + (removed.length ? removed.join(', ') : 'brak') +
    ' | aktywne: ' + finalEvents.join(', ');

  SpreadsheetApp.getActive()
    .getSheetByName(GA4_CONFIG_SHEET)
    .getRange('B9')
    .setValue(msg);

  SpreadsheetApp.getUi().alert(
    'GA4 – key events',
    'Główne: operational_order_submit + phone_click.\n' +
    'Usunięte mikrozdarzenia: ' + (removed.length ? removed.join(', ') : 'brak do usunięcia') + '.\n\n' +
    'Uwaga: zmiana key events nie jest retroaktywna. Historyczne dane głównych akcji pobieramy osobno do GA4 BUSINESS EVENTS.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/** Lista key events skonfigurowanych w GA4. */
function listGa4KeyEvents_(propertyId) {
  const out = [];
  let pageToken = '';

  do {
    const url = 'https://analyticsadmin.googleapis.com/v1beta/properties/' +
      encodeURIComponent(String(propertyId)) + '/keyEvents?pageSize=200' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = ga4ApiRequest_(url, 'get');
    (response.keyEvents || []).forEach(k => out.push(k));
    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return out;
}

/** Lista strumieni WWW dla właściwości GA4. */
function listGa4WebStreams_(propertyId) {
  const out = [];
  let pageToken = '';

  do {
    const url = 'https://analyticsadmin.googleapis.com/v1beta/properties/' +
      encodeURIComponent(String(propertyId)) + '/dataStreams?pageSize=200' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = ga4ApiRequest_(url, 'get');

    (response.dataStreams || []).forEach(stream => {
      if (stream.type === 'WEB_DATA_STREAM' && stream.webStreamData) {
        out.push({
          displayName: stream.displayName || '',
          defaultUri: stream.webStreamData.defaultUri || '',
          measurementId: stream.webStreamData.measurementId || ''
        });
      }
    });

    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return out;
}

function extractHostname_(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '');
}

/**
 * Domena serwisu używana do dopasowania strumienia GA4.
 * Źródło: Script Property SITE_DOMAIN, a w razie jej braku host z WP_BASE_URL.
 * Zwraca '' gdy nic nie jest skonfigurowane.
 */
function getSiteDomain_() {
  const props = PropertiesService.getScriptProperties();
  const explicit = String(props.getProperty('SITE_DOMAIN') || '').trim();
  const source = explicit || props.getProperty('WP_BASE_URL') || '';
  return extractHostname_(source).toLowerCase();
}

/** Czy hostname to dokładnie domena albo jej subdomena. */
function hostnameMatchesDomain_(hostname, domain) {
  const h = String(hostname || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  return Boolean(d) && (h === d || h.endsWith('.' + d));
}

/** Pierwszy/ręczny import: domyślnie 90 dni z opóźnieniem z konfiguracji. */
function importGA4OstatniZakres() {
  return recordImportRun_('GA4', false, () => {
    const cfg = requireGa4Config_();
    const end = addDays_(todayGa4_(), -cfg.dailyLagDays);
    const start = addDays_(end, -(cfg.daysBack - 1));
    return importGa4Range_(start, end, cfg);
  });
}

/** Import jednego dnia; przeznaczony do triggera. */
function importGA4Dzienny() {
  return recordImportRun_('GA4', true, () => {
    const cfg = requireGa4Config_();
    const day = addDays_(todayGa4_(), -cfg.dailyLagDays);
    return importGa4Range_(day, day, cfg);
  });
}

/** Ustawia codzienny import GA4 około 06:00. */
function ustawAutomatycznyImportGA4() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'importGA4Dzienny')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('importGA4Dzienny')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  // Komórka B9 pokaże "trigger: TAK" i stan ostatniego importu.
  writeImportStatusCell_('GA4');
}

function importGa4Range_(startDate, endDate, cfg) {
  const start = formatDate_(startDate);
  const end = formatDate_(endDate);
  const importedAt = new Date();
  ensureGa4BusinessSheet_();

  // 1) Landing pages + kanały + bazowe konwersje.
  const landingResp = runGa4ReportPaged_(cfg.propertyId, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [
      { name: 'date' },
      { name: 'landingPagePlusQueryString' },
      { name: 'sessionDefaultChannelGroup' },
      { name: 'sessionSourceMedium' },
      { name: 'sessionCampaignName' },
      { name: 'deviceCategory' }
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'totalUsers' },
      { name: 'keyEvents' },
      { name: 'sessionKeyEventRate' }
    ]
  }, cfg.rowLimit);

  const landingRows = landingResp.map(r => [
    parseGa4Date_(dim_(r, 0)),
    cleanLanding_(dim_(r, 1)),
    dim_(r, 2),
    dim_(r, 3),
    dim_(r, 4),
    dim_(r, 5),
    num_(metric_(r, 0)),
    num_(metric_(r, 1)),
    num_(metric_(r, 2)),
    num_(metric_(r, 3)),
    num_(metric_(r, 4)),
    importedAt
  ]);

  // 2) Konkretne key events. Metric filter usuwa zwykłe eventy z keyEvents=0.
  const eventResp = runGa4ReportPaged_(cfg.propertyId, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [
      { name: 'date' },
      { name: 'eventName' },
      { name: 'sessionDefaultChannelGroup' },
      { name: 'sessionSourceMedium' }
    ],
    metrics: [
      { name: 'keyEvents' },
      { name: 'totalUsers' }
    ],
    metricFilter: {
      filter: {
        fieldName: 'keyEvents',
        numericFilter: {
          operation: 'GREATER_THAN',
          value: { doubleValue: 0 }
        }
      }
    }
  }, cfg.rowLimit);

  const eventRows = eventResp.map(r => [
    parseGa4Date_(dim_(r, 0)),
    dim_(r, 1),
    dim_(r, 2),
    dim_(r, 3),
    num_(metric_(r, 0)),
    num_(metric_(r, 1)),
    importedAt
  ]);

  // 3) Główne zdarzenia biznesowe — zwykły eventCount, niezależnie od statusu key event.
  // Dzięki temu zachowujemy historię sprzed momentu oznaczenia zdarzeń jako key events.
  let businessResp;
  let businessDetailed = true;
  try {
    businessResp = runGa4ReportPaged_(cfg.propertyId, {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [
        { name: 'date' },
        { name: 'eventName' },
        { name: 'landingPagePlusQueryString' },
        { name: 'sessionDefaultChannelGroup' },
        { name: 'sessionSourceMedium' }
      ],
      metrics: [
        { name: 'eventCount' },
        { name: 'totalUsers' }
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: {
            values: ['operational_order_submit', 'phone_click', 'b2b_lead_submit'],
            caseSensitive: true
          }
        }
      }
    }, cfg.rowLimit);
  } catch (e) {
    // Awaryjnie bez landing page, jeśli kombinacja wymiarów okaże się niekompatybilna.
    businessDetailed = false;
    businessResp = runGa4ReportPaged_(cfg.propertyId, {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [
        { name: 'date' },
        { name: 'eventName' },
        { name: 'sessionDefaultChannelGroup' },
        { name: 'sessionSourceMedium' }
      ],
      metrics: [
        { name: 'eventCount' },
        { name: 'totalUsers' }
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: {
            values: ['operational_order_submit', 'phone_click', 'b2b_lead_submit'],
            caseSensitive: true
          }
        }
      }
    }, cfg.rowLimit);
  }

  const businessRows = businessResp.map(r => businessDetailed ? [
    parseGa4Date_(dim_(r, 0)),
    dim_(r, 1),
    cleanLanding_(dim_(r, 2)),
    dim_(r, 3),
    dim_(r, 4),
    num_(metric_(r, 0)),
    num_(metric_(r, 1)),
    importedAt
  ] : [
    parseGa4Date_(dim_(r, 0)),
    dim_(r, 1),
    '',
    dim_(r, 2),
    dim_(r, 3),
    num_(metric_(r, 0)),
    num_(metric_(r, 1)),
    importedAt
  ]);

  // 4) Google Ads — dane sesyjne do analizy landingów, słów i zapytań.
  // UWAGA: celowo NIE łączymy tutaj wymiarów sesyjnych/landing page z metrykami
  // advertiserAdCost / advertiserAdClicks / advertiserAdImpressions. GA4 Data API
  // nie pozwala na część takich kombinacji. Kolumny kosztowe I:K i M w arkuszu
  // pozostają zarezerwowane dla późniejszej integracji z Google Ads API.
  let adsRows = [];
  let adsWarning = '';

  try {
    const adsResp = runGa4ReportPaged_(cfg.propertyId, {
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [
        { name: 'date' },
        { name: 'landingPagePlusQueryString' },
        { name: 'sessionGoogleAdsCampaignName' },
        { name: 'sessionGoogleAdsAdGroupName' },
        { name: 'sessionGoogleAdsKeyword' },
        { name: 'sessionGoogleAdsQuery' },
        { name: 'deviceCategory' }
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'keyEvents' },
        { name: 'sessionKeyEventRate' }
      ],
      dimensionFilter: {
        notExpression: {
          filter: {
            fieldName: 'sessionGoogleAdsCampaignName',
            stringFilter: {
              matchType: 'EXACT',
              value: '(not set)',
              caseSensitive: false
            }
          }
        }
      }
    }, cfg.rowLimit);

    // Zachowujemy 14-kolumnowy schemat arkusza GA4 ADS RAW.
    // I, J, K i M są puste do czasu podpięcia kosztów z Google Ads API.
    adsRows = adsResp.map(r => [
      parseGa4Date_(dim_(r, 0)),
      cleanLanding_(dim_(r, 1)),
      dim_(r, 2),
      dim_(r, 3),
      dim_(r, 4),
      dim_(r, 5),
      dim_(r, 6),
      num_(metric_(r, 0)),
      '',
      '',
      '',
      num_(metric_(r, 1)),
      '',
      importedAt
    ]);
  } catch (e) {
    // Część Ads nie może blokować zbierania baseline'u organicznego.
    adsWarning = String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 220);
  }

  replaceGa4Range_(cfg.landingSheet, 12, startDate, endDate, landingRows, {
    dateColumn: 1,
    percentColumns: [11],
    timestampColumn: 12
  });

  replaceGa4Range_(cfg.eventsSheet, 7, startDate, endDate, eventRows, {
    dateColumn: 1,
    timestampColumn: 7
  });

  replaceGa4Range_(cfg.businessEventsSheet, 8, startDate, endDate, businessRows, {
    dateColumn: 1,
    timestampColumn: 8
  });

  replaceGa4Range_(cfg.adsSheet, 14, startDate, endDate, adsRows, {
    dateColumn: 1,
    currencyColumns: [11, 13],
    timestampColumn: 14
  });

  // Status komórki B9 zapisuje recordImportRun_() na podstawie tego wyniku.
  return {
    rows: landingRows.length + eventRows.length + businessRows.length + adsRows.length,
    detail: 'landing: ' + landingRows.length +
      ' | key events: ' + eventRows.length +
      ' | business: ' + businessRows.length +
      ' | ads: ' + adsRows.length,
    warning: adsWarning ? 'ADS: ' + adsWarning : ''
  };
}


/**
 * Zapewnia istnienie arkusza historycznych zdarzeń biznesowych i KPI na dashboardzie.
 * Dzięki temu v5 działa także bez ręcznego tworzenia nowej zakładki.
 */
function ensureGa4BusinessSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(GA4_BUSINESS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(GA4_BUSINESS_SHEET);
    sheet.getRange('A1:H1').setValues([[
      'Data', 'Zdarzenie', 'Landing page', 'Kanał sesji',
      'Źródło / medium', 'Event count', 'Użytkownicy', 'Pobrano'
    ]]);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:H1').setFontWeight('bold').setBackground('#e4e8ea');
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    sheet.getRange('H:H').setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.setColumnWidth(1, 95);
    sheet.setColumnWidth(2, 210);
    sheet.setColumnWidth(3, 260);
    sheet.setColumnWidth(4, 140);
    sheet.setColumnWidth(5, 180);
    sheet.setColumnWidth(6, 95);
    sheet.setColumnWidth(7, 95);
    sheet.setColumnWidth(8, 145);
  }

  // Dopisz parametr konfiguracyjny, jeżeli go nie ma.
  const cfg = ss.getSheetByName(GA4_CONFIG_SHEET);
  if (cfg && !cfg.getRange('A11').getValue()) {
    cfg.getRange('A11:C11').setValues([[
      'businessEventsSheet',
      GA4_BUSINESS_SHEET,
      'Historyczne główne zdarzenia biznesowe oparte na eventCount, niezależnie od statusu key event.'
    ]]);
  }

  // KPI na dashboardzie — tylko jeśli wiersz 8 jest pusty.
  const dash = ss.getSheetByName('Analityka marketingowa');
  if (dash && dash.getRange('A8:H8').isBlank()) {
    dash.getRange('A8:H8').setValues([[
      'Zamów online 30d',
      '=IF($E$2="";"";SUMIFS(\'GA4 BUSINESS EVENTS\'!F2:F100000;\'GA4 BUSINESS EVENTS\'!A2:A100000;">="&($E$2-29);\'GA4 BUSINESS EVENTS\'!A2:A100000;"<="&$E$2;\'GA4 BUSINESS EVENTS\'!B2:B100000;"operational_order_submit"))',
      'Telefon 30d',
      '=IF($E$2="";"";SUMIFS(\'GA4 BUSINESS EVENTS\'!F2:F100000;\'GA4 BUSINESS EVENTS\'!A2:A100000;">="&($E$2-29);\'GA4 BUSINESS EVENTS\'!A2:A100000;"<="&$E$2;\'GA4 BUSINESS EVENTS\'!B2:B100000;"phone_click"))',
      'Główne akcje 30d',
      '=IF(OR(B8="";D8="");"";B8+D8)',
      'B2B lead 30d',
      '=IF($E$2="";"";SUMIFS(\'GA4 BUSINESS EVENTS\'!F2:F100000;\'GA4 BUSINESS EVENTS\'!A2:A100000;">="&($E$2-29);\'GA4 BUSINESS EVENTS\'!A2:A100000;"<="&$E$2;\'GA4 BUSINESS EVENTS\'!B2:B100000;"b2b_lead_submit"))'
    ]]);
    dash.getRange('A8:H8').setFontWeight('bold').setBackground('#f4f4f4');
  }
}

/** Pobiera wszystkie strony raportu Data API. */
function runGa4ReportPaged_(propertyId, baseRequest, configuredLimit) {
  const limit = Math.min(Number(configuredLimit) || 100000, 250000);
  const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' +
    encodeURIComponent(String(propertyId)) + ':runReport';

  let offset = 0;
  let allRows = [];

  while (true) {
    const request = Object.assign({}, baseRequest, { limit: limit, offset: offset });
    const response = ga4ApiRequest_(url, 'post', request);
    const rows = response.rows || [];
    allRows = allRows.concat(rows);

    const rowCount = Number(response.rowCount || 0);
    if (!rows.length || allRows.length >= rowCount) break;
    offset += rows.length;
  }

  return allRows;
}

/** Lista właściwości GA4 dostępnych dla zalogowanego użytkownika. */
function listGa4Properties_() {
  const out = [];
  let pageToken = '';

  do {
    const url = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const response = ga4ApiRequest_(url, 'get');

    (response.accountSummaries || []).forEach(account => {
      (account.propertySummaries || []).forEach(property => {
        out.push({
          accountDisplayName: account.displayName || account.account || '',
          propertyDisplayName: property.displayName || property.property || '',
          propertyId: String(property.property || '').replace('properties/', '')
        });
      });
    });

    pageToken = response.nextPageToken || '';
  } while (pageToken);

  return out;
}

function ga4ApiRequest_(url, method, payload) {
  const options = {
    method: method || 'get',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken()
    },
    muteHttpExceptions: true
  };

  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  const text = res.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('Google Analytics API HTTP ' + code + ':\n' + text);
  }

  return text ? JSON.parse(text) : {};
}

function getGa4Config_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(GA4_CONFIG_SHEET);
  if (!sheet) throw new Error('Brak zakładki: ' + GA4_CONFIG_SHEET);

  const values = sheet.getRange('A2:B11').getValues();
  const map = {};
  values.forEach(r => {
    if (r[0]) map[String(r[0])] = r[1];
  });

  return {
    propertyId: map.propertyId ? String(map.propertyId).replace('properties/', '') : '',
    daysBack: Number(map.daysBack || 90),
    dailyLagDays: Number(map.dailyLagDays || 2),
    rowLimit: Number(map.rowLimit || 100000),
    landingSheet: String(map.landingSheet || GA4_RAW_SHEET),
    eventsSheet: String(map.eventsSheet || GA4_EVENTS_SHEET),
    adsSheet: String(map.adsSheet || GA4_ADS_SHEET),
    businessEventsSheet: String(map.businessEventsSheet || GA4_BUSINESS_SHEET),
    timezone: String(map.timezone || GA4_TZ)
  };
}

function requireGa4Config_() {
  const cfg = getGa4Config_();
  if (!cfg.propertyId) {
    throw new Error('Brak propertyId w Konfiguracja GA4!B2. Najpierw uruchom testGA4().');
  }
  return cfg;
}

/**
 * Zastępuje tylko importowany zakres dat. Dzięki temu ponowny import nie tworzy duplikatów.
 */
function replaceGa4Range_(sheetName, columnCount, startDate, endDate, newRows, formatOptions) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Brak zakładki: ' + sheetName);

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, columnCount).getValues()
    : [];

  const startKey = dateKey_(startDate);
  const endKey = dateKey_(endDate);

  const kept = existing.filter(row => {
    if (!row[0]) return false;
    const key = dateKey_(row[0]);
    return key < startKey || key > endKey;
  });

  const combined = kept.concat(newRows);
  const neededLastRow = combined.length + 1;
  if (sheet.getMaxRows() < neededLastRow) {
    sheet.insertRowsAfter(sheet.getMaxRows(), neededLastRow - sheet.getMaxRows());
  }

  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, columnCount).clearContent();
  }

  if (combined.length) {
    sheet.getRange(2, 1, combined.length, columnCount).setValues(combined);
  }

  const n = Math.max(combined.length, 1);
  if (formatOptions && formatOptions.dateColumn) {
    sheet.getRange(2, formatOptions.dateColumn, n, 1).setNumberFormat('yyyy-mm-dd');
  }
  (formatOptions && formatOptions.percentColumns || []).forEach(col => {
    sheet.getRange(2, col, n, 1).setNumberFormat('0.0%');
  });
  (formatOptions && formatOptions.currencyColumns || []).forEach(col => {
    sheet.getRange(2, col, n, 1).setNumberFormat('#,##0.00 "zł"');
  });
  if (formatOptions && formatOptions.timestampColumn) {
    sheet.getRange(2, formatOptions.timestampColumn, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
}

/** Usuwa query string z landing page, żeby parametry UTM/hsa/ved nie rozbijały jednego URL na wiele wierszy. */
function cleanLanding_(value) {
  const s = String(value || '');
  if (!s || s === '(not set)') return s;
  return s.split('?')[0] || '/';
}

function dim_(row, index) {
  return row.dimensionValues && row.dimensionValues[index]
    ? row.dimensionValues[index].value || ''
    : '';
}

function metric_(row, index) {
  return row.metricValues && row.metricValues[index]
    ? row.metricValues[index].value || '0'
    : '0';
}

function num_(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseGa4Date_(value) {
  const s = String(value || '');
  if (!/^\d{8}$/.test(s)) return '';
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

function todayGa4_() {
  const s = Utilities.formatDate(new Date(), GA4_TZ, 'yyyy-MM-dd');
  const p = s.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

function addDays_(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate_(date) {
  return Utilities.formatDate(date, GA4_TZ, 'yyyy-MM-dd');
}

function dateKey_(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, GA4_TZ, 'yyyy-MM-dd');
  }
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return '';
}
