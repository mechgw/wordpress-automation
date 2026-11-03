'use strict';

/**
 * #240: testy silnika zapadki długu (scripts/quality/debt-ratchet.js).
 *
 * Silnik decyduje o scaleniu, więc testy pilnują trzech rzeczy: (1) miary czytane z komunikatów ESLint
 * zgadzają się z liczbą w kodzie (format komunikatu jest przypięty wersją w locku), (2) klucze funkcji są
 * stabilne przy dopisaniu i przeniesieniu kodu, (3) dług nie wchodzi przez dopisanie wpisu w bazie.
 *
 * Testy tworzą własne drzewa w katalogu tymczasowym. Polecenia git dostają otoczenie bez zmiennych GIT_*:
 * hook pre-commit dziedziczy GIT_DIR i bez tego `git init` w katalogu tymczasowym pisałby do cudzego repo.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ratchet = require('../scripts/quality/debt-ratchet.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'quality', 'debt-ratchet.js');
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-'));
  roots.push(root);
  writeFiles(root, files);
  return root;
}

function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.pl', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
}

const lines = (...l) => `${l.join('\n')}\n`;

const limitsOf = (src, scripts = {}) => ({
  version: 1,
  scopes: {
    src: { files: ['src/*.gs'], sourceType: 'script', keyMode: 'global', limits: src },
    scripts: { files: ['scripts/quality/*.js'], sourceType: 'commonjs', keyMode: 'file', limits: scripts }
  }
});

const A_GS = lines(
  'function plain() {', '  return 1;', '}', '', '/** komentarz', '  wielowierszowy */',
  'function branchy(a, b, c, d, e, f) {', '  // komentarz liniowy', '', '  if (a) { return 1; }', '  if (b) { return 2; }',
  '  if (c) { return 3; }', '  return 4;', '}'
);

const collect = () => {
  const out = [];
  return { out, log: m => out.push(m), error: m => out.push(m) };
};

describe('#240: miary z komunikatów ESLint', () => {
  const all = { complexity: 0, lines: 0, statements: 0, params: 0, depth: 0, fileLines: 0 };

  test('wartości zgadzają się z kodem: złożoność, linie kodu, instrukcje, parametry, zagnieżdżenie, plik', async () => {
    const root = makeRoot({ 'src/A.gs': A_GS });
    const cur = await ratchet.measure(root, limitsOf(all));
    assert.deepEqual(cur.functions['src::branchy'].metrics, { lines: 6, params: 6, statements: 7, complexity: 4, depth: 1 });
    assert.deepEqual(cur.functions['src::plain'].metrics, { lines: 3, statements: 1, complexity: 1 });
    assert.deepEqual(cur.files['src/A.gs'].metrics, { fileLines: 9 });
    assert.equal(cur.functions['src::branchy'].line, 7);
    assert.equal(cur.functions['src::branchy'].file, 'src/A.gs');
  });

  test('granica: na progu nie raportuje, o 1 ponad progiem raportuje (każda miara)', async () => {
    const root = makeRoot({ 'src/A.gs': A_GS });
    const at = { complexity: 4, lines: 6, statements: 7, params: 6, depth: 1, fileLines: 9 };
    const atLimit = await ratchet.measure(root, limitsOf(at));
    assert.deepEqual(atLimit.functions, {});
    assert.deepEqual(atLimit.files['src/A.gs'].metrics, {});
    for (const [metric, n] of Object.entries(at)) {
      const cur = await ratchet.measure(root, limitsOf({ [metric]: n - 1 }));
      const reported = metric === 'fileLines' ? cur.files['src/A.gs'].metrics[metric] : cur.functions['src::branchy'].metrics[metric];
      assert.equal(reported, n, `miara ${metric} powinna być raportowana przy progu ${n - 1}`);
    }
  });

  test('linie kodu nie liczą pustych linii ani komentarzy (blokowych, JSDoc i liniowych)', async () => {
    const root = makeRoot({
      'src/B.gs': lines('/**', ' * Opis', ' */', 'function f() {', '', '  // komentarz', '  /* blok', '     drugi */', '  return 1; // końcowy', '}')
    });
    const cur = await ratchet.measure(root, limitsOf({ lines: 0 }));
    assert.equal(cur.functions['src::f'].metrics.lines, 3);
  });

  test('zagnieżdżenie jest przypisane do najwęższej funkcji, nie do zewnętrznej', async () => {
    const root = makeRoot({
      'src/C.gs': lines('function outer() {', '  function inner(a) {', '    if (a) { if (a > 1) { return 1; } }', '    return 0;', '  }', '  return inner;', '}')
    });
    const cur = await ratchet.measure(root, limitsOf({ depth: 0 }));
    assert.deepEqual(Object.keys(cur.functions), ['src::outer>inner']);
    assert.equal(cur.functions['src::outer>inner'].metrics.depth, 2);
  });

  test('błąd składni w źródle to błąd użycia, nie zielony wynik', async () => {
    const root = makeRoot({ 'src/Z.gs': 'function (' });
    await assert.rejects(ratchet.measure(root, limitsOf({ complexity: 1 })), ratchet.UsageError);
  });

  test('plik skryptu z shebangiem jest czytany, a pozycje zgadzają się z ESLint', async () => {
    const root = makeRoot({ 'scripts/quality/tool.js': lines('#!/usr/bin/env node', "'use strict';", 'function f(a) {', '  if (a) { return 1; }', '  return 2;', '}', 'module.exports = { f };') });
    const cur = await ratchet.measure(root, limitsOf({}, { complexity: 1 }));
    assert.deepEqual(Object.keys(cur.functions), ['scripts::scripts/quality/tool.js::f']);
    assert.equal(cur.functions['scripts::scripts/quality/tool.js::f'].metrics.complexity, 2);
  });
});

