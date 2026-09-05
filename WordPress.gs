// WordPress Bridge — Rank Math SEO + Media + page layout copy
// Wersja: patrz GitHub Releases; kod nie przechowuje numeru wersji.
//
// Dedykowane endpointy (seo-meta, page-layout) udostępnia snippet po stronie
// WordPressa pod namespace z Script Property WP_REST_NAMESPACE,
// np. /wp-json/<WP_REST_NAMESPACE>/v1/seo-meta.
const WP_COMMANDS_SHEET = 'WP COMMANDS';
const WP_RESULTS_SHEET = 'WP RESULTS';
const WP_SNAPSHOTS_SHEET = 'WP SNAPSHOTS';

/** Dodaje menu WordPress. Wywołaj addWpMenu_() z jednego, wspólnego onOpen() projektu. */
function addWpMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('WordPress')
    .addItem('Test połączenia', 'testWpConnection')
    .addItem('Test Rank Math bridge', 'testRankMathBridge')
    .addItem('Test biblioteki mediów', 'testWpMediaAccess')
    .addItem('Wykonaj polecenia', 'processWpCommands')
    .addToUi();
}

function getWpConfig_() {
  const props = PropertiesService.getScriptProperties();

  const config = {
    baseUrl: (props.getProperty('WP_BASE_URL') || '').replace(/\/+$/, ''),
    username: props.getProperty('WP_USERNAME') || '',
    appPassword: props.getProperty('WP_APP_PASSWORD') || '',
    allowWrites: props.getProperty('WP_ALLOW_WRITES') === 'TRUE',
    // Namespace dedykowanych endpointów snippetu WordPress (bez ukośników),
    // np. "mojafirma" dla /wp-json/mojafirma/v1/...
    restNamespace: String(props.getProperty('WP_REST_NAMESPACE') || '').trim().replace(/^\/+|\/+$/g, '')
  };

  if (!config.baseUrl) throw new Error('Brak Script Property: WP_BASE_URL');
  if (!config.username) throw new Error('Brak Script Property: WP_USERNAME');
  if (!config.appPassword) throw new Error('Brak Script Property: WP_APP_PASSWORD');
  if (config.restNamespace && !/^[a-z0-9_-]+$/i.test(config.restNamespace)) {
    throw new Error(
      'Nieprawidłowa Script Property WP_REST_NAMESPACE: "' + config.restNamespace +
      '". Dozwolone są tylko litery, cyfry, "-" i "_" (bez ukośników i wersji), np. "acme".'
    );
  }

  return config;
}

/**
 * Ścieżka dedykowanego endpointu REST bridge, np. wpBridgePath_('seo-meta')
 * → /wp-json/<WP_REST_NAMESPACE>/v1/seo-meta.
 */
function wpBridgePath_(endpoint) {
  const ns = getWpConfig_().restNamespace;
  if (!ns) throw new Error('Brak Script Property: WP_REST_NAMESPACE');
  return '/wp-json/' + ns + '/v1/' + String(endpoint || '').replace(/^\/+/, '');
}

function getWpHeaders_(config) {
  const auth = Utilities.base64Encode(config.username + ':' + config.appPassword);

  return {
    Authorization: 'Basic ' + auth,
    Accept: 'application/json'
  };
}

function wpFetch_(path, options = {}) {
  const config = getWpConfig_();

  const params = {
    method: options.method || 'get',
    headers: getWpHeaders_(config),
    muteHttpExceptions: true,
    followRedirects: true
  };

  if (options.payload !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(options.payload);
  }

  const response = UrlFetchApp.fetch(config.baseUrl + path, params);
  const code = response.getResponseCode();
  const text = response.getContentText();

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // odpowiedź nie była JSON
  }

  return {
    code,
    text,
    json,
    headers: response.getAllHeaders()
  };
}

function testWpConnection() {
  const response = wpFetch_('/wp-json/wp/v2/users/me?context=edit');

  if (response.code >= 200 && response.code < 300) {
    const user = response.json || {};

    SpreadsheetApp.getUi().alert(
      'WordPress REST API działa.\n\n' +
      'Użytkownik: ' + (user.name || user.slug || 'OK') +
      '\nHTTP: ' + response.code
    );
    return;
  }

  throw new Error(
    'WordPress zwrócił HTTP ' + response.code + '\n\n' + response.text.slice(0, 1000)
  );
}

