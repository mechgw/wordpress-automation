'use strict';

/**
 * #53: live SEO regression check – strona live vs oczekiwania w arkuszu SEO LIVE.
 * Atrapa HTTP: fetchRouter po adresie, HTML w fixture, przekierowania przez Location.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SHEET = 'SEO LIVE';
const HEADER = ['URL', 'Oczekiwany status HTTP', 'Oczekiwany URL docelowy', 'Oczekiwany title', 'Oczekiwany H1', 'Oczekiwany canonical', 'Oczekiwane robots', 'Oczekiwane schema (@type)', 'Wynik (live)', 'Różnice', 'Sprawdzono', 'Indeks Google (URL INSPEKCJA)'];
const A = 'https://www.example.pl/a/';
const B = 'https://www.example.pl/b/';

function page(opts = {}) {
  const title = opts.title === undefined ? 'Strona A – Example' : opts.title;
  const h1 = opts.h1 === undefined ? 'Strona A' : opts.h1;
  const canonical = opts.canonical === undefined ? A : opts.canonical;
  const robots = opts.robots === undefined ? 'index, follow' : opts.robots;
  return '<!doctype html><html><head>' +
    (title === null ? '' : '<title>' + title + '</title>') +
    (canonical === null ? '' : '<link rel="canonical" href="' + canonical + '" />') +
    (robots === null ? '' : '<meta name="robots" content="' + robots + '">') +
    (opts.schema || '') +
    '</head><body>' +
    (h1 === null ? '' : '<h1 class="x">' + h1 + '</h1>') +
    '<p>treść</p></body></html>';
}

const html = (body, code = 200, headers = {}) => ({ code, text: body, headers: Object.assign({ 'Content-Type': 'text/html' }, headers) });
const redirect = (location, code = 301) => ({ code, text: '', headers: { Location: location } });

function project(rows, routes, opts = {}) {
  const sheets = Object.assign({}, opts.sheets || {});
  if (rows) sheets[SHEET] = [HEADER, ...rows];
  return loadProject(Object.assign({}, opts, {
    sheets,
    fetch: (url, params) => {
      const r = routes[url];
      if (r === undefined) throw new Error('no fixture for ' + url);
      return typeof r === 'function' ? r(url, params) : r;
    }
  }));
}

const row = (url, extra = {}) => [
  url, extra.status ?? '', extra.target ?? '', extra.title ?? '', extra.h1 ?? '', extra.canonical ?? '', extra.robots ?? '', extra.schema ?? '',
  extra.result ?? '', extra.diffs ?? '', extra.checked ?? '', extra.index ?? ''
];
const result = (gas, i = 1) => plain(gas.$sheet(SHEET)[i].slice(8, 12));

describe('live check: zgodność i różnice', () => {
  test('T1: strona zgodna z oczekiwaniami → OK, pusta kolumna różnic, czas, brak w URL INSPEKCJA', () => {
    const gas = project([row(A, { title: 'Strona A – Example', h1: 'Strona A', canonical: A })], { [A]: html(page()) });
    const out = plain(gas.sprawdzStronyLive());
    assert.equal(out.ok, 1);
    assert.equal(out.warnings, 0);
    const [res, diffs, checked, index] = result(gas);
    assert.equal(res, 'OK');
    assert.equal(diffs, '');
    assert.match(checked, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal(index, 'brak w URL INSPEKCJA');
    const call = gas.$fetchCalls[0];
    assert.equal(call.params.followRedirects, false, 'redirects are followed by hand to compare the target');
    assert.equal(call.params.muteHttpExceptions, true);
    assert.match(gas.$alerts[0][0], /^Live SEO check \(stan opublikowanej strony teraz; stan w indeksie Google jest w kolumnie L\):\nSprawdzono: 1 \| OK: 1 \| UWAGA: 0 \| BŁĄD: 0$/);
  });

  test('puste oczekiwania sprawdzają tylko status 200, brak przekierowania i brak noindex', () => {
    const gas = project([row(A)], { [A]: html(page({ title: 'cokolwiek', h1: null, canonical: null })) });
    gas.sprawdzStronyLive();
    assert.equal(result(gas)[0], 'OK');
  });

  test('T2: noindex tam, gdzie nie powinno → UWAGA z treścią meta', () => {
    const gas = project([row(A)], { [A]: html(page({ robots: 'noindex, nofollow' })) });
    gas.sprawdzStronyLive();
    const [res, diffs] = result(gas);
    assert.equal(res, 'UWAGA: 1 różnic(e)');
    assert.equal(diffs, 'robots: noindex [noindex, nofollow] (oczekiwano index)');
  });

  test('T2b: oczekiwany noindex spełniony przez meta googlebot albo nagłówek X-Robots-Tag → OK; brak → różnica', () => {
    const gas = project(
      [row(A, { robots: 'noindex' }), row(B, { robots: 'noindex' }), row('https://www.example.pl/c/', { robots: 'noindex' })],
      {
        [A]: html(page({ robots: null }).replace('</head>', '<meta name="googlebot" content="noindex"></head>')),
        [B]: html(page({ robots: null }), 200, { 'x-robots-tag': 'noindex' }),
        'https://www.example.pl/c/': html(page({ robots: null }))
      }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[0], 'OK');
    assert.equal(result(gas, 2)[0], 'OK');
    assert.equal(result(gas, 3)[1], 'robots: index [brak meta robots] (oczekiwano noindex)');
  });

  test('T3: canonical inny niż oczekiwany → różnica; różnica tylko w końcowym ukośniku lub wielkości hosta nie jest różnicą', () => {
    const gas = project(
      [row(A, { canonical: A }), row(B, { canonical: 'https://WWW.example.pl/b' })],
      { [A]: html(page({ canonical: B })), [B]: html(page({ canonical: B })) }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[1], 'canonical: ' + B + ' (oczekiwano ' + A + ')');
    assert.equal(result(gas, 2)[0], 'OK');
  });

  test('T3b: brak tagu canonical przy oczekiwaniu → „brak”', () => {
    const gas = project([row(A, { canonical: A })], { [A]: html(page({ canonical: null })) });
    gas.sprawdzStronyLive();
    assert.equal(result(gas)[1], 'canonical: brak (oczekiwano ' + A + ')');
  });

  test('T4: 301 na inny cel niż oczekiwany → różnica z łańcuchem; 301 na oczekiwany cel → OK; względny Location jest rozwiązywany', () => {
    const OLD = 'https://www.example.pl/stara/';
    const gas = project(
      [
        row(OLD, { status: 200, target: A }),
        row('https://www.example.pl/rel/', { target: 'https://www.example.pl/rel/nowa/' }),
        row('https://www.example.pl/root/', { target: A })
      ],
      {
        [OLD]: redirect(B),
        [B]: html(page({ canonical: B })),
        'https://www.example.pl/rel/': redirect('nowa/', 302),
        'https://www.example.pl/rel/nowa/': html(page()),
        'https://www.example.pl/root/': redirect('/a/', 308),
        [A]: html(page())
      }
    );
    const out = plain(gas.sprawdzStronyLive());
    assert.equal(out.warnings, 1);
    assert.equal(result(gas, 1)[1], 'cel: ' + B + ' (oczekiwano ' + A + '; łańcuch: ' + OLD + ' → ' + B + ')');
    assert.equal(result(gas, 2)[0], 'OK', 'relative Location resolved against the directory');
    assert.equal(result(gas, 3)[0], 'OK', 'absolute-path Location resolved against the origin');
  });

  test('T4b: przekierowanie tam, gdzie oczekiwano braku, i status inny niż oczekiwany', () => {
    const gas = project(
      [row(A), row(B, { status: 410 })],
      { [A]: redirect(B), [B]: html('<html><title>Gone</title></html>', 404) }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[1], 'status: 404 (oczekiwano 200); cel: ' + B + ' (oczekiwano ' + A + '; łańcuch: ' + A + ' → ' + B + ')');
    assert.equal(result(gas, 2)[1], 'status: 404 (oczekiwano 410)');
  });

  test('T5: inny title, brak H1 i title z encjami → różnice z cytatami', () => {
    const gas = project(
      [row(A, { title: 'Strona A – Example', h1: 'Strona A' }), row(B, { title: 'Kurier & Spółka', h1: 'Kurier' })],
      {
        [A]: html(page({ title: 'Inny tytuł', h1: null, canonical: null })),
        [B]: html(page({ title: 'Kurier &amp; Sp&oacute;łka'.replace('&oacute;', '&#243;'), h1: '<span>Kurier</span>', canonical: null }))
      }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[0], 'UWAGA: 2 różnic(e)');
    assert.equal(result(gas, 1)[1], 'title: „Inny tytuł” (oczekiwano „Strona A – Example”); H1: brak (oczekiwano „Strona A”)');
    assert.equal(result(gas, 2)[0], 'OK', 'entities decoded, inner tags stripped');
  });

  test('schema: wymagane @type muszą być w JSON-LD (także w tablicy @type); brak → różnica z tym, co znaleziono', () => {
    const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"X"},{"@type":["WebPage","FAQPage"]}]}</script>';
    const gas = project(
      [row(A, { schema: 'Organization, FAQPage' }), row(B, { schema: 'LocalBusiness' })],
      { [A]: html(page({ schema: ld })), [B]: html(page({ schema: ld })) }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[0], 'OK');
    assert.equal(result(gas, 2)[1], 'schema: brak @type LocalBusiness (znaleziono: Organization, WebPage, FAQPage)');
    const none = project([row(A, { schema: 'Organization' })], { [A]: html(page()) });
    none.sprawdzStronyLive();
    assert.equal(result(none)[1], 'schema: brak @type Organization (znaleziono: nic)');
  });
});

describe('live check: błędy, lista, indeks', () => {
  test('T6: wyjątek sieci dla jednego adresu → BŁĄD w wierszu, reszta OK, okno wymienia problemy', () => {
    const gas = project(
      [row(A), row(B), row('https://www.example.pl/c/')],
      {
        [A]: html(page()),
        [B]: () => { throw new Error('Timeout: Address unavailable'); },
        'https://www.example.pl/c/': html(page({ canonical: null }))
      }
    );
    const out = plain(gas.sprawdzStronyLive());
    assert.deepEqual([out.ok, out.warnings, out.errors], [2, 0, 1]);
    assert.deepEqual(result(gas, 2).slice(0, 2), ['BŁĄD', 'Timeout: Address unavailable']);
    assert.equal(result(gas, 3)[0], 'OK');
    assert.match(gas.$alerts[0][0], /BŁĄD: 1\n\n- https:\/\/www\.example\.pl\/b\/: BŁĄD – Timeout: Address unavailable$/);
  });

  test('pętla przekierowań kończy się błędem po limicie, adres bez http(s) bez zapytania', () => {
    const gas = project([row(A), row('example.pl/x')], { [A]: redirect(A) });
    gas.sprawdzStronyLive();
    assert.match(result(gas, 1)[1], /^Za dużo przekierowań \(> 5\): https:\/\/www\.example\.pl\/a\/ → /);
    assert.equal(gas.$fetchCalls.length, 6);
    assert.match(result(gas, 2)[1], /musi zaczynać się od http/);
  });

  test('brak arkusza → arkusz z nagłówkiem i komunikat; puste wiersze pomijane', () => {
    const gas = project(null, {});
    const out = plain(gas.sprawdzStronyLive());
    assert.equal(out.empty, true);
    assert.deepEqual(plain(gas.$sheet(SHEET)), [HEADER]);
    assert.match(gas.$alerts[0][0], /nie ma adresów/);
    const blanks = project([[''], row(A)], { [A]: html(page()) });
    assert.equal(plain(blanks.sprawdzStronyLive()).ok, 1);
    assert.equal(blanks.$fetchCalls.length, 1);
  });

  test('kolumna L pokazuje werdykt z URL INSPEKCJA dla tego samego adresu (po normalizacji), inaczej „brak”', () => {
    const gas = project(
      [row(A), row(B)],
      { [A]: html(page()), [B]: html(page({ canonical: null })) },
      { sheets: { 'URL INSPEKCJA': [['URL'], ['https://WWW.example.pl/a', 'ZAINDEKSOWANY (PASS)', 'Submitted and indexed', '', '', '', '', '2026-09-01 07:00', '', '']] } }
    );
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[3], 'ZAINDEKSOWANY (PASS) (sprawdzono 2026-09-01 07:00)');
    assert.equal(result(gas, 2)[3], 'brak w URL INSPEKCJA');
  });

  test('#75: komórka „Sprawdzono” zamieniona przez Sheets na datę jest formatowana, nie wypisywana surowo', () => {
    const gas = project([row(A)], { [A]: html(page()) }, { sheets: { 'URL INSPEKCJA': [['URL']] } });
    const when = new gas.$Date(2026, 8, 6, 9, 7, 0);
    gas.$sheet('URL INSPEKCJA').push([A, 'ZAINDEKSOWANY (PASS)', '', '', '', '', '', when, '', '']);
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[3], 'ZAINDEKSOWANY (PASS) (sprawdzono ' + gas.Utilities.formatDate(new Date(2026, 8, 6, 9, 7, 0), 'Europe/Warsaw', 'yyyy-MM-dd HH:mm') + ')');
    assert.doesNotMatch(result(gas, 1)[3], /GMT/);
  });

  test('#75: nieliczbowy oczekiwany status daje różnicę zamiast udawać 200; liczba jako tekst działa', () => {
    const gas = project([row(A, { status: 'test' }), row(B, { status: '200' })], { [A]: html(page()), [B]: html(page({ canonical: null })) });
    gas.sprawdzStronyLive();
    assert.equal(result(gas, 1)[1], 'status: 200 (oczekiwany status „test” nie jest kodem HTTP; wpisz liczbę albo zostaw puste = 200)');
    assert.equal(result(gas, 2)[0], 'OK');
  });

  test('przebieg pod wspólnym lockiem; zajęty lock → odmowa bez zapytań', () => {
    const gas = project([row(A)], { [A]: html(page()) });
    gas.sprawdzStronyLive();
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
    const busy = project([row(A)], {}, { lockHeld: true });
    assert.throws(() => busy.sprawdzStronyLive(), /Inne uruchomienie jeszcze trwa \(live check SEO\)/);
    assert.equal(busy.$fetchCalls.length, 0);
  });
});

describe('live check: helpery', () => {
  test('seoLiveResolveUrl_ i seoLiveNormalizeUrl_', () => {
    const gas = project(null, {});
    assert.equal(gas.seoLiveResolveUrl_('https://www.example.pl/dir/page', 'https://x.pl/'), 'https://x.pl/');
    assert.equal(gas.seoLiveResolveUrl_('https://www.example.pl/dir/page', '//cdn.example.pl/z'), 'https://cdn.example.pl/z');
    assert.equal(gas.seoLiveResolveUrl_('https://www.example.pl/dir/page', '/root'), 'https://www.example.pl/root');
    assert.equal(gas.seoLiveResolveUrl_('https://www.example.pl/dir/page', 'other'), 'https://www.example.pl/dir/other');
    assert.equal(gas.seoLiveResolveUrl_('https://www.example.pl', 'other'), 'https://www.example.pl/other');
    assert.equal(gas.seoLiveNormalizeUrl_('HTTPS://WWW.Example.pl/A/#frag'), 'https://www.example.pl/A');
    assert.equal(gas.seoLiveNormalizeUrl_('not a url//'), 'not a url');
    assert.equal(gas.seoLiveNormalizeUrl_(''), '');
  });

  test('seoLiveExtract_ czyta atrybuty w dowolnej kolejności i cudzysłowach, pierwszy H1, deduplikuje typy', () => {
    const gas = project(null, {});
    const out = plain(gas.seoLiveExtract_(
      "<link href='https://www.example.pl/c/' rel=canonical><meta content=\"noindex\" name='ROBOTS'><h1>Pierwszy</h1><h1>Drugi</h1>" +
      '<script type="application/ld+json">{"@type":"WebPage"}</script><script type="application/ld+json">{"@type":"WebPage"}</script>',
      { 'X-Robots-Tag': 'NOINDEX' }
    ));
    assert.equal(out.title, '');
    assert.equal(out.h1, 'Pierwszy');
    assert.equal(out.canonical, 'https://www.example.pl/c/');
    assert.equal(out.robots, 'noindex | header: noindex');
    assert.deepEqual(out.types, ['WebPage'], 'typy nadal bez powtórzeń');
    // Od #110 ekstrakcja zwraca też sparsowane węzły, żeby dało się sprawdzać
    // wartości, a nie samą obecność typu.
    assert.equal(out.schemaNodes.length, 2);
    assert.deepEqual(out.schemaErrors, []);
  });
});

describe('#110: kontrole semantyczne w przebiegu SEO LIVE', () => {
  const SCHEMA = 'SEO SCHEMA';
  const SCHEMA_HEADER = ['URL', 'Ścieżka w schema', 'Oczekiwanie', 'Źródło', 'Uwagi'];
  const URL = 'https://www.example.pl/oferta/';
  const page = price =>
    '<html><head><title>Oferta</title><link rel="canonical" href="' + URL + '"></head>' +
    '<body><h1>Oferta</h1><p>Cena: 100 zł</p>' +
    '<script type="application/ld+json">{"@type":"Offer","price":"' + price + '"}</script>' +
    '</body></html>';

  const run = (rules, price) => {
    const sheets = rules ? { [SCHEMA]: [SCHEMA_HEADER, ...rules] } : {};
    const gas = project([row(URL)], { [URL]: { code: 200, text: page(price) } }, { sheets: sheets });
    gas.sprawdzStronyLive();
    return gas.$sheet(SHEET)[1];
  };

  test('bez zakładki reguł zachowanie jest identyczne jak dotąd', () => {
    const line = run(null, '999');
    assert.equal(line[8], 'OK', 'schema opisuje inną cenę, ale nikt o to nie prosił');
    assert.equal(line[9], '');
  });

  test('reguła wykrywa cenę w schema niezgodną z widoczną treścią', () => {
    const line = run([['', 'Offer.price', '', 'strona']], '999');
    assert.match(String(line[8]), /^UWAGA: 1 różnic/);
    assert.match(String(line[9]), /schema Offer\.price: „999” nie występuje w widocznej treści/);
  });

  test('zgodna cena nie generuje różnicy', () => {
    assert.equal(run([['', 'Offer.price', '', 'strona']], '100')[8], 'OK');
  });

  test('różnica semantyczna trafia do tej samej kolumny co pozostałe', () => {
    const line = run([['', 'Offer.price', '120', 'wartość']], '999');
    assert.match(String(line[9]), /^schema Offer\.price: „999” \(oczekiwano „120”\)$/);
  });

  test('pozycja przygotowania reguł jest w menu SEO / GSC', () => {
    const gas = project(null, {});
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.ok(seo.items.map(i => i.fn).includes('przygotujRegulySchema'));
  });
});

describe('live check: menu, trigger, e-mail o nowych rozbieżnościach', () => {
  test('menu SEO / GSC ma pozycje live check po inspekcji URL', () => {
    const gas = project(null, {});
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn).slice(4, 8), ['sprawdzIndeksowanie', 'ustawTygodniowaInspekcje', 'sprawdzStronyLive', 'ustawCodziennyLiveCheck']);
  });

  test('ustawCodziennyLiveCheck instaluje trigger codziennie 09:00, zastępuje stary, pokazuje adresata', () => {
    const gas = project(null, {}, { triggers: ['sprawdzStronyLiveTrigger'], properties: { ALERT_EMAIL: 'alerty@example.pl' } });
    gas.ustawCodziennyLiveCheck();
    const mine = gas.$triggers.filter(t => t.getHandlerFunction() === 'sprawdzStronyLiveTrigger');
    assert.equal(mine.length, 1);
    assert.deepEqual(plain(mine[0].$spec), { handler: 'sprawdzStronyLiveTrigger', everyDays: 1, atHour: 9 });
    assert.match(gas.$alerts[0][0], /adresat: alerty@example\.pl/);
  });

  test('trigger: e-mail tylko o nowych rozbieżnościach (poprzednio OK lub puste), bez okna; nic nowego → brak maila', () => {
    const routes = { [A]: html(page({ robots: 'noindex' })), [B]: html(page({ canonical: null })), 'https://www.example.pl/c/': () => { throw new Error('boom'); } };
    const gas = project(
      [row(A, { result: 'UWAGA: 1 różnic(e)' }), row(B, { result: 'OK' }), row('https://www.example.pl/c/', { result: 'OK' })],
      routes,
      { properties: { ALERT_EMAIL: 'alerty@example.pl' } }
    );
    const out = plain(gas.sprawdzStronyLiveTrigger());
    assert.equal(gas.$alerts.length, 0);
    assert.equal(out.problems.length, 2);
    assert.equal(out.newProblems.length, 1, 'A was already flagged, only C is new');
    assert.equal(gas.$mails.length, 1);
    assert.equal(gas.$mails[0].subject, '[wordpress-automation] Live SEO: 1 nowa(e) rozbieżność(ci)');
    assert.match(gas.$mails[0].body, /- https:\/\/www\.example\.pl\/c\/: BŁĄD – boom/);
    assert.doesNotMatch(gas.$mails[0].body, /example\.pl\/a\//);

    gas.$mails.length = 0;
    gas.sprawdzStronyLiveTrigger();
    assert.equal(gas.$mails.length, 0, 'same problems again → silence');
  });

  test('trigger: pierwsze uruchomienie z rozbieżnością (puste poprzednie) też jest nowe; bez ALERT_EMAIL brak maila i brak błędu', () => {
    const gas = project([row(A)], { [A]: html(page({ robots: 'noindex' })) });
    const out = plain(gas.sprawdzStronyLiveTrigger());
    assert.equal(out.newProblems.length, 1);
    assert.equal(gas.$mails.length, 0);
  });
});
