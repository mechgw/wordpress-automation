'use strict';

/**
 * #140: ustalenia diagnostyczne PageSpeed w arkuszu.
 *
 * Kolektor z #124 zapisywał osiem liczb i wyrzucał całą diagnozę z tej samej
 * odpowiedzi. Numeracja testów odpowiada macierzy z opisu #140.
 *
 * Dwie rzeczy mają tu najwięcej testów, bo oba błędy są ciche:
 *   1. koszt third-party nie może trafić do kolumn oszczędności — arkusz
 *      kłamałby semantycznie;
 *   2. udany pomiar musi zastąpić CAŁY zakres (URL, strategia), bo zwykły upsert
 *      zostawiłby nieistniejące już szanse jako bieżącą diagnozę.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const FINDINGS = 'PAGESPEED FINDINGS';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const FINDINGS_HEADER = [
  'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół',
  'Czas (ms)', 'Transfer (KiB)', 'Potencjalna oszczędność (ms)', 'Potencjalna oszczędność (KiB)',
  'Źródło', 'Pobrano', 'Wyzwolenie'
];

const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };

// Kolumny arkusza, żeby asercje nie operowały na gołych indeksach.
const COL = {
  url: 1, strategy: 2, attempt: 3, kind: 4, name: 5, detail: 6,
  timeMs: 7, transferKb: 8, savingsMs: 9, savingsKb: 10
};

const metrics = () => ({
  'largest-contentful-paint': { numericValue: 2500 },
  'cumulative-layout-shift': { numericValue: 0.02 },
  'total-blocking-time': { numericValue: 120 },
  'first-contentful-paint': { numericValue: 900 },
  'speed-index': { numericValue: 1800 },
  'server-response-time': { numericValue: 210 },
  'total-byte-weight': { numericValue: 1500000 }
});

const opportunity = (ms, bytes, title = 'Szansa') => ({
  title: title,
  details: { type: 'opportunity', overallSavingsMs: ms, overallSavingsBytes: bytes }
});

const lcpAudit = node => ({ details: { items: [{ items: [{ node: node }] }] } });

const psi = (extra = {}) => ({
  lighthouseResult: {
    categories: { performance: { score: 0.87 } },
    audits: Object.assign(metrics(), extra)
  }
});

function project({ audits = {}, sheets = {}, fetch } = {}) {
  const responses = typeof audits === 'function' ? audits : () => psi(audits);
  return loadProject({
    properties: KEY,
    sheets: Object.assign({ [URLS]: [URLS_HEADER, [URL, 'homepage', '']] }, sheets),
    fetch: fetch || (url => (String(url).indexOf('pagespeedonline') >= 0
      ? { code: 200, text: JSON.stringify(responses()) }
      : { code: 404, text: '{}' }))
  });
}

/** Wiersze ustaleń bez nagłówka i bez pustych. */
const findings = gas => gas.$sheet(FINDINGS).slice(1).filter(row => String(row[COL.url] || '') !== '');
const ofKind = (gas, kind) => findings(gas).filter(row => row[COL.kind] === kind);

