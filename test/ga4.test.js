'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, fetchRouter } = require('./helpers/gas');

describe('GA4.gs hostname / domain helpers', () => {
  const gas = loadProject();

  test('extractHostname_ strips scheme, www and path', () => {
    assert.equal(gas.extractHostname_('https://www.example.pl/some/path?x=1'), 'example.pl');
    assert.equal(gas.extractHostname_('http://shop.example.pl'), 'shop.example.pl');
    assert.equal(gas.extractHostname_('  example.pl  '), 'example.pl');
    assert.equal(gas.extractHostname_(''), '');
    assert.equal(gas.extractHostname_(null), '');
  });

  test('hostnameMatchesDomain_ accepts the domain and its subdomains only', () => {
    assert.equal(gas.hostnameMatchesDomain_('example.pl', 'example.pl'), true);
    assert.equal(gas.hostnameMatchesDomain_('shop.example.pl', 'example.pl'), true);
    assert.equal(gas.hostnameMatchesDomain_('EXAMPLE.PL', 'example.pl'), true);
    assert.equal(gas.hostnameMatchesDomain_('notexample.pl', 'example.pl'), false);
    assert.equal(gas.hostnameMatchesDomain_('example.pl.evil.com', 'example.pl'), false);
    assert.equal(gas.hostnameMatchesDomain_('example.pl', ''), false);
  });
});

describe('GA4.gs getSiteDomain_', () => {
  test('prefers SITE_DOMAIN and normalises it', () => {
    const gas = loadProject({ properties: { SITE_DOMAIN: ' https://WWW.Example.pl/ ', WP_BASE_URL: 'https://other.pl' } });
    assert.equal(gas.getSiteDomain_(), 'example.pl');
  });

  test('falls back to the host of WP_BASE_URL', () => {
    const gas = loadProject({ properties: { WP_BASE_URL: 'https://www.example.pl/' } });
    assert.equal(gas.getSiteDomain_(), 'example.pl');
  });

  test('returns empty string when nothing is configured', () => {
    const gas = loadProject();
    assert.equal(gas.getSiteDomain_(), '');
  });
});

describe('GA4.gs date helpers', () => {
  const gas = loadProject();

  test('parseGa4Date_ reads yyyyMMdd as a local date', () => {
    const d = gas.parseGa4Date_('20260905');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 8);
    assert.equal(d.getDate(), 5);
    assert.equal(gas.parseGa4Date_('2026-09-05'), '');
    assert.equal(gas.parseGa4Date_(''), '');
  });

  test('addDays_ crosses month and year boundaries without mutating input', () => {
    const start = new Date(2026, 11, 31, 15, 30);
    const next = gas.addDays_(start, 1);
    assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate()], [2027, 0, 1]);
    assert.equal(next.getHours(), 0, 'time of day is dropped');
    assert.equal(start.getDate(), 31, 'input untouched');
    const back = gas.addDays_(new Date(2026, 2, 1), -1);
    assert.deepEqual([back.getMonth(), back.getDate()], [1, 28]);
  });

  test('dateKey_ normalises Date, ISO strings and yyyyMMdd to yyyy-MM-dd', () => {
    assert.equal(gas.dateKey_(new gas.$Date(2026, 8, 5)), '2026-09-05');
    assert.equal(gas.dateKey_('2026-09-05T10:11:12Z'), '2026-09-05');
    assert.equal(gas.dateKey_('20260905'), '2026-09-05');
    assert.equal(gas.dateKey_('nonsense'), '');
    assert.equal(gas.dateKey_(new gas.$Date('invalid')), '');
  });
});

describe('GA4.gs report row helpers', () => {
  const gas = loadProject();
  const row = {
    dimensionValues: [{ value: '20260905' }, { value: '' }],
    metricValues: [{ value: '12' }, { value: '' }]
  };

  test('dim_ and metric_ return safe defaults for missing cells', () => {
    assert.equal(gas.dim_(row, 0), '20260905');
    assert.equal(gas.dim_(row, 1), '');
    assert.equal(gas.dim_(row, 5), '');
    assert.equal(gas.dim_({}, 0), '');
    assert.equal(gas.metric_(row, 0), '12');
    assert.equal(gas.metric_(row, 1), '0');
    assert.equal(gas.metric_({}, 0), '0');
  });

  test('num_ converts numeric strings and falls back to 0', () => {
    assert.equal(gas.num_('1.5'), 1.5);
    assert.equal(gas.num_('12'), 12);
    assert.equal(gas.num_('abc'), 0);
    assert.equal(gas.num_(undefined), 0);
    assert.equal(gas.num_('Infinity'), 0);
  });

  test('cleanLanding_ drops the query string but keeps GA4 placeholders', () => {
    assert.equal(gas.cleanLanding_('/oferta?utm_source=x'), '/oferta');
    assert.equal(gas.cleanLanding_('?only=query'), '/');
    assert.equal(gas.cleanLanding_('(not set)'), '(not set)');
    assert.equal(gas.cleanLanding_(''), '');
  });
});

