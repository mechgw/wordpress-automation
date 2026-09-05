'use strict';

// Points git at .githooks so the pre-commit gate runs for every clone.
// Runs from `npm ci` / `npm install` (prepare). Silent no-op outside a git
// checkout (e.g. CI tarballs) so it never breaks installation.

const { execFileSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  console.log('[hooks] core.hooksPath set to .githooks');
} catch {
  console.log('[hooks] not a git checkout, skipping hook installation');
}
