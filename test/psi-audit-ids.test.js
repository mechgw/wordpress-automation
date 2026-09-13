'use strict';

/**
 * #157: kolektor czyta aktualne identyfikatory audytów, z fallbackiem na wycofane.
 *
 * Fixture'y NIE są wymyślone. Pochodzą z sondy uruchomionej na produkcji
 * 2026-09-13 (v2.32.0, Lighthouse 13.4.1) i odtwarzają kształt, który naprawdę
 * wrócił — łącznie z tym, że węzeł LCP leży jako goła pozycja `details.items`,
 * a nie pod kluczem `node`. Dokładnie to przeoczenie sprawiało, że sama zmiana
 * identyfikatora nic by nie dała.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FINDINGS = 'PAGESPEED FINDINGS';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };
const COL = { url: 1, strategy: 2, kind: 4, name: 5, detail: 6, timeMs: 7, transferKb: 8 };

/** Kształt z Lighthouse 13.4.1: tabela faz, a obok niej goły węzeł. */
const lcpBreakdown = (selector = 'section.hero') => ({
  scoreDisplayMode: 'numeric',
  details: {
    type: 'list',
    items: [
      {
        type: 'table',
        headings: [],
        items: [
          { duration: 120, label: 'TTFB', subpart: 'ttfb' },
          { duration: 300, label: 'Load delay', subpart: 'loadDelay' },
          { duration: 80, label: 'Render delay', subpart: 'elementRenderDelay' }
        ]
      },
      {
        snippet: '<section class="hero">',
        selector: selector,
        boundingRect: { top: 0, left: 0 },
        type: 'node',
        nodeLabel: 'Zamów kuriera',
        lhId: 'page-0-SECTION',
        path: '1,HTML,1,BODY'
      }
    ]
  }
});

/** Kształt wycofany: węzeł opakowany w `node`, dwa poziomy zagnieżdżenia. */
const lcpLegacy = (selector = 'main.legacy') => ({
  details: { items: [{ items: [{ node: { selector: selector } }] }] }
});

const thirdPartiesInsight = () => ({
  scoreDisplayMode: 'informative',
  details: {
    type: 'table',
    items: [
      { mainThreadTime: 800, transferSize: 501000, entity: 'Google Tag Manager', subItems: {} },
      { subItems: {}, entity: 'Google Analytics', transferSize: 191000, mainThreadTime: 120 }
    ]
  }
});

const thirdPartyLegacy = () => ({
  details: { items: [{ entity: { text: 'Stary Dostawca' }, transferSize: 40960, mainThreadTime: 55 }] }
});

const psi = audits => JSON.stringify({
  lighthouseResult: {
    lighthouseVersion: '13.4.1',
    categories: { performance: { score: 0.72 } },
    audits: Object.assign({ 'largest-contentful-paint': { numericValue: 2500 } }, audits)
  }
});

function run(audits) {
  const gas = loadProject({
    properties: KEY,
    sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
    fetch: url => (String(url).indexOf('pagespeedonline') >= 0
      ? { code: 200, text: psi(audits) }
      : { code: 404, text: '{}' })
  });
  gas.runPsiMeasurement_();
  return gas;
}

const ofKind = (gas, kind) => gas.$sheet(FINDINGS).slice(1)
  .filter(row => String(row[COL.url] || '') !== '' && row[COL.kind] === kind);

describe('#157: element LCP z aktualnego audytu', () => {
  test('węzeł jako goła pozycja `details.items` jest znaleziony', () => {
    const rows = ofKind(run({ 'lcp-breakdown-insight': lcpBreakdown() }), 'ELEMENT LCP');
    assert.ok(rows.length > 0);
    rows.forEach(row => {
      assert.equal(row[COL.detail], 'section.hero', 'selektor z gołego węzła');
      assert.equal(row[COL.name], 'lcp-breakdown-insight', 'nazwa mówi, co naprawdę wróciło');
    });
  });

  test('tabela faz przed węzłem nie przesłania go', () => {
    // Pierwsza pozycja to `type/items/headings` bez żadnego węzła — gdyby
    // wyszukiwanie kończyło się na pierwszej pozycji, wynik byłby pusty.
    const rows = ofKind(run({ 'lcp-breakdown-insight': lcpBreakdown('h1.tytul') }), 'ELEMENT LCP');
    rows.forEach(row => assert.equal(row[COL.detail], 'h1.tytul'));
  });

  test('wycofany audyt nadal działa, gdy tylko on wraca', () => {
    const rows = ofKind(run({ 'largest-contentful-paint-element': lcpLegacy() }), 'ELEMENT LCP');
    rows.forEach(row => {
      assert.equal(row[COL.detail], 'main.legacy');
      assert.equal(row[COL.name], 'largest-contentful-paint-element');
    });
  });

  test('gdy wracają oba, wygrywa aktualny', () => {
    const rows = ofKind(run({
      'lcp-breakdown-insight': lcpBreakdown('section.nowy'),
      'largest-contentful-paint-element': lcpLegacy('main.stary')
    }), 'ELEMENT LCP');
    rows.forEach(row => {
      assert.equal(row[COL.detail], 'section.nowy');
      assert.equal(row[COL.name], 'lcp-breakdown-insight');
    });
  });

  test('brak obu audytów daje jawną adnotację, nie ciszę', () => {
    const rows = ofKind(run({}), 'ELEMENT LCP');
    assert.ok(rows.length > 0, 'wiersz powstaje mimo braku audytu');
    rows.forEach(row => assert.match(String(row[COL.detail]), /nie wskazał elementu LCP/));
  });
});

