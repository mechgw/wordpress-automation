'use strict';

/**
 * #157: sonda kształtu odpowiedzi PageSpeed Insights.
 *
 * Sonda istnieje po to, żeby NIE zgadywać, po które identyfikatory audytów
 * wolno sięgać. Lighthouse wycofuje je po cichu — objawem jest brak wierszy
 * w arkuszu, nieodróżnialny od braku danych po stronie API.
 *
 * Najwięcej testów ma higiena klucza: raport bywa wklejany do publicznego
 * repozytorium, a komunikat błędu z API może zacytować adres żądania.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-sondy-testowy' };

const insight = (items, type = 'table') => ({
  scoreDisplayMode: 'informative',
  details: { type: type, items: items }
});

function project({ fetch, urls = [[URL, 'homepage', '']], properties = KEY } = {}) {
  return loadProject({
    properties: properties,
    sheets: { [URLS]: [URLS_HEADER].concat(urls) },
    fetch: fetch || (() => ({ code: 200, text: '{}' }))
  });
}

const psiBody = audits => JSON.stringify({
  lighthouseResult: { lighthouseVersion: '12.8.2', audits: audits }
});

describe('#157: kształt audytu', () => {
  test('obecny audyt raportuje tryb, typ, liczbę pozycji i nazwy pól', () => {
    const gas = project();
    const audits = {
      'lcp-breakdown-insight': insight([{ node: { selector: 'main' }, subpart: 'ttfb', duration: 120 }])
    };
    const out = gas.psiProbeAuditShape_(audits, 'lcp-breakdown-insight');
    assert.match(out, /JEST/);
    assert.match(out, /scoreDisplayMode=informative/);
    assert.match(out, /details\.type=table/);
    assert.match(out, /pozycji=1/);
    assert.match(out, /pola=node\/subpart\/duration/);
    assert.match(out, /węzeł=TAK/);
  });

  test('brakujący audyt mówi BRAK, a nie udaje pustego', () => {
    const gas = project();
    assert.equal(gas.psiProbeAuditShape_({}, 'third-party-summary'), 'third-party-summary: BRAK');
    assert.equal(gas.psiProbeAuditShape_(undefined, 'x'), 'x: BRAK');
  });

  test('audyt bez pozycji nie wywraca się na braku pierwszego elementu', () => {
    const gas = project();
    const out = gas.psiProbeAuditShape_({ a: insight([]) }, 'a');
    assert.match(out, /pozycji=0/);
    assert.match(out, /pola=brak pozycji/);
  });

  test('badamy oba identyfikatory z każdej pary: następcę i wycofany', () => {
    const gas = project();
    const lista = plain(gas.PSI_PROBE_AUDITS ? gas.PSI_PROBE_AUDITS : []);
    // Stała nie jest widoczna przez VM, więc sprawdzamy ją przez wynik sondy.
    const audits = { 'lcp-breakdown-insight': insight([{ node: {} }]) };
    const gas2 = project({ fetch: () => ({ code: 200, text: psiBody(audits) }) });
    const out = gas2.psiProbeStrategy_(URL, 'mobile', 'k');
    ['lcp-breakdown-insight', 'largest-contentful-paint-element',
      'third-parties-insight', 'third-party-summary'].forEach(id => {
      assert.ok(out.indexOf(id) >= 0, 'brak w raporcie: ' + id);
    });
    assert.match(out, /Lighthouse 12\.8\.2/);
    assert.equal(Array.isArray(lista), true);
  });

  test('odpowiedź bez lighthouseResult nie wywraca sondy', () => {
    const gas = project({ fetch: () => ({ code: 200, text: '{}' }) });
    const out = gas.psiProbeStrategy_(URL, 'mobile', 'k');
    assert.match(out, /wersja nieznana/);
    assert.match(out, /third-party-summary: BRAK/);
  });
});

describe('#157: higiena klucza API', () => {
  test('klucz jest wycinany z dowolnego tekstu', () => {
    const gas = project();
    assert.equal(gas.psiSanitizeKey_('...&key=abc123&strategy=mobile'), '...&key=***&strategy=mobile');
    // Liczy się usunięcie sekretu, nie zachowanie wielkości liter w nazwie parametru.
    const wielkie = gas.psiSanitizeKey_('KEY=abc');
    assert.ok(wielkie.indexOf('abc') < 0, 'sekret musi zniknąć także przy KEY=');
    assert.match(wielkie, /\*\*\*/);
    assert.equal(gas.psiSanitizeKey_(''), '');
    assert.equal(gas.psiSanitizeKey_(null), '');
  });

  test('raport nie zawiera klucza, nawet gdy API zacytuje adres żądania w błędzie', () => {
    // Realny przypadek: 400 z echem adresu. Gdyby nie czyszczenie, klucz
    // trafiłby do okna, a stamtąd do wklejki w issue.
    const gas = project({
      fetch: url => ({ code: 400, text: 'Bad Request for ' + url })
    });
    gas.zbadajKsztaltOdpowiedziPsi();
    const raport = gas.$alerts[0][0];
    assert.ok(raport.indexOf('klucz-sondy-testowy') < 0, 'klucz wyciekł do raportu');
    assert.match(raport, /key=\*\*\*/);
  });

  test('raport wymienia adres, wersję i obie strategie', () => {
    const gas = project({ fetch: () => ({ code: 200, text: psiBody({}) }) });
    gas.zbadajKsztaltOdpowiedziPsi();
    const raport = gas.$alerts[0][0];
    assert.match(raport, /PSI mobile/);
    assert.match(raport, /PSI desktop/);
    assert.ok(raport.indexOf(URL) >= 0);
  });
});

