'use strict';

/**
 * #180: detektor anomalii importu liczy ZAKRESY DANYCH, nie runy (etap 1),
 * a GA4 porównuje dni robocze i weekend z osobnymi bazami (etap 2, wariant 6A);
 * zero wierszy alarmuje bez rozgrzewki, a zamknięcie incydentu anomalii nie
 * udaje, że import „ponownie działa”.
 *
 * 14 i 15.09.2026 GA4 dostało alarm „mało danych: 13 wierszy vs mediana 27”,
 * choć import działał. 09.09 ten sam dzień danych zaimportowano dwa razy
 * w odstępie 31 s i oba wpisy weszły do mediany — bez tego duplikatu żaden
 * z dwóch alarmów by nie powstał. `IMPORT LOG` nie zapisywał, jaki zakres
 * danych pobrał run, więc nie dało się tego rozróżnić.
 *
 * Numeracja odpowiada macierzy z opisu #180; przypadek 12 (zakres
 * pobranego dnia w importach GA4 i GSC) jest w testach end-to-end `status.test.js`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const GA4_SHEET = 'Konfiguracja GA4';
const LOG = 'IMPORT LOG';
const HEADER_9 = ['Czas', 'Źródło', 'Typ', 'Dni', 'Wynik', 'Wiersze', 'Czas [s]', 'Szczegóły', 'Błąd / uwaga'];
const HEADER = HEADER_9.concat(['Zakres danych']);

function baseSheets(log) {
  return {
    [GSC_SHEET]: [['k', 'v'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']],
    [GA4_SHEET]: [['k', 'v'], ['propertyId', 'properties/111'], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['', ''], ['status', '']],
    [LOG]: log
  };
}

/** Wiersz historii z zakresem: n godzin temu, profil GA4 trigger 1 dzień. */
const wiersz = (godzinTemu, rows, zakres, opcje = {}) => [
  new Date(Date.now() - godzinTemu * 3600000), opcje.source || 'GA4', opcje.type || 'trigger', opcje.days || 1,
  'OK', rows, 3, '', '', zakres || ''
];
const dzien = d => '2026-09-' + String(d).padStart(2, '0') + '..2026-09-' + String(d).padStart(2, '0');
const anomalia = (gas, key = 'LAST_IMPORT_GA4') => JSON.parse(gas.$properties[key]).lastRun.anomaly;
const importuj = (gas, rows, d, source = 'GA4') => gas.recordImportRun_(source, true, () => ({
  rows, days: 1, dataFrom: '2026-09-' + String(d).padStart(2, '0'), dataTo: '2026-09-' + String(d).padStart(2, '0')
}));

