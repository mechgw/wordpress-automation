'use strict';

// Test allowlisty środowiska pilota mutacji. Uruchamianie: node --test scripts/mutation/safe-env.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeEnv } = require('./safe-env.js');

test('przepuszcza tylko dozwolone nazwy i zmienne pilota', () => {
  const env = safeEnv({
    PATH: '/bin', SystemRoot: 'C:/Windows', TEMP: '/tmp', __STRYKER_ACTIVE_MUTANT__: '7', MUTATION_SELECTION: 'sel.json',
    SERVICE_PASSWORD: 'x', GITHUB_TOKEN: 'x', GIT_DIR: '/repo/.git', GIT_INDEX_FILE: 'i', HOME: '/home/u', NODE_OPTIONS: '--inspect', RANDOM_VAR: 'y'
  });
  assert.deepEqual(Object.keys(env).sort(), ['MUTATION_SELECTION', 'PATH', 'SystemRoot', 'TEMP', '__STRYKER_ACTIVE_MUTANT__']);
});

test('GIT_* nigdy nie przechodzi, także przez extra', () => {
  assert.throws(() => safeEnv({}, { GIT_DIR: 'x' }), /nie jest na liście pilota/);
  assert.equal(safeEnv({ GIT_DIR: 'x', git_work_tree: 'y' }).GIT_DIR, undefined);
  assert.equal(Object.keys(safeEnv({ git_work_tree: 'y' })).length, 0);
});

test('extra przepuszcza tylko zmienne pilota', () => {
  assert.equal(safeEnv({}, { MUTATION_SELECTION: 's.json' }).MUTATION_SELECTION, 's.json');
  assert.throws(() => safeEnv({}, { TOKEN: 'x' }), /nie jest na liście pilota/);
});
