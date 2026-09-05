// Purpose-built, consent-independent source-page context for B2B Forminator submissions.
//
// Marketing attribution stays in the existing consent-gated tracking snippet. This
// module adds only first-party form context: for forms marked as b2b_lead it writes
// the current page URL (origin + pathname) to hidden-13. No cookies, ad identifiers,
// referrer or UTM values are read or written here.
const B2B_SOURCE_CONTEXT_TAG = 'b2b-source-page-context';
const B2B_SOURCE_CONTEXT_NAME = 'B2B Source Page Context';
const B2B_SOURCE_CONTEXT_SNIPPET_ID_PROP = 'WP_B2B_SOURCE_CONTEXT_SNIPPET_ID';

/** Explicit approval for this narrow Code Snippets write flow. */
function requireB2BSourceContextWriteApproval_(title, message) {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(title, message, ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return false;
  requireWpWrite_({ confirm: 'YES' });
  return true;
}

/** Build a small head-content snippet that fills hidden-13 only for b2b_lead forms. */
function buildB2BSourceContextCode_() {
  return [
    '<script>',
    '(function () {',
    '  "use strict";',
    '',
    '  function fillB2BSourcePage() {',
    '    var markers = document.querySelectorAll(\'input[name="hidden-11"]\');',
    '    if (!markers.length) { return; }',
    '    var sourcePage = window.location.origin + window.location.pathname;',
    '',
    '    markers.forEach(function (marker) {',
    '      if (marker.value !== "b2b_lead") { return; }',
    '      var form = marker.closest("form");',
    '      if (!form) { return; }',
    '      var field = form.querySelector(\'input[name="hidden-13"]\');',
    '      if (!field || field.value === sourcePage) { return; }',
    '      field.value = sourcePage;',
    '      field.dispatchEvent(new Event("input", { bubbles: true }));',
    '      field.dispatchEvent(new Event("change", { bubbles: true }));',
    '    });',
    '  }',
    '',
    '  fillB2BSourcePage();',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", fillB2BSourcePage);',
    '  }',
    '  window.addEventListener("load", fillB2BSourcePage);',
    '  if (window.jQuery) {',
    '    window.jQuery(document).on("after.load.forminator", fillB2BSourcePage);',
    '  }',
    '',
    '  var attempts = 0;',
    '  var timer = window.setInterval(function () {',
    '    attempts += 1;',
    '    fillB2BSourcePage();',
    '    if (attempts >= 20) { window.clearInterval(timer); }',
    '  }, 500);',
    '}());',
    '</script>'
  ].join('\n');
}

/** Find the one managed snippet by tag/name without relying on production IDs. */
function getB2BSourceContextCandidates_(snippets) {
  return snippets.filter(snippet => {
    const tags = Array.isArray(snippet.tags) ? snippet.tags : [];
    return tags.includes(B2B_SOURCE_CONTEXT_TAG) ||
      String(snippet.name || '') === B2B_SOURCE_CONTEXT_NAME;
  });
}

function validateB2BSourceContextSnippet_(snippet, expectedCode) {
  if (!snippet || !/^\d+$/.test(String(snippet.id || ''))) {
    throw new Error('B2B source_page: snippet nie ma prawidłowego ID.');
  }
  if (String(snippet.code || '') !== expectedCode) {
    throw new Error('B2B source_page: kod snippetu różni się od oczekiwanego.');
  }
  if (String(snippet.scope || '') !== 'head-content') {
    throw new Error('B2B source_page: snippet ma nieprawidłowy scope.');
  }
  if (snippet.code_error) {
    throw new Error('B2B source_page: Code Snippets zgłasza błąd kodu.');
  }
  return snippet;
}

/** Create/reuse an INACTIVE snippet. Existing tracking remains untouched. */
function prepareB2BSourcePageContext() {
  return withScriptLock_('przygotowanie B2B source_page', () => {
    if (!requireB2BSourceContextWriteApproval_(
      'Przygotować B2B source_page?',
      'Zostanie utworzony wyłącznie NIEAKTYWNY snippet, który zapisuje bieżącą stronę do hidden-13 formularza B2B. Istniejący tracking marketingowy nie zostanie zmieniony.'
    )) {
      return { cancelled: true };
    }

    const expectedCode = buildB2BSourceContextCode_();
    const candidates = getB2BSourceContextCandidates_(getCodeSnippetsList_());
    if (candidates.length > 1) {
      throw new Error('B2B source_page: znaleziono więcej niż jeden zarządzany snippet. Przerwano bez zapisu.');
    }

    let snippet;
    let created = false;
    if (candidates.length === 1) {
      snippet = getCodeSnippetRaw_(candidates[0].id);
      validateB2BSourceContextSnippet_(snippet, expectedCode);
    } else {
      snippet = createInactiveCodeSnippet_({
        name: B2B_SOURCE_CONTEXT_NAME,
        desc: 'Consent-independent current page context for B2B Forminator hidden-13.',
        code: expectedCode,
        scope: 'head-content',
        priority: 5,
        tags: [B2B_SOURCE_CONTEXT_TAG]
      });
      created = true;
      if (!/^\d+$/.test(String(snippet.id || ''))) {
        throw new Error('B2B source_page: Code Snippets nie zwrócił ID nowego snippetu.');
      }
      snippet = getCodeSnippetRaw_(snippet.id);
      validateB2BSourceContextSnippet_(snippet, expectedCode);
    }

    if (snippet.active) {
      throw new Error('B2B source_page: snippet jest już aktywny. Użyj audytu zamiast przygotowania.');
    }

    PropertiesService.getScriptProperties().setProperty(
      B2B_SOURCE_CONTEXT_SNIPPET_ID_PROP,
      String(snippet.id)
    );
    const saved = saveCodeSnippetResult_(snippet, 'B2B-SOURCE-CONTEXT-PREPARE');

    SpreadsheetApp.getUi().alert(
      'B2B source_page przygotowany.\n\n' +
      'Snippet ID: ' + snippet.id +
      '\nStan: NIEAKTYWNY' +
      '\n\nIstniejący tracking działa bez zmian. Po audycie uruchom activateB2BSourcePageContext().'
    );

    return { snippetId: Number(snippet.id), created, active: false, resultRef: saved.resultRef };
  });
}

function getB2BSourceContextConfiguredId_() {
  const id = PropertiesService.getScriptProperties().getProperty(B2B_SOURCE_CONTEXT_SNIPPET_ID_PROP);
  if (!/^\d+$/.test(String(id || ''))) {
    throw new Error('B2B source_page: brak zapisanego ID snippetu. Najpierw uruchom prepareB2BSourcePageContext().');
  }
  return Number(id);
}

function getB2BSourceContextConfiguredSnippet_() {
  return getCodeSnippetRaw_(getB2BSourceContextConfiguredId_());
}

/** Read-only preflight/audit. */
function auditB2BSourcePageContext() {
  return withScriptLock_('audyt B2B source_page', () => {
    const expectedCode = buildB2BSourceContextCode_();
    const snippet = validateB2BSourceContextSnippet_(
      getB2BSourceContextConfiguredSnippet_(),
      expectedCode
    );
    const state = {
      snippetId: Number(snippet.id),
      active: Boolean(snippet.active),
      codeMatches: String(snippet.code || '') === expectedCode,
      codeError: snippet.code_error || null,
      scope: String(snippet.scope || '')
    };

    SpreadsheetApp.getUi().alert(
      'Audyt B2B source_page\n\n' +
      'Snippet ID: ' + state.snippetId +
      '\nStan: ' + (state.active ? 'AKTYWNY' : 'nieaktywny') +
      '\nKod zgodny: ' + (state.codeMatches ? 'TAK' : 'NIE') +
      '\nBłąd kodu: ' + (state.codeError ? String(state.codeError) : 'brak')
    );
    return state;
  });
}

/** Activate only after an explicit second approval and a fresh read-before-write. */
function activateB2BSourcePageContext() {
  return withScriptLock_('aktywacja B2B source_page', () => {
    if (!requireB2BSourceContextWriteApproval_(
      'Aktywować B2B source_page?',
      'Nowy snippet zacznie wypełniać hidden-13 bieżącym URL-em tylko w formularzach form_type=b2b_lead. Nie zmienia cookie ani danych marketingowych.'
    )) {
      return { cancelled: true };
    }

    const expectedCode = buildB2BSourceContextCode_();
    let snippet = validateB2BSourceContextSnippet_(
      getB2BSourceContextConfiguredSnippet_(),
      expectedCode
    );
    if (snippet.active) return { alreadyActive: true, snippetId: Number(snippet.id) };

    saveCodeSnippetSnapshot_(snippet, 'B2B-SOURCE-CONTEXT-ACTIVATE');
    setCodeSnippetActive_(snippet.id, true);
    snippet = validateB2BSourceContextSnippet_(getCodeSnippetRaw_(snippet.id), expectedCode);
    if (!snippet.active) {
      throw new Error('B2B source_page: aktywacja nie została potwierdzona w odczycie kontrolnym.');
    }
    const saved = saveCodeSnippetResult_(snippet, 'B2B-SOURCE-CONTEXT-ACTIVATE');

    SpreadsheetApp.getUi().alert(
      'B2B source_page aktywny.\n\nSnippet ID: ' + snippet.id +
      '\nNastępny krok: test formularza bez zgody marketingowej i kontrola kolumny source_page w RAW.'
    );
    return { snippetId: Number(snippet.id), active: true, resultRef: saved.resultRef };
  });
}

/** Emergency rollback: deactivate by the stored ID even if code drifted or is invalid. */
function rollbackB2BSourcePageContext() {
  return withScriptLock_('rollback B2B source_page', () => {
    if (!requireB2BSourceContextWriteApproval_(
      'Wyłączyć B2B source_page?',
      'Zostanie wyłączony wyłącznie dodatkowy snippet B2B source_page. Dotychczasowy tracking marketingowy pozostanie bez zmian.'
    )) {
      return { cancelled: true };
    }

    const snippetId = getB2BSourceContextConfiguredId_();
    let snippet = getCodeSnippetRaw_(snippetId);
    if (!snippet.active) return { alreadyRolledBack: true, snippetId };

    saveCodeSnippetSnapshot_(snippet, 'B2B-SOURCE-CONTEXT-ROLLBACK');
    setCodeSnippetActive_(snippetId, false);
    snippet = getCodeSnippetRaw_(snippetId);
    if (snippet.active) {
      throw new Error('B2B source_page: dezaktywacja nie została potwierdzona w odczycie kontrolnym.');
    }
    const saved = saveCodeSnippetResult_(snippet, 'B2B-SOURCE-CONTEXT-ROLLBACK');
    return { snippetId, active: false, resultRef: saved.resultRef };
  });
}