describe('#140: element LCP', () => {
  // #153 zmieniło kontrakt obu poniższych: element LCP bywa różny między próbami,
  // więc jest zapisywany z KAŻDEJ udanej próby, a jego brak dostaje własny wiersz.
  test('1 (#153): audyt z użytecznym węzłem daje wiersz na każdą udaną próbę', () => {
    const gas = project({
      audits: { 'largest-contentful-paint-element': lcpAudit({ selector: 'section.cc-hero', snippet: '<section>' }) }
    });
    gas.zmierzWydajnosc();
    const rows = ofKind(gas, 'ELEMENT LCP');
    assert.equal(rows.length, 6, 'trzy próby na mobile i trzy na desktop');
    assert.deepEqual(
      [...new Set(rows.map(row => row[COL.attempt]))].sort(),
      [1, 2, 3],
      'każda próba ma własny wiersz, żadna nie ginie'
    );
    assert.equal(rows[0][COL.detail], 'section.cc-hero', 'selektor ma pierwszeństwo przed fragmentem');
    assert.equal(rows[0][COL.savingsMs], '', 'element LCP to nie oszczędność');
    assert.equal(rows[0][COL.timeMs], '', 'ani koszt');
  });

  test('2 (#153): brak węzła jest ustaleniem i dostaje wiersz z adnotacją, nie ciszę', () => {
    for (const audits of [{}, { 'largest-contentful-paint-element': {} },
      { 'largest-contentful-paint-element': lcpAudit({}) },
      { 'largest-contentful-paint-element': { details: { items: [] } } }]) {
      const gas = project({ audits });
      gas.zmierzWydajnosc();
      const rows = ofKind(gas, 'ELEMENT LCP');
      assert.equal(rows.length, 6, JSON.stringify(audits));
      rows.forEach(row => assert.match(
        String(row[COL.detail]),
        /nie wskazał elementu LCP/,
        'cisza znaczyłaby trzy różne rzeczy naraz'
      ));
    }
  });

  test('węzeł bez selektora schodzi do etykiety, a potem do fragmentu HTML', () => {
    const gas = project({ audits: { 'largest-contentful-paint-element': lcpAudit({ nodeLabel: 'Zamów kuriera' }) } });
    gas.zmierzWydajnosc();
    assert.equal(ofKind(gas, 'ELEMENT LCP')[0][COL.detail], 'Zamów kuriera');

    const snippet = project({ audits: { 'largest-contentful-paint-element': lcpAudit({ snippet: '<p class="cc-lead">' }) } });
    snippet.zmierzWydajnosc();
    assert.equal(ofKind(snippet, 'ELEMENT LCP')[0][COL.detail], '<p class="cc-lead">');
  });
});

describe('#140: szanse', () => {
  test('3: szansa z ms i bajtami wypełnia oba pola oszczędności, a nie pola kosztu', () => {
    const gas = project({ audits: { 'uses-optimized-images': opportunity(2270, 507 * 1024, 'Ulepsz dostarczanie obrazów') } });
    gas.zmierzWydajnosc();
    const row = ofKind(gas, 'SZANSA')[0];
    assert.equal(row[COL.name], 'uses-optimized-images');
    assert.equal(row[COL.detail], 'Ulepsz dostarczanie obrazów');
    assert.equal(row[COL.savingsMs], 2270);
    assert.equal(row[COL.savingsKb], 507);
    assert.equal(row[COL.timeMs], '', 'szansa nie jest kosztem');
    assert.equal(row[COL.transferKb], '');
  });

  test('4: przy sześciu kwalifikujących się zapisujemy pięć, w kolejności oszczędności', () => {
    const audits = {};
    [600, 100, 500, 200, 400, 300].forEach((ms, i) => { audits['szansa-' + i] = opportunity(ms, 0); });
    const gas = project({ audits });
    gas.zmierzWydajnosc();
    const rows = ofKind(gas, 'SZANSA').filter(row => row[COL.strategy] === 'mobile');
    assert.equal(rows.length, 5, 'limit pięciu na parę URL/strategia');
    assert.deepEqual(rows.map(row => row[COL.savingsMs]), [600, 500, 400, 300, 200]);
  });

  test('5: pozycja poniżej obu progów jest pomijana', () => {
    const gas = project({ audits: { 'drobiazg': opportunity(30, 5 * 1024) } });
    gas.zmierzWydajnosc();
    assert.deepEqual(ofKind(gas, 'SZANSA'), [], '30 ms i 5 KiB nie zmieniają niczego');

    // Wystarczy jeden próg: sam transfer albo sam czas.
    const bytesOnly = project({ audits: { 'duzy-plik': opportunity(0, 25 * 1024) } });
    bytesOnly.zmierzWydajnosc();
    assert.equal(ofKind(bytesOnly, 'SZANSA').length, 2);

    const msOnly = project({ audits: { 'wolny': opportunity(60, 0) } });
    msOnly.zmierzWydajnosc();
    assert.equal(ofKind(msOnly, 'SZANSA').length, 2);
  });

  test('6: remis w milisekundach rozstrzyga większa oszczędność w bajtach', () => {
    const gas = project({
      audits: {
        'a-mniejsza': opportunity(500, 10 * 1024),
        'b-wieksza': opportunity(500, 900 * 1024)
      }
    });
    gas.zmierzWydajnosc();
    const rows = ofKind(gas, 'SZANSA').filter(row => row[COL.strategy] === 'mobile');
    assert.deepEqual(rows.map(row => row[COL.name]), ['b-wieksza', 'a-mniejsza']);
  });

  test('audyt bez `details.type = opportunity` nie jest szansą', () => {
    const gas = project({ audits: { 'diagnostyka': { title: 'X', details: { type: 'table', overallSavingsMs: 5000 } } } });
    gas.zmierzWydajnosc();
    assert.deepEqual(ofKind(gas, 'SZANSA'), []);
  });
});

