#!/usr/bin/env node
'use strict';

/**
 * Zapadka długu rozmiaru i złożoności (#240).
 *
 * Dług może tylko maleć. Silnik mierzy funkcje i pliki ESLintem (reguły rozmiaru
 * i złożoności z progami z `.quality/debt-limits.json`), porównuje wynik z bazą
 * istniejącego długu `.quality/debt-baseline.json` i jest czerwony, gdy:
 *
 *   - funkcja albo plik ponad limit nie ma wpisu w bazie,
 *   - miara rośnie względem wpisu,
 *   - wpis nie ma już funkcji (usunięta, zmieniła nazwę) albo dług został spłacony
 *     (spadek miary lokalnie tylko informuje, w CI jest czerwony: wpis trzeba obniżyć
 *     w tym samym PR),
 *   - baza z PR ma nowy wpis względem stanu bazy na `main` (dług nie wchodzi
 *     kanałem „dopisz wpis”).
 *
 * Konkretne miary dołączają osobne zgłoszenia: każda to jeden klucz w pliku limitów.
 *
 * Klucz funkcji: nazwa (w Apps Script wszystkie funkcje top-level dzielą jedną
 * przestrzeń nazw, więc przeniesienie do innego pliku nie zmienia klucza); funkcje
 * zagnieżdżone `zewnętrzna>wewnętrzna`; anonimowe `zewnętrzna>#<skrót AST ciała>`,
 * a przy identycznych kluczach `~2`, `~3` w kolejności położenia. Skrót to SHA-1
 * z AST ciała bez pozycji (espree), więc przeniesienie i zmiana komentarzy go nie
 * zmieniają, a dopisanie nowej funkcji anonimowej nie zmienia kluczy pozostałych.
 *
 * Użycie:
 *   node scripts/quality/debt-ratchet.js [check] [--mode=report|enforce]
 *                                       [--base=<ref>|none] [--ci] [--root=<katalog>]
 *   node scripts/quality/debt-ratchet.js write-baseline [--root=<katalog>]
 *
 * Kody wyjścia: 0 zielono (albo tryb raportu), 1 czerwono, 2 błąd użycia lub narzędzia.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ESLint } = require('eslint');
const espree = require('espree');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIMITS_FILE = '.quality/debt-limits.json';
const BASELINE_FILE = '.quality/debt-baseline.json';
const FORMAT_VERSION = 1;
const ECMA_VERSION = 2022;
const SOURCE_TYPES = ['script', 'commonjs', 'module'];
const KEY_MODES = ['global', 'file'];
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'coverage']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const ENTRY_NOTE_FIELDS = new Set(['hash', 'uzasadnienie']);

/** Linie kodu bez pustych i bez komentarzy (odpowiednik `ignore-whitespace` w PHPMD). */
const codeLines = n => [{ max: n, skipBlankLines: true, skipComments: true }];

/**
 * Miary: reguła ESLint, jej opcje dla progu `n` i odczyt wartości z komunikatu.
 * Format komunikatów jest przypięty wersją ESLint w locku i pilnowany testem.
 */
const METRICS = {
  complexity: { rule: 'complexity', options: n => [{ max: n }], value: /complexity of (\d+)/ },
  lines: { rule: 'max-lines-per-function', options: codeLines, value: /too many lines \((\d+)\)/ },
  statements: { rule: 'max-statements', options: n => [n], value: /too many statements \((\d+)\)/ },
  params: { rule: 'max-params', options: n => [n], value: /too many parameters \((\d+)\)/ },
  depth: { rule: 'max-depth', options: n => [n], value: /nested too deeply \((\d+)\)/ },
  fileLines: { rule: 'max-lines', options: codeLines, value: /too many lines \((\d+)\)/, perFile: true }
};

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Pliki i konfiguracja
// ---------------------------------------------------------------------------

function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matchesScope(scope, relPath) {
  return scope.files.some(pattern => globToRegExp(pattern).test(relPath));
}

function listRepoFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      } else out.push(`${rel}${entry.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${what}: niepoprawny JSON (${e.message})`);
  }
}

function readJson(file, what) {
  if (!fs.existsSync(file)) throw new UsageError(`${what}: brak pliku (${file})`);
  return parseJson(fs.readFileSync(file, 'utf8'), what);
}

