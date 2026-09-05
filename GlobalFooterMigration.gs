// Purpose-built migration of the global footer out of an active Code Snippet.
//
// The editable footer source remains a non-public WordPress page. This module
// creates a new inactive loader snippet, switches activation in an availability-
// preserving order, and provides a symmetric rollback. It intentionally does
// not expose generic snippet update/delete operations.
const GLOBAL_FOOTER_SOURCE_SLUG = 'cc-global-footer-source';
const GLOBAL_FOOTER_LOADER_TAG = 'global-footer-loader';
const GLOBAL_FOOTER_LOADER_NAME = 'Global Footer Loader';
const GLOBAL_FOOTER_SOURCE_ID_PROP = 'WP_GLOBAL_FOOTER_SOURCE_ID';
const GLOBAL_FOOTER_LEGACY_SNIPPET_ID_PROP = 'WP_GLOBAL_FOOTER_LEGACY_SNIPPET_ID';
const GLOBAL_FOOTER_LOADER_SNIPPET_ID_PROP = 'WP_GLOBAL_FOOTER_LOADER_SNIPPET_ID';

/** Explicit interactive approval for the purpose-built write flow. */
function requireGlobalFooterWriteApproval_(title, message) {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(title, message, ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return false;
  // Reuse the canonical WP_ALLOW_WRITES gate. Interactive YES is the explicit
  // confirmation for this guided migration; generic snippet writes remain out of scope.
  requireWpWrite_({ confirm: 'YES' });
  return true;
}

/** Ensure private Code Snippet snapshot columns exist in WP SNAPSHOTS. */
function ensureCodeSnippetSnapshotColumns_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(WP_SNAPSHOTS_SHEET);
  if (!sheet) throw new Error('Brak arkusza ' + WP_SNAPSHOTS_SHEET);

  if (sheet.getMaxColumns() < 17) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), 17 - sheet.getMaxColumns());
  }
  if (!sheet.getRange(1, 16).getValue()) {
    sheet.getRange(1, 16).setValue('code_snippet_before_json');
  }
  if (!sheet.getRange(1, 17).getValue()) {
    sheet.getRange(1, 17).setValue('code_snippet_code_chunk');
  }
  return sheet;
}

/** Full rollback snapshot; code is chunked below the Sheets per-cell limit. */
function saveCodeSnippetSnapshot_(snippet, commandId) {
  const sheet = ensureCodeSnippetSnapshotColumns_();
  const chunks = splitCodeSnippetCode_(snippet.code);
  const metadata = {
    id: Number(snippet.id || 0),
    name: String(snippet.name || snippet.display_name || ''),
    description: String(snippet.desc || snippet.description || ''),
    scope: String(snippet.scope || ''),
    active: Boolean(snippet.active),
    priority: snippet.priority === undefined ? '' : snippet.priority,
    condition_id: snippet.condition_id === undefined ? '' : snippet.condition_id,
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    network: snippet.network === undefined ? null : snippet.network,
    shared_network: snippet.shared_network === undefined ? null : snippet.shared_network,
    trashed: Boolean(snippet.trashed),
    locked: Boolean(snippet.locked),
    code_error: snippet.code_error === undefined ? null : snippet.code_error,
    code_length: String(snippet.code || '').length,
    code_chunks: chunks.length
  };
  const snapshotId =
    'WP-SC-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + metadata.id +
    '-' + Utilities.getUuid().slice(0, 8);

  sheet.appendRow([
    snapshotId,
    commandId || '',
    metadata.id || '',
    '',
    metadata.name || '',
    metadata.description || '',
    '',
    metadata.active ? 'active' : 'inactive',
    snippet.modified || '',
    new Date(),
    '',
    '',
    '',
    'CODE_SNIPPET',
    '',
    JSON.stringify(metadata),
    ''
  ]);

  chunks.forEach((chunk, index) => {
    const part = index + 1;
    sheet.appendRow([
      snapshotId + '-C' + part,
      commandId || '',
      metadata.id || '',
      'code:' + part + '/' + chunks.length,
      metadata.name || '',
      '',
      '',
      metadata.active ? 'active' : 'inactive',
      snippet.modified || '',
      new Date(),
      '',
      '',
      '',
      'CODE_SNIPPET_CODE',
      '',
      '',
      chunk
    ]);
  });

  return { snapshotId, chunks: chunks.length };
}

