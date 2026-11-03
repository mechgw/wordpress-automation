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

// Silnik uruchomiony przez pomyłkę podczas importu (process.exit w trakcie testów) kończyłby proces kodem 0 przed końcem testów.
let allTestsDone = false;
after(() => { allTestsDone = true; });
process.on('exit', () => { if (!allTestsDone) process.exitCode = 1; });

// Silnik domyślnie przyjmuje tryb CI z GITHUB_ACTIONS; testy ustawiają `--ci` jawnie, więc zmiennej nie dziedziczą.
delete process.env.GITHUB_ACTIONS;
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
      const onMain = base({ baseline: old, hashes: { 'src::f': 'H' } });
      assert.deepEqual(codes(run({ current, baseline: with_, base: onMain })), []);
      assert.deepEqual(codes(run({ current, baseline: without, base: onMain })), ['growth-vs-base']);
      assert.deepEqual(codes(run({ current, baseline: otherHash, base: onMain })).includes('growth-vs-base'), true);
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

// ---------------------------------------------------------------------------
// Testy dopisane po przebiegu mutacyjnym: dokładne komunikaty, gałęzie błędów, kolejności i skrajne położenia.
// ---------------------------------------------------------------------------

const { ESLint } = require('eslint');
const espree = require('espree');

/** Podmienia `ESLint.prototype.lintFiles`, żeby sprawdzić obsługę komunikatów, których prawdziwy ESLint nie wyprodukuje. */
async function withLintStub(stub, fn) {
  const original = ESLint.prototype.lintFiles;
  ESLint.prototype.lintFiles = stub;
  try {
    return await fn();
  } finally {
    ESLint.prototype.lintFiles = original;
  }
}

const msg = (over = {}) => Object.assign({
  ruleId: 'complexity', severity: 2, line: 1, column: 1, message: "Function 'a' has a complexity of 3. Maximum allowed is 0."
}, over);

describe('#240: miary dwucyfrowe i obsługa komunikatów ESLint', () => {
  const big = () => {
    const ifs = Array.from({ length: 11 }, () => '  if (a) { x += 1; }');
    const deep = ['function deep(a) {'];
    for (let i = 0; i < 10; i += 1) deep.push(`${' '.repeat(i + 1)}if (a) {`);
    for (let i = 9; i >= 0; i -= 1) deep.push(`${' '.repeat(i + 1)}}`);
    deep.push('}');
    return lines('function wide(a, b, c, d, e, f, g, h, i, j) {', '  let x = 0;', ...ifs, '  return x;', '}', ...deep);
  };

  test('wartości o dwóch cyfrach są czytane w całości, nie tylko pierwsza cyfra', async () => {
    const root = makeRoot({ 'src/Big.gs': big() });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 0, lines: 0, statements: 0, params: 0, depth: 0, fileLines: 0 }));
    assert.deepEqual(cur.functions['src::wide'].metrics, { lines: 15, params: 10, statements: 24, complexity: 12, depth: 1 });
    assert.equal(cur.functions['src::deep'].metrics.depth, 10);
    assert.equal(cur.files['src/Big.gs'].metrics.fileLines, 15 + 22);
  });

  test('metody klas, gettery i funkcje we właściwościach są przypisane do właściwej funkcji (ESLint raportuje od klucza)', async () => {
    const root = makeRoot({
      'src/K.gs': lines(
        'class K {', '  m(a) { if (a) { return 1; } return 2; }', '  get g() { if (this.a) { return 1; } return 2; }',
        '  static s(a) { if (a) { return 1; } return 2; }', '  f = (a) => { if (a) { return 1; } return 2; };', '}',
        'const o = { n: function (a) { if (a) { return 1; } return 2; } };'
      )
    });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 1 }));
    const keys = Object.keys(cur.functions);
    assert.deepEqual(keys.slice(0, 4), ['src::m', 'src::g', 'src::s', 'src::f']);
    assert.match(keys[4], /^src::#[0-9a-f]{8}$/);
    assert.deepEqual(keys.map(k => cur.functions[k].metrics.complexity), [2, 2, 2, 2, 2]);
  });

  test('sąsiednie funkcje bez separatora: komunikat z początku drugiej nie trafia do pierwszej', async () => {
    const root = makeRoot({ 'src/Adj.gs': 'function a() {}function b(x) { if (x) { return 1; } return 2; }\n' });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 1 }));
    assert.deepEqual(Object.keys(cur.functions), ['src::b']);
  });

  test('kilka komunikatów tej samej miary w jednej funkcji: wygrywa największa wartość, także gdy pojawia się pierwsza', async () => {
    const root = makeRoot({ 'src/A.gs': 'function a() {}\n' });
    const deep = n => msg({ ruleId: 'max-depth', message: `Blocks are nested too deeply (${n}). Maximum allowed is 0.` });
    const cur = await withLintStub(async paths => paths.map(p => ({ filePath: p, messages: [deep(3), deep(1)] })), () => ratchet.measure(root, limitsOf({ depth: 0 })));
    assert.equal(cur.functions['src::a'].metrics.depth, 3);
  });

  test('fatalny komunikat i każdy komunikat bez reguły to błąd użycia; komunikaty innych reguł są pomijane', async () => {
    const root = makeRoot({ 'src/A.gs': 'function a() {}\n' });
    const go = messages => withLintStub(async paths => paths.map(p => ({ filePath: p, messages })), () => ratchet.measure(root, limitsOf({ complexity: 0 })));
    await assert.rejects(go([msg({ fatal: true, ruleId: null, message: 'Parsing error: x' })]), e => e instanceof ratchet.UsageError && e.message === 'src/A.gs: Parsing error: x');
    await assert.rejects(go([msg({ ruleId: null, severity: 2, message: 'Konfiguracja zepsuta' })]), e => e instanceof ratchet.UsageError && e.message === 'src/A.gs: Konfiguracja zepsuta');
    await assert.rejects(go([msg({ ruleId: null, severity: 1, message: 'File ignored' })]), e => e instanceof ratchet.UsageError && e.message === 'src/A.gs: File ignored');
    assert.deepEqual((await go([msg({ ruleId: 'no-undef', severity: 2, message: "'x' is not defined." })])).functions, {});
    assert.deepEqual((await go([msg({ ruleId: 'no-undef', severity: 1, message: "'x' is not defined." })])).functions, {});
  });

  test('nieznany format komunikatu miary i pozycja poza funkcją to błąd użycia z opisem', async () => {
    const root = makeRoot({ 'src/A.gs': 'function a() {}\n' });
    const go = messages => withLintStub(async paths => paths.map(p => ({ filePath: p, messages })), () => ratchet.measure(root, limitsOf({ complexity: 0 })));
    await assert.rejects(go([msg({ message: 'dziwny komunikat' })]),
      e => e instanceof ratchet.UsageError && e.message === 'src/A.gs: nieznany format komunikatu ESLint dla miary complexity: dziwny komunikat');
    await assert.rejects(go([msg({ line: 1, column: 40 })]),
      e => e instanceof ratchet.UsageError && e.message === 'src/A.gs:1: nie znaleziono funkcji dla miary complexity');
  });

  test('ESLint jest wołany tylko dla zakresu z limitami i plikami; bez limitów albo bez plików nie lintuje całego katalogu', async () => {
    let calls = 0;
    const stub = async paths => { calls += 1; return paths.map(p => ({ filePath: p, messages: [] })); };
    const rootEmpty = makeRoot({ 'src/A.gs': 'function a() {}\n' });
    await withLintStub(stub, () => ratchet.measure(rootEmpty, limitsOf({})));
    assert.equal(calls, 0, 'zakres bez limitów nie powinien wołać ESLint');
    const rootNoFiles = makeRoot({ 'inne/B.gs': 'function b() {}\n' });
    await withLintStub(stub, () => ratchet.measure(rootNoFiles, limitsOf({ complexity: 1 })));
    assert.equal(calls, 0, 'zakres bez plików nie powinien wołać ESLint');
    await withLintStub(stub, () => ratchet.measure(rootEmpty, limitsOf({ complexity: 1 })));
    assert.equal(calls, 1);
  });

  test('błąd spoza UsageError jest przekazany dalej, nie zamieniony w kod 2', async () => {
    const root = makeRoot({ '.quality/debt-limits.json': JSON.stringify(limitsOf({ complexity: 1 })), 'src/A.gs': 'function a() {}\n' });
    const boom = async () => { throw new Error('boom'); };
    await withLintStub(boom, () => assert.rejects(ratchet.main([`--root=${root}`], collect()), /boom/));
  });
});

