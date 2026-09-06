// Read-only Forminator submission-history bridge used to validate historical B2B lead counts.
//
// The WordPress snippet exposes only entry ID and creation time for one configured form.
// It deliberately excludes field values, so names, emails, phone numbers and company data
// never leave WordPress through this endpoint.
const FORMINATOR_HISTORY_TAG = 'forminator-submission-history-bridge';
const FORMINATOR_HISTORY_NAME = 'Form Submission History Bridge';
const FORMINATOR_HISTORY_SNIPPET_ID_PROP = 'WP_FORMINATOR_HISTORY_SNIPPET_ID';
const FORMINATOR_HISTORY_FORM_ID_PROP = 'WP_B2B_FORM_ID';
const FORMINATOR_HISTORY_WRITE_APPROVAL_PROP = 'WP_FORMINATOR_HISTORY_WRITE_APPROVAL';
const FORMINATOR_HISTORY_SHEET = 'FORMINATOR B2B HISTORY';

/**
 * One-time approval for editor/headless execution.
 *
 * Running this function is the explicit first step. The approval is consumed by
 * the next Forminator-history write operation, so prepare/activate/rollback each
 * require a fresh arm. WP_ALLOW_WRITES must still be TRUE.
 */
function armForminatorHistoryWrite() {
  requireWpWrite_({ confirm: 'YES' });
  PropertiesService.getScriptProperties().setProperty(FORMINATOR_HISTORY_WRITE_APPROVAL_PROP, 'YES');
  return { armed: true };
}

function requireForminatorHistoryWriteApproval_(title, message) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(FORMINATOR_HISTORY_WRITE_APPROVAL_PROP) === 'YES') {
    props.setProperty(FORMINATOR_HISTORY_WRITE_APPROVAL_PROP, '');
    requireWpWrite_({ confirm: 'YES' });
    return true;
  }

  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    throw new Error(
      'Forminator history: brak kontekstu UI. Najpierw uruchom armForminatorHistoryWrite(), ' +
      'a potem ponów operację.'
    );
  }

  const answer = ui.alert(title, message, ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return false;
  requireWpWrite_({ confirm: 'YES' });
  return true;
}

/** Post-run message: dialog in the spreadsheet UI, log only in editor/headless context. */
function showForminatorHistoryMessage_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    Logger.log(message);
  }
}

function validateForminatorHistoryFormId_(value) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new Error('Forminator history: brak prawidłowej Script Property ' + FORMINATOR_HISTORY_FORM_ID_PROP + '.');
  }
  return Number(text);
}

function getForminatorHistoryConfig_() {
  const formId = validateForminatorHistoryFormId_(
    PropertiesService.getScriptProperties().getProperty(FORMINATOR_HISTORY_FORM_ID_PROP)
  );
  const namespace = getWpConfig_().restNamespace;
  if (!namespace) {
    throw new Error('Forminator history: brak Script Property WP_REST_NAMESPACE.');
  }
  return { formId, namespace };
}