/** Waliduje plik limitów; błąd konfiguracji to kod 2, nie zielony wynik. */
function validateLimits(limits) {
  if (!limits || limits.version !== FORMAT_VERSION || !isObject(limits.scopes)) {
    throw new UsageError(`${LIMITS_FILE}: oczekiwano { "version": ${FORMAT_VERSION}, "scopes": {...} }`);
  }
  for (const [id, scope] of Object.entries(limits.scopes)) {
    const at = `${LIMITS_FILE}: zakres ${id}`;
    if (!Array.isArray(scope.files) || scope.files.length === 0 || !scope.files.every(f => typeof f === 'string')) {
      throw new UsageError(`${at}: "files" musi być niepustą listą wzorców`);
    }
    if (!scope.files.every(f => /\.[A-Za-z0-9]+$/.test(f))) {
      throw new UsageError(`${at}: każdy wzorzec "files" musi kończyć się rozszerzeniem pliku (ESLint inaczej pomija plik)`);
    }
    if (!SOURCE_TYPES.includes(scope.sourceType)) throw new UsageError(`${at}: "sourceType" to ${SOURCE_TYPES.join(', ')}`);
    if (!KEY_MODES.includes(scope.keyMode)) throw new UsageError(`${at}: "keyMode" to ${KEY_MODES.join(', ')}`);
    for (const [metric, n] of Object.entries(scope.limits || {})) {
      if (!METRICS[metric]) throw new UsageError(`${at}: nieznana miara "${metric}" (znane: ${Object.keys(METRICS).join(', ')})`);
      if (!Number.isInteger(n) || n < 0) throw new UsageError(`${at}: limit miary "${metric}" musi być liczbą całkowitą >= 0`);
    }
  }
  return limits;
}

function loadLimits(root) {
  return validateLimits(readJson(path.join(root, LIMITS_FILE), 'plik limitów'));
}

const isObject = value => typeof value === 'object' && value !== null;
const normalizeSource = text => text.replace(/\r\n/g, '\n');
const sha1 = text => crypto.createHash('sha1').update(text).digest('hex');

// ---------------------------------------------------------------------------
// Funkcje: lista, klucze, skróty AST
// ---------------------------------------------------------------------------

function keyName(member) {
  if (member.computed) return null;
  if (member.key.type === 'Identifier') return member.key.name;
  return member.key.type === 'Literal' ? String(member.key.value) : null;
}

/**
 * Nazwa funkcji: własna, z deklaracji zmiennej albo metody klasy; inaczej anonimowa (null). Funkcje przypisane do
 * właściwości literału obiektu są anonimowe (klucz ze skrótu ciała), bo ta sama nazwa właściwości powtarza się
 * w wielu literałach obiektów i dawałaby konflikty kluczy.
 */
function functionName(node, parent) {
  if (node.id) return node.id.name;
  if (parent.type === 'VariableDeclarator') return parent.id.type === 'Identifier' ? parent.id.name : null;
  if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') return keyName(parent);
  return null;
}

const astReplacer = (key, value) => {
  if (key === 'range' || key === 'start' || key === 'end') return undefined; // `loc` zawiera tylko `start` i `end`
  return typeof value === 'bigint' ? value.toString() : value;
};
// Skrót obejmuje parametry i ciało: dopisanie parametru zmienia funkcję (miara `params`), więc nie jest „niezmieniona”.
const functionHash = node => sha1(JSON.stringify({ params: node.params, body: node.body }, astReplacer));

/** Wszystkie funkcje pliku z surowym kluczem (bez przedrostka zakresu i bez sufiksu powtórzeń). */
function listFunctions(source, sourceType) {
  // Shebang zamieniony na komentarz tej samej długości: pozycje zostają zgodne z ESLintem.
  const text = source.startsWith('#!') ? `//${source.slice(2)}` : source;
  const ast = espree.parse(text, { ecmaVersion: ECMA_VERSION, sourceType, loc: true, range: true });
  const out = [];
  const visit = (node, parent, chain) => {
    let next = chain;
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionName(node, parent);
      const hash = functionHash(node);
      // ESLint raportuje metody i właściwości od początku definicji (klucza), nie od nawiasu funkcji.
      const head = parent.value === node ? parent : node; // metoda, właściwość albo pole klasy
      out.push({ name, hash, range: [head.range[0], node.range[1]], line: node.loc.start.line, rawKey: chain.concat(name || `#${hash.slice(0, 8)}`).join('>') });
      if (name) next = chain.concat(name);
    }
    for (const field of Object.keys(node)) {
      const value = node[field];
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child.type === 'string') visit(child, node, next);
      }
    }
  };
  visit(ast, null, []);
  return out;
}

