'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

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

function sourcePage(id = 101) {
  return {
    id,
    slug: 'cc-global-footer-source',
    status: 'draft',
    title: { raw: 'Global Footer Source' },
    content: {
      raw: '<style id="cc-global-footer-styles">.x{display:block}</style>\n' +
        '<footer class="cc-site-footer"><a href="/x/">X</a></footer>'
    }
  };
}

function legacySnippet(id = 201, active = true) {
  return {
    id,
    name: 'Legacy Footer',
    desc: 'Old footer',
    code: "add_action('generate_before_footer', function(){ echo '<footer class=\"cc-site-footer\"></footer>'; });",
    scope: 'front-end',
    active,
    priority: 10,
    condition_id: 0,
    tags: ['footer'],
    modified: '2026-09-05T10:00:00+00:00'
  };
}

function buildLoader(gas, id = 202, active = false, overrides = {}) {
  return Object.assign({
    id,
    name: 'Global Footer Loader',
    desc: 'Loader',
    code: gas.buildGlobalFooterLoaderCode_(101),
    scope: 'front-end',
    active,
    priority: 10,
    condition_id: 0,
    tags: ['global-footer-loader'],
    code_error: null,
    modified: '2026-09-05T10:01:00+00:00'
  }, overrides);
}

function makeRouter(options = {}) {
  const state = {
    source: options.source === undefined ? sourcePage() : options.source,
    legacy: options.legacy || legacySnippet(),
    loader: options.loader || null,
    extraLoaders: options.extraLoaders || [],
    calls: []
  };

  const fetch = (url, params = {}) => {
    state.calls.push({ url, params });
    const parsed = new URL(url);
    const method = String(params.method || 'get').toLowerCase();

    if (options.forceHttpError && parsed.pathname.includes(options.forceHttpError.path)) {
      return { code: options.forceHttpError.code, text: 'forced-error', headers: {} };
    }

    if (parsed.pathname === '/wp-json/wp/v2/pages' && parsed.searchParams.get('slug') === 'cc-global-footer-source') {
      return { code: 200, json: state.source ? [state.source] : [], headers: {} };
    }
    if (state.source && parsed.pathname === '/wp-json/wp/v2/pages/' + state.source.id) {
      return { code: 200, json: state.source, headers: {} };
    }

    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'get') {
      return {
        code: 200,
        json: [state.legacy].concat(state.loader ? [state.loader] : []).concat(state.extraLoaders),
        headers: { 'X-WP-TotalPages': '1' }
      };
    }

    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'post') {
      if (options.createWithoutId) return { code: 201, json: { active: false }, headers: {} };
      const payload = JSON.parse(params.payload);
      state.loader = Object.assign({
        id: 202,
        modified: '2026-09-05T10:01:00+00:00',
        code_error: options.createdCodeError || null
      }, payload);
      if (options.createdWrongScope) state.loader.scope = 'global';
      if (options.createdActive) state.loader.active = true;
      if (options.createdWrongCode) state.loader.code = 'different';
      return { code: 201, json: state.loader, headers: {} };
    }

    const item = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)$/.exec(parsed.pathname);
    if (item && method === 'get') {
      const id = Number(item[1]);
      if (id === state.legacy.id) return { code: 200, json: state.legacy, headers: {} };
      if (state.loader && id === state.loader.id) return { code: 200, json: state.loader, headers: {} };
      return { code: 404, text: 'missing', headers: {} };
    }

    const toggle = /^\/wp-json\/code-snippets\/v1\/snippets\/(\d+)\/(activate|deactivate)$/.exec(parsed.pathname);
    if (toggle && method === 'post') {
      const id = Number(toggle[1]);
      const active = toggle[2] === 'activate';
      const target = id === state.legacy.id ? state.legacy : state.loader;
      if (!target) return { code: 404, text: 'missing', headers: {} };

      if (options.failLoaderActivation && target === state.loader && active) {
        return { code: 200, json: target, headers: {} };
      }
      if (options.failLegacyDeactivation && target === state.legacy && !active) {
        return { code: 200, json: target, headers: {} };
      }
      if (options.failLegacyActivation && target === state.legacy && active) {
        return { code: 200, json: target, headers: {} };
      }
      if (options.failLoaderDeactivation && target === state.loader && !active) {
        return { code: 200, json: target, headers: {} };
      }

      target.active = active;
      return { code: 200, json: target, headers: {} };
    }

    throw new Error('No route for ' + method + ' ' + url);
  };

  return { state, fetch };
}

