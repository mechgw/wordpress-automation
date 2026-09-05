'use strict';

/**
 * #44: wspólny skrypt porównania projektu Apps Script z checkoutem, użyty przez
 * deploy (weryfikacja po pushu) i drift check. Testowany na tymczasowym repo z
 * podstawionym poleceniem pobrania (APPS_SCRIPT_PULL_CMD).
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'quality', 'apps-script-compare.js');
const roots = [];

after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Repo z trzema źródłami; `fake` to skrypt symulujący clasp pull (mutacje w cwd). */
function repo(fakePullBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-'));
  roots.push(root);
  const g = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.pl']);
  g(['config', 'user.name', 'test']);
  // Byte-exact comparisons regardless of the developer's global autocrlf.
  g(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(root, 'Kod.gs'), 'function a() {}\n');
  fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() {}\n');
  fs.writeFileSync(path.join(root, 'Version.gs'), "const DEPLOYED_VERSION = { tag: 'dev' };\n");
  fs.writeFileSync(path.join(root, 'appsscript.json'), '{"timeZone":"Europe/Warsaw"}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.clasp.json\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  const fake = path.join(root, 'fake-clasp.js');
  fs.writeFileSync(fake, `'use strict';\nconst fs=require('fs');\n${fakePullBody}\nconsole.log('Pulled files.');\n`);
  return { root, fake };
}

function run(root, fake, extraArgs = [], env = {}) {
  const summary = path.join(root, 'summary.md');
  const r = spawnSync(process.execPath, [SCRIPT, '--cwd', root, '--label', 'v9.9.9', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${fake}"`, GITHUB_STEP_SUMMARY: summary, ...env }
  });
  const summaryText = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  return { status: r.status, out: r.stdout + r.stderr, summary: summaryText };
}

describe('apps-script-compare', () => {
  test('identical project → OK, exit 0, summary mentions the label and the pull output', () => {
    const { root, fake } = repo('');
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✅ Apps Script matches v9\.9\.9\./);
    assert.match(r.summary, /Pulled files\./);
  });

  test('missing trailing newlines and a stamped Version.gs are not drift', () => {
    const { root, fake } = repo(`
      fs.writeFileSync('Kod.gs', 'function a() {}');
      fs.writeFileSync('appsscript.json', '{"timeZone":"Europe/Warsaw"}');
      fs.writeFileSync('Version.gs', "const DEPLOYED_VERSION = { tag: 'v9.9.9', commit: 'abc' };\\n");
    `);
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(root, 'Version.gs'), 'utf8'), "const DEPLOYED_VERSION = { tag: 'dev' };\n", 'Version.gs restored from git');
  });

  test('a changed source is drift: exit 1, file listed, patch written', () => {
    const { root, fake } = repo(`fs.writeFileSync('GA4.gs', 'function b() { return 1; }\\n');`);
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, /❌ Apps Script differs from v9\.9\.9/);
    assert.match(r.out, / M GA4\.gs/);
    assert.match(r.out, /::error::Apps Script project differs from v9\.9\.9\. See the job summary and the patch artifact\./);
    const patch = fs.readFileSync(path.join(root, 'drift.patch'), 'utf8');
    assert.match(patch, /\+function b\(\) \{ return 1; \}/);
  });

  test('a new file in the live project is drift and appears in the patch', () => {
    const { root, fake } = repo(`fs.writeFileSync('Extra.gs', 'function extra() {}\\n');`);
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, /\?\? Extra\.gs/);
    assert.match(fs.readFileSync(path.join(root, 'drift.patch'), 'utf8'), /\+function extra\(\) \{\}/);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /\?\? Extra\.gs/, 'intent-to-add was reset, file stays untracked');
  });

  test('files outside the sources (e.g. .clasp.json) never count as drift', () => {
    const { root, fake } = repo(`fs.writeFileSync('.clasp.json', '{"scriptId":"x"}'); fs.writeFileSync('notes.txt', 'x');`);
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
  });

  test('a ref without Version.gs (older tag) is compared without trying to restore it', () => {
    const { root, fake } = repo('');
    execFileSync('git', ['rm', '-q', 'Version.gs'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@e.pl', '-c', 'user.name=t', 'commit', '-q', '-m', 'no version file'], { cwd: root });
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
  });

  test('a flag without a value fails fast with a clear message', () => {
    const { root, fake } = repo('');
    const r = spawnSync(process.execPath, [SCRIPT, '--cwd', root, '--label'], { encoding: 'utf8', env: { ...process.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${fake}"` } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--label requires a value/);
  });

  test('a failing pull is reported as a clear failure, not a diff', () => {
    const { root, fake } = repo(`process.exit(3);`);
    const r = run(root, fake);
    assert.equal(r.status, 1);
    assert.match(r.out, /\[apps-script-compare\] FAIL: Pull failed/);
  });
});