describe('#180: baza porównawcza liczy zakresy danych, nie runy', () => {
  test('1: dwa runy tego samego zakresu to jedna próbka — najnowsza', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER]) });
    const probki = gas.importAnomalySamples_('GA4', { trigger: true, days: 1, dataFrom: '2026-09-20', dataTo: '2026-09-20', finishedAt: new Date().toISOString() }, [
      { at: new Date(Date.now() - 3 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 27, rangeKey: dzien(7) },
      { at: new Date(Date.now() - 2 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 30, rangeKey: dzien(7) },
      { at: new Date(Date.now() - 1 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 32, rangeKey: dzien(8) }
    ]);
    assert.deepEqual(plain(probki).map(p => p.rows), [30, 32], 'z dwóch importów 07.09 został nowszy');
  });

  test('2: wiersze sprzed zmiany, bez zakresu, liczą się każdy osobno', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER]) });
    const probki = gas.importAnomalySamples_('GA4', { trigger: true, days: 1, finishedAt: new Date().toISOString() }, [
      { at: new Date(Date.now() - 2 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 27, rangeKey: '' },
      { at: new Date(Date.now() - 1 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 27, rangeKey: '' }
    ]);
    assert.equal(probki.length, 2, 'bez zakresu nie ma podstaw do deduplikacji');
  });

  test('3: bieżący run powtarza zakres z historii — próbki tego zakresu wykluczone', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER]) });
    const probki = gas.importAnomalySamples_('GA4', { trigger: true, days: 1, dataFrom: '2026-09-12', dataTo: '2026-09-12', finishedAt: new Date().toISOString() }, [
      { at: new Date(Date.now() - 2 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 13, rangeKey: dzien(12) },
      { at: new Date(Date.now() - 1 * 3600000), source: 'GA4', trigger: true, days: 1, ok: true, rows: 25, rangeKey: dzien(11) }
    ]);
    assert.deepEqual(plain(probki).map(p => p.rows), [25], 'bieżący run nie porównuje się sam ze sobą');
  });

  test('4: liczby z 14.09 odtworzone z zakresami — mediana 25, 13 wierszy bez alarmu', () => {
    // Tabela z opisu #180: run → pobrany dzień → wiersze; 09.09 dwa razy ten sam dzień.
    // Na profilu GSC, który zostaje przy jednej bazie: GA4 jednodniowe ma od etapu 2
    // bazy klasowe (6A), więc na nim ten test sprawdzałby już co innego niż deduplikację.
    const g = { source: 'GSC' };
    const historia = [
      wiersz(170, 10, dzien(5), g), wiersz(146, 8, dzien(6), g),
      wiersz(122, 27, dzien(7), g), wiersz(121.99, 27, dzien(7), g),
      wiersz(98, 32, dzien(8), g), wiersz(74, 31, dzien(9), g), wiersz(50, 15, dzien(10), g), wiersz(26, 25, dzien(11), g)
    ];
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 13, 12, 'GSC');

    assert.equal(anomalia(gas, 'LAST_IMPORT_GSC'), undefined, 'z duplikatem mediana 27 i próg 13,5 dawały fałszywy alarm');
  });

  test('4b: ta sama historia bez zakresów (jak przed zmianą) nadal daje alarm — test umie paść', () => {
    const historia = [10, 8, 27, 27, 32, 31, 15, 25].map((rows, i) => wiersz(170 - i * 20, rows, '', { source: 'GSC' }));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 13, 12, 'GSC');

    assert.equal(anomalia(gas, 'LAST_IMPORT_GSC'), 'mało danych: 13 wierszy vs mediana 27');
  });

  test('13: profile trigger / ręczny i różne `days` nadal osobne — regresja', () => {
    const historia = Array.from({ length: 7 }, (_, i) => wiersz(100 - i, 300, dzien(i + 1), { type: 'ręczny' }))
      .concat(Array.from({ length: 7 }, (_, i) => wiersz(50 - i, 300, dzien(i + 1), { days: 3 })));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 10, 20);

    assert.equal(anomalia(gas), undefined, 'profil trigger/1 dzień nie ma jeszcze żadnej próbki');
  });
});

describe('#180: zero wierszy alarmuje bez rozgrzewki', () => {
  test('5: 0 wierszy przy dwóch wcześniejszych próbkach, jedna > 0 → alarm (wcześniej go nie było)', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER, wiersz(50, 0, dzien(10)), wiersz(26, 12, dzien(11))]) });
    importuj(gas, 0, 12);

    assert.equal(anomalia(gas), 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 12)');
  });

  test('6: 0 wierszy, a wszystkie wcześniejsze próbki też 0 albo brak historii → brak alarmu', () => {
    const zera = loadProject({ sheets: baseSheets([HEADER, wiersz(50, 0, dzien(10)), wiersz(26, 0, dzien(11))]) });
    importuj(zera, 0, 12);
    assert.equal(anomalia(zera), undefined, 'źródło bez danych to nie spadek');

    const pusto = loadProject({ sheets: baseSheets([HEADER]) });
    importuj(pusto, 0, 12);
    assert.equal(anomalia(pusto), undefined, 'nowa instalacja');
  });

  test('6b: jedyna próbka z danymi to ten sam zakres co bieżący → brak alarmu', () => {
    // Ponowny import dnia, który wcześniej dał dane, a teraz daje zero, nie ma z czym się porównać:
    // bieżący zakres jest z bazy wykluczony.
    const gas = loadProject({ sheets: baseSheets([HEADER, wiersz(26, 12, dzien(12))]) });
    importuj(gas, 0, 12);
    assert.equal(anomalia(gas), undefined);
  });

  test('7: 0 wierszy po rozgrzewce → alarm z medianą, jak dotąd (regresja)', () => {
    const historia = Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 300, dzien(i + 1), { source: 'GSC' }));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 0, 20, 'GSC');

    assert.equal(anomalia(gas, 'LAST_IMPORT_GSC'), 'mało danych: 0 wierszy vs mediana 300');
  });

  test('7b: 0 wierszy po rozgrzewce, mediana 0, ale starsza próbka miała dane → alarm bez mediany', () => {
    const g = { source: 'GSC' };
    const historia = [wiersz(200, 40, dzien(1), g)].concat(Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 0, dzien(i + 2), g)));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 0, 20, 'GSC');

    assert.equal(anomalia(gas, 'LAST_IMPORT_GSC'), 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 40)',
      '„vs mediana 0” byłoby bez sensu, a milczenie przeczyłoby regule');
  });
});

