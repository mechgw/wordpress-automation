'use strict';

// Komenda testowa dla StrykerJS (pilot mutacji). Uruchamia testy `node --test` z mostem
// vm-preload.js, bez testów skanujących samo repozytorium (git ls-files, wordpress/, .git):
// w kopii roboczej Strykera nie mają czego skanować i padają niezależnie od mutacji.
// Otoczenie testów to allowlista (safe-env.js): poświadczenia i GIT_* nie przechodzą.
// Użycie: node scripts/mutation/run-tests.js [plik.test.js ...]  (bez argumentów: wszystkie)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['repo-identity.test.js', 'source-control-chars.test.js']);

function main() {
  const requested = process.argv.slice(2);
  const files = requested.length > 0
    ? requested
    : fs.readdirSync(path.join(ROOT, 'test'))
      .filter(f => f.endsWith('.test.js') && !SKIP.has(f))
      .map(f => path.join('test', f));

  const result = spawnSync(
    process.execPath,
    ['--require', path.join(__dirname, 'vm-preload.js'), '--test', '--test-concurrency=2', ...files],
    { cwd: ROOT, stdio: 'inherit', env: safeEnv(process.env) }
  );
  process.exit(result.status === null ? 1 : result.status);
}

if (require.main === module) main();
module.exports = { safeEnv };
