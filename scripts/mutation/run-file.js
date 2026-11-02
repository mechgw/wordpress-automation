'use strict';

// Pełny pomiar mutacyjny jednego pliku src/*.gs (pilot mutacji).
//   1. kopia cienia pliku,
//   2. przebieg indeksujący: komenda przechodzi bez mutanta i pada z mutantem, więc Stryker szybko
//      wypisuje wszystkie mutanty z id i lokalizacją (id są deterministyczne dla tej samej treści),
//   3. plik wyboru: dla każdego mutanta testy, które wykonują jego linie (coverage-map.json),
//   4. właściwy przebieg ze wszystkimi mutatorami, bez wykluczeń.
// Użycie: node scripts/mutation/run-file.js WordPress.gs [--concurrency=4] [--limit=N]
// Wyniki: reports/mutation/result-<Plik>.json (raport Strykera), selection-<Plik>.json
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'reports', 'mutation');
const name = process.argv[2];
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
if (!/^[A-Za-z0-9]+\.gs$/.test(name || '')) {
  console.error('Podaj nazwę pliku z src/, np. WordPress.gs');
  process.exit(2);
}
const concurrency = arg('concurrency') || '4';
const limit = Number(arg('limit') || 0);
const stem = name.replace(/\.gs$/, '');
const map = JSON.parse(fs.readFileSync(path.join(OUT, 'coverage-map.json'), 'utf8'));
const stryker = ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run'];

/** Stryker nie ma opcji CLI dla jsonReporter, więc każdy przebieg dostaje własny plik konfiguracji. */
function run(tag, overrides, env) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.config.json'), 'utf8'));
  const cfg = path.join(OUT, `cfg-${tag}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ ...base, ...overrides }));
  return spawnSync(process.execPath, [...stryker, cfg], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
}

spawnSync(process.execPath, [path.join(__dirname, 'prepare-shadow.js'), name], { cwd: ROOT, stdio: 'ignore' });
const shadow = `.stryker-shadow/${stem}.js`;

// 2. indeks
const idxReport = path.join('reports', 'mutation', `index-${stem}.json`);
const idxCmd = 'node -e "process.exit(process.env.__STRYKER_ACTIVE_MUTANT__!==undefined?1:0)"';
const t0 = Date.now();
run(`index-${stem}`, {
  mutate: [shadow], commandRunner: { command: idxCmd }, reporters: ['json'],
  jsonReporter: { fileName: idxReport }, concurrency: 4
});
const index = JSON.parse(fs.readFileSync(path.join(ROOT, idxReport), 'utf8'));
const mutants = Object.values(index.files)[0].mutants;
console.error(`indeks ${name}: ${mutants.length} mutantów w ${Math.round((Date.now() - t0) / 1000)} s`);

// 3. wybór testów
const baseline = new Set((map.baseline[name] || []));
const covering = {};
for (const [t, v] of Object.entries(map.tests)) if (v.sources[name]) covering[t] = new Set(v.sources[name]);
const allTests = Object.keys(map.tests).sort();
const sel = { source: name, all: allTests, covering: Object.keys(covering).sort(), mutants: {} };
for (const m of mutants) {
  const a = m.location.start.line;
  const b = m.location.end.line;
  let hitsBaseline = false;
  const tests = new Set();
  for (let line = a; line <= b; line++) {
    if (baseline.has(line)) hitsBaseline = true;
    for (const [t, set] of Object.entries(covering)) if (set.has(line)) tests.add(t);
  }
  sel.mutants[m.id] = hitsBaseline ? 'STATIC' : [...tests].sort();
}
const selFile = path.join(OUT, `selection-${stem}.json`);
fs.writeFileSync(selFile, JSON.stringify(sel));
const kinds = { static: 0, none: 0, some: 0 };
for (const v of Object.values(sel.mutants)) kinds[v === 'STATIC' ? 'static' : v.length === 0 ? 'none' : 'some']++;
console.error(`wybór testów: statyczne=${kinds.static} bez testu=${kinds.none} z doborem=${kinds.some}`);

// 4. właściwy przebieg
const resFile = path.join('reports', 'mutation', `result-${stem}.json`);
const mutateArg = limit > 0 ? `${shadow}:1-${limit}` : shadow;
const t1 = Date.now();
const res = run(`run-${stem}`, {
  mutate: [mutateArg], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
  reporters: ['json', 'clear-text'], jsonReporter: { fileName: resFile }, concurrency: Number(concurrency), timeoutMS: 90000
}, { MUTATION_SELECTION: selFile });
fs.writeFileSync(path.join(OUT, `log-${stem}.txt`), (res.stdout || '') + (res.stderr || ''));
console.error(`przebieg ${name}: ${Math.round((Date.now() - t1) / 1000)} s, exit ${res.status}`);
fs.writeFileSync(path.join(OUT, `time-${stem}.json`), JSON.stringify({ file: name, mutants: mutants.length, indexSeconds: Math.round((t1 - t0) / 1000), runSeconds: Math.round((Date.now() - t1) / 1000), concurrency: Number(concurrency) }));
process.exit(res.status === null ? 1 : res.status);
