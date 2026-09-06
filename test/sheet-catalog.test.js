'use strict';

/**
 * #78: porządek w pliku – kategorie, kolory zakładek, kolejność i arkusz START.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const START = 'START';
const HEADER = ['Arkusz', 'Kategoria', 'Prowadzi', 'Co tu jest'];
const SIGNATURE = 'START – spis arkuszy';

/** Plik zbliżony do produkcyjnego: arkusze własne wymieszane z arkuszami skryptu. */
function sheets(extra = {}) {
  const base = {
    'Kierunki SEO': [['a']],
    'GSC RAW': [['date']],
    'WP COMMANDS': [['command_id']],
    'Konfiguracja GSC': [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/']],
    'Quick wins': [['a']],
    'IMPORT LOG': [['Czas']],
    'URL INSPEKCJA': [['URL']],
    'Konfiguracja GA4': [['Klucz', 'Wartość'], ['propertyId', 'properties/111']],
    'GA4 RAW': [['date']],
    'WP RESULTS': [['command_id']]
  };
  return Object.assign(base, extra);
}

const project = (extra, opts = {}) => loadProject(Object.assign({ sheets: sheets(extra) }, opts));
const names = gas => gas.SpreadsheetApp.getActive().getSheets().map(s => s.getName());
const colors = gas => Object.fromEntries(gas.SpreadsheetApp.getActive().getSheets().map(s => [s.getName(), s.getTabColor()]));

describe('#78: kolejność i kolory', () => {
  test('T1: pełny plik → START pierwszy, arkusze własne przed skryptowymi, kategorie w kolejności, kolory tylko dla skryptowych', () => {
    const gas = project();
    const out = plain(gas.uporzadkujArkuszeZMenu());

    assert.deepEqual(names(gas), [
      'START',
      'Kierunki SEO', 'Quick wins',
      'URL INSPEKCJA',
      'WP COMMANDS', 'WP RESULTS',
      'Konfiguracja GSC', 'Konfiguracja GA4',
      'GSC RAW', 'GA4 RAW', 'IMPORT LOG'
    ]);

    const c = colors(gas);
    assert.equal(c['START'], '#674ea7');
    assert.equal(c['URL INSPEKCJA'], '#38761d');
    assert.equal(c['WP COMMANDS'], '#e69138');
    assert.equal(c['Konfiguracja GSC'], '#999999');
    assert.equal(c['GSC RAW'], '#434343');
    assert.equal(c['Kierunki SEO'], null, 'own sheets keep their colour');
    assert.equal(c['Quick wins'], null);

    assert.equal(out.own, 2);
    assert.equal(out.known, 9, 'catalogued sheets present in the file, plus START');
    assert.match(gas.$alerts[0][0], /^Porządek w pliku:\nArkusze skryptu: 9 \| arkusze własne: 2 \(kolory i widoczność bez zmian\)\n/);
    assert.match(gas.$alerts[0][0], /Dane surowe i logi możesz schować: Dane → Ukryj arkusze techniczne\.$/);
  });

  test('T2: arkusz spoza katalogu nie jest ruszany: kolor zostaje, nie jest ukrywany, zachowuje kolejność względną', () => {
    const gas = project({ 'Mój brudnopis': [['x']] });
    gas.SpreadsheetApp.getActive().getSheetByName('Mój brudnopis').setTabColor('#ff0000');
    gas.uporzadkujArkusze();
    assert.equal(colors(gas)['Mój brudnopis'], '#ff0000', 'own colour untouched');
    assert.deepEqual(names(gas).slice(0, 4), ['START', 'Kierunki SEO', 'Quick wins', 'Mój brudnopis'], 'own sheets keep their relative order');
    assert.equal(gas.SpreadsheetApp.getActive().getSheetByName('Mój brudnopis').isSheetHidden(), false);
  });

  test('T3: drugie uruchomienie nic nie zmienia (idempotencja)', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const orderAfterFirst = names(gas);
    const out = plain(gas.uporzadkujArkuszeZMenu());
    assert.deepEqual(plain(out.recolored), []);
    assert.deepEqual(plain(out.moved), []);
    assert.deepEqual(names(gas), orderAfterFirst);
    assert.match(gas.$alerts[0][0], /Pokolorowane teraz: żaden \(już były\)\nPrzesunięte teraz: żaden \(kolejność już poprawna\)/);
    assert.match(gas.$alerts[0][0], /\nPlik był już uporządkowany\.\n/);
  });

  test('brakujące arkusze skryptu są po prostu pomijane, kolejność pozostałych bez luk', () => {
    const gas = loadProject({ sheets: { 'Konfiguracja GSC': [['Klucz']], 'Analiza': [['a']] } });
    gas.uporzadkujArkusze();
    assert.deepEqual(names(gas), ['START', 'Analiza', 'Konfiguracja GSC']);
  });
});

