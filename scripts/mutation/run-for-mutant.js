'use strict';

// Komenda testowa StrykerJS z doborem testów per mutant (pilot mutacji). Stryker z runnerem `command`
// nie zna pokrycia per test, więc wybór robimy sami: plik wyboru (MUTATION_SELECTION) mapuje id
// mutanta na listę plików testów, które wykonują jego linie (z coverage-map.js).
//   - brak id (suchy przebieg): testy pliku, który mutujemy (selection.covering),
//   - 'STATIC': mutant wykonywany już przy ładowaniu projektu (np. stała); dostaje testy pliku
//     (selection.covering), bo pełny zestaw po kolei trwa ponad 2 min na mutant. Stała używana tylko
//     w innym pliku może więc umknąć: ocenia to validate-selection.js próbką na pełnym zestawie,
//   - 'ALL': wszystkie testy (używa validate-selection.js),
//   - pusta lista: żaden test nie wykonuje tej linii. Nic nie uruchamiamy, mutant wychodzi jako
//     `Survived` i jest oznaczany `NoCoverage` w raporcie (report.js).
// Pliki testów idą po kolei, od najmniejszego, i przerywamy na pierwszej porażce (kod != 0 to zabicie).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const selection = JSON.parse(fs.readFileSync(process.env.MUTATION_SELECTION, 'utf8'));
const id = process.env.__STRYKER_ACTIVE_MUTANT__;
const entry = id === undefined ? selection.covering : selection.mutants[id];
if (entry === undefined) {
  console.error(`Brak mutanta ${id} w pliku wyboru: pomiar nieważny.`);
  process.exit(70);
}
const files = (entry === 'ALL' ? selection.all : entry === 'STATIC' ? selection.covering : entry)
  .map(f => path.join('test', f))
  .sort((a, b) => fs.statSync(path.join(ROOT, a)).size - fs.statSync(path.join(ROOT, b)).size);

for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--require', path.join(__dirname, 'vm-preload.js'), '--test', file],
    { cwd: ROOT, stdio: 'inherit', env: safeEnv(process.env) }
  );
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);
}
process.exit(0);
