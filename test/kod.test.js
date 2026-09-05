'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

describe('Kod.gs date helpers', () => {
  const gas = loadProject();

  test('przesunDate_ shifts by days across a month boundary and keeps the input intact', () => {
    const start = new Date(2026, 0, 31);
    const shifted = gas.przesunDate_(start, 1);
    assert.deepEqual([shifted.getMonth(), shifted.getDate()], [1, 1]);
    assert.equal(start.getDate(), 31);
    assert.equal(gas.przesunDate_(new Date(2026, 0, 1), -1).getFullYear(), 2025);
  });

  test('normalizujDate_ returns yyyy-MM-dd for dates and strings', () => {
    assert.equal(gas.normalizujDate_(new gas.$Date(2026, 8, 5, 23, 59)), '2026-09-05');
    assert.equal(gas.normalizujDate_('2026-09-05T23:59:00'), '2026-09-05');
    assert.equal(gas.normalizujDate_(''), '');
    assert.equal(gas.normalizujDate_(null), '');
  });
});

describe('Kod.gs deployed version', () => {
  test('placeholder Version.gs reports "dev"', () => {
    const gas = loadProject();
    assert.equal(gas.versionLabel_(), 'dev');
    assert.equal(gas.deployedVersion_().tag, 'dev');
  });

  test('a stamped Version.gs drives the label', () => {
    const gas = loadProject({
      override: {
        'Version.gs': 'const DEPLOYED_VERSION = { tag: "v9.9.9", commit: "abc1234", deployedAt: "2026-09-05T09:14:42Z", deployedBy: "ci" };'
      }
    });
    assert.equal(gas.versionLabel_(), 'v9.9.9');
    assert.equal(gas.deployedVersion_().commit, 'abc1234');
  });

  test('missing Version.gs does not break the menu (typeof guard)', () => {
    const gas = loadProject({ skip: ['Version.gs'] });
    assert.equal(gas.versionLabel_(), 'dev');
    assert.deepEqual(plain(gas.deployedVersion_()), {});
    assert.doesNotThrow(() => gas.onOpen());
    assert.doesNotThrow(() => gas.showDeployedVersion());
  });
});
