'use strict';

// Mapa "plik testów -> pliki src/*.gs, które naprawdę wykonuje" z pokrycia LCOV każdego pliku testów
// osobno, względem wzorca load-only. Wynik: reports/mutation/coverage-map.json
//   { baseline: { "<Plik.gs>": [linie wykonane już przy samym ładowaniu] }, tests: { "<test>": { "<Plik.gs>": [linie spoza wzorca] } }, bySource: { "<Plik.gs>": ["<test>", ...] } }
// Użycie: node scripts/mutation/coverage-map.js   (ok. 3-4 min, sekwencyjnie)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseLcov } = require('./lcov.js');
const { safeEnv } = require('./safe-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'reports', 'mutation');
const TMP = path.join(OUT, 'tmp-lcov');
const SKIP = new Set(['repo-identity.test.js', 'source-control-chars.test.js']);
fs.mkdirSync(TMP, { recursive: true });

function coverageOf(testFile, tag) {
  const lcov = path.join(TMP, `${tag}.info`);
  const r = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage', '--test-coverage-include=src/*.gs',
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, testFile
  ], { cwd: ROOT, encoding: 'utf8', env: safeEnv(process.env) });
  if (!fs.existsSync(lcov)) throw new Error(`Brak LCOV dla ${testFile}: ${r.stderr}`);
  return { exit: r.status, cov: parseLcov(lcov) };
}

const baseline = coverageOf(path.join('scripts', 'mutation', 'load-only.test.js'), 'baseline').cov;
const tests = {};
const bySource = {};
const files = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js') && !SKIP.has(f)).sort();
for (const f of files) {
  const { exit, cov } = coverageOf(path.join('test', f), f.replace(/\W/g, '_'));
  tests[f] = { exit, sources: {} };
  for (const [src, data] of Object.entries(cov)) {
    const base = baseline[src] ? baseline[src].lines : new Map();
    const extra = [...data.lines].filter(([line, hits]) => hits > 0 && !(base.get(line) > 0)).map(([line]) => line);
    if (extra.length) {
      tests[f].sources[src] = extra.sort((a, b) => a - b);
      (bySource[src] = bySource[src] || []).push(f);
    }
  }
  process.stderr.write(`${f}: ${Object.keys(tests[f].sources).length} plików src\n`);
}
const baselineLines = Object.fromEntries(Object.entries(baseline).map(([src, d]) => [src, [...d.lines].filter(([, h]) => h > 0).map(([l]) => l).sort((a, b) => a - b)]));
fs.writeFileSync(path.join(OUT, 'coverage-map.json'), JSON.stringify({ baseline: baselineLines, tests, bySource }, null, 1));
console.log(`Zapisano reports/mutation/coverage-map.json (${files.length} plików testów)`);
