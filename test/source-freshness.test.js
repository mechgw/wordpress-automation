'use strict';

/**
 * #197: świeżość zewnętrznego źródła — czysta funkcja JS i generator natywnej
 * formuły z `NOW()`.
 *
 * Harness VM nie liczy formuł, więc formułę z generatora wykonuje tu mały model
 * podzbioru funkcji Arkuszy (`evaluateSheetsFormula`). Model wyłapuje błędy
 * struktury: literówkę, złą pozycję `MID`, zły separator. Nie dowodzi, że Arkusze
 * liczą tak samo — to potwierdził test na prawdziwym arkuszu 2026-09-29 (#197,
 * przypadki 12–21: 37/37 zgodnych z funkcją JS; 22–24: przejście do STALE bez
 * skryptu, powrót do ACTIVE, odczyt zamkniętego pliku przez gviz).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProject } = require('./helpers/gas');

const TZ = 'Europe/Warsaw';

function project() {
  return loadProject({ properties: {} });
}

// --- Model podzbioru formuł Arkuszy -----------------------------------------

const EMPTY = null;
const isError = v => v !== null && typeof v === 'object' && 'error' in v;
const isDateValue = v => v !== null && typeof v === 'object' && 'date' in v;
const err = code => ({ error: code });

function tokenize(src, separator) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (src[j] === '"' && src[j + 1] === '"') { text += '"'; j += 2; continue; }
        if (src[j] === '"') break;
        if (j >= src.length) throw new Error('niedomknięty tekst');
        text += src[j++];
      }
      tokens.push({ type: 'str', value: text });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ type: 'num', value: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(src.slice(i));
    if (id) { tokens.push({ type: 'id', value: id[0] }); i += id[0].length; continue; }
    const op = /^(<=|>=|<>|[<>=+\-*/&()])/.exec(src.slice(i));
    if (op) { tokens.push({ type: 'op', value: op[0] }); i += op[0].length; continue; }
    if (ch === separator) { tokens.push({ type: 'sep' }); i++; continue; }
    throw new Error('nieznany znak w formule: ' + ch + ' (pozycja ' + i + ')');
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type, value) => {
    const t = tokens[pos];
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error('oczekiwano ' + (value || type) + ', jest ' + JSON.stringify(t));
    }
    pos++;
    return t;
  };
  const isOp = (...ops) => peek() && peek().type === 'op' && ops.includes(peek().value);
  function comparison() {
    let left = concat();
    while (isOp('<=', '>=', '<>', '<', '>', '=')) left = { op: eat('op').value, left, right: concat() };
    return left;
  }
  function concat() {
    let left = additive();
    while (isOp('&')) left = { op: eat('op').value, left, right: additive() };
    return left;
  }
  function additive() {
    let left = multiplicative();
    while (isOp('+', '-')) left = { op: eat('op').value, left, right: multiplicative() };
    return left;
  }
  function multiplicative() {
    let left = unary();
    while (isOp('*', '/')) left = { op: eat('op').value, left, right: unary() };
    return left;
  }
  function unary() {
    if (isOp('-')) { eat('op'); return { op: 'neg', arg: unary() }; }
    return primary();
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('nieoczekiwany koniec formuły');
    if (t.type === 'num' || t.type === 'str') { pos++; return { lit: t.value }; }
    if (t.type === 'op' && t.value === '(') { eat('op', '('); const e = comparison(); eat('op', ')'); return e; }
    if (t.type === 'id') {
      pos++;
      if (!isOp('(')) return { name: t.value };
      eat('op', '(');
      const args = [];
      if (!isOp(')')) {
        args.push(comparison());
        while (peek() && peek().type === 'sep') { pos++; args.push(comparison()); }
      }
      eat('op', ')');
      return { call: t.value.toUpperCase(), args };
    }
    throw new Error('nieoczekiwany token ' + JSON.stringify(t));
  }
  const tree = comparison();
  if (pos !== tokens.length) throw new Error('nadmiarowe tokeny od pozycji ' + pos);
  return tree;
}