function testRankMathBridge() {
  const response = wpFetch_(
    '/wp-json/wp/v2/pages?context=edit&per_page=1&_fields=id,slug,cc_rank_math'
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const pages = Array.isArray(response.json) ? response.json : [];
  if (pages.length === 0) {
    throw new Error('WordPress nie zwrócił żadnej strony do testu Rank Math.');
  }

  const page = pages[0];
  if (!Object.prototype.hasOwnProperty.call(page, 'cc_rank_math')) {
    throw new Error(
      'Brak pola cc_rank_math w REST API. Włącz snippet „Rank Math REST bridge” po stronie WordPressa.'
    );
  }

  const seoMetaPath = wpBridgePath_('seo-meta');
  const endpoint = wpFetch_(seoMetaPath);
  if (endpoint.code < 200 || endpoint.code >= 300) {
    throw new Error(
      'Odczyt Rank Math działa, ale dedykowany endpoint zapisu (' + seoMetaPath +
      ') nie odpowiada. HTTP ' + endpoint.code + '\n\n' + endpoint.text.slice(0, 1000)
    );
  }

  SpreadsheetApp.getUi().alert(
    'Rank Math bridge działa.\n\n' +
    'Strona testowa: ' + (page.slug || page.id) +
    '\nOdczyt surowego SEO title/meta: OK' +
    '\nDedykowany endpoint zapisu: OK'
  );
}


function testWpMediaAccess() {
  const response = wpFetch_(
    '/wp-json/wp/v2/media?context=edit&per_page=1&_fields=id,slug,source_url,alt_text,mime_type'
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const media = Array.isArray(response.json) ? response.json : [];
  const sample = media.length ? media[0] : null;

  SpreadsheetApp.getUi().alert(
    'Biblioteka mediów WordPress jest dostępna w trybie odczytu.\n\n' +
    'HTTP: ' + response.code +
    (sample ? '\nPrzykładowe media ID: ' + sample.id + '\nPlik: ' + getMediaFilename_(sample) : '\nBiblioteka nie zwróciła żadnego elementu.')
  );
}

function processWpCommands() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(WP_COMMANDS_SHEET);

  if (!sheet) throw new Error('Brak arkusza ' + WP_COMMANDS_SHEET);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const rows = sheet.getRange(2, 1, lastRow - 1, 13).getValues();

  rows.forEach((row, index) => {
    const sheetRow = index + 2;

    const command = {
      id: String(row[0] || '').trim(),
      createdAt: row[1],
      action: String(row[2] || '').trim(),
      target: String(row[3] || '').trim(),
      field: String(row[4] || '').trim(),
      value: row[5],
      confirm: String(row[6] || '').trim().toUpperCase(),
      status: String(row[7] || '').trim()
    };

    if (command.status !== 'PENDING') return;

    processOneWpCommand_(sheet, sheetRow, command);
  });
}

function processOneWpCommand_(sheet, rowNumber, command) {
  sheet.getRange(rowNumber, 8).setValue('RUNNING');
  SpreadsheetApp.flush();

  try {
    let result;

    switch (command.action) {
      case 'GET_PAGE_BY_SLUG':
        result = getPageBySlug_(command.target, command.id);
        break;

      case 'GET_PAGE_BY_ID':
        result = getPageById_(command.target, command.id);
        break;

      case 'GET_ALL_PAGES':
        result = getAllPages_(command.id);
        break;

      case 'GET_RANK_MATH_META':
        result = getRankMathMetaById_(command.target, command.id);
        break;

      case 'GET_MEDIA_BY_ID':
        result = getMediaById_(command.target, command.id);
        break;

      case 'SEARCH_MEDIA':
        result = searchMedia_(command.target, command.id);
        break;

      case 'CREATE_PAGE_DRAFT':
        result = createPageDraft_(command);
        break;

      case 'PUBLISH_PAGE':
        result = publishPage_(command);
        break;

      case 'UPDATE_MEDIA_FIELD':
        result = updateMediaField_(command);
        break;

      case 'UPDATE_RANK_MATH_FIELD':
        result = updateRankMathField_(command);
        break;

      case 'UPDATE_PAGE_FIELD':
        result = updatePageField_(command);
        break;

      case 'REPLACE_PAGE_CONTENT_TEXT':
        result = replacePageContentText_(command);
        break;

      case 'GET_PAGE_LAYOUT':
        result = getPageLayout_(command.target, command.id);
        break;

      case 'COPY_PAGE_LAYOUT':
        result = copyPageLayout_(command);
        break;

      case 'RESTORE_SNAPSHOT':
        result = restoreSnapshot_(command);
        break;

      default:
        throw new Error('Nieobsługiwana akcja: ' + command.action);
    }

    sheet.getRange(rowNumber, 8).setValue('DONE');
    sheet.getRange(rowNumber, 9).setValue(result.httpCode || '');
    sheet.getRange(rowNumber, 10).setValue(result.message || '');
    sheet.getRange(rowNumber, 11).setValue(result.resultRef || '');
    sheet.getRange(rowNumber, 12).setValue(new Date());
  } catch (error) {
    sheet.getRange(rowNumber, 8).setValue('ERROR');

    if (error.httpCode) {
      sheet.getRange(rowNumber, 9).setValue(error.httpCode);
    }

    sheet
      .getRange(rowNumber, 10)
      .setValue(String(error.message || error).slice(0, 5000));

    sheet.getRange(rowNumber, 12).setValue(new Date());
  }
}

function getPageBySlug_(slug, commandId) {
  if (!slug) throw new Error('Brak sluga strony.');

  const path =
    '/wp-json/wp/v2/pages' +
    '?slug=' + encodeURIComponent(slug) +
    '&context=edit' +
    '&_fields=id,slug,status,link,title,excerpt,modified,content,cc_rank_math';

  const response = wpFetch_(path);

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const pages = response.json;

  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('Nie znaleziono strony o slug: ' + slug);
  }

  if (pages.length > 1) {
    throw new Error('WordPress zwrócił więcej niż jedną stronę dla slug: ' + slug);
  }

  return savePageResult_(pages[0], commandId);
}

function getPageById_(id, commandId) {
  if (!id || !/^\d+$/.test(String(id))) {
    throw new Error('GET_PAGE_BY_ID wymaga numerycznego ID WordPressa.');
  }

  const page = getPageRawById_(id);
  return savePageResult_(page, commandId);
}

