'use strict';

/**
 * #196: rejestr zapytań telefonicznych. Skrypt zakłada wyłącznie strukturę
 * zakładki, więc testy pilnują kontraktu z issue: nagłówek bez pól kontaktowych,
 * listy wyboru z ostrzeżeniem zamiast odrzucenia, przejęcie istniejącej zakładki
 * bez ruszania wierszy i odmowa przy innym nagłówku.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SHEET = 'ZAPYTANIA TELEFONICZNE';
const HEADER = ['Data', 'Skąd', 'Dokąd', 'Usługa', 'Wycena [zł]', 'Wynik', 'Skąd o nas wie', 'Uwagi'];
const SERVICES = ['miejska', 'podmiejska', 'krajowa', 'kurier dedykowany', 'inne'];
const RESULTS = ['zlecenie', 'za drogo', 'bez odpowiedzi', 'nie obsługujemy', 'inne'];
const SOURCES = ['Google', 'polecenie', 'stały klient', 'inne', 'nie wiem'];
const WPIS = ['2026-09-19', 'Kraków', 'Gdańsk', 'krajowa', 450, 'za drogo', 'Google', 'Ekspres'];
const WPIS2 = ['2026-09-20', 'Poznań', 'Łódź', 'kurier dedykowany', 700, 'zlecenie', 'polecenie', ''];

const project = sheets => loadProject({ sheets: sheets || {} });
const sheetOf = gas => gas.SpreadsheetApp.getActive().getSheetByName(SHEET);
const rule = (gas, header, row = 2) => {
  const r = sheetOf(gas).getRange(row, HEADER.indexOf(header) + 1).getDataValidation();
  return r && plain(r);
};

describe('#196: pierwsze uruchomienie', () => {
  test('zakłada zakładkę z nagłówkiem, zamrożeniem, walidacjami i notatką', () => {
    const gas = project();
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.deepEqual([out.ok, out.created], [true, true]);
    assert.deepEqual(gas.$sheet(SHEET)[0], HEADER);
    assert.equal(sheetOf(gas).getFrozenRows(), 1);

    assert.deepEqual(rule(gas, 'Usługa'), { criteria: 'VALUE_IN_LIST', values: SERVICES, allowInvalid: true, helpText: '', showDropdown: true });
    assert.deepEqual(rule(gas, 'Wynik').values, RESULTS);
    assert.deepEqual(rule(gas, 'Skąd o nas wie').values, SOURCES);
    assert.equal(rule(gas, 'Data').criteria, 'DATE_IS_VALID_DATE');
    assert.deepEqual([rule(gas, 'Wycena [zł]').criteria, rule(gas, 'Wycena [zł]').values], ['NUMBER_GREATER_THAN_OR_EQUAL_TO', [0]]);
    ['Data', 'Usługa', 'Wycena [zł]', 'Wynik', 'Skąd o nas wie'].forEach(h => {
      assert.equal(rule(gas, h).allowInvalid, true, h + ': ostrzeżenie, nie odrzucenie');
    });
    ['Skąd', 'Dokąd', 'Uwagi'].forEach(h => assert.equal(rule(gas, h), null, h + ': wolny tekst'));
    assert.ok(rule(gas, 'Usługa', sheetOf(gas).getMaxRows()), 'reguła sięga ostatniego wiersza siatki');
    assert.equal(rule(gas, 'Usługa', 1), null, 'nagłówek bez reguły');

    assert.match(sheetOf(gas).getRange(1, 8).getNote(), /Bez danych osobowych/);
    assert.match(gas.$alerts[0][0], /została założona/);
  });

  test('nagłówek nie ma kolumn na dane kontaktowe', () => {
    const gas = project();
    gas.przygotujRejestrZapytanTelefonicznych();
    const header = gas.$sheet(SHEET)[0];
    assert.equal(header.length, 8);
    assert.deepEqual(header.filter(h => /imię|nazwisko|telefon|e-?mail|firma|klient/i.test(h)), []);
  });
});

describe('#196: przejęcie istniejącej zakładki', () => {
  test('zakładka założona ręcznie: wiersze bez zmian, walidacja odnowiona, notatka dodana', () => {
    const gas = project({ [SHEET]: [HEADER, WPIS, WPIS2] });
    // Stara reguła, którą uruchomienie ma zastąpić, a nie zostawić obok.
    sheetOf(gas).getRange(2, 4, 5, 1).setDataValidation({ criteria: 'VALUE_IN_LIST', values: ['stara'], allowInvalid: false, helpText: '' });
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.deepEqual([out.ok, out.created], [true, false]);
    assert.deepEqual(gas.$sheet(SHEET).slice(0, 3), [HEADER, WPIS, WPIS2]);
    assert.deepEqual(rule(gas, 'Usługa').values, SERVICES);
    assert.equal(rule(gas, 'Usługa').allowInvalid, true);
    assert.match(sheetOf(gas).getRange(1, 8).getNote(), /Bez danych osobowych/);
    assert.match(gas.$alerts[0][0], /wpisane wiersze \(2\) zostały bez zmian/);
  });

  test('ponowne uruchomienie niczego nie dubluje i nie rusza wierszy', () => {
    const gas = project({ [SHEET]: [HEADER, WPIS] });
    gas.przygotujRejestrZapytanTelefonicznych();
    gas.przygotujRejestrZapytanTelefonicznych();
    assert.deepEqual(gas.$sheet(SHEET).slice(0, 2), [HEADER, WPIS]);
    assert.equal(gas.$sheet(SHEET).filter(r => r[0] === 'Data').length, 1, 'jeden nagłówek');
    assert.deepEqual(rule(gas, 'Wynik').values, RESULTS);
  });

  test('pusty pierwszy wiersz nad danymi dostaje nagłówek, dane zostają', () => {
    const gas = project({ [SHEET]: [['', '', ''], WPIS] });
    gas.przygotujRejestrZapytanTelefonicznych();
    assert.deepEqual(gas.$sheet(SHEET)[0], HEADER);
    assert.deepEqual(gas.$sheet(SHEET)[1], WPIS);
  });

  test('zakładka z innym nagłówkiem zostaje nietknięta, a okno wymienia różnice', () => {
    const obcy = ['Data', 'Klient', 'Telefon'];
    const gas = project({ [SHEET]: [obcy, ['2026-09-01', 'X', '123']] });
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.equal(out.ok, false);
    assert.deepEqual(gas.$sheet(SHEET), [obcy, ['2026-09-01', 'X', '123']]);
    assert.equal(rule(gas, 'Usługa'), null, 'bez walidacji');
    assert.equal(sheetOf(gas).getRange(1, 8).getNote(), '', 'bez notatki');
    assert.equal(sheetOf(gas).getFrozenRows(), 0, 'bez zamrożenia');
    const text = gas.$alerts[0][0];
    assert.match(text, /inny nagłówek.*niczego w niej nie zmieniłem/s);
    assert.match(text, /kolumna B: jest „Klient”, oczekiwano „Skąd”/);
    assert.match(text, /kolumna D: jest „”, oczekiwano „Usługa”/);
    assert.doesNotMatch(text, /kolumna A:/, 'zgodna kolumna nie jest wymieniana');
  });

  test('zakładka przycięta do samego nagłówka dostaje wiersze na wpisy i walidacje', () => {
    // Dane → Przytnij puste wiersze zostawia pustą zakładkę z jednym wierszem;
    // walidacja od wiersza 2 byłaby wtedy zakresem spoza siatki (uwaga Codexa w #203).
    const gas = project({ [SHEET]: { rows: [HEADER], maxRows: 1 } });
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.equal(out.ok, true);
    assert.equal(sheetOf(gas).getMaxRows(), 101, 'nagłówek i sto wierszy na wpisy');
    assert.deepEqual(rule(gas, 'Usługa').values, SERVICES);
  });

  test('węższa zakładka z innym nagłówkiem: odmowa bez wyjątku i bez dokładania kolumn', () => {
    const gas = project({ [SHEET]: { rows: [['Data', 'Uwagi']], maxColumns: 2 } });
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.equal(out.ok, false);
    assert.equal(sheetOf(gas).getMaxColumns(), 2, 'struktura nietknięta');
    assert.match(gas.$alerts[0][0], /kolumna B: jest „Uwagi”, oczekiwano „Skąd”/);
    assert.match(gas.$alerts[0][0], /kolumna H: jest „”, oczekiwano „Uwagi”/);
  });

  test('węższa pusta zakładka dostaje kolumny i nagłówek', () => {
    const gas = project({ [SHEET]: { rows: [], maxColumns: 3 } });
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.equal(out.ok, true);
    assert.deepEqual(gas.$sheet(SHEET)[0], HEADER);
    assert.ok(sheetOf(gas).getMaxColumns() >= 8);
  });

  test('równoległe założenie zakładki: duplikat przy insertSheet kończy się użyciem istniejącej', () => {
    const gas = project({ [SHEET]: [HEADER] });
    const active = gas.SpreadsheetApp.getActive();
    const real = active.getSheetByName;
    let calls = 0;
    // Pierwszy odczyt nie widzi zakładki, jak wykonanie, które wyprzedziło drugie.
    active.getSheetByName = name => (name === SHEET && calls++ === 0 ? null : real(name));
    const out = plain(gas.przygotujRejestrZapytanTelefonicznych());
    assert.deepEqual([out.ok, out.created], [true, false]);
    assert.deepEqual(rule(gas, 'Usługa').values, SERVICES);
  });

  test('inny błąd insertSheet nie jest połykany', () => {
    const gas = project();
    const active = gas.SpreadsheetApp.getActive();
    active.insertSheet = () => { throw new Error('limit zakładek'); };
    assert.throws(() => gas.przygotujRejestrZapytanTelefonicznych(), /limit zakładek/);
  });
});

describe('#196: katalog i menu', () => {
  test('wpis w katalogu: kategoria „wlasne”, właściciel człowiek', () => {
    const entry = plain(project().sheetCatalog_()).find(e => e.name === SHEET);
    assert.ok(entry, 'wpis obecny');
    assert.deepEqual([entry.category, entry.owner], ['wlasne', 'człowiek']);
  });

  test('„Ukryj arkusze techniczne” nie chowa rejestru', () => {
    const gas = project({ [SHEET]: [HEADER, WPIS] });
    gas.setTechnicalSheetsHidden_(true);
    assert.equal(sheetOf(gas).isSheetHidden(), false);
  });

  test('pozycja jest w menu Dane', () => {
    const gas = project();
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.ok(dane.items.some(i => i.fn === 'przygotujRejestrZapytanTelefonicznych'));
  });
});
