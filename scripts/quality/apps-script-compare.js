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
 *   2. Normalizacja końcowego znaku nowej linii po stronie pobranego projektu.
 *   3. Różnice będące wyłącznie końcowym `\n` są porównywane po tej samej
 *      normalizacji także względem wersji z gita i czyszczone jako brak driftu.
 *   4. `Version.gs` wraca do wersji z gita (wdrożenie stempluje go celowo).
 *   5. `git status` ograniczony do *.gs i appsscript.json; cokolwiek innego
 *      (np. .clasp.json) nie liczy się jako różnica.
 *   6. Różnica → lista plików, patch (opcjonalnie do pliku) i kod wyjścia 1.
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
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') opts.label = value(i++, '--label');
    else if (argv[i] === '--patch') opts.patch = value(i++, '--patch');
    else if (argv[i] === '--cwd') opts.cwd = path.resolve(value(i++, '--cwd'));
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function pull(cwd) {
  const override = process.env.APPS_SCRIPT_PULL_CMD;
  // Default runs without a shell; only an explicit override (tests) goes
  // through one. On Windows npx is a .cmd wrapper and needs the shell anyway.
  const r = override
    ? spawnSync(override, { cwd, shell: true, encoding: 'utf8' })
    : spawnSync('npx', ['clasp', 'pull'], { cwd, shell: process.platform === 'win32', encoding: 'utf8' });
  const cmd = override || 'npx clasp pull';
  if (r.error) throw new Error(`Pull failed (${cmd}): ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`Pull failed (${cmd}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

function withTrailingNewline(text) {
  return text.length && !text.endsWith('\n') ? text + '\n' : text;
}

function normalizeTrailingNewline(cwd) {
  for (const f of fs.readdirSync(cwd)) {
    if (!/\.gs$/.test(f) && f !== 'appsscript.json') continue;
    const p = path.join(cwd, f);
    const s = fs.readFileSync(p, 'utf8');
    const normalized = withTrailingNewline(s);
    if (normalized !== s) fs.writeFileSync(p, normalized);
  }
}

/**
 * `normalizeTrailingNewline()` normalizuje workspace po `clasp pull`, ale gitowy
 * ref może sam nie mieć końcowego `\n`. W takim przypadku samo dopisanie nowej
 * linii tworzyłoby fałszywe ` M plik.gs`. Jeśli zawartość HEAD i workspace jest
 * identyczna po normalizacji końcowego `\n`, przywracamy bajty z HEAD i usuwamy
 * wyłącznie ten sztuczny drift. Każda inna zmiana zostaje nietknięta.
 */
function clearTrailingNewlineOnlyDiffs(cwd) {
  const changed = git(cwd, ['diff', '--name-only', '--', '*.gs', 'appsscript.json'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  for (const f of changed) {
    if (f === 'Version.gs') continue;
    const p = path.join(cwd, f);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;

    let baseline;
    try {
      baseline = git(cwd, ['show', `HEAD:${f}`]);
    } catch {
      continue;
    }

    const current = fs.readFileSync(p, 'utf8');
    if (withTrailingNewline(baseline) === withTrailingNewline(current)) {
      git(cwd, ['checkout', '--', f]);
    }
  }
}

/** Zwraca { changes: string, patch: string } albo puste stringi gdy brak różnic. */
function compare(cwd) {
  normalizeTrailingNewline(cwd);
  // Restore only when the ref tracks Version.gs (older tags do not have it).
  if (git(cwd, ['ls-files', '--', 'Version.gs']).trim()) {
    git(cwd, ['checkout', '--', 'Version.gs']);
  }
  clearTrailingNewlineOnlyDiffs(cwd);

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

module.exports = { compare, normalizeTrailingNewline, clearTrailingNewlineOnlyDiffs, withTrailingNewline };
