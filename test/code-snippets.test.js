'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'CodeSnippets.gs'), 'utf8');

function load({ fetch, hasResults = true } = {}) {
  const rows = [[
    'result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title',
    'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'
  ]];
  const alerts = [];
  let uuid = 0;

  const context = {
    console,
    Date,
    encodeURIComponent,
    Utilities: {
      formatDate: () => '20260905-183500',
      getUuid: () => `uuid${++uuid}xxx`
    },
    Session: { getScriptTimeZone: () => 'Europe/Warsaw' },
    wpFetch_: fetch || (() => ({ code: 200, json: [], headers: {} })),
    wpError_: (code, text) => {
      const error = new Error(`WordPress REST API HTTP ${code}: ${text}`);
      error.httpCode = code;
      return error;
    },
    SpreadsheetApp: {
      getActive: () => ({
        getSheetByName: name => name === 'WP RESULTS' && hasResults
          ? {
              appendRow: row => rows.push(row.slice()),
              getLastRow: () => rows.length
            }
          : null
      }),
      getUi: () => ({ alert: text => alerts.push(text) })
    }
  };

  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'CodeSnippets.gs' });
  context.$rows = rows;
  context.$alerts = alerts;
  return context;
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

  const gas = load({
    fetch: requestPath => {
      calls.push(requestPath);
      if (requestPath.endsWith('&page=1')) {
        return {
          code: 200,
          json: [{ id: 7 }, { id: 8 }],
          headers: { 'X-WP-TotalPages': '2' }
        };
      }
      if (requestPath.endsWith('&page=2')) {
        return {
          code: 200,
          json: [{ id: 9 }],
          headers: { 'x-wp-totalpages': '2' }
        };
      }
      const id = Number(requestPath.split('/').pop());
      return { code: 200, json: details[id], headers: {} };
    }
  });

  const result = gas.discoverCodeSnippets();

  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { count: 3, resultRef: 'WP RESULTS!A2:M4' }
  );
  assert.equal(calls.length, 5);
  assert.equal(gas.$rows[1][4], 'active');
  assert.equal(gas.$rows[2][4], 'inactive');
  assert.equal(gas.$rows[1][12], 'CODE_SNIPPET');
  assert.deepEqual(JSON.parse(gas.$rows[1][8]), {
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
  assert.deepEqual(JSON.parse(gas.$rows[3][8]).tags, []);
  assert.match(gas.$alerts[0], /Pobrane snippety: 3/);
});

test('pusta lista kończy discovery bez wierszy', () => {
  const gas = load({
    fetch: () => ({ code: 200, json: [], headers: { 'X-Wp-Totalpages': '1' } })
  });

  const result = gas.discoverCodeSnippets();

  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    { count: 0, resultRef: '' }
  );
  assert.equal(gas.$rows.length, 1);
  assert.match(gas.$alerts[0], /Brak snippetów do zapisania/);
});

test('błędy HTTP i walidacja ID są jawne', () => {
  let gas = load({ fetch: () => ({ code: 403, text: 'forbidden' }) });
  assert.throws(() => gas.getCodeSnippetsList_(), /HTTP 403/);

  gas = load();
  assert.throws(() => gas.getCodeSnippetRaw_('abc'), /numeryczne ID/);

  gas = load({
    fetch: requestPath => requestPath.endsWith('/7')
      ? { code: 500, text: 'boom' }
      : { code: 200, json: [{ id: 7 }], headers: {} }
  });
  assert.throws(() => gas.getCodeSnippetRaw_(7), /HTTP 500/);
});

test('zapis wymaga WP RESULTS i obsługuje brak nazwy oraz command_id', () => {
  let gas = load({ hasResults: false });
  assert.throws(
    () => gas.saveCodeSnippetResult_({ id: 1 }, ''),
    /Brak arkusza WP RESULTS/
  );

  gas = load();
  const saved = gas.saveCodeSnippetResult_({ id: 1, active: false }, '');

  assert.match(saved.message, /bez nazwy/);
  assert.equal(gas.$rows[1][1], '');
  assert.equal(gas.$rows[1][7], '');
});