describe('#240: pomiar katalogów i zakresów', () => {
  const everything = { version: 1, scopes: { all: { files: ['**/*.js'], sourceType: 'commonjs', keyMode: 'file', limits: {} } } };

  test('lista plików: posortowana, bez node_modules, .git i coverage na żadnej głębokości', async () => {
    const root = makeRoot({
      'z.js': 'module.exports = 1;\n', 'a.js': 'module.exports = 2;\n', 'lib/b.js': 'module.exports = 3;\n', 'lib/deep/c.js': 'module.exports = 4;\n',
      'node_modules/m.js': 'syntax error here', '.git/x.js': 'syntax error here', 'coverage/c.js': 'syntax error here', 'lib/node_modules/n.js': 'syntax error here'
    });
    const cur = await ratchet.measure(root, everything);
    assert.deepEqual(Object.keys(cur.files), ['a.js', 'lib/b.js', 'lib/deep/c.js', 'z.js']);
    assert.deepEqual(cur.conflicts, []);
  });

  test('zakres z kilkoma wzorcami obejmuje pliki pasujące do któregokolwiek', async () => {
    const root = makeRoot({ 'src/A.gs': 'function a() {}\n', 'lib/B.gs': 'function b() {}\n', 'inne/C.gs': 'function c() {}\n' });
    const limits = { version: 1, scopes: { s: { files: ['src/*.gs', 'lib/*.gs'], sourceType: 'script', keyMode: 'global', limits: {} } } };
    const cur = await ratchet.measure(root, limits);
    assert.deepEqual(Object.keys(cur.files), ['lib/B.gs', 'src/A.gs']);
  });

  test('wzorzec `**/` obejmuje też zero katalogów', () => {
    const re = ratchet.globToRegExp('src/**/x.gs');
    assert.ok(re.test('src/x.gs'));
    assert.ok(re.test('src/a/b/x.gs'));
    assert.ok(!re.test('src/a/y.gs'));
  });
});

describe('#240: klucze funkcji: skrajne przypadki', () => {
  const scope = { files: ['src/*.gs'], sourceType: 'script', keyMode: 'global', limits: {} };
  const names = source => ratchet.listFunctions(source, 'script').map(f => f.name);

  test('nazwy metod: literał i liczba tak, klucz obliczany i prywatny nie; pole z lambdą ma nazwę pola', () => {
    assert.deepEqual(names("class A { 'lit'() { return 1; } 1() { return 2; } }"), ['lit', '1']);
    assert.deepEqual(names('class A { [k]() { return 1; } }'), [null]);
    assert.deepEqual(names('class A { #p() { return 1; } }'), [null]);
    assert.deepEqual(names('class A { f = () => 1; }'), ['f']);
  });

  test('funkcja w kluczu obliczanym, w destrukturyzacji i w literale obiektu jest anonimowa (null, nie undefined)', () => {
    assert.deepEqual(names('class A { [function () { return 1; }]() {} }').slice(0, 1), [null]);
    assert.deepEqual(names('const { a } = function () { return 1; };'), [null]);
    assert.deepEqual(names('const o = { m() { return 1; } };'), [null]);
    assert.deepEqual(names('const x = function () { return 1; };'), ['x']);
  });

  test('funkcja anonimowa nie wchodzi do łańcucha nazw: zagnieżdżona w niej dostaje klucz zewnętrznej nazwy', () => {
    const fns = ratchet.listFunctions('function o() { return [1].map(function () { function inner() { return 1; } return inner; }); }', 'script');
    assert.deepEqual(fns.map(f => f.rawKey).filter(k => !k.includes('#')), ['o', 'o>inner']);
  });

  test('pojedyncza funkcja i duplikat o tym samym ciele nie są konfliktem; różne ciała są', () => {
    const one = ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source: 'function f() { return 1; }' }]);
    assert.deepEqual(one.conflicts, []);
    const same = ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source: 'function f() { return 1; } function f() { return 1; }' }]);
    assert.deepEqual(Object.keys(same.hashes), ['src::f', 'src::f~2']);
    assert.deepEqual(same.conflicts, []);
  });

  test('kolejność plików wejściowych nie zmienia kluczy, a konflikt wskazuje pliki i wiersze', () => {
    const a = { rel: 'src/A.gs', source: 'function f() { return 1; }' };
    const b = { rel: 'src/B.gs', source: 'function f() { return 2; }' };
    const m = ratchet.analyseScope('src', scope, [b, a]);
    assert.equal(m.functions.find(f => f.key === 'src::f').rel, 'src/A.gs');
    assert.deepEqual(m.conflicts, ['src::f: 2 funkcji o tej samej nazwie i różnych ciałach (src/A.gs:1, src/B.gs:1)']);
  });

  test('błąd składni ma prefiks pliku; skrót pliku ignoruje różnicę CRLF i LF', () => {
    assert.throws(() => ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source: 'function (' }]),
      e => e instanceof ratchet.UsageError && e.message.startsWith('src/A.gs: błąd składni ('));
    const hashOf = source => ratchet.analyseScope('src', scope, [{ rel: 'src/A.gs', source }]).fileHashes['src/A.gs'];
    assert.equal(hashOf('var a = 1;\r\nvar b = 2;\r\n'), hashOf('var a = 1;\nvar b = 2;\n'));
    assert.notEqual(hashOf('var a = 1;\nvar b = 2;\n'), hashOf('var a = 1;var b = 2;'));
  });

  test('skrót ciała nie zależy od położenia w pliku ani od kolumny', () => {
    const hashOf = source => ratchet.listFunctions(source, 'script')[0].hash;
    assert.equal(hashOf('function f() { return [1, 2]; }'), hashOf('\n\n\n      function f() { return [1,\n   2]; }'));
  });
});

