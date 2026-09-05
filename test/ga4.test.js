'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

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
    const gas = loadProject({ sheets: { 'Konfiguracja GA4': [['daysBack', 7]] } });
    assert.throws(() => gas.requireGa4Config_(), /Brak propertyId/);
  });
});
