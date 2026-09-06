'use strict';

/**
 * #116: testy jednostkowe bramki pokrycia.
 *
 * Od tej bramki zależy każdy merge, a sama nie miała ani jednego testu.
 * Wyszło to przy #105, gdy diff dostał wykrywanie zmiany nazwy pliku
 * i poprawność trzeba było sprawdzać ręcznie.
 *
 * Testy działają na tymczasowym repozytorium, jak `apps-script-compare`,
 * żeby nie zależeć od stanu tego repo.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gate = require('../scripts/quality/coverage-gate.js');
const roots = [];

after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Repozytorium z jednym plikiem źródłowym w src/ i jednym poza nim. */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
  roots.push(root);
  const g = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.pl']);
  g(['config', 'user.name', 'test']);
  g(['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'Kod.gs'), 'function a() {}\nfunction b() {}\n');
  fs.writeFileSync(path.join(root, 'notatki.md'), 'nie jest źródłem\n');
  // Plik w katalogu głównym: układ sprzed #105, potrzebny do testu przeniesienia.
  fs.writeFileSync(path.join(root, 'Stary.gs'), 'function stary() {}\nfunction drugi() {}\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  return { root, g };
}

const staged = root => gate.changedLines('staged', root);
const lines = (map, file) => [...(map.get(file) || new Set())].sort((x, y) => x - y);

describe('#116: zmienione linie', () => {
  test('nowa linia w istniejącym pliku jest zmieniona, reszta nie', () => {
    const { root, g } = repo();
    fs.appendFileSync(path.join(root, 'src', 'Kod.gs'), 'function c() {}\n');
    g(['add', '-A']);
    const map = staged(root);
    assert.deepEqual(lines(map, 'src/Kod.gs'), [3], 'tylko dopisana linia');
  });

  test('przeniesienie z katalogu głównego do src/ nie jest nowym kodem', () => {
    // Dokładnie przypadek z #105. Pathspec musi obejmować katalog główny, bo
    // inaczej git nie widzi strony źródłowej i nie rozpozna zmiany nazwy,
    // przez co cały plik policzyłby się jako napisany od zera.
    const { root, g } = repo();
    g(['mv', 'Stary.gs', 'src/Stary.gs']);
    const map = staged(root);
    assert.deepEqual([...map.keys()].filter(k => lines(map, k).length), [], 'żadnych zmienionych linii');
  });

  test('przeniesienie do src/ z prawdziwą zmianą zgłasza tylko zmodyfikowane linie', () => {
    const { root, g } = repo();
    g(['mv', 'Stary.gs', 'src/Stary.gs']);
    fs.appendFileSync(path.join(root, 'src', 'Stary.gs'), 'function trzeci() {}\n');
    g(['add', '-A']);
    const map = staged(root);
    assert.deepEqual(lines(map, 'src/Stary.gs'), [3], 'nowa linia tak, przeniesione nie');
  });

  test('plik pozostawiony w katalogu głównym nie trafia do wyniku', () => {
    // Pathspec jest szerszy niż src/, więc wynik musi go odfiltrować sam.
    const { root, g } = repo();
    fs.appendFileSync(path.join(root, 'Stary.gs'), 'function trzeci() {}\n');
    fs.appendFileSync(path.join(root, 'src', 'Kod.gs'), 'function c() {}\n');
    g(['add', '-A']);
    const map = staged(root);
    assert.deepEqual([...map.keys()], ['src/Kod.gs']);
  });

  test('plik, który nie jest źródłem, jest pomijany', () => {
    const { root, g } = repo();
    fs.appendFileSync(path.join(root, 'notatki.md'), 'kolejna linia\n');
    g(['add', '-A']);
    assert.equal(staged(root).size, 0);
  });

  test('usunięcie pliku nie generuje zmienionych linii', () => {
    const { root, g } = repo();
    g(['rm', '-q', 'src/Kod.gs']);
    const map = staged(root);
    assert.deepEqual([...map.keys()], []);
  });

  test('nowy plik liczy się w całości', () => {
    const { root, g } = repo();
    fs.writeFileSync(path.join(root, 'src', 'Nowy.gs'), 'function x() {}\nfunction y() {}\n');
    g(['add', '-A']);
    assert.deepEqual(lines(staged(root), 'src/Nowy.gs'), [1, 2]);
  });

  test('tryb none nie pyta gita i zwraca pustą mapę', () => {
    assert.equal(gate.changedLines('none', '/katalog/ktory/nie/istnieje').size, 0);
  });

  test('tryb base:<ref> porównuje z podanym punktem, nie ze stage', () => {
    const { root, g } = repo();
    fs.appendFileSync(path.join(root, 'src', 'Kod.gs'), 'function c() {}\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'druga zmiana']);
    const map = gate.changedLines('base:HEAD~1', root);
    assert.deepEqual(lines(map, 'src/Kod.gs'), [3], 'zmiana już zacommitowana, a nadal widoczna');
    assert.equal(staged(root).size, 0, 'a w stage nie ma nic');
  });
});

describe('#116: progi z polityki', () => {
  const policy = {
    defaultThreshold: 80,
    rules: [
      { pattern: 'src/Version.gs', threshold: 100, rationale: 'placeholder' },
      { pattern: 'src/*.gs', threshold: 95, rationale: 'reszta źródeł' }
    ]
  };

  test('wygrywa pierwsza pasująca reguła, nie najbardziej szczegółowa', () => {
    assert.equal(gate.thresholdFor('src/Version.gs', policy).threshold, 100);
    assert.equal(gate.thresholdFor('src/Kod.gs', policy).threshold, 95);
  });

  test('plik bez reguły dostaje próg domyślny i mówi o tym wprost', () => {
    const out = gate.thresholdFor('inne/Plik.gs', policy);
    assert.equal(out.threshold, 80);
    assert.equal(out.rationale, 'defaultThreshold');
  });

  test('gwiazdka nie przekracza separatora, podwójna przekracza', () => {
    assert.equal(gate.globToRegExp('src/*.gs').test('src/Kod.gs'), true);
    assert.equal(gate.globToRegExp('src/*.gs').test('src/glebiej/Kod.gs'), false);
    assert.equal(gate.globToRegExp('src/**.gs').test('src/glebiej/Kod.gs'), true);
  });

  test('kropka we wzorcu jest znakiem, nie dowolnym znakiem', () => {
    assert.equal(gate.globToRegExp('src/Kod.gs').test('src/KodXgs'), false);
  });
});

describe('#116: pozostałe pomocnicze', () => {
  test('parseLcov zwraca linie niepokryte i łączną liczbę instrukcji', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-lcov-'));
    roots.push(root);
    const file = path.join(root, 'lcov.info');
    fs.writeFileSync(file, [
      'SF:' + path.join(root, 'src', 'Kod.gs'),
      'DA:1,1', 'DA:2,0', 'DA:3,5', 'end_of_record', ''
    ].join('\n'));
    const out = gate.parseLcov(file);
    const entry = [...out.values()][0];
    assert.equal(entry.found, 3, 'trzy instrukcje w raporcie');
    assert.equal(entry.hit, 2, 'dwie wykonane');
    const uncovered = [...entry.lines.entries()].filter(([, hits]) => hits === 0).map(([line]) => line);
    assert.deepEqual(uncovered, [2]);
  });

  test('ranges skleja kolejne numery w zakresy, a pojedyncze zostawia', () => {
    assert.equal(gate.ranges([1, 2, 3, 7, 9, 10]), '1-3, 7, 9-10');
    assert.equal(gate.ranges([5]), '5');
  });

  test('ignoredLines czyta wyjątki per plik', () => {
    const registry = { entries: [{ path: 'src/Kod.gs', lines: [10, 11], reason: 'teksty alertów w menu' }] };
    const out = gate.ignoredLines(registry);
    assert.deepEqual([...out.get('src/Kod.gs')].sort((a, b) => a - b), [10, 11]);
    assert.equal(out.has('src/Inny.gs'), false);
    assert.equal(gate.ignoredLines({}).size, 0, 'pusty rejestr to brak wyjątków, nie błąd');
  });
});
