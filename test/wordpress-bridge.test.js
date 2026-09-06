'use strict';

/**
 * WordPress bridge flows that go through the dedicated REST endpoints
 * (WP_REST_NAMESPACE): the Rank Math test, Rank Math reads/writes and the
 * page-layout get/copy commands. Each suite asserts the request shape, the
 * result written to the sheet and every named failure path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl/',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'secret pass',
  WP_REST_NAMESPACE: 'acme'
};
const WRITE_PROPS = { ...BASE_PROPS, WP_ALLOW_WRITES: 'TRUE' };
const RESULTS_SHEET = () => ({
  'WP RESULTS': [['result_id', 'command_id', 'page_id', 'slug', 'status', 'link', 'title', 'modified', 'json', 'at', '', '', 'kind']]
});

describe('WordPress.gs testRankMathBridge', () => {
  const pagesRoute = body => ['/wp-json/wp/v2/pages?context=edit&per_page=1', { code: 200, json: body }];
  const bridgeRoute = code => ['/wp-json/acme/v1/seo-meta', { code, text: code === 200 ? '{"ok":true}' : 'bridge down' }];

  test('reads a page, probes the bridge endpoint and reports success with the version', () => {
    const gas = loadProject({
      properties: BASE_PROPS,
      fetch: fetchRouter([pagesRoute([{ id: 5, slug: 'sample-page', cc_rank_math: { title: 'T' } }]), bridgeRoute(200)])
    });
    gas.testRankMathBridge();
    assert.equal(gas.$fetchCalls.length, 2);
    assert.match(gas.$fetchCalls[0].url, /_fields=id,slug,cc_rank_math,cc_rank_math_robots$/);
    assert.equal(gas.$fetchCalls[1].url, 'https://www.example.pl/wp-json/acme/v1/seo-meta');
    assert.equal(gas.$alerts.length, 1);
    const text = gas.$alerts[0][0];
    assert.match(text, /^Rank Math bridge działa \(wersja dev\)\./);
    assert.match(text, /Strona testowa: sample-page/);
    assert.match(text, /Dedykowany endpoint zapisu: OK/);
  });

  test('a non-2xx page listing surfaces as a WordPress REST error with the code', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 401, text: 'nope' }) });
    assert.throws(() => gas.testRankMathBridge(), err => err.httpCode === 401 && /HTTP 401: nope/.test(err.message));
    assert.equal(gas.$alerts.length, 0);
  });

  test('an empty page list is reported as such', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: fetchRouter([pagesRoute([])]) });
    assert.throws(() => gas.testRankMathBridge(), /nie zwrócił żadnej strony/);
  });

  test('a page without cc_rank_math points at the WordPress snippet', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: fetchRouter([pagesRoute([{ id: 5, slug: 'x' }])]) });
    assert.throws(() => gas.testRankMathBridge(), /Brak pola cc_rank_math.*Rank Math REST bridge/);
    assert.equal(gas.$fetchCalls.length, 1, 'bridge endpoint not probed');
  });

  test('a failing bridge endpoint names the path and the HTTP code', () => {
    const gas = loadProject({
      properties: BASE_PROPS,
      fetch: fetchRouter([pagesRoute([{ id: 5, slug: 'x', cc_rank_math: {} }]), bridgeRoute(500)])
    });
    assert.throws(
      () => gas.testRankMathBridge(),
      /endpoint zapisu \(\/wp-json\/acme\/v1\/seo-meta\) nie odpowiada\. HTTP 500\n\nbridge down/
    );
  });
});

describe('WordPress.gs getPageRawById_', () => {
  test('fetches the page in edit context with the Rank Math field', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 200, json: { id: 12, slug: 'p', cc_rank_math: { title: 'x' } } }) });
    const page = gas.getPageRawById_(12, true);
    assert.match(gas.$fetchCalls[0].url, /\/wp-json\/wp\/v2\/pages\/12\?context=edit&_fields=.*cc_rank_math,cc_rank_math_robots$/);
    assert.equal(plain(page).slug, 'p');
  });

  test('requireRankMath rejects a page without the field, a plain read accepts it', () => {
    const make = () => loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 200, json: { id: 12, slug: 'p' } }) });
    assert.throws(() => make().getPageRawById_(12, true), /Brak pola cc_rank_math.*Rank Math REST read/);
    assert.equal(plain(make().getPageRawById_(12)).id, 12);
  });

  test('non-2xx becomes a WordPress REST error', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 404, text: 'missing' }) });
    assert.throws(() => gas.getPageRawById_(12), err => err.httpCode === 404);
  });
});

describe('WordPress.gs writeRankMathField_', () => {
  test('posts the whitelisted field to the bridge endpoint', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 200, json: { ok: true } }) });
    const res = gas.writeRankMathField_('7', 'rank_math_title', 'New title');
    const call = gas.$fetchCalls[0];
    assert.equal(call.url, 'https://www.example.pl/wp-json/acme/v1/seo-meta');
    assert.equal(call.params.method, 'post');
    assert.deepEqual(JSON.parse(call.params.payload), { post_id: 7, field: 'rank_math_title', value: 'New title' });
    assert.equal(res.code, 200);
  });

  test('null or undefined value is sent as an empty string', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 200, json: {} }) });
    gas.writeRankMathField_(7, 'rank_math_description', null);
    assert.equal(JSON.parse(gas.$fetchCalls[0].params.payload).value, '');
  });

  test('rejects fields outside the whitelist before any request', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.writeRankMathField_(7, 'post_title', 'x'), /Niedozwolone pole Rank Math: post_title/);
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('non-2xx from the bridge becomes a WordPress REST error', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 403, text: 'forbidden' }) });
    assert.throws(() => gas.writeRankMathField_(7, 'rank_math_title', 'x'), err => err.httpCode === 403);
  });
});

describe('WordPress.gs getPageLayout_', () => {
  const layout = {
    target: { id: 7, slug: 'home', status: 'publish', link: 'https://www.example.pl/', title: 'Home', modified: '2026-09-01T10:00:00' },
    changed: null
  };

  test('reads the layout through the bridge and records a LAYOUT result row', () => {
    const gas = loadProject({ properties: BASE_PROPS, sheets: RESULTS_SHEET(), fetch: () => ({ code: 200, json: layout }) });
    const out = gas.getPageLayout_('7', 'CMD-1');
    assert.equal(gas.$fetchCalls[0].url, 'https://www.example.pl/wp-json/acme/v1/page-layout?post_id=7');
    assert.equal(gas.$fetchCalls[0].params.method, 'get');
    const rows = gas.$sheet('WP RESULTS');
    assert.equal(rows.length, 2, 'one result row appended');
    const row = rows[1];
    assert.match(row[0], /^WP-L-\d{8}-\d{6}-00000000$/);
    assert.equal(row[1], 'CMD-1');
    assert.equal(row[2], 7);
    assert.equal(row[3], 'home');
    assert.equal(row[6], 'Home');
    assert.equal(JSON.parse(row[8]).kind, 'PAGE_LAYOUT');
    assert.equal(row[12], 'LAYOUT');
    assert.equal(out.httpCode, 200);
    assert.equal(out.resultRef, 'WP RESULTS!A2:M2');
    assert.match(out.message, /ID 7\./);
  });

  test('rejects a non-numeric page id before any request', () => {
    const gas = loadProject({ properties: BASE_PROPS, sheets: RESULTS_SHEET() });
    assert.throws(() => gas.getPageLayout_('home', 'CMD-1'), /GET_PAGE_LAYOUT wymaga numerycznego ID/);
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('non-2xx from the bridge becomes a WordPress REST error and writes nothing', () => {
    const gas = loadProject({ properties: BASE_PROPS, sheets: RESULTS_SHEET(), fetch: () => ({ code: 500, text: 'boom' }) });
    assert.throws(() => gas.getPageLayout_('7', 'CMD-1'), err => err.httpCode === 500);
    assert.equal(gas.$sheet('WP RESULTS').length, 1);
  });

  test('a missing results sheet is reported after a successful read', () => {
    const gas = loadProject({ properties: BASE_PROPS, sheets: {}, fetch: () => ({ code: 200, json: layout }) });
    assert.throws(() => gas.getPageLayout_('7', 'CMD-1'), /Brak arkusza WP RESULTS/);
  });
});

describe('WordPress.gs copyPageLayout_', () => {
  const command = { id: 'CMD-9', target: '7', field: '9', confirm: 'YES' };
  const response = {
    source: { id: 9 },
    target: { id: 7, slug: 'home', status: 'publish', link: 'https://www.example.pl/', title: 'Home', modified: '2026-09-01' },
    changed: ['layout']
  };

  test('posts target and source ids, records the result and describes the copy', () => {
    const gas = loadProject({ properties: WRITE_PROPS, sheets: RESULTS_SHEET(), fetch: () => ({ code: 200, json: response }) });
    const out = gas.copyPageLayout_(command);
    const call = gas.$fetchCalls[0];
    assert.equal(call.url, 'https://www.example.pl/wp-json/acme/v1/page-layout');
    assert.equal(call.params.method, 'post');
    assert.deepEqual(JSON.parse(call.params.payload), { target_post_id: 7, source_post_id: 9 });
    assert.equal(gas.$sheet('WP RESULTS').length, 2);
    assert.equal(gas.$sheet('WP RESULTS')[1][1], 'CMD-9');
    assert.equal(out.httpCode, 200);
    assert.equal(out.message, 'Skopiowano układ strony ID 9 → ID 7. Zmiana potwierdzona odczytem kontrolnym.');
    assert.equal(out.resultRef, 'WP RESULTS!A2:M2');
  });

  test('refuses when writes are disabled, before any request', () => {
    const gas = loadProject({ properties: BASE_PROPS, sheets: RESULTS_SHEET(), fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.copyPageLayout_(command), /Zapisy do WordPressa są wyłączone/);
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('validates confirm, numeric ids and distinct pages', () => {
    const make = () => loadProject({ properties: WRITE_PROPS, sheets: RESULTS_SHEET(), fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => make().copyPageLayout_({ ...command, confirm: 'yes' }), /Brak potwierdzenia YES/);
    assert.throws(() => make().copyPageLayout_({ ...command, target: 'home' }), /numerycznego ID strony docelowej/);
    assert.throws(() => make().copyPageLayout_({ ...command, field: '' }), /numerycznego ID strony wzorcowej/);
    assert.throws(() => make().copyPageLayout_({ ...command, field: '7' }), /nie mogą mieć tego samego ID/);
  });

  test('non-2xx from the bridge becomes a WordPress REST error and writes nothing', () => {
    const gas = loadProject({ properties: WRITE_PROPS, sheets: RESULTS_SHEET(), fetch: () => ({ code: 502, text: 'bad gateway' }) });
    assert.throws(() => gas.copyPageLayout_(command), err => err.httpCode === 502 && /bad gateway/.test(err.message));
    assert.equal(gas.$sheet('WP RESULTS').length, 1);
  });
});
