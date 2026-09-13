'use strict';

/**
 * #165: fazy rozkładu LCP z `lcp-breakdown-insight`.
 *
 * Fixture podstawowy odtwarza realną odpowiedź zmierzoną sondą na produkcji
 * 2026-09-13 (Lighthouse 13.4.1). Osobne przypadki dowodzą, że parser NIE zależy
 * od liczby faz ani od ich nazw — obserwowane „trzy” wynikają z tego, że element
 * LCP jest sekcją tekstową i fazy zasobowe nie mają czego opisywać.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FINDINGS = 'PAGESPEED FINDINGS';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };
const COL = {
  url: 1, strategy: 2, attempt: 3, kind: 4, name: 5, detail: 6,
  timeMs: 7, transferKb: 8, savingsMs: 9, savingsKb: 10
};

const WEZEL = {
  snippet: '<section class="cc-hero">', selector: 'section.cc-hero', boundingRect: {},
  type: 'node', nodeLabel: 'Zamów kuriera', lhId: 'page-0-SECTION', path: '1,HTML'
};

/** Kształt z produkcji: tabela faz, obok niej goły węzeł. */
const rozklad = (fazy, kolejnoscOdwrocona = false) => {
  const tabela = { type: 'table', headings: [], items: fazy };
  return {
    scoreDisplayMode: 'numeric',
    details: { type: 'list', items: kolejnoscOdwrocona ? [WEZEL, tabela] : [tabela, WEZEL] }
  };
};

const TRZY_FAZY = [
  { subpart: 'ttfb', label: 'Time to first byte', duration: 120.4 },
  { subpart: 'loadDelay', label: 'Resource load delay', duration: 300 },
  { subpart: 'elementRenderDelay', label: 'Element render delay', duration: 80 }
];

const psi = audits => JSON.stringify({
  lighthouseResult: {
    lighthouseVersion: '13.4.1',
    categories: { performance: { score: 0.72 } },
    audits: Object.assign({ 'largest-contentful-paint': { numericValue: 500.4 } }, audits)
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

const ofKind = (gas, kind) => (gas.$sheet(FINDINGS) || []).slice(1)
  .filter(row => String(row[COL.url] || '') !== '' && row[COL.kind] === kind);
const mobile = rows => rows.filter(row => row[COL.strategy] === 'mobile');

describe('#165: fazy z realnego kształtu', () => {
  test('1: trzy fazy dają trzy wiersze na próbę, z subpart i czasem trwania', () => {
    const rows = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY) }), 'FAZA LCP'));
    const proba1 = rows.filter(row => row[COL.attempt] === 1);
    assert.equal(proba1.length, 3);
    assert.deepEqual(proba1.map(row => row[COL.name]), ['ttfb', 'loadDelay', 'elementRenderDelay']);
    assert.deepEqual(proba1.map(row => row[COL.detail]),
      ['Time to first byte', 'Resource load delay', 'Element render delay']);
    assert.deepEqual(proba1.map(row => row[COL.timeMs]), [120, 300, 80], 'czas zaokrąglony do ms');
  });

  test('5: czas trwania to koszt, więc kolumny oszczędności zostają puste', () => {
    const rows = ofKind(run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY) }), 'FAZA LCP');
    rows.forEach(row => {
      assert.equal(row[COL.savingsMs], '', 'faza nie jest potencjalną oszczędnością');
      assert.equal(row[COL.savingsKb], '');
      assert.equal(row[COL.transferKb], '', 'ani transferem');
    });
  });

  test('6: fazy powstają z każdej udanej próby i łączą się z elementem po kolumnie Próba', () => {
    const gas = run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY) });
    const fazy = mobile(ofKind(gas, 'FAZA LCP'));
    const element = mobile(ofKind(gas, 'ELEMENT LCP'));

    assert.deepEqual([...new Set(fazy.map(row => row[COL.attempt]))].sort(), [1, 2, 3]);
    assert.equal(fazy.length, 9, 'trzy fazy razy trzy próby');
    assert.deepEqual(
      [...new Set(element.map(row => row[COL.attempt]))].sort(),
      [...new Set(fazy.map(row => row[COL.attempt]))].sort(),
      'ten sam zbiór prób po obu stronach — da się je zestawić'
    );
  });

  test('9: tabela faz rozpoznana niezależnie od kolejności względem węzła', () => {
    const przed = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY, false) }), 'FAZA LCP'));
    const po = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY, true) }), 'FAZA LCP'));
    assert.equal(przed.length, po.length);
    assert.deepEqual(przed.map(r => r[COL.name]), po.map(r => r[COL.name]));
  });
});

