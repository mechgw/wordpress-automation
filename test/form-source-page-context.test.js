'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadProject, plain } = require('./helpers/gas');

const ROOT = path.resolve(__dirname, '..');
const FOOTER_MIGRATION_CODE = fs.readFileSync(path.join(ROOT, 'GlobalFooterMigration.gs'), 'utf8');
const B2B_CONTEXT_CODE = fs.readFileSync(path.join(ROOT, 'FormSourcePageContext.gs'), 'utf8');
const RESULTS_HEADER = [
  'result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title',
  'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'
];
const SNAPSHOTS_HEADER = [
  'snapshot_id', 'command_id', 'wp_id', 'slug', 'title_before', 'excerpt_before',
  'content_before', 'status_before', 'modified_before', 'created_at',
  'rank_math_title_before', 'rank_math_description_before', 'rank_math_captured',
  'snapshot_kind', 'media_before_json'
];
const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw'
};

function makeSnippet(gas, overrides = {}) {
  return Object.assign({
    id: 301,
    name: 'CC B2B Source Page Context',
    desc: 'B2B source page',
    code: gas.buildB2BSourceContextCode_(),
    scope: 'head-content',
    active: false,
    priority: 5,
    condition_id: 0,
    tags: ['b2b-source-page-context'],
    code_error: null,
    modified: '2026-09-05T20:00:00+00:00'
  }, overrides);
}

function makeRouter(options = {}) {
  const state = {
    snippet: options.snippet || null,
    extra: options.extra || [],
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
        id: 301,
        modified: '2026-09-05T20:00:00+00:00',
        code_error: options.createdCodeError || null
      }, payload);
      if (options.createdWrongCode) state.snippet.code = 'wrong';
      if (options.createdWrongScope) state.snippet.scope = 'global';
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

    throw new Error('No route for ' + method + ' ' + url);
  };

  return { state, fetch };
}

function project({ router, properties = {}, uiAnswer = 'YES', withResults = true, withSnapshots = true } = {}) {
  const sheets = {};
  if (withResults) sheets['WP RESULTS'] = [RESULTS_HEADER];
  if (withSnapshots) sheets['WP SNAPSHOTS'] = [SNAPSHOTS_HEADER];
  const gas = loadProject({
    properties: Object.assign({}, BASE_PROPS, properties),
    sheets,
    fetch: router ? router.fetch : (() => ({ code: 200, json: [], headers: {} }))
  });
  vm.runInContext(FOOTER_MIGRATION_CODE, gas, { filename: path.join(ROOT, 'GlobalFooterMigration.gs') });
  vm.runInContext(B2B_CONTEXT_CODE, gas, { filename: path.join(ROOT, 'FormSourcePageContext.gs') });
  gas.$ui.$answer = uiAnswer;
  return gas;
}

test('kod kontekstu zapisuje tylko bieżącą stronę formularza B2B bez danych marketingowych', () => {
  const gas = project();
  const code = gas.buildB2BSourceContextCode_();
  assert.match(code, /hidden-11/);
  assert.match(code, /hidden-13/);
  assert.match(code, /b2b_lead/);
  assert.match(code, /window\.location\.origin \+ window\.location\.pathname/);
  assert.match(code, /forminator:form:loaded/);
  assert.doesNotMatch(code, /cmplz|consent/i);
  assert.doesNotMatch(code, /cookie|localStorage|gclid|gbraid|wbraid|utm_/i);
});

test('approval i walidacja blokują niejawne lub niezgodne zapisy', () => {
  let gas = project({ uiAnswer: 'NO' });
  assert.equal(gas.requireB2BSourceContextWriteApproval_('x', 'y'), false);

  gas = project({ uiAnswer: 'YES' });
  assert.throws(() => gas.requireB2BSourceContextWriteApproval_('x', 'y'), /WP_ALLOW_WRITES/);

  gas = project({ uiAnswer: 'YES', properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.equal(gas.requireB2BSourceContextWriteApproval_('x', 'y'), true);
  const expected = gas.buildB2BSourceContextCode_();
  const good = makeSnippet(gas);
  assert.equal(gas.validateB2BSourceContextSnippet_(good, expected).id, 301);
  assert.throws(() => gas.validateB2BSourceContextSnippet_({}, expected), /prawidłowego ID/);
  assert.throws(() => gas.validateB2BSourceContextSnippet_(Object.assign({}, good, { code: 'x' }), expected), /różni się/);
  assert.throws(() => gas.validateB2BSourceContextSnippet_(Object.assign({}, good, { scope: 'global' }), expected), /scope/);
  assert.throws(() => gas.validateB2BSourceContextSnippet_(Object.assign({}, good, { code_error: ['bad'] }), expected), /błąd kodu/);
  assert.equal(gas.getB2BSourceContextCandidates_([{ name: 'x', tags: 'bad' }]).length, 0);
  assert.equal(gas.getB2BSourceContextCandidates_([good]).length, 1);
});

test('prepare tworzy tylko nieaktywny snippet, zapisuje ID i drugi run go reużywa', () => {
  const router = makeRouter();
  const gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });

  const first = gas.prepareB2BSourcePageContext();
  assert.equal(first.created, true);
  assert.equal(first.snippetId, 301);
  assert.equal(first.active, false);
  assert.equal(router.state.snippet.active, false);
  assert.equal(router.state.snippet.scope, 'head-content');
  assert.deepEqual(router.state.snippet.tags, ['b2b-source-page-context']);
  assert.equal(gas.$properties.WP_B2B_SOURCE_CONTEXT_SNIPPET_ID, '301');
  assert.match(String(gas.$alerts.at(-1)[0]), /NIEAKTYWNY/);

  const second = gas.prepareB2BSourcePageContext();
  assert.equal(second.created, false);
  const creates = router.state.calls.filter(call => {
    const parsed = new URL(call.url);
    return parsed.pathname === '/wp-json/code-snippets/v1/snippets' && String(call.params.method) === 'post';
  });
  assert.equal(creates.length, 1);
});