function project({ router, properties = {}, uiAnswer = 'YES', withResults = true, withSnapshots = true, lockHeld = false } = {}) {
  const sheets = {};
  if (withResults) sheets['WP RESULTS'] = [RESULTS_HEADER];
  if (withSnapshots) sheets['WP SNAPSHOTS'] = [SNAPSHOTS_HEADER];
  const gas = loadProject({
    properties: Object.assign({}, BASE_PROPS, properties),
    sheets,
    fetch: router ? router.fetch : (() => ({ code: 200, json: [], headers: {} })),
    lockHeld
  });
  gas.$ui.$answer = uiAnswer;
  return gas;
}

function migrationProps() {
  return {
    WP_ALLOW_WRITES: 'TRUE',
    WP_GLOBAL_FOOTER_SOURCE_ID: '101',
    WP_GLOBAL_FOOTER_LEGACY_SNIPPET_ID: '201',
    WP_GLOBAL_FOOTER_LOADER_SNIPPET_ID: '202'
  };
}

test('approval, snapshot i walidatory pokrywają bezpieczne ścieżki pomocnicze', () => {
  let gas = project({ uiAnswer: 'NO' });
  assert.equal(gas.requireGlobalFooterWriteApproval_('x', 'y'), false);

  gas = project({ uiAnswer: 'YES' });
  assert.throws(() => gas.requireGlobalFooterWriteApproval_('x', 'y'), /WP_ALLOW_WRITES/);

  gas = project({ uiAnswer: 'YES', properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.equal(gas.requireGlobalFooterWriteApproval_('x', 'y'), true);

  const snapshotSheet = gas.SpreadsheetApp.getActive().getSheetByName('WP SNAPSHOTS');
  snapshotSheet.getMaxColumns = () => 15;
  const big = Object.assign(legacySnippet(42), {
    code: 'x'.repeat(65001),
    network: false,
    shared_network: null,
    trashed: false,
    locked: false,
    code_error: null
  });
  const saved = gas.saveCodeSnippetSnapshot_(big, 'CMD');
  const rows = gas.$sheet('WP SNAPSHOTS');
  assert.equal(saved.chunks, 3);
  assert.equal(rows[0][15], 'code_snippet_before_json');
  assert.equal(rows[0][16], 'code_snippet_code_chunk');
  assert.equal(rows.slice(2).map(row => row[16]).join(''), big.code);

  assert.throws(() => project({ withSnapshots: false }).saveCodeSnippetSnapshot_(legacySnippet(), 'x'), /Brak arkusza WP SNAPSHOTS/);
  assert.throws(() => gas.validateGlobalFooterSourcePage_({}), /prawidłowego ID/);
  assert.throws(() => gas.validateGlobalFooterSourcePage_({ id: 1, status: 'publish', content: { raw: '' } }), /opublikowanym/);
  assert.throws(() => gas.validateGlobalFooterSourcePage_({ id: 1, status: 'draft', content: { raw: '<footer></footer>' } }), /dokładnie jeden/);

  const incompleteStyle = sourcePage();
  incompleteStyle.content.raw = '<style id="cc-global-footer-styles">.x{}\n' +
    '<footer class="cc-site-footer">X</footer>';
  assert.throws(() => gas.validateGlobalFooterSourcePage_(incompleteStyle), /kompletny/);

  const incompleteFooter = sourcePage();
  incompleteFooter.content.raw = '<style id="cc-global-footer-styles">.x{}</style>\n' +
    '<footer class="cc-site-footer">X';
  assert.throws(() => gas.validateGlobalFooterSourcePage_(incompleteFooter), /kompletny/);
  assert.match(gas.validateGlobalFooterSourcePage_(sourcePage()), /cc-site-footer/);

  assert.throws(() => gas.findLegacyGlobalFooterSnippet_([]), /Kandydaci: 0/);
  assert.equal(gas.findLegacyGlobalFooterSnippet_([legacySnippet()]).id, 201);
  assert.deepEqual(plain(gas.getGlobalFooterLoaderCandidates_([{ name: 'x', tags: 'bad' }])), []);
  assert.equal(gas.getGlobalFooterLoaderCandidates_([{ name: 'Global Footer Loader', tags: [] }]).length, 1);

  assert.throws(() => gas.buildGlobalFooterLoaderCode_('bad'), /numerycznego ID/);
  const php = gas.buildGlobalFooterLoaderCode_(101);
  assert.match(php, /get_post\( 101 \)/);
  assert.match(php, /\$style_ok =/);
  assert.match(php, /\$footer_ok =/);
  assert.match(php, /echo \$match\[0\];/);
  assert.match(php, /return wpauto_global_footer_source_valid\(\) \? '' : \$copyright;/);
  assert.doesNotMatch(php, /stripos\( \$content, 'cc-site-footer' \)/);
  assert.doesNotMatch(php, /\\"/);

  assert.throws(() => gas.setCodeSnippetActive_('bad', true), /numerycznego ID/);
  assert.throws(() => gas.getGlobalFooterMigrationConfig_(), /Brak kompletnej konfiguracji/);
});

test('źródło i low-level REST jawnie propagują HTTP errors', () => {
  let router = makeRouter({ forceHttpError: { path: '/wp-json/wp/v2/pages', code: 500 } });
  let gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  assert.throws(() => gas.getGlobalFooterSourcePageBySlug_(), /HTTP 500/);

  router = makeRouter({ source: null });
  gas = project({ router });
  assert.throws(() => gas.getGlobalFooterSourcePageBySlug_(), /znaleziono: 0/);

  router = makeRouter({ forceHttpError: { path: '/wp-json/code-snippets/v1/snippets', code: 500 } });
  gas = project({ router });
  assert.throws(() => gas.createInactiveCodeSnippet_({ code: 'x' }), /HTTP 500/);
  assert.throws(() => gas.setCodeSnippetActive_(7, true), /HTTP 500/);
});

test('prepare tworzy wyłącznie nieaktywny loader i drugi run go reużywa', () => {
  const router = makeRouter();
  const gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });

  const first = gas.prepareGlobalFooterLoader();
  assert.equal(first.created, true);
  assert.equal(first.sourceId, 101);
  assert.equal(first.legacyId, 201);
  assert.equal(first.loaderId, 202);
  assert.equal(router.state.loader.active, false);
  assert.equal(router.state.loader.scope, 'front-end');
  assert.deepEqual(router.state.loader.tags, ['global-footer-loader']);
  assert.match(router.state.loader.code, /get_post\( 101 \)/);
  assert.equal(gas.$properties.WP_GLOBAL_FOOTER_SOURCE_ID, '101');
  assert.equal(gas.$properties.WP_GLOBAL_FOOTER_LEGACY_SNIPPET_ID, '201');
  assert.equal(gas.$properties.WP_GLOBAL_FOOTER_LOADER_SNIPPET_ID, '202');
  assert.match(String(gas.$alerts.at(-1)[0]), /NIEAKTYWNY/);

  const second = gas.prepareGlobalFooterLoader();
  assert.equal(second.created, false);
  const creates = router.state.calls.filter(call => {
    const parsed = new URL(call.url);
    return parsed.pathname === '/wp-json/code-snippets/v1/snippets' && String(call.params.method) === 'post';
  });
  assert.equal(creates.length, 1);
});

test('prepare można anulować i blokuje niejednoznaczne lub uszkodzone stany', () => {
  let router = makeRouter();
  let gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'NO' });
  assert.deepEqual(plain(gas.prepareGlobalFooterLoader()), { cancelled: true });
  assert.equal(router.state.calls.length, 0);

  const seed = project();
  const expectedCode = seed.buildGlobalFooterLoaderCode_(101);
  const cases = [
    { loader: { id: 202, name: 'Global Footer Loader', code: 'different', scope: 'front-end', active: false, tags: ['global-footer-loader'] }, re: /inny kod/ },
    { loader: { id: 202, name: 'Global Footer Loader', code: expectedCode, scope: 'front-end', active: true, tags: ['global-footer-loader'] }, re: /już aktywny/ },
    { loader: { id: 202, name: 'Global Footer Loader', code: expectedCode, scope: 'global', active: false, tags: ['global-footer-loader'] }, re: /nie zgadza/ },
    { loader: { id: 202, name: 'Global Footer Loader', code: expectedCode, scope: 'front-end', active: false, tags: ['global-footer-loader'], code_error: ['bad', 1] }, re: /błąd kodu/ }
  ];
  for (const item of cases) {
    router = makeRouter({ loader: item.loader });
    gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });
    assert.throws(() => gas.prepareGlobalFooterLoader(), item.re);
  }

  router = makeRouter({
    loader: { id: 202, name: 'Global Footer Loader', code: expectedCode, scope: 'front-end', active: false, tags: ['global-footer-loader'] },
    extraLoaders: [{ id: 203, name: 'Other', code: expectedCode, scope: 'front-end', active: false, tags: ['global-footer-loader'] }]
  });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });
  assert.throws(() => gas.prepareGlobalFooterLoader(), /więcej niż jeden/);

  router = makeRouter({ createWithoutId: true });
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });
  assert.throws(() => gas.prepareGlobalFooterLoader(), /nie zwrócił ID/);

  for (const option of ['createdActive', 'createdWrongScope', 'createdWrongCode', 'createdCodeError']) {
    const opts = {};
    opts[option] = option === 'createdCodeError' ? ['bad', 1] : true;
    router = makeRouter(opts);
    gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, uiAnswer: 'YES' });
    assert.throws(() => gas.prepareGlobalFooterLoader(), /już aktywny|nie zgadza|błąd kodu/);
  }
});

