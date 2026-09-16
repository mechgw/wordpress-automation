'use strict';

/**
 * Pliki tekstowe repozytorium nie zawierają surowych znaków sterujących.
 *
 * Znak sterujący wpisany wprost w kod jest niewidoczny w edytorze i w recenzji,
 * a narzędzia traktują przez niego cały plik inaczej niż tekst. `src/BusinessProfile.gs`
 * miał bajt NUL jako separator klucza w `join('…')`: `grep` zamiast pasujących wierszy
 * wypisywał tylko „Binary file matches”, więc wyszukiwanie po tym pliku po cichu nie
 * pokazywało wyników — wyszło to 2026-09-16, gdy zmyliło przeszukiwanie kodu.
 *
 * Wartość sterującą zapisuje się sekwencją ucieczki (`'\u0000'`, `'\x1f'`). W czasie
 * wykonania łańcuch jest identyczny, a w źródle widać, co w nim jest.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/** Te same katalogi i rozszerzenia co w test/repo-identity.test.js. */
const SCAN_DIRS = ['src', 'test', 'wordpress', 'scripts', 'docs', '.github'];
const SCAN_FILES = ['README.md', 'CLAUDE.md'];
const EXTENSIONS = ['.gs', '.js', '.php', '.md', '.json', '.yml', '.yaml'];

/**
 * Zakazane: znaki sterujące C0 poza tabulatorem, LF i CR, znak DEL oraz sterujące C1.
 * Wszystkie są niewidoczne w edytorze; tabulator i końce wierszy są zwykłym tekstem.
 *
 * Funkcja, nie wyrażenie regularne: `no-control-regex` słusznie zakazuje znaków
 * sterujących w regexach, a ten test istnieje po to, żeby je wykrywać.
 */
function isForbiddenCode(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function scanFiles() {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      if (EXTENSIONS.indexOf(path.extname(entry.name)) >= 0) out.push(full);
    });
  };
  SCAN_DIRS.forEach(dir => walk(path.join(ROOT, dir)));
  SCAN_FILES.forEach(name => {
    const full = path.join(ROOT, name);
    if (fs.existsSync(full)) out.push(full);
  });
  return out;
}

/** `plik:wiersz U+XXXX` dla każdego znaku zakazanego w tekście. */
function findControlChars(text, name) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (let k = 0; k < line.length; k++) {
      const code = line.charCodeAt(k);
      if (isForbiddenCode(code)) {
        hits.push(name + ':' + (i + 1) + ' U+' + code.toString(16).toUpperCase().padStart(4, '0'));
      }
    }
  });
  return hits;
}

describe('surowe znaki sterujące w plikach repozytorium', () => {
  test('żaden plik z kodem, testami ani dokumentacją ich nie zawiera', () => {
    const files = scanFiles();
    const hits = [];
    files.forEach(full => {
      const name = path.relative(ROOT, full).split(path.sep).join('/');
      findControlChars(fs.readFileSync(full, 'utf8'), name).forEach(hit => hits.push(hit));
    });

    assert.deepEqual(hits, [], 'zapisz te znaki sekwencją ucieczki, np. \\u0000 albo \\x1f:\n' + hits.join('\n'));
  });

  test('skan naprawdę obejmuje pliki, w których znaki się pojawiły', () => {
    const names = scanFiles().map(full => path.relative(ROOT, full).split(path.sep).join('/'));

    assert.ok(names.length > 50, 'warunek wstępny: skan widzi repozytorium, nie pusty katalog');
    assert.ok(names.indexOf('src/BusinessProfile.gs') >= 0);
    assert.ok(names.indexOf('test/sitemap-urls.test.js') >= 0);
  });

  test('detektor łapie NUL, znaki C0 i C1, a przepuszcza tabulator, końce wierszy i polskie litery', () => {
    const c = String.fromCharCode;
    assert.deepEqual(findControlChars('a' + c(0) + 'b', 'x'), ['x:1 U+0000']);
    assert.deepEqual(findControlChars('ok\n' + c(0x1f) + c(0x8b) + c(0x08), 'x'), ['x:2 U+001F', 'x:2 U+008B', 'x:2 U+0008']);
    assert.deepEqual(findControlChars(c(0x7f), 'x'), ['x:1 U+007F']);
    assert.deepEqual(findControlChars('\tzażółć gęślą jaźń\r\n„cudzysłów” — myślnik', 'x'), []);
  });
});