describe('#157: warunki uruchomienia', () => {
  test('brak adresów kończy się komunikatem, a nie wyjątkiem', () => {
    const gas = project({ urls: [] });
    assert.deepEqual(plain(gas.zbadajKsztaltOdpowiedziPsi()), []);
    assert.match(gas.$alerts[0][0], /Brak adresów/);
  });

  test('brak klucza tłumaczy, co utworzyć', () => {
    const gas = project({ properties: {} });
    assert.throws(() => gas.zbadajKsztaltOdpowiedziPsi(), /PAGESPEED_API_KEY/);
  });

  test('sonda bada pierwszy monitorowany adres', () => {
    const gas = project({
      urls: [['https://www.example.pl/a/', 'a', ''], ['https://www.example.pl/b/', 'b', '']],
      fetch: () => ({ code: 200, text: psiBody({}) })
    });
    gas.zbadajKsztaltOdpowiedziPsi();
    assert.match(gas.$alerts[0][0], /Adres: https:\/\/www\.example\.pl\/a\//);
  });
});

/**
 * #157/Codex: audyty `insights` bywają listami i wtedy pierwszy poziom niesie
 * samo opakowanie. Sonda musi zejść niżej, inaczej nie pokaże tego, po co jest.
 */
describe('#157: pozycje zagnieżdżone', () => {
  const lista = rows => ({
    scoreDisplayMode: 'informative',
    details: { type: 'list', items: [{ type: 'table', headings: [], items: rows }] }
  });

  test('pola z zagnieżdżonego wiersza są widoczne, nie samo opakowanie', () => {
    const gas = project();
    const out = gas.psiProbeAuditShape_(
      { 'third-parties-insight': lista([{ entity: 'Google', transferSize: 501000, mainThreadTime: 800 }]) },
      'third-parties-insight'
    );
    assert.match(out, /details\.type=list/);
    assert.match(out, /type\/headings\/items/, 'opakowanie nadal widoczne');
    assert.match(out, /> entity\/transferSize\/mainThreadTime/, 'i wiersz piętro niżej');
  });

  test('węzeł LCP ukryty w zagnieżdżeniu jest wykryty', () => {
    const gas = project();
    const out = gas.psiProbeAuditShape_(
      { 'lcp-breakdown-insight': lista([{ subpart: 'ttfb' }, { node: { selector: 'main' } }]) },
      'lcp-breakdown-insight'
    );
    assert.match(out, /węzeł=TAK/, 'węzeł w drugiej pozycji, nie w pierwszej');
  });

  test('brak węzła jest mówiony wprost, a zagnieżdżenie nie schodzi bez końca', () => {
    const gas = project();
    const gleboko = { a: { b: 1 } };
    const out = gas.psiProbeAuditShape_(
      { x: { details: { type: 'list', items: [{ items: [{ items: [{ items: [gleboko] }] }] }] } } },
      'x'
    );
    assert.match(out, /węzeł=nie/);
    assert.ok(out.length < 400, 'raport nie puchnie od zagnieżdżeń');
  });
});

/**
 * #157: flaga `węzeł=` przegapiła węzeł przy pierwszym uruchomieniu na produkcji.
 *
 * Lighthouse 13.4.1 kładzie go jako gołą pozycję opisaną `selector`/`nodeLabel`/
 * `snippet`, a heurystyka szukała pola o nazwie `node`. Flaga myliła się więc
 * dokładnie w przypadku, dla którego istnieje.
 */
describe('#157: flaga węzła wobec realnego kształtu 13.4.1', () => {
  const realnyLcp = {
    scoreDisplayMode: 'numeric',
    details: {
      type: 'list',
      items: [
        { type: 'table', headings: [], items: [{ duration: 120, label: 'TTFB', subpart: 'ttfb' }] },
        {
          snippet: '<section class="hero">', selector: 'section.hero', boundingRect: {},
          type: 'node', nodeLabel: 'Zamów kuriera', lhId: 'page-0-SECTION', path: '1,HTML'
        }
      ]
    }
  };

  test('goły węzeł jest wykryty, mimo braku pola o nazwie node', () => {
    const gas = project();
    const out = gas.psiProbeAuditShape_({ 'lcp-breakdown-insight': realnyLcp }, 'lcp-breakdown-insight');
    assert.match(out, /węzeł=TAK/, 'to jest przypadek, który flaga przegapiła na produkcji');
    assert.match(out, /snippet\/selector/, 'a nazwy pól nadal są wypisane obok flagi');
  });

  test('tabela faz bez węzła nadal daje „nie”', () => {
    const gas = project();
    const samefazy = {
      details: { type: 'list', items: [{ type: 'table', items: [{ duration: 1, label: 'a', subpart: 'b' }] }] }
    };
    assert.match(gas.psiProbeAuditShape_({ x: samefazy }, 'x'), /węzeł=nie/);
  });
});