test('migration state, switch, audit i rollback zachowują kolejność availability-first', () => {
  const seed = project();
  const router = makeRouter({ loader: buildLoader(seed) });
  const gas = project({ router, properties: migrationProps(), uiAnswer: 'YES' });

  const state = gas.getGlobalFooterMigrationState_();
  assert.equal(state.loaderCodeMatches, true);
  assert.equal(state.loaderCodeError, null);

  const switched = gas.switchGlobalFooterToLoader();
  assert.equal(switched.switched, true);
  assert.equal(router.state.loader.active, true);
  assert.equal(router.state.legacy.active, false);
  let toggles = router.state.calls.filter(call => /\/(activate|deactivate)$/.test(new URL(call.url).pathname));
  assert.match(toggles[0].url, /\/202\/activate$/);
  assert.match(toggles[1].url, /\/201\/deactivate$/);
  assert.equal(gas.$sheet('WP SNAPSHOTS').filter(row => row[13] === 'CODE_SNIPPET').length, 2);
  assert.match(String(gas.$alerts.at(-1)[0]), /przełączona/);

  assert.equal(gas.switchGlobalFooterToLoader().alreadySwitched, true);
  const audit = gas.auditGlobalFooterMigration();
  assert.deepEqual(plain(audit), {
    sourceId: 101,
    sourceStatus: 'draft',
    legacyId: 201,
    legacyActive: false,
    loaderId: 202,
    loaderActive: true,
    loaderCodeMatches: true,
    loaderCodeError: null
  });

  const rolled = gas.rollbackGlobalFooterToLegacy();
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.recoveredDoubleActive, false);
  assert.equal(router.state.legacy.active, true);
  assert.equal(router.state.loader.active, false);
  toggles = router.state.calls.filter(call => /\/(activate|deactivate)$/.test(new URL(call.url).pathname));
  assert.match(toggles.at(-2).url, /\/201\/activate$/);
  assert.match(toggles.at(-1).url, /\/202\/deactivate$/);
  assert.equal(gas.rollbackGlobalFooterToLegacy().alreadyRolledBack, true);
});

