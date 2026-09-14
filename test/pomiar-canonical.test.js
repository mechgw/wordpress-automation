'use strict';

/**
 * #168: `Pomiar` w jednej postaci — klucz, zapis i migracja historii.
 *
 * Numeracja odpowiada macierzy z opisu #168. Sedno: jedna chwila ma mieć jedną
 * reprezentację we wszystkich trzech zakładkach PSI, liczoną w strefie ARKUSZA,
 * bo tylko wtedy `(Pomiar, URL, Strategia, Próba)` łączy je po kluczu — także
 * z poziomu formuł, nie tylko z kodu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const URLS = 'PERFORMANCE URLS';
const LAB = 'PAGESPEED LAB';
const FINDINGS = 'PAGESPEED FINDINGS';
const SUMMARY = 'PERFORMANCE SUMMARY';
const FIELD = 'CWV FIELD';
const URLS_HEADER = ['URL', 'Rola', 'Uwagi'];
const LAB_HEADER = ['Pomiar', 'URL', 'Strategia', 'Próba', 'Metryka', 'Wartość', 'Źródło', 'Pobrano', 'Wyzwolenie'];
const SUMMARY_HEADER = ['Pomiar', 'URL', 'Strategia', 'Metryka', 'Mediana', 'Liczba prób', 'Źródło', 'Pobrano'];
const FIELD_HEADER = ['Okres do', 'URL', 'Form factor', 'Metryka', 'p75', 'Stan', 'Źródło', 'Pobrano'];
const FINDINGS_HEADER = [
  'Pomiar', 'URL', 'Strategia', 'Próba', 'Rodzaj', 'Nazwa', 'Szczegół',
  'Czas (ms)', 'Transfer (KiB)', 'Potencjalna oszczędność (ms)', 'Potencjalna oszczędność (KiB)',
  'Źródło', 'Pobrano', 'Wyzwolenie'
];

const URL = 'https://www.example.pl/';
const KEY = { PAGESPEED_API_KEY: 'klucz-testowy' };
const PROP = 'POMIAR_CANONICAL_MIGRATION';

const psiBody = () => JSON.stringify({
  lighthouseResult: {
    lighthouseVersion: '13.4.1',
    categories: { performance: { score: 0.8 } },
    audits: { 'largest-contentful-paint': { numericValue: 2500 } }
  }
});

const psiFetch = url => (String(url).indexOf('pagespeedonline') >= 0
  ? { code: 200, text: psiBody() }
  : { code: 404, text: '{}' });

/** Wiersz surowej próby w kształcie, jaki produkuje `parsePsiRun_`. */
const lab = (pomiar, attempt = 1, value = 2000) =>
  [pomiar, URL, 'mobile', attempt, 'LCP', value, 'PSI_LAB', '2026-09-13', 'ręczny'];

const rowsOf = (gas, sheet) => (gas.$sheet(sheet) || []).slice(1).filter(r => String(r[1] || '') !== '');
const pomiary = (gas, sheet) => rowsOf(gas, sheet).map(r => r[0]);

function project(sheets = {}, opts = {}) {
  return loadProject(Object.assign({
    properties: KEY,
    sheets: Object.assign({ [URLS]: [URLS_HEADER, [URL, 'homepage', '']] }, sheets),
    fetch: psiFetch
  }, opts));
}

/** Data w realm-ie VM — tylko taka przechodzi `instanceof Date` w źródłach. */
const data = (gas, y, m, d, hh = 0, mm = 0, ss = 0) => new gas.$Date(y, m - 1, d, hh, mm, ss);