function getPageRawById_(id, requireRankMath = false) {
  const path =
    '/wp-json/wp/v2/pages/' + encodeURIComponent(id) +
    '?context=edit' +
    '&_fields=id,slug,status,link,title,excerpt,modified,content,cc_rank_math';

  const response = wpFetch_(path);

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const page = response.json || {};

  if (
    requireRankMath &&
    !Object.prototype.hasOwnProperty.call(page, 'cc_rank_math')
  ) {
    throw new Error(
      'Brak pola cc_rank_math w REST API. Włącz snippet „Rank Math REST read” po stronie WordPressa.'
    );
  }

  return page;
}

function getRankMathMetaById_(id, commandId) {
  if (!id || !/^\d+$/.test(String(id))) {
    throw new Error('GET_RANK_MATH_META wymaga numerycznego ID WordPressa.');
  }

  const page = getPageRawById_(id, true);
  const saved = savePageResult_(page, commandId);
  saved.message =
    'Pobrano stronę WordPress ID ' + page.id +
    ' wraz z surowymi polami Rank Math.';
  return saved;
}

function getAllPages_(commandId) {
  const statuses = ['publish', 'draft', 'pending', 'private', 'future'];
  const seenIds = new Set();
  let count = 0;
  let firstResultRow = null;
  let lastResultRow = null;

  statuses.forEach(status => {
    let pageNo = 1;

    while (true) {
      const path =
        '/wp-json/wp/v2/pages' +
        '?context=edit' +
        '&status=' + encodeURIComponent(status) +
        '&per_page=100' +
        '&page=' + pageNo +
        '&orderby=id' +
        '&order=asc' +
        '&_fields=id,slug,status,link,title,excerpt,modified,content,cc_rank_math';

      const response = wpFetch_(path);

      if (response.code < 200 || response.code >= 300) {
        throw wpError_(response.code, response.text);
      }

      const pages = Array.isArray(response.json) ? response.json : [];

      pages.forEach(page => {
        if (seenIds.has(page.id)) return;
        seenIds.add(page.id);

        const saved = savePageResult_(page, commandId);
        count++;

        const rowNumber = extractResultRow_(saved.resultRef);
        if (rowNumber) {
          if (!firstResultRow) firstResultRow = rowNumber;
          lastResultRow = rowNumber;
        }
      });

      const headers = response.headers || {};
      const totalPages = Number(
        headers['X-WP-TotalPages'] ||
        headers['x-wp-totalpages'] ||
        headers['X-Wp-Totalpages'] ||
        1
      );

      if (pageNo >= totalPages || pages.length === 0) break;
      pageNo++;
    }
  });

  return {
    httpCode: 200,
    message: 'Pobrano wszystkie dostępne strony WordPress: ' + count,
    resultRef:
      firstResultRow && lastResultRow
        ? 'WP RESULTS!A' + firstResultRow + ':M' + lastResultRow
        : ''
  };
}


function getMediaFields_() {
  return 'id,slug,status,link,title,modified,source_url,alt_text,caption,description,mime_type,media_details';
}

function getMediaById_(id, commandId) {
  if (!id || !/^\d+$/.test(String(id))) {
    throw new Error('GET_MEDIA_BY_ID wymaga numerycznego ID mediów WordPressa.');
  }

  const path =
    '/wp-json/wp/v2/media/' + encodeURIComponent(id) +
    '?context=edit&_fields=' + getMediaFields_();

  const response = wpFetch_(path);

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return saveMediaResult_(response.json || {}, commandId);
}

function searchMedia_(query, commandId) {
  query = String(query || '').trim();
  if (!query) throw new Error('SEARCH_MEDIA wymaga tekstu wyszukiwania w kolumnie target.');

  const path =
    '/wp-json/wp/v2/media' +
    '?context=edit' +
    '&search=' + encodeURIComponent(query) +
    '&per_page=100' +
    '&orderby=relevance' +
    '&order=desc' +
    '&_fields=' + getMediaFields_();

  const response = wpFetch_(path);

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const media = Array.isArray(response.json) ? response.json : [];
  if (media.length === 0) {
    return {
      httpCode: 200,
      message: 'Brak mediów pasujących do: ' + query,
      resultRef: ''
    };
  }

  let firstResultRow = null;
  let lastResultRow = null;

  media.forEach(item => {
    const saved = saveMediaResult_(item, commandId);
    const rowNumber = extractResultRow_(saved.resultRef);
    if (rowNumber) {
      if (!firstResultRow) firstResultRow = rowNumber;
      lastResultRow = rowNumber;
    }
  });

  return {
    httpCode: 200,
    message: 'Znaleziono media dla „' + query + '”: ' + media.length,
    resultRef:
      firstResultRow && lastResultRow
        ? 'WP RESULTS!A' + firstResultRow + ':M' + lastResultRow
        : ''
  };
}


function getMediaRawById_(id) {
  if (!id || !/^\d+$/.test(String(id))) {
    throw new Error('Media ID musi być numeryczne.');
  }

  const path =
    '/wp-json/wp/v2/media/' + encodeURIComponent(id) +
    '?context=edit&_fields=' + getMediaFields_();

  const response = wpFetch_(path);

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return response.json || {};
}

