'use strict';

/**
 * #52: blokada współbieżnych uruchomień (Lock.gs), idempotencja komend zapisu
 * po command_id, wiersze RUNNING jako przerwane oraz wykonywanie wierszy
 * DRY_RUN po potwierdzeniu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');
const { fakeWordPress } = require('./helpers/wordpress');

const PROPS = { WP_BASE_URL: 'https://www.example.pl', WP_USERNAME: 'bot', WP_APP_PASSWORD: 'pw', WP_REST_NAMESPACE: 'acme' };
const WRITE = { ...PROPS, WP_ALLOW_WRITES: 'TRUE' };
const DRY = { ...PROPS, WP_DRY_RUN: 'TRUE' };

const COMMANDS_HEADER = ['id', 'created_at', 'action', 'target', 'field', 'value', 'confirm', 'status', 'http', 'message', 'result_ref', 'done_at', 'note'];
const RESULTS_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];
const SNAPSHOTS_HEADER = ['snapshot_id', 'command_id', 'wp_id', 'slug', 'title', 'excerpt', 'content', 'status', 'modified', 'at', 'rm_title', 'rm_desc', 'rm_captured', 'snapshot_kind', 'media_before_json'];
const cmd = (action, target = '', field = '', value = '', confirm = 'YES', status = 'PENDING', id = 'CMD-1') =>
  [id, '2026-09-05', action, target, field, value, confirm, status, '', '', '', '', ''];
const PAGES = [{ id: 7, slug: 'home', status: 'publish', title: 'Home', content: 'Treść' }, { id: 8, slug: 'szkic', status: 'draft', title: 'Szkic', content: 'x' }];

function project({ props = WRITE, commands = [], results = [], lockHeld = false, answer = 'YES' } = {}) {
  const fake = fakeWordPress({ pages: PAGES });
  const gas = loadProject({
    properties: props,
    lockHeld,
    sheets: { 'WP COMMANDS': [COMMANDS_HEADER, ...commands], 'WP RESULTS': [RESULTS_HEADER, ...results], 'WP SNAPSHOTS': [SNAPSHOTS_HEADER] },
    fetch: fake.fetch
  });
  gas.$ui.$answer = answer;
  gas.$wp = fake.state;
  return gas;
}
const row = (gas, n = 2) => gas.$sheet('WP COMMANDS')[n - 1];
const status = (gas, n = 2) => row(gas, n)[7];
const message = (gas, n = 2) => String(row(gas, n)[9]);

describe('Lock.gs withScriptLock_', () => {
  test('acquires with the short timeout, runs the function and releases', () => {
    const gas = loadProject();
    const out = gas.withScriptLock_('test', () => 42);
    assert.equal(out, 42);
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
  });

  test('releases the lock even when the function throws', () => {
    const gas = loadProject();
    assert.throws(() => gas.withScriptLock_('test', () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(plain(gas.$lock.slice(-1)), [['releaseLock']]);
  });

  test('a nested call inside a held lock neither re-acquires nor releases it', () => {
    const gas = loadProject();
    const out = gas.withScriptLock_('outer', () => gas.withScriptLock_('inner', () => 'ok'));
    assert.equal(out, 'ok');
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']], 'exactly one acquire/release pair');
  });

  test('refuses immediately when another run holds the lock, without waiting or queueing', () => {
    const gas = loadProject({ lockHeld: true });
    let ran = false;
    assert.throws(() => gas.withScriptLock_('import GSC', () => { ran = true; }), /Inne uruchomienie jeszcze trwa \(import GSC\)/);
    assert.equal(ran, false);
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000]], 'no release without acquisition');
  });
});

describe('imports under the lock', () => {
  const sheets = {
    'Konfiguracja GSC': [['k', 'v'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    'Konfiguracja GA4': [['k', 'v'], ['propertyId', 'properties/111'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['', ''], ['', ''], ['', ''], ['status', '']],
    'GSC RAW': [['date']]
  };

  test('a refused lock is recorded as a failed run in B8 and no request is sent', () => {
    const gas = loadProject({ sheets, lockHeld: true, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.importDzienny(), /Inne uruchomienie jeszcze trwa \(import GSC\)/);
    assert.match(gas.$cell('Konfiguracja GSC', 'B8'), /BŁĄD .*Inne uruchomienie jeszcze trwa/);
    assert.equal(JSON.parse(gas.$properties.LAST_IMPORT_GSC).lastRun.ok, false);
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('GA4 import refuses the same way', () => {
    const gas = loadProject({ sheets, lockHeld: true });
    assert.throws(() => gas.importGA4Dzienny(), /Inne uruchomienie jeszcze trwa \(import GA4\)/);
    assert.match(gas.$cell('Konfiguracja GA4', 'B9'), /BŁĄD .*import GA4/);
  });

  test('a successful import acquires and releases the lock', () => {
    const gas = loadProject({ sheets, fetch: () => ({ code: 200, json: { rows: [] } }) });
    gas.importDzienny();
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
  });
});

describe('processWpCommands: lock, idempotency, RUNNING rows', () => {
  test('refuses to run while another run holds the lock', () => {
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '7')], lockHeld: true });
    assert.throws(() => gas.processWpCommands(), /Inne uruchomienie jeszcze trwa \(komendy WordPress\)/);
    assert.equal(status(gas), 'PENDING', 'row untouched');
  });

  test('holds the lock for the whole loop and releases it at the end', () => {
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '7'), cmd('GET_PAGE_BY_ID', '8', '', '', 'YES', 'PENDING', 'CMD-2')] });
    const stats = gas.processWpCommands();
    assert.deepEqual(plain(stats), { processed: 2, skipped: 0 });
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
  });

  test('a write command whose command_id already has a result is SKIPPED without any request', () => {
    const existing = ['WP-R-old', 'CMD-1', 7, 'home', 'publish', '', 'Home', '', '', '', '', '', 'OK'];
    const gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'Nowy')], results: [existing] });
    const stats = gas.processWpCommands();
    assert.equal(status(gas), 'SKIPPED');
    assert.match(message(gas), /wynik dla command_id CMD-1 już istnieje w WP RESULTS \(wiersz 2\)\. Aby wykonać ponownie, nadaj nowe command_id\./);
    assert.equal(gas.$fetchCalls.length, 0);
    assert.equal(gas.$wp.pages.get(7).title, 'Home');
    assert.deepEqual(plain(stats), { processed: 0, skipped: 1 });
  });

  test('a read command may be repeated even if a result with the same id exists', () => {
    const existing = ['WP-R-old', 'CMD-1', 7, 'home', 'publish', '', 'Home', '', '', '', '', '', 'OK'];
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '7')], results: [existing] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
  });

  test('a write command without command_id is SKIPPED with an explanation', () => {
    const gas = project({ commands: [cmd('PUBLISH_PAGE', '8', '', '', 'YES', 'PENDING', '')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'SKIPPED');
    assert.match(message(gas), /wymaga command_id/);
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('a RUNNING row (interrupted run) is never re-executed automatically', () => {
    const gas = project({ commands: [cmd('PUBLISH_PAGE', '8', '', '', 'YES', 'RUNNING')] });
    const stats = gas.processWpCommands();
    assert.equal(status(gas), 'RUNNING');
    assert.deepEqual(plain(stats), { processed: 0, skipped: 0 });
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('a write command re-run after a DRY_RUN pass is not blocked (dry run leaves no result row)', () => {
    const dry = project({ props: DRY, commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'Nowy')] });
    dry.processWpCommands();
    assert.equal(status(dry), 'DRY_RUN');
    assert.equal(dry.$sheet('WP RESULTS').length, 1, 'no result row after dry run');
  });
});

describe('executeDryRunCommands', () => {
  test('menu has the item', () => {
    const gas = project();
    gas.onOpen();
    const wp = gas.$menus.find(m => m.title === 'WordPress');
    assert.ok(wp.items.some(i => i.fn === 'executeDryRunCommands'));
  });

  test('with WP_DRY_RUN still on it only alerts', () => {
    const gas = project({ props: { ...WRITE, WP_DRY_RUN: 'TRUE' }, commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'N', 'YES', 'DRY_RUN')] });
    const out = gas.executeDryRunCommands();
    assert.deepEqual(plain(out), { converted: 0 });
    assert.match(gas.$alerts[0][0], /WP_DRY_RUN jest nadal TRUE/);
    assert.equal(status(gas), 'DRY_RUN');
  });

  test('without DRY_RUN rows it alerts and does nothing', () => {
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '7')] });
    gas.executeDryRunCommands();
    assert.match(gas.$alerts[0][0], /Brak wierszy ze statusem DRY_RUN/);
    assert.equal(status(gas), 'PENDING');
  });

  test('answering NO leaves the rows as DRY_RUN', () => {
    const gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'N', 'YES', 'DRY_RUN')], answer: 'NO' });
    const out = gas.executeDryRunCommands();
    assert.deepEqual(plain(out), { converted: 0 });
    assert.equal(status(gas), 'DRY_RUN');
    assert.equal(gas.$alerts[0][2], 'YES_NO');
    assert.match(gas.$alerts[0][1], /Wiersze DRY_RUN: 1/);
  });

  test('when another run holds the lock, rows stay DRY_RUN and nothing is converted', () => {
    const gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'N', 'YES', 'DRY_RUN')], lockHeld: true });
    assert.throws(() => gas.executeDryRunCommands(), /Inne uruchomienie jeszcze trwa/);
    assert.equal(status(gas), 'DRY_RUN', 'no PENDING left behind without confirmation');
    assert.equal(gas.$fetchCalls.length, 0);
  });

  test('answering YES converts DRY_RUN rows to PENDING and executes them for real', () => {
    const gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'Nowy', 'YES', 'DRY_RUN'), cmd('GET_PAGE_BY_ID', '8', '', '', 'YES', 'DONE', 'CMD-2')] });
    const out = gas.executeDryRunCommands();
    assert.deepEqual(plain(out), { converted: 1, processed: 1, skipped: 0 });
    assert.equal(status(gas, 2), 'DONE');
    assert.equal(gas.$wp.pages.get(7).title, 'Nowy');
    assert.equal(status(gas, 3), 'DONE', 'other rows untouched');
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']], 'conversion and execution share one lock');
  });
});
