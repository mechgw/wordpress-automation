'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadProject, plain } = require('./helpers/gas');

const ROOT = path.resolve(__dirname, '..');
const FOOTER_MIGRATION_CODE = fs.readFileSync(path.join(ROOT, 'GlobalFooterMigration.gs'), 'utf8');
const SYNTHETIC_FORM_ID = '321';
const RESULTS_HEADER = [
  'result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title',
  'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'
];
const SNAPSHOTS_HEADER = [
  'snapshot_id', 'command_id', 'wp_id', 'slug', 'title_before', 'excerpt_before',
  'content_before', 'status_before', 'modified_before', 'created_at',
  'rank_math_title_before', 'rank_math_description_before', 'rank_math_captured',
  'snapshot_kind', 'media_before_json', 'code_snippet_before_json', 'code_snippet_code_chunk'
];
const HISTORY_HEADER = ['submission_id', 'time_created', 'submission_date_norm', 'imported_at'];
const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_ALLOW_WRITES: 'TRUE',
  WP_REST_NAMESPACE: 'example',
  WP_B2B_FORM_ID: SYNTHETIC_FORM_ID
};

function makeSnippet(gas, overrides = {}) {
  return Object.assign({
    id: 401,
    name: 'Form Submission History Bridge',
    desc: 'history',
    code: gas.buildForminatorHistoryBridgeCode_(),
    scope: 'global',
    active: false,
    priority: 10,
    condition_id: 0,
    tags: ['forminator-submission-history-bridge'],
    code_error: null,
    modified: '2026-09-05T20:00:00+00:00'
  }, overrides);
}

function makeRouter(options = {}) {
  const state = {
    snippet: options.snippet || null,
    extra: options.extra || [],
    pages: options.pages || {},
    calls: []
  };

  const fetch = (url, params = {}) => {
    state.calls.push({ url, params });
    const parsed = new URL(url);
    const method = String(params.method || 'get').toLowerCase();

    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'get') {
      return {
        code: 200,
        json: (state.snippet ? [state.snippet] : []).concat(state.extra),
        headers: { 'X-WP-TotalPages': '1' }
      };
    }

    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'post') {
      if (options.createWithoutId) return { code: 201, json: { active: false }, headers: {} };
      const payload = JSON.parse(params.payload);
      state.snippet = Object.assign({
        id: 401,
        modified: '2026-09-05T20:00:00+00:00',
        code_error: options.createdCodeError || null
      }, payload);
      if (options.createdWrongCode) state.snippet.code = 'wrong';
      if (options.createdWrongScope) state.snippet.scope = 'head-content';
      return { code: 201, json: state.snippet, headers: {} };
    }

    const item = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)$/.exec(parsed.pathname);
    if (item && method === 'get') {
      if (state.snippet && Number(item[1]) === Number(state.snippet.id)) {
        return { code: 200, json: state.snippet, headers: {} };
      }
      return { code: 404, text: 'missing', headers: {} };
    }

    const toggle = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)\/(activate|deactivate)$/.exec(parsed.pathname);
    if (toggle && method === 'post') {
      if (!state.snippet || Number(toggle[1]) !== Number(state.snippet.id)) {
        return { code: 404, text: 'missing', headers: {} };
      }
      const targetActive = toggle[2] === 'activate';
      if ((options.failActivation && targetActive) || (options.failDeactivation && !targetActive)) {
        return { code: 200, json: state.snippet, headers: {} };
      }
      state.snippet.active = targetActive;
      return { code: 200, json: state.snippet, headers: {} };
    }

    if (parsed.pathname === '/wp-json/example/v1/form-submission-history' && method === 'get') {
      if (options.historyHttpCode) {
        return { code: options.historyHttpCode, text: 'history failure', headers: {} };
      }
      const page = Number(parsed.searchParams.get('page') || 1);
      const payload = Object.prototype.hasOwnProperty.call(state.pages, page)
        ? state.pages[page]
        : { form_id: Number(SYNTHETIC_FORM_ID), count: 0, page, per_page: 100, entries: [] };
      return { code: 200, json: payload, headers: {} };
    }

    throw new Error('No route for ' + method + ' ' + url);
  };

  return { state, fetch };
}

