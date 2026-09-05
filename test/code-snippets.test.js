'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw'
};

const RESULTS_HEADER = [
  'result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title',
  'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'
];

function project({ fetch, withResults = true } = {}) {
  return loadProject({
    properties: PROPS,
    sheets: withResults ? { 'WP RESULTS': [RESULTS_HEADER] } : {},
    fetch: fetch || (() => ({ code: 200, json: [], headers: {} }))
  });
}

test('discovery paginuje, pobiera pełne rekordy i zapisuje wyniki', () => {
  const calls = [];
  const details = {
    7: {
      id: 7,
      name: 'Footer',
      desc: 'Global',
      code: '<footer>...</footer>',
      scope: 'global',
      active: true,
      priority: 10,
      condition_id: 0,
      tags: ['footer'],
      modified: '2026-09-05'
    },
    8: {
      id: 8,
      display_name: 'Bridge',
      description: 'REST',
      code: 'return true;',
      scope: 'global',
      active: false
    },
    9: { id: 9, code: 'x', scope: '', active: false, tags: 'bad' }
  };

  const gas = project({
    fetch: url => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/wp-json/code-snippets/v1/snippets') {
        if (parsed.searchParams.get('page') === '1') {
          return {
            code: 200,
            json: [{ id: 7 }, { id: 8 }],
            headers: { 'X-WP-TotalPages': '2' }
          };
        }
        return {
          code: 200,
          json: [{ id: 9 }],
          headers: { 'x-wp-totalpages': '2' }
        };
      }
      const id = Number(parsed.pathname.split('/').pop());
      return { code: 200, json: details[id], headers: {} };
    }
  });

  const result = gas.discoverCodeSnippets();
  const rows = gas.$sheet('WP RESULTS');

  assert.deepEqual(plain(result), { count: 3, resultRef: 'WP RESULTS!A2:M4' });
  assert.equal(calls.length, 5);
  assert.equal(rows[1][4], 'active');
  assert.equal(rows[2][4], 'inactive');
  assert.equal(rows[1][12], 'CODE_SNIPPET');
  assert.deepEqual(JSON.parse(rows[1][8]), {
    kind: 'CODE_SNIPPET',
    id: 7,
    name: 'Footer',
    description: 'Global',
    code: '<footer>...</footer>',
    scope: 'global',
    active: true,
    priority: 10,
    condition_id: 0,
    tags: ['footer']
  });
  assert.deepEqual(JSON.parse(rows[3][8]).tags, []);
  assert.match(String(gas.$alerts[0][0]), /Pobrane snippety: 3/);
});

test('pusta lista kończy discovery bez wierszy', () => {
  const gas = project({
    fetch: () => ({ code: 200, json: [], headers: { 'X-Wp-Totalpages': '1' } })
  });

  const result = gas.discoverCodeSnippets();

  assert.deepEqual(plain(result), { count: 0, resultRef: '' });
  assert.equal(gas.$sheet('WP RESULTS').length, 1);
  assert.match(String(gas.$alerts[0][0]), /Brak snippetów do zapisania/);
});

test('błędy HTTP i walidacja ID są jawne', () => {
  let gas = project({ fetch: () => ({ code: 403, text: 'forbidden' }) });
  assert.throws(() => gas.getCodeSnippetsList_(), /HTTP 403/);

  gas = project();
  assert.throws(() => gas.getCodeSnippetRaw_('abc'), /numeryczne ID/);

  gas = project({ fetch: () => ({ code: 500, text: 'boom' }) });
  assert.throws(() => gas.getCodeSnippetRaw_(7), /HTTP 500/);
});

test('zapis wymaga WP RESULTS i obsługuje brak nazwy oraz command_id', () => {
  let gas = project({ withResults: false });
  assert.throws(
    () => gas.saveCodeSnippetResult_({ id: 1 }, ''),
    /Brak arkusza WP RESULTS/
  );

  gas = project();
  const saved = gas.saveCodeSnippetResult_({ id: 1, active: false }, '');
  const row = gas.$sheet('WP RESULTS')[1];

  assert.match(saved.message, /bez nazwy/);
  assert.equal(row[1], '');
  assert.equal(row[7], '');
});