const toNumber = v => {
  if (isError(v)) return v;
  if (isDateValue(v)) return v.date;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === EMPTY) return 0;
  return err('#VALUE!');
};
const serialOf = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000 + 25569;
const partsOf = serial => {
  const dt = new Date(Math.round((serial - 25569) * 86400000));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const roundSheets = x => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Porównanie jak w Arkuszach: liczby są mniejsze od tekstu. */
function compare(a, b) {
  const rank = v => (typeof v === 'string' ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') return a.localeCompare(b);
  return toNumber(a) - toNumber(b);
}

function evaluate(node, env) {
  if ('lit' in node) return node.lit;
  if ('name' in node) {
    if (Object.prototype.hasOwnProperty.call(env.vars, node.name)) return env.vars[node.name];
    if (Object.prototype.hasOwnProperty.call(env.cells, node.name)) return env.cells[node.name];
    throw new Error('nieznana nazwa: ' + node.name);
  }
  if (node.op === 'neg') {
    const v = toNumber(evaluate(node.arg, env));
    return isError(v) ? v : -v;
  }
  if (node.op) {
    const a = evaluate(node.left, env);
    const b = evaluate(node.right, env);
    if (isError(a)) return a;
    if (isError(b)) return b;
    if (['<=', '>=', '<>', '<', '>', '='].includes(node.op)) {
      const c = compare(a, b);
      return { '<=': c <= 0, '>=': c >= 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '=': c === 0 }[node.op];
    }
    const x = toNumber(a);
    const y = toNumber(b);
    if (isError(x)) return x;
    if (isError(y)) return y;
    return { '+': x + y, '-': x - y, '*': x * y, '/': x / y }[node.op];
  }
  return call(node.call, node.args, env);
}

function call(name, args, env) {
  const ev = a => evaluate(a, env);
  const all = () => args.map(ev);
  const firstError = vals => vals.find(isError);
  switch (name) {
    case 'IFERROR': { const v = ev(args[0]); return isError(v) ? ev(args[1]) : v; }
    case 'IF': {
      const c = ev(args[0]);
      if (isError(c)) return c;
      return c ? ev(args[1]) : ev(args[2]);
    }
    case 'LET': {
      const vars = Object.assign({}, env.vars);
      const inner = { cells: env.cells, vars };
      for (let i = 0; i < args.length - 1; i += 2) vars[args[i].name] = evaluate(args[i + 1], inner);
      return evaluate(args[args.length - 1], inner);
    }
    case 'AND': case 'OR': {
      const vals = all();
      const e = firstError(vals);
      if (e) return e;
      return name === 'AND' ? vals.every(Boolean) : vals.some(Boolean);
    }
    case 'NOT': { const v = ev(args[0]); return isError(v) ? v : !v; }
    case 'NA': return err('#N/A');
    case 'ISTEXT': return typeof ev(args[0]) === 'string';
    case 'ISNUMBER': { const v = ev(args[0]); return typeof v === 'number' || isDateValue(v); }
    // Tekstu model nie parsuje: formuła sprawdza ISTEXT przed ISDATE.
    case 'ISDATE': return isDateValue(ev(args[0]));
    case 'REGEXMATCH': {
      const [text, re] = all();
      return new RegExp(re).test(text);
    }
    case 'MID': {
      const [text, start, len] = all();
      return String(text).substr(start - 1, len);
    }
    case 'VALUE': {
      const v = ev(args[0]);
      return /^\d+$/.test(v) ? Number(v) : err('#VALUE!');
    }
    case 'DATE': {
      const [y, m, d] = all().map(toNumber);
      return { date: Date.UTC(y, m - 1, d) / 86400000 + 25569 };
    }
    case 'TIME': {
      const [h, mi, s] = all().map(toNumber);
      return (h * 3600 + mi * 60 + s) / 86400;
    }
    case 'EOMONTH': {
      const [start, months] = all().map(toNumber);
      const p = partsOf(start);
      return { date: serialOf(p.y, p.m + months + 1, 1) - 1 };
    }
    case 'DAY': return partsOf(toNumber(ev(args[0]))).d;
    case 'ROUND': {
      const v = toNumber(ev(args[0]));
      return isError(v) ? v : roundSheets(v);
    }
    default: throw new Error('funkcja spoza modelu: ' + name);
  }
}

function evaluateSheetsFormula(formula, cells, separator = ',') {
  assert.equal(formula[0], '=');
  const value = evaluate(parse(tokenize(formula.slice(1), separator)), { cells, vars: {} });
  return isError(value) ? value.error : value;
}

/** Wartość komórki arkusza odpowiadająca wartości JS (data → numer seryjny czasu ściennego). */
function cellOf(value) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    const wall = Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds());
    return { date: wall / 86400000 + 25569 };
  }
  if (value === '' || value === undefined) return EMPTY;
  return value;
}

// --- Tabela przypadków (1–10 z #197), wspólna dla funkcji i formuły ----------

