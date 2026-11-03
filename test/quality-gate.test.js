'use strict';

/**
 * #242: job zbiorczy `quality-gate`. Ocena wyniku jobów jest fail-closed (tylko `success` zalicza), a lista
 * wymaganych jobów w skrypcie musi się zgadzać z `ci.yml` (nowy job bez wpisu na liście czerwieni test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const gate = require('../scripts/quality/quality-gate.js');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'quality', 'quality-gate.js');
const CI = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');

const allOk = () => Object.fromEntries([...gate.REQUIRED_JOBS, ...gate.HEAVY_JOBS].map(job => [job, { result: 'success' }]));

describe('#242: ocena jobów (evaluate)', () => {
  test('wszystkie wymagane joby z wynikiem success: zielono', () => {
    assert.deepEqual(gate.evaluate(allOk()), { ok: true, failures: [] });
  });

  test('failure, cancelled, skipped, nieznany wynik i brak wpisu dają czerwono, każdy z nazwą jobu', () => {
    for (const result of ['failure', 'cancelled', 'skipped', 'neutral', '', 'Success']) {
      const needs = allOk();
      needs.validate = { result };
      const r = gate.evaluate(needs);
      assert.equal(r.ok, false, `wynik "${result}" nie może zaliczać`);
      assert.deepEqual(r.failures, [`validate: ${result}`]);
    }
    const missing = allOk();
    delete missing['secret-scan'];
    assert.deepEqual(gate.evaluate(missing), { ok: false, failures: ['secret-scan: brak wyniku'] });
    assert.deepEqual(gate.evaluate({}).failures.length, gate.REQUIRED_JOBS.length + gate.HEAVY_JOBS.length);
    assert.equal(gate.evaluate(undefined).ok, false);
    assert.equal(gate.evaluate({ validate: null, 'secret-scan': { result: 'success' } }).ok, false);
  });

  test('pominięcie dozwolone tylko dla jobu z listy ciężkich i tylko w PR w Draft', () => {
    const original = gate.HEAVY_JOBS.slice();
    gate.HEAVY_JOBS.push('mutation');
    try {
      const needs = allOk();
      needs.mutation = { result: 'skipped' };
      assert.equal(gate.evaluate(needs, { draft: true }).ok, true);
      assert.deepEqual(gate.evaluate(needs, { draft: false }).failures, ['mutation: skipped']);
      assert.deepEqual(gate.evaluate(needs).failures, ['mutation: skipped']);
      const cancelled = allOk();
      cancelled.mutation = { result: 'cancelled' };
      assert.equal(gate.evaluate(cancelled, { draft: true }).ok, false);
      const lightSkipped = allOk();
      lightSkipped.mutation = { result: 'success' };
      lightSkipped.validate = { result: 'skipped' };
      assert.deepEqual(gate.evaluate(lightSkipped, { draft: true }).failures, ['validate: skipped']);
    } finally {
      gate.HEAVY_JOBS.length = 0;
      gate.HEAVY_JOBS.push(...original);
    }
  });
});

describe('#242: skrypt jobu (CLI)', () => {
  // Otoczenie procesu bez zmiennych jobu (reszta, np. PATH, zostaje: narzędzia testowe przekazują przez nie swój stan do dziecka).
  const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NEEDS_JSON' && name !== 'DRAFT'));
  const run = env => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...inherited(), ...env } });
  const json = needs => JSON.stringify(needs);

  test('zielony: kod 0 i wynik każdego jobu w logu', () => {
    const r = run({ NEEDS_JSON: json(allOk()), DRAFT: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[quality-gate\] validate: success/);
    assert.match(r.stdout, /\[quality-gate\] OK/);
  });

  test('czerwony: kod 1 i lista jobów, które nie zaliczyły', () => {
    const needs = allOk();
    needs['secret-scan'] = { result: 'cancelled' };
    const r = run({ NEEDS_JSON: json(needs) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[quality-gate\] CZERWONE: secret-scan: cancelled/);
  });

  test('brak lub uszkodzony NEEDS_JSON to błąd użycia (kod 2), nie zielony wynik', () => {
    for (const env of [{}, { NEEDS_JSON: '' }, { NEEDS_JSON: '{' }]) {
      const r = run(env);
      assert.equal(r.status, 2, JSON.stringify(env));
      assert.match(r.stderr, /NEEDS_JSON nie jest poprawnym JSON/);
    }
  });

  test('main: dokładne komunikaty (wynik każdego jobu, podsumowanie, błąd JSON)', () => {
    const io = () => { const out = []; return { out, log: m => out.push(`log: ${m}`), error: m => out.push(`error: ${m}`) }; };
    const green = io();
    assert.equal(gate.main({ NEEDS_JSON: json(allOk()) }, green), 0);
    assert.deepEqual(green.out, ['log: [quality-gate] validate: success', 'log: [quality-gate] secret-scan: success', 'log: [quality-gate] OK']);
    const needs = allOk();
    needs.validate = { result: 'failure' };
    delete needs['secret-scan'];
    const red = io();
    assert.equal(gate.main({ NEEDS_JSON: json(needs) }, red), 1);
    assert.deepEqual(red.out, [
      'log: [quality-gate] validate: failure', 'log: [quality-gate] secret-scan: brak wyniku',
      'error: [quality-gate] CZERWONE: validate: failure, secret-scan: brak wyniku'
    ]);
    const bad = io();
    assert.equal(gate.main({ NEEDS_JSON: '{' }, bad), 2);
    assert.deepEqual(bad.out, ['error: [quality-gate] BŁĄD: NEEDS_JSON nie jest poprawnym JSON (oczekiwano toJSON(needs))']);
    assert.equal(gate.main({}, io()), 2);
  });

  test('main: DRAFT=true z ciężkim jobem pominiętym jest zielone, bez DRAFT czerwone', () => {
    const original = gate.HEAVY_JOBS.slice();
    gate.HEAVY_JOBS.push('mutation');
    const io = () => { const out = []; return { out, log: m => out.push(m), error: m => out.push(m) }; };
    try {
      const needs = allOk();
      needs.mutation = { result: 'skipped' };
      const env = { NEEDS_JSON: json(needs) };
      assert.equal(gate.main({ ...env, DRAFT: 'true' }, io()), 0);
      assert.equal(gate.main({ ...env, DRAFT: 'false' }, io()), 1);
      assert.equal(gate.main(env, io()), 1);
    } finally {
      gate.HEAVY_JOBS.length = 0;
      gate.HEAVY_JOBS.push(...original);
    }
  });
});

describe('#242: zgodność z ci.yml', () => {
  // Wcięcie 2 spacje pod `jobs:` to klucz jobu; `needs: [a, b]` w jobie quality-gate.
  const jobsSection = CI.slice(CI.indexOf('\njobs:'));
  const jobIds = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map(m => m[1]);
  const gateSection = jobsSection.slice(jobsSection.indexOf('\n  quality-gate:'));
  const needs = (/^ {4}needs:\s*\[([^\]]*)\]/m.exec(gateSection) || ['', ''])[1].split(',').map(s => s.trim()).filter(Boolean);

  test('każdy job kontrolny z ci.yml jest na liście wymaganych, a agregat zależy dokładnie od tej listy', () => {
    assert.ok(jobIds.includes('quality-gate'), 'brak jobu quality-gate w ci.yml');
    const checks = jobIds.filter(id => id !== 'quality-gate').sort();
    assert.deepEqual(checks, [...gate.REQUIRED_JOBS, ...gate.HEAVY_JOBS].sort(), 'lista w quality-gate.js różni się od jobów w ci.yml');
    assert.deepEqual([...needs].sort(), checks, '`needs` jobu quality-gate różni się od jobów w ci.yml');
  });

  test('job zbiorczy działa zawsze (if: always), a PR dostaje świeży przebieg po zmianie Draft na Ready', () => {
    assert.match(gateSection, /^ {4}if: always\(\)\s*$/m);
    assert.match(CI, /types: \[opened, synchronize, reopened, ready_for_review\]/);
    assert.match(gateSection, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
    assert.match(gateSection, /DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}/);
  });
});
