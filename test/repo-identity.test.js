'use strict';

/**
 * #103: tożsamość instalacji nie należy do publicznego repozytorium.
 *
 * CLAUDE.md zakazuje trzymania w kodzie nazw firm, domen i identyfikatorów
 * witryny — tożsamość ma żyć w Script Properties. Zakaz istniał, ale nic go nie
 * pilnowało, więc łamał się po cichu: prefiks `cc_` w polach REST, slugi
 * konkretnej instalacji, a przy pracy nad #165 także **selektory CSS i tekst CTA
 * przepisane wprost z sondy produkcyjnej** do fixture'ów testowych.
 *
 * **Czego ten test NIE potrafi.** Nie sprawdza samej nazwy firmy, bo nie da się
 * jednocześnie usunąć jej z repozytorium i testować literałem, że jej nie ma —
 * wzorzec byłby tym, czego zakazuje. Sprawdzalny jest **prefiks**: dwuliterowy
 * skrót nazwy, którym oznaczono pola i klasy tej instalacji. To proxy, nie dowód;
 * poświadczeń pilnuje osobno `secret-scan` (gitleaks).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/** Katalogi z kodem i dokumentacją; bez zależności i bez historii gita. */
const SCAN_DIRS = ['src', 'test', 'wordpress', 'scripts', 'docs', '.github'];
const SCAN_FILES = ['README.md', 'CLAUDE.md'];
const EXTENSIONS = ['.gs', '.js', '.php', '.md', '.json', '.yml', '.yaml'];

/** Prefiks instalacji: `cc_pole`, `cc-klasa`. Granica słowa, żeby nie łapać „soccer-ball”. */
const IDENTITY_PREFIX = /(?:^|[^A-Za-z0-9])cc[_-][a-z]/i;

/**
 * Ten plik jest wykluczony ze skanu, bo **musi** nazwać to, czego pilnuje.
 * Wyjątek jest dokładnie jeden i wymieniony z nazwy, żeby nie dało się schować
 * niczego „przy okazji” w innym pliku.
 */
const SELF = 'test/repo-identity.test.js';

/**
 * Pola REST, które most WordPressa wystawia jeszcze pod starą nazwą.
 *
 * **Pusta i taka ma zostać.** Ostatni krok #103 usunął historyczne nazwy pól po tym,
 * jak instalacja potwierdziła wystawianie nazw docelowych. Lista zostaje w kodzie,
 * bo następna zmiana nazwy pola będzie potrzebowała tego samego okresu przejściowego —
 * a wtedy ma tu trafić razem z planem usunięcia, nie zamiast niego.
 *
 * Test niżej wymaga, żeby lista zgadzała się **co do znaku** ze stanem kodu: wpis bez
 * pokrycia w źródłach wywraca go tak samo jak brakujący.
 */
const LEGACY_REST_FIELDS = [];

function scanFiles() {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); return; }
      if (EXTENSIONS.indexOf(path.extname(entry.name)) < 0) return;
      out.push(full);
    });
  };
  SCAN_DIRS.forEach(dir => walk(path.join(ROOT, dir)));
  SCAN_FILES.forEach(file => {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) out.push(full);
  });
  return out;
}

const relativeOf = file => path.relative(ROOT, file).split(path.sep).join('/');

/** Wystąpienia prefiksu z podziałem na znane historyczne i całą resztę. */
function findings() {
  const legacy = [];
  const fresh = [];
  scanFiles().forEach(file => {
    const relative = relativeOf(file);
    if (relative === SELF) return;
    fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)).forEach((line, i) => {
      if (!IDENTITY_PREFIX.test(line)) return;
      const known = LEGACY_REST_FIELDS.filter(name => line.indexOf(name) >= 0);
      const entry = { where: relative + ':' + (i + 1), line: line.trim() };
      if (known.length) legacy.push(Object.assign({ names: known }, entry));
      else fresh.push(entry);
    });
  });
  return { legacy: legacy, fresh: fresh };
}

describe('#103: prefiks instalacji nie wraca do repozytorium', () => {
  const found = findings();

  test('skan obejmuje realny zbiór plików — inaczej test milczy o wszystkim', () => {
    const files = scanFiles();
    assert.ok(files.length >= 60, 'przeskanowano tylko ' + files.length + ' plików');
    assert.ok(files.some(f => f.endsWith(path.join('src', 'WordPress.gs'))), 'źródła Apps Script w zasięgu');
    assert.ok(files.some(f => f.indexOf('wordpress') >= 0 && f.endsWith('.php')), 'mosty PHP w zasięgu');
  });

  test('poza polami REST z okresu przejściowego prefiks nie występuje', () => {
    assert.deepEqual(
      found.fresh.map(item => item.where + '  →  ' + item.line.slice(0, 90)),
      [],
      'prefiks instalacji w publicznym repozytorium. Tożsamość witryny należy do Script ' +
      'Properties, a w testach używa się wartości neutralnych (example.pl, „hero”). Jeśli to ' +
      'kolejne pole REST okresu przejściowego, dopisz je do LEGACY_REST_FIELDS razem z planem usunięcia.'
    );
  });

  test('lista pól przejściowych zgadza się co do znaku ze stanem kodu', () => {
    // Wyjątek, którego nikt nie sprawdza, degeneruje się w furtkę: nazwa usunięta
    // z kodu ma zniknąć z listy, a nie zostać na niej „na wszelki wypadek”.
    const used = [];
    found.legacy.forEach(item => item.names.forEach(name => {
      if (used.indexOf(name) < 0) used.push(name);
    }));
    assert.deepEqual(
      used.slice().sort(), LEGACY_REST_FIELDS.slice().sort(),
      'LEGACY_REST_FIELDS ma wymieniać dokładnie te nazwy, które są jeszcze w kodzie'
    );
  });

  test('w źródłach i mostach stara nazwa nigdy nie jest jedyną', () => {
    // Na poziomie PLIKU, nie linii: fixture testujący odwrót musi podać samą starą
    // nazwę, więc warunek liniowy byłby fałszywy. Znaczenie ma to, że kod produkcyjny
    // i mosty nigdy nie znają wyłącznie starej nazwy — inaczej okres przejściowy
    // przestaje być przejściowy.
    const osierocone = [];
    scanFiles()
      .filter(file => /\/(src|wordpress)\//.test(relativeOf(file)))
      .forEach(file => {
        const code = fs.readFileSync(file, 'utf8');
        LEGACY_REST_FIELDS.forEach(legacy => {
          if (code.indexOf(legacy) < 0) return;
          const nowa = legacy.replace(/^cc_/, 'wpa_');
          if (code.indexOf(nowa) < 0) osierocone.push(relativeOf(file) + ': ' + legacy + ' bez ' + nowa);
        });
      });
    assert.deepEqual(
      osierocone, [],
      'te pliki znają wyłącznie starą nazwę pola — okres przejściowy wymaga obu naraz'
    );
  });
});
