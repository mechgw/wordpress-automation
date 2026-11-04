'use strict';

/**
 * #286: spłata po metodach - mutanty Strykera w niezmienianych funkcjach `Kod.gs`.
 *
 * Stryker (pilotaż #234) pokazał zbiegłe mutanty w menu, `apiRequest_`, `getConfig_`,
 * `gscKlLayout_`, `gscKlPatterns_`, `importRange_` i drobnych pomocnikach: teksty
 * etykiet i handlerów, granice kodów HTTP, wartości domyślne konfiguracji, stronicowanie
 * zapytań, teksty ostrzeżeń. Testy sprawdzają dokładne wartości.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const CFG = 'Konfiguracja GSC';
const RAW = 'GSC RAW';
const HEADER = ['date', 'query', 'page', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'downloaded'];

function konfiguracja(extra = {}) {
  const wartosci = Object.assign({ siteUrl: 'https://www.example.pl/', daysBack: 3, dailyLagDays: 2, rowLimit: 100, searchType: 'web' }, extra);
  const rows = [['Klucz', 'Wartość']].concat(Object.keys(wartosci).map(k => [k, wartosci[k]]));
  while (rows.length < 8) rows.push(['', '']);
  rows.push(['status', '']);
  return { [CFG]: rows };
}
const projekt = (opcje = {}) => loadProject(Object.assign({ sheets: Object.assign(konfiguracja(), { [RAW]: { rows: [HEADER] } }) }, opcje));
const etapy = () => {
  const msgs = [];
  const stage = m => msgs.push(m);
  stage.msgs = msgs;
  return stage;
};

describe('#286: menu', () => {
  const MENU = [
    ['Sprawdź połączenie', 'testPolaczenia'],
    ['Importuj ostatni zakres', 'importOstatniZakres'],
    ['Importuj dzień', 'importDzienny'],
    ['Włącz codzienny import', 'ustawAutomatycznyImport'],
    ['Sprawdź indeksowanie (URL INSPEKCJA)', 'sprawdzIndeksowanie'],
    ['Włącz cotygodniową inspekcję URL', 'ustawTygodniowaInspekcje'],
    ['Sprawdź strony live (SEO LIVE)', 'sprawdzStronyLive'],
    ['Włącz codzienny live check SEO', 'ustawCodziennyLiveCheck'],
    ['Przygotuj reguły schema (SEO SCHEMA)', 'przygotujRegulySchema'],
    ['Sprawdź sitemapy (SITEMAPY)', 'sprawdzSitemapy'],
    ['Odśwież adresy z sitemap (SITEMAP URLS)', 'odswiezMonitoringZSitemap'],
    ['Włącz cotygodniowe odświeżanie z sitemap', 'ustawTygodnioweOdswiezanieSitemap'],
    ['Kolejka recrawl (RECRAWL QUEUE)', 'kolejkaRecrawl'],
    ['Włącz codzienną kolejkę recrawl', 'ustawCodziennaKolejkeRecrawl'],
    ['Przygotuj Business Profile', 'przygotujBusinessProfile'],
    ['Importuj Business Profile', 'importujBusinessProfile'],
    ['Włącz codzienny import Business Profile', 'ustawCodziennyImportBusinessProfile'],
    ['Przygotuj pomiar wydajności', 'przygotujPomiarWydajnosci'],
    ['Zmierz wydajność (CrUX + PSI)', 'zmierzWydajnosc'],
    ['Włącz cykliczny pomiar wydajności', 'ustawCyklicznyPomiarWydajnosci'],
    ['Wyłącz cykliczny pomiar wydajności', 'usunCyklicznyPomiarWydajnosci'],
    ['Zbadaj kształt odpowiedzi PSI', 'zbadajKsztaltOdpowiedziPsi']
  ];

  test('menu "SEO / GSC": dokładne etykiety i handlery w kolejności', () => {
    const gas = projekt();

    gas.onOpen();

    const menu = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(plain(menu.items.map(i => [i.label, i.fn])), MENU);
  });

  test('każdy handler menu istnieje jako funkcja projektu', () => {
    const gas = projekt();

    gas.onOpen();

    const menu = gas.$menus.find(m => m.title === 'SEO / GSC');
    menu.items.forEach(i => assert.equal(typeof gas[i.fn], 'function', i.fn));
  });

  test('menu wersji: tytuł z tagu i jedna pozycja "Szczegóły wdrożenia"', () => {
    const gas = projekt();

    gas.addVersionMenu_();

    const menu = gas.$menus[gas.$menus.length - 1];
    assert.equal(menu.title, gas.versionLabel_());
    assert.deepEqual(plain(menu.items), [{ label: 'Szczegóły wdrożenia', fn: 'showDeployedVersion' }]);
  });
});

describe('#286: formatowanie dat i strefa', () => {
  test('formatujDate_ i formatujDateCzas_ przekazują strefę i wzorzec do usługi', () => {
    const gas = projekt();
    const wywolania = [];
    const oryginal = gas.Utilities.formatDate;
    gas.Utilities.formatDate = (date, tz, wzorzec) => { wywolania.push([tz, wzorzec]); return oryginal(date, tz, wzorzec); };
    const data = new gas.$Date(2026, 9, 5, 14, 30);

    assert.equal(gas.formatujDate_(data), '2026-10-05');
    assert.equal(gas.formatujDateCzas_(data), '2026-10-05 14:30');

    assert.deepEqual(wywolania, [['Europe/Warsaw', 'yyyy-MM-dd'], ['Europe/Warsaw', 'yyyy-MM-dd HH:mm']]);
  });

  test('dayDiff_ liczy dni kalendarzowe przez granicę miesiąca', () => {
    const gas = projekt();

    assert.equal(gas.dayDiff_('2026-02-28', '2026-03-01'), 1);
    assert.equal(gas.dayDiff_('2026-01-31', '2026-02-02'), 2);
    assert.equal(gas.dayDiff_('2026-10-05', '2026-10-05'), 0);
  });

  test('dailyGscRange_: luka w limicie daje zakres od dnia po ostatnim i pusty warning', () => {
    const gas = projekt();

    assert.deepEqual(plain(gas.dailyGscRange_('2026-10-10', '2026-10-08')), { from: '2026-10-09', to: '2026-10-10', warning: '' });
    assert.deepEqual(plain(gas.dailyGscRange_('2026-10-10', '')), { from: '2026-10-10', to: '2026-10-10', warning: '' });
  });
});

describe('#286: apiRequest_', () => {
  function zOdpowiedzia(kod, tekst) {
    const gas = projekt();
    const wywolania = [];
    gas.UrlFetchApp.fetch = (url, opcje) => {
      wywolania.push([url, opcje]);
      return { getResponseCode: () => kod, getContentText: () => tekst };
    };
    return { gas, wywolania };
  }

  test('żądanie bez ładunku: metoda, wyciszone wyjątki HTTP, token; bez contentType i payload', () => {
    const { gas, wywolania } = zOdpowiedzia(200, '{"a":1}');

    const out = plain(gas.apiRequest_('https://api.example/x', 'get'));

    assert.deepEqual(out, { a: 1 });
    const [url, opcje] = wywolania[0];
    assert.equal(url, 'https://api.example/x');
    assert.equal(opcje.method, 'get');
    assert.equal(opcje.muteHttpExceptions, true);
    assert.deepEqual(plain(opcje.headers), { Authorization: 'Bearer test-token' });
    assert.equal('contentType' in opcje, false);
    assert.equal('payload' in opcje, false);
  });

  test('żądanie z ładunkiem: application/json i JSON', () => {
    const { gas, wywolania } = zOdpowiedzia(200, '{}');

    gas.apiRequest_('https://api.example/x', 'post', { q: 1 });

    const opcje = wywolania[0][1];
    assert.equal(opcje.contentType, 'application/json');
    assert.equal(opcje.payload, '{"q":1}');
  });

  test('granice kodów: 199 i 300 to błąd z kodem i treścią, 200 i 299 to sukces', () => {
    assert.throws(() => zOdpowiedzia(199, 'x').gas.apiRequest_('u', 'get'), /^Error: Search Console API HTTP 199:\nx$/);
    assert.throws(() => zOdpowiedzia(300, 'treść').gas.apiRequest_('u', 'get'), /^Error: Search Console API HTTP 300:\ntreść$/);
    assert.deepEqual(plain(zOdpowiedzia(200, '{"ok":true}').gas.apiRequest_('u', 'get')), { ok: true });
    assert.deepEqual(plain(zOdpowiedzia(299, '{"ok":true}').gas.apiRequest_('u', 'get')), { ok: true });
  });

  test('pusta odpowiedź to pusty obiekt', () => {
    assert.deepEqual(plain(zOdpowiedzia(204, '').gas.apiRequest_('u', 'get')), {});
  });
});

describe('#286: getConfig_', () => {
  test('wartości z arkusza: adres przycięty, liczby jako liczby, limit wiersza obcięty do 25000', () => {
    const gas = loadProject({ sheets: konfiguracja({ siteUrl: '  https://x.example/  ', daysBack: '7', dailyLagDays: '1', rowLimit: 30000, searchType: 'news' }) });

    assert.deepEqual(plain(gas.getConfig_()), { siteUrl: 'https://x.example/', daysBack: 7, dailyLagDays: 1, rowLimit: 25000, searchType: 'news' });
  });

  test('wartości domyślne: 30 dni, opóźnienie 3, limit 25000, typ web', () => {
    const rows = [['Klucz', 'Wartość'], ['siteUrl', 'https://x.example/'], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['status', '']];
    const gas = loadProject({ sheets: { [CFG]: rows } });

    assert.deepEqual(plain(gas.getConfig_()), { siteUrl: 'https://x.example/', daysBack: 30, dailyLagDays: 3, rowLimit: 25000, searchType: 'web' });
  });

  test('limit wiersza poniżej 25000 zostaje', () => {
    const gas = loadProject({ sheets: konfiguracja({ rowLimit: 100 }) });

    assert.equal(gas.getConfig_().rowLimit, 100);
  });
});

describe('#286: kotwice K-L', () => {
  const FK = '=ARRAYFORMULA(IF(A2:A="",,G2:G*I2:I))';
  const FL = '=ARRAYFORMULA(IF(A2:A="",,A2:A*1))';
  /** Arkusz-atrapa: formuły K-L w wierszach 1.. i wartość A2. */
  function arkusz({ formuly, wartosci, a2 = '' }) {
    return {
      getLastRow: () => formuly.length,
      getRange: (r, c, rows, cols) => (cols === 2
        ? { getFormulas: () => formuly, getValues: () => wartosci || formuly.map(() => ['', '']) }
        : { getValue: () => a2 })
    };
  }
  const zWzorcem = gas => { gas.$properties.GSC_KL_ANCHOR_FORMULAS = JSON.stringify({ K: FK, L: FL }); };

  test('brak formuł: obie kolumny z problemem "brak formuły", kotwice puste, dokładne ostrzeżenie', () => {
    const gas = projekt();
    const out = plain(gas.gscKlLayout_(arkusz({ formuly: [['', ''], ['', '']] }), '2026-10-02', '2026-10-02'));

    assert.equal(out.ok, false);
    assert.deepEqual(out.anchors, { K: '', L: '' });
    assert.equal(out.warning, 'K–L: zapis całej zakładki, bo K: brak formuły, kotwica: brak formuły; L: brak formuły, kotwica: brak formuły');
  });

  test('tylko K ma formułę: kotwica K pełny tekst, L pusta', () => {
    const gas = projekt();
    zWzorcem(gas);
    const out = plain(gas.gscKlLayout_(arkusz({ formuly: [[FK, ''], ['', '']], wartosci: [[1, ''], ['', '']] }), '2026-10-02', '2026-10-02'));

    assert.deepEqual(out.anchors, { K: FK, L: '' });
    assert.equal(out.ok, false);
  });

  test('zatwierdzony układ i A2 poza zakresem: ok, puste ostrzeżenie, kotwice z tekstem', () => {
    const gas = projekt();
    zWzorcem(gas);
    const sheet = arkusz({ formuly: [['', ''], [FK, FL]], wartosci: [['', ''], [1, 2]], a2: '2026-09-01' });

    const out = plain(gas.gscKlLayout_(sheet, '2026-10-02', '2026-10-02'));

    assert.equal(out.ok, true);
    assert.equal(out.warning, '');
    assert.deepEqual(out.anchors, { K: FK, L: FL });
  });

  test('kotwica w wierszu 2 i A2 w importowanym zakresie: odmowa z datą', () => {
    const gas = projekt();
    zWzorcem(gas);
    const sheet = arkusz({ formuly: [['', ''], [FK, FL]], wartosci: [['', ''], [1, 2]], a2: '2026-10-02' });

    const out = plain(gas.gscKlLayout_(sheet, '2026-10-02', '2026-10-03'));

    assert.equal(out.ok, false);
    assert.equal(out.warning, 'K–L: zapis całej zakładki, bo kotwica w wierszu 2, a wiersz 2 należy do importowanego zakresu (2026-10-02)');
  });

  test('kotwica w wierszu 2 i pusta A2: ok', () => {
    const gas = projekt();
    zWzorcem(gas);
    const sheet = arkusz({ formuly: [['', ''], [FK, FL]], wartosci: [['', ''], [1, 2]], a2: '' });

    assert.equal(gas.gscKlLayout_(sheet, '2026-10-02', '2026-10-02').ok, true);
  });

  test('kotwica w wierszu 1: wiersz 2 nie jest sprawdzany', () => {
    const gas = projekt();
    zWzorcem(gas);
    const sheet = arkusz({ formuly: [[FK, FL], ['', '']], wartosci: [[1, 2], ['', '']], a2: '2026-10-02' });

    assert.equal(gas.gscKlLayout_(sheet, '2026-10-02', '2026-10-02').ok, true);
  });

  test('gscKlPatterns_: tylko obiekt JSON jest wzorcem; brak, błąd składni i inne typy to null', () => {
    const gas = projekt();
    const wzorce = wartosc => { gas.$properties.GSC_KL_ANCHOR_FORMULAS = wartosc; return gas.gscKlPatterns_(); };

    assert.equal(wzorce(''), null);
    assert.equal(wzorce('{niepoprawny'), null);
    assert.equal(wzorce('5'), null);
    assert.equal(wzorce('"napis"'), null);
    assert.equal(wzorce('true'), null);
    assert.equal(wzorce('null'), null);
    assert.equal(wzorce('0'), null);
    assert.deepEqual(plain(wzorce('{"K":"a","L":"b"}')), { K: 'a', L: 'b' });
    delete gas.$properties.GSC_KL_ANCHOR_FORMULAS;
    assert.equal(gas.gscKlPatterns_(), null);
  });
});

