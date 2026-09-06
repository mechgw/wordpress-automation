'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadProject, plain } = require('./helpers/gas');

const ROOT = path.resolve(__dirname, '..');
const FOOTER_MIGRATION_CODE = fs.readFileSync(path.join(ROOT, 'GlobalFooterMigration.gs'), 'utf8');
const RESULTS_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];
const SNAPSHOTS_HEADER = ['snapshot_id', 'command_id', 'wp_id', 'slug', 'title_before', 'excerpt_before', 'content_before', 'status_before', 'modified_before', 'created_at', 'rank_math_title_before', 'rank_math_description_before', 'rank_math_captured', 'snapshot_kind', 'media_before_json', 'code_snippet_before_json', 'code_snippet_code_chunk'];
const PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_ALLOW_WRITES: 'TRUE',
  WP_REST_NAMESPACE: 'example',
  WP_B2B_FORM_ID: '321'
};

function makeProject({ properties = {}, fetch, answer = 'YES' } = {}) {
  const gas = loadProject({
    properties: Object.assign({}, PROPS, properties),
    sheets: {
      'WP RESULTS': [RESULTS_HEADER],
      'WP SNAPSHOTS': [SNAPSHOTS_HEADER],
      'FORMINATOR B2B HISTORY': [['submission_id', 'time_created', 'submission_date_norm', 'imported_at']]
    },
    fetch: fetch || (() => ({ code: 200, json: [], headers: {} }))
  });
  vm.runInContext(FOOTER_MIGRATION_CODE, gas, { filename: path.join(ROOT, 'GlobalFooterMigration.gs') });
  gas.$ui.$answer = answer;
  return gas;
}

function makeSnippet(gas, active = false) {
  return {
    id: 401,
    name: 'Form Submission History Bridge',
    desc: 'history',
    code: gas.buildForminatorHistoryBridgeCode_(),
    scope: 'global',
    active,
    priority: 10,
    condition_id: 0,
    tags: ['forminator-submission-history-bridge'],
    code_error: null,
    modified: '2026-09-05T20:00:00+00:00'
  };
}

function existingSnippetRouter(state) {
  return (url, params = {}) => {
    const parsed = new URL(url);
    const method = String(params.method || 'get').toLowerCase();
    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets' && method === 'get') {
      return { code: 200, json: state.snippet ? [state.snippet] : [], headers: { 'X-WP-TotalPages': '1' } };
    }
    if (parsed.pathname === '/wp-json/code-snippets/v1/snippets/401' && method === 'get') {
      return { code: 200, json: state.snippet, headers: {} };
    }
    throw new Error('unexpected request: ' + method + ' ' + url);
  };
}

test('config requires REST namespace and snippet validation requires numeric ID', () => {
  let gas = makeProject({ properties: { WP_REST_NAMESPACE: '' } });
  assert.throws(() => gas.getForminatorHistoryConfig_(), /brak Script Property WP_REST_NAMESPACE/);

  gas = makeProject();
  const expected = gas.buildForminatorHistoryBridgeCode_();
  assert.throws(
    () => gas.validateForminatorHistorySnippet_({ id: 'bad', code: expected, scope: 'global' }, expected),
    /nie ma prawidłowego ID/
  );
});

test('prepare reuses a valid inactive managed snippet', () => {
  const state = { snippet: null };
  const gas = makeProject({ fetch: existingSnippetRouter(state) });
  state.snippet = makeSnippet(gas, false);

  const result = plain(gas.prepareForminatorHistoryBridge());
  assert.equal(result.snippetId, 401);
  assert.equal(result.created, false);
  assert.equal(result.active, false);
  assert.equal(gas.$properties.WP_FORMINATOR_HISTORY_SNIPPET_ID, '401');
});

test('prepare refuses an already-active managed snippet', () => {
  const state = { snippet: null };
  const gas = makeProject({ fetch: existingSnippetRouter(state) });
  state.snippet = makeSnippet(gas, true);

  assert.throws(() => gas.prepareForminatorHistoryBridge(), /jest już aktywny/);
});

test('activation and rollback can both be cancelled before any WordPress request', () => {
  let calls = 0;
  let gas = makeProject({
    properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' },
    answer: 'NO',
    fetch: () => { calls += 1; throw new Error('fetch should not run'); }
  });
  assert.deepEqual(plain(gas.activateForminatorHistoryBridge()), { cancelled: true });
  assert.equal(calls, 0);

  gas = makeProject({
    properties: { WP_FORMINATOR_HISTORY_SNIPPET_ID: '401' },
    answer: 'NO',
    fetch: () => { calls += 1; throw new Error('fetch should not run'); }
  });
  assert.deepEqual(plain(gas.rollbackForminatorHistoryBridge()), { cancelled: true });
  assert.equal(calls, 0);
});