function cases(gas) {
  const at = (h, mi = 0, s = 0, ms = 0) => new gas.$Date(2026, 8, 29, h, mi, s, ms);
  return [
    { n: '1. młodszy niż próg', ts: at(11), thr: 2, want: 'ACTIVE' },
    { n: '2. dokładnie na granicy', ts: at(10), thr: 2, want: 'ACTIVE' },
    { n: '2. sekundę za granicą', ts: at(9, 59, 59), thr: 2, want: 'STALE' },
    { n: '2. granica, ułamek sekundy poniżej połowy', ts: at(9, 59, 59, 600), thr: 2, want: 'ACTIVE' },
    { n: '2. granica, ułamek sekundy powyżej połowy', ts: at(9, 59, 59, 400), thr: 2, want: 'STALE' },
    { n: '2. próg ułamkowy 1,5 h na granicy', ts: at(10, 30), thr: 1.5, want: 'ACTIVE' },
    { n: '3. starszy niż próg', ts: at(9), thr: 2, want: 'STALE' },
    { n: '3. starszy o dni', ts: new gas.$Date(2026, 8, 20, 12), thr: 48, want: 'STALE' },
    { n: '4. pusta komórka', ts: '', thr: 2, want: 'ERROR' },
    { n: '5. 30 lutego', ts: '2026-02-30 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. 13. miesiąc', ts: '2026-13-01 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. miesiąc 00', ts: '2026-00-10 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. dzień 00', ts: '2026-09-00 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. godzina 24', ts: '2026-09-29 24:00:00', thr: 2, want: 'ERROR' },
    { n: '5. minuta 60', ts: '2026-09-29 10:60:00', thr: 2, want: 'ERROR' },
    { n: '5. sekunda 60', ts: '2026-09-29 10:00:60', thr: 2, want: 'ERROR' },
    { n: '5. rok przed 1900', ts: '1899-12-31 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. 29 lutego w roku nieprzestępnym', ts: '2025-02-29 10:00:00', thr: 100000, want: 'ERROR' },
    { n: '5. 29 lutego w roku przestępnym', ts: '2024-02-29 10:00:00', thr: 100000, want: 'ACTIVE' },
    { n: '5. liczba bez formatu daty', ts: 46294.5, thr: 2, want: 'ERROR' },
    { n: '5. wartość logiczna', ts: true, thr: 2, want: 'ERROR' },
    { n: '6. próg 0', ts: at(11), thr: 0, want: 'ERROR' },
    { n: '6. próg ujemny', ts: at(11), thr: -1, want: 'ERROR' },
    { n: '6. próg jako tekst', ts: at(11), thr: '2', want: 'ERROR' },
    { n: '6. próg pusty', ts: at(11), thr: '', want: 'ERROR' },
    { n: '6. próg logiczny', ts: at(11), thr: true, want: 'ERROR' },
    { n: '6. próg będący datą', ts: at(11), thr: at(2), want: 'ERROR' },
    { n: '7. znacznik z przyszłości', ts: at(12, 0, 1), thr: 2, want: 'ERROR' },
    { n: '7. przyszłość poniżej pół sekundy to ta sama sekunda', ts: at(12, 0, 0, 400), thr: 2, want: 'ACTIVE' },
    { n: '8. tekst młodszy niż próg', ts: '2026-09-29 11:30:00', thr: 1, want: 'ACTIVE' },
    { n: '8. tekst na granicy', ts: '2026-09-29 11:00:00', thr: 1, want: 'ACTIVE' },
    { n: '8. tekst starszy niż próg', ts: '2026-09-29 10:59:59', thr: 1, want: 'STALE' },
    { n: '8. tekst z przyszłości', ts: '2026-09-29 12:00:01', thr: 1, want: 'ERROR' },
    { n: '9. format ISO z T', ts: '2026-09-29T11:00:00', thr: 2, want: 'ERROR' },
    { n: '9. format polski', ts: '29.09.2026 11:00:00', thr: 2, want: 'ERROR' },
    { n: '9. bez sekund', ts: '2026-09-29 11:00', thr: 2, want: 'ERROR' },
    { n: '9. spacja na końcu', ts: '2026-09-29 11:00:00 ', thr: 2, want: 'ERROR' },
    { n: '9. tekst, który ISDATE uznałby za datę', ts: 'July 20 1969', thr: 2, want: 'ERROR' },
    { n: '10. źródło A, próg 3 h', ts: at(8), thr: 3, want: 'STALE' },
    { n: '10. źródło B, ten sam znacznik, próg 6 h', ts: at(8), thr: 6, want: 'ACTIVE' }
  ];
}

