'use strict';

// Zestawienie pilota mutacji z pokryciem (pilot mutacji). Czyta reports/mutation/result-<Plik>.json
// (raport Strykera), selection-<Plik>.json (wybór testów) i coverage/lcov.info (npm run test:coverage),
// a progi z .quality/coverage-policy.json. Pisze:
//   reports/mutation/summary.json  liczby per plik
//   reports/mutation/LISTY.md      jawne listy: niepokryte linie, ocalałe, bez pokrycia, przekroczenia czasu
// Użycie: node scripts/mutation/report.js [Plik.gs ...]   (bez argumentów: wszystkie z result-*.json)
const fs = require('node:fs');
const path = require('node:path');
const { parseLcov, ranges } = require('./lcov.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'reports', 'mutation');
const lcov = parseLcov(path.join(ROOT, 'coverage', 'lcov.info'));
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, '.quality', 'coverage-policy.json'), 'utf8'));

function threshold(name) {
  const rule = policy.rules.find(r => r.pattern === `src/${name}`);
  return rule ? rule.threshold : policy.defaultThreshold;
}

/** Linie z mutantami -> "linia(liczba)" w zakresach, np. "10-12 15(3)". */
function lineList(lines) {
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  return ranges(counts.keys()) + ` [${lines.length} mutantów]`;
}

const PROGRAM_ERROR = /\b(ReferenceError|SyntaxError)\b|Cannot find module|stryker.*is not defined/;
const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(OUT).filter(f => /^result-.*\.json$/.test(f)).map(f => f.replace(/^result-|\.json$/g, '') + '.gs').sort();

const summary = {};
const md = ['# Listy: pokrycie i mutacje (pilot)', ''];
for (const name of names) {
  const stem = name.replace(/\.gs$/, '');
  const report = JSON.parse(fs.readFileSync(path.join(OUT, `result-${stem}.json`), 'utf8'));
  const sel = JSON.parse(fs.readFileSync(path.join(OUT, `selection-${stem}.json`), 'utf8'));
  const time = fs.existsSync(path.join(OUT, `time-${stem}.json`)) ? JSON.parse(fs.readFileSync(path.join(OUT, `time-${stem}.json`), 'utf8')) : {};
  const mutants = Object.values(report.files)[0].mutants;

  const cov = lcov[name];
  const lineHits = cov ? [...cov.lines] : [];
  const uncovered = lineHits.filter(([, h]) => h === 0).map(([l]) => l);
  const branchTotal = cov ? cov.branches.size : 0;
  const branchMissed = cov ? [...cov.branches.values()].filter(h => h === 0).length : 0;
  const linePct = lineHits.length ? 100 * (lineHits.length - uncovered.length) / lineHits.length : 100;
  const thr = threshold(name);

  const by = { 'killed-assert': 0, 'killed-other': 0, Survived: 0, NoCoverage: 0, Timeout: 0, Error: 0, Ignored: 0 };
  const lists = { survived: [], noCoverage: [], timeout: [], killedOther: [], error: [] };
  const uncoveredSet = new Set(uncovered);
  let mutantsOnUncovered = 0;
  let survivedOnCovered = 0;
  for (const m of mutants) {
    const line = m.location.start.line;
    const noTests = Array.isArray(sel.mutants[m.id]) && sel.mutants[m.id].length === 0;
    let status = m.status;
    if (status === 'Killed') {
      const out = String(m.statusReason || '');
      status = /AssertionError/.test(out) && !PROGRAM_ERROR.test(out) ? 'killed-assert' : 'killed-other';
    } else if (status === 'Survived' && noTests) {
      status = 'NoCoverage';
    }
    by[status] = (by[status] || 0) + 1;
    if (uncoveredSet.has(line)) mutantsOnUncovered++;
    if (status === 'Survived') { lists.survived.push(line); if (!uncoveredSet.has(line)) survivedOnCovered++; }
    if (status === 'NoCoverage') lists.noCoverage.push(line);
    if (status === 'Timeout') lists.timeout.push(line);
    if (status === 'killed-other') lists.killedOther.push(line);
    if (status === 'RuntimeError' || status === 'CompileError') lists.error.push(line);
  }
  const total = mutants.length;
  const covered = total - by.NoCoverage;
  summary[name] = {
    mutants: total, ...by, scoreAll: +(100 * by['killed-assert'] / total).toFixed(1),
    scoreCovered: covered ? +(100 * by['killed-assert'] / covered).toFixed(1) : null,
    lcov: { lines: lineHits.length, uncoveredLines: uncovered.length, linePct: +linePct.toFixed(2), threshold: thr, gate: linePct >= thr ? 'OK' : 'FAIL', branchTotal, branchMissed },
    mutantsOnUncoveredLines: mutantsOnUncovered, survivedOnCoveredLines: survivedOnCovered,
    seconds: time.runSeconds, indexSeconds: time.indexSeconds
  };
  md.push(`## ${name}`, '',
    `- Niepokryte linie (LCOV, ${uncovered.length} z ${lineHits.length}): ${uncovered.length ? ranges(uncovered) : 'brak'}`,
    `- Ocalałe na liniach pokrytych (asercja nie łapie): ${lists.survived.length ? lineList(lists.survived) : 'brak'}`,
    `- Bez pokrycia (żaden test nie wykonuje linii): ${lists.noCoverage.length ? lineList(lists.noCoverage) : 'brak'}`,
    `- Przekroczenia czasu: ${lists.timeout.length ? lineList(lists.timeout) : 'brak'}`,
    `- Zabite bez asercji (nie liczone): ${lists.killedOther.length ? lineList(lists.killedOther) : 'brak'}`,
    `- Błędy kompilacji/uruchomienia mutanta: ${lists.error.length ? lineList(lists.error) : 'brak'}`, '');
}
const rowsMd = ['| Plik | Mutantów | Zabite z asercją | Zabite bez asercji | Ocalałe | Bez pokrycia | Przekroczenia czasu | Wynik (asercja) | Linie LCOV (próg) | Niepokryte linie |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const tot = { m: 0, k: 0, ko: 0, sv: 0, nc: 0, to: 0 };
for (const [f, v] of Object.entries(summary)) {
  tot.m += v.mutants; tot.k += v['killed-assert']; tot.ko += v['killed-other']; tot.sv += v.Survived; tot.nc += v.NoCoverage; tot.to += v.Timeout;
  rowsMd.push(`| ${f} | ${v.mutants} | ${v['killed-assert']} | ${v['killed-other']} | ${v.Survived} | ${v.NoCoverage} | ${v.Timeout} | ${v.scoreAll} % | ${v.lcov.linePct} % (${v.lcov.threshold} %) | ${v.lcov.uncoveredLines} |`);
}
rowsMd.push(`| **Razem** | **${tot.m}** | **${tot.k}** | **${tot.ko}** | **${tot.sv}** | **${tot.nc}** | **${tot.to}** | **${(100 * tot.k / tot.m).toFixed(1)} %** |  |  |`);
fs.writeFileSync(path.join(OUT, 'TABELA.md'), rowsMd.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'LISTY.md'), md.join('\n'));
console.log(JSON.stringify(summary, null, 1));