describe('#240: klucze funkcji', () => {
  const scope = { files: ['src/*.gs'], sourceType: 'script', keyMode: 'global', limits: {} };
  const keys = (source, sc = scope) => Object.keys(ratchet.analyseScope('src', sc, [{ rel: 'src/A.gs', source }]).hashes);
  const model = source => ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source }]);

  test('nazwy: deklaracje, zmienne, zagnieżdżone `zewnętrzna>wewnętrzna`, metody klas', () => {
    const source = lines(
      'function top() { function inner() {} return inner; }', 'const arrow = () => 1;', 'const expr = function () { return 2; };',
      'class K { method() { return 3; } }'
    );
    assert.deepEqual(keys(source).sort(), ['src::arrow', 'src::expr', 'src::method', 'src::top', 'src::top>inner']);
  });

  test('funkcja przypisana do właściwości obiektu jest anonimowa (klucz ze skrótu ciała)', () => {
    const k = keys('const o = { a: function () { return 1; }, b: () => 2 };');
    assert.equal(k.length, 2);
    assert.ok(k.every(key => /^src::#[0-9a-f]{8}$/.test(key)), k.join(','));
  });

  test('anonimowa funkcja: klucz zależy od ciała, nie od kolejności; dopisanie lambdy przed nią go nie zmienia', () => {
    const before = keys('function f(x) { return x.map(function (v) { return v + 1; }); }');
    const after = keys('function f(x) { x.forEach(function (v) { log(v * 7); }); return x.map(function (v) { return v + 1; }); }');
    const lambda = before.find(k => k.includes('#'));
    assert.ok(lambda.startsWith('src::f>#'));
    assert.ok(after.includes(lambda), 'klucz dotychczasowej lambdy zmienił się po dopisaniu innej');
    assert.equal(after.length, 3);
  });

  test('identyczne anonimowe ciała w jednym miejscu dostają sufiks ~2 w kolejności położenia', () => {
    const k = keys('function f() { return [1].map(function (v) { return v; }).concat([2].map(function (v) { return v; })); }');
    assert.equal(k.length, 3);
    assert.equal(k.filter(key => key.endsWith('~2')).length, 1);
  });

  test('konflikt: dwie funkcje o tej samej nazwie i różnych ciałach są rozróżnione i zgłoszone', () => {
    const m = model('if (a) { function g() { return 1; } } else { function g() { return 2; } }');
    assert.deepEqual(Object.keys(m.hashes).sort(), ['src::g', 'src::g~2']);
    assert.equal(m.conflicts.length, 1);
    assert.match(m.conflicts[0], /src::g: 2 funkcji o tej samej nazwie/);
  });

  test('skrót ciała nie zależy od komentarzy, odstępów i położenia; zmiana treści go zmienia', () => {
    const a = model('function f() { return 1; }').hashes['src::f'];
    const b = model('\n\n// komentarz\nfunction f() {\n  return   1; /* x */\n}\n').hashes['src::f'];
    const c = model('function f() { return 2; }').hashes['src::f'];
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test('przeniesienie funkcji do innego pliku w zakresie globalnym nie zmienia klucza ani skrótu', () => {
    const one = ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source: 'function f() { return 1; }' }, { rel: 'src/B.gs', source: 'function g() {}' }]);
    const two = ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source: 'function g() {}' }, { rel: 'src/B.gs', source: 'function f() { return 1; }' }]);
    assert.equal(one.hashes['src::f'], two.hashes['src::f']);
  });

  test('tryb kluczy `file` dodaje ścieżkę pliku do klucza', () => {
    const k = keys('function f() {}', { files: ['src/*.gs'], sourceType: 'script', keyMode: 'file', limits: {} });
    assert.deepEqual(k, ['src::src/A.gs::f']);
  });

  test('literał BigInt w ciele nie przerywa liczenia skrótu', () => {
    assert.ok(model('function f() { return 10n; }').hashes['src::f']);
  });
});