describe('#286: importRange_', () => {
  /** API GSC: kolejne odpowiedzi z listy `strony` (tablice wierszy), potem puste. */
  function api(strony) {
    let n = 0;
    return () => ({ code: 200, json: n < strony.length ? { rows: strony[n++] } : {} });
  }
  const wiersz = (data, extra = {}) => Object.assign({ keys: [data, 'fraza', '/s', 'pol', 'MOBILE'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }, extra);
  const payloady = gas => gas.$fetchCalls.map(c => JSON.parse(c.params.payload));

  test('żądanie: metoda, adres, wymiary, dataState, typ i limit; stronicowanie zwiększa startRow o limit', () => {
    const gas = projekt({ sheets: Object.assign(konfiguracja({ rowLimit: 2 }), { [RAW]: { rows: [HEADER] } }), fetch: api([[wiersz('2026-10-01'), wiersz('2026-10-01')], [wiersz('2026-10-01')]]) });
    const stage = etapy();

    const out = plain(gas.importRange_('2026-10-01', '2026-10-01', { stage }));

    assert.equal(out.rows, 3);
    assert.equal(gas.$fetchCalls.length, 2);
    assert.equal(gas.$fetchCalls[0].url, 'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.pl%2F/searchAnalytics/query');
    assert.equal(gas.$fetchCalls[0].params.method, 'post');
    assert.deepEqual(payloady(gas), [
      { startDate: '2026-10-01', endDate: '2026-10-01', dimensions: ['date', 'query', 'page', 'country', 'device'], type: 'web', dataState: 'final', rowLimit: 2, startRow: 0 },
      { startDate: '2026-10-01', endDate: '2026-10-01', dimensions: ['date', 'query', 'page', 'country', 'device'], type: 'web', dataState: 'final', rowLimit: 2, startRow: 2 }
    ]);
    assert.ok(stage.msgs.includes('zapytania API (3 wierszy)'), stage.msgs.join(' | '));
  });

  test('strona o dokładnie limicie wierszy wymusza kolejne zapytanie; krótsza kończy', () => {
    const gas = projekt({ sheets: Object.assign(konfiguracja({ rowLimit: 2 }), { [RAW]: { rows: [HEADER] } }), fetch: api([[wiersz('2026-10-01'), wiersz('2026-10-01')], []]) });

    gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy() });

    assert.equal(gas.$fetchCalls.length, 2);
  });

  test('odpowiedź bez wierszy: zero wierszy w wyniku i w arkuszu', () => {
    const gas = projekt({ fetch: () => ({ code: 200, json: {} }) });

    const out = plain(gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy() }));

    assert.equal(out.rows, 0);
    assert.equal(out.detail, '0 wierszy (2026-10-01 – 2026-10-01)');
    assert.equal(gas.$sheet(RAW).length, 1, 'tylko nagłówek');
  });

  test('wiersz bez kluczy i bez metryk: puste napisy i zera, nie wartości zastępcze', () => {
    const gas = projekt({ fetch: api([[{}]]) });

    gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy() });

    const zapisany = gas.$sheet(RAW)[1].slice(0, 9);
    assert.deepEqual(plain(zapisany), ['', '', '', '', '', 0, 0, 0, 0]);
  });

  test('wiersz z częścią kluczy: brakujące klucze to puste napisy', () => {
    const gas = projekt({ fetch: api([[{ keys: ['2026-10-01', 'fraza'], clicks: 2 }]]) });

    gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy() });

    assert.deepEqual(plain(gas.$sheet(RAW)[1].slice(0, 6)), ['2026-10-01', 'fraza', '', '', '', 2]);
  });

  test('bez opcji stage: licznik etapów z prefiksem "[import GSC]" w logu wykonania', () => {
    const gas = projekt({ fetch: api([[wiersz('2026-10-01')]]) });

    gas.importRange_('2026-10-01', '2026-10-01');

    assert.ok(gas.$console.some(([, t]) => t.startsWith('[import GSC] zapytania API (1 wierszy): ')), gas.$console.map(([, t]) => t).join('\n'));
  });

  test('etap "rozpoznanie K–L" tylko w imporcie dziennym', () => {
    const gas = projekt({ fetch: api([[wiersz('2026-10-01')], [wiersz('2026-10-01')]]) });
    const bezDziennego = etapy();
    const dzienny = etapy();

    gas.importRange_('2026-10-01', '2026-10-01', { stage: bezDziennego });
    gas.importRange_('2026-10-01', '2026-10-01', { stage: dzienny, daily: true });

    assert.equal(bezDziennego.msgs.some(m => m === 'rozpoznanie K–L'), false);
    assert.equal(dzienny.msgs.some(m => m === 'rozpoznanie K–L'), true);
  });

  test('ostrzeżenia łączone separatorem " | ", puste pomijane', () => {
    const gas = projekt({ fetch: api([[wiersz('2026-10-01')]]) });

    const bez = plain(gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy() }));
    const z = plain(gas.importRange_('2026-10-01', '2026-10-01', { stage: etapy(), warning: 'moje', daily: true }));

    assert.equal(bez.warning, '');
    const czesci = z.warning.split(' | ');
    assert.equal(czesci[0], 'moje');
    assert.ok(czesci.length >= 2 && czesci.every(Boolean), z.warning);
    assert.match(czesci[czesci.length - 1], /^K–L: zapis całej zakładki, bo K: brak formuły/);
  });
});

describe('#286: testPolaczenia', () => {
  test('brak właściwości: status "BRAK WŁAŚCIWOŚCI" i brak zapisu wierszy właściwości', () => {
    const gas = projekt({ fetch: () => ({ code: 200, json: { siteEntry: [] } }) });

    gas.testPolaczenia();

    assert.equal(gas.$cell(CFG, 'B8'), 'POŁĄCZENIE OK – BRAK WŁAŚCIWOŚCI');
    assert.equal(gas.$events.filter(e => e[0] === 'setValues' && e[2] === 2 && e[3] === 5).length, 0, 'bez zapisu do kolumny E');
  });

  test('są właściwości: status "POŁĄCZENIE OK" i lista w E-F', () => {
    const gas = projekt({ fetch: () => ({ code: 200, json: { siteEntry: [{ siteUrl: 'sc-domain:x.pl', permissionLevel: 'siteOwner' }] } }) });

    gas.testPolaczenia();

    assert.equal(gas.$cell(CFG, 'B8'), 'POŁĄCZENIE OK');
    assert.equal(gas.$cell(CFG, 'E2'), 'sc-domain:x.pl');
    assert.equal(gas.$cell(CFG, 'F2'), 'siteOwner');
  });
});