describe('#157: third-party z aktualnego audytu', () => {
  test('pozycje `third-parties-insight` trafiają do arkusza z kosztem, nie oszczędnością', () => {
    const rows = ofKind(run({ 'third-parties-insight': thirdPartiesInsight() }), 'THIRD-PARTY');
    const mobile = rows.filter(row => row[COL.strategy] === 'mobile');
    assert.deepEqual(mobile.map(row => row[COL.name]).sort(), ['Google Analytics', 'Google Tag Manager']);
    const gtm = mobile.find(row => row[COL.name] === 'Google Tag Manager');
    assert.equal(gtm[COL.timeMs], 800, 'czas wątku głównego to koszt');
    assert.equal(gtm[COL.transferKb], Math.round(501000 / 1024));
  });

  test('kolejność kluczy w pozycji nie ma znaczenia', () => {
    // W realnej odpowiedzi pola przychodzą w różnej kolejności w kolejnych
    // pozycjach; czytamy po nazwach, nie po miejscu.
    const rows = ofKind(run({ 'third-parties-insight': thirdPartiesInsight() }), 'THIRD-PARTY');
    const ga = rows.find(row => row[COL.name] === 'Google Analytics');
    assert.equal(ga[COL.timeMs], 120);
    assert.equal(ga[COL.transferKb], Math.round(191000 / 1024));
  });

  test('wycofany audyt nadal działa, także z `entity` jako obiektem', () => {
    const rows = ofKind(run({ 'third-party-summary': thirdPartyLegacy() }), 'THIRD-PARTY');
    assert.deepEqual([...new Set(rows.map(row => row[COL.name]))], ['Stary Dostawca']);
  });

  test('gdy wracają oba, wygrywa aktualny', () => {
    const rows = ofKind(run({
      'third-parties-insight': thirdPartiesInsight(),
      'third-party-summary': thirdPartyLegacy()
    }), 'THIRD-PARTY');
    assert.ok(rows.every(row => row[COL.name] !== 'Stary Dostawca'), 'stary audyt zignorowany');
  });
});

describe('#157: rozpoznawanie węzła', () => {
  test('opakowanie nie jest brane za węzeł', () => {
    const gas = loadProject({ properties: KEY, sheets: { [URLS]: [URLS_HEADER, [URL, 'h', '']] } });
    assert.equal(gas.psiLooksLikeNode_({ type: 'table', headings: [], items: [] }), false);
    assert.equal(gas.psiLooksLikeNode_({ duration: 120, label: 'TTFB', subpart: 'ttfb' }), false);
    assert.equal(gas.psiLooksLikeNode_(null), false);
    assert.equal(gas.psiLooksLikeNode_('tekst'), false);
  });

  test('węzeł rozpoznany po każdym z trzech pól opisujących element', () => {
    const gas = loadProject({ properties: KEY, sheets: { [URLS]: [URLS_HEADER, [URL, 'h', '']] } });
    assert.equal(gas.psiLooksLikeNode_({ selector: 'main' }), true);
    assert.equal(gas.psiLooksLikeNode_({ nodeLabel: 'Zamów' }), true);
    assert.equal(gas.psiLooksLikeNode_({ snippet: '<p>' }), true);
    // Puste wartości nie liczą się jako opis elementu.
    assert.equal(gas.psiLooksLikeNode_({ selector: '', nodeLabel: '', snippet: '' }), false);
  });
});
