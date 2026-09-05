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

function project({ fetch, withResults = true, lockHeld = false } = {}) {
  return loadProject({
    properties: PROPS,
    sheets: withResults ? { 'WP RESULTS': [RESULTS_HEADER] } : {},
    fetch: fetch || (() => ({ code: 200, json: [], headers: {} })),
    lockHeld
  });
}

test('discovery pod lockiem paginuje, używa context=edit i zapisuje kod w osobnych wierszach', () => {
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
      assert.equal(parsed.searchParams.get('context'), 'edit');

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

  assert.deepEqual(plain(result), { count: 3, resultRef: 'WP RESULTS!A2:M7' });
  assert.equal(calls.length, 5);
  assert.deepEqual(gas.$lock.slice(), [['tryLock', 3000], ['releaseLock']]);

  assert.equal(rows[1][4], 'active');
  assert.equal(rows[1][12], 'CODE_SNIPPET');
  assert.deepEqual(JSON.parse(rows[1][8]), {
    kind: 'CODE_SNIPPET',
    id: 7,
    name: 'Footer',
    description: 'Global',
    scope: 'global',
    active: true,
    priority: 10,
    condition_id: 0,
    tags: ['footer'],
    code_length: 20,
    code_chunks: 1
  });
  assert.equal(rows[2][3], 'code:1/1');
  assert.equal(rows[2][8], '<footer>...</footer>');
  assert.equal(rows[2][12], 'CODE_SNIPPET_CODE');

  assert.equal(rows[3][4], 'inactive');
  assert.equal(JSON.parse(rows[3][8]).name, 'Bridge');
  assert.equal(JSON.parse(rows[3][8]).description, 'REST');
  assert.deepEqual(JSON.parse(rows[5][8]).tags, []);
  assert.match(String(gas.$alerts[0][0]), /Pobrane snippety: 3/);
});

test('pusta lista bez nagłówka paginacji kończy discovery bez wierszy', () => {
  const gas = project({
    fetch: () => ({ code: 200, json: [], headers: {} })
  });

  const result = gas.discoverCodeSnippets();

  assert.deepEqual(plain(result), { count: 0, resultRef: '' });
  assert.equal(gas.$sheet('WP RESULTS').length, 1);
  assert.match(String(gas.$alerts[0][0]), /Brak snippetów do zapisania/);
});

test('duży kod jest dzielony na części znacznie poniżej limitu komórki Sheets', () => {
  const code = 'x'.repeat(65001);
  const gas = project();

  const saved = gas.saveCodeSnippetResult_({ id: 42, code, active: false }, 'CMD-LARGE');
  const rows = gas.$sheet('WP RESULTS');
  const meta = JSON.parse(rows[1][8]);
  const chunks = rows.slice(2).map(row => row[8]);

  assert.equal(meta.code_length, 65001);
  assert.equal(meta.code_chunks, 3);
  assert.equal(rows.length, 5);
  assert.ok(chunks.every(chunk => chunk.length <= 30000));
  assert.equal(chunks.join(''), code);
  assert.equal(rows[2][6], 'Code Snippet [kod 1/3]');
  assert.equal(saved.resultRef, 'WP RESULTS!A2:M5');
  assert.equal(saved.firstRow, 2);
  assert.equal(saved.lastRow, 5);
});

test('błędy HTTP i walidacja ID są jawne', () => {
  let gas = project({ fetch: () => ({ code: 403, text: 'forbidden' }) });
  assert.throws(() => gas.getCodeSnippetsList_(), /HTTP 403/);

  gas = project();
  assert.throws(() => gas.getCodeSnippetRaw_('abc'), /numeryczne ID/);

  gas = project({ fetch: () => ({ code: 500, text: 'boom' }) });
  assert.throws(() => gas.getCodeSnippetRaw_(7), /HTTP 500/);
});

test('discovery odmawia startu, gdy wspólny lock jest zajęty', () => {
  const gas = project({ lockHeld: true });

  assert.throws(() => gas.discoverCodeSnippets(), /inne uruchomienie|trwa/i);
  assert.equal(gas.$fetchCalls.length, 0);
});

test('zapis wymaga wspólnego WP_RESULTS_SHEET i obsługuje pusty kod oraz command_id', () => {
  let gas = project({ withResults: false });
  assert.throws(
    () => gas.saveCodeSnippetResult_({ id: 1 }, ''),
    /Brak arkusza WP RESULTS/
  );

  gas = project();
  const saved = gas.saveCodeSnippetResult_({ id: 1, active: false }, '');
  const row = gas.$sheet('WP RESULTS')[1];
  const meta = JSON.parse(row[8]);

  assert.match(saved.message, /bez nazwy/);
  assert.equal(row[1], '');
  assert.equal(row[7], '');
  assert.equal(meta.code_length, 0);
  assert.equal(meta.code_chunks, 0);
  assert.equal(gas.$sheet('WP RESULTS').length, 2, 'pusty kod nie tworzy wiersza CODE_SNIPPET_CODE');
});