describe('#165: niezależność od liczby i nazw faz', () => {
  test('2: cztery fazy, w tym zasobowe, dają cztery wiersze', () => {
    const cztery = TRZY_FAZY.slice(0, 2)
      .concat([{ subpart: 'resourceLoadTime', label: 'Resource load duration', duration: 210 }])
      .concat(TRZY_FAZY.slice(2));
    const proba1 = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(cztery) }), 'FAZA LCP'))
      .filter(row => row[COL.attempt] === 1);
    assert.equal(proba1.length, 4, 'parser nie zna liczby faz z góry');
    assert.ok(proba1.map(r => r[COL.name]).indexOf('resourceLoadTime') >= 0);
  });

  test('3: faza o nazwie spoza znanych jest zapisana tak samo', () => {
    const nowa = [{ subpart: 'czegosTakiegoJeszczeNieBylo', label: 'Nowa faza', duration: 42 }];
    const proba1 = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(nowa) }), 'FAZA LCP'))
      .filter(row => row[COL.attempt] === 1);
    assert.equal(proba1.length, 1, 'brak whitelisty nazw');
    assert.equal(proba1[0][COL.name], 'czegosTakiegoJeszczeNieBylo');
  });

  test('4: wiersz bez kompletu subpart/label/duration jest pomijany', () => {
    const niepelne = [
      { subpart: 'ttfb', label: 'Time to first byte', duration: 100 },
      { subpart: 'brakLabel', duration: 50 },
      { label: 'Brak subpart', duration: 50 },
      { subpart: 'brakCzasu', label: 'Bez czasu' },
      { subpart: 'czasTekstem', label: 'Czas jako tekst', duration: '50' }
    ];
    const proba1 = mobile(ofKind(run({ 'lcp-breakdown-insight': rozklad(niepelne) }), 'FAZA LCP'))
      .filter(row => row[COL.attempt] === 1);
    assert.deepEqual(proba1.map(row => row[COL.name]), ['ttfb'], 'tylko komplet trafia do arkusza');
  });
});

describe('#165: granice', () => {
  test('7: fallback na wycofany audyt nie daje faz, ale element LCP nadal powstaje', () => {
    const legacy = { details: { items: [{ items: [{ node: { selector: 'main.legacy' } }] }] } };
    const gas = run({ 'largest-contentful-paint-element': legacy });
    assert.deepEqual(ofKind(gas, 'FAZA LCP'), [], 'stary audyt faz nie niesie — to nie błąd');
    const element = ofKind(gas, 'ELEMENT LCP');
    assert.ok(element.length > 0);
    assert.equal(element[0][COL.detail], 'main.legacy');
  });

  test('8: audyt z samym węzłem nie tworzy pustych wierszy faz', () => {
    const samWezel = { details: { type: 'list', items: [WEZEL] } };
    const gas = run({ 'lcp-breakdown-insight': samWezel });
    assert.deepEqual(ofKind(gas, 'FAZA LCP'), []);
    assert.equal(mobile(ofKind(gas, 'ELEMENT LCP'))[0][COL.detail], 'section.cc-hero');
  });

  test('10: suma faz bywa inna niż headline LCP i NIE jest to błąd', () => {
    // Lighthouse potrafi raportować fazy obserwowane obok symulowanego LCP,
    // więc równość byłaby fałszywym wymaganiem. Test dokumentuje relację.
    const gas = run({ 'lcp-breakdown-insight': rozklad(TRZY_FAZY) });
    const suma = mobile(ofKind(gas, 'FAZA LCP'))
      .filter(row => row[COL.attempt] === 1)
      .reduce((acc, row) => acc + Number(row[COL.timeMs]), 0);
    assert.equal(suma, 500, 'suma faz z tej próby');

    const lab = gas.$sheet('PAGESPEED LAB').slice(1)
      .filter(r => r[2] === 'mobile' && r[4] === 'LCP' && r[3] === 1);
    assert.equal(Math.round(Number(lab[0][5])), 500, 'headline LCP tej samej próby');
    // Zgodność w tym fixture jest przypadkiem konstrukcji, nie kontraktem API.
  });
});
