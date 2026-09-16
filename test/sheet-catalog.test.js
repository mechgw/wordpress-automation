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
const LINK_BASE = 'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=';
const gidOf = (gas, name) => gas.SpreadsheetApp.getActive().getSheetByName(name).getSheetId();
/** Kolumna A arkusza START tak, jak widzi ją człowiek: tekst i adres, pod który prowadzi kliknięcie. */
const startColumnA = gas => {
  const sheet = gas.SpreadsheetApp.getActive().getSheetByName(START);
  return sheet.getRange(1, 1, sheet.getLastRow(), 1).getRichTextValues()
    .map(line => ({ text: line[0].getText(), link: line[0].getLinkUrl() }));
};
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

    assert.deepEqual(grid[4], ['Kierunki SEO', 'Analiza (arkusze własne)', 'człowiek', 'Arkusz własny, nie zarządzany przez skrypt.']);
    assert.deepEqual(startColumnA(gas)[4], { text: 'Kierunki SEO', link: LINK_BASE + gidOf(gas, 'Kierunki SEO') });

    const rows = grid.slice(4);
    assert.equal(rows.length, 10, 'every sheet except START');
    assert.ok(!rows.some(r => r[0] === START), 'START does not list itself');
    const raw = rows.find(r => r[0] === 'GSC RAW');
    assert.deepEqual(raw.slice(1), ['Dane surowe i logi', 'skrypt', 'Surowe dane Search Console. Nie edytuj ręcznie.']);
    const commands = rows.find(r => r[0] === 'WP COMMANDS');
    assert.equal(commands[2], 'człowiek + skrypt');
  });

  test('T4b: START jest przepisywany, nie dopisywany: usunięty arkusz znika ze spisu', () => {
    const s = sheets();
    const gas = loadProject({ sheets: s });
    gas.uporzadkujArkusze();
    const first = plain(gas.$sheet(START)).length;
    assert.ok(plain(gas.$sheet(START)).some(r => r[0] === 'Quick wins'), 'warunek wstępny: pierwszy spis zawiera arkusz');

    delete s['Quick wins'];
    delete s['GA4 RAW'];
    const gas2 = loadProject({ sheets: s });
    gas2.uporzadkujArkusze();
    const second = plain(gas2.$sheet(START));
    assert.equal(second.length, first - 2);
    assert.ok(!second.some(r => r[0] === 'Quick wins'));
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

/**
 * #175: kolumna A arkusza START to linki rich text, nie formuły.
 *
 * `=HYPERLINK(…)` zapisane przez `setValues` jest parsowane w ustawieniach
 * regionalnych pliku; przy dziesiętnym przecinku separatorem argumentów jest
 * średnik, więc formuła z przecinkiem dawała `#ERROR!` w każdym wierszu. Testy
 * sprawdzają to, co widzi i klika człowiek — tekst i adres linku — a nie łańcuch
 * formuły, bo stub formuł nie oblicza i żaden test na łańcuch nie wykryłby błędu.
 */
describe('#175: kolumna A arkusza START', () => {
  test('1: każdy wiersz danych prowadzi do SWOJEJ zakładki, a tekstem jest jej nazwa', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const data = startColumnA(gas).slice(4);

    assert.equal(data.length, 10, 'warunek wstępny: spis ma wiersze');
    data.forEach(cell => {
      assert.equal(cell.link, LINK_BASE + gidOf(gas, cell.text), cell.text + ': link do właściwej zakładki');
    });
    assert.equal(new Set(data.map(c => c.link)).size, data.length, 'żadne dwa wiersze nie prowadzą w to samo miejsce');
  });

  test('2: wpis bez istniejącej zakładki to sama nazwa, bez linku i bez błędu', () => {
    const gas = project();
    const plan = [
      { name: START, category: 'start', owner: 'skrypt', description: 'spis' },
      { name: 'Kierunki SEO', category: 'wlasne', owner: 'człowiek', description: 'jest' },
      { name: 'Zakładka usunięta w międzyczasie', category: 'wlasne', owner: 'człowiek', description: 'nie ma' }
    ];
    gas.writeStartSheet_(plan);
    const cells = startColumnA(gas).slice(4);

    assert.deepEqual(cells[0], { text: 'Kierunki SEO', link: LINK_BASE + gidOf(gas, 'Kierunki SEO') });
    assert.deepEqual(cells[1], { text: 'Zakładka usunięta w międzyczasie', link: null });
  });

  test('3: cudzysłów w nazwie trafia do komórki dosłownie — nie jest już fragmentem składni', () => {
    const gas = project({ 'Raport "roczny"': [['a']] });
    gas.uporzadkujArkusze();
    const cell = startColumnA(gas).find(c => c.text.indexOf('roczny') >= 0);

    assert.deepEqual(cell, { text: 'Raport "roczny"', link: LINK_BASE + gidOf(gas, 'Raport "roczny"') });
  });

  test('4: przecinek i średnik w nazwie nie mają znaczenia składniowego', () => {
    const name = 'Koszty; paliwo, opłaty';
    const gas = project({ [name]: [['a']] });
    gas.uporzadkujArkusze();

    assert.deepEqual(startColumnA(gas).find(c => c.text === name), { text: name, link: LINK_BASE + gidOf(gas, name) });
  });

  test('5: podpis, opis i nagłówek to zwykły tekst bez linku', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const head = startColumnA(gas).slice(0, 4);

    assert.match(head[0].text, /^START – spis arkuszy/);
    assert.equal(head[3].text, 'Arkusz');
    head.forEach((cell, i) => assert.equal(cell.link, null, 'wiersz ' + (i + 1) + ' bez linku'));
  });

  test('6: liczba zapisów do START nie rośnie z liczbą zakładek', () => {
    const writes = extra => {
      const gas = project(Object.assign({ [START]: [[SIGNATURE + ' (wersja skryptu: v1.0.0)']] }, extra));
      const sheet = gas.SpreadsheetApp.getActive().getSheetByName(START);
      const real = sheet.getRange.bind(sheet);
      let count = 0;
      sheet.getRange = (...args) => {
        const range = real(...args);
        ['setValues', 'setValue', 'setRichTextValues'].forEach(method => {
          const original = range[method].bind(range);
          range[method] = (...values) => { count++; return original(...values); };
        });
        return range;
      };
      gas.uporzadkujArkusze();
      return count;
    };
    const many = {};
    for (let i = 1; i <= 8; i++) many['Arkusz ' + i] = [['a']];

    assert.equal(writes({}), 2, 'jeden zapis wartości i jeden zapis linków');
    assert.equal(writes(many), 2, 'osiem zakładek więcej, ta sama liczba wywołań');
  });

  test('START nie zawiera ani jednej formuły — niezależnie od ustawień regionalnych pliku', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const sheet = gas.SpreadsheetApp.getActive().getSheetByName(START);
    const values = sheet.getRange(1, 1, sheet.getLastRow(), 4).getValues();

    assert.ok(values.length > 4, 'warunek wstępny: spis ma wiersze');
    assert.deepEqual(values.flat().filter(v => String(v).charAt(0) === '='), [], 'żadna komórka nie jest formułą');
  });

  test('ponowne porządkowanie odtwarza linki — clear() nie zostawia spisu bez nich', () => {
    const gas = project();
    gas.uporzadkujArkusze();
    const first = startColumnA(gas);
    gas.uporzadkujArkusze();

    assert.deepEqual(startColumnA(gas), first);
    assert.ok(first.slice(4).every(c => c.link), 'każdy wiersz danych ma link');
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
      assert.notEqual(entry.category, 'start', entry.name + ': kategoria „start” jest zarezerwowana dla samego arkusza START');
      assert.ok(entry.description.length > 20, entry.name + ': description too short');
      assert.ok(!seen[entry.name], 'duplicate ' + entry.name);
      seen[entry.name] = true;
    });
    assert.equal(catalog.length, 28);
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
    assert.equal(rows.find(r => r[0] === 'GA4 LANDING')[1], 'Dane surowe i logi');
    assert.deepEqual(plain(gas.ukryjArkuszeTechniczne()), ['GA4 LANDING', 'GA4 ADS']);

    // Bez arkusza konfiguracji katalog wraca do nazw domyślnych zamiast paść.
    const noConfig = loadProject({ sheets: { 'GA4 RAW': [['date']], 'Analiza': [['a']] } });
    noConfig.uporzadkujArkusze();
    assert.equal(colors(noConfig)['GA4 RAW'], '#434343');
  });

  test('arkusz człowieka opisany w katalogu trafia do START z własnym opisem, ale nie jest kolorowany ani przenoszony między arkusze skryptu', () => {
    const gas = project({ 'Dziennik zmian': [['Data', 'URL']] });
    const out = plain(gas.uporzadkujArkuszeZMenu());

    assert.equal(colors(gas)['Dziennik zmian'], null, 'kategoria „wlasne” nie ma koloru');
    assert.deepEqual(names(gas).slice(0, 4), ['START', 'Kierunki SEO', 'Quick wins', 'Dziennik zmian'], 'zostaje wśród arkuszy własnych');
    assert.equal(out.own, 3, 'liczony jako arkusz własny, nie skryptu');

    const row = plain(gas.$sheet(START)).slice(4).find(r => r[0] === 'Dziennik zmian');
    assert.deepEqual(row.slice(1), ['Analiza (arkusze własne)', 'człowiek', 'Ręczny rejestr zmian SEO. Kolejka recrawl czyta stąd kolumnę z adresem i kolumnę z datą, więc ich nagłówki mają znaczenie.']);
    assert.equal(plain(gas.ukryjArkuszeTechniczne()).includes('Dziennik zmian'), false, 'nigdy nie jest ukrywany');
  });

  test('#78/Codex: kolizja nazw z konfiguracją GA4 nie odbiera arkuszowi skryptu statusu zarządzanego', () => {
    // Patologiczna, ale możliwa konfiguracja: wyjście GA4 wskazuje nazwę arkusza człowieka.
    const gas = loadProject({ sheets: {
      'Konfiguracja GA4': [['Klucz', 'Wartość'], ['propertyId', 'properties/111'], ['landingSheet', 'Dziennik zmian']],
      'Dziennik zmian': [['date']],
      'Analiza': [['a']]
    } });
    gas.uporzadkujArkusze();

    assert.equal(colors(gas)['Dziennik zmian'], '#434343', 'liczy się wpis arkusza skryptu, nie człowieka');
    const row = plain(gas.$sheet(START)).slice(4).find(r => r[0] === 'Dziennik zmian');
    assert.equal(row[1], 'Dane surowe i logi');
    assert.equal(row[3], 'Surowe dane GA4: strony docelowe. Nie edytuj ręcznie.');
    assert.deepEqual(plain(gas.ukryjArkuszeTechniczne()), ['Dziennik zmian'], 'ukrywanie i opis mówią to samo');
  });

  test('menu Dane ma trzy pozycje porządkowe na końcu', () => {
    const gas = project();
    gas.onOpen();
    const dane = gas.$menus.find(m => m.title === 'Dane');
    assert.deepEqual(dane.items.map(i => i.fn).slice(-3), ['uporzadkujArkuszeZMenu', 'ukryjArkuszeTechniczne', 'pokazArkuszeTechniczne']);
  });
});
