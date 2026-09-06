#!/usr/bin/env node
'use strict';

/**
 * Kontrola wypełnienia szablonu PR (#49).
 *
 * Sprawdza treść PR-a (nie kod) pod kątem trzech sekcji szablonu z
 * .github/PULL_REQUEST_TEMPLATE.md, w wersji angielskiej i polskiej nagłówków:
 *   1. matryca testów: co najmniej jeden wiersz z treścią poza nagłówkiem
 *      i separatorem tabeli;
 *   2. macierz dowodów: każda pozycja listy `- [ ]` / `- [x]` jest odhaczona,
 *      oznaczona „N/A (powód)”, albo jawnie odłożona (tekst „po wdrożeniu” /
 *      „after deploy” / odwołanie do issue `#123`), oraz linia uzasadnienia
 *      deficytu pokrycia nie jest pusta;
 *   3. linki: `Fixes:` albo `Refs:` z numerem issue, bez placeholdera `<nr>`.
 *
 * Moduł eksportuje czystą funkcję `evaluate(body)` (testowaną jednostkowo)
 * i tryb CLI, który czyta treść z pliku albo ze zmiennej PR_BODY:
 *   node scripts/quality/pr-template.js [--body-file <plik>]
 * Kod wyjścia 1 przy brakach. Okres obserwacji: check nie jest wymagany
 * przez ochronę gałęzi, dopóki nie pokaże, że łapie realne braki.
 */

const fs = require('fs');

const SECTION_ALIASES = {
  testMatrix: ['test matrix', 'macierz testów', 'matryca testów'],
  evidence: ['evidence matrix', 'macierz dowodów'],
  links: ['links', 'linki']
};

const DEFERRAL_PATTERNS = [/po wdrożeniu/i, /after deploy/i, /follow-?up/i, /#\d+/];

function normalizeHeading(line) {
  return line.replace(/^#{2,3}\s*/, '').trim().toLowerCase();
}

/** Dzieli treść na sekcje po nagłówkach `##`/`###`; komentarze HTML szablonu są usuwane. */
function splitSections(body) {
  const text = String(body || '').replace(/<!--[\s\S]*?-->/g, '');
  const sections = {};
  let current = '_preamble';
  sections[current] = [];
  text.split(/\r?\n/).forEach(line => {
    if (/^#{2,3}\s+/.test(line)) {
      current = normalizeHeading(line);
      sections[current] = sections[current] || [];
      return;
    }
    sections[current].push(line);
  });
  return sections;
}

function findSection(sections, key) {
  const names = SECTION_ALIASES[key];
  const heading = Object.keys(sections).find(h => names.some(n => h === n || h.startsWith(n)));
  return heading ? sections[heading] : null;
}

function checkTestMatrix(lines, problems) {
  if (!lines) {
    problems.push('Brak sekcji „Test matrix” / „Macierz testów”.');
    return;
  }
  const tableRows = lines.filter(l => /^\s*\|/.test(l));
  const dataRows = tableRows.filter(l => !/^\s*\|\s*-{2,}/.test(l) && !/^\s*\|\s*ID\s*\|/i.test(l));
  // Kompletny wiersz = ID + scenariusz + krytyczność + warstwa + test (5 komórek z treścią);
  // pojedyncza wypełniona komórka w wierszu z szablonu nie wystarcza.
  const complete = dataRows.filter(l => {
    const cells = l.split('|').slice(1, -1).map(c => c.trim());
    return cells.length >= TEST_MATRIX_COLUMNS && cells.slice(0, TEST_MATRIX_COLUMNS).every(Boolean);
  });
  if (!complete.length) {
    problems.push('Matryca testów nie ma żadnego kompletnego wiersza (ID, scenariusz, krytyczność, warstwa, test – wszystkie komórki wypełnione).');
  }
}

/** Kategorie macierzy dowodów z szablonu; każda musi wystąpić (etykieta EN albo PL). */
const EVIDENCE_CATEGORIES = [
  { name: 'Unit (VM)', match: /\bunit\b/i },
  { name: 'Coverage / Pokrycie', match: /coverage|pokrycie/i },
  { name: 'Sheet manual test / Test ręczny w arkuszu', match: /\bsheet\b|arkusz/i },
  { name: 'Runtime', match: /runtime/i },
  { name: 'Security / Bezpieczeństwo', match: /security|bezpiecze/i }
];
const TEST_MATRIX_COLUMNS = 5;

function checkEvidence(lines, problems) {
  if (!lines) {
    problems.push('Brak sekcji „Evidence matrix” / „Macierz dowodów”.');
    return;
  }
  const items = lines.filter(l => /^\s*[-*]\s*\[[ xX]\]/.test(l));
  if (!items.length) {
    problems.push('Macierz dowodów nie ma żadnej pozycji listy `- [ ]` / `- [x]`.');
  }
  // Każda kategoria z szablonu musi być obecna: usunięcie wiersza nie może zwolnić z dowodu.
  const labels = items.map(item => {
    const bold = item.match(/\*\*([^*]+)\*\*/);
    return bold ? bold[1] : item;
  });
  EVIDENCE_CATEGORIES.forEach(cat => {
    if (!labels.some(label => cat.match.test(label))) {
      problems.push('Macierz dowodów nie ma pozycji „' + cat.name + '” (usunięta z szablonu?).');
    }
  });
  items.forEach(item => {
    const checked = /^\s*[-*]\s*\[[xX]\]/.test(item);
    if (checked) return;
    const bold = item.match(/\*\*([^*]+)\*\*/);
    const label = (bold ? bold[1] : item.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '')).trim();
    const na = /N\/A\s*\(([^)]*)\)/i.exec(item);
    if (na) {
      if (!na[1].trim()) problems.push('Pozycja „' + label + '”: N/A bez powodu w nawiasie.');
      return;
    }
    if (DEFERRAL_PATTERNS.some(p => p.test(item))) return;
    problems.push('Pozycja „' + label + '” nie jest odhaczona, nie ma „N/A (powód)” ani jawnego odłożenia (po wdrożeniu / follow-up / #issue).');
  });

  const deficit = lines.find(l => /(coverage deficit justification|uzasadnienie deficytu pokrycia)/i.test(l));
  if (!deficit) {
    problems.push('Brak linii „Coverage deficit justification” / „Uzasadnienie deficytu pokrycia”.');
  } else {
    const value = deficit.replace(/^.*?(justification|pokrycia)\s*:?\**\s*/i, '').trim();
    if (!value) problems.push('Uzasadnienie deficytu pokrycia jest puste (wpisz „none” / „brak” albo listę wyjątków z powodem).');
  }
}