describe('#240: porównanie z bazą (compare)', () => {
  const LIM = limitsOf({ complexity: 10 }, {});
  const cur = (fns = {}, files = {}, allKeys = null) => ({
    functions: Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, { hash: v.hash || `h-${k}`, file: 'src/A.gs', line: 1, metrics: v.metrics }])),
    allKeys: allKeys || Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, v.hash || `h-${k}`])),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { scope: 'src', hash: v.hash || `f-${k}`, metrics: v.metrics }])),
    conflicts: []
  });
  const bl = (functions = {}, files = {}, tool) => ({ version: 1, tool, functions, files });
  const codes = r => r.findings.filter(f => f.level === 'red').map(f => f.code);
  const infos = r => r.findings.filter(f => f.level === 'info').map(f => f.code);
  const run = (args) => ratchet.compare(Object.assign({ limits: LIM }, args));

  test('bez długu i bez wpisów: zielono', () => {
    assert.deepEqual(run({ current: cur(), baseline: bl() }).findings.filter(f => f.code !== 'no-base'), []);
  });

  test('funkcja ponad limit bez wpisu: czerwono (nowy kod bez wyjątków)', () => {
    assert.deepEqual(codes(run({ current: cur({ 'src::f': { metrics: { complexity: 11 } } }), baseline: bl() })), ['over-limit-no-entry']);
  });

  test('wzrost miary względem wpisu: czerwono; równa wartość: zielono', () => {
    const baseline = bl({ 'src::f': { hash: 'h-src::f', complexity: 20 } });
    assert.deepEqual(codes(run({ current: cur({ 'src::f': { metrics: { complexity: 21 } } }), baseline })), ['growth']);
    assert.deepEqual(codes(run({ current: cur({ 'src::f': { metrics: { complexity: 20 } } }), baseline })), []);
  });

  test('miara ponad limit, której wpis nie ma: czerwono', () => {
    const baseline = bl({ 'src::f': { hash: 'h-src::f', lines: 90 } });
    assert.deepEqual(codes(run({ current: cur({ 'src::f': { metrics: { complexity: 12 } } }), baseline })), ['metric-without-entry']);
  });

  test('spadek miary: lokalnie informacja, w CI czerwono (trzeba obniżyć wpis)', () => {
    const baseline = bl({ 'src::f': { hash: 'h-src::f', complexity: 20 } });
    const current = cur({ 'src::f': { metrics: { complexity: 15 } } });
    const local = run({ current, baseline, ci: false });
    assert.deepEqual(codes(local), []);
    assert.deepEqual(infos(local).filter(c => c === 'shrink'), ['shrink']);
    assert.deepEqual(codes(run({ current, baseline, ci: true })), ['shrink']);
  });

  test('dług spłacony (funkcja poniżej limitu): lokalnie informacja, w CI czerwono', () => {
    const baseline = bl({ 'src::f': { hash: 'h-src::f', complexity: 20 } });
    const current = cur({}, {}, { 'src::f': 'h-src::f' });
    assert.deepEqual(infos(run({ current, baseline })).filter(c => c === 'repaid'), ['repaid']);
    assert.deepEqual(codes(run({ current, baseline, ci: true })), ['repaid']);
  });

  test('wpis bez funkcji: czerwono; zmiana nazwy przy tym samym skrócie wskazuje wpis do przeniesienia', () => {
    const baseline = bl({ 'src::stara': { hash: 'H', complexity: 20 } });
    assert.deepEqual(codes(run({ current: cur({}, {}, {}), baseline })), ['entry-without-function']);
    const renamed = run({ current: cur({ 'src::nowa': { hash: 'H', metrics: { complexity: 20 } } }), baseline });
    assert.deepEqual(codes(renamed).sort(), ['entry-renamed', 'over-limit-no-entry']);
  });

  test('pliki: brak wpisu, wzrost, spadek, spłata i wpis bez pliku', () => {
    const baseline = bl({}, { 'src/A.gs': { fileLines: 500 } });
    const at = n => cur({}, { 'src/A.gs': { metrics: n === null ? {} : { fileLines: n } } });
    assert.deepEqual(codes(run({ current: at(null), baseline: bl() })), []);
    assert.deepEqual(codes(run({ current: at(450), baseline: bl() })), ['file-over-limit-no-entry']);
    assert.deepEqual(codes(run({ current: at(501), baseline })), ['file-growth']);
    assert.deepEqual(codes(run({ current: at(500), baseline })), []);
    assert.deepEqual(codes(run({ current: at(450), baseline, ci: true })), ['file-shrink']);
    assert.deepEqual(codes(run({ current: at(null), baseline, ci: true })), ['file-repaid']);
    assert.deepEqual(codes(run({ current: cur(), baseline })), ['file-entry-without-file']);
  });

  test('różna wersja narzędzia w bazie jest informacją o migracji', () => {
    const baseline = bl({}, {}, { eslint: '0.0.1', espree: '0.0.1' });
    assert.ok(infos(run({ current: cur(), baseline })).includes('tool-changed'));
  });

  describe('nowe wpisy względem stanu bazowego', () => {
    const base = (over = {}) => Object.assign({
      ref: 'main', baselineMissing: false, baseline: bl(), limits: LIM, hashes: {}, fileHashes: {}
    }, over);
    const sameLimits = LIM;

    test('bez stanu bazowego: informacja, nie sprawdzono; brak bazy na main: import dozwolony', () => {
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 20 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 20 } } });
      assert.ok(infos(run({ current, baseline })).includes('no-base'));
      const imp = run({ current, baseline, base: base({ baselineMissing: true, baseline: null }) });
      assert.deepEqual(codes(imp), []);
      assert.ok(infos(imp).includes('import'));
    });

    test('NEGATYW: nowa funkcja ponad limit z dopisanym wpisem w tym samym PR: czerwono', () => {
      const baseline = bl({ 'src::nowa': { hash: 'H', complexity: 30 } });
      const current = cur({ 'src::nowa': { hash: 'H', metrics: { complexity: 30 } } });
      assert.deepEqual(codes(run({ current, baseline, base: base() })), ['new-entry']);
    });

    test('NEGATYW: istniejąca funkcja, której miara nie była wpisana, nie dostaje wpisu bez nowej miary', () => {
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 30 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 30 } } });
      assert.deepEqual(codes(run({ current, baseline, base: base({ hashes: { 'src::f': 'H' }, limits: sameLimits }) })), ['new-entry']);
    });

    test('wprowadzenie nowej miary: wpisy dla niezmienionych funkcji dozwolone', () => {
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 30 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 30 } } });
      const b = base({ hashes: { 'src::f': 'H' }, limits: limitsOf({}) });
      assert.deepEqual(codes(run({ current, baseline, base: b })), []);
    });

    test('zaostrzenie limitu liczy się jak wprowadzenie miary', () => {
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 11 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 11 } } });
      const b = base({ hashes: { 'src::f': 'H' }, limits: limitsOf({ complexity: 20 }) });
      assert.deepEqual(codes(run({ current, baseline, base: b })), []);
    });

    test('NEGATYW: przy nowej mierze wpis dla funkcji ZMIENIONEJ w PR albo z podrobionym skrótem jest czerwony', () => {
      const baseline = bl({ 'src::f': { hash: 'STARY', complexity: 30 } });
      const changed = cur({ 'src::f': { hash: 'NOWY', metrics: { complexity: 30 } } });
      const b = base({ hashes: { 'src::f': 'STARY' }, limits: limitsOf({}) });
      assert.deepEqual(codes(run({ current: changed, baseline, base: b })), ['new-entry']);
      const newFunction = cur({ 'src::g': { hash: 'G', metrics: { complexity: 30 } } });
      assert.deepEqual(codes(run({ current: newFunction, baseline: bl({ 'src::g': { hash: 'G', complexity: 30 } }), base: b })), ['new-entry']);
    });

    test('wzrost wpisu względem main: czerwono nawet gdy wartości w kodzie są zgodne', () => {
      const old = bl({ 'src::f': { hash: 'H', complexity: 20 } });
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 25 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 25 } } });
      assert.deepEqual(codes(run({ current, baseline, base: base({ baseline: old }) })), ['growth-vs-base']);
    });

    test('obniżenie wpisu względem main jest dozwolone', () => {
      const old = bl({ 'src::f': { hash: 'H', complexity: 25 } });
      const baseline = bl({ 'src::f': { hash: 'H', complexity: 20 } });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 20 } } });
      assert.deepEqual(codes(run({ current, baseline, base: base({ baseline: old }) })), []);
    });

    test('przeniesienie wpisu pod nowy klucz (ten sam skrót, stary klucz usunięty, wartość nie większa): dozwolone', () => {
      const old = bl({ 'src::stara': { hash: 'H', complexity: 20 } });
      const baseline = bl({ 'src::nowa': { hash: 'H', complexity: 20 } });
      const current = cur({ 'src::nowa': { hash: 'H', metrics: { complexity: 20 } } });
      assert.deepEqual(codes(run({ current, baseline, base: base({ baseline: old }) })), []);
      const bigger = bl({ 'src::nowa': { hash: 'H', complexity: 21 } });
      const currentBigger = cur({ 'src::nowa': { hash: 'H', metrics: { complexity: 21 } } });
      assert.deepEqual(codes(run({ current: currentBigger, baseline: bigger, base: base({ baseline: old }) })), ['new-entry']);
    });

    test('migracja po zmianie wersji narzędzia: wzrost wpisu wymaga uzasadnienia i tego samego skrótu', () => {
      const old = bl({ 'src::f': { hash: 'H', complexity: 20 } }, {}, { eslint: '1', espree: '1' });
      const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 22 } } });
      const with_ = bl({ 'src::f': { hash: 'H', complexity: 22, uzasadnienie: 'nowy sposób liczenia' } }, {}, { eslint: '2', espree: '2' });
      const without = bl({ 'src::f': { hash: 'H', complexity: 22 } }, {}, { eslint: '2', espree: '2' });
      const otherHash = bl({ 'src::f': { hash: 'X', complexity: 22, uzasadnienie: 'x' } }, {}, { eslint: '2', espree: '2' });
      assert.deepEqual(codes(run({ current, baseline: with_, base: base({ baseline: old }) })), []);
      assert.deepEqual(codes(run({ current, baseline: without, base: base({ baseline: old }) })), ['growth-vs-base']);
      assert.deepEqual(codes(run({ current, baseline: otherHash, base: base({ baseline: old }) })).includes('growth-vs-base'), true);
    });

    test('pliki: nowy wpis dozwolony tylko dla nowej miary i niezmienionego pliku', () => {
      const baseline = bl({}, { 'src/A.gs': { fileLines: 500 } });
      const current = cur({}, { 'src/A.gs': { hash: 'F1', metrics: { fileLines: 500 } } });
      const withLimit = limitsOf({ fileLines: 400 });
      const fresh = limitsOf({});
      const go = (b, limits = withLimit) => run({ current, baseline, limits, base: b });
      assert.deepEqual(codes(go(base({ fileHashes: { 'src/A.gs': 'F1' }, limits: fresh }))), []);
      assert.deepEqual(codes(go(base({ fileHashes: { 'src/A.gs': 'F0' }, limits: fresh }))), ['new-file-entry']);
      assert.deepEqual(codes(go(base({ fileHashes: { 'src/A.gs': 'F1' }, limits: withLimit }))), ['new-file-entry']);
      const old = bl({}, { 'src/A.gs': { fileLines: 400 } });
      assert.deepEqual(codes(go(base({ baseline: old }))), ['file-growth-vs-base']);
    });
  });
});