test('prepare obsługuje anulowanie i odrzuca niejednoznaczne lub uszkodzone stany', () => {
  let router = makeRouter();
  let gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'NO' });
  assert.deepEqual(plain(gas.prepareB2BSourcePageContext()), { cancelled: true });
  assert.equal(router.state.calls.length, 0);

  const seed = project();
  const expected = seed.buildB2BSourceContextCode_();
  const base = makeSnippet(seed);

  router = makeRouter({ snippet: base, extra: [Object.assign({}, base, { id: 302 })] });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /więcej niż jeden/);

  router = makeRouter({ snippet: Object.assign({}, base, { code: 'wrong' }) });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /różni się/);

  router = makeRouter({ snippet: Object.assign({}, base, { active: true }) });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /już aktywny/);

  router = makeRouter({ createWithoutId: true });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /nie zwrócił ID/);

  router = makeRouter({ createdWrongCode: true });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /różni się/);

  router = makeRouter({ createdWrongScope: true });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /scope/);

  router = makeRouter({ createdCodeError: ['bad'] });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.prepareB2BSourcePageContext(), /błąd kodu/);

  assert.equal(expected.includes('b2b_lead'), true);
});

test('audit wymaga konfiguracji i zwraca kontrolowany stan', () => {
  let gas = project();
  assert.throws(() => gas.getB2BSourceContextConfiguredSnippet_(), /brak zapisanego ID/);

  const seed = project();
  const snippet = makeSnippet(seed, { active: true });
  const router = makeRouter({ snippet });
  gas = project({
    router,
    properties: { WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301' }
  });
  const state = gas.auditB2BSourcePageContext();
  assert.deepEqual(plain(state), {
    snippetId: 301,
    active: true,
    codeMatches: true,
    codeError: null,
    scope: 'head-content'
  });
  assert.match(String(gas.$alerts.at(-1)[0]), /AKTYWNY/);
});

test('activate robi snapshot, aktywuje i potwierdza read-after-write', () => {
  const seed = project();
  const router = makeRouter({ snippet: makeSnippet(seed) });
  const gas = project({
    router,
    properties: {
      WP_ALLOW_WRITES: 'TRUE',
      WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301'
    },
    uiAnswer: 'YES'
  });

  const result = gas.activateB2BSourcePageContext();
  assert.equal(result.snippetId, 301);
  assert.equal(result.active, true);
  assert.equal(router.state.snippet.active, true);
  assert.equal(gas.$sheet('WP SNAPSHOTS').length >= 2, true);
  assert.match(String(gas.$alerts.at(-1)[0]), /aktywny/);

  const again = gas.activateB2BSourcePageContext();
  assert.deepEqual(plain(again), { alreadyActive: true, snippetId: 301 });
});

test('activate można anulować i wykrywa brak faktycznej aktywacji', () => {
  let seed = project();
  let router = makeRouter({ snippet: makeSnippet(seed) });
  let gas = project({
    router,
    properties: { WP_ALLOW_WRITES: 'TRUE', WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301' },
    uiAnswer: 'NO'
  });
  assert.deepEqual(plain(gas.activateB2BSourcePageContext()), { cancelled: true });

  seed = project();
  router = makeRouter({ snippet: makeSnippet(seed), failActivation: true });
  gas = project({
    router,
    properties: { WP_ALLOW_WRITES: 'TRUE', WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301' }
  });
  assert.throws(() => gas.activateB2BSourcePageContext(), /aktywacja nie została potwierdzona/);
});

test('rollback dezaktywuje tylko dodatkowy snippet i jest idempotentny', () => {
  const seed = project();
  const router = makeRouter({ snippet: makeSnippet(seed, { active: true }) });
  const gas = project({
    router,
    properties: {
      WP_ALLOW_WRITES: 'TRUE',
      WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301'
    }
  });

  const result = gas.rollbackB2BSourcePageContext();
  assert.equal(result.active, false);
  assert.equal(router.state.snippet.active, false);

  const again = gas.rollbackB2BSourcePageContext();
  assert.deepEqual(plain(again), { alreadyRolledBack: true, snippetId: 301 });
});

test('rollback można anulować i wykrywa brak faktycznej dezaktywacji', () => {
  let seed = project();
  let router = makeRouter({ snippet: makeSnippet(seed, { active: true }) });
  let gas = project({
    router,
    properties: { WP_ALLOW_WRITES: 'TRUE', WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301' },
    uiAnswer: 'NO'
  });
  assert.deepEqual(plain(gas.rollbackB2BSourcePageContext()), { cancelled: true });

  seed = project();
  router = makeRouter({ snippet: makeSnippet(seed, { active: true }), failDeactivation: true });
  gas = project({
    router,
    properties: { WP_ALLOW_WRITES: 'TRUE', WP_B2B_SOURCE_CONTEXT_SNIPPET_ID: '301' }
  });
  assert.throws(() => gas.rollbackB2BSourcePageContext(), /dezaktywacja nie została potwierdzona/);
});