describe('#240: konfiguracja, baza i argumenty: komunikaty', () => {
  const okLimits = () => JSON.parse(JSON.stringify(limitsOf({ complexity: 12 })));
  const bad = (fn, re) => {
    const l = okLimits();
    fn(l.scopes.src);
    assert.throws(() => ratchet.validateLimits(l), e => e instanceof ratchet.UsageError && re.test(e.message), String(re));
  };

  test('walidacja limitów: dokładne komunikaty i przypadki graniczne', () => {
    assert.throws(() => ratchet.validateLimits(null), ratchet.UsageError);
    assert.throws(() => ratchet.validateLimits({ version: 1, scopes: null }), /oczekiwano/);
    assert.throws(() => ratchet.validateLimits({ version: 2, scopes: {} }), /oczekiwano \{ "version": 1, "scopes": \{\.\.\.\} \}/);
    bad(s => { s.files = [1]; }, /^\.quality\/debt-limits\.json: zakres src: "files" musi być niepustą listą wzorców$/);
    bad(s => { s.files = 'src/*.gs'; }, /"files" musi być niepustą listą wzorców/);
    bad(s => { s.files = []; }, /"files" musi być niepustą listą wzorców/);
    bad(s => { s.sourceType = 'x'; }, /zakres src: "sourceType" to script, commonjs, module$/);
    bad(s => { s.keyMode = 'x'; }, /zakres src: "keyMode" to global, file$/);
    bad(s => { s.limits.nieznana = 1; }, /zakres src: nieznana miara "nieznana" \(znane: complexity, lines, statements, params, depth, fileLines\)$/);
    bad(s => { s.limits.complexity = -1; }, /zakres src: limit miary "complexity" musi być liczbą całkowitą >= 0$/);
    const ok = okLimits();
    ok.scopes.src.sourceType = 'module';
    ok.scopes.src.limits.complexity = 0;
    assert.equal(ratchet.validateLimits(ok), ok);
  });

  test('walidacja bazy: wpisy poprawne przechodzą, błędne mają dokładne komunikaty', () => {
    const good = { version: 1, functions: { f: { hash: 'h', complexity: 3, lines: 9, uzasadnienie: 'x' } }, files: { 'a.gs': { fileLines: 450 } } };
    assert.equal(ratchet.validateBaseline(good), good);
    const fails = (b, re) => assert.throws(() => ratchet.validateBaseline(b), e => e instanceof ratchet.UsageError && re.test(e.message), String(re));
    assert.throws(() => ratchet.validateBaseline(null), ratchet.UsageError);
    fails({ version: 2, functions: {}, files: {} }, /oczekiwano \{ "version": 1, "functions": \{\.\.\.\}, "files": \{\.\.\.\} \}/);
    fails({ version: 1, functions: null, files: {} }, /oczekiwano/);
    fails({ version: 1, functions: {}, files: null }, /oczekiwano/);
    fails({ version: 1, functions: 'x', files: {} }, /oczekiwano/);
    fails({ version: 1, functions: {}, files: 'x' }, /oczekiwano/);
    fails({ version: 1, functions: { f: { complexity: 1 } }, files: {} }, /^\.quality\/debt-baseline\.json: wpis f bez skrótu "hash"$/);
    fails({ version: 1, functions: { f: { hash: 'h', zzz: 1 } }, files: {} }, /wpis f: niepoprawna miara "zzz"$/);
    fails({ version: 1, functions: { f: { hash: 'h', fileLines: 1 } }, files: {} }, /wpis f: niepoprawna miara "fileLines"$/);
    fails({ version: 1, functions: { f: { hash: 'h', complexity: '3' } }, files: {} }, /wpis f: niepoprawna miara "complexity"$/);
    fails({ version: 1, functions: {}, files: { 'a.gs': { zzz: 1 } } }, /wpis pliku a\.gs: niepoprawna miara "zzz"$/);
    fails({ version: 1, functions: {}, files: { 'a.gs': { complexity: 1 } } }, /wpis pliku a\.gs: niepoprawna miara "complexity"$/);
    fails({ version: 1, functions: {}, files: { 'a.gs': { fileLines: '4' } } }, /wpis pliku a\.gs: niepoprawna miara "fileLines"$/);
  });

  test('ładowanie: niepoprawny JSON, brak pliku i domyślna pusta baza', () => {
    const root = makeRoot({ '.quality/debt-limits.json': '{', '.quality/debt-baseline.json': '[' });
    assert.throws(() => ratchet.loadLimits(root), e => e instanceof ratchet.UsageError && /^plik limitów: niepoprawny JSON \(/.test(e.message));
    assert.throws(() => ratchet.loadBaseline(root), e => e instanceof ratchet.UsageError && /^baza długu: niepoprawny JSON \(/.test(e.message));
    const empty = makeRoot({});
    assert.throws(() => ratchet.loadLimits(empty), e => e instanceof ratchet.UsageError && /^plik limitów: brak pliku \(/.test(e.message));
    const fresh = ratchet.loadBaseline(empty);
    assert.deepEqual(Object.keys(fresh), ['version', 'tool', 'functions', 'files']);
    assert.equal(fresh.version, 1);
    assert.deepEqual(fresh.functions, {});
    assert.deepEqual(fresh.files, {});
  });

  test('buildBaseline sortuje także pliki', () => {
    const current = {
      functions: {},
      files: { 'src/B.gs': { scope: 'src', hash: 'b', metrics: { fileLines: 2 } }, 'src/A.gs': { scope: 'src', hash: 'a', metrics: { fileLines: 1 } } }
    };
    assert.deepEqual(Object.keys(ratchet.buildBaseline(current).files), ['src/A.gs', 'src/B.gs']);
  });

  test('parseArgs: wartości domyślne, CI z GITHUB_ACTIONS i korzeń repozytorium', () => {
    const saved = process.env.GITHUB_ACTIONS;
    try {
      delete process.env.GITHUB_ACTIONS;
      assert.deepEqual(ratchet.parseArgs([]), { command: 'check', mode: 'enforce', base: 'none', ci: false, root: path.resolve(__dirname, '..') });
      process.env.GITHUB_ACTIONS = 'true';
      assert.equal(ratchet.parseArgs([]).ci, true);
      process.env.GITHUB_ACTIONS = 'false';
      assert.equal(ratchet.parseArgs([]).ci, false);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = saved;
    }
    assert.equal(ratchet.parseArgs(['--root=x/y']).root, path.resolve('x/y'));
    assert.throws(() => ratchet.parseArgs(['--mode=zly']), e => e instanceof ratchet.UsageError && e.message === '--mode: report albo enforce, nie zly');
  });
});

describe('#240: compare: komunikaty, poziomy i skrajne przypadki', () => {
  const LIM = limitsOf({ complexity: 10, fileLines: 400 }, {});
  const cur = (fns = {}, files = {}, allKeys = null, conflicts = []) => ({
    functions: Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, { hash: v.hash || `h-${k}`, file: 'src/A.gs', line: 1, metrics: v.metrics }])),
    allKeys: allKeys || Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, v.hash || `h-${k}`])),
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { scope: 'src', hash: v.hash || `f-${k}`, metrics: v.metrics }])),
    conflicts
  });
  const bl = (functions = {}, files = {}, tool) => ({ version: 1, tool, functions, files });
  const run = args => ratchet.compare(Object.assign({ limits: LIM }, args));
  const one = (args, code) => {
    const found = run(args).findings.filter(f => f.code === code);
    assert.equal(found.length, 1, `oczekiwano jednego ${code}`);
    return found[0];
  };
  const base = (over = {}) => Object.assign({ ref: 'main', baselineMissing: false, baseline: bl(), limits: LIM, hashes: {}, fileHashes: {} }, over);
  const redCodes = r => r.findings.filter(f => f.level === 'red').map(f => f.code);
  const tools = ratchet.buildBaseline({ functions: {}, files: {} }).tool;

  test('funkcje: dokładne komunikaty, klucz i poziom', () => {
    const f = (metrics, extra = {}) => cur({ 'src::f': { metrics } }, {}, null, extra.conflicts);
    assert.deepEqual(one({ current: f({ complexity: 11 }), baseline: bl() }, 'over-limit-no-entry'),
      { level: 'red', code: 'over-limit-no-entry', key: 'src::f', message: 'complexity=11 ponad limit 10 (src/A.gs:1), brak wpisu w bazie' });
    assert.deepEqual(one({ current: f({ complexity: 12 }), baseline: bl({ 'src::f': { hash: 'h-src::f', lines: 90 } }) }, 'metric-without-entry'),
      { level: 'red', code: 'metric-without-entry', key: 'src::f', message: 'complexity=12 ponad limit 10 (src/A.gs:1), wpis nie ma tej miary' });
    const entry = bl({ 'src::f': { hash: 'h-src::f', complexity: 20 } });
    assert.deepEqual(one({ current: f({ complexity: 21 }), baseline: entry }, 'growth'),
      { level: 'red', code: 'growth', key: 'src::f', message: 'complexity rośnie: 20 -> 21 (src/A.gs:1)' });
    assert.deepEqual(one({ current: f({ complexity: 15 }), baseline: entry }, 'shrink'),
      { level: 'info', code: 'shrink', key: 'src::f', message: 'complexity spadło: 20 -> 15 (src/A.gs:1), obniż wpis' });
    assert.equal(one({ current: f({ complexity: 15 }), baseline: entry, ci: true }, 'shrink').level, 'red');
    assert.deepEqual(run({ current: f({ complexity: 20 }), baseline: entry, ci: true }).findings.filter(x => x.code !== 'no-base'), []);
  });

  test('wpisy funkcji: spłata miary po miarze, przeniesienie i brak funkcji', () => {
    const two = bl({ 'src::f': { hash: 'H', complexity: 20, lines: 90 } });
    const repaid = one({ current: cur({ 'src::f': { hash: 'H', metrics: { complexity: 20 } } }), baseline: two }, 'repaid');
    assert.deepEqual(repaid, { level: 'info', code: 'repaid', key: 'src::f', message: 'lines poniżej limitu: usuń miarę z wpisu' });
    assert.deepEqual(one({ current: cur({}, {}, {}), baseline: bl({ 'src::a': { hash: 'H', complexity: 20 } }) }, 'entry-without-function'),
      { level: 'red', code: 'entry-without-function', key: 'src::a', message: 'wpis bez funkcji (usunięta albo zmieniona): usuń wpis' });
    assert.deepEqual(one({ current: cur({ 'src::b': { hash: 'H', metrics: { complexity: 20 } } }), baseline: bl({ 'src::a': { hash: 'H', complexity: 20 } }) }, 'entry-renamed'),
      { level: 'red', code: 'entry-renamed', key: 'src::a', message: 'funkcja ma teraz klucz src::b (ten sam skrót ciała): przenieś wpis' });
    // cel przeniesienia, który już ma wpis, ani inny skrót ciała nie są przeniesieniem
    const taken = bl({ 'src::a': { hash: 'H', complexity: 20 }, 'src::b': { hash: 'H', complexity: 20 } });
    assert.deepEqual(redCodes(run({ current: cur({ 'src::b': { hash: 'H', metrics: { complexity: 20 } } }, {}, { 'src::b': 'H' }), baseline: taken })), ['entry-without-function']);
    const other = run({ current: cur({ 'src::b': { hash: 'INNY', metrics: { complexity: 20 } } }, {}, { 'src::b': 'INNY' }), baseline: bl({ 'src::a': { hash: 'H', complexity: 20 } }) });
    assert.deepEqual(redCodes(other).sort(), ['entry-without-function', 'over-limit-no-entry']);
  });

  test('pliki: dokładne komunikaty; równa wartość w CI jest zielona', () => {
    const at = n => cur({}, { 'src/A.gs': { metrics: n === null ? {} : { fileLines: n } } });
    assert.deepEqual(one({ current: at(450), baseline: bl() }, 'file-over-limit-no-entry'),
      { level: 'red', code: 'file-over-limit-no-entry', key: 'src/A.gs', message: 'fileLines=450 ponad limit 400, brak wpisu w bazie' });
    assert.deepEqual(one({ current: at(450), baseline: bl({}, { 'src/A.gs': {} }) }, 'file-metric-without-entry'),
      { level: 'red', code: 'file-metric-without-entry', key: 'src/A.gs', message: 'fileLines=450 ponad limit 400, wpis nie ma tej miary' });
    const entry = bl({}, { 'src/A.gs': { fileLines: 500 } });
    assert.deepEqual(one({ current: at(501), baseline: entry }, 'file-growth'),
      { level: 'red', code: 'file-growth', key: 'src/A.gs', message: 'fileLines rośnie: 500 -> 501' });
    assert.deepEqual(one({ current: at(450), baseline: entry }, 'file-shrink'),
      { level: 'info', code: 'file-shrink', key: 'src/A.gs', message: 'fileLines spadło: 500 -> 450, obniż wpis' });
    assert.deepEqual(redCodes(run({ current: at(500), baseline: entry, ci: true })), []);
    assert.deepEqual(one({ current: at(null), baseline: entry }, 'file-repaid'),
      { level: 'info', code: 'file-repaid', key: 'src/A.gs', message: 'fileLines poniżej limitu: usuń miarę z wpisu' });
    assert.deepEqual(one({ current: cur(), baseline: entry }, 'file-entry-without-file'),
      { level: 'red', code: 'file-entry-without-file', key: 'src/A.gs', message: 'wpis bez pliku (usunięty albo przeniesiony): usuń wpis' });
  });

  test('informacje: konflikt kluczy, zmiana narzędzi, brak stanu bazowego i import', () => {
    const conflict = 'src::g: 2 funkcji o tej samej nazwie i różnych ciałach (src/A.gs:1, src/A.gs:2)';
    assert.deepEqual(one({ current: cur({}, {}, {}, [conflict]), baseline: bl() }, 'key-conflict'),
      { level: 'info', code: 'key-conflict', key: 'src::g', message: `konflikt kluczy (rozróżniono sufiksem ~n): ${conflict}` });
    const old = { eslint: '0.0.1', espree: '0.0.1' };
    assert.deepEqual(one({ current: cur(), baseline: bl({}, {}, old) }, 'tool-changed'), {
      level: 'info', code: 'tool-changed', key: '-',
      message: `baza zapisana narzędziami ${JSON.stringify(old)}, bieżące ${JSON.stringify({ eslint: ESLint.version, espree: espree.version })}: przelicz bazę (migracja)`
    });
    const noTool = run({ current: cur(), baseline: bl() }).findings.map(f => f.code);
    const sameTool = run({ current: cur(), baseline: bl({}, {}, tools) }).findings.map(f => f.code);
    assert.ok(!noTool.includes('tool-changed') && !sameTool.includes('tool-changed'));
    assert.deepEqual(one({ current: cur(), baseline: bl() }, 'no-base'),
      { level: 'info', code: 'no-base', key: '-', message: 'brak porównania ze stanem bazowym (--base): nie sprawdzono nowych wpisów' });
    assert.deepEqual(one({ current: cur(), baseline: bl(), base: base({ baselineMissing: true, baseline: null }) }, 'import'),
      { level: 'info', code: 'import', key: '-', message: 'na main nie ma bazy: import długu, nowe wpisy dozwolone' });
  });

  test('względem stanu bazowego: komunikaty nowych wpisów i wzrostu, równość nie jest wzrostem', () => {
    const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 30 } } });
    assert.deepEqual(one({ current, baseline: bl({ 'src::f': { hash: 'H', complexity: 30 } }), base: base() }, 'new-entry'), {
      level: 'red', code: 'new-entry', key: 'src::f',
      message: 'nowy wpis complexity=30 względem main: dług nie wchodzi przez dopisanie wpisu (nowa lub zmieniona funkcja musi mieścić się w limicie)'
    });
    const old = base({ baseline: bl({ 'src::f': { hash: 'H', complexity: 25 } }) });
    assert.deepEqual(one({ current, baseline: bl({ 'src::f': { hash: 'H', complexity: 30 } }), base: old }, 'growth-vs-base'),
      { level: 'red', code: 'growth-vs-base', key: 'src::f', message: 'complexity wpisu rośnie względem main: 25 -> 30' });
    const same = bl({ 'src::f': { hash: 'H', complexity: 30 } });
    assert.deepEqual(redCodes(run({ current, baseline: same, base: base({ baseline: same }) })), []);
  });

  test('migracja narzędzi wymaga realnej zmiany wersji: te same wersje z uzasadnieniem nie legalizują wzrostu', () => {
    const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 22 } } });
    const grown = (tool, uzasadnienie) => bl({ 'src::f': Object.assign({ hash: 'H', complexity: 22 }, uzasadnienie ? { uzasadnienie } : {}) }, {}, tool);
    const old = tool => base({ baseline: bl({ 'src::f': { hash: 'H', complexity: 20 } }, {}, tool), hashes: { 'src::f': 'H' } });
    const v1 = { eslint: '1', espree: '1' };
    const v2 = { eslint: '2', espree: '2' };
    assert.deepEqual(redCodes(run({ current, baseline: grown(v1, 'x'), base: old(v1) })), ['growth-vs-base']);
    assert.deepEqual(redCodes(run({ current, baseline: grown(undefined, 'x'), base: old(undefined) })), ['growth-vs-base']);
    assert.deepEqual(redCodes(run({ current, baseline: grown(v2, 'x'), base: old(v1) })), []);
    assert.deepEqual(redCodes(run({ current, baseline: grown(v2, 'x'), base: old(undefined) })), []);
    assert.deepEqual(redCodes(run({ current, baseline: grown(undefined, 'x'), base: old(v1) })), []);
  });

  test('nowa miara we wpisie, który już istniał z inną miarą: dozwolona tylko przy nowej mierze i niezmienionej funkcji', () => {
    const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 30, lines: 5 } } });
    const baseline = bl({ 'src::f': { hash: 'H', complexity: 30, lines: 5 } });
    const old = bl({ 'src::f': { hash: 'H', lines: 5 } });
    const sameLimits = limitsOf({ complexity: 10, lines: 3 });
    const go = b => run({ current, baseline, limits: sameLimits, base: base(Object.assign({ baseline: old, limits: sameLimits }, b)) });
    assert.deepEqual(redCodes(go({ hashes: { 'src::f': 'H' } })), ['new-entry']);
    assert.deepEqual(redCodes(go({ hashes: { 'src::f': 'H' }, limits: limitsOf({ lines: 3 }) })), []);
  });

  test('przeniesienie wpisu: stary klucz musi zniknąć, skrót musi się zgadzać i miara musi istnieć', () => {
    const current = cur({ 'src::nowa': { hash: 'H', metrics: { complexity: 20 } } });
    const baseline = bl({ 'src::nowa': { hash: 'H', complexity: 20 } });
    const moved = oldFunctions => run({ current, baseline, base: base({ baseline: bl(oldFunctions) }) });
    assert.deepEqual(redCodes(moved({ 'src::stara': { hash: 'H', complexity: 20 } })), []);
    assert.ok(redCodes(moved({ 'src::stara': { hash: 'INNY', complexity: 20 } })).includes('new-entry'));
    assert.ok(redCodes(moved({ 'src::stara': { hash: 'H', lines: 20 } })).includes('new-entry'));
    const copy = run({ current, baseline: bl({ 'src::nowa': { hash: 'H', complexity: 20 }, 'src::stara': { hash: 'H', complexity: 20 } }), base: base({ baseline: bl({ 'src::stara': { hash: 'H', complexity: 20 } }) }) });
    assert.deepEqual(redCodes(copy).sort(), ['entry-without-function', 'new-entry']);
  });

  test('ocena „miara wprowadzona w PR”: brak zakresów albo limitów w stanie bazowym to miara nowa; miara bez limitu nią nie jest', () => {
    const current = cur({ 'src::f': { hash: 'H', metrics: { complexity: 30 } } });
    const baseline = bl({ 'src::f': { hash: 'H', complexity: 30 } });
    const go = b => redCodes(run({ current, baseline, base: base(Object.assign({ hashes: { 'src::f': 'H' } }, b)) }));
    assert.deepEqual(go({ limits: {} }), []);
    assert.deepEqual(go({ limits: { scopes: {} } }), []);
    assert.deepEqual(go({ limits: { scopes: { src: {} } } }), []);
    assert.deepEqual(go({ limits: { scopes: { src: { limits: {} } } } }), []);
    assert.deepEqual(go({ limits: { scopes: { src: { limits: { complexity: 40 } } } } }), []);
    assert.deepEqual(go({ limits: { scopes: { src: { limits: { complexity: 10 } } } } }), ['new-entry']);
    const noLimit = bl({ 'src::f': { hash: 'H', lines: 30 } });
    assert.deepEqual(redCodes(run({ current, baseline: noLimit, base: base({ hashes: { 'src::f': 'H' }, limits: limitsOf({}) }) })).includes('new-entry'), true);
  });

  test('pliki względem stanu bazowego: dokładne komunikaty, równość, wpis bez miary, plik poza zakresem i usunięty', () => {
    const current = cur({}, { 'src/A.gs': { hash: 'F1', metrics: { fileLines: 500 } } });
    const baseline = bl({}, { 'src/A.gs': { fileLines: 500 } });
    const fresh = limitsOf({});
    assert.deepEqual(one({ current, baseline, base: base({ fileHashes: { 'src/A.gs': 'F0' }, limits: fresh }) }, 'new-file-entry'), {
      level: 'red', code: 'new-file-entry', key: 'src/A.gs',
      message: 'nowy wpis fileLines=500 względem main: plik ponad limit musi mieścić się w limicie (albo być niezmieniony, gdy miara jest nowa)'
    });
    assert.deepEqual(one({ current, baseline, base: base({ baseline: bl({}, { 'src/A.gs': { fileLines: 400 } }) }) }, 'file-growth-vs-base'),
      { level: 'red', code: 'file-growth-vs-base', key: 'src/A.gs', message: 'fileLines wpisu rośnie względem main: 400 -> 500' });
    assert.deepEqual(redCodes(run({ current, baseline, base: base({ baseline: bl({}, { 'src/A.gs': { fileLines: 500 } }) }) })), []);
    // wpis pliku bez tej miary, mimo nowej miary w limitach, to nadal nowy wpis tylko gdy plik się zmienił
    assert.deepEqual(redCodes(run({ current, baseline, base: base({ baseline: bl({}, { 'src/A.gs': {} }) }) })), ['new-file-entry']);
    // plik usunięty z drzewa albo spoza zakresów nie może dostać wpisu
    const gone = run({ current: cur(), baseline, base: base({ fileHashes: { 'src/A.gs': 'F1' }, limits: fresh }) });
    assert.deepEqual(redCodes(gone).sort(), ['file-entry-without-file', 'new-file-entry']);
    const outside = run({ current: cur(), baseline: bl({}, { 'x.txt': { fileLines: 9 } }), base: base({ limits: fresh }) });
    assert.deepEqual(redCodes(outside).sort(), ['file-entry-without-file', 'new-file-entry']);
  });
});

