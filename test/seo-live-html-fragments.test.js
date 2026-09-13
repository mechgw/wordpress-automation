'use strict';

/**
 * #154: SEO LIVE — oczekiwane i zakazane fragmenty HTML per URL.
 *
 * Najczęstsza regresja w praktyce to nie zmiana title, tylko powrót ustawienia
 * wtyczki, który zostawia w HTML charakterystyczny ślad. Dwie opcjonalne kolumny
 * pozwalają go pilnować bez pisania kodu na każdą taką wtyczkę z osobna.
 *
 * Najwięcej testów dotyczy nie samego dopasowania, tylko UPGRADE'U ISTNIEJĄCEGO
 * ARKUSZA: nowe kolumny idą na koniec, za `Indeks Google`, a stary kontrakt
 * kończył się na `L`, więc skrypt nie ma prawa zakładać, że `M`/`N` należą
 * do niego. Przejęcie cudzej kolumny — nawet bez nadpisania wartości — zamieniłoby
 * czyjeś notatki w konfigurację kontroli i wygenerowało fałszywe regresje.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SHEET = 'SEO LIVE';
const COMMANDS = 'WP COMMANDS';
const COMMANDS_HEADER = ['id', 'created_at', 'action', 'target', 'field', 'value', 'confirm', 'status', 'http', 'message', 'result_ref', 'done_at', 'note'];
/** Układ sprzed #154: kontrakt kończył się na kolumnie `L`. */
const HEADER_OLD = [
  'URL', 'Oczekiwany status HTTP', 'Oczekiwany URL docelowy', 'Oczekiwany title', 'Oczekiwany H1',
  'Oczekiwany canonical', 'Oczekiwane robots', 'Oczekiwane schema (@type)', 'Wynik (live)',
  'Różnice', 'Sprawdzono', 'Indeks Google (URL INSPEKCJA)'
];
const HEADER = HEADER_OLD.concat(['Oczekiwane w HTML', 'Zakazane w HTML']);
const COL = { result: 8, diffs: 9, checked: 10, index: 11, required: 12, forbidden: 13 };

const URL = 'https://www.example.pl/a/';
const OTHER = 'https://www.example.pl/b/';
/** Ślad ustawienia, które potrafi wrócić samo — powód powstania tej funkcji. */
const MARKER = '<script id="cache-guest" data-mode="full"></script>';

const page = (extra = '') => '<!doctype html><html><head><title>Strona A</title>' +
  '<meta name="robots" content="index, follow">' + extra +
  '</head><body><h1>Strona A</h1><p>treść</p></body></html>';

const wiersz = (url, extra = {}) => [
  url, extra.status ?? '', extra.target ?? '', extra.title ?? '', extra.h1 ?? '', extra.canonical ?? '',
  extra.robots ?? '', extra.schema ?? '', extra.result ?? '', extra.diffs ?? '', extra.checked ?? '',
  extra.index ?? '', extra.required ?? '', extra.forbidden ?? ''
];

function project({ rows = [wiersz(URL)], header = HEADER, sheet, html = page(), routes, properties, commands } = {}) {
  const sheets = {};
  sheets[SHEET] = sheet || [header].concat(rows);
  if (commands) sheets[COMMANDS] = [COMMANDS_HEADER].concat(commands);
  return loadProject({
    properties: properties || {},
    sheets: sheets,
    fetch: url => {
      // Po prefiksie, nie po równości: REST WordPressa dokleja `?context=edit&_fields=…`,
      // a fixture dopasowany ściśle cicho wpadłby w gałąź 404 i test przestałby cokolwiek dowodzić.
      const route = Object.keys(routes || {}).filter(key => String(url).indexOf(key) === 0)[0];
      if (route) return routes[route];
      if (String(url).indexOf('/wp-json/') > 0) return { code: 404, text: '{}' };
      return { code: 200, text: html, headers: { 'Content-Type': 'text/html' } };
    }
  });
}

const wynik = (gas, i = 1) => String(gas.$sheet(SHEET)[i][COL.result]);
const roznice = (gas, i = 1) => String(gas.$sheet(SHEET)[i][COL.diffs]);
const naglowek = gas => plain(gas.$sheet(SHEET)[0]).slice(0, HEADER.length);

