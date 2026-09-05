// Code Snippets — bezpieczny discovery tylko do odczytu.
//
// Ten moduł korzysta z istniejącego uwierzytelnionego klienta wpFetch_()
// z WordPress.gs. Nie wykonuje żadnych zapisów do WordPressa ani Code Snippets.
const CODE_SNIPPETS_REST_BASE = '/wp-json/code-snippets/v1/snippets';

/** Pobiera pełną listę snippetów, obsługując standardową paginację REST WordPressa. */
function getCodeSnippetsList_() {
  const snippets = [];
  let page = 1;

  while (true) {
    const response = wpFetch_(
      CODE_SNIPPETS_REST_BASE +
      '?status=all&per_page=100&orderby=id&order=asc&page=' + page
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

/** Pobiera jeden snippet po ID, żeby discovery zawsze zapisywał pełny kod, a nie skróconą kolekcję. */
function getCodeSnippetRaw_(id) {
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('Code Snippets: wymagane jest numeryczne ID snippetu.');
  }

  const response = wpFetch_(CODE_SNIPPETS_REST_BASE + '/' + encodeURIComponent(id));
  if (response.code < 200 || response.code >= 300) {
    throw wpError_(response.code, response.text);
  }

  return response.json || {};
}

/** Normalizuje tylko pola potrzebne do audytu; kod pozostaje wyłącznie w prywatnym arkuszu. */
function codeSnippetState_(snippet) {
  return {
    kind: 'CODE_SNIPPET',
    id: Number(snippet.id || 0),
    name: String(snippet.name || snippet.display_name || ''),
    description: String(snippet.desc || snippet.description || ''),
    code: String(snippet.code || ''),
    scope: String(snippet.scope || ''),
    active: Boolean(snippet.active),
    priority: snippet.priority === undefined ? '' : snippet.priority,
    condition_id: snippet.condition_id === undefined ? '' : snippet.condition_id,
    tags: Array.isArray(snippet.tags) ? snippet.tags : []
  };
}

/** Zapisuje odczyt snippetu do istniejącego WP RESULTS bez ujawniania kodu w komunikacie UI. */
function saveCodeSnippetResult_(snippet, commandId) {
  const results = SpreadsheetApp.getActive().getSheetByName('WP RESULTS');
  if (!results) throw new Error('Brak arkusza WP RESULTS');

  const state = codeSnippetState_(snippet);
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

  const row = results.getLastRow();
  return {
    httpCode: 200,
    message: 'Pobrano Code Snippet ID ' + state.id + ' (' + (state.name || 'bez nazwy') + ').',
    resultRef: 'WP RESULTS!A' + row + ':M' + row
  };
}

/**
 * Ręczny discovery produkcyjnej instalacji Code Snippets.
 *
 * Funkcja tylko czyta REST API. Dla każdego ID z kolekcji pobiera pełny rekord
 * i zapisuje go do WP RESULTS jako kind=CODE_SNIPPET. Dzięki temu można ustalić
 * dokładny kod, scope i stan aktywacji m.in. snippetu globalnej stopki.
 */
function discoverCodeSnippets() {
  const list = getCodeSnippetsList_();
  let firstRow = null;
  let lastRow = null;

  list.forEach(item => {
    const full = getCodeSnippetRaw_(item.id);
    const saved = saveCodeSnippetResult_(full, 'CODE-SNIPPETS-DISCOVERY');
    const match = /!A(\d+):M(\d+)$/.exec(saved.resultRef);
    if (match) {
      const row = Number(match[1]);
      if (firstRow === null) firstRow = row;
      lastRow = row;
    }
  });

  const resultRef = firstRow === null ? '' : 'WP RESULTS!A' + firstRow + ':M' + lastRow;
  SpreadsheetApp.getUi().alert(
    'Code Snippets — discovery zakończony.\n\n' +
    'Pobrane snippety: ' + list.length +
    (resultRef ? '\nWyniki: ' + resultRef : '\nBrak snippetów do zapisania.') +
    '\n\nNie wykonano żadnego zapisu do WordPressa.'
  );

  return { count: list.length, resultRef };
}