function getMediaState_(media) {
  return {
    id: Number(media.id || 0),
    slug: String(media.slug || ''),
    title: getRawValue_(media.title),
    alt_text: String(media.alt_text || ''),
    caption: getRawValue_(media.caption),
    description: getRawValue_(media.description),
    source_url: String(media.source_url || ''),
    modified: media.modified || ''
  };
}

function writeMediaField_(mediaId, field, value) {
  const allowedFields = ['title', 'alt_text', 'caption', 'description'];
  if (!allowedFields.includes(field)) {
    throw new Error('Niedozwolone pole mediów: ' + field);
  }

  const payload = {};
  payload[field] = value === null || value === undefined ? '' : String(value);

  const response = wpFetch_(
    '/wp-json/wp/v2/media/' + encodeURIComponent(mediaId),
    {
      method: 'post',
      payload
    }
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return response;
}

function updateMediaField_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(command.target)) {
    throw new Error('UPDATE_MEDIA_FIELD wymaga numerycznego ID mediów WordPress.');
  }

  const allowedFields = ['title', 'alt_text', 'caption', 'description'];
  if (!allowedFields.includes(command.field)) {
    throw new Error(
      'Niedozwolone pole mediów: ' + command.field +
      '. Dozwolone: ' + allowedFields.join(', ')
    );
  }

  // 1. Pobierz aktualny stan bezpośrednio przed zapisem.
  const before = getMediaRawById_(command.target);

  // 2. Zapisz pełny snapshot metadanych mediów.
  const snapshot = saveMediaSnapshot_(before, command.id);

  // 3. Zapisz wyłącznie jedno whitelisted pole.
  const expected = command.value === null || command.value === undefined
    ? ''
    : String(command.value);

  const response = writeMediaField_(
    Number(command.target),
    command.field,
    expected
  );

  // 4. Odczyt kontrolny i porównanie dokładnej wartości RAW.
  const after = getMediaRawById_(command.target);
  const afterState = getMediaState_(after);
  const actual = String(afterState[command.field] || '');

  if (actual !== expected) {
    throw new Error(
      'WordPress odpowiedział poprawnie, ale odczyt kontrolny mediów nie zgadza się z zapisem. ' +
      'Pole: ' + command.field
    );
  }

  const saved = saveMediaResult_(after, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Zaktualizowano ' + command.field +
    ' mediów ID ' + command.target +
    '. Snapshot przed zmianą: ' + snapshot.snapshotId;

  return saved;
}

function ensureSnapshotMediaColumns_() {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(WP_SNAPSHOTS_SHEET);
  if (!sheet) throw new Error('Brak arkusza ' + WP_SNAPSHOTS_SHEET);

  if (sheet.getMaxColumns() < 15) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 15 - sheet.getMaxColumns());
  }

  if (!sheet.getRange(1, 14).getValue()) {
    sheet.getRange(1, 14).setValue('snapshot_kind');
  }
  if (!sheet.getRange(1, 15).getValue()) {
    sheet.getRange(1, 15).setValue('media_before_json');
  }
}

function saveMediaSnapshot_(media, commandId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(WP_SNAPSHOTS_SHEET);

  if (!sheet) throw new Error('Brak arkusza ' + WP_SNAPSHOTS_SHEET);
  ensureSnapshotMediaColumns_();

  const state = getMediaState_(media);
  const snapshotId =
    'WP-SM-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + state.id +
    '-' + Utilities.getUuid().slice(0, 8);

  sheet.appendRow([
    snapshotId,
    commandId || '',
    state.id || '',
    state.slug || '',
    state.title || '',
    '',
    '',
    'MEDIA',
    state.modified || '',
    new Date(),
    '',
    '',
    '',
    'MEDIA',
    JSON.stringify(state)
  ]);

  return {
    snapshotId,
    row: sheet.getLastRow()
  };
}

function saveMediaResult_(media, commandId) {
  const ss = SpreadsheetApp.getActive();
  const results = ss.getSheetByName(WP_RESULTS_SHEET);

  if (!results) throw new Error('Brak arkusza ' + WP_RESULTS_SHEET);

  const resultId =
    'WP-M-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8);

  const details = media.media_details && typeof media.media_details === 'object'
    ? media.media_details
    : {};

  const mediaInfo = {
    kind: 'MEDIA',
    filename: getMediaFilename_(media),
    alt_text: String(media.alt_text || ''),
    caption: getRawValue_(media.caption),
    description: getRawValue_(media.description),
    mime_type: String(media.mime_type || ''),
    width: details.width || '',
    height: details.height || ''
  };

  results.appendRow([
    resultId,
    commandId || '',
    media.id || '',
    media.slug || '',
    media.status || '',
    media.source_url || media.link || '',
    getRawValue_(media.title),
    media.modified || '',
    JSON.stringify(mediaInfo),
    new Date(),
    '',
    '',
    'MEDIA'
  ]);

  const resultRow = results.getLastRow();

  return {
    httpCode: 200,
    message: 'Pobrano media WordPress ID ' + media.id + ' (' + getMediaFilename_(media) + ')',
    resultRef: 'WP RESULTS!A' + resultRow + ':M' + resultRow
  };
}