/** Fetch the non-public WordPress page that stores footer CSS and markup. */
function getGlobalFooterSourcePageBySlug_() {
  const response = wpFetch_(
    '/wp-json/wp/v2/pages?slug=' + encodeURIComponent(GLOBAL_FOOTER_SOURCE_SLUG) +
    '&status=draft&context=edit&_fields=id,slug,status,title,content'
  );
  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  const pages = Array.isArray(response.json) ? response.json : [];
  if (pages.length !== 1) {
    throw new Error(
      'Źródło stopki: oczekiwano dokładnie jednej strony draft o slugu ' +
      GLOBAL_FOOTER_SOURCE_SLUG + ', znaleziono: ' + pages.length + '.'
    );
  }
  return pages[0];
}

/** Validate source identity and the two structural markers used by the loader. */
function validateGlobalFooterSourcePage_(page) {
  if (!page || !/^\d+$/.test(String(page.id || ''))) {
    throw new Error('Źródło stopki nie ma prawidłowego ID WordPressa.');
  }
  if (String(page.status || '') === 'publish') {
    throw new Error('Źródło stopki nie może być opublikowanym landingiem.');
  }

  const content = getRawValue_(page.content);
  const styleHits = (content.match(/<style\b[^>]*id=["']cc-global-footer-styles["'][^>]*>/gi) || []).length;
  const footerHits = (content.match(/<footer\b[^>]*class=["'][^"']*\bcc-site-footer\b[^"']*["'][^>]*>/gi) || []).length;
  if (styleHits !== 1 || footerHits !== 1) {
    throw new Error(
      'Źródło stopki musi zawierać dokładnie jeden #cc-global-footer-styles i jeden .cc-site-footer.'
    );
  }
  return content;
}

/** Identify the current active footer implementation without relying on production IDs. */
function findLegacyGlobalFooterSnippet_(snippets) {
  const candidates = snippets.filter(snippet => {
    const code = String(snippet.code || '');
    const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
    return snippet.active &&
      !tags.includes(GLOBAL_FOOTER_LOADER_TAG) &&
      code.includes('generate_before_footer') &&
      code.includes('cc-site-footer');
  });

  if (candidates.length !== 1) {
    throw new Error(
      'Nie można jednoznacznie wskazać starego aktywnego snippetu stopki. Kandydaci: ' +
      candidates.length + '.'
    );
  }
  return candidates[0];
}

/** Build minimal loader PHP. The actual page ID is injected only at runtime. */
function buildGlobalFooterLoaderCode_(pageId) {
  if (!/^\d+$/.test(String(pageId || ''))) {
    throw new Error('Loader stopki wymaga numerycznego ID strony źródłowej.');
  }

  const id = Number(pageId);
  return [
    "if ( ! function_exists( 'wpauto_global_footer_source_content' ) ) {",
    "\tfunction wpauto_global_footer_source_content() {",
    "\t\tstatic $content = null;",
    "\t\tif ( null !== $content ) { return $content; }",
    "\t\t$source = get_post( " + id + " );",
    "\t\tif ( ! $source || 'page' !== $source->post_type ) { $content = ''; return $content; }",
    "\t\t$content = (string) $source->post_content;",
    "\t\treturn $content;",
    "\t}",
    "}",
    "",
    "if ( ! function_exists( 'wpauto_global_footer_source_valid' ) ) {",
    "\tfunction wpauto_global_footer_source_valid() {",
    "\t\t$content = wpauto_global_footer_source_content();",
    "\t\treturn (bool) preg_match( '/<style\\b[^>]*id=[\"\\x27]cc-global-footer-styles[\"\\x27][^>]*>/i', $content ) && false !== stripos( $content, 'cc-site-footer' );",
    "\t}",
    "}",
    "",
    "add_action( 'wp_head', function () {",
    "\tif ( ! wpauto_global_footer_source_valid() ) { return; }",
    "\t$content = wpauto_global_footer_source_content();",
    "\tif ( preg_match( '/<style\\b[^>]*id=[\"\\x27]cc-global-footer-styles[\"\\x27][^>]*>.*?<\\/style>/is', $content, $match ) ) {",
    "\t\techo $match[0];",
    "\t}",
    "}, 40 );",
    "",
    "add_action( 'generate_before_footer', function () {",
    "\tif ( is_admin() || ! wpauto_global_footer_source_valid() ) { return; }",
    "\t$content = wpauto_global_footer_source_content();",
    "\t$markup = preg_replace( '/<style\\b[^>]*id=[\"\\x27]cc-global-footer-styles[\"\\x27][^>]*>.*?<\\/style>\\s*/is', '', $content, 1 );",
    "\tif ( null !== $markup ) { echo $markup; }",
    "}, 5 );",
    "",
    "add_filter( 'generate_copyright', function ( $copyright ) {",
    "\treturn wpauto_global_footer_source_valid() ? '' : $copyright;",
    "} );"
  ].join('\n');
}

/** Create a snippet, always inactive regardless of caller payload. */
function createInactiveCodeSnippet_(payload) {
  const body = Object.assign({}, payload, { active: false });
  const response = wpFetch_(CODE_SNIPPETS_REST_BASE, { method: 'post', payload: body });
  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }
  return response.json || {};
}

/** One explicit activation/deactivation request; never retried automatically. */
function setCodeSnippetActive_(id, active) {
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('Zmiana aktywacji wymaga numerycznego ID snippetu.');
  }
  const action = active ? 'activate' : 'deactivate';
  const response = wpFetch_(
    CODE_SNIPPETS_REST_BASE + '/' + encodeURIComponent(id) + '/' + action,
    { method: 'post', payload: {} }
  );
  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }
  return response.json || {};
}

function getGlobalFooterLoaderCandidates_(snippets) {
  return snippets.filter(snippet => {
    const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
    return tags.includes(GLOBAL_FOOTER_LOADER_TAG) || String(snippet.name || '') === GLOBAL_FOOTER_LOADER_NAME;
  });
}

/**
 * Stage 1: create/reuse a NEW INACTIVE loader. The legacy footer remains active.
 * Production-specific IDs are stored only in Script Properties.
 */
function prepareGlobalFooterLoader() {
  return withScriptLock_('przygotowanie loadera stopki', () => {
    if (!requireGlobalFooterWriteApproval_(
      'Przygotować loader stopki?',
      'Zostanie utworzony wyłącznie NIEAKTYWNY snippet loadera. Obecna stopka nie zostanie wyłączona ani zmodyfikowana.'
    )) {
      return { cancelled: true };
    }

    const source = getGlobalFooterSourcePageBySlug_();
    validateGlobalFooterSourcePage_(source);
    const expectedCode = buildGlobalFooterLoaderCode_(source.id);
    const snippets = getCodeSnippetsList_();
    const legacy = findLegacyGlobalFooterSnippet_(snippets);
    const loaderCandidates = getGlobalFooterLoaderCandidates_(snippets);

    if (loaderCandidates.length > 1) {
      throw new Error('Znaleziono więcej niż jeden kandydat nowego loadera stopki. Przerwano bez zapisu.');
    }

    let loader;
    let created = false;
    if (loaderCandidates.length === 1) {
      loader = getCodeSnippetRaw_(loaderCandidates[0].id);
      if (String(loader.code || '') !== expectedCode) {
        throw new Error('Istniejący loader ma inny kod niż oczekiwany. Przerwano bez zmiany.');
      }
    } else {
      loader = createInactiveCodeSnippet_({
        name: GLOBAL_FOOTER_LOADER_NAME,
        desc: 'Minimalny loader globalnej stopki z niepublicznego obiektu WordPress.',
        code: expectedCode,
        scope: 'front-end',
        priority: 10,
        tags: [GLOBAL_FOOTER_LOADER_TAG]
      });
      created = true;
      if (!/^\d+$/.test(String(loader.id || ''))) {
        throw new Error('Code Snippets nie zwrócił ID utworzonego loadera.');
      }
      loader = getCodeSnippetRaw_(loader.id);
    }

    if (loader.active) {
      throw new Error('Nowy loader jest już aktywny. Użyj audytu zamiast przygotowania kolejnego loadera.');
    }
    if (String(loader.code || '') !== expectedCode || String(loader.scope || '') !== 'front-end') {
      throw new Error('Odczyt kontrolny nowego loadera nie zgadza się z oczekiwanym stanem.');
    }
    if (loader.code_error) {
      throw new Error('Code Snippets zgłasza błąd kodu nowego loadera. Loader pozostaje nieaktywny.');
    }

    const props = PropertiesService.getScriptProperties();
    props.setProperty(GLOBAL_FOOTER_SOURCE_ID_PROP, String(source.id));
    props.setProperty(GLOBAL_FOOTER_LEGACY_SNIPPET_ID_PROP, String(legacy.id));
    props.setProperty(GLOBAL_FOOTER_LOADER_SNIPPET_ID_PROP, String(loader.id));
    const saved = saveCodeSnippetResult_(loader, 'GLOBAL-FOOTER-PREPARE');

    SpreadsheetApp.getUi().alert(
      'Loader stopki przygotowany.\n\n' +
      'Źródło WordPress ID: ' + source.id +
      '\nStary snippet ID: ' + legacy.id +
      '\nNowy loader ID: ' + loader.id +
      '\nStan loadera: NIEAKTYWNY' +
      '\n\nNie przełączono jeszcze stopki. Obecna stopka nadal działa bez zmian.'
    );

    return {
      sourceId: Number(source.id),
      legacyId: Number(legacy.id),
      loaderId: Number(loader.id),
      created,
      resultRef: saved.resultRef
    };
  });
}

function getGlobalFooterMigrationConfig_() {
  const props = PropertiesService.getScriptProperties();
  const sourceId = props.getProperty(GLOBAL_FOOTER_SOURCE_ID_PROP) || '';
  const legacyId = props.getProperty(GLOBAL_FOOTER_LEGACY_SNIPPET_ID_PROP) || '';
  const loaderId = props.getProperty(GLOBAL_FOOTER_LOADER_SNIPPET_ID_PROP) || '';

  if (![sourceId, legacyId, loaderId].every(value => /^\d+$/.test(String(value)))) {
    throw new Error('Brak kompletnej konfiguracji migracji stopki. Najpierw uruchom prepareGlobalFooterLoader().');
  }
  return { sourceId: Number(sourceId), legacyId: Number(legacyId), loaderId: Number(loaderId) };
}

/** Read-only preflight/current-state read. */
function getGlobalFooterMigrationState_() {
  const config = getGlobalFooterMigrationConfig_();
  const source = getPageRawById_(config.sourceId);
  validateGlobalFooterSourcePage_(source);
  const legacy = getCodeSnippetRaw_(config.legacyId);
  const loader = getCodeSnippetRaw_(config.loaderId);
  const expectedCode = buildGlobalFooterLoaderCode_(config.sourceId);

  return {
    config,
    source,
    legacy,
    loader,
    loaderCodeMatches: String(loader.code || '') === expectedCode,
    loaderCodeError: loader.code_error || null
  };
}

/**
 * Stage 2: activate loader first, verify it, then deactivate legacy footer.
 * If activation fails, legacy remains untouched. No automatic retry is used.
 */
function switchGlobalFooterToLoader() {
  return withScriptLock_('przełączenie globalnej stopki', () => {
    const before = getGlobalFooterMigrationState_();

    if (!before.loaderCodeMatches || before.loaderCodeError) {
      throw new Error('Loader nie przechodzi preflightu kodu. Przerwano bez zapisu.');
    }
    if (before.loader.active && !before.legacy.active) {
      return { alreadySwitched: true, loaderId: before.config.loaderId, legacyId: before.config.legacyId };
    }
    if (before.loader.active || !before.legacy.active) {
      throw new Error('Stan aktywacji nie jest oczekiwany: stary snippet ma być aktywny, loader nieaktywny.');
    }

    if (!requireGlobalFooterWriteApproval_(
      'Przełączyć globalną stopkę?',
      'Nowy loader zostanie aktywowany jako pierwszy. Dopiero po potwierdzeniu aktywacji stary snippet zostanie dezaktywowany.\n\n' +
      'Loader ID: ' + before.config.loaderId + '\nStary snippet ID: ' + before.config.legacyId
    )) {
      return { cancelled: true };
    }

    const loaderSnapshot = saveCodeSnippetSnapshot_(before.loader, 'GLOBAL-FOOTER-SWITCH');
    const legacySnapshot = saveCodeSnippetSnapshot_(before.legacy, 'GLOBAL-FOOTER-SWITCH');

    setCodeSnippetActive_(before.config.loaderId, true);
    const loaderAfterActivation = getCodeSnippetRaw_(before.config.loaderId);
    if (!loaderAfterActivation.active || loaderAfterActivation.code_error) {
      throw new Error(
        'Nie potwierdzono aktywacji nowego loadera. Stary snippet pozostaje bez zmian. ' +
        'Snapshot loadera: ' + loaderSnapshot.snapshotId
      );
    }

    setCodeSnippetActive_(before.config.legacyId, false);
    const legacyAfter = getCodeSnippetRaw_(before.config.legacyId);
    if (legacyAfter.active) {
      throw new Error(
        'Nowy loader jest aktywny, ale nie potwierdzono dezaktywacji starego snippetu. ' +
        'Możliwa podwójna stopka. Snapshot starego snippetu: ' + legacySnapshot.snapshotId
      );
    }

    const saved = saveCodeSnippetResult_(loaderAfterActivation, 'GLOBAL-FOOTER-SWITCH');
    SpreadsheetApp.getUi().alert(
      'Globalna stopka przełączona na loader.\n\n' +
      'Nowy loader: AKTYWNY\nStary snippet: NIEAKTYWNY\n' +
      'Źródłem treści jest niepubliczny obiekt WordPress ID ' + before.config.sourceId + '.\n\n' +
      'Następny krok: audyt i weryfikacja strony.'
    );

    return {
      switched: true,
      sourceId: before.config.sourceId,
      loaderId: before.config.loaderId,
      legacyId: before.config.legacyId,
      loaderSnapshot: loaderSnapshot.snapshotId,
      legacySnapshot: legacySnapshot.snapshotId,
      resultRef: saved.resultRef
    };
  });
}

/** Symmetric rollback: restore legacy first; only then deactivate loader. */
function rollbackGlobalFooterToLegacy() {
  return withScriptLock_('rollback globalnej stopki', () => {
    const before = getGlobalFooterMigrationState_();

    if (before.legacy.active && !before.loader.active) {
      return { alreadyRolledBack: true };
    }
    if (!before.loader.active || before.legacy.active) {
      throw new Error('Rollback wymaga stanu: loader aktywny, stary snippet nieaktywny.');
    }

    if (!requireGlobalFooterWriteApproval_(
      'Cofnąć migrację stopki?',
      'Stary snippet zostanie aktywowany jako pierwszy, a loader wyłączony dopiero po potwierdzeniu.'
    )) {
      return { cancelled: true };
    }

    saveCodeSnippetSnapshot_(before.legacy, 'GLOBAL-FOOTER-ROLLBACK');
    saveCodeSnippetSnapshot_(before.loader, 'GLOBAL-FOOTER-ROLLBACK');

    setCodeSnippetActive_(before.config.legacyId, true);
    const legacyAfterActivation = getCodeSnippetRaw_(before.config.legacyId);
    if (!legacyAfterActivation.active) {
      throw new Error('Nie potwierdzono aktywacji starego snippetu. Loader pozostaje aktywny.');
    }

    setCodeSnippetActive_(before.config.loaderId, false);
    const loaderAfter = getCodeSnippetRaw_(before.config.loaderId);
    if (loaderAfter.active) {
      throw new Error('Stary snippet jest aktywny, ale loader także pozostał aktywny. Możliwa podwójna stopka.');
    }

    saveCodeSnippetResult_(legacyAfterActivation, 'GLOBAL-FOOTER-ROLLBACK');
    SpreadsheetApp.getUi().alert('Rollback stopki zakończony: stary snippet aktywny, loader nieaktywny.');
    return { rolledBack: true, legacyId: before.config.legacyId, loaderId: before.config.loaderId };
  });
}

/** Read-only state audit after preparation, switch or rollback. */
function auditGlobalFooterMigration() {
  return withScriptLock_('audyt globalnej stopki', () => {
    const state = getGlobalFooterMigrationState_();
    const summary = {
      sourceId: state.config.sourceId,
      sourceStatus: String(state.source.status || ''),
      legacyId: state.config.legacyId,
      legacyActive: Boolean(state.legacy.active),
      loaderId: state.config.loaderId,
      loaderActive: Boolean(state.loader.active),
      loaderCodeMatches: state.loaderCodeMatches,
      loaderCodeError: state.loaderCodeError
    };

    SpreadsheetApp.getUi().alert(
      'Audyt globalnej stopki\n\n' +
      'Źródło: ID ' + summary.sourceId + ', status ' + summary.sourceStatus +
      '\nStary snippet: ' + (summary.legacyActive ? 'AKTYWNY' : 'nieaktywny') +
      '\nLoader: ' + (summary.loaderActive ? 'AKTYWNY' : 'nieaktywny') +
      '\nKod loadera zgodny: ' + (summary.loaderCodeMatches ? 'TAK' : 'NIE') +
      '\nBłąd kodu: ' + (summary.loaderCodeError ? 'TAK' : 'brak')
    );
    return summary;
  });
}
