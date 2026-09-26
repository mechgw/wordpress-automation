/**
 * Rejestr zapytań telefonicznych (#196).
 *
 * Klient dzwoni, pyta o trasę, dostaje wycenę i znika, a w żadnych danych nie
 * zostaje ani trasa, ani cena, ani wynik rozmowy. Zakładkę wypełnia człowiek;
 * skrypt zakłada wyłącznie strukturę: nagłówek, zamrożony wiersz, listy wyboru
 * i notatkę o danych osobowych.
 *
 * Czego tu świadomie NIE ma: kolumn na imię, telefon, e-mail i firmę. To rejestr
 * popytu do analityki, nie CRM. Wolny tekst `Uwag` może je mimo to zawierać,
 * więc notatka przy nagłówku mówi wprost, żeby ich tam nie wpisywać.
 */

const PHONE_INQUIRIES_SHEET = 'ZAPYTANIA TELEFONICZNE';
const PHONE_INQUIRIES_HEADER = ['Data', 'Skąd', 'Dokąd', 'Usługa', 'Wycena [zł]', 'Wynik', 'Skąd o nas wie', 'Uwagi'];

/**
 * Słownik usług wspólny z zapisem zleceń z formularza (#195): grupy usług, a nie
 * surowe wartości techniczne formularza, żeby oba źródła dało się zestawić.
 * Poziom szybkości (Standard, Ekspres) trafia do `Uwag`.
 */
const PHONE_INQUIRY_SERVICES = ['miejska', 'podmiejska', 'krajowa', 'kurier dedykowany', 'inne'];
const PHONE_INQUIRY_RESULTS = ['zlecenie', 'za drogo', 'bez odpowiedzi', 'nie obsługujemy', 'inne'];
const PHONE_INQUIRY_SOURCES = ['Google', 'polecenie', 'stały klient', 'inne', 'nie wiem'];

/**
 * Wiersze na wpisy, gdy zakładkę przycięto do samego nagłówka (*Dane → Przytnij
 * puste wiersze*). Walidacja zakresu spoza siatki kończy się wyjątkiem Arkuszy.
 */
const PHONE_INQUIRIES_MIN_ROWS = 100;

const PHONE_INQUIRIES_NOTE =
  'Bez danych osobowych: nie wpisuj tu imion, nazwisk, telefonów, e-maili ani nazw firm. ' +
  'Rejestr służy do liczenia tras, cen i wyników rozmów. Poziom szybkości (np. Standard, Ekspres) wpisuj tutaj.';

/** Menu Dane → Przygotuj rejestr zapytań telefonicznych. */
function przygotujRejestrZapytanTelefonicznych() {
  const result = preparePhoneInquiriesSheet_();
  SpreadsheetApp.getUi().alert(result.message);
  return result;
}

/**
 * Zakłada albo przejmuje zakładkę. Wierszy danych nie rusza nigdy.
 *
 * - brak zakładki: nowa, z nagłówkiem;
 * - pusty wiersz 1: dopisany nagłówek, dane poniżej zostają;
 * - nagłówek zgodny (także zakładka założona ręcznie 2026-09-19): odnowione
 *   walidacje, notatka i zamrożenie;
 * - inny nagłówek: nic nie zmieniamy i mówimy, co się nie zgadza, bo zakładkę
 *   o tej nazwie mógł założyć człowiek do innego celu.
 */
function preparePhoneInquiriesSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(PHONE_INQUIRIES_SHEET);
  let created = false;
  if (!sheet) {
    try {
      sheet = ss.insertSheet(PHONE_INQUIRIES_SHEET);
      created = true;
    } catch (e) {
      // Duplikat z równoległego wykonania: bierzemy zakładkę, która już istnieje.
      sheet = ss.getSheetByName(PHONE_INQUIRIES_SHEET);
      if (!sheet) throw e;
    }
  }

  const width = PHONE_INQUIRIES_HEADER.length;
  // Odczyt tylko w granicach siatki: zakładka węższa niż nagłówek to realny
  // przypadek, a zakres spoza siatki kończy się wyjątkiem zamiast odpowiedzią.
  const seen = sheet.getLastRow() >= 1
    ? sheet.getRange(1, 1, 1, Math.min(Math.max(width, sheet.getLastColumn()), sheet.getMaxColumns())).getValues()[0].map(v => String(v).trim())
    : [];
  if (seen.some(v => v !== '')) {
    const diff = phoneInquiriesHeaderDiff_(seen);
    if (diff.length) {
      return {
        ok: false,
        created: false,
        message: 'Zakładka „' + PHONE_INQUIRIES_SHEET + '” ma inny nagłówek niż rejestr zapytań, więc niczego w niej nie zmieniłem.\n\n' +
          diff.join('\n') + '\n\nOczekiwany nagłówek: ' + PHONE_INQUIRIES_HEADER.join(' | ')
      };
    }
  } else {
    ensureSheetColumns_(sheet, width);
    sheet.getRange(1, 1, 1, width).setValues([PHONE_INQUIRIES_HEADER]);
  }

  ensureSheetRows_(sheet, PHONE_INQUIRIES_MIN_ROWS + 1);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  applyPhoneInquiryValidation_(sheet);
  sheet.getRange(1, PHONE_INQUIRIES_HEADER.indexOf('Uwagi') + 1).setNote(PHONE_INQUIRIES_NOTE);

  const rows = Math.max(sheet.getLastRow() - 1, 0);
  return {
    ok: true,
    created: created,
    message: (created
      ? 'Zakładka „' + PHONE_INQUIRIES_SHEET + '” została założona.'
      : 'Zakładka „' + PHONE_INQUIRIES_SHEET + '” jest gotowa; wpisane wiersze (' + rows + ') zostały bez zmian.') +
      '\n\nListy wyboru: Usługa, Wynik, Skąd o nas wie. Kontrola: Data (data), Wycena [zł] (liczba ≥ 0). ' +
      'Nietypowa wartość zostaje zapisana z ostrzeżeniem, a nie odrzucona.\n\n' +
      'Bez danych osobowych w Uwagach — przypomina o tym notatka przy nagłówku „Uwagi”.'
  };
}

/** Różnice nagłówka jako linie „kolumna X: jest „…”, oczekiwano „…””. */
function phoneInquiriesHeaderDiff_(seen) {
  const out = [];
  const width = Math.max(seen.length, PHONE_INQUIRIES_HEADER.length);
  for (let i = 0; i < width; i++) {
    const expected = PHONE_INQUIRIES_HEADER[i] || '';
    const actual = seen[i] || '';
    if (actual !== expected) {
      out.push('kolumna ' + columnLetter_(i + 1) + ': jest „' + actual + '”, oczekiwano „' + expected + '”');
    }
  }
  return out;
}

/**
 * Reguły na wszystkich wierszach danych zakładki. Ponowne uruchomienie je
 * odnawia, bo `setDataValidation` zastępuje regułę zakresu. Ostrzeżenie zamiast
 * odrzucenia: szybkość wpisywania w trakcie rozmowy jest ważniejsza niż
 * wymuszanie, a nietypowa wartość i tak będzie widoczna.
 */
function applyPhoneInquiryValidation_(sheet) {
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const column = name => sheet.getRange(2, PHONE_INQUIRIES_HEADER.indexOf(name) + 1, rows, 1);
  const warn = builder => builder.setAllowInvalid(true).build();
  const list = values => warn(SpreadsheetApp.newDataValidation().requireValueInList(values, true));

  column('Data').setDataValidation(warn(SpreadsheetApp.newDataValidation().requireDate().setHelpText('Data rozmowy.')));
  column('Usługa').setDataValidation(list(PHONE_INQUIRY_SERVICES));
  column('Wycena [zł]').setDataValidation(warn(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setHelpText('Kwota w złotych: sama liczba, bez „zł”.')
  ));
  column('Wynik').setDataValidation(list(PHONE_INQUIRY_RESULTS));
  column('Skąd o nas wie').setDataValidation(list(PHONE_INQUIRY_SOURCES));
}