function checkLinks(lines, problems) {
  if (!lines) {
    problems.push('Brak sekcji „Links” / „Linki”.');
    return;
  }
  const text = lines.join('\n');
  if (/<nr>/.test(text)) {
    problems.push('Sekcja linków zawiera placeholder `<nr>` z szablonu.');
    return;
  }
  if (!/\b(Fixes|Closes|Resolves|Refs|Ref)\b\s*:?\s*#\d+/i.test(text)) {
    problems.push('Sekcja linków nie ma `Fixes: #<numer>` ani `Refs: #<numer>`.');
  }
}

/**
 * @param {string} body treść PR-a
 * @returns {{ ok: boolean, problems: string[] }}
 */
function evaluate(body) {
  const problems = [];
  if (!String(body || '').trim()) {
    return { ok: false, problems: ['Treść PR-a jest pusta; wypełnij szablon.'] };
  }
  const sections = splitSections(body);
  checkTestMatrix(findSection(sections, 'testMatrix'), problems);
  checkEvidence(findSection(sections, 'evidence'), problems);
  checkLinks(findSection(sections, 'links'), problems);
  return { ok: problems.length === 0, problems };
}

function parseArgs(argv) {
  const args = { bodyFile: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--body-file') {
      if (!argv[i + 1]) throw new Error('--body-file wymaga ścieżki');
      args.bodyFile = argv[++i];
    } else {
      throw new Error('Nieznany argument: ' + argv[i]);
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const body = args.bodyFile ? fs.readFileSync(args.bodyFile, 'utf8') : (process.env.PR_BODY || '');
  const result = evaluate(body);
  if (result.ok) {
    console.log('[pr-template] OK: matryca testów, macierz dowodów i linki są wypełnione.');
    return 0;
  }
  console.log('[pr-template] Braki w szablonie PR:');
  result.problems.forEach(p => console.log('  - ' + p));
  console.log('[pr-template] Szablon: .github/PULL_REQUEST_TEMPLATE.md; standard: docs/quality/testing-standard.md');
  return 1;
}

module.exports = { evaluate, splitSections };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error('[pr-template] ' + e.message);
    process.exitCode = 2;
  }
}
