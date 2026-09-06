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
 *
 * Observability for assertions:
 *   ctx.$fetchCalls        every UrlFetchApp.fetch(url, params)
 *   ctx.$alerts            every SpreadsheetApp.getUi().alert(...) (args array)
 *   ctx.$sheet(name)       the live cell grid of a stubbed sheet (row 1 first)
 *   ctx.$cell(name, 'B9')  a single cell value
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = ['Version.gs', 'Lock.gs', 'Kod.gs', 'GA4.gs', 'WordPress.gs', 'CodeSnippets.gs', 'Status.gs', 'Alerts.gs', 'FormSourcePageContext.gs', 'UrlInspection.gs', 'ForminatorHistory.gs', 'SeoLive.gs', 'Sitemaps.gs'];

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

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // 1-based
}

/**
 * Parses "B9", "A2:B11", "E1:H120" and whole columns "A:A" / "E:H" into
 * { row, col, rows, cols } (1-based). Whole columns span the current grid
 * height (at least one row), mirroring how the sources iterate them.
 */
function parseA1(a1, gridRows = 1) {
  const s = String(a1).trim();
  const cols = /^([A-Z]+):([A-Z]+)$/i.exec(s);
  if (cols) {
    const col = colIndex(cols[1]);
    return { row: 1, col, rows: Math.max(gridRows, 1), cols: colIndex(cols[2]) - col + 1 };
  }
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(s);
  if (!m) throw new Error(`Sheet stub: unsupported A1 range "${a1}"`);
  const row = Number(m[2]);
  const col = colIndex(m[1]);
  const row2 = m[4] ? Number(m[4]) : row;
  const col2 = m[3] ? colIndex(m[3]) : col;
  return { row, col, rows: row2 - row + 1, cols: col2 - col + 1 };
}

/**
 * A sheet is a 2D grid with 1-based semantics (grid[r-1][c-1]); the fixture
 * rows start at row 1. Cells outside the grid read as ''.
 */
function makeSheet(name, initialRows) {
  const grid = initialRows.map(r => r.slice());
  const ensure = (row, col) => {
    while (grid.length < row) grid.push([]);
    const line = grid[row - 1];
    while (line.length < col) line.push('');
  };
  const rangeOf = (row, col, rows, cols) => ({
    getValues: () => {
      const out = [];
      for (let r = row; r < row + rows; r++) {
        const line = [];
        for (let c = col; c < col + cols; c++) line.push((grid[r - 1] || [])[c - 1] ?? '');
        out.push(line);
      }
      return out;
    },
    getValue: () => (grid[row - 1] || [])[col - 1] ?? '',
    isBlank() {
      for (let r = row; r < row + rows; r++) {
        for (let c = col; c < col + cols; c++) {
          const v = (grid[r - 1] || [])[c - 1];
          if (v !== undefined && v !== null && v !== '') return false;
        }
      }
      return true;
    },
    setValue(value) {
      ensure(row, col);
      grid[row - 1][col - 1] = value;
      return this;
    },
    setValues(values) {
      values.forEach((line, i) => line.forEach((v, j) => {
        ensure(row + i, col + j);
        grid[row + i - 1][col + j - 1] = v;
      }));
      return this;
    },
    clearContent() {
      for (let r = row; r < row + rows; r++) {
        for (let c = col; c < col + cols; c++) {
          if (grid[r - 1] && grid[r - 1].length >= c) grid[r - 1][c - 1] = '';
        }
      }
      return this;
    },
    setNumberFormat() { return this; },
    setFontWeight() { return this; },
    setBackground() { return this; },
    setFontColor() { return this; },
    // Minimal TextFinder: exact (matchEntireCell) or substring search within the range.
    createTextFinder(text) {
      let entire = false;
      const finder = {
        matchEntireCell(flag) { entire = Boolean(flag); return finder; },
        findNext() {
          for (let r = row; r < row + rows; r++) {
            for (let c = col; c < col + cols; c++) {
              const v = String((grid[r - 1] || [])[c - 1] ?? '');
              if (entire ? v === String(text) : v.includes(String(text))) {
                return { getRow: () => r, getColumn: () => c, getValue: () => v };
              }
            }
          }
          return null;
        }
      };
      return finder;
    }
  });
  return {
    getName: () => name,
    getRange: (...args) => {
      if (typeof args[0] === 'string') {
        const { row, col, rows, cols } = parseA1(args[0], grid.length);
        return rangeOf(row, col, rows, cols);
      }
      return rangeOf(args[0], args[1], args[2] ?? 1, args[3] ?? 1);
    },
    getLastRow: () => grid.length,
    getMaxRows: () => Math.max(grid.length, 1000),
    getMaxColumns: () => Math.max(26, ...grid.map(r => r.length)),
    insertRowsAfter() { return this; },
    insertRowBefore(row) { grid.splice(row - 1, 0, []); return this; },
    insertColumnsAfter() { return this; },
    deleteRows(row, n = 1) { grid.splice(row - 1, n); return this; },
    setFrozenRows() { return this; },
    setColumnWidth() { return this; },
    appendRow(row) { grid.push(row.slice()); return this; },
    $grid: grid
  };
}