describe('#154: dopasowanie fragmentów', () => {
  test('1: obie kolumny puste → żadnej nowej kontroli', () => {
    const gas = project();
    const out = plain(gas.sprawdzStronyLive());
    assert.equal(out.ok, 1);
    assert.equal(roznice(gas), '');
  });

  test('2: oczekiwany fragment obecny → OK', () => {
    const gas = project({ rows: [wiersz(URL, { required: MARKER })], html: page(MARKER) });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 1);
  });

  test('3: jednego z dwóch oczekiwanych brak → regresja wskazująca brakujący', () => {
    const gas = project({
      rows: [wiersz(URL, { required: '<title>Strona A</title>\n' + MARKER })],
      html: page()
    });
    assert.equal(plain(gas.sprawdzStronyLive()).warnings, 1);
    assert.match(roznice(gas), /brak oczekiwanego fragmentu HTML: „<script id="cache-guest"/);
    assert.ok(roznice(gas).indexOf('<title>') < 0, 'obecny fragment nie jest zgłaszany');
  });

  test('4: zakazany fragment nieobecny → OK', () => {
    const gas = project({ rows: [wiersz(URL, { forbidden: MARKER })], html: page() });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 1);
  });

  test('5: zakazany fragment obecny → regresja wskazująca znaleziony', () => {
    const gas = project({ rows: [wiersz(URL, { forbidden: MARKER })], html: page(MARKER) });
    assert.equal(plain(gas.sprawdzStronyLive()).warnings, 1);
    assert.match(roznice(gas), /zakazany fragment HTML obecny/);
  });

  test('6: inne białe znaki po obu stronach → dopasowanie po normalizacji', () => {
    const wHtml = '<script   id="cache-guest"\n      data-mode="full"></script>';
    const gas = project({
      rows: [wiersz(URL, { required: '<script id="cache-guest" data-mode="full"></script>' })],
      html: page(wHtml)
    });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 1, 'łamanie wiersza w HTML nie psuje dopasowania');
  });

  test('7: fragment z „|” jest jednym fragmentem, bez escapowania', () => {
    const skrypt = '<script>var x = a || b;</script>';
    const gas = project({ rows: [wiersz(URL, { required: skrypt })], html: page(skrypt) });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 1);

    const brak = project({ rows: [wiersz(URL, { required: skrypt })], html: page() });
    assert.equal(plain(brak.sprawdzStronyLive()).warnings, 1);
    assert.match(roznice(brak), /a \|\| b/, 'całość została jednym fragmentem, nie dwoma');
  });

  test('8: puste linie i spacje na końcach linii nie tworzą pustych oczekiwań', () => {
    const gas = project({
      rows: [wiersz(URL, { required: '\n   ' + MARKER + '   \n\n' })],
      html: page(MARKER)
    });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 1, 'pusta linia nie jest fragmentem pasującym do wszystkiego');
  });

  test('9: lista ponad limit komórki → jawny błąd tego URL-a, reszta przebiegu bez zmian', () => {
    const gas = project({
      rows: [wiersz(URL, { required: 'x'.repeat(50001) }), wiersz(OTHER, { forbidden: MARKER })]
    });
    const out = plain(gas.sprawdzStronyLive());
    assert.equal(out.errors, 1);
    assert.equal(wynik(gas, 1), 'BŁĄD');
    assert.match(roznice(gas, 1), /limit komórki to 50000/);
    assert.equal(wynik(gas, 2), 'OK', 'drugi adres sprawdzony normalnie');
  });

  test('10: zgodny title nie maskuje zakazanego znacznika', () => {
    const gas = project({
      rows: [wiersz(URL, { title: 'Strona A', forbidden: MARKER })],
      html: page(MARKER)
    });
    assert.equal(plain(gas.sprawdzStronyLive()).ok, 0);
    assert.match(wynik(gas), /^UWAGA/);
  });
});