describe('#140: koszt third-party', () => {
  test('7: transfer i czas trafiają do kolumn kosztu, a kolumny oszczędności zostają puste', () => {
    const gas = project({
      audits: {
        'third-party-summary': {
          details: {
            items: [
              { entity: 'Google Tag Manager', transferSize: 489 * 1024, mainThreadTime: 543 },
              { entity: { type: 'link', text: 'Google Analytics' }, transferSize: 1024, mainThreadTime: 2 }
            ]
          }
        }
      }
    });
    gas.zmierzWydajnosc();
    const rows = ofKind(gas, 'THIRD-PARTY').filter(row => row[COL.strategy] === 'mobile');
    assert.deepEqual(rows.map(row => row[COL.name]), ['Google Tag Manager', 'Google Analytics']);
    assert.equal(rows[0][COL.transferKb], 489);
    assert.equal(rows[0][COL.timeMs], 543);
    assert.equal(rows[0][COL.savingsMs], '', 'koszt to nie oszczędność');
    assert.equal(rows[0][COL.savingsKb], '', 'to jest sedno #140');
  });

  test('podmiot bez nazwy albo bez żadnej liczby jest pomijany', () => {
    const gas = project({
      audits: {
        'third-party-summary': {
          details: {
            items: [
              { entity: '', transferSize: 100, mainThreadTime: 10 },
              { entity: 'Pusty', transferSize: 0, mainThreadTime: 0 }
            ]
          }
        }
      }
    });
    gas.zmierzWydajnosc();
    assert.deepEqual(ofKind(gas, 'THIRD-PARTY'), []);
  });
});

