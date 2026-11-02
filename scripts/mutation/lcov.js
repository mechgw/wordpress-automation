'use strict';

// Minimalny parser LCOV (pilot mutacji): trafienia linii i gałęzi per plik.
const fs = require('node:fs');
const path = require('node:path');

/** @returns {Record<string, {lines: Map<number, number>, branches: Map<string, number>}>} klucz: nazwa pliku, np. WordPress.gs */
function parseLcov(file) {
  const out = {};
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      const name = path.win32.basename(raw.slice(3));
      cur = out[name] = { lines: new Map(), branches: new Map() };
    } else if (cur && raw.startsWith('DA:')) {
      const [line, hits] = raw.slice(3).split(',').map(Number);
      cur.lines.set(line, (cur.lines.get(line) || 0) + hits);
    } else if (cur && raw.startsWith('BRDA:')) {
      const [line, block, branch, hits] = raw.slice(5).split(',');
      const key = `${line}:${block}:${branch}`;
      cur.branches.set(key, (cur.branches.get(key) || 0) + (hits === '-' ? 0 : Number(hits)));
    } else if (raw === 'end_of_record') {
      cur = null;
    }
  }
  return out;
}

/** Zakresy kolejnych linii, np. [1,2,3,7] -> "1-3 7". */
function ranges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return out.join(' ');
}

module.exports = { parseLcov, ranges };