function getMediaFilename_(media) {
  const sourceUrl = String((media && media.source_url) || '');
  if (!sourceUrl) return '';

  const clean = sourceUrl.split('?')[0].split('#')[0];
  const parts = clean.split('/');
  return decodeURIComponent(parts[parts.length - 1] || '');
}

function savePageResult_(page, commandId) {
  const ss = SpreadsheetApp.getActive();
  const results = ss.getSheetByName(WP_RESULTS_SHEET);

  if (!results) throw new Error('Brak arkusza ' + WP_RESULTS_SHEET);

  const resultId =
    'WP-R-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8);

  const title = getRawValue_(page.title);
  const content = getRawValue_(page.content);
  const rankMath = getRankMathData_(page);

  results.appendRow([
    resultId,
    commandId || '',
    page.id || '',
    page.slug || '',
    page.status || '',
    page.link || '',
    title,
    page.modified || '',
    content,
    new Date(),
    rankMath.title,
    rankMath.description,
    rankMath.available ? 'OK' : 'UNAVAILABLE'
  ]);

  const resultRow = results.getLastRow();

  return {
    httpCode: 200,
    message: 'Pobrano stronę WordPress ID ' + page.id + ' (' + page.slug + ')',
    resultRef: 'WP RESULTS!A' + resultRow + ':M' + resultRow
  };
}

function getRankMathData_(page) {
  const available = Object.prototype.hasOwnProperty.call(page || {}, 'cc_rank_math');
  const raw = available && page.cc_rank_math && typeof page.cc_rank_math === 'object'
    ? page.cc_rank_math
    : {};

  return {
    available,
    title: String(raw.title || ''),
    description: String(raw.description || '')
  };
}

function writeRankMathField_(postId, field, value) {
  const allowedFields = ['rank_math_title', 'rank_math_description'];
  if (!allowedFields.includes(field)) {
    throw new Error('Niedozwolone pole Rank Math: ' + field);
  }

  const response = wpFetch_(wpBridgePath_('seo-meta'), {
    method: 'post',
    payload: {
      post_id: Number(postId),
      field: field,
      value: value === null || value === undefined ? '' : String(value)
    }
  });

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return response;
}

function updateRankMathField_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(command.target)) {
    throw new Error('UPDATE_RANK_MATH_FIELD wymaga ID strony WordPress.');
  }

  const allowedFields = ['rank_math_title', 'rank_math_description'];
  if (!allowedFields.includes(command.field)) {
    throw new Error(
      'Niedozwolone pole Rank Math: ' + command.field +
      '. Dozwolone: ' + allowedFields.join(', ')
    );
  }

  // Odczyt surowych pól Rank Math jest obowiązkowy przed zapisem,
  // żeby snapshot pozwalał odtworzyć faktyczny stan, także zmienne Rank Math.
  const before = getPageRawById_(command.target, true);
  const snapshot = saveSnapshot_(before, command.id);

  const meta = {};
  meta[command.field] = command.value === null || command.value === undefined
    ? ''
    : String(command.value);

  const response = writeRankMathField_(
    Number(command.target),
    command.field,
    meta[command.field]
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const after = getPageRawById_(command.target, true);
  const rankMathAfter = getRankMathData_(after);
  const expected = meta[command.field];
  const actual = command.field === 'rank_math_title'
    ? rankMathAfter.title
    : rankMathAfter.description;

  if (String(actual) !== String(expected)) {
    throw new Error(
      'Rank Math odpowiedział poprawnie, ale odczyt kontrolny nie zgadza się z zapisem. ' +
      'Pole: ' + command.field
    );
  }

  const saved = savePageResult_(after, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Zaktualizowano ' + command.field +
    ' strony ID ' + command.target +
    '. Snapshot przed zmianą: ' + snapshot.snapshotId;

  return saved;
}


function createPageDraft_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  const slug = String(command.target || '').trim().toLowerCase();
  const title = String(command.field || '').trim();
  const content = command.value === null || command.value === undefined
    ? ''
    : String(command.value);

  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('CREATE_PAGE_DRAFT wymaga bezpiecznego sluga w kolumnie target.');
  }

  if (!title) {
    throw new Error('CREATE_PAGE_DRAFT wymaga tytułu strony w kolumnie field.');
  }

  if (!content.trim()) {
    throw new Error('CREATE_PAGE_DRAFT wymaga treści strony w kolumnie value.');
  }

  // Blokada duplikatu: sprawdzamy wszystkie typowe statusy edytowalne.
  const existing = wpFetch_(
    '/wp-json/wp/v2/pages?context=edit&slug=' + encodeURIComponent(slug) +
    '&status=publish,draft,pending,private,future&per_page=100&_fields=id,slug,status,title'
  );

  if (existing.code < 200 || existing.code >= 300) {
    throw wpError_(existing.code, existing.text);
  }

  const matches = Array.isArray(existing.json) ? existing.json : [];
  if (matches.length > 0) {
    throw new Error(
      'Strona o slugu ' + slug + ' już istnieje (ID ' + matches[0].id +
      ', status ' + matches[0].status + '). Nie utworzono duplikatu.'
    );
  }

  const response = wpFetch_('/wp-json/wp/v2/pages', {
    method: 'post',
    payload: {
      title: title,
      slug: slug,
      content: content,
      status: 'draft'
    }
  });

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const createdId = response.json && response.json.id;
  if (!createdId) {
    throw new Error('WordPress utworzył stronę, ale odpowiedź nie zawiera ID.');
  }

  const after = getPageRawById_(String(createdId), true);

  if (String(after.slug || '') !== slug || String(after.status || '') !== 'draft') {
    throw new Error(
      'Odczyt kontrolny utworzonej strony nie zgadza się ze zleceniem. ' +
      'Oczekiwano slug=' + slug + ', status=draft.'
    );
  }

  const saved = savePageResult_(after, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Utworzono szkic strony WordPress ID ' + createdId +
    ' o slugu /' + slug + '/. Strona NIE została opublikowana.';

  return saved;
}