describe('#78: arkusz START', () => {
  test('T4: START ma nagłówek, wiersz na każdy arkusz z linkiem po gid, kategorią, właścicielem i opisem', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const grid = plain(gas.$sheet(START));

    assert.match(grid[0][0], /^START – spis arkuszy \(wersja skryptu: dev\)$/);
    assert.match(grid[1][0], /Odświeżany przez Dane → Uporządkuj arkusze/);
    assert.deepEqual(grid[3], HEADER);

    const gid = gas.SpreadsheetApp.getActive().getSheetByName('Kierunki SEO').getSheetId();
    assert.deepEqual(grid[4], ['=HYPERLINK("https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=' + gid + '","Kierunki SEO")', 'Analiza (arkusze własne)', 'człowiek', 'Arkusz własny, nie zarządzany przez skrypt.']);

    const rows = grid.slice(4);
    assert.equal(rows.length, 10, 'every sheet except START');
    assert.ok(!rows.some(r => String(r[0]).includes('"START"')), 'START does not list itself');
    const raw = rows.find(r => String(r[0]).includes('"GSC RAW"'));
    assert.deepEqual(raw.slice(1), ['Dane surowe i logi', 'skrypt', 'Surowe dane Search Console. Nie edytuj ręcznie.']);
    const commands = rows.find(r => String(r[0]).includes('"WP COMMANDS"'));
    assert.equal(commands[2], 'człowiek + skrypt');
  });

  test('T4b: START jest przepisywany, nie dopisywany: usunięty arkusz znika ze spisu', () => {
    const s = sheets();
    const gas = loadProject({ sheets: s });
    gas.uporzadkujArkusze();
    const first = plain(gas.$sheet(START)).length;

    delete s['Quick wins'];
    delete s['GA4 RAW'];
    const gas2 = loadProject({ sheets: s });
    gas2.uporzadkujArkusze();
    const second = plain(gas2.$sheet(START));
    assert.equal(second.length, first - 2);
    assert.ok(!second.some(r => String(r[0]).includes('"Quick wins"')));
  });

  test('wygenerowany wcześniej START jest przepisywany: stara treść znika, arkusz zostaje pierwszy', () => {
    const gas = project({ [START]: [[SIGNATURE + ' (wersja skryptu: v1.0.0)'], ['nieaktualny wiersz']] });
    gas.uporzadkujArkusze();
    const grid = plain(gas.$sheet(START));
    assert.match(grid[0][0], /^START – spis arkuszy \(wersja skryptu: dev\)$/);
    assert.ok(!grid.some(r => r.some(v => String(v).includes('nieaktualny wiersz'))), 'old content cleared');
    assert.equal(names(gas)[0], START);
  });

  test('#78/Codex: cudzy arkusz START nie jest kasowany – porządkowanie odmawia z instrukcją', () => {
    const gas = project({ [START]: [['Moje notatki'], ['ważne dane']] });
    assert.throws(() => gas.uporzadkujArkusze(), /Arkusz „START” istnieje i nie został utworzony przez skrypt/);
    assert.throws(() => gas.uporzadkujArkusze(), /Nic nie zostało zmienione/);
    assert.deepEqual(plain(gas.$sheet(START)), [['Moje notatki'], ['ważne dane']], 'contents untouched');
    assert.equal(names(gas)[0], 'Kierunki SEO', 'no reordering happened either');

    const empty = project({ [START]: [] });
    empty.uporzadkujArkusze();
    assert.match(plain(empty.$sheet(START))[0][0], /^START – spis arkuszy/, 'an empty START is adopted');
  });

  test('#78/Codex: cudzysłów w nazwie arkusza jest podwajany w formule HYPERLINK', () => {
    const gas = project({ 'Raport "roczny"': [['a']] });
    gas.uporzadkujArkusze();
    const row = plain(gas.$sheet(START)).find(r => String(r[0]).includes('roczny'));
    const label = String(row[0]).slice(String(row[0]).indexOf(',') + 1, -1);
    assert.equal(label, '"Raport ""roczny"""');
    assert.equal((String(row[0]).match(/"/g) || []).length % 2, 0, 'quotes stay balanced');
  });

  test('wyścig o insertSheet: duplikat kończy się użyciem istniejącego arkusza, inny błąd nie jest ukrywany', () => {
    const gas = project({ [START]: [[SIGNATURE + ' (wersja skryptu: v1.0.0)']] });
    const ss = gas.SpreadsheetApp.getActive();
    const realGet = ss.getSheetByName;
    let lookups = 0;
    ss.getSheetByName = name => {
      if (name === START && ++lookups === 1) return null;
      return realGet(name);
    };
    ss.insertSheet = () => { throw new Error('A sheet with the name "START" already exists.'); };
    gas.uporzadkujArkusze();
    assert.match(plain(gas.$sheet(START))[0][0], /^START – spis arkuszy/, 'the loser of the race writes into the existing sheet');

    const broken = project();
    const bss = broken.SpreadsheetApp.getActive();
    const brokenGet = bss.getSheetByName;
    bss.getSheetByName = name => (name === START ? null : brokenGet(name));
    bss.insertSheet = () => { throw new Error('brak uprawnień do dodania arkusza'); };
    assert.throws(() => broken.uporzadkujArkusze(), /brak uprawnień do dodania arkusza/);
  });
});

describe('#78: ukrywanie arkuszy technicznych', () => {
  test('T5: ukryj chowa tylko kategorię „dane”, pokaż je przywraca, powtórzenie mówi o braku zmian', () => {
    const gas = project();
    const hidden = plain(gas.ukryjArkuszeTechniczne());
    assert.deepEqual(hidden, ['GSC RAW', 'GA4 RAW', 'IMPORT LOG']);
    const ss = gas.SpreadsheetApp.getActive();
    assert.equal(ss.getSheetByName('GSC RAW').isSheetHidden(), true);
    assert.equal(ss.getSheetByName('WP COMMANDS').isSheetHidden(), false, 'only raw data is hidden');
    assert.equal(ss.getSheetByName('Kierunki SEO').isSheetHidden(), false);
    assert.match(gas.$alerts[0][0], /^Ukryte arkusze z danymi surowymi: GSC RAW, GA4 RAW, IMPORT LOG\.\nPokażesz je z Dane → Pokaż arkusze techniczne\.$/);

    assert.deepEqual(plain(gas.ukryjArkuszeTechniczne()), []);
    assert.match(gas.$alerts[1][0], /są już ukryte\.$/);

    assert.deepEqual(plain(gas.pokazArkuszeTechniczne()), ['GSC RAW', 'GA4 RAW', 'IMPORT LOG']);
    assert.equal(ss.getSheetByName('GSC RAW').isSheetHidden(), false);
    assert.deepEqual(plain(gas.pokazArkuszeTechniczne()), []);
    assert.match(gas.$alerts[3][0], /Żaden arkusz z danymi surowymi nie był ukryty\.$/);
  });

  test('#78/Codex: ukryte arkusze da się przenieść – są pokazywane na czas porządkowania i znów ukrywane', () => {
    // Kolejność odwrotna do docelowej wymusza przeniesienie każdej ukrytej zakładki.
    const gas = loadProject({ sheets: { 'IMPORT LOG': [['Czas']], 'GA4 RAW': [['date']], 'GSC RAW': [['date']], 'Konfiguracja GSC': [['Klucz']], 'Analiza': [['a']] } });
    gas.ukryjArkuszeTechniczne();
    const ss = gas.SpreadsheetApp.getActive();
    const activated = [];
    const realActivate = ss.setActiveSheet;
    ss.setActiveSheet = sh => { activated.push({ name: sh.getName(), hidden: sh.isSheetHidden() }); return realActivate(sh); };

    const out = plain(gas.uporzadkujArkusze());
    assert.ok(activated.length > 0, 'sheets were moved');
    assert.ok(!activated.some(a => a.hidden), 'no hidden sheet was ever activated');
    assert.equal(out.rehidden, 3);
    ['GSC RAW', 'GA4 RAW', 'IMPORT LOG'].forEach(name => assert.equal(ss.getSheetByName(name).isSheetHidden(), true, name + ' hidden again'));
    assert.deepEqual(names(gas), ['START', 'Analiza', 'Konfiguracja GSC', 'GSC RAW', 'GA4 RAW', 'IMPORT LOG']);
  });
});

describe('#78: katalog i menu', () => {
  test('każdy wpis katalogu ma nazwę, znaną kategorię, właściciela i opis; nazwy są unikalne', () => {
    const gas = project();
    const catalog = plain(gas.sheetCatalog_());
    const seen = {};
    catalog.forEach(entry => {
      assert.ok(entry.name, 'name');
      // Nieznana kategoria wraca z fallbacku z label === key; znana ma własną etykietę.
      const category = plain(gas.sheetCategory_(entry.category));
      assert.notEqual(category.label, entry.category, entry.name + ': unknown category ' + entry.category);
      assert.match(entry.owner, /^(skrypt|człowiek|człowiek \+ skrypt)$/, entry.name);
      assert.ok(entry.description.length > 20, entry.name + ': description too short');
      assert.ok(!seen[entry.name], 'duplicate ' + entry.name);
      seen[entry.name] = true;
    });
    assert.equal(catalog.length, 17);
  });

  test('#78/Codex: nadpisane w konfiguracji nazwy arkuszy GA4 trafiają do kategorii „dane”, nie do arkuszy własnych', () => {
    const gas = loadProject({ sheets: {
      'Konfiguracja GA4': [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['landingSheet', 'GA4 LANDING'], ['adsSheet', 'GA4 ADS']],
      'GA4 LANDING': [['date']],
      'GA4 ADS': [['date']],
      'Analiza': [['a']]
    } });
    gas.uporzadkujArkusze();
    const c = colors(gas);
    assert.equal(c['GA4 LANDING'], '#434343');
    assert.equal(c['GA4 ADS'], '#434343');
    assert.equal(c['Analiza'], null);
    assert.deepEqual(names(gas), ['START', 'Analiza', 'Konfiguracja GA4', 'GA4 LANDING', 'GA4 ADS']);
    const rows = plain(gas.$sheet(START)).slice(4);
    assert.equal(rows.find(r => String(r[0]).includes('"GA4 LANDING"'))[1], 'Dane surowe i logi');
    assert.deepEqual(plain(gas.ukryjArkuszeTechniczne()), ['GA4 LANDING', 'GA4 ADS']);

    // Bez arkusza konfiguracji katalog wraca do nazw domyślnych zamiast paść.
    const noConfig = loadProject({ sheets: { 'GA4 RAW': [['date']], 'Analiza': [['a']] } });
    noConfig.uporzadkujArkusze();
    assert.equal(colors(noConfig)['GA4 RAW'], '#434343');
  });

  test('menu Dane ma trzy pozycje porządkowe na końcu', () => {
    const gas = project();
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.deepEqual(dane.items.map(i => i.fn).slice(-3), ['uporzadkujArkuszeZMenu', 'ukryjArkuszeTechniczne', 'pokazArkuszeTechniczne']);
  });
});
