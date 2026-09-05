#!/usr/bin/env node
'use strict';

/**
 * Porównanie projektu Apps Script z bieżącym checkoutem (#44).
 *
 * Wspólna logika dla dwóch workflow'ów:
 *   - Deploy: tuż po `clasp push` dowodzi, że w Apps Script jest dokładnie to,
 *     co wypchnęliśmy z wdrażanego taga.
 *   - Drift check: co tydzień dowodzi, że nikt nie edytował kodu w edytorze.
 *
 * Kroki:
 *   1. `clasp pull` nadpisuje pliki źródłowe w katalogu roboczym.
 *   2. Normalizacja końcowego znaku nowej linii (edytor Apps Script go obcina).
 *   3. `Version.gs` wraca do wersji z gita (wdrożenie stempluje go celowo).
 *   4. `git status` ograniczony do *.gs i appsscript.json; cokolwiek innego
 *      (np. .clasp.json) nie liczy się jako różnica.
 *   5. Różnica → lista plików, patch (opcjonalnie do pliku) i kod wyjścia 1.
 *
 * Użycie:
 *   node scripts/quality/apps-script-compare.js [--label <opis>] [--patch <plik>] [--cwd <katalog>]
 * Zmienna APPS_SCRIPT_PULL_CMD nadpisuje komendę pobrania (domyślnie `npx clasp pull`);
 * testy podstawiają w ten sposób fałszywy clasp.
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { label: 'the checked-out ref', patch: '', cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') opts.label = argv[++i];
    else if (argv[i] === '--patch') opts.patch = argv[++i];
    else if (argv[i] === '--cwd') opts.cwd = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pull(cwd) {
  const cmd = process.env.APPS_SCRIPT_PULL_CMD || 'npx clasp pull';
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`Pull failed (${cmd}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function normalizeTrailingNewline(cwd) {
  for (const f of fs.readdirSync(cwd)) {
    if (!/\.gs$/.test(f) && f !== 'appsscript.json') continue;
    const p = path.join(cwd, f);
    const s = fs.readFileSync(p, 'utf8');
    if (s.length && !s.endsWith('\n')) fs.writeFileSync(p, s + '\n');
  }
}

/** Zwraca { changes: string, patch: string } albo puste stringi gdy brak różnic. */
function compare(cwd) {
  normalizeTrailingNewline(cwd);
  if (git(cwd, ['ls-files', '--error-unmatch', 'Version.gs']).trim()) {
    git(cwd, ['checkout', '--', 'Version.gs']);
  }
  const pathspec = ['--', '*.gs', 'appsscript.json'];
  // Keep the leading status column (" M", "??"); only strip trailing whitespace.
  const changes = git(cwd, ['status', '--porcelain', ...pathspec]).replace(/\s+$/, '');
  if (!changes.trim()) return { changes: '', patch: '' };
  // Untracked files enter the diff via intent-to-add; reset afterwards.
  const untracked = changes.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).trim());
  if (untracked.length) git(cwd, ['add', '-N', '--', ...untracked]);
  const patch = git(cwd, ['--no-pager', 'diff', ...pathspec]);
  if (untracked.length) git(cwd, ['reset', '-q', '--', ...untracked]);
  return { changes, patch };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pulled = pull(opts.cwd);
  const { changes, patch } = compare(opts.cwd);
  const summary = [];

  if (!changes) {
    summary.push(`✅ Apps Script matches ${opts.label}.`);
    if (pulled) summary.push('', '```', pulled, '```');
  } else {
    summary.push(`❌ Apps Script differs from ${opts.label}:`, '', '```', changes, '```');
    if (opts.patch) {
      fs.writeFileSync(path.resolve(opts.cwd, opts.patch), patch);
      summary.push(`Patch saved to ${opts.patch}.`);
    }
  }

  const text = summary.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  if (changes) {
    console.error(`::error::Apps Script project differs from ${opts.label}. See the job summary${opts.patch ? ' and the patch artifact' : ''}.`);
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`\n[apps-script-compare] FAIL: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { compare, normalizeTrailingNewline };