describe('#180: zamknięcie incydentu zależy od powodu', () => {
  const MAIL = { ALERT_EMAIL: 'alerty@example.pl' };

  test('8: zamknięcie anomalii importu — „Dane wróciły do normy”', () => {
    const historia = Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 300, dzien(i + 1)));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)), properties: MAIL });
    importuj(gas, 0, 20);
    importuj(gas, 300, 21);

    assert.deepEqual(gas.$mails.map(m => m.subject), [
      '[wordpress-automation] UWAGA, mało danych: Google Analytics 4 (GA4)',
      '[wordpress-automation] Dane wróciły do normy: Google Analytics 4 (GA4)'
    ]);
  });

  test('9: zamknięcie błędu importu i zadania — tematy bez zmian (regresja)', () => {
    const imp = loadProject({ sheets: baseSheets([HEADER]), properties: MAIL });
    assert.throws(() => imp.recordImportRun_('GSC', true, () => { throw new Error('HTTP 500'); }));
    imp.recordImportRun_('GSC', true, () => ({ rows: 5, days: 1 }));
    assert.equal(imp.$mails.slice(-1)[0].subject, '[wordpress-automation] Import ponownie działa: Search Console (GSC)');

    const job = loadProject({ sheets: baseSheets([HEADER]), properties: MAIL });
    assert.throws(() => job.recordJobRun_('SEO_LIVE', true, () => { throw new Error('boom'); }));
    job.recordJobRun_('SEO_LIVE', true, () => ({ rows: 1 }));
    assert.equal(job.$mails.slice(-1)[0].subject, '[wordpress-automation] Zadanie ponownie działa: live check SEO');
  });
});