describe('#240: konfiguracja i baza', () => {
  test('walidacja limitów: nieznana miara, zły typ źródła, zły tryb kluczy, ujemny limit, brak plików', () => {
    const ok = limitsOf({ complexity: 12 });
    assert.equal(ratchet.validateLimits(ok), ok);
    const mutate = fn => { const l = JSON.parse(JSON.stringify(ok)); fn(l.scopes.src); return l; };
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.limits.nieznana = 1; })), /nieznana miara "nieznana"/);
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.sourceType = 'x'; })), /sourceType/);
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.keyMode = 'x'; })), /keyMode/);
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.limits.complexity = -1; })), /liczbą całkowitą/);
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.limits.complexity = 1.5; })), /liczbą całkowitą/);
    assert.throws(() => ratchet.validateLimits(mutate(s => { s.files = []; })), /niepustą listą/);
    assert.throws(() => ratchet.validateLimits({ version: 2, scopes: {} }), /oczekiwano/);
  });

  test('walidacja bazy: brak skrótu, miara plikowa we wpisie funkcji, miara funkcji we wpisie pliku, nie-liczba', () => {
    const base = { version: 1, functions: {}, files: {} };
    assert.equal(ratchet.validateBaseline(base), base);
    assert.throws(() => ratchet.validateBaseline({ version: 1, functions: { f: { complexity: 1 } }, files: {} }), /bez skrótu/);
    assert.throws(() => ratchet.validateBaseline({ version: 1, functions: { f: { hash: 'h', fileLines: 1 } }, files: {} }), /niepoprawna miara/);
    assert.throws(() => ratchet.validateBaseline({ version: 1, functions: {}, files: { 'a.gs': { complexity: 1 } } }), /niepoprawna miara/);
    assert.throws(() => ratchet.validateBaseline({ version: 1, functions: { f: { hash: 'h', complexity: '3' } }, files: {} }), /niepoprawna miara/);
    assert.throws(() => ratchet.validateBaseline({ version: 3 }), /oczekiwano/);
  });

  test('wzorce plików: * nie przekracza katalogu, ** przekracza, ? to jeden znak', () => {
    assert.ok(ratchet.globToRegExp('src/*.gs').test('src/A.gs'));
    assert.ok(!ratchet.globToRegExp('src/*.gs').test('src/sub/A.gs'));
    assert.ok(ratchet.globToRegExp('src/**/*.gs').test('src/sub/A.gs'));
    assert.ok(ratchet.globToRegExp('src/**/*.gs').test('src/A.gs'));
    assert.ok(ratchet.globToRegExp('src/**').test('src/a/b.gs'));
    assert.ok(ratchet.globToRegExp('a?.gs').test('ab.gs'));
    assert.ok(!ratchet.globToRegExp('a.gs').test('axgs'));
  });

  test('argumenty: tryb, baza, korzeń; nieznany argument i zły tryb to błąd użycia', () => {
    const o = ratchet.parseArgs(['--mode=report', '--base=origin/main', '--ci', 'check']);
    assert.equal(o.mode, 'report');
    assert.equal(o.base, 'origin/main');
    assert.equal(o.ci, true);
    assert.equal(o.command, 'check');
    assert.equal(ratchet.parseArgs([]).mode, 'enforce');
    assert.equal(ratchet.parseArgs([]).base, 'none');
    assert.equal(ratchet.parseArgs(['write-baseline']).command, 'write-baseline');
    assert.throws(() => ratchet.parseArgs(['--mode=x']), ratchet.UsageError);
    assert.throws(() => ratchet.parseArgs(['--nieznany']), /nieznany argument/);
  });

  test('buildBaseline zapisuje tylko miary ponad limit, posortowane, ze skrótem i wersjami narzędzi', () => {
    const current = {
      functions: { 'src::b': { hash: 'B', metrics: { lines: 50 } }, 'src::a': { hash: 'A', metrics: { complexity: 20, lines: 41 } } },
      files: { 'src/X.gs': { scope: 'src', hash: 'x', metrics: { fileLines: 450 } }, 'src/Y.gs': { scope: 'src', hash: 'y', metrics: {} } }
    };
    const baseline = ratchet.buildBaseline(current);
    assert.deepEqual(Object.keys(baseline.functions), ['src::a', 'src::b']);
    assert.deepEqual(baseline.functions['src::a'], { hash: 'A', complexity: 20, lines: 41 });
    assert.deepEqual(baseline.files, { 'src/X.gs': { fileLines: 450 } });
    assert.match(baseline.tool.eslint, /^\d+\.\d+\.\d+/);
    assert.match(baseline.tool.espree, /^\d+\.\d+\.\d+/);
  });
});

