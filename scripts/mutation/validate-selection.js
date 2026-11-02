'use strict';

// Sprawdzian doboru testów (pilot mutacji): próbka mutantów, które wyszły jako ocalałe albo bez
// pokrycia przy wybranych testach, jest uruchamiana jeszcze raz z CAŁYM zestawem testów.
// Jeśli któryś zginie, dobór testów z coverage-map.js ukrywał zabicia.
// Użycie: node scripts/mutation/validate-selection.js WordPress.gs [--survived=50] [--nocov=30]
//         node scripts/mutation/validate-selection.js WordPress.gs --ids=12,34,56   (konkretne mutanty)
// Testy czytające src/*.gs jako TEKST (scheduled-jobs, *-completeness itd.) widzą w kopii zinstrumentowanej
// inny tekst i padają bez względu na mutanta; wykluczamy je przez --exclude=a.test.js,b.test.js.
// Suchy przebieg używa całej listy, więc taki test wychodzi od razu (Stryker przerywa).
// Limit czasu mutanta: 10 min, bo pełny zestaw po kolei trwa ponad 2 min.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'reports', 'mutation');
const name = process.argv[2];
const arg = (k, d) => Number((process.argv.find(a => a.startsWith(`--${k}=`)) || `=${d}`).split('=')[1]);
const stem = name.replace(/\.gs$/, '');
const result = JSON.parse(fs.readFileSync(path.join(OUT, `result-${stem}.json`), 'utf8'));
const sel = JSON.parse(fs.readFileSync(path.join(OUT, `selection-${stem}.json`), 'utf8'));
const mutants = Object.values(result.files)[0].mutants;

function every(list, n) {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}
const noTests = m => Array.isArray(sel.mutants[m.id]) && sel.mutants[m.id].length === 0;
const survivors = every(mutants.filter(m => m.status === 'Survived' && !noTests(m)), arg('survived', 50));
const noCov = every(mutants.filter(m => m.status === 'Survived' && noTests(m)), arg('nocov', 30));
const idsArg = (process.argv.find(a => a.startsWith('--ids=')) || '').slice(6);
const sample = idsArg ? mutants.filter(m => idsArg.split(',').includes(m.id)) : [...survivors, ...noCov];

// reszta mutantów dostaje pustą listę (kończy się od razu), próbka: wszystkie testy
const exclude = (process.argv.find(a => a.startsWith('--exclude=')) || '').slice(10).split(',').filter(Boolean);
const all = sel.all.filter(t => !exclude.includes(t));
const val = { ...sel, all, covering: all, mutants: Object.fromEntries(mutants.map(m => [m.id, [] ])) };
for (const m of sample) val.mutants[m.id] = 'ALL';
const valFile = path.join(OUT, `selection-val-${stem}.json`);
fs.writeFileSync(valFile, JSON.stringify(val));

const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'stryker.config.json'), 'utf8'));
const cfg = path.join(OUT, `cfg-val-${stem}.json`);
const valReport = path.join('reports', 'mutation', `val-${stem}.json`);
fs.writeFileSync(cfg, JSON.stringify({
  ...base, mutate: [`.stryker-shadow/${stem}.js`], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
  reporters: ['json'], jsonReporter: { fileName: valReport }, concurrency: 4, timeoutMS: 600000
}));
fs.rmSync(path.join(ROOT, valReport), { force: true });
spawnSync(process.execPath, [path.join(__dirname, 'prepare-shadow.js'), name], { cwd: ROOT, stdio: 'ignore' });
const run = spawnSync(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', cfg], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, MUTATION_SELECTION: valFile }
});
if (!fs.existsSync(path.join(ROOT, valReport))) {
  console.error((run.stdout || '').split(/\r?\n/).filter(l => /✖|ERROR|failed/.test(l)).slice(0, 15).join(' | '));
  process.exit(1);
}
const val2 = JSON.parse(fs.readFileSync(path.join(ROOT, valReport), 'utf8'));
const status = Object.fromEntries(Object.values(val2.files)[0].mutants.map(m => [m.id, m.status]));
const disagree = sample.filter(m => status[m.id] !== 'Survived');
const out = {
  file: name, exit: run.status, probe: sample.length, survivors: survivors.length, noCoverage: noCov.length,
  staticInSample: sample.filter(m => sel.mutants[m.id] === 'STATIC').length,
  killedByFullSuite: disagree.map(m => ({ static: sel.mutants[m.id] === 'STATIC', id: m.id, line: m.location.start.line, mutator: m.mutatorName, was: noTests(m) ? 'NoCoverage' : 'Survived', now: status[m.id] }))
};
fs.writeFileSync(path.join(OUT, `validation-${stem}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
