'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl/',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'secret pass',
  WP_REST_NAMESPACE: 'acme'
};

describe('WordPress.gs getWpConfig_', () => {
  test('reads properties, strips the trailing slash and defaults writes to off', () => {
    const gas = loadProject({ properties: BASE_PROPS });
    const cfg = gas.getWpConfig_();
    assert.equal(cfg.baseUrl, 'https://www.example.pl');
    assert.equal(cfg.username, 'bot');
    assert.equal(cfg.allowWrites, false);
    assert.equal(cfg.restNamespace, 'acme');
  });

  test('allowWrites only for the literal TRUE', () => {
    assert.equal(loadProject({ properties: { ...BASE_PROPS, WP_ALLOW_WRITES: 'TRUE' } }).getWpConfig_().allowWrites, true);
    assert.equal(loadProject({ properties: { ...BASE_PROPS, WP_ALLOW_WRITES: 'true' } }).getWpConfig_().allowWrites, false);
    assert.equal(loadProject({ properties: { ...BASE_PROPS, WP_ALLOW_WRITES: 'yes' } }).getWpConfig_().allowWrites, false);
  });

  test('names the missing property in the error', () => {
    for (const key of ['WP_BASE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD']) {
      const props = { ...BASE_PROPS };
      delete props[key];
      assert.throws(() => loadProject({ properties: props }).getWpConfig_(), new RegExp('Brak Script Property: ' + key));
    }
  });

  test('trims and un-slashes the namespace, rejects anything else', () => {
    assert.equal(loadProject({ properties: { ...BASE_PROPS, WP_REST_NAMESPACE: ' /acme/ ' } }).getWpConfig_().restNamespace, 'acme');
    assert.equal(loadProject({ properties: { ...BASE_PROPS, WP_REST_NAMESPACE: 'my-site_1' } }).getWpConfig_().restNamespace, 'my-site_1');
    assert.throws(() => loadProject({ properties: { ...BASE_PROPS, WP_REST_NAMESPACE: 'acme/v1' } }).getWpConfig_(), /Nieprawidłowa Script Property WP_REST_NAMESPACE/);
    assert.throws(() => loadProject({ properties: { ...BASE_PROPS, WP_REST_NAMESPACE: 'ac me' } }).getWpConfig_(), /WP_REST_NAMESPACE/);
  });
});

describe('WordPress.gs wpBridgePath_', () => {
  test('builds /wp-json/<ns>/v1/<endpoint>', () => {
    const gas = loadProject({ properties: BASE_PROPS });
    assert.equal(gas.wpBridgePath_('seo-meta'), '/wp-json/acme/v1/seo-meta');
    assert.equal(gas.wpBridgePath_('/page-layout'), '/wp-json/acme/v1/page-layout');
  });

  test('fails loudly without WP_REST_NAMESPACE', () => {
    const props = { ...BASE_PROPS };
    delete props.WP_REST_NAMESPACE;
    const gas = loadProject({ properties: props });
    assert.throws(() => gas.wpBridgePath_('seo-meta'), /Brak Script Property: WP_REST_NAMESPACE/);
  });
});

describe('WordPress.gs wpFetch_', () => {
  test('sends Basic auth, JSON payload and parses the JSON response', () => {
    const gas = loadProject({
      properties: BASE_PROPS,
      fetch: () => ({ code: 201, text: '{"id":7}', headers: { 'X-Test': '1' } })
    });
    const res = gas.wpFetch_('/wp-json/wp/v2/pages', { method: 'post', payload: { title: 'x' } });
    const call = gas.$fetchCalls[0];
    assert.equal(call.url, 'https://www.example.pl/wp-json/wp/v2/pages');
    assert.equal(call.params.method, 'post');
    assert.equal(call.params.muteHttpExceptions, true);
    assert.equal(call.params.contentType, 'application/json');
    assert.equal(call.params.payload, '{"title":"x"}');
    assert.equal(call.params.headers.Authorization, 'Basic ' + Buffer.from('bot:secret pass').toString('base64'));
    assert.equal(call.params.headers.Accept, 'application/json');
    assert.equal(res.code, 201);
    assert.deepEqual(plain(res.json), { id: 7 });
    assert.deepEqual(plain(res.headers), { 'X-Test': '1' });
  });

  test('defaults to GET without payload and tolerates non-JSON bodies', () => {
    const gas = loadProject({ properties: BASE_PROPS, fetch: () => ({ code: 500, text: '<html>boom</html>' }) });
    const res = gas.wpFetch_('/wp-json/wp/v2/pages');
    const call = gas.$fetchCalls[0];
    assert.equal(call.params.method, 'get');
    assert.equal('payload' in call.params, false);
    assert.equal(res.code, 500);
    assert.equal(res.json, null);
    assert.equal(res.text, '<html>boom</html>');
  });
});

describe('WordPress.gs response helpers', () => {
  const gas = loadProject({ properties: BASE_PROPS });

  test('getRawValue_ prefers raw, then rendered, then stringifies', () => {
    assert.equal(gas.getRawValue_(null), '');
    assert.equal(gas.getRawValue_(undefined), '');
    assert.equal(gas.getRawValue_('plain'), 'plain');
    assert.equal(gas.getRawValue_({ raw: 'Raw title', rendered: 'Rendered' }), 'Raw title');
    assert.equal(gas.getRawValue_({ rendered: 'Rendered' }), 'Rendered');
    assert.equal(gas.getRawValue_({ raw: '' }), '');
    assert.equal(gas.getRawValue_(42), '42');
  });

  test('extractResultRow_ reads the row number from an A1 result reference', () => {
    assert.equal(gas.extractResultRow_("'WP RESULTS'!A12:H12"), 12);
    assert.equal(gas.extractResultRow_('WP RESULTS!A3:Z3'), 3);
    assert.equal(gas.extractResultRow_('nonsense'), null);
    assert.equal(gas.extractResultRow_(''), null);
  });

  test('wpError_ carries the HTTP code and truncates the body', () => {
    const err = gas.wpError_(403, 'x'.repeat(5000));
    assert.equal(err.httpCode, 403);
    assert.match(err.message, /^WordPress REST API HTTP 403: x+$/);
    assert.equal(err.message.length, 'WordPress REST API HTTP 403: '.length + 3000);
  });

  test('getRankMathData_ reports availability and defaults', () => {
    assert.deepEqual(plain(gas.getRankMathData_({ cc_rank_math: { title: 'T', description: 'D' } })), { available: true, title: 'T', description: 'D' });
    assert.deepEqual(plain(gas.getRankMathData_({ cc_rank_math: null })), { available: true, title: '', description: '' });
    assert.deepEqual(plain(gas.getRankMathData_({})), { available: false, title: '', description: '' });
    assert.deepEqual(plain(gas.getRankMathData_(null)), { available: false, title: '', description: '' });
  });
});
