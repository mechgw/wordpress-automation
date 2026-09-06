'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const BASE_PROPS = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_ALLOW_WRITES: 'TRUE',
  WP_REST_NAMESPACE: 'example',
  WP_B2B_FORM_ID: '321'
};

test('editor: jednorazowe arm pozwala przejść approval bez Spreadsheet UI i jest konsumowane', () => {
  const gas = loadProject({ properties: BASE_PROPS });
  gas.SpreadsheetApp.getUi = () => { throw new Error('no ui'); };

  assert.deepEqual(plain(gas.armForminatorHistoryWrite()), { armed: true });
  assert.equal(gas.$properties.WP_FORMINATOR_HISTORY_WRITE_APPROVAL, 'YES');
  assert.equal(gas.requireForminatorHistoryWriteApproval_('title', 'message'), true);
  assert.equal(gas.$properties.WP_FORMINATOR_HISTORY_WRITE_APPROVAL, '');

  assert.throws(
    () => gas.requireForminatorHistoryWriteApproval_('title', 'message'),
    /Najpierw uruchom armForminatorHistoryWrite/
  );
});

test('editor: arm nadal wymaga globalnego WP_ALLOW_WRITES', () => {
  const gas = loadProject({ properties: Object.assign({}, BASE_PROPS, { WP_ALLOW_WRITES: 'FALSE' }) });
  assert.throws(() => gas.armForminatorHistoryWrite(), /WP_ALLOW_WRITES/);
  assert.equal(gas.$properties.WP_FORMINATOR_HISTORY_WRITE_APPROVAL, undefined);
});

test('komunikat po operacji używa logu zamiast rzucać, gdy Spreadsheet UI jest niedostępne', () => {
  const gas = loadProject({ properties: BASE_PROPS });
  gas.SpreadsheetApp.getUi = () => { throw new Error('no ui'); };
  assert.doesNotThrow(() => gas.showForminatorHistoryMessage_('gotowe'));
});
