#!/usr/bin/env node
'use strict';

/**
 * Coverage gate for the Apps Script sources.
 *
 * Two rules, evaluated after running the unit tests with V8 coverage:
 *
 *   1. Per-file thresholds from .quality/coverage-policy.json (a ratchet:
 *      thresholds may only go up as tests are added).
 *   2. 100% line coverage of CHANGED lines in *.gs files. Lines listed in
 *      .quality/changed-lines-ignore.json (with a reason) are exempt.
 *
 * Usage:
 *   node scripts/quality/coverage-gate.js [--changed=none|staged|base:<ref>]
 *                                        [--lcov=<path>] [--no-run]
 *
 *   --changed=staged     pre-commit: lines staged in the index
 *   --changed=base:REF   CI: lines changed since REF (git diff REF...HEAD)
 *   --changed=none       only the per-file thresholds
 *   --no-run             reuse an existing lcov file instead of running tests
 *
 * Exit code 1 on any violation; the report says exactly which lines to cover
 * or how to register a justified exception.
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LCOV_DEFAULT = path.join(ROOT, 'coverage', 'lcov.info');
const POLICY_FILE = path.join(ROOT, '.quality', 'coverage-policy.json');
const IGNORE_FILE = path.join(ROOT, '.quality', 'changed-lines-ignore.json');
const SOURCE_GLOB = /\.gs$/;

function parseArgs(argv) {
  const opts = { changed: 'none', lcov: LCOV_DEFAULT, run: true };
  for (const arg of argv) {
    if (arg.startsWith('--changed=')) opts.changed = arg.slice('--changed='.length);
    else if (arg.startsWith('--lcov=')) opts.lcov = path.resolve(ROOT, arg.slice('--lcov='.length));
    else if (arg === '--no-run') opts.run = false;
    else if (arg === '--help' || arg === '-h') { printUsage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); printUsage(); process.exit(2); }
  }
  if (!/^(none|staged|base:.+)$/.test(opts.changed)) {
    console.error(`Invalid --changed value: ${opts.changed}`);
    process.exit(2);
  }
  return opts;
}

function printUsage() {
  console.log('Usage: node scripts/quality/coverage-gate.js [--changed=none|staged|base:<ref>] [--lcov=<path>] [--no-run]');
}

function runTestsWithCoverage(lcovPath) {
  fs.mkdirSync(path.dirname(lcovPath), { recursive: true });
  const args = [
    '--test',
    '--experimental-test-coverage',
    '--test-coverage-include=*.gs',
    '--test-reporter=lcov', `--test-reporter-destination=${lcovPath}`,
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    'test/**/*.test.js'
  ];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`Unit tests failed (exit ${result.status}); fix them before looking at coverage.`);
  }
}

/** lcov → Map<relativeFile, { lines: Map<line, hits>, found, hit }> */
function parseLcov(lcovPath) {
  if (!fs.existsSync(lcovPath)) fail(`Coverage report not found: ${lcovPath}`);
  const files = new Map();
  let current = null;
  for (const raw of fs.readFileSync(lcovPath, 'utf8').split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      const rel = normalizeSource(raw.slice(3));
      current = { lines: new Map(), found: 0, hit: 0 };
      files.set(rel, current);
    } else if (raw.startsWith('DA:') && current) {
      const [line, hits] = raw.slice(3).split(',').map(Number);
      current.lines.set(line, hits);
      current.found += 1;
      if (hits > 0) current.hit += 1;
    } else if (raw === 'end_of_record') {
      current = null;
    }
  }
  return files;
}