describe('#197: sourceFreshness_ — semantyka ACTIVE/STALE/ERROR', () => {
  test('tabela przypadków 1–10', () => {
    const gas = project();
    const now = new gas.$Date(2026, 8, 29, 12, 0, 0);
    for (const c of cases(gas)) {
      assert.equal(gas.sourceFreshness_(c.ts, c.thr, now, TZ), c.want, c.n);
    }
  });

  test('niepoprawny obiekt daty jako znacznik albo bieżąca chwila → ERROR', () => {
    const gas = project();
    const now = new gas.$Date(2026, 8, 29, 12);
    assert.equal(gas.sourceFreshness_(new gas.$Date('x'), 2, now, TZ), 'ERROR');
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 11), 2, new gas.$Date('x'), TZ), 'ERROR');
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 11), 2, '2026-09-29 12:00:00', TZ), 'ERROR');
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 11), NaN, now, TZ), 'ERROR');
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 11), Infinity, now, TZ), 'ERROR');
  });

  test('zaokrąglenie jak ROUND w Arkuszach: połówki od zera, także ujemne', () => {
    const gas = project();
    assert.equal(gas.roundHalfAwayFromZero_(0.5), 1);
    assert.equal(gas.roundHalfAwayFromZero_(-0.5), -1);
    assert.ok(gas.roundHalfAwayFromZero_(-0.4) === 0); // -0 też jest zerem
    // Znacznik pół sekundy w przyszłości to już sekunda w przyszłości, czyli ERROR.
    // Tylko w JS: w formule (n-s)*86400 trafia w -0,5 z błędem zmiennoprzecinkowym.
    const now = new gas.$Date(2026, 8, 29, 12, 0, 0);
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 12, 0, 0, 500), 2, now, TZ), 'ERROR');
  });

  test('8: tekst jest czytany w strefie arkusza — ten sam wynik co data pokazująca ten sam czas', () => {
    const gas = project();
    const now = new gas.$Date(2026, 8, 29, 12);
    for (const [text, date] of [
      ['2026-09-29 10:00:00', new gas.$Date(2026, 8, 29, 10)],
      ['2026-09-29 09:59:59', new gas.$Date(2026, 8, 29, 9, 59, 59)]
    ]) {
      assert.equal(gas.sourceFreshness_(text, 2, now, TZ), gas.sourceFreshness_(date, 2, now, TZ), text);
    }
  });

  test('zmiana czasu: wiek w czasie ściennym strefy arkusza, jak numery seryjne Arkuszy', () => {
    const gas = project();
    // Stub formatuje w strefie maszyny; tu potrzebna jest prawdziwa strefa arkusza.
    gas.Utilities.formatDate = (date, tz, pattern) => {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(date).map(x => [x.type, x.value]));
      return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
        .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
    };
    // 29.03.2026 w Warszawie: 01:30 CET (00:30Z) i 04:30 CEST (02:30Z) dzielą 2 h
    // rzeczywiste, ale 3 h na zegarze. Arkusz odejmuje numery seryjne czasu lokalnego.
    const ts = new gas.$Date(Date.UTC(2026, 2, 29, 0, 30));
    const now = new gas.$Date(Date.UTC(2026, 2, 29, 2, 30));
    assert.equal(gas.sourceFreshness_(ts, 2.5, now, TZ), 'STALE');
    assert.equal(gas.sourceFreshness_(ts, 3, now, TZ), 'ACTIVE');
    assert.equal(gas.sourceFreshness_('2026-03-29 01:30:00', 3, now, TZ), 'ACTIVE');
  });

  test('11: mechanizm nie czyta arkusza — działa bez dostępu do SpreadsheetApp', () => {
    const gas = project();
    const denied = () => { throw new Error('odczyt arkusza zabroniony w tym teście'); };
    gas.SpreadsheetApp.getActive = denied;
    gas.SpreadsheetApp.getActiveSpreadsheet = denied;
    const now = new gas.$Date(2026, 8, 29, 12);
    assert.equal(gas.sourceFreshness_(new gas.$Date(2026, 8, 29, 11), 2, now, TZ), 'ACTIVE');
    assert.match(gas.sourceFreshnessFormula_('B2', 'C2'), /^=IFERROR\(/);
  });
});

