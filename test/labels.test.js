'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.github', 'labels.json'), 'utf8')
);

test('label manifest targets this repository and never prunes implicitly', () => {
  assert.equal(manifest.repo, 'mechgw/wordpress-automation');
  assert.equal(manifest.prune, false);
  assert.ok(Array.isArray(manifest.labels));
  assert.ok(manifest.labels.length > 0);
});

test('label definitions are unique and valid for the GitHub API', () => {
  const names = new Set();

  for (const label of manifest.labels) {
    assert.match(label.name, /\S/);
    assert.match(label.color, /^[0-9a-f]{6}$/i, label.name);
    assert.ok((label.description || '').length <= 100, label.name);
    assert.ok(manifest.families[label.family], `${label.name}: unknown family ${label.family}`);

    const key = label.name.toLowerCase();
    assert.equal(names.has(key), false, `duplicate label: ${label.name}`);
    names.add(key);
  }
});

test('closed label families are complete and family colors stay consistent', () => {
  const byName = new Map(manifest.labels.map(label => [label.name, label]));

  for (const name of ['P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3']) {
    assert.ok(byName.has(name), `missing required label ${name}`);
  }

  for (const [familyName, family] of Object.entries(manifest.families)) {
    if (!family.color) continue;
    for (const label of manifest.labels.filter(item => item.family === familyName)) {
      assert.equal(label.color.toLowerCase(), family.color.toLowerCase(), label.name);
    }
  }
});