function normalizeSource(sf) {
  const abs = path.isAbsolute(sf) ? sf : path.resolve(ROOT, sf);
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`Cannot parse ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

/** Minimal glob: `*` matches within a segment, `**` matches across segments. */
function globToRegExp(pattern) {
  const escaped = pattern
    .split('**')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function thresholdFor(file, policy) {
  for (const rule of policy.rules || []) {
    if (globToRegExp(rule.pattern).test(file)) {
      return { threshold: Number(rule.threshold), rationale: rule.rationale || '' };
    }
  }
  return { threshold: Number(policy.defaultThreshold ?? 0), rationale: 'defaultThreshold' };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** Changed *.gs lines as Map<file, Set<line>> for the requested mode. */
function changedLines(mode) {
  if (mode === 'none') return new Map();
  const diffArgs = ['diff', '--no-color', '-U0'];
  if (mode === 'staged') diffArgs.push('--cached');
  else diffArgs.push(`${mode.slice('base:'.length)}...HEAD`);
  diffArgs.push('--', '*.gs');

  const result = new Map();
  let file = null;
  for (const line of git(diffArgs).split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '');
      if (file) result.set(file, result.get(file) || new Set());
    } else if (file && line.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let l = start; l < start + count; l++) result.get(file).add(l);
    }
  }
  return result;
}

function ignoredLines(registry) {
  const map = new Map();
  for (const entry of registry.entries || []) {
    if (!entry.path || !Array.isArray(entry.lines) || !String(entry.reason || '').trim()) {
      fail(`.quality/changed-lines-ignore.json: every entry needs "path", "lines" and a non-empty "reason" (offending: ${JSON.stringify(entry)})`);
    }
    map.set(entry.path, new Set(entry.lines.map(Number)));
  }
  return map;
}

function ranges(lines) {
  const sorted = [...lines].sort((a, b) => a - b);
  const out = [];
  for (const l of sorted) {
    const last = out[out.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else out.push([l, l]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

function fail(message) {
  console.error(`\n[coverage-gate] FAIL: ${message}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.run) runTestsWithCoverage(opts.lcov);

  const coverage = parseLcov(opts.lcov);
  const policy = readJson(POLICY_FILE, { defaultThreshold: 0, rules: [] });
  const ignore = ignoredLines(readJson(IGNORE_FILE, { entries: [] }));
  const problems = [];

  // --- 1. per-file thresholds ------------------------------------------------
  console.log('\n[coverage-gate] Per-file line coverage vs .quality/coverage-policy.json');
  const sources = fs.readdirSync(ROOT).filter(f => SOURCE_GLOB.test(f)).sort();
  for (const file of sources) {
    const cov = coverage.get(file);
    const { threshold } = thresholdFor(file, policy);
    if (!cov) {
      problems.push(`${file}: not loaded by the test harness (add it to SOURCES in test/helpers/gas.js)`);
      console.log(`  ${file.padEnd(16)} n/a      (threshold ${threshold}%)  ← not in coverage report`);
      continue;
    }
    const pct = cov.found ? (cov.hit / cov.found) * 100 : 100;
    const ok = pct + 1e-9 >= threshold;
    console.log(`  ${file.padEnd(16)} ${pct.toFixed(2).padStart(6)}%  (threshold ${threshold}%)  ${ok ? 'OK' : 'BELOW'}`);
    if (!ok) problems.push(`${file}: line coverage ${pct.toFixed(2)}% is below the ${threshold}% threshold`);
  }

  // --- 2. changed lines -------------------------------------------------------
  const changed = changedLines(opts.changed);
  if (opts.changed === 'none') {
    console.log('\n[coverage-gate] Changed-lines rule skipped (--changed=none).');
  } else {
    console.log(`\n[coverage-gate] Changed lines in *.gs (${opts.changed}) must be 100% covered`);
    let total = 0;
    let uncoveredTotal = 0;
    for (const [file, lines] of changed) {
      if (!fs.existsSync(path.join(ROOT, file))) continue; // deleted file
      const cov = coverage.get(file);
      const exempt = ignore.get(file) || new Set();
      const uncovered = [];
      let counted = 0;
      for (const line of lines) {
        if (!cov) { uncovered.push(line); counted += 1; continue; }
        if (!cov.lines.has(line)) continue; // not a statement line (comment, blank, brace)
        counted += 1;
        if (cov.lines.get(line) === 0 && !exempt.has(line)) uncovered.push(line);
      }
      total += counted;
      uncoveredTotal += uncovered.length;
      const status = uncovered.length ? `UNCOVERED ${ranges(uncovered)}` : 'OK';
      console.log(`  ${file.padEnd(16)} ${String(counted - uncovered.length).padStart(4)}/${String(counted).padEnd(4)} statements  ${status}`);
      if (uncovered.length) {
        problems.push(
          `${file}: changed lines ${ranges(uncovered)} are not executed by any test. ` +
          'Add a test that exercises them, or register a justified exception in .quality/changed-lines-ignore.json.'
        );
      }
    }
    if (!changed.size) console.log('  (no changed *.gs lines)');
    else console.log(`  total: ${total - uncoveredTotal}/${total} changed statements covered`);
  }

  if (problems.length) {
    console.error('\n[coverage-gate] Violations:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('\n[coverage-gate] PASS');
}

main();