describe('#197: sourceFreshnessFormula_ — natywna formuła z NOW()', () => {
  test('produkcyjnie odwołuje się do NOW() wprost, bez funkcji niestandardowej', () => {
    const gas = project();
    const formula = gas.sourceFreshnessFormula_('B2', 'C2');
    assert.match(formula, /\bcurrent,NOW\(\)/);
    const called = [...formula.matchAll(/([A-Z]+)\(/g)].map(m => m[1]);
    const builtIn = ['IFERROR', 'LET', 'IF', 'ISTEXT', 'REGEXMATCH', 'VALUE', 'MID', 'AND', 'DAY', 'EOMONTH',
      'DATE', 'TIME', 'NA', 'ISDATE', 'ROUND', 'OR', 'NOT', 'ISNUMBER', 'NOW'];
    assert.deepEqual([...new Set(called)].filter(f => !builtIn.includes(f)), []);
  });

  for (const separator of [',', ';']) {
    test(`12–21 w modelu: formuła (separator "${separator}") daje ten sam wynik co funkcja JS`, () => {
      const gas = project();
      const now = new gas.$Date(2026, 8, 29, 12, 0, 0);
      const formula = gas.sourceFreshnessFormula_('B2', 'C2', { now: 'E1', separator });
      for (const c of cases(gas)) {
        const cells = { B2: cellOf(c.ts), C2: cellOf(c.thr), E1: cellOf(now) };
        const fromFormula = evaluateSheetsFormula(formula, cells, separator);
        assert.equal(fromFormula, gas.sourceFreshness_(c.ts, c.thr, now, TZ), c.n);
        assert.equal(fromFormula, c.want, c.n);
      }
    });
  }

  test('separator ";" nie zostawia przecinków, a "," średników', () => {
    const gas = project();
    assert.ok(!gas.sourceFreshnessFormula_('B2', 'C2', { separator: ';' }).includes(','));
    assert.ok(!gas.sourceFreshnessFormula_('B2', 'C2', { separator: ',' }).includes(';'));
  });

  test('odwołania z nazwą arkusza przechodzą bez zmian', () => {
    const gas = project();
    const formula = gas.sourceFreshnessFormula_("'Źródła, zgłoszenia'!B2", "'Źródła, zgłoszenia'!C2", { separator: ';' });
    assert.ok(formula.includes("stamp;'Źródła, zgłoszenia'!B2;limit;'Źródła, zgłoszenia'!C2;current;NOW()"));
  });

  test('błędne wywołanie generatora kończy się czytelnym błędem', () => {
    const gas = project();
    assert.throws(() => gas.sourceFreshnessFormula_('', 'C2'), /niepustych odwołań/);
    assert.throws(() => gas.sourceFreshnessFormula_('B2', undefined), /niepustych odwołań/);
    assert.throws(() => gas.sourceFreshnessFormula_('B2', 'C2', { now: ' ' }), /niepustych odwołań/);
    assert.throws(() => gas.sourceFreshnessFormula_('B2', 'C2', { separator: '|' }), /"," albo ";"/);
  });

  test('README podaje formułę identyczną z generatorem, w obu wariantach separatora', () => {
    const gas = project();
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    for (const separator of [',', ';']) {
      const formula = gas.sourceFreshnessFormula_('B2', 'C2', { separator });
      assert.ok(readme.includes(formula), `README nie zawiera formuły z separatorem "${separator}"`);
    }
  });
});

describe('model formuł użyty w testach sam umie paść', () => {
  test('odrzuca funkcję spoza modelu i niedomknięte wyrażenie', () => {
    assert.throws(() => evaluateSheetsFormula('=FOO(1)', {}), /spoza modelu/);
    assert.throws(() => evaluateSheetsFormula('=IF(1,2', {}), /oczekiwano|koniec/);
    assert.throws(() => evaluateSheetsFormula('=1;2', {}, ','), /nieznany znak/);
  });

  test('zła pozycja MID w formule zmienia wynik względem funkcji JS', () => {
    const gas = project();
    const now = new gas.$Date(2026, 8, 29, 12);
    const broken = gas.sourceFreshnessFormula_('B2', 'C2', { now: 'E1' }).replace('MID(stamp,15,2)', 'MID(stamp,12,2)');
    // Minuty czytane z pozycji godziny: 11:30 staje się 11:11, a wiek przekracza próg 30 min.
    const cells = { B2: '2026-09-29 11:30:00', C2: 0.5, E1: cellOf(now) };
    assert.equal(gas.sourceFreshness_('2026-09-29 11:30:00', 0.5, now, TZ), 'ACTIVE');
    assert.equal(evaluateSheetsFormula(broken, cells), 'STALE');
  });
});