describe('#240: stan bazowy z gita: skrajne przypadki', () => {
  const LIMITS_CX = JSON.stringify(limitsOf({ complexity: 3 }, {}), null, 2);
  const SRC = lines('function stary(a, b) {', '  if (a) { return 1; }', '  if (b) { return 2; }', '  return 4;', '}');

  function repo(files) {
    const root = makeRoot(files);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'baza');
    return root;
  }

  test('zmienne GIT_* z otoczenia nie przekierowują poleceń gita', () => {
    const root = repo({ 'src/A.gs': SRC });
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = path.join(root, 'nie-ma-takiego-katalogu');
    process.env.GIT_INDEX_FILE = path.join(root, 'nie-ma-indeksu');
    try {
      const base = ratchet.loadBase(root, 'main', JSON.parse(LIMITS_CX));
      assert.deepEqual(Object.keys(base.hashes), ['src::stary']);
    } finally {
      for (const [name, value] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.index]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  test('brak limitów na refie to pusty zestaw zakresów; nieistniejący ref ma dokładny komunikat', () => {
    const root = repo({ 'src/A.gs': SRC });
    const base = ratchet.loadBase(root, 'main', JSON.parse(LIMITS_CX));
    assert.deepEqual(base.limits, { scopes: {} });
    assert.equal(base.ref, 'main');
    assert.equal(base.baseline, null);
    assert.throws(() => ratchet.loadBase(root, 'brak', JSON.parse(LIMITS_CX)),
      e => e instanceof ratchet.UsageError && e.message === '--base: nie znaleziono brak (w CI potrzebna pełna historia: fetch-depth: 0)');
  });

  test('uszkodzona baza albo limity na refie to błąd użycia z nazwą refu', () => {
    const badBaseline = repo({ '.quality/debt-baseline.json': '{', 'src/A.gs': SRC });
    assert.throws(() => ratchet.loadBase(badBaseline, 'main', JSON.parse(LIMITS_CX)),
      e => e instanceof ratchet.UsageError && /^baza długu na main: niepoprawny JSON \(/.test(e.message));
    const badLimits = repo({ '.quality/debt-limits.json': '{', 'src/A.gs': SRC });
    assert.throws(() => ratchet.loadBase(badLimits, 'main', JSON.parse(LIMITS_CX)),
      e => e instanceof ratchet.UsageError && /^plik limitów na main: niepoprawny JSON \(/.test(e.message));
  });

  test('baza i limity na refie są wczytane razem ze skrótami plików', () => {
    const root = repo({ '.quality/debt-baseline.json': '{ "version": 1, "functions": {}, "files": {} }', '.quality/debt-limits.json': LIMITS_CX, 'src/A.gs': SRC });
    const base = ratchet.loadBase(root, 'main', JSON.parse(LIMITS_CX));
    assert.equal(base.baselineMissing, false);
    assert.deepEqual(base.baseline.functions, {});
    assert.equal(base.limits.scopes.src.limits.complexity, 3);
    assert.deepEqual(Object.keys(base.fileHashes), ['src/A.gs']);
  });

  test('polecenia gita nie przeciekają komunikatami na stderr, gdy bazy nie ma na refie', () => {
    const root = repo({ '.quality/debt-limits.json': LIMITS_CX, 'src/A.gs': SRC });
    const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, '--base=main', '--mode=report'], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /INFO import -: na main nie ma bazy/);
  });
});

describe('#240: CLI: dokładne wyjście', () => {
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
    return { code, lines: io.out };
  }

  test('write-baseline wypisuje liczbę funkcji i plików, a check kończy się dokładnym podsumowaniem', async () => {
    const root = makeRoot(FILES);
    const written = await run(root, 'write-baseline');
    assert.deepEqual(written.lines, ['[debt-ratchet] zapisano .quality/debt-baseline.json: 1 funkcji, 0 plików']);
    const ok = await run(root);
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.lines.slice(-1), ['[debt-ratchet] OK: 2 aktywnych miar, 1 funkcji i 0 plików ponad limit, 0 naruszeń']);
    writeFiles(root, { 'src/A.gs': FILES['src/A.gs'].replace('return 4;', 'if (a || b) { return 5; }\n  return 4;') });
    const red = await run(root, '--mode=report');
    assert.equal(red.code, 0);
    assert.ok(red.lines.includes('[debt-ratchet] RED growth src::stary: complexity rośnie: 5 -> 7 (src/A.gs:1)'), red.lines.join('\n'));
    assert.ok(red.lines.includes('[debt-ratchet] RED growth src::stary: lines rośnie: 6 -> 7 (src/A.gs:1)'), red.lines.join('\n'));
    assert.equal(red.lines.at(-1), '[debt-ratchet] CZERWONE: 2 aktywnych miar, 1 funkcji i 0 plików ponad limit, 2 naruszeń (tryb raportu, nie blokuje)');
    assert.equal((await run(root)).code, 1);
  });

  test('adnotacje ::error i ::warning tylko dla czerwonych w CI; informacje i tryb lokalny ich nie mają', async () => {
    const root = makeRoot(FILES);
    const local = await run(root);
    assert.equal(local.code, 1);
    assert.equal(local.lines.some(l => l.startsWith('::')), false);
    assert.ok(local.lines.includes('[debt-ratchet] RED over-limit-no-entry src::stary: complexity=5 ponad limit 3 (src/A.gs:1), brak wpisu w bazie'), local.lines.join('\n'));
    const enforce = await run(root, '--ci');
    const annotations = enforce.lines.filter(l => l.startsWith('::'));
    assert.equal(annotations.length, 2);
    assert.ok(annotations.includes('::error title=debt-ratchet over-limit-no-entry::src::stary: complexity=5 ponad limit 3 (src/A.gs:1), brak wpisu w bazie'), annotations.join('\n'));
    const report = await run(root, '--ci', '--mode=report');
    assert.equal(report.lines.filter(l => l.startsWith('::warning title=debt-ratchet over-limit-no-entry::')).length, 2);
    await run(root, 'write-baseline');
    const info = await run(root, '--ci');
    assert.equal(info.lines.some(l => l.startsWith('::')), false, 'informacja nie dostaje adnotacji');
    assert.ok(info.lines[0].startsWith('[debt-ratchet] INFO no-base -: '), info.lines[0]);
  });

  test('błąd użycia wypisuje prefiks i daje kod 2', async () => {
    const root = makeRoot({});
    const r = await run(root);
    assert.equal(r.code, 2);
    assert.equal(r.lines[0].startsWith('[debt-ratchet] BŁĄD: plik limitów: brak pliku ('), true, r.lines[0]);
    assert.deepEqual((await run(root, '--mode=zly')).lines, ['[debt-ratchet] BŁĄD: --mode: report albo enforce, nie zly']);
  });

  test('uruchomiony bez --root liczy od korzenia repozytorium, niezależnie od katalogu roboczego', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--mode=report'], { encoding: 'utf8', env: cleanEnv(), cwd: os.tmpdir() });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[debt-ratchet\] (OK|CZERWONE): \d+ aktywnych miar/);
  });
});