test('switch preflight, cancel i failure paths nie ukrywają niepotwierdzonego stanu', () => {
  const seed = project();
  const props = migrationProps();

  let router = makeRouter({ loader: buildLoader(seed, 202, false, { code: 'mismatch' }) });
  let gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.switchGlobalFooterToLoader(), /preflightu kodu/);

  router = makeRouter({ loader: buildLoader(seed, 202, false, { code_error: ['bad', 1] }) });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.switchGlobalFooterToLoader(), /preflightu kodu/);

  router = makeRouter({ loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, true) });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.switchGlobalFooterToLoader(), /Stan aktywacji/);

  router = makeRouter({ loader: buildLoader(seed) });
  gas = project({ router, properties: props, uiAnswer: 'NO' });
  assert.deepEqual(plain(gas.switchGlobalFooterToLoader()), { cancelled: true });
  assert.equal(router.state.calls.filter(call => /\/(activate|deactivate)$/.test(new URL(call.url).pathname)).length, 0);

  router = makeRouter({ loader: buildLoader(seed), failLoaderActivation: true });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.switchGlobalFooterToLoader(), /Nie potwierdzono aktywacji/);
  assert.equal(router.state.legacy.active, true);

  router = makeRouter({ loader: buildLoader(seed), failLegacyDeactivation: true });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.switchGlobalFooterToLoader(), /podwójna stopka/);
  assert.equal(router.state.loader.active, true);
  assert.equal(router.state.legacy.active, true);
});

