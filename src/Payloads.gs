/**
 * Duże payloady treści strony, poza limitem komórki Arkuszy (#109).
 *
 * `UPDATE_PAGE_FIELD` bierze wartość z jednej komórki `WP COMMANDS`, a komórka
 * mieści 50 000 znaków. Pełna wymiana treści długiej strony była więc
 * niewykonalna, mimo że WordPress przyjąłby większy `post_content`.
 *
 * Nośnikiem jest osobna zakładka, a nie plik na Dysku. Dysk wymagałby nowego
 * zakresu OAuth i ponownej autoryzacji projektu, a payload i tak jest treścią
 * strony, która należy do tego samego arkusza co reszta pracy. Zakładka dzieli
 * treść na części po jednej komórce każda i skleja je w kolejności.
 *
 * W `WP COMMANDS` zostaje wyłącznie referencja `payload:<id>`, zgodnie
 * z wymaganiem, żeby komenda trzymała metadane, a nie wielki HTML.
 */

const WP_PAYLOADS_SHEET = 'WP PAYLOADS';
const WP_PAYLOADS_HEADER = ['payload_id', 'part', 'content', 'note'];

/**
 * Sufit rozmiaru sklejonego payloadu. Nie chroni Arkuszy, tylko nas: żądanie
 * o kilka megabajtów i tak skończyłoby się limitem UrlFetchApp albo czasem
 * wykonania, a jasny komunikat jest lepszy niż wyjątek z połowy operacji.
 */
const WP_PAYLOAD_MAX_CHARS = 2000000;

/** Podpowiedź w menu: bezpieczny rozmiar jednej części, z zapasem na komórkę. */
const WP_PAYLOAD_MAX_CELL_HINT = 45000;

/** Referencja do payloadu; celowo wąska, żeby nie pomylić jej z treścią strony. */
const WP_PAYLOAD_REFERENCE = /^payload:([A-Za-z0-9_-]{1,64})$/;

/** Czy wartość komendy jest referencją do payloadu, a nie samą treścią. */
function isPayloadReference_(value) {
  return WP_PAYLOAD_REFERENCE.test(String(value === null || value === undefined ? '' : value).trim());
}

/** Zakładka payloadów, tworzona na żądanie razem z nagłówkiem. */
function ensurePayloadsSheet_() {
  return ensureSheetWithHeader_(WP_PAYLOADS_SHEET, WP_PAYLOADS_HEADER);
}

/**
 * Menu: przygotowuje zakładkę i tłumaczy sposób użycia. Bez tego trzeba by
 * odtworzyć nagłówki ręcznie, co przy literówce kończy się niejasnym błędem.
 */
function przygotujZakladkePayloadow() {
  const sheet = ensurePayloadsSheet_();
  const existing = Math.max(0, sheet.getLastRow() - 1);
  SpreadsheetApp.getUi().alert([
    'Zakładka „' + WP_PAYLOADS_SHEET + '” jest gotowa (wierszy z danymi: ' + existing + ').',
    '',
    'Jak jej użyć:',
    '1. Wpisz własny identyfikator w kolumnie payload_id, np. strona-glowna.',
    '2. Podziel treść na części po najwyżej ' + WP_PAYLOAD_MAX_CELL_HINT + ' znaków i wpisz je',
    '   w kolejnych wierszach, numerując part od 1 bez luk i duplikatów.',
    '3. W „WP COMMANDS” użyj akcji UPDATE_PAGE_FIELD, pola content i wartości',
    '   payload:<identyfikator>.',
    '',
    'Części są sklejane w kolejności numerów. Limit całości to ' + WP_PAYLOAD_MAX_CHARS + ' znaków.'
  ].join('\n'));
  return sheet;
}

/**
 * Skraca treść do krótkiego skrótu SHA-256. Służy do porównania po zapisie
 * i do opisu w trybie próbnym: rozmiar i skrót mówią wszystko, co potrzebne,
 * nie wypisując treści do arkusza ani do logów.
 */
function contentDigest_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text === null || text === undefined ? '' : text));
  return bytes.map(function (b) {
    return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1);
  }).join('').slice(0, 16);
}

/**
 * Normalizacja przed porównaniem. WordPress potrafi oddać treść z innym
 * znakiem końca linii albo bez końcowej pustej linii; to nie jest rozjazd
 * treści, tylko zapis. Wszystko inne pozostaje istotne.
 */
function normalizeContentForCompare_(text) {
  return String(text === null || text === undefined ? '' : text).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Skleja payload z części. Waliduje kompletność ZANIM cokolwiek się wydarzy:
 * brakująca część w środku dałaby stronę z dziurą w treści, a to gorsze niż
 * odmowa wykonania komendy.
 */
function resolvePayload_(value) {
  const match = WP_PAYLOAD_REFERENCE.exec(String(value === null || value === undefined ? '' : value).trim());
  if (!match) throw new Error('To nie jest referencja do payloadu: ' + value);
  const id = match[1];

  const sheet = SpreadsheetApp.getActive().getSheetByName(WP_PAYLOADS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    throw new Error('Brak zakładki „' + WP_PAYLOADS_SHEET + '” albo jest pusta. Payload ' + id + ' nie istnieje.');
  }

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, WP_PAYLOADS_HEADER.length).getValues();
  const parts = [];
  rows.forEach(function (row) {
    if (String(row[0] || '').trim() !== id) return;
    const part = Number(row[1]);
    if (!(part >= 1) || Math.floor(part) !== part) {
      throw new Error('Payload ' + id + ': numer części musi być liczbą całkowitą od 1, jest „' + row[1] + '”.');
    }
    parts.push({ part: part, text: String(row[2] === null || row[2] === undefined ? '' : row[2]) });
  });

  if (!parts.length) throw new Error('Payload ' + id + ' nie ma żadnych części w zakładce „' + WP_PAYLOADS_SHEET + '”.');

  parts.sort(function (a, b) { return a.part - b.part; });
  parts.forEach(function (entry, index) {
    if (entry.part !== index + 1) {
      throw new Error(
        'Payload ' + id + ' ma niekompletne części: oczekiwano ' + (index + 1) + ', jest ' + entry.part +
        '. Części muszą iść po kolei od 1, bez luk i duplikatów.'
      );
    }
  });

  const text = parts.map(function (entry) { return entry.text; }).join('');
  if (text.length > WP_PAYLOAD_MAX_CHARS) {
    throw new Error(
      'Payload ' + id + ' ma ' + text.length + ' znaków, a limit to ' + WP_PAYLOAD_MAX_CHARS + '.'
    );
  }
  if (!text.length) throw new Error('Payload ' + id + ' jest pusty. Do wyczyszczenia treści użyj pustej wartości, nie payloadu.');

  return { id: id, text: text, parts: parts.length, chars: text.length, digest: contentDigest_(text) };
}

/** Opis payloadu do komunikatów: bez treści, za to z rozmiarem i skrótem. */
function payloadSummaryText_(payload) {
  return 'payload ' + payload.id + ': ' + payload.parts + ' część(i), ' +
    payload.chars + ' znaków, skrót ' + payload.digest;
}