/**
 * Model zakresu z podanych źródeł: klucze funkcji (ze skutkiem zakresu, ewentualnie plikiem i sufiksem
 * powtórzeń) oraz skróty plików. Używany dla drzewa roboczego i dla stanu bazy na `main`.
 */
function analyseScope(scopeId, scope, sources) {
  const functions = [];
  const fileHashes = {};
  for (const { rel, source } of [...sources].sort((a, b) => a.rel.localeCompare(b.rel))) {
    fileHashes[rel] = sha1(normalizeSource(source));
    let parsed;
    try {
      parsed = listFunctions(source, scope.sourceType);
    } catch (e) {
      throw new UsageError(`${rel}: błąd składni (${e.message})`);
    }
    for (const fn of parsed) {
      functions.push(Object.assign(fn, { rel, base: `${scopeId}::${scope.keyMode === 'file' ? `${rel}::` : ''}${fn.rawKey}` }));
    }
  }
  const seen = {};
  const conflicts = [];
  for (const fn of functions) {
    seen[fn.base] = (seen[fn.base] || 0) + 1;
    fn.key = seen[fn.base] === 1 ? fn.base : `${fn.base}~${seen[fn.base]}`;
  }
  const byBase = {};
  for (const fn of functions) (byBase[fn.base] = byBase[fn.base] || []).push(fn);
  for (const [base, group] of Object.entries(byBase)) {
    if (new Set(group.map(f => f.hash)).size > 1) {
      conflicts.push(`${base}: ${group.length} funkcji o tej samej nazwie i różnych ciałach (${group.map(f => `${f.rel}:${f.line}`).join(', ')})`);
    }
  }
  const hashes = {};
  for (const fn of functions) hashes[fn.key] = fn.hash;
  return { functions, hashes, fileHashes, conflicts };
}

function lineStarts(source) {
  const starts = [0];
  const re = /\r\n|[\r\n\u2028\u2029]/g;
  let m;
  while ((m = re.exec(source)) !== null) starts.push(m.index + m[0].length);
  return starts;
}

/** Najwęższa funkcja zawierająca pozycję (wiersz i kolumna z ESLint, kolumna liczona od 1). */
function innermostFunction(functions, starts, line, column) {
  const offset = starts[line - 1] + column - 1;
  let best = null;
  // Funkcje są w kolejności przejścia wgłąb (zewnętrzna przed wewnętrzną), więc ostatnia zawierająca pozycję jest najwęższa.
  for (const fn of functions) {
    if (fn.range[0] <= offset && offset < fn.range[1]) best = fn;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pomiar
// ---------------------------------------------------------------------------

async function lintScope(root, scope, files) {
  const rules = {};
  for (const [metric, n] of Object.entries(scope.limits)) rules[METRICS[metric].rule] = ['error', ...METRICS[metric].options(n)];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    ignore: false,
    allowInlineConfig: false, // komentarze `eslint-disable` i `/* eslint reguła: off */` w kodzie nie obniżają limitów
    overrideConfig: [{ files: scope.files, languageOptions: { ecmaVersion: ECMA_VERSION, sourceType: scope.sourceType }, rules }]
  });
  return eslint.lintFiles(files.map(f => path.join(root, f)));
}

/**
 * Stan kodu: `functions` (tylko funkcje ponad limit: skrót i miary), `allKeys` (wszystkie funkcje: klucz → skrót),
 * `files` (skrót pliku i miary plików ponad limit), `conflicts`.
 */