function project({ router, properties = {}, uiAnswer = 'YES', historyRows = [HISTORY_HEADER] } = {}) {
  const gas = loadProject({
    properties: Object.assign({}, BASE_PROPS, properties),
    sheets: {
      'WP RESULTS': [RESULTS_HEADER],
      'WP SNAPSHOTS': [SNAPSHOTS_HEADER],
      'FORMINATOR B2B HISTORY': historyRows
    },
    fetch: router ? router.fetch : (() => ({ code: 200, json: [], headers: {} }))
  });
  vm.runInContext(FOOTER_MIGRATION_CODE, gas, { filename: path.join(ROOT, 'GlobalFooterMigration.gs') });
  gas.$ui.$answer = uiAnswer;
  return gas;
}

test('bridge jest read-only, uwierzytelniony i nie eksportuje wartości pól formularza', () => {
  const gas = project();
  const code = gas.buildForminatorHistoryBridgeCode_();

  assert.match(code, /register_rest_route\( 'example\/v1', '\/form-submission-history'/);
  assert.match(code, /'methods' => 'GET'/);
  assert.match(code, /current_user_can\( 'manage_options' \)/);
  assert.match(code, /Forminator_API::count_entries\( 321 \)/);
  assert.match(code, /Forminator_API::get_entries\( 321, \$per_page, \$page \)/);
  assert.match(code, /'entry_id'/);
  assert.match(code, /'time_created'/);
  assert.doesNotMatch(code, /meta_data|email|phone|company|citycouriers/i);
});

test('konfiguracja odrzuca brak form ID i nieprawidłowy namespace', () => {
  let gas = project({ properties: { WP_B2B_FORM_ID: '' } });
  assert.throws(() => gas.getForminatorHistoryConfig_(), /WP_B2B_FORM_ID/);
  assert.throws(() => gas.validateForminatorHistoryFormId_('abc'), /WP_B2B_FORM_ID/);

  gas = project();
  assert.throws(
    () => gas.buildForminatorHistoryBridgeCode_({ formId: 321, namespace: 'bad/namespace' }),
    /nieprawidłowy namespace/
  );
});

test('prepare respektuje anulowanie i nie wykonuje zapisu', () => {
  const router = makeRouter();
  const gas = project({ router, uiAnswer: 'NO' });
  const result = plain(gas.prepareForminatorHistoryBridge());

  assert.deepEqual(result, { cancelled: true });
  assert.equal(router.state.calls.length, 0);
});

test('prepare tworzy wyłącznie nieaktywny snippet, zapisuje ID i wynik', () => {
  const router = makeRouter();
  const gas = project({ router });
  const result = plain(gas.prepareForminatorHistoryBridge());

  assert.equal(result.snippetId, 401);
  assert.equal(result.created, true);
  assert.equal(result.active, false);
  assert.equal(gas.$properties.WP_FORMINATOR_HISTORY_SNIPPET_ID, '401');
  assert.equal(router.state.snippet.active, false);
  assert.equal(router.state.snippet.scope, 'global');
  assert.equal(gas.$sheet('WP RESULTS').length >= 3, true);
});

test('prepare odrzuca duplikaty i błędny rekord utworzony przez REST', () => {
  let gas = project({ router: makeRouter({
    snippet: { id: 1, name: 'Form Submission History Bridge', tags: [], active: false },
    extra: [{ id: 2, name: 'other', tags: ['forminator-submission-history-bridge'], active: false }]
  }) });
  assert.throws(() => gas.prepareForminatorHistoryBridge(), /więcej niż jeden/);

  gas = project({ router: makeRouter({ createWithoutId: true }) });
  assert.throws(() => gas.prepareForminatorHistoryBridge(), /nie zwrócił ID/);

  gas = project({ router: makeRouter({ createdWrongCode: true }) });
  assert.throws(() => gas.prepareForminatorHistoryBridge(), /kod snippetu różni się/);
});

test('walidacja i audyt wykrywają zły scope, code_error i brak skonfigurowanego ID', () => {
  let gas = project();
  const expected = gas.buildForminatorHistoryBridgeCode_();
  assert.throws(
    () => gas.validateForminatorHistorySnippet_({ id: 1, code: expected, scope: 'head-content', code_error: null }, expected),
    /nieprawidłowy scope/
  );
  assert.throws(
    () => gas.validateForminatorHistorySnippet_({ id: 1, code: expected, scope: 'global', code_error: 'boom' }, expected),
    /zgłasza błąd kodu/
  );
  assert.throws(() => gas.getForminatorHistoryConfiguredId_(), /brak zapisanego ID/);

  const router = makeRouter();
  gas = project({ router, properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' } });
  router.state.snippet = makeSnippet(gas);
  const audit = plain(gas.auditForminatorHistoryBridge());
  assert.deepEqual(audit, { snippetId: 401, active: false, codeMatches: true, codeError: null, scope: 'global' });
});

test('activate wykonuje snapshot, aktywację i świeżą walidację', () => {
  const router = makeRouter();
  const gas = project({ router, properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' } });
  router.state.snippet = makeSnippet(gas);

  const result = plain(gas.activateForminatorHistoryBridge());
  assert.deepEqual(result, { snippetId: 401, active: true });
  assert.equal(router.state.snippet.active, true);
  assert.equal(gas.$sheet('WP SNAPSHOTS').length >= 3, true);

  const second = plain(gas.activateForminatorHistoryBridge());
  assert.deepEqual(second, { snippetId: 401, active: true, alreadyActive: true });
});

test('activate zgłasza błąd, jeśli REST nie utrzymał stanu active', () => {
  const router = makeRouter({ failActivation: true });
  const gas = project({ router, properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' } });
  router.state.snippet = makeSnippet(gas);
  assert.throws(() => gas.activateForminatorHistoryBridge(), /pozostał nieaktywny/);
});

test('rollback wyłącza po zapisanym ID także przy driftującym kodzie i code_error', () => {
  const router = makeRouter();
  const gas = project({ router, properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' } });
  router.state.snippet = makeSnippet(gas, { active: true, code: 'drift', code_error: 'broken' });

  const result = plain(gas.rollbackForminatorHistoryBridge());
  assert.deepEqual(result, { snippetId: 401, active: false });
  assert.equal(router.state.snippet.active, false);
  assert.equal(gas.$sheet('WP SNAPSHOTS').length >= 3, true);
});

test('rollback zgłasza błąd, jeśli deaktywacja nie zadziała', () => {
  const router = makeRouter({ failDeactivation: true });
  const gas = project({ router, properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' } });
  router.state.snippet = makeSnippet(gas, { active: true });
  assert.throws(() => gas.rollbackForminatorHistoryBridge(), /nie wyłączył snippetu/);
});

test('fetch strony historii waliduje HTTP, form_id, count, entries i entry_id', () => {
  let gas = project({ router: makeRouter({ historyHttpCode: 500 }) });
  assert.throws(() => gas.fetchForminatorHistoryPage_(1, 100), /HTTP 500/);

  gas = project({ router: makeRouter({ pages: {
    1: { form_id: 999, count: 0, entries: [] }
  } }) });
  assert.throws(() => gas.fetchForminatorHistoryPage_(1, 100), /nieprawidłowa odpowiedź/);

  gas = project({ router: makeRouter({ pages: {
    1: { form_id: 321, count: 1, entries: null }
  } }) });
  assert.throws(() => gas.fetchForminatorHistoryPage_(1, 100), /tablicy entries/);

  gas = project({ router: makeRouter({ pages: {
    1: { form_id: 321, count: 1, entries: [{ entry_id: 'bad', time_created: '' }] }
  } }) });
  assert.throws(() => gas.fetchForminatorHistoryPage_(1, 100), /entry_id/);
});

test('readAll pobiera wiele stron, sortuje po ID i pilnuje spójności count', () => {
  const page1Entries = Array.from({ length: 100 }, (_, i) => ({
    entry_id: i + 1,
    time_created: `2026-01-${String((i % 28) + 1).padStart(2, '0')} 12:00:00`
  }));
  const router = makeRouter({ pages: {
    1: { form_id: 321, count: 102, entries: page1Entries },
    2: { form_id: 321, count: 102, entries: [
      { entry_id: 102, time_created: '2026-02-02 12:00:00' },
      { entry_id: 101, time_created: '2026-02-01 12:00:00' }
    ] }
  } });
  let gas = project({ router });
  const entries = plain(gas.readAllB2BForminatorHistory_());
  assert.equal(entries.length, 102);
  assert.equal(entries[0].entryId, 1);
  assert.equal(entries[101].entryId, 102);

  gas = project({ router: makeRouter({ pages: {
    1: { form_id: 321, count: 101, entries: page1Entries },
    2: { form_id: 321, count: 100, entries: [] }
  } }) });
  assert.throws(() => gas.readAllB2BForminatorHistory_(), /zmieniła się w trakcie importu/);

  gas = project({ router: makeRouter({ pages: {
    1: { form_id: 321, count: 2, entries: [
      { entry_id: 1, time_created: '2026-01-01 10:00:00' },
      { entry_id: 1, time_created: '2026-01-01 10:00:00' }
    ] }
  } }) });
  assert.throws(() => gas.readAllB2BForminatorHistory_(), /unikalnych wpisów/);
});

test('readAll ma limit bezpieczeństwa dla nieoczekiwanie dużej historii', () => {
  const gas = project({ router: makeRouter({ pages: {
    1: { form_id: 321, count: 50001, entries: [] }
  } }) });
  assert.throws(() => gas.readAllB2BForminatorHistory_(), /50000/);
});

test('import zapisuje wyłącznie ID i czas, normalizuje datę i czyści stare wiersze', () => {
  const router = makeRouter({ pages: {
    1: { form_id: 321, count: 2, entries: [
      { entry_id: 9, time_created: '2026-06-03 08:10:11' },
      { entry_id: 7, time_created: '2026-05-30 17:20:30' }
    ] }
  } });
  const gas = project({
    router,
    historyRows: [HISTORY_HEADER, ['old', 'secret-looking-old-value', 'old', 'old'], ['stale', 'stale', 'stale', 'stale']]
  });

  const result = plain(gas.importB2BForminatorHistory());
  assert.equal(result.count, 2);
  assert.equal(result.firstTime, '2026-05-30 17:20:30');
  assert.equal(result.lastTime, '2026-06-03 08:10:11');
  assert.equal(gas.$cell('FORMINATOR B2B HISTORY', 'A2'), 7);
  assert.equal(gas.$cell('FORMINATOR B2B HISTORY', 'B2'), '2026-05-30 17:20:30');
  assert.equal(gas.$cell('FORMINATOR B2B HISTORY', 'C2'), '2026-05-30');
  assert.equal(gas.$cell('FORMINATOR B2B HISTORY', 'A3'), 9);
  assert.equal(gas.$cell('FORMINATOR B2B HISTORY', 'C3'), '2026-06-03');
  assert.notEqual(gas.$cell('FORMINATOR B2B HISTORY', 'D2'), '');
});

test('import obsługuje pustą historię i brak arkusza', () => {
  let gas = project({ router: makeRouter() });
  const empty = plain(gas.importB2BForminatorHistory());
  assert.deepEqual(empty, { count: 0, firstTime: 'brak', lastTime: 'brak' });

  gas = loadProject({
    properties: BASE_PROPS,
    sheets: {},
    fetch: makeRouter().fetch
  });
  assert.throws(() => gas.importB2BForminatorHistory(), /Brak arkusza FORMINATOR B2B HISTORY/);
});
