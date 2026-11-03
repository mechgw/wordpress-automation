#!/usr/bin/env node
'use strict';

/**
 * Job zbiorczy `quality-gate` (#242): jedna wymagana kontrola `main` zamiast listy jobów.
 *
 * Zielony tylko wtedy, gdy KAŻDY job z listy wymaganych ma wynik dokładnie `success`. Fail-closed:
 * `failure`, `cancelled`, `skipped`, brak wpisu i nieznany wynik dają czerwony wynik. Jedyny wyjątek to job
 * z listy ciężkich kontroli (`HEAVY_JOBS`), pominięty w PR w Draft: po „Ready for review” workflow startuje
 * od nowa na bieżącym HEAD (`ready_for_review` w `ci.yml`), więc wynik z Draft nie wystarcza do scalenia.
 *
 * Lista wymaganych jobów jest w jednym miejscu (tu); test `test/quality-gate.test.js` pilnuje zgodności z `ci.yml`.
 *
 * Użycie (w jobie): NEEDS_JSON='${{ toJSON(needs) }}' DRAFT='${{ github.event.pull_request.draft }}' node scripts/quality/quality-gate.js
 */

/** Joby kontrolne z `ci.yml`, od których zależy agregat (wszystkie poza samym `quality-gate`). */
const REQUIRED_JOBS = ['validate', 'secret-scan'];

/** Ciężkie kontrole, które w PR w Draft wolno pominąć (dziś brak; dodaje je #254). */
const HEAVY_JOBS = [];

/**
 * @param {Record<string, {result?: string}>} needs obiekt `needs` z GitHub Actions
 * @param {{draft?: boolean}} [options]
 * @returns {{ok: boolean, failures: string[]}}
 */
function evaluate(needs, { draft = false } = {}) {
  const failures = [];
  for (const job of [...REQUIRED_JOBS, ...HEAVY_JOBS]) {
    const result = needs && needs[job] ? needs[job].result : undefined;
    if (result === 'success') continue;
    if (result === 'skipped' && draft && HEAVY_JOBS.includes(job)) continue;
    failures.push(`${job}: ${result === undefined ? 'brak wyniku' : result}`);
  }
  return { ok: failures.length === 0, failures };
}

function main(env = process.env, out = console) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS_JSON);
  } catch {
    out.error('[quality-gate] BŁĄD: NEEDS_JSON nie jest poprawnym JSON (oczekiwano toJSON(needs))');
    return 2;
  }
  const { ok, failures } = evaluate(needs, { draft: env.DRAFT === 'true' });
  for (const job of [...REQUIRED_JOBS, ...HEAVY_JOBS]) out.log(`[quality-gate] ${job}: ${needs[job] ? needs[job].result : 'brak wyniku'}`);
  if (!ok) {
    out.error(`[quality-gate] CZERWONE: ${failures.join(', ')}`);
    return 1;
  }
  out.log('[quality-gate] OK');
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { HEAVY_JOBS, REQUIRED_JOBS, evaluate, main };