describe('GA4.gs getGa4Config_', () => {
  test('parses the config sheet and applies defaults', () => {
    const gas = loadProject({
      sheets: {
        'Konfiguracja GA4': [
          ['Klucz', 'Wartość'],
          ['propertyId', 'properties/123456'],
          ['daysBack', 30],
          ['', 'ignored'],
          ['landingSheet', 'Landing']
        ]
      }
    });
    const cfg = gas.getGa4Config_();
    assert.equal(cfg.propertyId, '123456');
    assert.equal(cfg.daysBack, 30);
    assert.equal(cfg.dailyLagDays, 2);
    assert.equal(cfg.rowLimit, 100000);
    assert.equal(cfg.landingSheet, 'Landing');
    assert.equal(cfg.eventsSheet, gas.$get('GA4_EVENTS_SHEET'));
    assert.equal(cfg.timezone, 'Europe/Warsaw');
  });

  test('throws a clear error when the config sheet is missing', () => {
    const gas = loadProject({ sheets: {} });
    assert.throws(() => gas.getGa4Config_(), /Brak zakładki: Konfiguracja GA4/);
  });

  test('requireGa4Config_ insists on a propertyId', () => {
    const gas = loadProject({ sheets: { 'Konfiguracja GA4': [['Klucz', 'Wartość'], ['daysBack', 7]] } });
    assert.throws(() => gas.requireGa4Config_(), /Brak propertyId/);
  });
});

describe('GA4.gs ga4ApiRequest_', () => {
  test('sends a bearer token, JSON payload for POST, and parses the response', () => {
    const gas = loadProject({ fetch: () => ({ code: 200, json: { rows: [] } }) });
    const out = gas.ga4ApiRequest_('https://analyticsdata.googleapis.com/x', 'post', { a: 1 });
    const call = gas.$fetchCalls[0];
    assert.equal(call.params.headers.Authorization, 'Bearer test-token');
    assert.equal(call.params.muteHttpExceptions, true);
    assert.equal(call.params.contentType, 'application/json');
    assert.equal(call.params.payload, '{"a":1}');
    assert.deepEqual(plain(out), { rows: [] });
  });

  test('GET has no payload and an empty body becomes {}', () => {
    const gas = loadProject({ fetch: () => ({ code: 200, text: '' }) });
    const out = gas.ga4ApiRequest_('https://analyticsadmin.googleapis.com/x', 'get');
    assert.equal('payload' in gas.$fetchCalls[0].params, false);
    assert.deepEqual(plain(out), {});
  });

  test('non-2xx responses throw with the code and body', () => {
    const gas = loadProject({ fetch: () => ({ code: 403, text: 'denied' }) });
    assert.throws(() => gas.ga4ApiRequest_('https://analyticsadmin.googleapis.com/x', 'get'), /Google Analytics API HTTP 403:\ndenied/);
  });
});

/**
 * testGA4() end to end: lists properties and their web streams through the
 * Admin API, writes them to E:H, auto-picks the property whose stream matches
 * the site domain, then proves Data API access with a small report.
 */
