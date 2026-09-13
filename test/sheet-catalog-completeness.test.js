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
 * Nazwy zakładek rzadko trafiają do `ensureSheetWithHeader_()` wprost. Częściej
 * idą przez opakowanie — `upsertPerformanceRows_(PERF_FIELD_SHEET, …)`,
 * `syncMonitoringSheet_(SEO_LIVE_SHEET, …)` — więc kontrola patrząca wyłącznie
 * na bezpośrednie wywołania przepuszczałaby dokładnie te przypadki, dla których
 * powstała. Opakowania rozpoznajemy więc same: funkcja, która przekazuje dalej
 * swój parametr w pozycji nazwy arkusza, sama staje się miejscem zakładania
 * zakładki i jej wywołania też są sprawdzane. Punkt stały, nie jedna warstwa.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadProject } = require('./helpers/gas');

const SOURCE_DIR = path.resolve(__dirname, '..', 'src');
/** Od którego wywołania zaczynamy: to ono zakłada zakładkę z nagłówkiem. */
const ROOT_FUNCTION = 'ensureSheetWithHeader_';
const DECLARATION = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;

/**
 * Kod bez komentarzy, z zachowanymi pozycjami znaków — numery linii mają dalej
 * wskazywać plik. Bez tego wzorzec łapie wzmianki z dokumentacji funkcji
 * (`ensureSheetWithHeader_()` w komentarzu) i test zgłasza nieistniejący problem.
 */
function stripComments(code) {
  const NL = String.fromCharCode(10);
  const BACKSLASH = String.fromCharCode(92);
  let out = '';
  let mode = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (mode === 'line') { out += ch === NL ? ch : ' '; if (ch === NL) mode = ''; continue; }
    if (mode === 'block') { out += ch === NL ? ch : ' '; if (ch === '*' && next === '/') { out += ' '; i++; mode = ''; } continue; }
    if (mode) {
      out += ch;
      if (ch === BACKSLASH) { out += next === NL ? NL : ' '; i++; continue; }
      if (ch === mode) mode = '';
      continue;
    }
    if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i++; continue; }
    if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i++; continue; }
    if (ch === String.fromCharCode(39) || ch === '"' || ch === '`') { mode = ch; out += ch; continue; }
    out += ch;
  }
  return out;
}

const sources = fs.readdirSync(SOURCE_DIR)
  .filter(file => file.endsWith('.gs'))
  .map(file => ({ file: file, code: stripComments(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8')) }));

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

/**
 * Argumenty wywołania, którego nawias otwierający jest na pozycji `open`.
 * Dzielimy po przecinkach najwyższego poziomu, pomijając zagnieżdżenia
 * i łańcuchy — do rozpoznania stałej albo literału w danej pozycji to wystarcza.
 */
function callArguments(code, open) {
  const args = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = open + 1; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      current += ch;
      if (ch === quote && code[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if ('([{'.indexOf(ch) >= 0) { depth++; current += ch; continue; }
    if (ch === ')' && depth === 0) { args.push(current.trim()); return args; }
    if (')]}'.indexOf(ch) >= 0) { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  return args;
}

/** Wywołania funkcji `name` we wszystkich źródłach, z argumentem z pozycji `position`. */
function callSites(name, position) {
  const out = [];
  sources.forEach(source => {
    const re = new RegExp('(^|[^\\w$.])(function\\s+)?' + name + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(source.code)) !== null) {
      if (m[2]) continue; // deklaracja, nie wywołanie
      const open = source.code.indexOf('(', m.index + m[0].length - 1);
      out.push({
        file: source.file,
        line: source.code.slice(0, m.index).split('\n').length,
        argument: (callArguments(source.code, open)[position] || '').trim(),
        enclosing: enclosingFunction(source.code, m.index)
      });
    }
  });
  return out;
}

describe('#162: kompletność katalogu arkuszy', () => {
  const gas = loadProject({ properties: {}, sheets: {}, fetch: () => ({ code: 404, text: '{}' }) });
  const catalog = new Set(gas.sheetCatalog_().map(entry => entry.name));

  /** Stała albo literał sprowadzone do nazwy zakładki; `null`, gdy to nie nazwa. */
  const resolve = argument => {
    const literal = /^'([^']*)'$/.exec(argument) || /^"([^"]*)"$/.exec(argument);
    if (literal) return literal[1];
    if (!/^[A-Za-z_$][\w$]*$/.test(argument)) return null;
    try {
      const value = gas.$get(argument);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  };

  // Punkt stały: startujemy od `ensureSheetWithHeader_`, a każda funkcja, która
  // przekazuje dalej własny parametr, dołącza do listy wejść jako opakowanie.
  const entryPoints = [{ name: ROOT_FUNCTION, position: 0 }];
  const seen = new Set([ROOT_FUNCTION + '#0']);
  const resolved = [];
  const unresolved = [];

  for (let i = 0; i < entryPoints.length; i++) {
    const entry = entryPoints[i];
    callSites(entry.name, entry.position).forEach(site => {
      const name = resolve(site.argument);
      if (name !== null) { resolved.push({ site: site, name: name }); return; }
      const params = (site.enclosing && site.enclosing.params) || [];
      const position = params.indexOf(site.argument);
      if (position < 0) { unresolved.push(site); return; }
      const key = site.enclosing.name + '#' + position;
      if (seen.has(key)) return;
      seen.add(key);
      entryPoints.push({ name: site.enclosing.name, position: position });
    });
  }

  test('wzorzec coś znajduje — inaczej test milczy o wszystkim', () => {
    assert.ok(resolved.length >= 15, 'rozwiązano tylko ' + resolved.length + ' nazw; wzorzec przestał pasować do źródeł');
  });

  test('każda zakładka zakładana przez skrypt — także przez opakowanie — ma wpis w katalogu', () => {
    const missing = resolved
      .filter(item => !catalog.has(item.name))
      .map(item => item.site.file + ':' + item.site.line + ' → „' + item.name + '”');
    assert.deepEqual(
      missing, [],
      'te zakładki tworzy skrypt, ale nie ma ich w sheetCatalog_() w src/SheetCatalog.gs. ' +
      'Bez wpisu „START” przypisze im właściciela „człowiek”, a porządkowanie arkuszy ich nie ruszy.'
    );
  });

  test('nazwa nierozwiązywalna jest parametrem przekazywanym dalej, a nie zapomnianą stałą', () => {
    assert.deepEqual(
      unresolved.map(site => site.file + ':' + site.line + ' → ' + site.argument +
        ' w ' + ((site.enclosing && site.enclosing.name) || '(poza funkcją)')),
      [],
      'tych nazw nie da się rozwiązać ani jako stałej, ani jako parametru przekazywanego dalej — ' +
      'katalog nie jest dla nich sprawdzany, a powinien.'
    );
  });

  test('opakowania naprawdę są śledzone, nie tylko wywołania bezpośrednie', () => {
    // Bez tego cała rozbudowa mogłaby cicho przestać działać, a testy wyżej
    // nadal by przechodziły — po prostu nie miałyby czego sprawdzać.
    const names = entryPoints.map(entry => entry.name);
    assert.ok(names.indexOf('upsertPerformanceRows_') >= 0, 'rozpoznane wejścia: ' + names.join(', '));
    assert.ok(names.indexOf('syncMonitoringSheet_') >= 0, 'rozpoznane wejścia: ' + names.join(', '));
    assert.ok(
      resolved.some(item => item.site.enclosing && item.site.enclosing.name === 'runCruxMeasurement_'),
      'nazwa podana opakowaniu w runCruxMeasurement_ powinna być rozwiązana'
    );
  });
});
