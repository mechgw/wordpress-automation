/**
 * Semantyczne kontrole JSON-LD dla SEO LIVE (#110).
 *
 * Sprawdzenie obecności `@type` chroni przed zniknięciem całego typu danych
 * strukturalnych, ale przepuszcza gorszą klasę regresji: schema jest, tylko
 * opisuje co innego niż strona. Cena w `Offer` inna niż na stronie, pytanie
 * w `FAQPage`, którego w widocznym FAQ nie ma, dwa węzły podające sprzeczne
 * wartości tego samego pola.
 *
 * Zakres świadomie wąski. To kontrola spójności danych, a nie walidator Google
 * Rich Results: wynik nie mówi nic o kwalifikacji do rich resultów ani
 * o rankingu. Reguły opisujące konkretną witrynę żyją w arkuszu, nie w kodzie
 * publicznego repozytorium.
 *
 * Kontrole są opcjonalne. Bez zakładki `SEO SCHEMA` i bez reguł dla danego
 * adresu SEO LIVE działa dokładnie tak jak wcześniej.
 */

const SEO_SCHEMA_SHEET = 'SEO SCHEMA';
const SEO_SCHEMA_HEADER = ['URL', 'Ścieżka w schema', 'Oczekiwanie', 'Źródło', 'Uwagi'];

/** Dozwolone źródła oczekiwania; cokolwiek innego jest błędem konfiguracji. */
const SEO_SCHEMA_SOURCES = ['wartość', 'strona'];

/** Ile znaków wartości pokazujemy w różnicy, żeby nie wkleić całego opisu. */
const SEO_SCHEMA_VALUE_PREVIEW = 120;

/** Zakładka reguł, tworzona na żądanie razem z nagłówkiem. */
function ensureSchemaExpectationsSheet_() {
  return ensureSheetWithHeader_(SEO_SCHEMA_SHEET, SEO_SCHEMA_HEADER);
}

/**
 * Wszystkie węzły JSON-LD ze strony, spłaszczone do jednej listy.
 *
 * `@graph`, tablice na najwyższym poziomie i obiekty zagnieżdżone trafiają do
 * tej samej listy, bo z punktu widzenia kontroli nie ma znaczenia, jak głęboko
 * ktoś umieścił `Offer`. Blok z niepoprawnym JSON-em jest zgłaszany osobno
 * i nie przerywa czytania pozostałych.
 */
function parseJsonLd_(html) {
  const nodes = [];
  const errors = [];
  const blocks = String(html || '').match(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];

  blocks.forEach(function (block, index) {
    const body = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      // Bez treści bloku: bywa długa, a do naprawy wystarczy jego numer.
      errors.push('nieprawidłowy JSON-LD w bloku ' + (index + 1));
      return;
    }
    collectJsonLdNodes_(parsed, nodes);
  });

  return { nodes: nodes, errors: errors };
}

/** Rekurencyjnie zbiera obiekty z `@type`, wchodząc też w @graph i tablice. */
function collectJsonLdNodes_(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Object.prototype.toString.call(value) === '[object Array]') {
    value.forEach(function (item) { collectJsonLdNodes_(item, out); });
    return;
  }
  if (value['@type']) out.push(value);
  Object.keys(value).forEach(function (key) {
    if (key === '@type') return;
    collectJsonLdNodes_(value[key], out);
  });
}

/** Typy węzła jako lista; `@type` bywa tekstem albo tablicą. */
function jsonLdTypes_(node) {
  const raw = node && node['@type'];
  if (!raw) return [];
  const list = Object.prototype.toString.call(raw) === '[object Array]' ? raw : [raw];
  return list.map(function (t) { return String(t); }).filter(Boolean);
}

/** Wszystkie typy występujące na stronie, bez powtórzeń, w kolejności wystąpienia. */
function jsonLdTypeList_(nodes) {
  const types = [];
  nodes.forEach(function (node) {
    jsonLdTypes_(node).forEach(function (type) {
      if (types.indexOf(type) < 0) types.push(type);
    });
  });
  return types;
}

/**
 * Wartości spod ścieżki `Typ.pole.podpole`.
 *
 * Pierwszy segment wybiera węzły po `@type`, reszta schodzi w głąb. Tablice po
 * drodze są rozwijane, więc `FAQPage.mainEntity.name` zwraca wszystkie pytania
 * naraz. Zwracamy teksty, bo porównujemy je z treścią strony i z oczekiwaniem
 * wpisanym w komórce.
 */
function schemaValuesAtPath_(nodes, path) {
  const parts = String(path || '').split('.').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length < 2) return [];

  const type = parts[0];
  let current = nodes.filter(function (node) { return jsonLdTypes_(node).indexOf(type) >= 0; });

  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    const next = [];
    current.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const value = item[key];
      if (value === undefined || value === null) return;
      if (Object.prototype.toString.call(value) === '[object Array]') next.push.apply(next, value);
      else next.push(value);
    });
    current = next;
  }

  return current
    .filter(function (v) { return v !== null && v !== undefined && typeof v !== 'object'; })
    .map(function (v) { return String(v).trim(); })
    .filter(Boolean);
}

/** Widoczny tekst strony: bez skryptów, stylów i znaczników. */
function visiblePageText_(html) {
  const stripped = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return seoLiveText_(stripped);
}

