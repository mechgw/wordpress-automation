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
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Pliki pomijane jako binarne — WYŁĄCZNIE po rozszerzeniu.
 *
 * Nie korzystamy z wykrywania binarności przez gita (`git ls-files --eol`): git uznaje
 * plik za binarny właśnie wtedy, gdy znajdzie bajt NUL w pierwszych 8000 bajtach, więc
 * skan pominąłby dokładnie ten przypadek, dla którego istnieje.
 */
const BINARY_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip', '.gz'];

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

/**
 * Wszystkie pliki śledzone przez gita, poza binarnymi — ścieżki względne z `/`.
 *
 * Lista katalogów (pierwsza wersja, wzorem `repo-identity`) pomijała pliki w katalogu
 * głównym i ukrytych: `eslint.config.js`, `.githooks/pre-commit`, `package.json`,
 * `.quality/*.json` (uwaga Codexa z recenzji #184). Zbiór z gita nie wymaga pamiętania
 * o nowych katalogach. Separator `-z` to NUL, więc nazwy z odstępami też przechodzą.
 */
function scanFiles() {
  const listing = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return listing.split(String.fromCharCode(0))
    .filter(Boolean)
    .filter(name => BINARY_EXTENSIONS.indexOf(path.extname(name).toLowerCase()) < 0)
    .filter(name => fs.existsSync(path.join(ROOT, name)));
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
  test('żaden plik śledzony przez gita ich nie zawiera', () => {
    const hits = [];
    scanFiles().forEach(name => {
      findControlChars(fs.readFileSync(path.join(ROOT, name), 'utf8'), name).forEach(hit => hits.push(hit));
    });

    assert.deepEqual(hits, [], 'zapisz te znaki sekwencją ucieczki, np. \\u0000 albo \\x1f:\n' + hits.join('\n'));
  });

  test('skan obejmuje pliki, w których znaki się pojawiły, oraz te w katalogu głównym i ukrytych', () => {
    const names = scanFiles();

    assert.ok(names.length > 50, 'warunek wstępny: skan widzi repozytorium, nie pusty katalog');
    [
      'src/BusinessProfile.gs', 'test/sitemap-urls.test.js',
      // Pomijane przez pierwszą wersję opartą na liście katalogów:
      'eslint.config.js', 'package.json', '.githooks/pre-commit', '.quality/coverage-policy.json'
    ].forEach(name => assert.ok(names.indexOf(name) >= 0, name + ' musi być w skanie'));
  });

  test('binarne są pomijane wyłącznie po rozszerzeniu, nie po zawartości', () => {
    const names = scanFiles();
    assert.ok(names.every(name => BINARY_EXTENSIONS.indexOf(path.extname(name).toLowerCase()) < 0));
    assert.ok(names.indexOf('LICENSE') >= 0, 'plik bez rozszerzenia jest tekstem i jest skanowany');
  });

  test('detektor łapie NUL, znaki C0 i C1, a przepuszcza tabulator, końce wierszy i polskie litery', () => {
    const c = String.fromCharCode;
    assert.deepEqual(findControlChars('a' + c(0) + 'b', 'x'), ['x:1 U+0000']);
    assert.deepEqual(findControlChars('ok\n' + c(0x1f) + c(0x8b) + c(0x08), 'x'), ['x:2 U+001F', 'x:2 U+008B', 'x:2 U+0008']);
    assert.deepEqual(findControlChars(c(0x7f), 'x'), ['x:1 U+007F']);
    assert.deepEqual(findControlChars('\tzażółć gęślą jaźń\r\n„cudzysłów” — myślnik', 'x'), []);
  });
});
