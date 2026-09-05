'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, makeSpreadsheet } = require('./helpers/gas');

describe('GA4.gs konfigurujGlowneKeyEventsGA4', () => {
  test('adds all missing primary events, removes micro events and is idempotent', () => {
    const alerts = [];
    const spreadsheet = makeSpreadsheet({
      'Konfiguracja GA4': [
        ['Klucz', 'Wartość'],
        ['propertyId', '123']
      ]
    }, alerts);
    spreadsheet.getUi().ButtonSet = { OK: 'OK' };

    let nextId = 10;
    let keyEvents = [
      {
        eventName: 'operational_order_submit',
        name: 'properties/123/keyEvents/1',
        deletable: true
      },
      {
        eventName: 'pricing_pdf_click',
        name: 'properties/123/keyEvents/2',
        deletable: true
      },
      {
        eventName: 'dedicated_calculator_use',
        name: 'properties/123/keyEvents/3',
        deletable: true
      },
      {
        eventName: 'regulamin_pdf_click',
        name: 'properties/123/keyEvents/4',
        deletable: true
      }
    ];

    const gas = loadProject({
      SpreadsheetApp: spreadsheet,
      fetch: (url, params) => {
        if (url.includes('/keyEvents?pageSize=200')) {
          return { code: 200, json: { keyEvents } };
        }

        if (params.method === 'post' && url.endsWith('/keyEvents')) {
          const eventName = JSON.parse(params.payload).eventName;
          const created = {
            eventName,
            name: 'properties/123/keyEvents/' + nextId++,
            deletable: true
          };
          keyEvents.push(created);
          return { code: 200, json: created };
        }

        if (params.method === 'delete') {
          const name = url.split('/v1beta/')[1];
          keyEvents = keyEvents.filter(event => event.name !== name);
          return { code: 204, text: '' };
        }

        throw new Error('Unexpected GA4 Admin API call: ' + params.method + ' ' + url);
      }
    });

    gas.konfigurujGlowneKeyEventsGA4();

    const firstPosts = gas.$fetchCalls
      .filter(call => call.params.method === 'post')
      .map(call => JSON.parse(call.params.payload).eventName)
      .sort();
    const firstDeletes = gas.$fetchCalls
      .filter(call => call.params.method === 'delete');

    assert.deepEqual(firstPosts, ['b2b_lead_submit', 'phone_click']);
    assert.equal(firstDeletes.length, 3);
    assert.deepEqual(
      keyEvents.map(event => event.eventName).sort(),
      ['b2b_lead_submit', 'operational_order_submit', 'phone_click']
    );
    assert.match(gas.$cell('Konfiguracja GA4', 'B9'), /b2b_lead_submit/);
    assert.match(
      alerts[0][1],
      /Główne: operational_order_submit \+ phone_click \+ b2b_lead_submit\./
    );

    const firstCallCount = gas.$fetchCalls.length;
    gas.konfigurujGlowneKeyEventsGA4();
    const secondRunCalls = gas.$fetchCalls.slice(firstCallCount);

    assert.equal(
      secondRunCalls.some(call => call.params.method === 'post'),
      false,
      'existing primary key events are not created again'
    );
    assert.equal(
      secondRunCalls.some(call => call.params.method === 'delete'),
      false,
      'already removed micro events are not deleted again'
    );
  });
});