async function measure(root, limits) {
  const current = { functions: {}, allKeys: {}, files: {}, conflicts: [] };
  const allFiles = listRepoFiles(root);
  for (const [scopeId, scope] of Object.entries(limits.scopes)) {
    const rels = allFiles.filter(rel => matchesScope(scope, rel));
    const sources = rels.map(rel => ({ rel, source: fs.readFileSync(path.join(root, rel), 'utf8') }));
    const model = analyseScope(scopeId, scope, sources);
    Object.assign(current.allKeys, model.hashes);
    current.conflicts.push(...model.conflicts);
    for (const rel of rels) current.files[rel] = { scope: scopeId, hash: model.fileHashes[rel], metrics: {} };
    if (Object.keys(scope.limits || {}).length === 0 || rels.length === 0) continue;

    const byRule = Object.fromEntries(Object.keys(scope.limits).map(metric => [METRICS[metric].rule, metric]));
    const bySource = Object.fromEntries(sources.map(s => [s.rel, s]));
    for (const result of await lintScope(root, scope, rels)) {
      const rel = path.relative(root, result.filePath).split(path.sep).join('/');
      const fns = model.functions.filter(fn => fn.rel === rel);
      const starts = lineStarts(bySource[rel].source);
      for (const message of result.messages) {
        const metric = byRule[message.ruleId];
        if (message.fatal || (!metric && message.ruleId === null)) {
          throw new UsageError(`${rel}: ${message.message}`);
        }
        if (!metric) continue;
        const parsed = METRICS[metric].value.exec(message.message);
        if (!parsed) throw new UsageError(`${rel}: nieznany format komunikatu ESLint dla miary ${metric}: ${message.message}`);
        const value = Number(parsed[1]);
        if (METRICS[metric].perFile) {
          current.files[rel].metrics[metric] = value;
          continue;
        }
        const fn = innermostFunction(fns, starts, message.line, message.column);
        if (!fn) throw new UsageError(`${rel}:${message.line}: nie znaleziono funkcji dla miary ${metric}`);
        const entry = current.functions[fn.key] || (current.functions[fn.key] = { hash: fn.hash, file: rel, line: fn.line, metrics: {} });
        entry.metrics[metric] = Math.max(entry.metrics[metric] || 0, value);
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Baza i stan bazowy (main)
// ---------------------------------------------------------------------------

const metricsOf = entry => Object.keys(entry).filter(k => !ENTRY_NOTE_FIELDS.has(k));
const scopeOfKey = key => key.split('::')[0];

function toolVersions() {
  return { eslint: ESLint.version, espree: espree.version };
}

function buildBaseline(current) {
  const baseline = { version: FORMAT_VERSION, tool: toolVersions(), functions: {}, files: {} };
  for (const key of Object.keys(current.functions).sort()) {
    baseline.functions[key] = Object.assign({ hash: current.functions[key].hash }, current.functions[key].metrics);
  }
  for (const rel of Object.keys(current.files).sort()) {
    if (Object.keys(current.files[rel].metrics).length > 0) baseline.files[rel] = Object.assign({}, current.files[rel].metrics);
  }
  return baseline;
}

function validateBaseline(baseline) {
  if (!baseline || baseline.version !== FORMAT_VERSION || !isObject(baseline.functions) || !isObject(baseline.files)) {
    throw new UsageError(`${BASELINE_FILE}: oczekiwano { "version": ${FORMAT_VERSION}, "functions": {...}, "files": {...} }`);
  }
  for (const [key, entry] of Object.entries(baseline.functions)) {
    if (typeof entry.hash !== 'string') throw new UsageError(`${BASELINE_FILE}: wpis ${key} bez skrótu "hash"`);
    for (const m of metricsOf(entry)) {
      if (!METRICS[m] || METRICS[m].perFile || !Number.isInteger(entry[m])) throw new UsageError(`${BASELINE_FILE}: wpis ${key}: niepoprawna miara "${m}"`);
    }
  }
  for (const [rel, entry] of Object.entries(baseline.files)) {
    for (const m of metricsOf(entry)) {
      if (!METRICS[m] || !METRICS[m].perFile || !Number.isInteger(entry[m])) throw new UsageError(`${BASELINE_FILE}: wpis pliku ${rel}: niepoprawna miara "${m}"`);
    }
  }
  return baseline;
}

function loadBaseline(root) {
  const file = path.join(root, BASELINE_FILE);
  return fs.existsSync(file) ? validateBaseline(readJson(file, 'baza długu')) : buildBaseline({ functions: {}, files: {} });
}

function cleanGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: cleanGitEnv(), maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Stan `ref` (zwykle pierwszy rodzic): baza, limity, skróty funkcji i plików. Brak refu to błąd użycia. */
function loadBase(root, ref, limits) {
  try {
    git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  } catch {
    throw new UsageError(`--base: nie znaleziono ${ref} (w CI potrzebna pełna historia: fetch-depth: 0)`);
  }
  const show = file => {
    try {
      return git(root, ['show', `${ref}:${file}`]);
    } catch {
      return null;
    }
  };
  const baselineText = show(BASELINE_FILE);
  const limitsText = show(LIMITS_FILE);
  const base = {
    ref,
    baselineMissing: baselineText === null,
    baseline: baselineText === null ? null : validateBaseline(parseJson(baselineText, `baza długu na ${ref}`)),
    limits: limitsText === null ? { scopes: {} } : parseJson(limitsText, `plik limitów na ${ref}`),
    hashes: {},
    fileHashes: {}
  };
  const tracked = git(root, ['ls-tree', '-r', '--name-only', ref]).split('\n');
  for (const [scopeId, scope] of Object.entries(limits.scopes)) {
    const sources = tracked.filter(rel => matchesScope(scope, rel)).map(rel => ({ rel, source: show(rel) }));
    const model = analyseScope(scopeId, scope, sources);
    Object.assign(base.hashes, model.hashes);
    Object.assign(base.fileHashes, model.fileHashes);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Porównanie
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object} args.current  wynik `measure`
 * @param {object} args.baseline baza z drzewa roboczego (PR)
 * @param {object} args.limits   limity z drzewa roboczego
 * @param {object} [args.base]   wynik `loadBase` (stan bazowy), bez niego brak kontroli „nowych wpisów”
 * @param {boolean} [args.ci]    w CI spadek miary i spłacony dług są czerwone
 * @returns {{findings: Array<{level: string, code: string, key: string, message: string}>}}
 */
function compare({ current, baseline, limits, base = null, ci = false }) {
  const findings = [];
  const add = (level, code, key, message) => findings.push({ level, code, key, message });
  const red = (code, key, message) => add('red', code, key, message);
  const info = (code, key, message) => add('info', code, key, message);
  const lower = ci ? red : info;
  const limitOf = (scopeId, metric) => limits.scopes[scopeId].limits[metric];

  for (const text of current.conflicts) info('key-conflict', text.split(': ')[0], `konflikt kluczy (rozróżniono sufiksem ~n): ${text}`);
  if (baseline.tool && JSON.stringify(baseline.tool) !== JSON.stringify(toolVersions())) {
    info('tool-changed', '-', `baza zapisana narzędziami ${JSON.stringify(baseline.tool)}, bieżące ${JSON.stringify(toolVersions())}: przelicz bazę (migracja)`);
  }

  // 1. funkcje ponad limit
  for (const [key, cur] of Object.entries(current.functions)) {
    const entry = baseline.functions[key];
    for (const [metric, value] of Object.entries(cur.metrics)) {
      const where = `${cur.file}:${cur.line}`;
      const limit = limitOf(scopeOfKey(key), metric);
      if (!entry) red('over-limit-no-entry', key, `${metric}=${value} ponad limit ${limit} (${where}), brak wpisu w bazie`);
      else if (entry[metric] === undefined) red('metric-without-entry', key, `${metric}=${value} ponad limit ${limit} (${where}), wpis nie ma tej miary`);
      else if (value > entry[metric]) red('growth', key, `${metric} rośnie: ${entry[metric]} -> ${value} (${where})`);
      else if (value < entry[metric]) lower('shrink', key, `${metric} spadło: ${entry[metric]} -> ${value} (${where}), obniż wpis`);
    }
  }
  // 2. wpisy funkcji
  for (const [key, entry] of Object.entries(baseline.functions)) {
    if (!(key in current.allKeys)) {
      const moved = Object.entries(current.allKeys).find(([k, hash]) => hash === entry.hash && !(k in baseline.functions));
      if (moved) red('entry-renamed', key, `funkcja ma teraz klucz ${moved[0]} (ten sam skrót ciała): przenieś wpis`);
      else red('entry-without-function', key, 'wpis bez funkcji (usunięta albo zmieniona): usuń wpis');
      continue;
    }
    const cur = current.functions[key];
    for (const metric of metricsOf(entry)) {
      if (!cur || cur.metrics[metric] === undefined) lower('repaid', key, `${metric} poniżej limitu: usuń miarę z wpisu`);
    }
  }
  // 3. pliki
  for (const [rel, cur] of Object.entries(current.files)) {
    const entry = baseline.files[rel];
    for (const [metric, value] of Object.entries(cur.metrics)) {
      const limit = limitOf(cur.scope, metric);
      if (!entry) red('file-over-limit-no-entry', rel, `${metric}=${value} ponad limit ${limit}, brak wpisu w bazie`);
      else if (entry[metric] === undefined) red('file-metric-without-entry', rel, `${metric}=${value} ponad limit ${limit}, wpis nie ma tej miary`);
      else if (value > entry[metric]) red('file-growth', rel, `${metric} rośnie: ${entry[metric]} -> ${value}`);
      else if (value < entry[metric]) lower('file-shrink', rel, `${metric} spadło: ${entry[metric]} -> ${value}, obniż wpis`);
    }
  }
  for (const [rel, entry] of Object.entries(baseline.files)) {
    if (!(rel in current.files)) {
      red('file-entry-without-file', rel, 'wpis bez pliku (usunięty albo przeniesiony): usuń wpis');
      continue;
    }
    for (const metric of metricsOf(entry)) {
      if (current.files[rel].metrics[metric] === undefined) lower('file-repaid', rel, `${metric} poniżej limitu: usuń miarę z wpisu`);
    }
  }
  // 4. nowe wpisy względem stanu bazowego
  if (!base) {
    info('no-base', '-', 'brak porównania ze stanem bazowym (--base): nie sprawdzono nowych wpisów');
  } else if (base.baselineMissing) {
    info('import', '-', `na ${base.ref} nie ma bazy: import długu, nowe wpisy dozwolone`);
  } else {
    compareWithBase({ baseline, limits, base, current, red });
  }
  return { findings };
}

function introduced(limits, base, scopeId, metric) {
  const now = limits.scopes[scopeId] && limits.scopes[scopeId].limits[metric];
  const before = base.limits.scopes && base.limits.scopes[scopeId] && base.limits.scopes[scopeId].limits
    ? base.limits.scopes[scopeId].limits[metric] : undefined;
  return now !== undefined && (before === undefined || now < before);
}

/**
 * Dług nie wchodzi przez dopisanie wpisu. Nowa para (klucz, miara) jest dozwolona tylko dla miary wprowadzonej lub
 * zaostrzonej w tym PR i tylko dla funkcji (pliku) niezmienionej względem `main` (ten sam skrót), albo jako
 * przeniesienie istniejącego wpisu pod nowy klucz funkcji o tym samym skrócie w kodzie. Wzrost wpisu względem `main` jest czerwony; wyjątek: migracja po
 * zmianie wersji narzędzia, z uzasadnieniem, dla funkcji niezmienionej (ten sam skrót we wpisie, na `main` i w kodzie).
 * Wpis stanu bazowego przenosi się najwyżej raz: kopie tej samej funkcji pod nowymi nazwami dłużej nie powielają długu.
 */
function compareWithBase({ baseline, limits, base, current, red }) {
  const toolChanged = JSON.stringify(baseline.tool || null) !== JSON.stringify(base.baseline.tool || null);
  const oldFunctions = base.baseline.functions;
  const oldFiles = base.baseline.files;
  const claimed = new Set();

  for (const [key, entry] of Object.entries(baseline.functions)) {
    const old = oldFunctions[key];
    for (const metric of metricsOf(entry)) {
      if (old && old[metric] !== undefined) {
        const migration = toolChanged && Boolean(entry.uzasadnienie) && base.hashes[key] === entry.hash && current.allKeys[key] === entry.hash;
        if (entry[metric] > old[metric] && !migration) red('growth-vs-base', key, `${metric} wpisu rośnie względem ${base.ref}: ${old[metric]} -> ${entry[metric]}`);
        continue;
      }
      const unchanged = introduced(limits, base, scopeOfKey(key), metric) && base.hashes[key] === entry.hash && current.allKeys[key] === entry.hash;
      const source = unchanged ? null : Object.entries(oldFunctions).find(([k, e]) => !claimed.has(`${k}|${metric}`) && !(k in baseline.functions) && e.hash === entry.hash && e[metric] >= entry[metric] && current.allKeys[key] === entry.hash);
      if (source) claimed.add(`${source[0]}|${metric}`);
      if (!unchanged && !source) red('new-entry', key, `nowy wpis ${metric}=${entry[metric]} względem ${base.ref}: dług nie wchodzi przez dopisanie wpisu (nowa lub zmieniona funkcja musi mieścić się w limicie)`);
    }
  }
  for (const [rel, entry] of Object.entries(baseline.files)) {
    const old = oldFiles[rel];
    for (const metric of metricsOf(entry)) {
      if (old && old[metric] !== undefined) {
        if (entry[metric] > old[metric]) red('file-growth-vs-base', rel, `${metric} wpisu rośnie względem ${base.ref}: ${old[metric]} -> ${entry[metric]}`);
        continue;
      }
      const scopeId = Object.keys(limits.scopes).find(id => matchesScope(limits.scopes[id], rel));
      const allowed = scopeId && introduced(limits, base, scopeId, metric) && current.files[rel] !== undefined && base.fileHashes[rel] === current.files[rel].hash;
      if (!allowed) red('new-file-entry', rel, `nowy wpis ${metric}=${entry[metric]} względem ${base.ref}: plik ponad limit musi mieścić się w limicie (albo być niezmieniony, gdy miara jest nowa)`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { command: 'check', mode: 'enforce', base: 'none', ci: process.env.GITHUB_ACTIONS === 'true', root: REPO_ROOT };
  for (const arg of argv) {
    if (arg === 'check' || arg === 'write-baseline') opts.command = arg;
    else if (arg.startsWith('--mode=')) opts.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg.startsWith('--root=')) opts.root = path.resolve(arg.slice('--root='.length));
    else if (arg === '--ci') opts.ci = true;
    else throw new UsageError(`nieznany argument: ${arg}`);
  }
  if (!['report', 'enforce'].includes(opts.mode)) throw new UsageError(`--mode: report albo enforce, nie ${opts.mode}`);
  return opts;
}

async function main(argv, out = console) {
  let opts;
  try {
    opts = parseArgs(argv);
    const limits = loadLimits(opts.root);
    const current = await measure(opts.root, limits);
    if (opts.command === 'write-baseline') {
      const baseline = buildBaseline(current);
      fs.writeFileSync(path.join(opts.root, BASELINE_FILE), `${JSON.stringify(baseline, null, 2)}\n`);
      out.log(`[debt-ratchet] zapisano ${BASELINE_FILE}: ${Object.keys(baseline.functions).length} funkcji, ${Object.keys(baseline.files).length} plików`);
      return 0;
    }
    const baseline = loadBaseline(opts.root);
    const base = opts.base === 'none' ? null : loadBase(opts.root, opts.base, limits);
    const { findings } = compare({ current, baseline, limits, base, ci: opts.ci });
    const reds = findings.filter(f => f.level === 'red');
    for (const f of findings) {
      out.log(`[debt-ratchet] ${f.level.toUpperCase()} ${f.code} ${f.key}: ${f.message}`);
      if (opts.ci && f.level === 'red') out.log(`::${opts.mode === 'enforce' ? 'error' : 'warning'} title=debt-ratchet ${f.code}::${f.key}: ${f.message}`);
    }
    const active = Object.values(limits.scopes).reduce((n, s) => n + Object.keys(s.limits || {}).length, 0);
    out.log(`[debt-ratchet] ${reds.length === 0 ? 'OK' : 'CZERWONE'}: ${active} aktywnych miar, ${Object.keys(current.functions).length} funkcji i ${Object.values(current.files).filter(f => Object.keys(f.metrics).length > 0).length} plików ponad limit, ${reds.length} naruszeń${opts.mode === 'report' ? ' (tryb raportu, nie blokuje)' : ''}`);
    return reds.length > 0 && opts.mode === 'enforce' ? 1 : 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out.error(`[debt-ratchet] BŁĄD: ${e.message}`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e); process.exit(2); });
}

module.exports = {
  METRICS, UsageError, analyseScope, buildBaseline, cleanGitEnv, compare, git, globToRegExp, listFunctions, loadBase, loadBaseline, loadLimits,
  main, measure, parseArgs, validateBaseline, validateLimits
};