describe('#168 klucz: ta sama chwila to ten sam wiersz', () => {
  test('1: w arkuszu data, przychodzi tekst — jeden wiersz, nie dwa', () => {
    const gas = project({ [LAB]: [LAB_HEADER] });
    const key = gas.$get('PERF_LAB_KEY');
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, [lab('2026-09-13 13:14:11')]);

    // Tak wygląda ta komórka, gdy arkusz sparsował zapisany łańcuch.
    gas.$sheet(LAB)[1][0] = data(gas, 2026, 9, 13, 13, 14, 11);
    assert.ok(gas.$sheet(LAB)[1][0] instanceof gas.$Date, 'warunek produkcyjny odtworzony');

    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, [lab('2026-09-13 13:14:11', 1, 2500)]);

    const rows = rowsOf(gas, LAB);
    assert.equal(rows.length, 1, 'data i tekst to ten sam klucz');
    assert.equal(rows[0][5], 2500, 'wiersz podmieniony, nie zdublowany');
    assert.equal(rows[0][0], '2026-09-13 13:14:11', 'zapisany kanonicznie, jako tekst');
  });

  test('2: symetrycznie — w arkuszu tekst, przychodzi data', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14:11')] });
    const przychodzacy = lab(data(gas, 2026, 9, 13, 13, 14, 11), 1, 3000);
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'), [przychodzacy]);

    const rows = rowsOf(gas, LAB);
    assert.equal(rows.length, 1, 'ta sama chwila po obu stronach klucza');
    assert.equal(rows[0][5], 3000);
    assert.equal(rows[0][0], '2026-09-13 13:14:11', 'data przychodząca też jest kanonizowana przy zapisie');
  });

  test('znacznik sprzed sekund (#156) to ta sama chwila, nie inny przebieg', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')] });
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'),
      [lab('2026-09-13 13:14:00', 1, 4000)]);

    const rows = rowsOf(gas, LAB);
    assert.equal(rows.length, 1, 'minuta bez sekund opisuje pełną minutę');
    assert.equal(rows[0][5], 4000);
  });

  test('3: „CWV FIELD” zostaje przy dobie — nie sprowadzamy jej do 00:00:00', () => {
    const gas = project();
    const tz = 'Europe/Warsaw';
    const dzien = gas.$get('PERF_CANONICAL_DAY');

    assert.equal(gas.performanceKeyPart_(data(gas, 2026, 9, 9), dzien, tz), '2026-09-09');
    assert.equal(gas.performanceKeyPart_('2026-09-09', dzien, tz), '2026-09-09',
      'tekst i data dają ten sam klucz, bez sekund');
    assert.equal(
      gas.performanceCanonicalDate_(data(gas, 2026, 9, 9), gas.$get('PERF_CANONICAL_MEASUREMENT'), tz),
      '2026-09-09 00:00:00',
      'pełny znacznik istnieje, ale NIE jest postacią „Okres do”'
    );
  });

  test('3: zapis do „CWV FIELD” nie zmienia postaci „Okres do”', () => {
    const gas = project({ [FIELD]: [FIELD_HEADER] });
    const wiersz = ['2026-09-09', URL, 'PHONE', 'LCP', 2000, 'GOOD', 'CrUX', '2026-09-13'];
    gas.upsertPerformanceRows_(FIELD, FIELD_HEADER, gas.$get('PERF_FIELD_KEY'), [wiersz]);

    assert.equal(gas.$sheet(FIELD)[1][0], '2026-09-09', 'bez sekund i bez formatu tekstowego');
  });

  test('4: ponowne przetworzenie tego samego znacznika nie mnoży wierszy', () => {
    const gas = project({ [LAB]: [LAB_HEADER] });
    const key = gas.$get('PERF_LAB_KEY');
    const rows = [lab('2026-09-13 13:14:11', 1), lab('2026-09-13 13:14:11', 2)];
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, rows);
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, rows);
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, rows);

    assert.equal(rowsOf(gas, LAB).length, 2, 'trzy przetworzenia, dwa wiersze');
  });

  test('5: nowy znacznik dokłada komplet i nie rusza poprzedniego', () => {
    const gas = project({ [LAB]: [LAB_HEADER] });
    const key = gas.$get('PERF_LAB_KEY');
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, [lab('2026-09-13 13:14:11', 1, 1111)]);
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, key, [lab('2026-09-13 19:14:11', 1, 2222)]);

    const rows = rowsOf(gas, LAB);
    assert.equal(rows.length, 2, 'historia, nie nadpisanie');
    assert.deepEqual(rows.map(r => [r[0], r[5]]).sort(),
      [['2026-09-13 13:14:11', 1111], ['2026-09-13 19:14:11', 2222]]);
  });
});