/**
 * Publikuje wyłącznie istniejący szkic strony.
 * Celowo nie jest to ogólny UPDATE statusu — akcja nie pozwala ustawić
 * private/pending/future/trash ani cofnąć opublikowanej strony do szkicu.
 */
function publishPage_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(command.target)) {
    throw new Error('PUBLISH_PAGE wymaga ID strony WordPress.');
  }

  const before = getPageRawById_(command.target, true);
  const currentStatus = String(before.status || '');

  // Idempotencja: ponowne wykonanie nie robi drugiego zapisu.
  if (currentStatus === 'publish') {
    const saved = savePageResult_(before, command.id);
    saved.httpCode = 200;
    saved.message =
      'Strona ID ' + command.target + ' jest już opublikowana. Nie wykonano zmiany.';
    return saved;
  }

  if (currentStatus !== 'draft') {
    throw new Error(
      'PUBLISH_PAGE publikuje wyłącznie strony ze statusem draft. ' +
      'Aktualny status strony ID ' + command.target + ': ' + currentStatus
    );
  }

  const title = before.title && before.title.raw !== undefined
    ? String(before.title.raw).trim()
    : String((before.title && before.title.rendered) || '').trim();
  const content = before.content && before.content.raw !== undefined
    ? String(before.content.raw).trim()
    : '';
  const slug = String(before.slug || '').trim();

  if (!title || !content || !slug) {
    throw new Error(
      'Nie publikuję niekompletnej strony ID ' + command.target +
      '. Wymagane są: title, slug i niepusta content.'
    );
  }

  // Snapshot dokładnie przed publikacją, łącznie z Rank Math.
  const snapshot = saveSnapshot_(before, command.id);

  const response = wpFetch_(
    '/wp-json/wp/v2/pages/' + encodeURIComponent(command.target),
    {
      method: 'post',
      payload: { status: 'publish' }
    }
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const after = getPageRawById_(command.target, true);
  if (String(after.status || '') !== 'publish') {
    throw new Error(
      'WordPress odpowiedział poprawnie, ale odczyt kontrolny nie potwierdził publikacji ' +
      'strony ID ' + command.target + '.'
    );
  }

  const saved = savePageResult_(after, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Opublikowano stronę ID ' + command.target +
    ' /' + String(after.slug || '') + '/. Snapshot przed publikacją: ' +
    snapshot.snapshotId;

  return saved;
}

function updatePageField_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(command.target)) {
    throw new Error('UPDATE_PAGE_FIELD wymaga ID strony WordPress.');
  }

  const allowedFields = ['title', 'excerpt', 'content'];

  if (!allowedFields.includes(command.field)) {
    throw new Error(
      'Niedozwolone pole: ' + command.field +
      '. Dozwolone: ' + allowedFields.join(', ')
    );
  }

  // 1. Zawsze pobieramy aktualny stan bezpośrednio przed zapisem.
  const before = getPageRawById_(command.target);

  // 2. Zawsze zapisujemy lokalny snapshot przed zmianą.
  const snapshot = saveSnapshot_(before, command.id);

  // 3. Dopiero potem wykonujemy zmianę.
  const payload = {};
  payload[command.field] = command.value;

  const response = wpFetch_(
    '/wp-json/wp/v2/pages/' + encodeURIComponent(command.target),
    {
      method: 'post',
      payload
    }
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  // 4. Odczyt kontrolny po zapisie.
  const after = getPageRawById_(command.target);
  const saved = savePageResult_(after, command.id);

  saved.httpCode = response.code;
  saved.message =
    'Zaktualizowano ' + command.field +
    ' strony ID ' + command.target +
    '. Snapshot przed zmianą: ' + snapshot.snapshotId;

  return saved;
}


/**
 * Bezpieczna, punktowa podmiana dokładnego fragmentu w treści strony.
 * Kolumna field = tekst do znalezienia, value = tekst zastępczy.
 * Zapis jest wykonywany tylko wtedy, gdy fragment występuje dokładnie raz.
 */