describe('GA4.gs testGA4', () => {
  const ADMIN = 'analyticsadmin.googleapis.com/v1beta/';
  const accountSummaries = properties => ({
    code: 200,
    json: {
      accountSummaries: [{
        displayName: 'Acme account',
        propertySummaries: properties.map(([id, name]) => ({ property: 'properties/' + id, displayName: name }))
      }]
    }
  });
  const streams = byProperty => (url) => {
    const id = /properties\/(\d+)\/dataStreams/.exec(url)[1];
    return {
      code: 200,
      json: {
        dataStreams: (byProperty[id] || []).map(uri => ({
          type: 'WEB_DATA_STREAM',
          displayName: 'web',
          webStreamData: { defaultUri: uri, measurementId: 'G-' + id }
        }))
      }
    };
  };
  const report = { code: 200, json: { rows: [{ dimensionValues: [{ value: '20260904' }], metricValues: [{ value: '5' }] }], rowCount: 1 } };
  const configSheet = () => ({ 'Konfiguracja GA4': [['Klucz', 'Wartość'], ['propertyId', ''], ['daysBack', 30]] });

  function project({ properties, streamsByProperty, siteDomain }) {
    return loadProject({
      properties: siteDomain ? { SITE_DOMAIN: siteDomain } : {},
      sheets: configSheet(),
      fetch: fetchRouter([
        [ADMIN + 'accountSummaries', accountSummaries(properties)],
        ['/dataStreams', streams(streamsByProperty)],
        [':runReport', report]
      ])
    });
  }

  test('auto-picks the single property whose web stream matches SITE_DOMAIN and confirms Data API access', () => {
    const gas = project({
      properties: [['111', 'Main site'], ['222', 'Other site']],
      streamsByProperty: { 111: ['https://www.example.pl'], 222: ['https://other.pl'] },
      siteDomain: 'example.pl'
    });

    gas.testGA4();

    assert.equal(gas.$cell('Konfiguracja GA4', 'B2'), '111', 'property id written to B2');
    assert.deepEqual(gas.$sheet('Konfiguracja GA4')[0].slice(4, 8), ['Dostępne właściwości GA4', 'Property ID', 'Konto', 'URL strumienia']);
    assert.deepEqual(gas.$sheet('Konfiguracja GA4')[1].slice(4, 8), ['Main site', '111', 'Acme account', 'https://www.example.pl']);
    assert.match(gas.$cell('Konfiguracja GA4', 'B9'), /^POŁĄCZENIE OK – Main site \(111\) \| https:\/\/www\.example\.pl$/);
    const reportCall = gas.$fetchCalls.find(c => c.url.includes(':runReport'));
    assert.match(reportCall.url, /properties\/111:runReport$/);
    assert.equal(JSON.parse(reportCall.params.payload).limit, 10000, 'report limit capped at 10000');
  });

  test('with no site domain and several properties it asks the user to choose', () => {
    const gas = project({
      properties: [['111', 'Main site'], ['222', 'Other site']],
      streamsByProperty: { 111: ['https://www.example.pl'], 222: ['https://other.pl'] }
    });

    gas.testGA4();

    assert.equal(gas.$cell('Konfiguracja GA4', 'B2'), '');
    assert.equal(gas.$cell('Konfiguracja GA4', 'B9'), 'WYBIERZ PROPERTY ID Z LISTY E:H I WPISZ DO B2');
    assert.equal(gas.$fetchCalls.some(c => c.url.includes(':runReport')), false, 'no report without a property');
  });

  test('with no site domain but exactly one property it picks that property', () => {
    const gas = project({ properties: [['333', 'Only']], streamsByProperty: { 333: ['https://only.pl'] } });
    gas.testGA4();
    assert.equal(gas.$cell('Konfiguracja GA4', 'B2'), '333');
    assert.match(gas.$cell('Konfiguracja GA4', 'B9'), /^POŁĄCZENIE OK – Only \(333\)/);
  });

  test('ambiguous match (two properties on the site domain) names the domain in the hint', () => {
    const gas = project({
      properties: [['111', 'Main'], ['222', 'Staging']],
      streamsByProperty: { 111: ['https://www.example.pl'], 222: ['https://staging.example.pl'] },
      siteDomain: 'example.pl'
    });
    gas.testGA4();
    assert.equal(gas.$cell('Konfiguracja GA4', 'B2'), '');
    assert.equal(gas.$cell('Konfiguracja GA4', 'B9'), 'KILKA WŁAŚCIWOŚCI MA STRUMIEŃ EXAMPLE.PL – WYBIERZ PROPERTY ID Z LISTY E:H');
  });

  test('no accessible properties at all', () => {
    const gas = project({ properties: [], streamsByProperty: {}, siteDomain: 'example.pl' });
    gas.testGA4();
    assert.equal(gas.$cell('Konfiguracja GA4', 'B9'), 'BRAK DOSTĘPNYCH WŁAŚCIWOŚCI GA4');
  });

  test('a preselected property is kept and reported even without a matching stream', () => {
    const gas = loadProject({
      sheets: { 'Konfiguracja GA4': [['Klucz', 'Wartość'], ['propertyId', 'properties/999']] },
      fetch: fetchRouter([
        [ADMIN + 'accountSummaries', accountSummaries([['111', 'Main']])],
        ['/dataStreams', streams({ 111: ['https://www.example.pl'] })],
        [':runReport', report]
      ])
    });
    gas.testGA4();
    assert.equal(gas.$cell('Konfiguracja GA4', 'B2'), 'properties/999', 'B2 untouched');
    assert.equal(gas.$cell('Konfiguracja GA4', 'B9'), 'POŁĄCZENIE OK – property 999 (999)');
  });

  test('missing config sheet fails before any API call', () => {
    const gas = loadProject({ sheets: {}, fetch: () => { throw new Error('should not fetch'); } });
    assert.throws(() => gas.testGA4(), /Brak zakładki: Konfiguracja GA4/);
    assert.equal(gas.$fetchCalls.length, 0);
  });
});