describe('#140: wybór próby i model snapshotu', () => {
  test('8 (#153): przy próbach 1 i 2 udanych element LCP jest z obu, a szanse z próby 2', () => {
    let call = 0;
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        call++;
        // Trzecia próba każdej strategii pada; Lighthouse robi to losowo.
        if (call % 3 === 0) return { code: 500, text: 'lighthouseError' };
        return {
          code: 200,
          text: JSON.stringify(psi({
            'largest-contentful-paint-element': lcpAudit({ selector: 'main' }),
            'uses-optimized-images': opportunity(2270, 0)
          }))
        };
      }
    });
    gas.zmierzWydajnosc();

    const rows = ofKind(gas, 'ELEMENT LCP');
    assert.equal(rows.length, 4, 'dwie udane próby razy dwie strategie');
    assert.deepEqual([...new Set(rows.map(row => row[COL.attempt]))].sort(), [1, 2],
      'element LCP z każdej udanej próby; trzecia padła, więc jej nie ma');

    const szanse = ofKind(gas, 'SZANSA');
    assert.equal(szanse.length, 2, 'szansa nadal raz na strategię');
    szanse.forEach(row => assert.equal(row[COL.attempt], 2, 'ostatnia UDANA, nie ostatnia w kolejności'));
  });

  test('9: udany pomiar usuwa ustalenie, którego nie ma już w odpowiedzi', () => {
    const stale = [
      '2026-09-01 10:00', URL, 'mobile', 1, 'SZANSA', 'stara-szansa', 'Nieaktualna',
      '', '', 900, '', 'PSI_LAB', '2026-09-01'
    ];
    const gas = project({
      audits: { 'nowa-szansa': opportunity(500, 0) },
      sheets: { [FINDINGS]: [FINDINGS_HEADER, stale] }
    });
    gas.zmierzWydajnosc();
    const names = findings(gas).map(row => row[COL.name]);
    assert.ok(!names.includes('stara-szansa'), 'zakres (URL, strategia) zastąpiony w całości');
    assert.ok(names.includes('nowa-szansa'));
  });

  test('9a: zakres spoza pomiaru zostaje nietknięty', () => {
    const other = [
      '2026-09-01 10:00', 'https://www.example.pl/inna/', 'mobile', 1, 'SZANSA', 'obca', 'Inny adres',
      '', '', 700, '', 'PSI_LAB', '2026-09-01'
    ];
    const gas = project({
      audits: { 'nowa-szansa': opportunity(500, 0) },
      sheets: { [FINDINGS]: [FINDINGS_HEADER, other] }
    });
    gas.zmierzWydajnosc();
    assert.ok(findings(gas).some(row => row[COL.name] === 'obca'), 'nie ruszamy cudzego zakresu');
  });

  test('10: pomiar nieudany w całości nie kasuje poprzedniej diagnozy', () => {
    const previous = [
      '2026-09-01 10:00', URL, 'mobile', 1, 'ELEMENT LCP', 'largest-contentful-paint-element', 'section.hero',
      '', '', '', '', 'PSI_LAB', '2026-09-01'
    ];
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']], [FINDINGS]: [FINDINGS_HEADER, previous] },
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 500, text: 'lighthouseError' }
        : { code: 404, text: '{}' })
    });
    gas.zmierzWydajnosc();
    const rows = findings(gas);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][COL.detail], 'section.hero', 'ostatnia dobra diagnoza zostaje');
  });
});

describe('#140: granice danych', () => {
  test('11: fragment dłuższy niż limit komórki jest przycięty z jawnym znacznikiem', () => {
    const snippet = 'x'.repeat(gasCellLimit() + 500);
    const gas = project({ audits: { 'largest-contentful-paint-element': lcpAudit({ snippet: snippet }) } });
    gas.zmierzWydajnosc();
    const detail = String(ofKind(gas, 'ELEMENT LCP')[0][COL.detail]);
    assert.ok(detail.length <= gasCellLimit(), 'mieści się w komórce');
    assert.match(detail, /OBCIĘTO/, 'przycięcie nigdy po cichu');
  });

  test('12: odpowiedź bez sekcji audits nie wywraca przebiegu', () => {
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 200, text: '{}' }
        : { code: 404, text: '{}' })
    });
    assert.doesNotThrow(() => gas.zmierzWydajnosc());
    // #153: pusta odpowiedź to nadal udana próba, więc powstaje wiersz z adnotacją
    // o braku węzła. Nie ma za to ani szans, ani third-party — nie było z czego.
    const rows = findings(gas);
    assert.deepEqual([...new Set(rows.map(row => row[COL.kind]))], ['ELEMENT LCP']);
    rows.forEach(row => assert.match(String(row[COL.detail]), /nie wskazał elementu LCP/));
  });

  test('arkusz i podsumowanie mówią o ustaleniach', () => {
    const gas = project({ audits: { 'uses-optimized-images': opportunity(2270, 0) } });
    gas.przygotujPomiarWydajnosci();
    assert.ok(gas.$sheet(FINDINGS), 'arkusz zakładany razem z pozostałymi');
    assert.deepEqual(gas.$sheet(FINDINGS)[0], FINDINGS_HEADER);

    const result = gas.zmierzWydajnosc();
    assert.equal(result.lab.findings, findings(gas).length);
    assert.match(gas.$alerts.join('\n'), /Ustalenia diagnostyczne: \d+/);
  });
});