describe('#240: mutacje, runda 2: położenia, zakresy i wyjście programu', () => {
  test('arrow w arrow: oba komunikaty trafiają do właściwych funkcji (pozycja z `=>`)', async () => {
    const root = makeRoot({ 'src/Arrows.gs': 'const f=a=>b=>1;\n' });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 0 }));
    const keys = Object.keys(cur.functions);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], 'src::f');
    assert.match(keys[1], /^src::f>#[0-9a-f]{8}$/);
  });

  test('dwie funkcje w argumentach jednego wywołania: komunikat pierwszej nie trafia do drugiej', async () => {
    const root = makeRoot({ 'src/Args.gs': 'run(function a(x) { if (x) { return 1; } return 2; }, function b() { return 1; });\n' });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 1 }));
    assert.deepEqual(Object.keys(cur.functions), ['src::a']);
  });

  test('komunikat z jednego pliku nie trafia do funkcji innego pliku zakresu', async () => {
    const root = makeRoot({ 'src/A.gs': 'function aaa(x) { if (x) { return 1; } return 2; }\n', 'src/B.gs': 'function bbb() { return 1; /* dłuższe ciało */ }\n' });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 1 }));
    assert.deepEqual(Object.keys(cur.functions), ['src::aaa']);
    assert.equal(cur.functions['src::aaa'].file, 'src/A.gs');
  });

  test('konflikty kluczy z pomiaru trafiają do wyniku', async () => {
    const root = makeRoot({ 'src/A.gs': 'if (a) { function g() { return 1; } } else { function g() { return 2; } }\n' });
    const cur = await ratchet.measure(root, limitsOf({}));
    assert.equal(cur.conflicts.length, 1);
    assert.match(cur.conflicts[0], /^src::g: 2 funkcji/);
  });

  test('typ źródła z zakresu jest stosowany: `with` w skrypcie (.gs) i `return` na górze modułu commonjs', async () => {
    const root = makeRoot({
      'src/W.gs': 'function w(x) { with (x) { return a; } }\n',
      'scripts/quality/top.js': 'if (process.argv.length > 99) { return; }\nmodule.exports = 1;\n'
    });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 0 }, { complexity: 0 }));
    assert.deepEqual(Object.keys(cur.functions), ['src::w']);
  });

  test('wzorzec zakresu musi kończyć się rozszerzeniem; plik bez dopasowanej konfiguracji nie daje cichej zieleni', async () => {
    const bad = limitsOf({ complexity: 1 });
    bad.scopes.src.files = ['src/*'];
    assert.throws(() => ratchet.validateLimits(bad), e => e instanceof ratchet.UsageError && /zakres src: każdy wzorzec "files" musi kończyć się rozszerzeniem pliku/.test(e.message));
    for (const files of [['src/*.gs', 'src/*'], ['src/a.b/*']]) {
      const partly = limitsOf({ complexity: 1 });
      partly.scopes.src.files = files;
      assert.throws(() => ratchet.validateLimits(partly), /musi kończyć się rozszerzeniem pliku/, files.join());
    }
    const mixed = limitsOf({ complexity: 1 });
    mixed.scopes.src.files = ['src/*.gs', 1];
    assert.throws(() => ratchet.validateLimits(mixed), /"files" musi być niepustą listą wzorców/);
    const root = makeRoot({ 'src/A.gs': 'function a() {}\n' });
    const ignoredByEslint = async paths => paths.map(p => ({ filePath: p, messages: [{ ruleId: null, severity: 1, message: 'File ignored because no matching configuration was supplied.', line: 0, column: 0 }] }));
    await assert.rejects(withLintStub(ignoredByEslint, () => ratchet.measure(root, limitsOf({ complexity: 0 }))),
      e => e instanceof ratchet.UsageError && e.message === 'src/A.gs: File ignored because no matching configuration was supplied.');
  });

  test('lista plików: sortowanie pełnych ścieżek i brak plików spoza dysku', async () => {
    const root = makeRoot({ 'lib.js': 'module.exports = 1;\n', 'lib/b.js': 'module.exports = 2;\n', 'a.js': 'module.exports = 3;\n' });
    const all = { version: 1, scopes: { all: { files: ['**/*.js'], sourceType: 'commonjs', keyMode: 'file', limits: {} } } };
    const cur = await ratchet.measure(root, all);
    assert.deepEqual(Object.keys(cur.files), ['a.js', 'lib.js', 'lib/b.js']);
    const star = { version: 1, scopes: { s: { files: ['*.js'], sourceType: 'commonjs', keyMode: 'file', limits: {} } } };
    assert.deepEqual(Object.keys((await ratchet.measure(root, star)).files), ['a.js', 'lib.js']);
    // wzorzec `*` obejmuje każdą nazwę w korzeniu: lista z dodatkowym, nieistniejącym wpisem zepsułaby odczyt
    const anyName = { version: 1, scopes: { s: { files: ['*'], sourceType: 'commonjs', keyMode: 'file', limits: {} } } };
    assert.deepEqual(Object.keys((await ratchet.measure(root, anyName)).files), ['a.js', 'lib.js']);
  });

  test('`**/` nie pasuje do nazwy z innym przedrostkiem w tym samym katalogu', () => {
    assert.ok(!ratchet.globToRegExp('src/**/x.gs').test('src/ax.gs'));
    assert.ok(ratchet.globToRegExp('src/**/x.gs').test('src/a/x.gs'));
  });

  test('cleanGitEnv usuwa tylko zmienne GIT_*', () => {
    const saved = { dir: process.env.GIT_DIR, keep: process.env.DEBT_TEST_KEEP };
    process.env.GIT_DIR = 'x';
    process.env.DEBT_TEST_KEEP = 'y';
    try {
      const env = ratchet.cleanGitEnv();
      assert.equal('GIT_DIR' in env, false);
      assert.equal(env.DEBT_TEST_KEEP, 'y');
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
      if (saved.keep === undefined) delete process.env.DEBT_TEST_KEEP; else process.env.DEBT_TEST_KEEP = saved.keep;
    }
  });

  test('git nie przekazuje wejścia ani nie przechwytuje stderr w błędzie (stderr wyciszony)', () => {
    const root = makeRoot({ 'a.txt': 'x' });
    git(root, 'init', '-q', '-b', 'main');
    assert.throws(() => ratchet.git(root, ['show', 'main:nie-ma-takiego']), e => e.stderr === null || e.stderr === undefined);
    assert.equal(typeof ratchet.git(root, ['rev-parse', '--git-dir']), 'string');
  });

  test('podsumowanie liczy pliki ponad limit', async () => {
    const root = makeRoot({
      '.quality/debt-limits.json': JSON.stringify(limitsOf({ fileLines: 2 }, {})),
      'src/A.gs': lines('function a() {', '  return 1;', '}')
    });
    const io = collect();
    const code = await ratchet.main([`--root=${root}`], io);
    assert.equal(code, 1);
    assert.equal(io.out.at(-1), '[debt-ratchet] CZERWONE: 1 aktywnych miar, 0 funkcji i 1 plików ponad limit, 1 naruszeń');
  });

  test('wyjątek spoza UsageError w programie: komunikat na stderr i kod 2', () => {
    const root = makeRoot({ '.quality/debt-limits.json/placeholder': 'katalog zamiast pliku' });
    const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /EISDIR/);
  });
});