describe('#240: przebieg całości (CLI) na tymczasowym repozytorium', () => {
  const LIMITS = JSON.stringify(limitsOf({ complexity: 3, lines: 5 }, {}), null, 2);
  const FILES = {
    '.quality/debt-limits.json': LIMITS,
    'src/A.gs': lines(
      'function stary(a, b) {', '  if (a) { return 1; }', '  if (b) { return 2; }', '  if (a && b) { return 3; }', '  return 4;', '}',
      'function drobna() { return 1; }'
    )
  };

  async function run(root, ...args) {
    const io = collect();
    const code = await ratchet.main([`--root=${root}`, ...args], io);
    return { code, text: io.out.join('\n') };
  }

  test('write-baseline zapisuje dług; kolejny check jest zielony; wzrost złożoności daje czerwono (enforce) i 0 w trybie raportu', async () => {
    const root = makeRoot(FILES);
    assert.equal((await run(root, 'write-baseline')).code, 0);
    const baseline = JSON.parse(fs.readFileSync(path.join(root, '.quality/debt-baseline.json'), 'utf8'));
    assert.deepEqual(Object.keys(baseline.functions), ['src::stary']);
    assert.equal(baseline.functions['src::stary'].complexity, 5);
    assert.equal((await run(root)).code, 0);

    writeFiles(root, { 'src/A.gs': FILES['src/A.gs'].replace('  return 4;', '  if (a || b) { return 5; }\n  return 4;') });
    const enforce = await run(root);
    assert.equal(enforce.code, 1);
    assert.match(enforce.text, /RED growth src::stary: complexity rośnie: 5 -> \d+/);
    const report = await run(root, '--mode=report');
    assert.equal(report.code, 0);
    assert.match(report.text, /tryb raportu, nie blokuje/);
  });

  test('nowa funkcja ponad limit bez wpisu daje czerwono, a w CI adnotację ::error', async () => {
    const root = makeRoot(FILES);
    await run(root, 'write-baseline');
    writeFiles(root, { 'src/A.gs': `${FILES['src/A.gs']}function nowa(a) { if (a) { if (a > 1) { if (a > 2) { return 1; } } } return 0; }\n` });
    const r = await run(root, '--ci');
    assert.equal(r.code, 1);
    assert.match(r.text, /RED over-limit-no-entry src::nowa/);
    assert.match(r.text, /::error title=debt-ratchet over-limit-no-entry::/);
    assert.equal((await run(root, '--ci', '--mode=report')).text.includes('::warning title=debt-ratchet'), true);
  });

  test('przeniesienie funkcji z długiem do innego pliku nie zmienia wyniku', async () => {
    const root = makeRoot(FILES);
    await run(root, 'write-baseline');
    const moved = FILES['src/A.gs'].split('function drobna')[0];
    writeFiles(root, { 'src/A.gs': 'function drobna() { return 1; }\n', 'src/B.gs': moved });
    const r = await run(root, '--ci');
    assert.equal(r.code, 0, r.text);
  });

  test('spłata długu: lokalnie zielono z informacją, w CI czerwono do obniżenia wpisu', async () => {
    const root = makeRoot(FILES);
    await run(root, 'write-baseline');
    writeFiles(root, { 'src/A.gs': 'function stary(a, b) { return a + b; }\nfunction drobna() { return 1; }\n' });
    const local = await run(root);
    assert.equal(local.code, 0);
    assert.match(local.text, /INFO repaid src::stary/);
    assert.equal((await run(root, '--ci')).code, 1);
  });

  test('brak pliku limitów albo zły argument: kod 2, nie zielony wynik', async () => {
    const root = makeRoot({ 'src/A.gs': 'function f() {}\n' });
    const r = await run(root);
    assert.equal(r.code, 2);
    assert.match(r.text, /BŁĄD: plik limitów: brak pliku/);
    const bad = await run(root, '--mode=zly');
    assert.equal(bad.code, 2);
  });

  test('skrypt uruchomiony jako program zwraca kod wyjścia i drukuje podsumowanie', () => {
    const root = makeRoot(Object.assign({}, FILES, { '.quality/debt-baseline.json': '{ "version": 1, "functions": {}, "files": {} }' }));
    const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CZERWONE: 2 aktywnych miar/);
  });
});

