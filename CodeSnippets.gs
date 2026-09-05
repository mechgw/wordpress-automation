// Code Snippets — bezpieczny discovery tylko do odczytu.
//
// Ten moduł korzysta z istniejącego uwierzytelnionego klienta wpFetch_()
// z WordPress.gs. Nie wykonuje żadnych zapisów do WordPressa ani Code Snippets.
const CODE_SNIPPETS_REST_BASE = '/wp-json/code-snippets/v1/snippets';
const CODE_SNIPPET_CODE_CHUNK_SIZE = 30000;

/** Pobiera pełną listę snippetów, obsługując standardową paginację REST WordPressa. */
function getCodeSnippetsList_() {
  const snippets = [];
  let page = 1;

  while (true) {
    const response = wpFetch_(
      CODE_SNIPPETS_REST_BASE +
      '?context=edit&status=all&per_page=100&orderby=id&order=asc&page=' + page
    );

    if (response.code < 200 || response.code >= 300) {
      throw wpError_(response.code, response.text);
    }

    const items = Array.isArray(response.json) ? response.json : [];
    snippets.push(...items);

    const headers = response.headers || {};
    const totalPages = Number(
      headers['X-WP-TotalPages'] ||
      headers['x-wp-totalpages'] ||
      headers['X-Wp-Totalpages'] ||
      1
    );

    if (page >= totalPages || items.length === 0) break;
    page++;
  }

  return snippets;
}

/** Pobiera jeden snippet po ID w kontekście edycji, aby zachować pełny kod. */
function getCodeSnippetRaw_(id) {
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('Code Snippets: wymagane jest numeryczne ID snippetu.');
  }

  const response = wpFetch_(
    CODE_SNIPPETS_REST_BASE + '/' + encodeURIComponent(id) + '?context=edit'
  );
  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return response.json || {};
}

/** Dzieli kod na części znacznie poniżej limitu 50 000 znaków jednej komórki Sheets. */
function splitCodeSnippetCode_(code) {
  const text = String(code || '');
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += CODE_SNIPPET_CODE_CHUNK_SIZE) {
    chunks.push(text.slice(offset, offset + CODE_SNIPPET_CODE_CHUNK_SIZE));
  }
  return chunks;
}

/** Normalizuje pola audytowe; sam kod jest zapisywany osobno w bezpiecznych częściach. */
function codeSnippetState_(snippet) {
  const code = String(snippet.code || '');
  const chunks = splitCodeSnippetCode_(code);
  return {
    kind: 'CODE_SNIPPET',
    id: Number(snippet.id || 0),
    name: String(snippet.name || snippet.display_name || ''),
    description: String(snippet.desc || snippet.description || ''),
    scope: String(snippet.scope || ''),
    active: Boolean(snippet.active),
    priority: snippet.priority === undefined ? '' : snippet.priority,
    condition_id: snippet.condition_id === undefined ? '' : snippet.condition_id,
    tags: Array.isArray(snippet.tags) ? snippet.tags : [],
    code_length: code.length,
    code_chunks: chunks.length
  };
}

/**
 * Zapisuje metadane snippetu i kod do istniejącego WP RESULTS.
 * Kod trafia do osobnych wierszy CODE_SNIPPET_CODE po maks. 30 000 znaków,
 * więc nawet duży snippet nie przekracza limitu pojedynczej komórki Sheets.
 */
function saveCodeSnippetResult_(snippet, commandId) {
  const results = SpreadsheetApp.getActive().getSheetByName(WP_RESULTS_SHEET);
  if (!results) throw new Error('Brak arkusza ' + WP_RESULTS_SHEET);

  const state = codeSnippetState_(snippet);
  const codeChunks = splitCodeSnippetCode_(snippet.code);
  const resultId =
    'WP-CS-' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8);

  results.appendRow([
    resultId,
    commandId || '',
    state.id || '',
    state.scope || '',
    state.active ? 'active' : 'inactive',
    '',
    state.name || '',
    snippet.modified || '',
    JSON.stringify(state),
    new Date(),
    '',
    '',
    'CODE_SNIPPET'
  ]);

  const firstRow = results.getLastRow();

  codeChunks.forEach((chunk, index) => {
    const part = index + 1;
    results.appendRow([
      resultId + '-C' + part,
      commandId || '',
      state.id || '',
      'code:' + part + '/' + codeChunks.length,
      state.active ? 'active' : 'inactive',
      '',
      (state.name || 'Code Snippet') + ' [kod ' + part + '/' + codeChunks.length + ']',
      snippet.modified || '',
      chunk,
      new Date(),
      '',
      '',
      'CODE_SNIPPET_CODE'
    ]);
  });

  const lastRow = results.getLastRow();
  return {
    httpCode: 200,
    message:
      'Pobrano Code Snippet ID ' + state.id + ' (' + (state.name || 'bez nazwy') +
      '), kod: ' + state.code_length + ' znaków / ' + state.code_chunks + ' części.',
    resultRef: 'WP RESULTS!A' + firstRow + ':M' + lastRow,
    firstRow,
    lastRow
  };
}

/**
 * Ręczny discovery produkcyjnej instalacji Code Snippets.
 *
 * Funkcja tylko czyta REST API. Dla każdego ID z kolekcji pobiera pełny rekord
 * i zapisuje go do WP RESULTS. Cały przebieg jest pod wspólną blokadą projektu,
 * żeby zakres wyników nie został przepleciony z innym procesem.
 */
function discoverCodeSnippets() {
  return withScriptLock_('Code Snippets discovery', () => {
    const list = getCodeSnippetsList_();
    let firstRow = null;
    let lastRow = null;

    list.forEach(item => {
      const full = getCodeSnippetRaw_(item.id);
      const saved = saveCodeSnippetResult_(full, 'CODE-SNIPPETS-DISCOVERY');
      if (firstRow === null) firstRow = saved.firstRow;
      lastRow = saved.lastRow;
    });

    const resultRef = firstRow === null ? '' : 'WP RESULTS!A' + firstRow + ':M' + lastRow;
    SpreadsheetApp.getUi().alert(
      'Code Snippets — discovery zakończony.\n\n' +
      'Pobrane snippety: ' + list.length +
      (resultRef ? '\nWyniki: ' + resultRef : '\nBrak snippetów do zapisania.') +
      '\n\nNie wykonano żadnego zapisu do WordPressa.'
    );

    return { count: list.length, resultRef };
  });
}