test('rollback działa przy uszkodzonym źródle i odzyskuje stan double-active', () => {
  const seed = project();
  const props = migrationProps();

  let router = makeRouter({ source: null, loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, false) });
  let gas = project({ router, properties: props, uiAnswer: 'YES' });
  let rolled = gas.rollbackGlobalFooterToLegacy();
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.recoveredDoubleActive, false);
  assert.equal(router.state.legacy.active, true);
  assert.equal(router.state.loader.active, false);
  assert.equal(router.state.calls.some(call => new URL(call.url).pathname.startsWith('/wp-json/wp/v2/pages')), false);

  router = makeRouter({ source: null, loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, true) });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  rolled = gas.rollbackGlobalFooterToLegacy();
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.recoveredDoubleActive, true);
  assert.equal(router.state.legacy.active, true);
  assert.equal(router.state.loader.active, false);
  const toggles = router.state.calls.filter(call => /\/(activate|deactivate)$/.test(new URL(call.url).pathname));
  assert.equal(toggles.length, 1);
  assert.match(toggles[0].url, /\/202\/deactivate$/);
});

test('rollback cancel i failure paths nigdy nie wyłączają jedynej działającej wersji', () => {
  const seed = project();
  const props = migrationProps();

  let router = makeRouter({ loader: buildLoader(seed, 202, false), legacy: legacySnippet(201, false) });
  let gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.rollbackGlobalFooterToLegacy(), /Rollback wymaga/);

  router = makeRouter({ loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, false) });
  gas = project({ router, properties: props, uiAnswer: 'NO' });
  assert.deepEqual(plain(gas.rollbackGlobalFooterToLegacy()), { cancelled: true });

  router = makeRouter({ loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, false), failLegacyActivation: true });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.rollbackGlobalFooterToLegacy(), /Nie potwierdzono aktywacji starego/);
  assert.equal(router.state.loader.active, true);

  router = makeRouter({ loader: buildLoader(seed, 202, true), legacy: legacySnippet(201, false), failLoaderDeactivation: true });
  gas = project({ router, properties: props, uiAnswer: 'YES' });
  assert.throws(() => gas.rollbackGlobalFooterToLegacy(), /podwójna stopka/);
  assert.equal(router.state.legacy.active, true);
  assert.equal(router.state.loader.active, true);
});

test('write helpers sukces i lock-busy są jawne', () => {
  let router = makeRouter();
  let gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' } });
  const created = gas.createInactiveCodeSnippet_({ name: 'x', code: 'y', active: true });
  assert.equal(created.active, false);
  assert.equal(gas.setCodeSnippetActive_(created.id, true).active, true);
  assert.equal(gas.setCodeSnippetActive_(created.id, false).active, false);

  router = makeRouter();
  gas = project({ router, properties: { WP_ALLOW_WRITES: 'TRUE' }, lockHeld: true });
  assert.throws(() => gas.prepareGlobalFooterLoader(), /inne uruchomienie|trwa/i);
});