describe('#180: kolumna `Zakres danych` w istniejącej zakładce', () => {
  test('10: zakładka z 9 kolumnami — J1 dostaje etykietę, A–I nietknięte, nowy wiersz ma zakres', () => {
    const stary = wiersz(26, 25, '').slice(0, 9);
    const gas = loadProject({ sheets: baseSheets([HEADER_9, stary]) });
    const przed = gas.$sheet(LOG).map(r => r.slice(0, 9));
    importuj(gas, 30, 12);

    const log = gas.$sheet(LOG);
    assert.equal(log[0][9], 'Zakres danych');
    assert.deepEqual(log.slice(0, 2).map(r => r.slice(0, 9)), przed, 'kolumny A–I bez zmian');
    assert.equal(log[2][9], '2026-09-12..2026-09-12');
  });

  test('11: J1 z cudzą treścią — wiersz bez zakresu, bez wyjątku, import udany; cudza kolumna nie jest zakresem', () => {
    const cudzy = HEADER_9.concat(['Notatki']);
    const historia = Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 300, 'moja notatka'));
    const gas = loadProject({ sheets: baseSheets([cudzy].concat(historia)) });
    importuj(gas, 300, 12);

    const log = gas.$sheet(LOG);
    assert.equal(log[0][9], 'Notatki', 'cudza etykieta nietknięta');
    assert.equal(log.slice(-1)[0].length, 9, 'wiersz bez zakresu');
    assert.equal(JSON.parse(gas.$properties.LAST_IMPORT_GA4).lastRun.ok, true);
    // Siedem wierszy z tą samą „notatką” byłoby jedną próbką, gdyby cudza kolumna udawała zakres.
    assert.equal(gas.importLogHistory_().filter(h => h.rangeKey).length, 0);
  });

  test('11a: cudza etykieta J1 nad PUSTĄ kolumną — nie jest nadpisywana', () => {
    // Bez tego przypadku etykietę użytkownika chronił tylko warunek „kolumna niepusta”:
    // nad pustą kolumną `Notatki` zamieniłoby się po cichu na `Zakres danych`.
    const gas = loadProject({ sheets: baseSheets([HEADER_9.concat(['Notatki']), wiersz(26, 25, '').slice(0, 9)]) });
    importuj(gas, 30, 12);

    assert.equal(gas.$sheet(LOG)[0][9], 'Notatki');
    assert.equal(gas.$sheet(LOG).slice(-1)[0].length, 9, 'wiersz bez zakresu');
  });

  test('11b: pusta J1, ale cudze wartości pod nią — też bez zakresu i bez etykiety', () => {
    const wiersze = [wiersz(26, 25, 'coś ręcznie')];
    const gas = loadProject({ sheets: baseSheets([HEADER_9].concat(wiersze)) });
    importuj(gas, 30, 12);

    assert.equal(gas.$sheet(LOG)[0][9], undefined, 'etykieta nie powstała');
    assert.equal(gas.$sheet(LOG).slice(-1)[0].length, 9);
  });

  test('11c: zakładka przycięta do 9 kolumn — bez zakresu i bez wyjątku z getRange', () => {
    const gas = loadProject({ sheets: Object.assign(baseSheets(null), { [LOG]: { rows: [HEADER_9], maxColumns: 9 } }) });
    importuj(gas, 30, 12);

    assert.equal(gas.$sheet(LOG).slice(-1)[0].length, 9);
    assert.equal(JSON.parse(gas.$properties.LAST_IMPORT_GA4).lastRun.ok, true, 'logowanie nie zamienia importu w błąd');
  });
});

