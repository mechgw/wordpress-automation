'use strict';

/**
 * Loads the Apps Script sources (*.gs) into an isolated VM context with
 * minimal stand-ins for the Google services they touch, so pure helpers and
 * the configuration layer can be unit-tested with plain Node.
 *
 * Apps Script shares one global scope across files, which is exactly what a
 * single vm context gives us: functions from Kod.gs, GA4.gs, WordPress.gs and
 * Version.gs see each other. Top-level `function` declarations become
 * properties of the returned context; top-level `const`s are reachable via
 * `ctx.$get('NAME')`.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = ['Version.gs', 'Kod.gs', 'GA4.gs', 'WordPress.gs'];

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Just enough of Utilities.formatDate for the patterns used in the sources. */
function formatDate(date, _tz, pattern) {
  const parts = {
    yyyy: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds())
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, m => parts[m]);
}

/** Builds a SpreadsheetApp stub from { sheetName: rows } (rows = 2D array). */
function makeSpreadsheet(sheets = {}) {
  const sheetFor = name => {
    if (!Object.prototype.hasOwnProperty.call(sheets, name)) return null;
    const rows = sheets[name];
    return {
      getName: () => name,
      getRange: () => ({
        getValues: () => rows,
        getValue: () => (rows[0] || [])[0],
        setValue() { return this; },
        setValues() { return this; },
        clearContent() { return this; }
      }),
      getLastRow: () => rows.length
    };
  };
  return {
    getActive: () => ({ getSheetByName: sheetFor }),
    getUi: () => ({
      alert() {},
      createMenu: () => {
        const menu = {
          addItem: () => menu,
          addSeparator: () => menu,
          addSubMenu: () => menu,
          addToUi() {}
        };
        return menu;
      }
    })
  };
}

function createStubs(opts) {
  const properties = Object.assign({}, opts.properties || {});
  const fetchCalls = [];
  const fetchImpl = opts.fetch || (() => ({ code: 200, text: '{}' }));

  return {
    SpreadsheetApp: opts.SpreadsheetApp || makeSpreadsheet(opts.sheets || {}),
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null),
        setProperty: (key, value) => { properties[key] = String(value); }
      })
    },
    UrlFetchApp: {
      fetch: (url, params) => {
        fetchCalls.push({ url, params });
        const r = fetchImpl(url, params);
        return {
          getResponseCode: () => r.code,
          getContentText: () => r.text,
          getAllHeaders: () => r.headers || {}
        };
      }
    },
    Utilities: {
      formatDate,
      base64Encode: s => Buffer.from(String(s), 'utf8').toString('base64'),
      getUuid: () => '00000000-0000-4000-8000-000000000000',
      sleep() {}
    },
    ScriptApp: {
      getOAuthToken: () => 'test-token',
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger() { throw new Error('ScriptApp.newTrigger is not stubbed'); }
    },
    Session: { getScriptTimeZone: () => 'Europe/Warsaw' },
    Logger: { log() {} },
    console,
    $fetchCalls: fetchCalls,
    $properties: properties
  };
}

/**
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.properties]  Script Properties
 * @param {Record<string,any[][]>} [opts.sheets]      sheet name → rows
 * @param {(url, params) => {code, text, headers?}} [opts.fetch]
 * @param {string[]} [opts.skip]                      source files to omit
 * @param {Record<string,string>} [opts.override]     source file → replacement code
 */
function loadProject(opts = {}) {
  const ctx = vm.createContext(createStubs(opts));
  for (const file of SOURCES) {
    if ((opts.skip || []).includes(file)) continue;
    const code = opts.override && Object.prototype.hasOwnProperty.call(opts.override, file)
      ? opts.override[file]
      : fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, ctx, { filename: path.join(ROOT, file) });
  }
  ctx.$get = name => vm.runInContext(name, ctx);
  // Dates must be created inside the VM: an `instanceof Date` check in the
  // sources fails for Date objects from the test realm.
  ctx.$Date = vm.runInContext('Date', ctx);
  return ctx;
}

/**
 * Objects created inside the VM have a different Object prototype than the
 * test's realm, which makes assert.deepStrictEqual fail on identical data.
 * Round-trip through JSON to compare structure only.
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = { loadProject, makeSpreadsheet, plain };