function buildForminatorHistoryBridgeCode_(config) {
  const cfg = config || getForminatorHistoryConfig_();
  const formId = validateForminatorHistoryFormId_(cfg.formId);
  const namespace = String(cfg.namespace || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(namespace)) {
    throw new Error('Forminator history: nieprawidłowy namespace REST.');
  }

  return [
    "add_action( 'rest_api_init', function () {",
    "\tregister_rest_route( '" + namespace + "/v1', '/form-submission-history', array(",
    "\t\t'methods' => 'GET',",
    "\t\t'permission_callback' => function () { return current_user_can( 'manage_options' ); },",
    "\t\t'callback' => function ( WP_REST_Request $request ) {",
    "\t\t\tif ( ! class_exists( 'Forminator_API' ) ) {",
    "\t\t\t\treturn new WP_Error( 'forminator_unavailable', 'Forminator API is unavailable.', array( 'status' => 503 ) );",
    "\t\t\t}",
    "",
    "\t\t\t$per_page = absint( $request->get_param( 'per_page' ) );",
    "\t\t\tif ( $per_page < 1 ) { $per_page = 100; }",
    "\t\t\t$per_page = min( 100, $per_page );",
    "\t\t\t$page = max( 1, absint( $request->get_param( 'page' ) ) );",
    "",
    "\t\t\t$count = Forminator_API::count_entries( " + formId + " );",
    "\t\t\tif ( is_wp_error( $count ) ) { return $count; }",
    "\t\t\t$entries = Forminator_API::get_entries( " + formId + ", $per_page, $page );",
    "\t\t\tif ( is_wp_error( $entries ) ) { return $entries; }",
    "\t\t\tif ( ! is_array( $entries ) ) { $entries = $entries ? array( $entries ) : array(); }",
    "",
    "\t\t\t$items = array();",
    "\t\t\tforeach ( $entries as $entry ) {",
    "\t\t\t\tif ( ! is_object( $entry ) || empty( $entry->entry_id ) ) { continue; }",
    "\t\t\t\t$items[] = array(",
    "\t\t\t\t\t'entry_id' => absint( $entry->entry_id ),",
    "\t\t\t\t\t'time_created' => isset( $entry->time_created ) ? sanitize_text_field( (string) $entry->time_created ) : '',",
    "\t\t\t\t);",
    "\t\t\t}",
    "",
    "\t\t\treturn rest_ensure_response( array(",
    "\t\t\t\t'form_id' => " + formId + ",",
    "\t\t\t\t'count' => absint( $count ),",
    "\t\t\t\t'page' => $page,",
    "\t\t\t\t'per_page' => $per_page,",
    "\t\t\t\t'entries' => $items,",
    "\t\t\t) );",
    "\t\t},",
    "\t) );",
    "} );"
  ].join('\n');
}

function getForminatorHistoryCandidates_(snippets) {
  return snippets.filter(snippet => {
    const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
    return tags.includes(FORMINATOR_HISTORY_TAG) || String(snippet.name || '') === FORMINATOR_HISTORY_NAME;
  });
}

function validateForminatorHistorySnippet_(snippet, expectedCode) {
  if (!snippet || !/^\d+$/.test(String(snippet.id || ''))) {
    throw new Error('Forminator history: snippet nie ma prawidłowego ID.');
  }
  if (String(snippet.code || '') !== expectedCode) {
    throw new Error('Forminator history: kod snippetu różni się od oczekiwanego.');
  }
  if (String(snippet.scope || '') !== 'global') {
    throw new Error('Forminator history: snippet ma nieprawidłowy scope.');
  }
  if (snippet.code_error) {
    throw new Error('Forminator history: Code Snippets zgłasza błąd kodu.');
  }
  return snippet;
}

function prepareForminatorHistoryBridge() {
  return withScriptLock_('przygotowanie Forminator history bridge', () => {
    if (!requireForminatorHistoryWriteApproval_(
      'Przygotować Forminator history bridge?',
      'Zostanie utworzony wyłącznie NIEAKTYWNY, uwierzytelniony endpoint tylko do odczytu ID i czasu zgłoszeń jednego formularza.'
    )) {
      return { cancelled: true };
    }

    const expectedCode = buildForminatorHistoryBridgeCode_();
    const candidates = getForminatorHistoryCandidates_(getCodeSnippetsList_());
    if (candidates.length > 1) {
      throw new Error('Forminator history: znaleziono więcej niż jeden zarządzany snippet.');
    }

    let snippet;
    let created = false;
    if (candidates.length === 1) {
      snippet = getCodeSnippetRaw_(candidates[0].id);
      validateForminatorHistorySnippet_(snippet, expectedCode);
    } else {
      snippet = createInactiveCodeSnippet_({
        name: FORMINATOR_HISTORY_NAME,
        desc: 'Authenticated read-only Forminator submission history endpoint without field values.',
        code: expectedCode,
        scope: 'global',
        priority: 10,
        tags: [FORMINATOR_HISTORY_TAG]
      });
      created = true;
      if (!/^\d+$/.test(String(snippet.id || ''))) {
        throw new Error('Forminator history: Code Snippets nie zwrócił ID nowego snippetu.');
      }
      snippet = getCodeSnippetRaw_(snippet.id);
      validateForminatorHistorySnippet_(snippet, expectedCode);
    }

    if (snippet.active) {
      throw new Error('Forminator history: snippet jest już aktywny. Użyj audytu.');
    }

    PropertiesService.getScriptProperties().setProperty(
      FORMINATOR_HISTORY_SNIPPET_ID_PROP,
      String(snippet.id)
    );
    const saved = saveCodeSnippetResult_(snippet, 'FORMINATOR-HISTORY-PREPARE');

    showForminatorHistoryMessage_(
      'Forminator history bridge przygotowany.\n\n' +
      'Snippet ID: ' + snippet.id + '\nStan: NIEAKTYWNY\n\nPo audycie uruchom activateForminatorHistoryBridge().'
    );

    return { snippetId: Number(snippet.id), created, active: false, resultRef: saved.resultRef };
  });
}