/** Builds a SpreadsheetApp stub from { sheetName: rows }; rows start at row 1. */
function makeSpreadsheet(sheets = {}, alerts = [], menus = []) {
  const instances = new Map();
  const sheetFor = name => {
    if (!Object.prototype.hasOwnProperty.call(sheets, name)) return null;
    if (!instances.has(name)) instances.set(name, makeSheet(name, sheets[name]));
    return instances.get(name);
  };
  const ui = {
    Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    // alert(text) or alert(title, text, buttons); the answer comes from ui.$answer (default OK).
    alert: (...args) => { alerts.push(args); return ui.$answer; },
    $answer: 'OK',
    createMenu: title => {
      const entry = { title, items: [] };
      const menu = {
        addItem(label, fn) { entry.items.push({ label, fn }); return menu; },
        addSeparator: () => menu,
        addSubMenu: () => menu,
        addToUi() { menus.push(entry); }
      };
      return menu;
    }
  };
  const insertSheet = name => {
    // Like Apps Script: a duplicate name is an error, not a silent no-op.
    if (Object.prototype.hasOwnProperty.call(sheets, name)) {
      throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    }
    sheets[name] = [];
    return sheetFor(name);
  };
  // One stable spreadsheet object, like Apps Script: tests may patch its methods.
  const active = { getSheetByName: sheetFor, insertSheet, getUrl: () => 'https://docs.google.com/spreadsheets/d/test-sheet/edit' };
  return {
    getActive: () => active,
    getUi: () => ui,
    flush() {},
    $sheet: name => (sheetFor(name) || {}).$grid,
    $ui: ui
  };
}

function createStubs(opts) {
  const properties = Object.assign({}, opts.properties || {});
  const fetchCalls = [];
  const alerts = [];
  const triggers = (opts.triggers || []).map(handler => ({ getHandlerFunction: () => handler }));
  const menus = [];
  const lockLog = [];
  const mails = [];
  const fetchImpl = opts.fetch || (() => ({ code: 200, text: '{}' }));
  const spreadsheet = opts.SpreadsheetApp || makeSpreadsheet(opts.sheets || {}, alerts, menus);

  return {
    SpreadsheetApp: spreadsheet,
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
        if (!r) throw new Error(`fetch stub returned nothing for ${url}`);
        return {
          getResponseCode: () => r.code,
          getContentText: () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.json ?? {})),
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
      WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(trigger) {
        const i = triggers.indexOf(trigger);
        if (i >= 0) triggers.splice(i, 1);
      },
      // Minimal time-based trigger builder; create() registers the trigger.
      newTrigger(handler) {
        const spec = { handler, everyDays: null, atHour: null };
        const builder = {
          timeBased: () => builder,
          everyDays(n) { spec.everyDays = n; return builder; },
          onWeekDay(day) { spec.weekDay = day; return builder; },
          atHour(h) { spec.atHour = h; return builder; },
          create() {
            const trigger = { getHandlerFunction: () => handler, $spec: spec };
            triggers.push(trigger);
            return trigger;
          }
        };
        return builder;
      }
    },
    Session: { getScriptTimeZone: () => 'Europe/Warsaw' },
    // Script lock: opts.lockHeld simulates another run holding it; $lock records calls.
    LockService: {
      getScriptLock: () => ({
        tryLock(ms) { lockLog.push(['tryLock', ms]); if (opts.lockHeld) return false; lockLog.held = true; return true; },
        releaseLock() { lockLog.push(['releaseLock']); lockLog.held = false; },
        hasLock: () => Boolean(lockLog.held)
      })
    },
    Logger: { log() {} },
    MailApp: {
      sendEmail: (to, subject, body) => { mails.push({ to, subject, body }); },
      getRemainingDailyQuota: () => 100
    },
    console,
    $mails: mails,
    $lock: lockLog,
    $fetchCalls: fetchCalls,
    $alerts: alerts,
    $properties: properties,
    $triggers: triggers,
    $menus: menus,
    $sheet: name => spreadsheet.$sheet(name),
    $ui: spreadsheet.$ui,
    $cell: (name, a1) => {
      const { row, col } = parseA1(a1);
      const grid = spreadsheet.$sheet(name) || [];
      return (grid[row - 1] || [])[col - 1] ?? '';
    }
  };
}

/**
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.properties]  Script Properties
 * @param {Record<string,any[][]>} [opts.sheets]      sheet name → rows (row 1 first)
 * @param {(url, params) => {code, text?, json?, headers?}} [opts.fetch]
 * @param {string[]} [opts.triggers]                  handler names of installed triggers
 * @param {boolean}  [opts.lockHeld]                  another run holds the script lock
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

/** Routes fetch calls by URL substring: [[needle, response | fn(url, params)], ...]. */
function fetchRouter(routes) {
  return (url, params) => {
    for (const [needle, response] of routes) {
      if (url.includes(needle)) return typeof response === 'function' ? response(url, params) : response;
    }
    throw new Error(`fetch stub: no route for ${url}`);
  };
}

module.exports = { loadProject, makeSpreadsheet, plain, fetchRouter };
