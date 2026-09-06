'use strict';

/**
 * #110: semantyczne kontrole JSON-LD.
 *
 * Sprawdzenie obecności `@type` przepuszcza gorszą regresję: schema jest, tylko
 * opisuje co innego niż strona. Te testy pilnują, że wykrywamy rozjazd, i że
 * bez konfiguracji nic się nie zmienia.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SCHEMA = 'SEO SCHEMA';
const SCHEMA_HEADER = ['URL', 'Ścieżka w schema', 'Oczekiwanie', 'Źródło', 'Uwagi'];

const ldBlock = json => '<script type="application/ld+json">' + json + '</script>';
const gas = (rules = []) => loadProject({ sheets: rules.length ? { [SCHEMA]: [SCHEMA_HEADER, ...rules] } : {} });

describe('#110: parser JSON-LD', () => {
  test('spłaszcza @graph, tablice i węzły zagnieżdżone do jednej listy', () => {
    const html =
      ldBlock('{"@graph":[{"@type":"WebPage","name":"Strona"},{"@type":"Organization","name":"Firma"}]}') +
      ldBlock('[{"@type":"Product","offers":{"@type":"Offer","price":"100"}}]');
    const out = plain(gas().parseJsonLd_(html));
    assert.deepEqual(out.errors, []);
    assert.deepEqual(plain(gas().jsonLdTypeList_(out.nodes)), ['WebPage', 'Organization', 'Product', 'Offer']);
  });

  test('tablica w @type daje wszystkie typy', () => {
    const out = plain(gas().parseJsonLd_(ldBlock('{"@type":["LocalBusiness","Organization"],"name":"X"}')));
    assert.deepEqual(plain(gas().jsonLdTypeList_(out.nodes)), ['LocalBusiness', 'Organization']);
  });

  test('uszkodzony blok jest zgłaszany z numerem i nie zatrzymuje pozostałych', () => {
    const html = ldBlock('{to nie jest json}') + ldBlock('{"@type":"WebPage"}');
    const out = plain(gas().parseJsonLd_(html));
    assert.deepEqual(out.errors, ['nieprawidłowy JSON-LD w bloku 1']);
    assert.deepEqual(plain(gas().jsonLdTypeList_(out.nodes)), ['WebPage'], 'drugi blok został przeczytany');
  });

  test('komunikat o uszkodzonym bloku nie zawiera jego treści', () => {
    const out = plain(gas().parseJsonLd_(ldBlock('{"sekret":"nie-do-wypisania",,,}')));
    assert.doesNotMatch(out.errors[0], /sekret/);
  });

  test('strona bez JSON-LD to pusty wynik, nie błąd', () => {
    const out = plain(gas().parseJsonLd_('<html><body>nic</body></html>'));
    assert.deepEqual(out.nodes, []);
    assert.deepEqual(out.errors, []);
  });
});

describe('#110: ścieżki w schema', () => {
  const nodes = () => plain(gas().parseJsonLd_(
    ldBlock(JSON.stringify({
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'Ile to trwa?' },
        { '@type': 'Question', name: 'Ile kosztuje?' }
      ]
    })) +
    ldBlock(JSON.stringify({ '@type': 'Product', offers: { '@type': 'Offer', price: '100', priceCurrency: 'PLN' } }))
  )).nodes;

  test('rozwija tablice, więc jedna ścieżka zwraca wszystkie pytania', () => {
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'FAQPage.mainEntity.name')), ['Ile to trwa?', 'Ile kosztuje?']);
  });

  test('sięga do węzła zagnieżdżonego wprost po jego typie', () => {
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'Offer.price')), ['100']);
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'Offer.priceCurrency')), ['PLN']);
  });

  test('nieznany typ, nieznane pole i ścieżka bez kropki dają pustą listę', () => {
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'Recipe.name')), []);
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'Offer.brakTakiego')), []);
    assert.deepEqual(plain(gas().schemaValuesAtPath_(nodes(), 'Offer')), []);
  });
});

describe('#110: reguły spójności', () => {
  const html = types =>
    '<html><body><h1>Oferta</h1><p>Cena: 100 zł</p><p>Ile to trwa?</p>' + types + '</body></html>';
  const check = (page, rules) => {
    const project = gas();
    const parsed = plain(project.parseJsonLd_(page));
    return plain(project.schemaSemanticDiffs_(page, parsed.nodes, parsed.errors, rules));
  };

  test('źródło „strona”: wartość obecna w widocznej treści przechodzi', () => {
    const page = html(ldBlock('{"@type":"FAQPage","mainEntity":{"@type":"Question","name":"Ile to trwa?"}}'));
    assert.deepEqual(check(page, [{ path: 'FAQPage.mainEntity.name', expected: '', source: 'strona' }]), []);
  });

  test('źródło „strona”: pytanie spoza widocznej treści jest różnicą', () => {
    const page = html(ldBlock('{"@type":"FAQPage","mainEntity":{"@type":"Question","name":"Czy dowozicie na Marsa?"}}'));
    const diffs = check(page, [{ path: 'FAQPage.mainEntity.name', expected: '', source: 'strona' }]);
    assert.equal(diffs.length, 1);
    assert.match(diffs[0], /^schema FAQPage\.mainEntity\.name: „Czy dowozicie na Marsa\?” nie występuje w widocznej treści$/);
  });

  test('źródło „strona” nie daje się nabrać na tekst ukryty w samym JSON-LD', () => {
    // Wartość jest w bloku schema, ale nie w treści: skrypty są wycinane
    // z widocznego tekstu, więc nie mogą potwierdzać same siebie.
    const page = '<html><body><p>nic</p>' + ldBlock('{"@type":"Offer","price":"999"}') + '</body></html>';
    const diffs = check(page, [{ path: 'Offer.price', expected: '', source: 'strona' }]);
    assert.equal(diffs.length, 1);
  });

  test('źródło „wartość”: zgodna cena przechodzi, niezgodna jest różnicą', () => {
    const page = html(ldBlock('{"@type":"Offer","price":"100"}'));
    assert.deepEqual(check(page, [{ path: 'Offer.price', expected: '100', source: 'wartość' }]), []);
    const diffs = check(page, [{ path: 'Offer.price', expected: '120', source: 'wartość' }]);
    assert.match(diffs[0], /^schema Offer\.price: „100” \(oczekiwano „120”\)$/);
  });

  test('porównanie ignoruje wielkość liter, spacje i rodzaj cudzysłowu', () => {
    const page = html(ldBlock('{"@type":"Organization","name":"  Firma   Testowa "}'));
    assert.deepEqual(check(page, [{ path: 'Organization.name', expected: 'firma testowa', source: 'wartość' }]), []);
  });

  test('dwa węzły ze sprzecznymi wartościami są zgłaszane jako sprzeczność', () => {
    const page = html(ldBlock('{"@type":"Offer","price":"100"}') + ldBlock('{"@type":"Offer","price":"120"}'));
    const diffs = check(page, [{ path: 'Offer.price', expected: '100', source: 'wartość' }]);
    assert.equal(diffs.length, 1);
    assert.match(diffs[0], /^schema Offer\.price: sprzeczne wartości w JSON-LD: „100”, „120”$/);
  });

  test('dwa węzły z tą samą wartością nie są sprzecznością', () => {
    const page = html(ldBlock('{"@type":"Offer","price":"100"}') + ldBlock('{"@type":"Offer","price":"100"}'));
    assert.deepEqual(check(page, [{ path: 'Offer.price', expected: '100', source: 'wartość' }]), []);
  });

  test('brak wartości pod ścieżką to osobny rodzaj różnicy', () => {
    const page = html(ldBlock('{"@type":"Offer","priceCurrency":"PLN"}'));
    const diffs = check(page, [{ path: 'Offer.price', expected: '100', source: 'wartość' }]);
    assert.match(diffs[0], /^schema Offer\.price: brak wartości w JSON-LD$/);
  });

  test('nieznane źródło jest błędem konfiguracji, nie cichym pominięciem', () => {
    const page = html(ldBlock('{"@type":"Offer","price":"100"}'));
    const diffs = check(page, [{ path: 'Offer.price', expected: '100', source: 'widoczne' }]);
    assert.match(diffs[0], /nieznane źródło „widoczne” \(dozwolone: wartość, strona\)/);
  });

  test('uszkodzony blok jest różnicą nawet bez żadnych reguł', () => {
    const page = html(ldBlock('{zepsute}'));
    assert.deepEqual(check(page, []), ['schema: nieprawidłowy JSON-LD w bloku 1']);
  });

  test('bardzo długa wartość jest skracana w komunikacie', () => {
    const long = 'a'.repeat(300);
    const page = html(ldBlock(JSON.stringify({ '@type': 'Offer', price: long })));
    const diffs = check(page, [{ path: 'Offer.price', expected: 'x', source: 'wartość' }]);
    assert.match(diffs[0], /…/);
    assert.ok(diffs[0].length < 200, 'komunikat nie może zawierać całej wartości');
  });
});

describe('#110: konfiguracja z zakładki', () => {
  test('reguła bez adresu dotyczy wszystkich stron, z adresem tylko jego', () => {
    const project = gas([
      ['', 'Offer.price', '100', 'wartość', ''],
      ['https://www.example.pl/a/', 'Organization.name', 'Firma', 'wartość', '']
    ]);
    const all = plain(project.schemaExpectations_());
    assert.equal(all[''].length, 1);
    const forA = plain(project.schemaRulesFor_(all, 'https://www.example.pl/a/'));
    assert.deepEqual(forA.map(r => r.path), ['Offer.price', 'Organization.name']);
    const forB = plain(project.schemaRulesFor_(all, 'https://www.example.pl/b/'));
    assert.deepEqual(forB.map(r => r.path), ['Offer.price']);
  });

  test('adres jest dopasowywany po normalizacji, więc końcowy ukośnik nie ma znaczenia', () => {
    const project = gas([['https://www.example.pl/a', 'Offer.price', '1', 'wartość', '']]);
    const rules = plain(project.schemaRulesFor_(plain(project.schemaExpectations_()), 'https://www.example.pl/a/'));
    assert.equal(rules.length, 1);
  });

  test('wiersz bez ścieżki jest pomijany, a brak zakładki nie jest błędem', () => {
    const project = gas([['', '', 'cokolwiek', 'wartość', '']]);
    assert.deepEqual(plain(project.schemaExpectations_())[''], []);
    assert.deepEqual(plain(gas().schemaExpectations_()), { '': [] }, 'bez zakładki brak reguł');
  });

  test('menu tworzy zakładkę z nagłówkiem i opisuje format', () => {
    const project = gas();
    project.przygotujRegulySchema();
    assert.deepEqual(project.$sheet(SCHEMA)[0], SCHEMA_HEADER);
    const text = project.$alerts[0][0];
    assert.match(text, /Źródło – „wartość” albo „strona”/);
    assert.match(text, /nie walidator rich resultów/);
  });
});