function getForminatorHistoryConfiguredId_() {
  const id = PropertiesService.getScriptProperties().getProperty(FORMINATOR_HISTORY_SNIPPET_ID_PROP);
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('Forminator history: brak zapisanego ID snippetu. Najpierw uruchom prepareForminatorHistoryBridge().');
  }
  return Number(id);
}

function auditForminatorHistoryBridge() {
  return withScriptLock_('audyt Forminator history bridge', () => {
    const expectedCode = buildForminatorHistoryBridgeCode_();
    const snippet = validateForminatorHistorySnippet_(
      getCodeSnippetRaw_(getForminatorHistoryConfiguredId_()),
      expectedCode
    );
    const state = {
      snippetId: Number(snippet.id),
      active: Boolean(snippet.active),
      codeMatches: true,
      codeError: null,
      scope: String(snippet.scope || '')
    };
    showForminatorHistoryMessage_(
      'Audyt Forminator history bridge\n\n' +
      'Snippet ID: ' + state.snippetId +
      '\nStan: ' + (state.active ? 'AKTYWNY' : 'nieaktywny') +
      '\nKod zgodny: TAK\nBłąd kodu: brak'
    );
    return state;
  });
}

function activateForminatorHistoryBridge() {
  return withScriptLock_('aktywacja Forminator history bridge', () => {
    if (!requireForminatorHistoryWriteApproval_(
      'Aktywować Forminator history bridge?',
      'Endpoint będzie dostępny wyłącznie dla uwierzytelnionego administratora i zwróci tylko ID oraz czas zgłoszeń.'
    )) {
      return { cancelled: true };
    }

    const expectedCode = buildForminatorHistoryBridgeCode_();
    let snippet = validateForminatorHistorySnippet_(
      getCodeSnippetRaw_(getForminatorHistoryConfiguredId_()),
      expectedCode
    );
    if (snippet.active) return { snippetId: Number(snippet.id), active: true, alreadyActive: true };

    saveCodeSnippetSnapshot_(snippet, 'FORMINATOR-HISTORY-ACTIVATE');
    setCodeSnippetActive_(snippet.id, true);
    snippet = getCodeSnippetRaw_(snippet.id);
    validateForminatorHistorySnippet_(snippet, expectedCode);
    if (!snippet.active) throw new Error('Forminator history: snippet pozostał nieaktywny po aktywacji.');

    showForminatorHistoryMessage_(
      'Forminator history bridge aktywny.\n\nSnippet ID: ' + snippet.id +
      '\nNastępny krok: importB2BForminatorHistory().'
    );
    return { snippetId: Number(snippet.id), active: true };
  });
}

function rollbackForminatorHistoryBridge() {
  return withScriptLock_('rollback Forminator history bridge', () => {
    if (!requireForminatorHistoryWriteApproval_(
      'Wyłączyć Forminator history bridge?',
      'Zapisany snippet zostanie zdezaktywowany po ID. Dane już zapisane w arkuszu pozostaną bez zmian.'
    )) {
      return { cancelled: true };
    }

    const id = getForminatorHistoryConfiguredId_();
    let snippet = getCodeSnippetRaw_(id);
    saveCodeSnippetSnapshot_(snippet, 'FORMINATOR-HISTORY-ROLLBACK');
    if (snippet.active) setCodeSnippetActive_(id, false);
    snippet = getCodeSnippetRaw_(id);
    if (snippet.active) throw new Error('Forminator history: rollback nie wyłączył snippetu.');
    return { snippetId: id, active: false };
  });
}