describe('#168 strażnik: klucz nie może rozminąć się z zapisem', () => {
  test('kolumna „Pomiar” w kluczu bez postaci kanonicznej wywraca pierwsze wywołanie', () => {
    const gas = project({ [LAB]: [LAB_HEADER] });
    assert.throws(
      () => gas.upsertPerformanceRows_(LAB, LAB_HEADER, [0, 1, 2, 3, 4], [lab('2026-09-13 13:14:11')]),
      /kolumna „Pomiar” w kluczu zapisu musi deklarować postać/
    );
    assert.equal(rowsOf(gas, LAB).length, 0, 'nic nie zostało zapisane');
  });

  test('zakładka bez kolumny „Pomiar” nie podlega tej regule', () => {
    const gas = project({ [FIELD]: [FIELD_HEADER] });
    assert.doesNotThrow(() => gas.upsertPerformanceRows_(FIELD, FIELD_HEADER, [0, 1, 2, 3],
      [['2026-09-09', URL, 'PHONE', 'LCP', 2000, 'GOOD', 'CrUX', '2026-09-13']]));
  });
});

describe('#168 format kolumny: arkusz przestaje parsować', () => {
  /** Zakładka odwzorowująca parsowanie zapisanego łańcucha przez Arkusze. */
  const parsujacy = (rows = [LAB_HEADER]) => ({ rows: rows, parsesOnWrite: true });

  const formatPomiaru = (gas, name) =>
    gas.SpreadsheetApp.getActive().getSheetByName(name).getRange(2, 1).getNumberFormat();

  test('6: po zapisie kolumna ma format tekstowy, a łańcuch wraca łańcuchem', () => {
    const gas = project({ [LAB]: parsujacy() });
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'), [lab('2026-09-13 13:14:11')]);

    assert.equal(formatPomiaru(gas, LAB), '@', 'kolumna „Pomiar” jest tekstem');
    assert.equal(typeof gas.$sheet(LAB)[1][0], 'string', 'arkusz nie sparsował znacznika na datę');
    assert.equal(gas.$sheet(LAB)[1][0], '2026-09-13 13:14:11');
  });

  test('6: format obejmuje też wiersze DOPISANE przy tym zapisie', () => {
    // Wiersze poniżej dotychczasowego końca danych rozjechały się w #168, bo
    // dostawały format domyślny — czyli ten, który parsuje.
    const gas = project({ [LAB]: parsujacy([LAB_HEADER, lab('2026-09-13 13:14:11', 1)]) });
    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'),
      [lab('2026-09-13 19:00:00', 1), lab('2026-09-13 19:00:00', 2), lab('2026-09-13 19:00:00', 3)]);

    const typy = [...new Set(rowsOf(gas, LAB).map(r => typeof r[0]))];
    assert.deepEqual(typy, ['string'], 'żaden wiersz nie został sparsowany na datę');
  });

  test('7: istniejąca zakładka z formatem datowym dostaje tekstowy, bez ruszania chwil', () => {
    const gas = project({ [LAB]: parsujacy([LAB_HEADER, lab('2026-09-13 13:14:11')]) });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    sheet.getRange(2, 1, 10, 1).setNumberFormat('yyyy-MM-dd HH:mm');

    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'), [lab('2026-09-13 19:00:00')]);

    assert.equal(formatPomiaru(gas, LAB), '@', 'format poprawiony');
    assert.deepEqual(pomiary(gas, LAB).sort(), ['2026-09-13 13:14:11', '2026-09-13 19:00:00'],
      'obie chwile zachowane, obie tekstem');
  });

  test('15: format ustawiany PRZED zapisem kanonicznych wartości', () => {
    const gas = project({ [LAB]: parsujacy() });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    const kolejnosc = [];
    const realGetRange = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => {
      const range = realGetRange(...args);
      const setNumberFormat = range.setNumberFormat.bind(range);
      const setValues = range.setValues.bind(range);
      range.setNumberFormat = fmt => { kolejnosc.push('format:' + fmt + '@' + args[0]); return setNumberFormat(fmt); };
      range.setValues = values => { kolejnosc.push('zapis@' + args[0]); return setValues(values); };
      return range;
    };

    gas.upsertPerformanceRows_(LAB, LAB_HEADER, gas.$get('PERF_LAB_KEY'), [lab('2026-09-13 13:14:11')]);

    const format = kolejnosc.indexOf('format:@@2');
    const zapis = kolejnosc.findIndex(x => x === 'zapis@2');
    assert.ok(format >= 0, 'format tekstowy w ogóle ustawiony: ' + kolejnosc.join(', '));
    assert.ok(zapis >= 0, 'zapis danych w ogóle nastąpił: ' + kolejnosc.join(', '));
    assert.ok(format < zapis, 'odwrotna kolejność pozwala arkuszowi sparsować świeży zapis');
  });
});