/** Limit znaków w komórce; ten sam, którego pilnuje `cellSafeText_`. */
function gasCellLimit() {
  return require('./helpers/gas').CELL_CHAR_LIMIT;
}

/**
 * #153: element LCP z każdej udanej próby.
 *
 * Produkcja pokazała rozkład dwutrybowy — w jednym trybie element był
 * raportowany, w drugim nie było go wcale. Zapis z jednej próby opisywał wtedy
 * jedno losowanie i nic w arkuszu nie mówiło, które.
 */
describe('#153: element LCP per próba', () => {
  const attemptFetch = responses => {
    let call = 0;
    return url => {
      if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
      const r = responses[call % responses.length];
      call++;
      return r;
    };
  };

  test('2: różne elementy w kolejnych próbach — trzy wiersze, żaden nie ginie', () => {
    const selektory = ['section.hero', 'h1.tytul', 'img.banner'];
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
      fetch: attemptFetch(selektory.map(sel => ({
        code: 200,
        text: JSON.stringify(psi({ 'largest-contentful-paint-element': lcpAudit({ selector: sel }) }))
      })))
    });
    gas.zmierzWydajnosc();

    const mobile = ofKind(gas, 'ELEMENT LCP').filter(row => row[COL.strategy] === 'mobile');
    assert.equal(mobile.length, 3, 'po jednym wierszu na próbę');
    assert.deepEqual(mobile.map(row => row[COL.detail]), selektory, 'każdy tryb widoczny osobno');
  });

  test('4: jedna udana próba z trzech daje jeden wiersz i mówi, która to była', () => {
    let call = 0;
    const gas = loadProject({
      properties: KEY,
      sheets: { [URLS]: [URLS_HEADER, [URL, 'homepage', '']] },
      fetch: url => {
        if (String(url).indexOf('pagespeedonline') < 0) return { code: 404, text: '{}' };
        call++;
        // Udaje się wyłącznie trzecia próba każdej strategii.
        if (call % 3 !== 0) return { code: 500, text: 'lighthouseError' };
        return { code: 200, text: JSON.stringify(psi({ 'largest-contentful-paint-element': lcpAudit({ selector: 'main' }) })) };
      }
    });
    gas.zmierzWydajnosc();

    const rows = ofKind(gas, 'ELEMENT LCP');
    assert.equal(rows.length, 2, 'jedna udana próba na strategię');
    rows.forEach(row => assert.equal(row[COL.attempt], 3, 'numer próby wskazuje, z której pochodzi'));
  });

  test('5: zero udanych prób nie rusza poprzedniej diagnozy', () => {
    const stara = [
      '2026-09-01 10:00', URL, 'mobile', 2, 'ELEMENT LCP', 'largest-contentful-paint-element',
      'section.stary-hero', '', '', '', '', 'PSI_LAB', '2026-09-01'
    ];
    const gas = loadProject({
      properties: KEY,
      sheets: {
        [URLS]: [URLS_HEADER, [URL, 'homepage', '']],
        [FINDINGS]: [FINDINGS_HEADER, stara]
      },
      fetch: url => (String(url).indexOf('pagespeedonline') >= 0
        ? { code: 500, text: 'lighthouseError' }
        : { code: 404, text: '{}' })
    });
    gas.zmierzWydajnosc();

    assert.deepEqual(
      findings(gas).map(row => row[COL.detail]),
      ['section.stary-hero'],
      'nieudany przebieg nie kasuje ostatniej dobrej diagnozy'
    );
  });
});