describe('#240: stan bazowy z gita (loadBase) i nowe wpisy w PR', () => {
  const LIMITS_EMPTY = JSON.stringify(limitsOf({}, {}), null, 2);
  const LIMITS_CX = JSON.stringify(limitsOf({ complexity: 3 }, {}), null, 2);
  const SRC = lines('function stary(a, b) {', '  if (a) { return 1; }', '  if (b) { return 2; }', '  if (a && b) { return 3; }', '  return 4;', '}');

  function repoWithBase(files) {
    const root = makeRoot(files);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'baza');
    return root;
  }

  async function run(root, ...args) {
    const io = collect();
    const code = await ratchet.main([`--root=${root}`, '--base=main', '--ci', ...args], io);
    return { code, text: io.out.join('\n') };
  }

  test('loadBase czyta bazę, limity i skróty ze stanu refu, a brak refu to błąd użycia', () => {
    const root = repoWithBase({ '.quality/debt-limits.json': LIMITS_CX, 'src/A.gs': SRC });
    const base = ratchet.loadBase(root, 'main', JSON.parse(LIMITS_CX));
    assert.equal(base.baselineMissing, true);
    assert.deepEqual(Object.keys(base.hashes), ['src::stary']);
    assert.equal(base.limits.scopes.src.limits.complexity, 3);
    assert.equal(Object.keys(base.fileHashes).length, 1);
    assert.throws(() => ratchet.loadBase(root, 'nie-ma-takiego-refu', JSON.parse(LIMITS_CX)), /nie znaleziono nie-ma-takiego-refu/);
  });

  test('import: pierwszy PR wprowadzający bazę i miarę jest zielony', async () => {
    const root = repoWithBase({ '.quality/debt-limits.json': LIMITS_EMPTY, 'src/A.gs': SRC });
    writeFiles(root, { '.quality/debt-limits.json': LIMITS_CX });
    await ratchet.main([`--root=${root}`, 'write-baseline'], collect());
    const r = await run(root);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /INFO import/);
  });

  test('NEGATYW: PR dopisuje nową funkcję ponad limit razem z jej wpisem w bazie: czerwono', async () => {
    const root = repoWithBase({ '.quality/debt-limits.json': LIMITS_CX, 'src/A.gs': SRC, '.quality/debt-baseline.json': '{ "version": 1, "functions": {}, "files": {} }' });
    writeFiles(root, { '.quality/debt-baseline.json': '{ "version": 1, "functions": {}, "files": {} }' });
    // baza na main jest pusta, a stara funkcja ponad limit bez wpisu jest już błędem; zerujemy to wpisem w main:
    await ratchet.main([`--root=${root}`, 'write-baseline'], collect());
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'dług wpisany');
    writeFiles(root, { 'src/A.gs': `${SRC}function nowa(a) { if (a) { if (a > 1) { if (a > 2) { return 1; } } } return 0; }\n` });
    await ratchet.main([`--root=${root}`, 'write-baseline'], collect());
    const r = await run(root);
    assert.equal(r.code, 1);
    assert.match(r.text, /RED new-entry src::nowa/);
  });

  test('wprowadzenie miary w PR: wpis dla niezmienionej funkcji jest dozwolony, dla funkcji zmienionej w tym PR nie', async () => {
    const root = repoWithBase({ '.quality/debt-limits.json': LIMITS_EMPTY, 'src/A.gs': SRC });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'nic');
    // main ma pustą bazę, więc import jest już zamknięty
    writeFiles(root, { '.quality/debt-baseline.json': '{ "version": 1, "functions": {}, "files": {} }' });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'pusta baza');
    writeFiles(root, { '.quality/debt-limits.json': LIMITS_CX });
    await ratchet.main([`--root=${root}`, 'write-baseline'], collect());
    const ok = await run(root);
    assert.equal(ok.code, 0, ok.text);

    writeFiles(root, { 'src/A.gs': SRC.replace('return 4;', 'return 44;') });
    await ratchet.main([`--root=${root}`, 'write-baseline'], collect());
    const changed = await run(root);
    assert.equal(changed.code, 1);
    assert.match(changed.text, /RED new-entry src::stary/);
  });

  test('nieznany ref w --base to kod 2', async () => {
    const root = repoWithBase({ '.quality/debt-limits.json': LIMITS_EMPTY, 'src/A.gs': SRC });
    const io = collect();
    const code = await ratchet.main([`--root=${root}`, '--base=brak'], io);
    assert.equal(code, 2);
    assert.match(io.out.join('\n'), /BŁĄD: --base: nie znaleziono brak/);
  });
});