describe('#154: upgrade istniejącego arkusza', () => {
  test('11: stary układ z realnymi I–L → nic nie przesunięte, wyniki dalej w I–L', () => {
    const stary = [HEADER_OLD, [
      URL, '', '', 'Inny title', '', '', '', '',
      'UWAGA: 1 różnic(e)', 'title: „Strona A” (oczekiwano „Inny title”)', '2026-09-01 09:00', 'INDEXED'
    ]];
    const gas = project({ sheet: stary });
    gas.sprawdzStronyLive();

    assert.deepEqual(naglowek(gas), HEADER, 'etykiety M1/N1 dopisane, reszta nietknięta');
    assert.match(wynik(gas), /^UWAGA/, 'wynik nadal ląduje w kolumnie I');
    assert.match(roznice(gas), /^title: /, 'oczekiwanie z kolumny D nadal czytane jako title');
    assert.ok(roznice(gas).indexOf('fragment') < 0, 'stare I–L nie zostały odczytane jako nowe kontrole');
  });

  test('12: drugi przebieg nie dopisuje ani nie nadpisuje etykiet', () => {
    const gas = project({ sheet: [HEADER_OLD, [URL, '', '', '', '', '', '', '', '', '', '', '']] });
    gas.sprawdzStronyLive();
    const poPierwszym = naglowek(gas);
    gas.sprawdzStronyLive();

    assert.deepEqual(naglowek(gas), poPierwszym);
    assert.deepEqual(naglowek(gas), HEADER);
    assert.equal(gas.$sheet(SHEET)[0].length, HEADER.length, 'żadna kolumna nie doszła po raz drugi');
  });

  test('12a: własna wartość operatora w M1 → konflikt, komórka nietknięta', () => {
    const gas = project({
      sheet: [HEADER_OLD.concat(['Moje notatki']), [URL].concat(new Array(11).fill('')).concat(['uwaga'])]
    });
    assert.throws(() => gas.runSeoLiveCheck_(), /Niezgodny nagłówek zakładki „SEO LIVE”.*kolumna 13/s);
    assert.equal(gas.$sheet(SHEET)[0][COL.required], 'Moje notatki', 'cudza etykieta nienaruszona');
    assert.equal(gas.$sheet(SHEET)[1][COL.required], 'uwaga');
  });

  test('12b: M1 puste, ale M2 ma wartość operatora → konflikt, nic nietknięte', () => {
    const gas = project({
      sheet: [HEADER_OLD, [URL].concat(new Array(11).fill('')).concat(['prywatna notatka'])]
    });
    assert.throws(() => gas.runSeoLiveCheck_(), /nagłówek pusty, ale pod nim są dane/);
    assert.equal(gas.$sheet(SHEET)[0][COL.required] ?? '', '', 'etykieta nie została wpisana');
    assert.equal(gas.$sheet(SHEET)[1][COL.required], 'prywatna notatka', 'wartość nie stała się konfiguracją');
  });

  test('12c: M wolna, N zajęta poniżej nagłówka → konflikt wykryty przed zapisem M1', () => {
    const gas = project({
      sheet: [HEADER_OLD, [URL].concat(new Array(11).fill('')).concat(['', 'cudza wartość'])]
    });
    assert.throws(() => gas.runSeoLiveCheck_(), /kolumna 14/);
    assert.equal(gas.$sheet(SHEET)[0][COL.required] ?? '', '', 'M1 nie została przejęta w połowie operacji');
    assert.equal(gas.$sheet(SHEET)[0][COL.forbidden] ?? '', '');
  });

  test('12d: formuła zwracająca pusty tekst to nie jest pusta kolumna', () => {
    const gas = loadProject({
      properties: {},
      sheets: {
        [SHEET]: {
          rows: [HEADER_OLD, [URL].concat(new Array(11).fill('')).concat([''])],
          formulas: [[], new Array(12).fill('').concat(['=IF(A2="";"";"x")'])]
        }
      },
      fetch: () => ({ code: 200, text: page(), headers: { 'Content-Type': 'text/html' } })
    });
    assert.throws(() => gas.runSeoLiveCheck_(), /nagłówek pusty, ale pod nim są dane/);
    assert.equal(gas.$sheet(SHEET)[0][COL.required] ?? '', '', 'kolumna z formułą nie została przejęta');
  });

  test('13: arkusz zakładany od zera dostaje pełny, czternastokolumnowy nagłówek', () => {
    const gas = project({ sheet: [] });
    gas.sprawdzStronyLive();
    assert.deepEqual(naglowek(gas), HEADER);
  });

  test('arkusz przycięty do dwunastu kolumn dostaje miejsce na nowe', () => {
    const gas = loadProject({
      properties: {},
      sheets: {
        [SHEET]: {
          rows: [HEADER_OLD, [URL].concat(new Array(11).fill(''))],
          maxColumns: 12
        }
      },
      fetch: () => ({ code: 200, text: page(), headers: { 'Content-Type': 'text/html' } })
    });
    gas.runSeoLiveCheck_();
    assert.deepEqual(naglowek(gas), HEADER, 'siatka rozszerzona zamiast wyjątku o zakresie');
  });
});

describe('#154: nowe kontrole poza wyciszaniem z #130', () => {
  const PROPS = { WP_BASE_URL: 'https://www.example.pl', WP_USERNAME: 'bot', WP_APP_PASSWORD: 'pw', WP_REST_NAMESPACE: 'acme' };
  const polecenie = () => [
    'CMD-1', new Date(Date.now() - 2 * 3600000), 'UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots',
    'noindex', 'YES', 'PENDING', '', '', '', '', ''
  ];
  const fixture = extra => project(Object.assign({
    rows: [wiersz(URL, Object.assign({ robots: 'noindex' }, extra))],
    properties: PROPS,
    commands: [polecenie()],
    routes: { 'https://www.example.pl/wp-json/wp/v2/pages/7': { code: 200, text: JSON.stringify({ id: 7, link: URL }) } }
  }));

  test('fixture naprawdę wycisza: sama różnica w robots daje PENDING CHANGE', () => {
    const gas = fixture({});
    gas.sprawdzStronyLive();
    assert.match(wynik(gas), /^PENDING CHANGE/, 'bez tego test 14 nie dowodziłby niczego');
  });

  test('14: zakazany fragment obok pokrytej różnicy → alert NIE jest wyciszany', () => {
    const gas = project({
      rows: [wiersz(URL, { robots: 'noindex', forbidden: MARKER })],
      properties: PROPS,
      commands: [polecenie()],
      html: page(MARKER),
      routes: { 'https://www.example.pl/wp-json/wp/v2/pages/7': { code: 200, text: JSON.stringify({ id: 7, link: URL }) } }
    });
    const out = plain(gas.sprawdzStronyLive());
    assert.match(wynik(gas), /^UWAGA/, 'dla fragmentu HTML nie ma deterministycznego polecenia, więc to regresja');
    assert.equal(out.pending, 0);
    assert.match(roznice(gas), /zakazany fragment HTML obecny/);
    assert.match(roznice(gas), /robots: /, 'pokryta różnica nadal jest opisana');
  });
});
