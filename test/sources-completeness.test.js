'use strict';

/**
 * #102: każdy plik `*.gs` musi być w SOURCES w test/helpers/gas.js.
 *
 * W Apps Script wszystkie pliki dzielą jedną przestrzeń nazw, więc plik
 * ładowany w testach osobno nie podlega tej samej weryfikacji co reszta:
 * kolizja nazw albo odwołanie do symbolu, który zniknął, wychodzą dopiero
 * na produkcji. Wcześniej GlobalFooterMigration.gs był ładowany ręcznie
 * w czterech plikach testowych i przez to omijał wspólny kontekst.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HELPERS = path.join(__dirname, 'helpers', 'gas.js');

function sourcesList() {
  const code = fs.readFileSync(HELPERS, 'utf8');
  const line = /const SOURCES = \[([^\]]+)\]/.exec(code);
  assert.ok(line, 'nie znaleziono tablicy SOURCES w helpers/gas.js');
  return line[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('#102: kompletność SOURCES', () => {
  const sources = sourcesList();
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs'));

  test('każdy plik *.gs z repozytorium jest w SOURCES', () => {
    for (const file of files) {
      assert.ok(
        sources.includes(file),
        `Plik ${file} nie jest w SOURCES w test/helpers/gas.js. Dopisz go tam, ` +
        'inaczej nie będzie ładowany do wspólnego kontekstu razem z resztą projektu.'
      );
    }
  });

  test('SOURCES nie wymienia pliku, którego nie ma', () => {
    for (const source of sources) {
      assert.ok(files.includes(source), `SOURCES wymienia nieistniejący plik ${source}.`);
    }
  });

  test('żaden test nie ładuje pliku *.gs poza wspólnym kontekstem', () => {
    const offenders = [];
    for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'))) {
      const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // Interesuje nas wyłącznie ładowanie źródeł projektu; snippet przeglądarkowy
      // celowo działa we własnym kontekście i nie jest plikiem *.gs.
      if (/runInContext\([A-Z_]*(CODE|SOURCE)[A-Z_]*, gas\b/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], 'te testy ładują źródło do kontekstu ręcznie zamiast przez SOURCES');
  });

  test('polityka pokrycia zna każdy plik *.gs', () => {
    const policy = JSON.parse(fs.readFileSync(path.join(ROOT, '.quality', 'coverage-policy.json'), 'utf8'));
    const patterns = policy.rules.map(r => r.pattern);
    for (const file of files) {
      assert.ok(patterns.includes(file), `Brak reguły progu pokrycia dla ${file} w .quality/coverage-policy.json.`);
    }
  });
});
