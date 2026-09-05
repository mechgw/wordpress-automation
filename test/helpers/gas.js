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
const SOURCES = ['Version.gs', 'Lock.gs', 'Kod.gs', 'GA4.gs', 'WordPress.gs', 'CodeSnippets.gs', 'Status.gs', 'Alerts.gs', 'FormSourcePageContext.gs', 'ForminatorHistory.gs'];

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
    setValue(value) {
      ensure(row, col);
      grid[row - 1][col - 1] = value;
      return this;
    },
    setValues(values) {
      values.forEach((line, rOffset) => {
        line.forEach((value, cOffset) => {
          ensure(row + rOffset, col + cOffset);
          grid[row + rOffset - 1][col + cOffset - 1] = value;
        });
      });
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
    setBackground() { return this; },
    setFontWeight() { return this; },
    setFontColor() { return this; },
    setWrap() { return this; },
    setHorizontalAlignment() { return this; },
    setVerticalAlignment() { return this; },
    setBorder() { return this; },
    setFormula(value) { return this.setValue(value); },
    setFormulas(values) { return this.setValues(values); },
    getFormula: () => String((grid[row - 1] || [])[col - 1] || '').startsWith('=') ? (grid[row - 1] || [])[col - 1] : '',
    getFormulas: () => {
      const values = [];
      for (let r = row; r < row + rows; r++) {
        const line = [];
        for (let c = col; c < col + cols; c++) {
          const value = (grid[r - 1] || [])[c - 1] ?? '';
          line.push(String(value).startsWith('=') ? value : '');
        }
        values.push(line);
      }
      return values;
    }
  });

  return {
    name,
    grid,
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const parsed = parseA1(a, grid.length);
        return rangeOf(parsed.row, parsed.col, parsed.rows, parsed.cols);
      }
      return rangeOf(a, b, c || 1, d || 1);
    },
    getLastRow() {
      let last = 0;
      grid.forEach((line, index) => {
        if (line.some(v => v !== '' && v !== null && v !== undefined)) last = index + 1;
      });
      return last;
    },
    getLastColumn() {
      return grid.reduce((max, line) => Math.max(max, line.length), 0);
    },
    getMaxColumns() { return Math.max(this.getLastColumn(), 1); },
    insertColumnsAfter() { return this; },
    appendRow(values) {
      grid.push(values.slice());
      return this;
    },
    clear() {
      grid.splice(0, grid.length);
      return this;
    },
    setFrozenRows() { return this; },
    autoResizeColumns() { return this; }
  };
}

function loadProject(options = {}) {
  const propertyStore = Object.assign({}, options.properties || {});
  const sheetMap = new Map();
  Object.entries(options.sheets || {}).forEach(([name, rows]) => sheetMap.set(name, makeSheet(name, rows)));

  const alerts = [];
  const ui = {
    Button: { YES: 'YES', NO: 'NO', OK: 'OK' },
    ButtonSet: { YES_NO: 'YES_NO' },
    alert(...args) {
      alerts.push(args);
      if (args[2] === this.ButtonSet.YES_NO) return this.$answer || this.Button.YES;
      return this.Button.OK;
    },
    createMenu() {
      return {
        addItem() { return this; },
        addSeparator() { return this; },
        addSubMenu() { return this; },
        addToUi() { return this; }
      };
    },
    $answer: 'YES'
  };

  const fetchCalls = [];
  const fetchImpl = options.fetch || (() => ({ code: 200, text: '{}', json: {}, headers: {} }));

  const context = vm.createContext({
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Map,
    Set,
    encodeURIComponent,
    decodeURIComponent,
    Utilities: {
      base64Encode(value) { return Buffer.from(String(value), 'utf8').toString('base64'); },
      formatDate,
      getUuid() { return '12345678-1234-1234-1234-123456789abc'; }
    },
    Session: {
      getScriptTimeZone() { return 'Europe/Warsaw'; }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return propertyStore[key] ?? null; },
          setProperty(key, value) { propertyStore[key] = String(value); },
          deleteProperty(key) { delete propertyStore[key]; }
        };
      }
    },
    SpreadsheetApp: {
      getUi() { return ui; },
      getActive() {
        return {
          getSheetByName(name) { return sheetMap.get(name) || null; },
          insertSheet(name) {
            const sheet = makeSheet(name, []);
            sheetMap.set(name, sheet);
            return sheet;
          }
        };
      }
    },
    UrlFetchApp: {
      fetch(url, params = {}) {
        fetchCalls.push({ url, params });
        const out = fetchImpl(url, params) || {};
        const code = out.code ?? 200;
        const text = out.text ?? (out.json !== undefined ? JSON.stringify(out.json) : '{}');
        const headers = out.headers || {};
        return {
          getResponseCode() { return code; },
          getContentText() { return text; },
          getAllHeaders() { return headers; }
        };
      }
    },
    MailApp: { sendEmail() {} }
  });

  for (const source of SOURCES) {
    if ((options.skip || []).includes(source)) continue;
    const code = (options.override && options.override[source]) || fs.readFileSync(path.join(ROOT, source), 'utf8');
    vm.runInContext(code, context, { filename: path.join(ROOT, source) });
  }

  context.$fetchCalls = fetchCalls;
  context.$alerts = alerts;
  context.$properties = propertyStore;
  context.$ui = ui;
  context.$sheet = name => sheetMap.get(name)?.grid || null;
  context.$cell = (name, a1) => {
    const sheet = sheetMap.get(name);
    if (!sheet) return undefined;
    const parsed = parseA1(a1, sheet.grid.length);
    return (sheet.grid[parsed.row - 1] || [])[parsed.col - 1] ?? '';
  };
  context.$get = name => vm.runInContext(name, context);

  return context;
}

/** Convert VM objects to plain host objects before deep equality assertions. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadProject, plain };