describe('#180 etap 2 (6A): osobne bazy dni roboczych i weekendu dla GA4', () => {
  // Liczby z testu kompletności 19.09.2026 (komentarz w #180): wiersze GA4 na dzień
  // danych, 05–17.09. Weekend 8–13, dni robocze 15–38.
  const LICZBY = { 5: 10, 6: 8, 7: 27, 8: 26, 9: 31, 10: 15, 11: 25, 12: 13, 13: 13, 14: 34, 15: 26, 16: 38, 17: 27 };
  const historia = (source = 'GA4') => Object.keys(LICZBY).map(Number)
    .map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d), { source }));

  test('14: klasa z daty DANYCH, nie z daty uruchomienia — niezależnie od strefy', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER]) });
    // Import z poniedziałku 14.09 pobiera sobotę 12.09: liczy się sobota.
    assert.equal(gas.importDataClass_('2026-09-12..2026-09-12'), 'weekend');
    assert.equal(gas.importDataClass_('2026-09-13..2026-09-13'), 'weekend');
    assert.equal(gas.importDataClass_('2026-09-14..2026-09-14'), 'roboczy');
    assert.equal(gas.importDataClass_('2026-09-11..2026-09-11'), 'roboczy', 'piątek');
    assert.equal(gas.importDataClass_(''), '', 'bez zakresu nie ma klasy');
  });

  test('15: sobota z 10 wierszami, baza weekendowa ~11 → brak alarmu (jedna baza dawała alarm)', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia())) });
    importuj(gas, 10, 19);
    assert.equal(anomalia(gas), undefined, 'mediana weekendu z 10, 8, 13, 13 to 11,5 — próg 5,75');

    // Kontrola: te same liczby w GSC (jedna baza) dają alarm — test umie paść.
    const gsc = loadProject({ sheets: baseSheets([HEADER].concat(historia('GSC'))) });
    importuj(gsc, 10, 19, 'GSC');
    assert.equal(anomalia(gsc, 'LAST_IMPORT_GSC'), 'mało danych: 10 wierszy vs mediana 26');
  });

  test('15b: weekend z kompletem 4 próbek alarmuje przy spadku poniżej połowy mediany weekendu', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia())) });
    importuj(gas, 2, 19);
    assert.equal(anomalia(gas), 'mało danych: 2 wierszy vs mediana 11.5 (weekend)', 'okno weekendu to dokładnie 4 próbki');
  });

  test('16: dzień roboczy z 10 wierszami, baza robocza ~27 → alarm z nazwą klasy', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia())) });
    importuj(gas, 10, 18);
    assert.equal(anomalia(gas), 'mało danych: 10 wierszy vs mediana 27 (dni robocze)',
      'pięć ostatnich dni roboczych: 25, 34, 26, 38, 27');
  });

  test('17: GSC z tym samym rozkładem — jedna baza, jak w etapie 1', () => {
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia('GSC'))) });
    importuj(gas, 10, 18, 'GSC');
    assert.equal(anomalia(gas, 'LAST_IMPORT_GSC'), 'mało danych: 10 wierszy vs mediana 26', 'bez nazwy klasy');
  });

  test('rozgrzewka per klasa: weekend potrzebuje 4 próbek, dni robocze 5', () => {
    // Trzy soboty/niedziele w bazie — mediany weekendu jeszcze nie ma.
    const trzy = [5, 6, 12].map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d)));
    const weekend = loadProject({ sheets: baseSheets([HEADER].concat(trzy)) });
    importuj(weekend, 2, 13);
    assert.equal(anomalia(weekend), undefined, 'spadek w rozgrzewce klasy nie alarmuje');

    // Cztery dni robocze — mediany dni roboczych jeszcze nie ma, choć razem próbek jest 6.
    const cztery = [5, 6, 7, 8, 9, 10].map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d)));
    const robocze = loadProject({ sheets: baseSheets([HEADER].concat(cztery)) });
    importuj(robocze, 2, 11);
    assert.equal(anomalia(robocze), undefined);

    // Piąty dzień roboczy domyka rozgrzewkę.
    const piec = [7, 8, 9, 10, 11].map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d)));
    const gotowe = loadProject({ sheets: baseSheets([HEADER].concat(piec)) });
    importuj(gotowe, 2, 14);
    assert.equal(anomalia(gotowe), 'mało danych: 2 wierszy vs mediana 26 (dni robocze)');
  });

  test('próbki bez zakresu nie wchodzą do baz klasowych, ale liczą się dla alarmu zera', () => {
    const bezZakresu = Array.from({ length: 8 }, (_, i) => wiersz(200 - i * 24, 30, ''));
    const spadek = loadProject({ sheets: baseSheets([HEADER].concat(bezZakresu)) });
    importuj(spadek, 5, 19);
    assert.equal(anomalia(spadek), undefined, 'osiem próbek bez klasy to pusta baza weekendu');

    const zero = loadProject({ sheets: baseSheets([HEADER].concat(bezZakresu)) });
    importuj(zero, 0, 19);
    assert.equal(anomalia(zero), 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 30)');
  });

  test('zero w pierwszą sobotę po dniach roboczych z danymi → alarm (reguła zera obejmuje cały profil)', () => {
    const robocze = [7, 8, 9, 10, 11].map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d)));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(robocze)) });
    importuj(gas, 0, 12);
    assert.equal(anomalia(gas), 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 25)');
  });

  test('GA4 z profilem wielodniowym i ręczny jednodniowy — tylko jednodniowe mają klasy', () => {
    const trzyDni = Object.keys(LICZBY).map(Number).map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d), { days: 3 }));
    const wielo = loadProject({ sheets: baseSheets([HEADER].concat(trzyDni)) });
    wielo.recordImportRun_('GA4', true, () => ({ rows: 10, days: 3, dataFrom: '2026-09-17', dataTo: '2026-09-19' }));
    assert.equal(anomalia(wielo), 'mało danych: 10 wierszy vs mediana 26', 'jedna baza, bez nazwy klasy');

    const reczne = Object.keys(LICZBY).map(Number).map(d => wiersz((20 - d) * 24, LICZBY[d], dzien(d), { type: 'ręczny' }));
    const reczny = loadProject({ sheets: baseSheets([HEADER].concat(reczne)) });
    reczny.recordImportRun_('GA4', false, () => ({ rows: 10, days: 1, dataFrom: '2026-09-19', dataTo: '2026-09-19' }));
    assert.equal(anomalia(reczny), undefined, 'ręczny jednodniowy też ma bazę weekendową');
  });
});