function replacePageContentText_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(command.target)) {
    throw new Error('REPLACE_PAGE_CONTENT_TEXT wymaga ID strony WordPress.');
  }

  const findText = String(command.field || '');
  const replacement = command.value === null || command.value === undefined
    ? ''
    : String(command.value);

  if (!findText) {
    throw new Error('REPLACE_PAGE_CONTENT_TEXT wymaga tekstu do znalezienia w kolumnie field.');
  }

  const before = getPageRawById_(command.target, true);
  const content = before.content && before.content.raw !== undefined
    ? String(before.content.raw)
    : '';

  const occurrences = content.split(findText).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      'Nie wykonano podmiany. Fragment musi występować dokładnie raz; znaleziono: ' +
      occurrences + '.'
    );
  }

  const snapshot = saveSnapshot_(before, command.id);
  const updatedContent = content.replace(findText, replacement);

  const response = wpFetch_(
    '/wp-json/wp/v2/pages/' + encodeURIComponent(command.target),
    {
      method: 'post',
      payload: { content: updatedContent }
    }
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const after = getPageRawById_(command.target, true);
  const afterContent = after.content && after.content.raw !== undefined
    ? String(after.content.raw)
    : '';

  if (!afterContent.includes(replacement) || afterContent.includes(findText)) {
    throw new Error(
      'WordPress odpowiedział poprawnie, ale odczyt kontrolny nie potwierdził dokładnej podmiany treści.'
    );
  }

  const saved = savePageResult_(after, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Podmieniono dokładny fragment content strony ID ' + command.target +
    '. Snapshot przed zmianą: ' + snapshot.snapshotId;

  return saved;
}

function saveSnapshot_(page, commandId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(WP_SNAPSHOTS_SHEET);

  if (!sheet) throw new Error('Brak arkusza ' + WP_SNAPSHOTS_SHEET);
  ensureSnapshotMediaColumns_();

  const snapshotId =
    'WP-S-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + page.id +
    '-' + Utilities.getUuid().slice(0, 8);

  const rankMath = getRankMathData_(page);

  sheet.appendRow([
    snapshotId,
    commandId || '',
    page.id || '',
    page.slug || '',
    getRawValue_(page.title),
    getRawValue_(page.excerpt),
    getRawValue_(page.content),
    page.status || '',
    page.modified || '',
    new Date(),
    rankMath.title,
    rankMath.description,
    rankMath.available ? 'TRUE' : 'FALSE',
    'PAGE',
    ''
  ]);

  return {
    snapshotId,
    row: sheet.getLastRow()
  };
}


/**
 * Odczytuje bezpieczny, whitelisted zestaw ustawień układu strony
 * z dedykowanego endpointu REST bridge.
 */
function getPageLayout_(postId, commandId) {
  if (!/^\d+$/.test(String(postId || ''))) {
    throw new Error('GET_PAGE_LAYOUT wymaga numerycznego ID strony WordPress.');
  }

  const response = wpFetch_(
    wpBridgePath_('page-layout') + '?post_id=' + encodeURIComponent(postId)
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return savePageLayoutResult_(response.json || {}, commandId);
}

/**
 * Kopiuje wyłącznie ustawienia układu strony z istniejącej strony wzorcowej.
 * target = ID strony docelowej, field = ID strony źródłowej.
 * Sam zapis wykonuje dedykowany endpoint PHP z własną whitelistą pól.
 */
function copyPageLayout_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  if (!/^\d+$/.test(String(command.target || ''))) {
    throw new Error('COPY_PAGE_LAYOUT wymaga numerycznego ID strony docelowej w target.');
  }

  if (!/^\d+$/.test(String(command.field || ''))) {
    throw new Error('COPY_PAGE_LAYOUT wymaga numerycznego ID strony wzorcowej w field.');
  }

  if (String(command.target) === String(command.field)) {
    throw new Error('Strona docelowa i wzorcowa nie mogą mieć tego samego ID.');
  }

  const response = wpFetch_(wpBridgePath_('page-layout'), {
    method: 'post',
    payload: {
      target_post_id: Number(command.target),
      source_post_id: Number(command.field)
    }
  });

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const saved = savePageLayoutResult_(response.json || {}, command.id);
  saved.httpCode = response.code;
  saved.message =
    'Skopiowano układ strony ID ' + command.field +
    ' → ID ' + command.target +
    '. Zmiana potwierdzona odczytem kontrolnym.';
  return saved;
}

function savePageLayoutResult_(data, commandId) {
  const ss = SpreadsheetApp.getActive();
  const results = ss.getSheetByName(WP_RESULTS_SHEET);
  if (!results) throw new Error('Brak arkusza ' + WP_RESULTS_SHEET);

  const resultId =
    'WP-L-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8);

  const target = data.target || data.page || {};
  const pageId = target.id || data.post_id || '';
  const slug = target.slug || data.slug || '';
  const status = target.status || data.status || '';
  const link = target.link || data.link || '';
  const title = target.title || data.title || 'Page layout';
  const modified = target.modified || data.modified || '';

  const compact = {
    kind: 'PAGE_LAYOUT',
    source: data.source || null,
    before: data.before || null,
    target: data.target || data.page || null,
    changed: data.changed || null
  };

  results.appendRow([
    resultId,
    commandId || '',
    pageId,
    slug,
    status,
    link,
    typeof title === 'string' ? title : getRawValue_(title),
    modified,
    JSON.stringify(compact),
    new Date(),
    '',
    '',
    'LAYOUT'
  ]);

  const resultRow = results.getLastRow();
  return {
    httpCode: 200,
    message: 'Pobrano ustawienia układu strony WordPress ID ' + pageId + '.',
    resultRef: 'WP RESULTS!A' + resultRow + ':M' + resultRow
  };
}

function restoreSnapshot_(command) {
  const config = getWpConfig_();

  if (!config.allowWrites) {
    throw new Error('Zapisy do WordPressa są wyłączone. WP_ALLOW_WRITES != TRUE');
  }

  if (command.confirm !== 'YES') {
    throw new Error('Brak potwierdzenia YES w kolumnie confirm.');
  }

  const snapshotId = String(command.target || '').trim();
  if (!snapshotId) throw new Error('RESTORE_SNAPSHOT wymaga snapshot_id w kolumnie target.');

  const snapshot = findSnapshot_(snapshotId);
  if (!snapshot) throw new Error('Nie znaleziono snapshotu: ' + snapshotId);

  if (snapshot.snapshotKind === 'MEDIA') {
    return restoreMediaSnapshot_(snapshot, command);
  }

  const wpId = snapshot.wpId;

  // Snapshot aktualnego stanu przed rollbackiem - rollback też można cofnąć.
  const current = getPageRawById_(wpId, snapshot.rankMathCaptured);
  const safetySnapshot = saveSnapshot_(current, command.id);

  const payload = {
    title: snapshot.title,
    excerpt: snapshot.excerpt,
    content: snapshot.content,
    status: snapshot.status
  };

  const response = wpFetch_(
    '/wp-json/wp/v2/pages/' + encodeURIComponent(wpId),
    {
      method: 'post',
      payload
    }
  );

  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  if (snapshot.rankMathCaptured) {
    writeRankMathField_(
      Number(wpId),
      'rank_math_title',
      snapshot.rankMathTitle
    );
    writeRankMathField_(
      Number(wpId),
      'rank_math_description',
      snapshot.rankMathDescription
    );
  }

  const restored = getPageRawById_(wpId, snapshot.rankMathCaptured);
  const saved = savePageResult_(restored, command.id);

  saved.httpCode = response.code;
  saved.message =
    'Przywrócono snapshot ' + snapshotId +
    ' dla strony ID ' + wpId +
    (snapshot.rankMathCaptured ? ' wraz z polami Rank Math.' : '.') +
    ' Snapshot stanu sprzed rollbacku: ' + safetySnapshot.snapshotId;

  return saved;
}

function restoreMediaSnapshot_(snapshot, command) {
  const state = snapshot.mediaBefore || null;
  if (!state || !state.id) {
    throw new Error('Snapshot MEDIA nie zawiera prawidłowych danych do przywrócenia.');
  }

  // Snapshot aktualnego stanu przed rollbackiem.
  const current = getMediaRawById_(state.id);
  const safetySnapshot = saveMediaSnapshot_(current, command.id);

  ['title', 'alt_text', 'caption', 'description'].forEach(field => {
    writeMediaField_(Number(state.id), field, state[field] || '');
  });

  const restored = getMediaRawById_(state.id);
  const restoredState = getMediaState_(restored);

  ['title', 'alt_text', 'caption', 'description'].forEach(field => {
    if (String(restoredState[field] || '') !== String(state[field] || '')) {
      throw new Error('Rollback MEDIA nie przeszedł kontroli pola: ' + field);
    }
  });

  const saved = saveMediaResult_(restored, command.id);
  saved.httpCode = 200;
  saved.message =
    'Przywrócono snapshot MEDIA ' + snapshot.snapshotId +
    ' dla mediów ID ' + state.id +
    '. Snapshot stanu sprzed rollbacku: ' + safetySnapshot.snapshotId;

  return saved;
}

function findSnapshot_(snapshotId) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(WP_SNAPSHOTS_SHEET);

  if (!sheet || sheet.getLastRow() < 2) return null;
  ensureSnapshotMediaColumns_();

  const finder = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(snapshotId)
    .matchEntireCell(true)
    .findNext();

  if (!finder) return null;

  const row = finder.getRow();
  const values = sheet.getRange(row, 1, 1, 15).getValues()[0];
  const snapshotKind = String(values[13] || '').toUpperCase() || 'PAGE';

  let mediaBefore = null;
  if (snapshotKind === 'MEDIA' && values[14]) {
    try {
      mediaBefore = JSON.parse(String(values[14]));
    } catch (e) {
      throw new Error('Nie można odczytać media_before_json snapshotu: ' + snapshotId, { cause: e });
    }
  }

  return {
    snapshotId: String(values[0] || ''),
    commandId: String(values[1] || ''),
    wpId: values[2],
    slug: String(values[3] || ''),
    title: String(values[4] || ''),
    excerpt: String(values[5] || ''),
    content: String(values[6] || ''),
    status: String(values[7] || ''),
    modified: values[8],
    createdAt: values[9],
    rankMathTitle: String(values[10] || ''),
    rankMathDescription: String(values[11] || ''),
    rankMathCaptured: String(values[12] || '').toUpperCase() === 'TRUE',
    snapshotKind,
    mediaBefore,
    row
  };
}

function getRawValue_(field) {
  if (field === null || field === undefined) return '';

  if (typeof field === 'string') return field;

  if (typeof field === 'object') {
    if (field.raw !== undefined) return String(field.raw || '');
    if (field.rendered !== undefined) return String(field.rendered || '');
  }

  return String(field);
}

function extractResultRow_(resultRef) {
  const match = String(resultRef || '').match(/!A(\d+):[A-Z]+\d+$/);
  return match ? Number(match[1]) : null;
}

function wpError_(code, body) {
  const error = new Error(
    'WordPress REST API HTTP ' + code + ': ' + String(body).slice(0, 3000)
  );

  error.httpCode = code;
  return error;
}