describe('#240: uwagi recenzji Codexa', () => {
  test('komentarze `eslint` w kodzie nie obniżają limitów: funkcja z wyłączoną regułą nadal jest mierzona', async () => {
    const root = makeRoot({
      'src/D.gs': lines('/* eslint complexity: off */', '/* eslint-disable max-lines-per-function */', 'function f(a) {', '  // eslint-disable-next-line complexity', '  if (a) { return 1; }', '  return 2;', '}')
    });
    const cur = await ratchet.measure(root, limitsOf({ complexity: 1, lines: 1 }));
    assert.deepEqual(cur.functions['src::f'].metrics, { complexity: 2, lines: 4 });
  });

  describe('względem stanu bazowego', () => {
    const LIM = limitsOf({ complexity: 10 }, {});
    const bl = (functions = {}, files = {}, tool) => ({ version: 1, tool, functions, files });
    const base = (over = {}) => Object.assign({ ref: 'main', baselineMissing: false, baseline: bl(), limits: LIM, hashes: {}, fileHashes: {} }, over);
    const cur = (fns, allKeys) => ({
      functions: Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, { hash: v.hash, file: 'src/A.gs', line: 1, metrics: v.metrics }])),
      allKeys: allKeys || Object.fromEntries(Object.entries(fns).map(([k, v]) => [k, v.hash])),
      files: {},
      conflicts: []
    });
    const redCodes = r => r.findings.filter(f => f.level === 'red').map(f => f.code);
    const v1 = { eslint: '1', espree: '1' };
    const v2 = { eslint: '2', espree: '2' };

    test('migracja narzędzi: wzrost miary przy zmienionym w PR ciele funkcji nie jest migracją, nawet ze starym skrótem we wpisie', () => {
      const old = base({ baseline: bl({ 'src::f': { hash: 'H', complexity: 20 } }, {}, v1), hashes: { 'src::f': 'H' } });
      const grown = bl({ 'src::f': { hash: 'H', complexity: 25, uzasadnienie: 'nowy sposób liczenia' } }, {}, v2);
      const unchanged = cur({ 'src::f': { hash: 'H', metrics: { complexity: 25 } } });
      const rewritten = cur({ 'src::f': { hash: 'NOWY', metrics: { complexity: 25 } } });
      assert.deepEqual(redCodes(ratchet.compare({ current: unchanged, baseline: grown, limits: LIM, base: old })), []);
      assert.deepEqual(redCodes(ratchet.compare({ current: rewritten, baseline: grown, limits: LIM, base: old })), ['growth-vs-base']);
      const otherBase = base({ baseline: old.baseline, hashes: { 'src::f': 'INNY' } });
      assert.deepEqual(redCodes(ratchet.compare({ current: unchanged, baseline: grown, limits: LIM, base: otherBase })), ['growth-vs-base']);
    });

    test('przeniesienie wpisu dotyczy jednej funkcji: kopie usuniętej funkcji pod nowymi nazwami nie powielają długu', () => {
      const old = base({ baseline: bl({ 'src::stara': { hash: 'H', complexity: 20, lines: 90 } }) });
      const baseline = bl({ 'src::kopia1': { hash: 'H', complexity: 20, lines: 90 }, 'src::kopia2': { hash: 'H', complexity: 20, lines: 90 } });
      const current = cur({ 'src::kopia1': { hash: 'H', metrics: { complexity: 20, lines: 90 } }, 'src::kopia2': { hash: 'H', metrics: { complexity: 20, lines: 90 } } });
      const limits = limitsOf({ complexity: 10, lines: 50 }, {});
      const result = ratchet.compare({ current, baseline, limits, base: old });
      const newEntries = result.findings.filter(f => f.code === 'new-entry');
      assert.deepEqual(newEntries.map(f => f.key), ['src::kopia2', 'src::kopia2']);
      const single = ratchet.compare({ current: cur({ 'src::kopia1': { hash: 'H', metrics: { complexity: 20, lines: 90 } } }), baseline: bl({ 'src::kopia1': { hash: 'H', complexity: 20, lines: 90 } }), limits, base: old });
      assert.deepEqual(redCodes(single), []);
    });

    test('dwa różne stare wpisy o tym samym skrócie przenoszą się po jednym', () => {
      const old = base({ baseline: bl({ 'src::a': { hash: 'H', complexity: 20 }, 'src::b': { hash: 'H', complexity: 20 } }) });
      const baseline = bl({ 'src::c': { hash: 'H', complexity: 20 }, 'src::d': { hash: 'H', complexity: 20 } });
      const current = cur({ 'src::c': { hash: 'H', metrics: { complexity: 20 } }, 'src::d': { hash: 'H', metrics: { complexity: 20 } } });
      assert.deepEqual(redCodes(ratchet.compare({ current, baseline, limits: LIM, base: old })), []);
    });
  });
});
