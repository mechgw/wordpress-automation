'use strict';

/**
 * #180 etap 1: detektor anomalii importu liczy ZAKRESY DANYCH, nie runy,
 * zero wierszy alarmuje bez rozgrzewki, a zamknięcie incydentu anomalii nie
 * udaje, że import „ponownie działa”.
 *
 * 14 i 15.09.2026 GA4 dostało alarm „mało danych: 13 wierszy vs mediana 27”,
 * choć import działał. 09.09 ten sam dzień danych zaimportowano dwa razy
 * w odstępie 31 s i oba wpisy weszły do mediany — bez tego duplikatu żaden
 * z dwóch alarmów by nie powstał. `IMPORT LOG` nie zapisywał, jaki zakres
 * danych pobrał run, więc nie dało się tego rozróżnić.
 *
 * Numeracja odpowiada macierzy etapu 1 z opisu #180; przypadek 12 (zakres
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

  test('4: historia GA4 z 14.09 odtworzona z zakresami — mediana 25, 13 wierszy bez alarmu', () => {
    // Tabela z opisu #180: run → pobrany dzień → wiersze; 09.09 dwa razy ten sam dzień.
    const historia = [
      wiersz(170, 10, dzien(5)), wiersz(146, 8, dzien(6)),
      wiersz(122, 27, dzien(7)), wiersz(121.99, 27, dzien(7)),
      wiersz(98, 32, dzien(8)), wiersz(74, 31, dzien(9)), wiersz(50, 15, dzien(10)), wiersz(26, 25, dzien(11))
    ];
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 13, 12);

    assert.equal(anomalia(gas), undefined, 'z duplikatem mediana 27 i próg 13,5 dawały fałszywy alarm');
  });

  test('4b: ta sama historia bez zakresów (jak przed zmianą) nadal daje alarm — test umie paść', () => {
    const historia = [10, 8, 27, 27, 32, 31, 15, 25].map((rows, i) => wiersz(170 - i * 20, rows, ''));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 13, 12);

    assert.equal(anomalia(gas), 'mało danych: 13 wierszy vs mediana 27');
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
    const historia = Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 300, dzien(i + 1)));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 0, 20);

    assert.equal(anomalia(gas), 'mało danych: 0 wierszy vs mediana 300');
  });

  test('7b: 0 wierszy po rozgrzewce, mediana 0, ale starsza próbka miała dane → alarm bez mediany', () => {
    const historia = [wiersz(200, 40, dzien(1))].concat(Array.from({ length: 7 }, (_, i) => wiersz(170 - i * 24, 0, dzien(i + 2))));
    const gas = loadProject({ sheets: baseSheets([HEADER].concat(historia)) });
    importuj(gas, 0, 20);

    assert.equal(anomalia(gas), 'mało danych: 0 wierszy, a wcześniej ten profil zwracał dane (ostatnio 40)',
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