/** Porównanie odporne na wielkość liter, spacje i typ cudzysłowu. */
function schemaNormalize_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[„”"']/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Skrócona wartość do komunikatu, żeby długi opis nie zalał kolumny różnic. */
function schemaPreview_(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return text.length > SEO_SCHEMA_VALUE_PREVIEW
    ? text.slice(0, SEO_SCHEMA_VALUE_PREVIEW) + '…'
    : text;
}

/**
 * Reguły z zakładki, zgrupowane po znormalizowanym adresie. Wiersz bez adresu
 * dotyczy wszystkich stron, co pozwala opisać regułę wspólną raz.
 */
function schemaExpectations_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SEO_SCHEMA_SHEET);
  const byUrl = { '': [] };
  if (!sheet || sheet.getLastRow() < 2) return byUrl;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, SEO_SCHEMA_HEADER.length).getValues();
  rows.forEach(function (row) {
    const path = String(row[1] || '').trim();
    if (!path) return;
    const url = String(row[0] || '').trim();
    const key = url ? seoLiveNormalizeUrl_(url) : '';
    if (!byUrl[key]) byUrl[key] = [];
    byUrl[key].push({
      path: path,
      expected: String(row[2] === null || row[2] === undefined ? '' : row[2]).trim(),
      source: String(row[3] || '').trim().toLowerCase()
    });
  });
  return byUrl;
}

/** Reguły obowiązujące dany adres: wspólne plus przypisane wprost do niego. */
function schemaRulesFor_(expectations, url) {
  const common = expectations[''] || [];
  const own = expectations[seoLiveNormalizeUrl_(url)] || [];
  return common.concat(own);
}

/**
 * Różnice semantyczne dla jednej strony. Każdy rodzaj problemu ma inny
 * początek komunikatu, żeby dało się je odróżnić w kolumnie różnic:
 * nieprawidłowy JSON-LD, brak wartości, sprzeczne wartości, niezgodna wartość.
 */
function schemaSemanticDiffs_(html, nodes, errors, rules) {
  const diffs = errors.map(function (e) { return 'schema: ' + e; });
  if (!rules.length) return diffs;

  const text = schemaNormalize_(visiblePageText_(html));

  rules.forEach(function (rule) {
    if (SEO_SCHEMA_SOURCES.indexOf(rule.source) < 0) {
      diffs.push('schema ' + rule.path + ': nieznane źródło „' + rule.source +
        '” (dozwolone: ' + SEO_SCHEMA_SOURCES.join(', ') + ')');
      return;
    }

    const values = schemaValuesAtPath_(nodes, rule.path);
    if (!values.length) {
      diffs.push('schema ' + rule.path + ': brak wartości w JSON-LD');
      return;
    }

    // Sprzeczność sprawdzamy zawsze: dwa węzły podające co innego o tym samym
    // polu są problemem niezależnie od tego, czy któryś zgadza się z regułą.
    const distinct = [];
    values.forEach(function (v) {
      if (distinct.filter(function (d) { return schemaNormalize_(d) === schemaNormalize_(v); }).length === 0) {
        distinct.push(v);
      }
    });
    if (rule.source === 'wartość' && distinct.length > 1) {
      diffs.push('schema ' + rule.path + ': sprzeczne wartości w JSON-LD: ' +
        distinct.map(function (v) { return '„' + schemaPreview_(v) + '”'; }).join(', '));
      return;
    }

    if (rule.source === 'wartość') {
      if (schemaNormalize_(distinct[0]) !== schemaNormalize_(rule.expected)) {
        diffs.push('schema ' + rule.path + ': „' + schemaPreview_(distinct[0]) +
          '” (oczekiwano „' + schemaPreview_(rule.expected) + '”)');
      }
      return;
    }

    // Źródło „strona”: każda wartość z JSON-LD musi być widoczna na stronie.
    const missing = values.filter(function (v) { return text.indexOf(schemaNormalize_(v)) < 0; });
    missing.forEach(function (v) {
      diffs.push('schema ' + rule.path + ': „' + schemaPreview_(v) + '” nie występuje w widocznej treści');
    });
  });

  return diffs;
}

/** Menu: przygotowuje zakładkę reguł i tłumaczy jej format. */
function przygotujRegulySchema() {
  const sheet = ensureSchemaExpectationsSheet_();
  const existing = Math.max(0, sheet.getLastRow() - 1);
  SpreadsheetApp.getUi().alert([
    'Zakładka „' + SEO_SCHEMA_SHEET + '” jest gotowa (reguł: ' + existing + ').',
    '',
    'Kolumny:',
    '• URL – adres, którego dotyczy reguła; puste = wszystkie strony.',
    '• Ścieżka w schema – Typ.pole, np. Offer.price albo FAQPage.mainEntity.name.',
    '• Oczekiwanie – wartość, z którą porównujemy (tylko dla źródła „wartość”).',
    '• Źródło – „wartość” albo „strona”.',
    '',
    'Źródło „wartość” porównuje schema z tym, co wpiszesz, i zgłasza sprzeczne',
    'wartości w kilku węzłach. Źródło „strona” wymaga, żeby każda wartość',
    'z JSON-LD była widoczna w treści strony.',
    '',
    'To kontrola spójności danych, nie walidator rich resultów.'
  ].join('\n'));
  return sheet;
}
