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
 *   4. `git status` ograniczony do źródeł (src/*.gs, albo *.gs w starszych tagach);
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

/**
 * Katalog ze źródłami wdrażanego refa. Od #105 to src/, ale rollback do
 * wcześniejszego taga ma je w katalogu głównym, a to narzędzie zawsze pochodzi
 * z main, więc musi obsłużyć oba układy.
 */
function sourceDir(cwd) {
  return fs.existsSync(path.join(cwd, 'src', 'appsscript.json')) ? 'src' : '.';
}

/** Pathspec ograniczający git status/diff do samych źródeł Apps Script. */
function sourcePathspec(cwd) {
  const dir = sourceDir(cwd);
  return dir === '.' ? ['*.gs', 'appsscript.json'] : [dir + '/*.gs', dir + '/appsscript.json'];
}

function normalizeTrailingNewline(cwd) {
  const dir = path.join(cwd, sourceDir(cwd));
  for (const f of fs.readdirSync(dir)) {
    if (!/\.gs$/.test(f) && f !== 'appsscript.json') continue;
    const p = path.join(dir, f);
    const s = fs.readFileSync(p, 'utf8');
    if (s.length && !s.endsWith('\n')) fs.writeFileSync(p, s + '\n');
  }
}

/**
 * Druga strona tej samej normalizacji: plik w repozytorium (index) bez znaku
 * nowej linii na końcu, który Apps Script oddaje z tym znakiem, nie jest
 * driftem. Gdy jedyną różnicą jest ten znak, index dostaje wersję z
 * roboczego katalogu; każda inna różnica zostaje widoczna w status/diff.
 */
function normalizeIndexTrailingNewline(cwd) {
  const tracked = git(cwd, ['ls-files', '--', ...sourcePathspec(cwd)]).split('\n').map(s => s.trim()).filter(Boolean);
  for (const f of tracked) {
    const shown = spawnSync('git', ['show', ':' + f], { cwd, encoding: 'utf8' });
    if (shown.status !== 0) continue;
    const indexed = shown.stdout;
    if (!indexed.length || indexed.endsWith('\n')) continue;
    const p = path.join(cwd, f);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === indexed + '\n') git(cwd, ['add', '--', f]);
  }
}

/** Zwraca { changes: string, patch: string } albo puste stringi gdy brak różnic. */
function compare(cwd) {
  normalizeTrailingNewline(cwd);
  normalizeIndexTrailingNewline(cwd);
  // Restore only when the ref tracks Version.gs (older tags do not have it).
  const versionFile = sourceDir(cwd) === '.' ? 'Version.gs' : 'src/Version.gs';
  if (git(cwd, ['ls-files', '--', versionFile]).trim()) {
    git(cwd, ['checkout', '--', versionFile]);
  }
  const pathspec = ['--', ...sourcePathspec(cwd)];
  // Keep the leading status columns (" M", "??"); only strip trailing whitespace.
  // Lines with a change only in the index (e.g. "M  Kod.gs" after the trailing
  // newline normalisation above) are not drift: drift is worktree vs index.
  const changes = git(cwd, ['status', '--porcelain', ...pathspec])
    .split('\n')
    .filter(l => l.trim() && (l.startsWith('??') || l[1] !== ' '))
    .join('\n')
    .replace(/\s+$/, '');
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

module.exports = { compare, normalizeTrailingNewline, normalizeIndexTrailingNewline };
