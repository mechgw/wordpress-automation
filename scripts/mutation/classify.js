'use strict';

// Klasyfikacja wyników Strykera (pilot mutacji). Runner `command` uznaje KAŻDY niezerowy kod
// wyjścia za zabicie mutanta, także awarię preludium, loadera czy VM. Ten skrypt czyta surowy
// raport JSON i dzieli zabite na:
//   killed-assert  w wyjściu testów jest nieudana asercja (AssertionError) i brak błędu programu,
//   killed-other   inny niezerowy wynik bez AssertionError (np. TypeError rzucony przez zmutowany kod,
//                  ReferenceError z preludium, awaria loadera): NIE liczy się do zabitych. Trzeba obejrzeć
//                  ślad stosu: błąd z src/ to prawdziwa zmiana zachowania, błąd z preludium to awaria pomiaru.
// Użycie: node scripts/mutation/classify.js [reports/mutation/mutation.json] [--list]
// Kod wyjścia 3: pomiar nieważny (brak zabitych z asercją, czyli nic nie zostało zmierzone).
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ||
  path.join('reports', 'mutation', 'mutation.json');
const list = process.argv.includes('--list');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));

const PROGRAM_ERROR = /\b(ReferenceError|SyntaxError|RangeError)\b|Cannot find module|stryker.*is not defined/;
const counts = {};
const rows = [];
for (const [name, entry] of Object.entries(report.files)) {
  for (const m of entry.mutants) {
    let status = m.status;
    if (status === 'Killed') {
      const out = String(m.statusReason || '');
      const failing = [...new Set([...out.matchAll(/^\s*✖ (.+?) \([\d.]+ms\)/gm)].map(x => x[1]))];
      const hasAssertion = /AssertionError/.test(out);
      status = hasAssertion && !PROGRAM_ERROR.test(out) ? 'killed-assert' : 'killed-other';
      m.failing = failing;
    }
    counts[status] = (counts[status] || 0) + 1;
    rows.push({ file: name, line: m.location.start.line, id: m.id, mutator: m.mutatorName, status, failing: m.failing || [] });
  }
}

console.log(JSON.stringify(counts));
if (list) for (const r of rows) console.log(`${r.status}\t${r.file}:${r.line}\tid=${r.id}\t${r.mutator}\t${r.failing.join(' ; ').slice(0, 100)}`);
const assertKilled = counts['killed-assert'] || 0;
const total = rows.length;
console.log(`wynik wg killed-assert: ${assertKilled}/${total} = ${(100 * assertKilled / total).toFixed(1)} %`);
if (!(assertKilled > 0)) {
  console.error('POMIAR NIEWAŻNY: brak zabitych z asercją (killed-assert).');
  process.exit(3);
}
if (counts['killed-other']) console.error(`Uwaga: ${counts['killed-other']} zabitych bez asercji (killed-other) poza wynikiem; sprawdź ślad stosu.`);
