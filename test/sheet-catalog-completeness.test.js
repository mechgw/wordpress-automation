'use strict';

/**
 * #162: każda zakładka tworzona przez skrypt ma wpis w `sheetCatalog_()`.
 *
 * README stawia ten kontrakt wprost: „Nowa funkcja tworząca arkusz dodaje jeden
 * wpis do katalogu, inaczej arkusz wyląduje wśród niezarządzanych”. Nic go nie
 * pilnowało i luka powtórzyła się wielokrotnie — brakowało ośmiu zakładek,
 * dwukrotnie więcej, niż wyliczała treść #162. Bez tego testu powtórzy się przy
 * następnej funkcji tworzącej zakładkę, a objawem będzie wyłącznie zdanie
 * nieprawdy w arkuszu „START”: że prowadzi ją człowiek.
 *
 * Test czyta wywołania `ensureSheetWithHeader_` ze źródeł i rozwiązuje ich
 * pierwszy argument przez wspólny kontekst VM, czyli tak, jak widzi go Apps
 * Script. Argument, którego nie da się rozwiązać, musi być parametrem funkcji,
 * w której leży — wtedy nazwa przychodzi od wywołującego i to tam jest widoczna.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('./helpers/gas');

const SOURCE_DIR = path.resolve(__dirname, '..', 'src');
const CALL = /ensureSheetWithHeader_\(\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/g;
const DECLARATION = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;

/** Funkcja, wewnątrz której wypada dana pozycja w pliku. */
function enclosingFunction(code, index) {
  const re = new RegExp(DECLARATION.source, 'g');
  let found = null;
  let m;
  while ((m = re.exec(code)) !== null && m.index < index) {
    found = { name: m[1], params: m[2].split(',').map(s => s.trim()).filter(Boolean) };
  }
  return found;
}

function callSites() {
  const out = [];
  fs.readdirSync(SOURCE_DIR).filter(f => f.endsWith('.gs')).forEach(file => {
    const code = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');
    const re = new RegExp(CALL.source, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
      const literal = m[1] !== undefined ? m[1] : m[2];
      out.push({
        file: file,
        argument: m[3],
        literal: literal,
        line: code.slice(0, m.index).split('\n').length,
        enclosing: enclosingFunction(code, m.index)
      });
    }
  });
  return out;
}

describe('#162: kompletność katalogu arkuszy', () => {
  const gas = loadProject({ properties: {}, sheets: {}, fetch: () => ({ code: 404, text: '{}' }) });
  const catalog = new Set(gas.sheetCatalog_().map(entry => entry.name));
  const sites = callSites();

  test('są jakieś wywołania do sprawdzenia — inaczej test milczy o wszystkim', () => {
    assert.ok(sites.length >= 15, 'znaleziono tylko ' + sites.length + ' wywołań; wzorzec przestał pasować do źródeł');
  });

  test('każda zakładka zakładana przez skrypt ma wpis w sheetCatalog_()', () => {
    const missing = [];
    sites.forEach(site => {
      let name = site.literal;
      if (name === undefined && site.argument) {
        // `$get` czyta stałą z tego samego kontekstu co źródła; stała najwyższego
        // poziomu nie jest własnością globala, więc nie da się jej wziąć wprost.
        try {
          const value = gas.$get(site.argument);
          if (typeof value === 'string') name = value;
        } catch {
          name = undefined;
        }
      }
      if (name === undefined) return;
      if (!catalog.has(name)) missing.push(site.file + ':' + site.line + ' → „' + name + '”');
    });
    assert.deepEqual(
      missing, [],
      'te zakładki tworzy skrypt, ale nie ma ich w sheetCatalog_() w src/SheetCatalog.gs. ' +
      'Bez wpisu „START” przypisze im właściciela „człowiek”, a porządkowanie arkuszy ich nie ruszy.'
    );
  });

  test('argument nierozwiązywalny jest parametrem swojej funkcji, a nie zapomnianą stałą', () => {
    const suspicious = [];
    sites.forEach(site => {
      if (site.literal !== undefined || !site.argument) return;
      try {
        if (typeof gas.$get(site.argument) === 'string') return;
      } catch { /* nierozwiązywalny — sprawdzamy niżej */ }
      const params = (site.enclosing && site.enclosing.params) || [];
      if (params.indexOf(site.argument) < 0) {
        suspicious.push(site.file + ':' + site.line + ' → ' + site.argument +
          ' w ' + ((site.enclosing && site.enclosing.name) || '(poza funkcją)'));
      }
    });
    assert.deepEqual(
      suspicious, [],
      'tych nazw nie da się rozwiązać ani jako stałej, ani jako parametru — katalog nie jest ' +
      'dla nich sprawdzany, a powinien. Przekaż nazwę stałą albo dopisz kontrolę w miejscu wywołania.'
    );
  });
});