function fetchForminatorHistoryPage_(page, perPage) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(perPage) || 100));
  const response = wpFetch_(
    wpBridgePath_('form-submission-history') +
    '?page=' + encodeURIComponent(pageNumber) + '&per_page=' + encodeURIComponent(pageSize)
  );
  if (response.code < 200 || response.code >= 300) {
    throw new Error('Forminator history endpoint HTTP ' + response.code + ': ' + response.text.slice(0, 1000));
  }
  const payload = response.json || {};
  const expectedFormId = getForminatorHistoryConfig_().formId;
  if (Number(payload.form_id) !== expectedFormId || !Number.isInteger(Number(payload.count))) {
    throw new Error('Forminator history: nieprawidłowa odpowiedź endpointu.');
  }
  if (!Array.isArray(payload.entries)) {
    throw new Error('Forminator history: endpoint nie zwrócił tablicy entries.');
  }
  const entries = payload.entries.map(entry => {
    if (!entry || !/^\d+$/.test(String(entry.entry_id || ''))) {
      throw new Error('Forminator history: wpis bez prawidłowego entry_id.');
    }
    return {
      entryId: Number(entry.entry_id),
      timeCreated: String(entry.time_created || '')
    };
  });
  return { count: Number(payload.count), entries };
}

function readAllB2BForminatorHistory_() {
  const perPage = 100;
  const first = fetchForminatorHistoryPage_(1, perPage);
  if (first.count > 50000) {
    throw new Error('Forminator history: liczba wpisów przekracza limit bezpieczeństwa 50000.');
  }

  const byId = new Map();
  first.entries.forEach(entry => byId.set(entry.entryId, entry));
  const totalPages = Math.max(1, Math.ceil(first.count / perPage));
  for (let page = 2; page <= totalPages; page += 1) {
    const current = fetchForminatorHistoryPage_(page, perPage);
    if (current.count !== first.count) {
      throw new Error('Forminator history: liczba wpisów zmieniła się w trakcie importu. Spróbuj ponownie.');
    }
    current.entries.forEach(entry => byId.set(entry.entryId, entry));
  }

  const entries = Array.from(byId.values()).sort((a, b) => a.entryId - b.entryId);
  if (entries.length !== first.count) {
    throw new Error(
      'Forminator history: oczekiwano ' + first.count + ' unikalnych wpisów, pobrano ' + entries.length + '.'
    );
  }
  return entries;
}

function normalizeForminatorHistoryDate_(timeCreated) {
  const match = String(timeCreated || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function importB2BForminatorHistory() {
  return withScriptLock_('import historii zgłoszeń B2B', () => {
    const entries = readAllB2BForminatorHistory_();
    const sheet = SpreadsheetApp.getActive().getSheetByName(FORMINATOR_HISTORY_SHEET);
    if (!sheet) throw new Error('Brak arkusza ' + FORMINATOR_HISTORY_SHEET + '.');

    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 4).clearContent();

    const importedAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    const rows = entries.map(entry => [
      entry.entryId,
      entry.timeCreated,
      normalizeForminatorHistoryDate_(entry.timeCreated),
      importedAt
    ]);
    if (rows.length) sheet.getRange(2, 1, rows.length, 4).setValues(rows);

    const first = rows.length ? rows[0][1] : 'brak';
    const last = rows.length ? rows[rows.length - 1][1] : 'brak';
    showForminatorHistoryMessage_(
      'Historia Forminator B2B pobrana.\n\n' +
      'Wpisy: ' + rows.length + '\nNajstarszy: ' + first + '\nNajnowszy: ' + last +
      '\n\nDo arkusza nie skopiowano żadnych wartości pól formularza.'
    );
    return { count: rows.length, firstTime: first, lastTime: last };
  });
}