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
/**
 * Wejścia skanowania. `ensureSheetWithHeader_` zakłada zakładkę z nagłówkiem, ale
 * nie jest jedyną drogą: część zakładek powstaje wprost przez `insertSheet`
 * (`GA4.gs`, `Status.gs`, `SheetCatalog.gs`). Skan wyłącznie po pierwszej z nich
 * przepuszczałby te miejsca — i przepuszczał.
 */
const ROOTS = [
  { name: 'ensureSheetWithHeader_', position: 0, method: false },
  { name: 'insertSheet', position: 0, method: true }
];

/**
 * Jedyna zakładka poza katalogiem, i to z definicji: „START” jest **spisem**
 * pozostałych zakładek, więc nie wymienia sam siebie — `sheetPlan_()` obsługuje
 * ją osobną kategorią. Osobny test pilnuje, żeby ten wyjątek nie stał się wygodną
 * furtką: nazwa musi naprawdę wystąpić w źródłach.
 */
const OUTSIDE_CATALOG = ['START'];
/**
 * Deklaracje funkcji w trzech postaciach, które występują w tych źródłach:
 * `function name(…)`, `const name = function (…)` i `const name = (…) =>`.
 * Sama pierwsza postać nie wystarcza: opakowanie zapisane strzałką zostałoby
 * przypisane poprzedniej nazwanej funkcji, a skaner poszedłby za złą — wytknięte
 * w audycie #170.
 */
const DECLARATION = new RegExp([
  'function\\s+([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)|',
  '(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?(?:',
  'function\\s*\\(([^)]*)\\)|',
  '\\(([^)]*)\\)\\s*=>|',
  '([A-Za-z_$][\\w$]*)\\s*=>',
  ')'
].join(''), 'g');

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
    const name = m[1] || m[3];
    const raw = m[2] !== undefined ? m[2] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : m[6]));
    found = { name: name, params: String(raw || '').split(',').map(s => s.trim()).filter(Boolean) };
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
function callSites(name, position, method) {
  const out = [];
  sources.forEach(source => {
    const prefix = method ? '[.]' : '(?:^|[^\\w$.])';
    const re = new RegExp(prefix + name + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(source.code)) !== null) {
      // Deklaracja to nie wywołanie: `function ensureSheetWithHeader_(name, …)`.
      if (/function\\s+$/.test(source.code.slice(0, m.index + m[0].length - name.length - 1))) continue;
      const open = source.code.indexOf('(', m.index + m[0].length - 1);
      out.push({
        file: source.file,
        line: source.code.slice(0, m.index).split(String.fromCharCode(10)).length,
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
  const entryPoints = ROOTS.slice();
  const seen = new Set(ROOTS.map(root => root.name + '#' + root.position));
  const resolved = [];
  const unresolved = [];

  for (let i = 0; i < entryPoints.length; i++) {
    const entry = entryPoints[i];
    callSites(entry.name, entry.position, entry.method).forEach(site => {
      const name = resolve(site.argument);
      if (name !== null) { resolved.push({ site: site, name: name }); return; }
      const params = (site.enclosing && site.enclosing.params) || [];
      const position = params.indexOf(site.argument);
      if (position < 0) { unresolved.push(site); return; }
      const key = site.enclosing.name + '#' + position;
      if (seen.has(key)) return;
      seen.add(key);
      entryPoints.push({ name: site.enclosing.name, position: position, method: false });
    });
  }

  test('wzorzec coś znajduje — inaczej test milczy o wszystkim', () => {
    assert.ok(resolved.length >= 15, 'rozwiązano tylko ' + resolved.length + ' nazw; wzorzec przestał pasować do źródeł');
  });

  test('każda zakładka zakładana przez skrypt — także przez opakowanie — ma wpis w katalogu', () => {
    const missing = resolved
      .filter(item => !catalog.has(item.name) && OUTSIDE_CATALOG.indexOf(item.name) < 0)
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

  test('wyjątek poza katalogiem nie jest furtką — każda nazwa naprawdę występuje w źródłach', () => {
    OUTSIDE_CATALOG.forEach(name => {
      assert.ok(
        resolved.some(item => item.name === name),
        'wyjątek „' + name + '” nie odpowiada żadnej zakładce zakładanej przez skrypt — usuń go'
      );
    });
  });

  test('zakładki zakładane wprost przez insertSheet też są sprawdzane', () => {
    const direct = resolved.filter(item => /GA4|Status|SheetCatalog/.test(item.site.file));
    assert.ok(direct.length >= 3, 'znaleziono: ' + direct.map(item => item.name).join(', '));
  });

  // Druga, niezależna reguła. Śledzenie wywołań zawsze będzie miało margines — audyt
  // pokazał kolejno: opakowania, `insertSheet` i funkcje strzałkowe. Ta reguła nie pyta,
  // JAK zakładka powstaje: w tym projekcie każda ma stałą `*_SHEET`.
  //
  // Nie patrzymy też na KSZTAŁT deklaracji — wystarczy, że nazwa gdziekolwiek występuje,
  // a wartość bierzemy z kontekstu VM, czyli tak jak widzi ją Apps Script. Kolejne wersje
  // tego testu przepuszczały najpierw `const X_SHEET = "X";` (inny cudzysłów), potem
  // `const A = [], X_SHEET = 'X';` (druga deklaracja w jednej instrukcji). Dopasowywanie
  // składni deklaracji okazało się źródłem luk, więc przestało być częścią reguły.
  const SHEET_CONSTANT = /(?:^|[^\w$.])([A-Za-z0-9_$]+_SHEET)\b/g;

  test('każda stała `*_SHEET` wskazuje zakładkę z katalogu — niezależnie od sposobu zakładania', () => {
    const byName = new Map();
    sources.forEach(source => {
      const re = new RegExp(SHEET_CONSTANT.source, 'g');
      let m;
      while ((m = re.exec(source.code)) !== null) {
        if (byName.has(m[1])) continue;
        let value = null;
        try {
          const resolved = gas.$get(m[1]);
          if (typeof resolved === 'string') value = resolved;
        } catch {
          value = null;
        }
        byName.set(m[1], { file: source.file, name: value });
      }
    });

    assert.ok(byName.size >= 20, 'znaleziono tylko ' + byName.size + ' nazw `*_SHEET`; konwencja się zmieniła');
    const unresolved = [...byName.entries()].filter(entry => entry[1].name === null);
    assert.deepEqual(
      unresolved.map(entry => entry[1].file + ': ' + entry[0]),
      [],
      'tych nazw nie da się rozwiązać do łańcucha, więc reguła ich nie sprawdza'
    );
    const missing = [...byName.entries()]
      .filter(entry => !catalog.has(entry[1].name) && OUTSIDE_CATALOG.indexOf(entry[1].name) < 0)
      .map(entry => entry[1].file + ': ' + entry[0] + ' → „' + entry[1].name + '”');
    assert.deepEqual(
      missing, [],
      'te zakładki mają stałą w źródłach, ale nie mają wpisu w sheetCatalog_(). ' +
      'Ta reguła nie zależy od tego, jak zakładka jest zakładana ani jak zadeklarowana.'
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