describe('#168 przebieg: trzy zakładki, jedna postać', () => {
  test('10: „PAGESPEED FINDINGS” też, mimo zapisu przez replaceFindingsScopes_', () => {
    const gas = project();
    gas.runPsiMeasurement_();

    const wszystkie = [LAB, FINDINGS, SUMMARY].map(name => {
      const unikalne = [...new Set(pomiary(gas, name).map(String))];
      assert.equal(unikalne.length, 1, name + ': jeden przebieg to jeden znacznik, było ' + unikalne.join(' | '));
      return unikalne[0];
    });
    assert.equal([...new Set(wszystkie)].length, 1, 'ten sam znacznik w trzech zakładkach: ' + wszystkie.join(' | '));
    assert.match(wszystkie[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(rowsOf(gas, FINDINGS).length > 0, 'ustalenia w ogóle powstały');
  });

  test('10: w FINDINGS kanonizowany jest też wiersz ZACHOWANY z innego zakresu', () => {
    // Wiersze zakresu mierzonego teraz i tak niosą kanoniczny `measuredAt`, więc
    // dowodem na objęcie tej ścieżki jest wyłącznie wiersz, którego przebieg nie
    // dotyka: inny adres, stary znacznik, zachowany przez replaceFindingsScopes_.
    const obcy = [
      '2026-09-10 08:00', 'https://www.example.pl/inna/', 'mobile', 1, 'SZANSA', 'coś', '',
      '', '', '', '', 'PSI_LAB', '2026-09-13', 'ręczny'
    ];
    const gas = project({ [FINDINGS]: { rows: [FINDINGS_HEADER, obcy], parsesOnWrite: true } });
    gas.runPsiMeasurement_();

    const zachowany = rowsOf(gas, FINDINGS).find(r => String(r[1]).indexOf('/inna/') >= 0);
    assert.ok(zachowany, 'wiersz obcego zakresu przetrwał przebieg');
    assert.equal(zachowany[0], '2026-09-10 08:00:00', 'i wyszedł w postaci kanonicznej');
    assert.deepEqual([...new Set(rowsOf(gas, FINDINGS).map(r => typeof r[0]))], ['string'],
      'żaden wiersz FINDINGS nie został sparsowany na datę');
  });

  test('kolejny przebieg nie rozjeżdża znacznika wierszy zachowanych', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-10 08:00')] });
    gas.runPsiMeasurement_();

    const postaci = [...new Set(pomiary(gas, LAB).map(p => typeof p))];
    assert.deepEqual(postaci, ['string'], 'zakładka trzyma jeden typ');
    assert.ok(pomiary(gas, LAB).indexOf('2026-09-10 08:00:00') >= 0,
      'historyczny znacznik przetrwał w postaci kanonicznej');
  });
});

describe('#168 migracja: mechanizm wykonania', () => {
  const mieszana = gas => {
    const grid = gas.$sheet(LAB);
    grid[1][0] = data(gas, 2026, 9, 13, 13, 14, 11);
    grid[3][0] = data(gas, 2026, 9, 13, 19, 0, 0);
  };

  const zHistoria = () => project({
    [LAB]: [
      LAB_HEADER,
      lab('2026-09-13 13:14:11', 1), lab('2026-09-13 13:14:11', 2),
      lab('2026-09-13 19:00:00', 1), lab('2026-09-13 19:00', 2)
    ]
  });

  test('8 i 11: zakładka mieszana wychodzi w jednej postaci, bez zmiany chwil', () => {
    const gas = zHistoria();
    mieszana(gas);
    const przed = gas.$sheet(LAB).slice(1).map(r => (r[0] instanceof gas.$Date ? r[0].getTime() : r[0]));
    assert.ok(przed.some(v => typeof v === 'number'), 'stan wyjściowy naprawdę mieszany');

    gas.$ui.$answer = 'YES';
    const out = plain(gas.kanonizujZnacznikiPomiaru());

    assert.equal(out.sheets, 3, 'trzy zakładki oznaczone jako zmigrowane');
    assert.deepEqual([...new Set(pomiary(gas, LAB).map(p => typeof p))], ['string']);
    assert.deepEqual(pomiary(gas, LAB), [
      '2026-09-13 13:14:11', '2026-09-13 13:14:11', '2026-09-13 19:00:00', '2026-09-13 19:00:00'
    ], 'każda chwila zachowana; znacznik bez sekund dostał :00');
    assert.equal(out.changed, 3, 'dwie daty i jeden znacznik bez sekund');
  });

  test('8: migracja nie rusza innych kolumn ani kolejności wierszy', () => {
    const gas = zHistoria();
    mieszana(gas);
    const przed = gas.$sheet(LAB).slice(1).map(r => r.slice(1));
    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();

    assert.deepEqual(gas.$sheet(LAB).slice(1).map(r => r.slice(1)), przed,
      'poza kolumną „Pomiar” zakładka jest bit w bit taka sama');
  });

  test('8: formuła w innej kolumnie przeżywa migrację', () => {
    // `getValues()` oddaje WYNIK formuły, więc przepisanie pełnej szerokości
    // zamieniłoby ją na liczbę — i to trwale (uwaga z audytu Codexa na #177).
    const gas = project({
      [LAB]: {
        rows: [LAB_HEADER, lab('2026-09-13 13:14'), lab('2026-09-13 13:14', 2)],
        formulas: [[], [], ['', '', '', '', '', '=ŚREDNIA(F2:F2)']]
      }
    });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    assert.equal(sheet.getRange(3, 6).getFormulas()[0][0], '=ŚREDNIA(F2:F2)', 'stan wyjściowy');

    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();

    assert.equal(sheet.getRange(3, 6).getFormulas()[0][0], '=ŚREDNIA(F2:F2)',
      'migracja dotyka wyłącznie kolumny „Pomiar”');
    assert.deepEqual(pomiary(gas, LAB), ['2026-09-13 13:14:00', '2026-09-13 13:14:00']);
  });

  test('9 i 12: drugie uruchomienie to no-op — zakładki nie są nawet czytane', () => {
    const gas = zHistoria();
    mieszana(gas);
    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();
    const po = gas.$sheet(LAB).slice().map(r => r.slice());

    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    const wywolania = [];
    const real = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => { wywolania.push(args); return real(...args); };

    gas.$alerts.length = 0;
    const out = plain(gas.kanonizujZnacznikiPomiaru());

    assert.equal(out.changed, 0);
    assert.equal(out.sheets, 0);
    assert.deepEqual(wywolania, [], 'żadnego odczytu ani zapisu zmigrowanej zakładki');
    assert.deepEqual(gas.$sheet(LAB), po, 'nic się nie zmieniło');
    assert.match(gas.$alerts[0][0], /Nic nie zostało odczytane ani zapisane/);
  });

  test('12: no-op rozpoznaje WERSJĘ, nie samą obecność wpisu', () => {
    const gas = zHistoria();
    mieszana(gas);
    gas.$properties[gas.$get('PERF_MIGRATION_PROP')] = JSON.stringify({
      [LAB]: 0, [FINDINGS]: 0, [SUMMARY]: 0
    });
    gas.$ui.$answer = 'YES';

    assert.equal(plain(gas.kanonizujZnacznikiPomiaru()).sheets, 3,
      'starsza wersja znaczy „do zrobienia”, nie „zrobione”');
  });

  test('uszkodzony stan czytamy jako „nic nie zmigrowano”', () => {
    const gas = zHistoria();
    gas.$properties[PROP] = 'to nie jest JSON';
    assert.deepEqual(plain(gas.perfMigrationState_()), {});

    gas.$properties[PROP] = '"tekst"';
    assert.deepEqual(plain(gas.perfMigrationState_()), {}, 'JSON, ale nie obiekt');
  });

  test('13: awaria w połowie nie oznacza zakładki; kolejne uruchomienie kończy pracę', () => {
    const gas = project({
      [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')],
      [SUMMARY]: [SUMMARY_HEADER, ['2026-09-13 13:14', URL, 'mobile', 'LCP', 2000, 1, 'PSI_LAB', '2026-09-13']]
    });

    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(SUMMARY);
    const real = sheet.getRange.bind(sheet);
    let psuj = true;
    sheet.getRange = (...args) => {
      const range = real(...args);
      const setValues = range.setValues.bind(range);
      range.setValues = values => {
        if (psuj && args[0] === 2) throw new Error('awaria zapisu w połowie');
        return setValues(values);
      };
      return range;
    };

    gas.$ui.$answer = 'YES';
    assert.throws(() => gas.kanonizujZnacznikiPomiaru(), /awaria zapisu w połowie/);

    const stan = plain(gas.perfMigrationState_());
    assert.equal(stan[LAB], 1, 'zakładka zapisana w całości jest oznaczona');
    assert.equal(stan[SUMMARY], undefined, 'zakładka przerwana NIE jest oznaczona');
    assert.deepEqual(gas.$lock.filter(e => e[0] === 'releaseLock').length, 1, 'blokada zwolniona mimo błędu');

    assert.deepEqual(pomiary(gas, LAB), ['2026-09-13 13:14:00'], 'zakładka sprzed awarii przepisana');
    assert.deepEqual(pomiary(gas, SUMMARY), ['2026-09-13 13:14'], 'przerwana została nietknięta');

    psuj = false;
    const out = plain(gas.kanonizujZnacznikiPomiaru());
    assert.equal(out.sheets, 1, 'dokończona zostaje tylko SUMMARY; LAB już nie jest czytana');
    assert.equal(plain(gas.perfMigrationState_())[SUMMARY], 1);
    assert.deepEqual(pomiary(gas, SUMMARY), ['2026-09-13 13:14:00']);
  });

  test('anulowanie w dialogu nie zmienia ani danych, ani stanu', () => {
    const gas = zHistoria();
    mieszana(gas);
    const przed = gas.$sheet(LAB).slice().map(r => r.slice());
    gas.$ui.$answer = 'NO';

    assert.equal(plain(gas.kanonizujZnacznikiPomiaru()).sheets, 0);
    assert.deepEqual(gas.$sheet(LAB), przed);
    assert.deepEqual(plain(gas.perfMigrationState_()), {}, 'nic nie oznaczone');
    assert.match(gas.$alerts[1][0], /Anulowano/);
  });

  test('dialog podaje liczby PRZED zmianą, per zakładka', () => {
    const gas = zHistoria();
    mieszana(gas);
    gas.$ui.$answer = 'NO';
    gas.kanonizujZnacznikiPomiaru();

    const tekst = gas.$alerts[0][0];
    assert.match(tekst, /PAGESPEED LAB: 3 z 4 wierszy do przepisania/);
    assert.match(tekst, /PAGESPEED FINDINGS: zakładka nie istnieje/);
    assert.match(tekst, /Żadna zapisana chwila, żadna inna kolumna ani kolejność wierszy się nie zmienia/);
  });

  test('migracja idzie pod blokadą — zajęta blokada zatrzymuje ją przed zapisem', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')] }, { lockHeld: true });
    gas.$ui.$answer = 'YES';

    assert.throws(() => gas.kanonizujZnacznikiPomiaru(), /Inne uruchomienie jeszcze trwa/);
    assert.deepEqual(pomiary(gas, LAB), ['2026-09-13 13:14'], 'nic nie przepisane');
    assert.deepEqual(plain(gas.perfMigrationState_()), {});
  });
});

describe('#168 stan migracji jest widoczny', () => {
  test('linia statusu wymienia zakładki, które czekają', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')] });
    const przed = gas.perfMigrationStatusLine_();
    assert.match(przed, /zmigrowane 0 z 3 zakładek/);
    assert.match(przed, /Czekają: PAGESPEED LAB, PAGESPEED FINDINGS, PERFORMANCE SUMMARY/);
    assert.match(przed, /Kanonizuj znaczniki Pomiar/);

    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();

    const po = gas.perfMigrationStatusLine_();
    assert.match(po, /zmigrowane 3 z 3 zakładek/);
    assert.ok(po.indexOf('Czekają') < 0, po);
  });

  test('linia statusu nie czyta zakładek — status nie może kosztować odczytu historii', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')] });
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(LAB);
    const wywolania = [];
    const real = sheet.getRange.bind(sheet);
    sheet.getRange = (...args) => { wywolania.push(args); return real(...args); };

    gas.perfMigrationStatusLine_();
    assert.deepEqual(wywolania, []);
  });

  test('„Status danych” pokazuje tę linię', () => {
    const gas = project({ [LAB]: [LAB_HEADER, lab('2026-09-13 13:14')] });
    gas.showImportStatus();
    assert.match(gas.$alerts[0][0], /\nKanonizacja „Pomiar” \(#168\): zmigrowane 0 z 3 zakładek\./);
  });
});

describe('#168 strefa arkusza jest jedynym źródłem prawdy', () => {
  const ARKUSZ = 'Pacific/Kiritimati';
  const SKRYPT = 'Europe/Warsaw';
  const PRZESUNIECIA = { [ARKUSZ]: 14, [SKRYPT]: 2 };

  /** Prawdziwe przeliczenie stref; stub domyślnie formatuje w strefie maszyny. */
  const formatujWStrefie = (date, tz, pattern) => {
    if (!(tz in PRZESUNIECIA)) throw new Error('nieznana strefa: ' + tz);
    const p = new Date(date.getTime() + PRZESUNIECIA[tz] * 3600000);
    const dwa = n => String(n).padStart(2, '0');
    const parts = {
      yyyy: String(p.getUTCFullYear()), MM: dwa(p.getUTCMonth() + 1), dd: dwa(p.getUTCDate()),
      HH: dwa(p.getUTCHours()), mm: dwa(p.getUTCMinutes()), ss: dwa(p.getUTCSeconds())
    };
    return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, m => parts[m]);
  };

  const zeStrefa = sheets => {
    const gas = project(sheets, { timeZone: ARKUSZ });
    const strefy = [];
    gas.Utilities.formatDate = (date, tz, pattern) => {
      strefy.push(tz);
      return formatujWStrefie(date, tz, pattern);
    };
    return { gas, strefy };
  };

  test('14: data blisko północy nie przesuwa dnia przy migracji', () => {
    const { gas, strefy } = zeStrefa({ [LAB]: [LAB_HEADER, lab('x')] });
    // 2026-09-13 12:00 UTC: w strefie arkusza to już 14 września, w strefie
    // skryptu jeszcze 13. Dzień rozstrzyga wyłącznie strefa arkusza.
    const chwila = new gas.$Date(Date.UTC(2026, 8, 13, 12, 0, 0));
    gas.$sheet(LAB)[1][0] = chwila;
    assert.equal(formatujWStrefie(chwila, SKRYPT, 'yyyy-MM-dd'), '2026-09-13',
      'strefy naprawdę się rozjeżdżają — inaczej test nie dowodziłby niczego');

    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();

    assert.deepEqual(pomiary(gas, LAB), ['2026-09-14 02:00:00']);
    assert.deepEqual([...new Set(strefy)], [ARKUSZ], 'strefa skryptu nie pojawia się w migracji');
  });

  test('14: to samo dla drugiej strony północy', () => {
    const { gas } = zeStrefa({ [LAB]: [LAB_HEADER, lab('x')] });
    // 23:50 i 00:10 w strefie ARKUSZA to ta sama doba tylko w niej.
    gas.$sheet(LAB)[1][0] = new gas.$Date(Date.UTC(2026, 8, 13, 9, 50, 0));
    gas.$ui.$answer = 'YES';
    gas.kanonizujZnacznikiPomiaru();

    assert.deepEqual(pomiary(gas, LAB), ['2026-09-13 23:50:00']);
  });

  test('nowy zapis i klucz też liczą się w strefie arkusza', () => {
    const { gas, strefy } = zeStrefa({});
    gas.runPsiMeasurement_();

    assert.deepEqual([...new Set(strefy)], [ARKUSZ],
      'ani jedno formatowanie w strefie skryptu: ' + [...new Set(strefy)].join(', '));
    const znacznik = String(pomiary(gas, LAB)[0]);
    assert.match(znacznik, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('strefa skryptu nie jest w tych plikach wywoływana', () => {
    const fs = require('fs');
    // Komentarze wolno jej nazywać — właśnie w nich wyjaśniamy, czemu jej nie
    // używamy. Liczy się wywołanie, więc linie komentarza odpadają przed szukaniem.
    const kod = tekst => tekst.split(String.fromCharCode(10))
      .filter(line => {
        const t = line.trim();
        return t.indexOf('*') !== 0 && t.indexOf('//') !== 0 && t.indexOf('/*') !== 0;
      })
      .join(String.fromCharCode(10));

    ['src/Performance.gs', 'src/PerformanceMigration.gs'].forEach(plik => {
      assert.ok(
        kod(fs.readFileSync(plik, 'utf8')).indexOf('getScriptTimeZone') < 0,
        plik + ': strefa skryptu nie należy do ścieżek klucza, zapisu ani migracji (#168)'
      );
    });

    // Strażnik musi umieć się wywrócić: ten sam filtr na kodzie, który ją wywołuje.
    assert.ok(kod('function f() {\n  return Session.getScriptTimeZone();\n}').indexOf('getScriptTimeZone') >= 0);
  });
});
