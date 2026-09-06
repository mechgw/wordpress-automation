'use strict';

/**
 * #89: sitemapa jako źródło listy monitorowanych adresów. XML sitemap jest
 * parsowany do arkusza SITEMAP URLS, a brakujące adresy dosypywane do
 * SEO LIVE i URL INSPEKCJA. Synchronizacja tylko dopisuje.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const GSC_SHEET = 'Konfiguracja GSC';
const URLS = 'SITEMAP URLS';
const LIVE = 'SEO LIVE';
const INSPECT = 'URL INSPEKCJA';
const URLS_HEADER = ['URL', 'Sitemapa źródłowa', 'lastmod', 'Odczytano'];
const SITEMAPS_API = '/sitemaps';
const INDEX = 'https://www.example.pl/sitemap_index.xml';
const PAGES = 'https://www.example.pl/page-sitemap.xml';
const POSTS = 'https://www.example.pl/post-sitemap.xml';

function sheets(extra = {}) {
  return Object.assign({
    [GSC_SHEET]: [['Klucz', 'Wartość'], ['siteUrl', 'https://www.example.pl/'], ['daysBack', 3], ['dailyLagDays', 2], ['rowLimit', 100], ['searchType', 'web'], ['', ''], ['status', '']]
  }, extra);
}

const urlset = entries => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  entries.map(e => '<url><loc>' + e[0] + '</loc>' + (e[1] ? '<lastmod>' + e[1] + '</lastmod>' : '') + '</url>').join('') + '</urlset>';
const sitemapindex = locs => '<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  locs.map(l => '<sitemap><loc>' + l + '</loc></sitemap>').join('') + '</sitemapindex>';

/** Routing: API sitemap Search Console + pobieranie plików XML po adresie. */
function project(opts) {
  const api = (opts.sitemaps === undefined ? [{ path: INDEX }] : opts.sitemaps);
  const files = opts.files || {};
  return loadProject(Object.assign({
    sheets: sheets(opts.extraSheets),
    fetch: url => {
      if (String(url).includes(SITEMAPS_API)) return { code: 200, json: { sitemap: api } };
      const f = files[url];
      if (f === undefined) return { code: 404, text: 'not found' };
      if (typeof f === 'function') return f();
      return typeof f === 'object' ? f : { code: 200, text: f };
    }
  }, opts.load || {}));
}

const col = (gas, sheet, index = 0) => plain(gas.$sheet(sheet) || []).slice(1).map(r => r[index]).filter(v => v !== '' && v !== undefined);

describe('#89: parsowanie sitemap', () => {
  test('indeks rozwijany do plików, adresy z lastmod trafiają do SITEMAP URLS, duplikaty pomijane', () => {
    const gas = project({
      files: {
        [INDEX]: sitemapindex([PAGES, POSTS]),
        [PAGES]: urlset([['https://www.example.pl/', '2026-09-01'], ['https://www.example.pl/dla-firm/', '2026-09-02']]),
        [POSTS]: urlset([['https://www.example.pl/blog/wpis/', ''], ['https://www.example.pl/dla-firm', '']])
      }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.files, 3, 'index + two children');
    assert.equal(out.urls, 3, 'the duplicate differing only by trailing slash is skipped');

    const grid = plain(gas.$sheet(URLS));
    assert.deepEqual(grid[0], URLS_HEADER);
    assert.deepEqual(grid[1].slice(0, 3), ['https://www.example.pl/', PAGES, '2026-09-01']);
    assert.deepEqual(grid[2].slice(0, 3), ['https://www.example.pl/dla-firm/', PAGES, '2026-09-02']);
    assert.deepEqual(grid[3].slice(0, 3), ['https://www.example.pl/blog/wpis/', POSTS, '']);
    assert.match(grid[1][3], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('obrazki w rozszerzeniu image: nie są brane za adresy stron, encje są dekodowane', () => {
    const gas = project({
      files: {
        [INDEX]: '<?xml version="1.0"?><urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' +
          '<url><loc>https://www.example.pl/a/?x=1&amp;y=2</loc><image:image><image:loc>https://www.example.pl/foto.jpg</image:loc></image:image></url>' +
          '</urlset>'
      }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 1);
    assert.equal(plain(gas.$sheet(URLS))[1][0], 'https://www.example.pl/a/?x=1&y=2');
  });

  test('parseSitemapXml_ rozpoznaje indeks i zwykłą sitemapę, pusty XML nie wywraca', () => {
    const gas = project({ files: {} });
    const idx = plain(gas.parseSitemapXml_(sitemapindex([PAGES])));
    assert.equal(idx.isIndex, true);
    assert.deepEqual(idx.entries.map(e => e.loc), [PAGES]);
    const plainSet = plain(gas.parseSitemapXml_(urlset([['https://www.example.pl/a/', '2026-01-01']])));
    assert.equal(plainSet.isIndex, false);
    assert.deepEqual(plain(plainSet.entries[0]), { loc: 'https://www.example.pl/a/', lastmod: '2026-01-01' });
    assert.deepEqual(plain(gas.parseSitemapXml_('')).entries, []);
    assert.deepEqual(plain(gas.parseSitemapXml_('<urlset></urlset>')).entries, []);
  });
});

describe('#89: synchronizacja monitoringu', () => {
  const twoUrls = { [INDEX]: urlset([['https://www.example.pl/', ''], ['https://www.example.pl/dla-firm/', '']]) };

  test('brakujące adresy trafiają do SEO LIVE i URL INSPEKCJA z nagłówkiem, po jednym wierszu', () => {
    const gas = project({ files: twoUrls });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.deepEqual(plain(out.seoLive.added), ['https://www.example.pl/', 'https://www.example.pl/dla-firm/']);
    assert.deepEqual(plain(out.inspection.added), ['https://www.example.pl/', 'https://www.example.pl/dla-firm/']);
    assert.deepEqual(col(gas, LIVE), ['https://www.example.pl/', 'https://www.example.pl/dla-firm/']);
    assert.deepEqual(col(gas, INSPECT), ['https://www.example.pl/', 'https://www.example.pl/dla-firm/']);
    assert.equal(plain(gas.$sheet(LIVE))[0][0], 'URL', 'sheet created with its header');
    assert.equal(plain(gas.$sheet(LIVE))[1].length, 1, 'only column A is written: expectations stay empty');
  });

  test('drugie uruchomienie nic nie dopisuje (idempotencja)', () => {
    const gas = project({ files: twoUrls });
    gas.odswiezMonitoringZSitemap();
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.deepEqual(plain(out.seoLive.added), []);
    assert.deepEqual(plain(out.inspection.added), []);
    assert.equal(col(gas, LIVE).length, 2);
    assert.match(gas.$alerts[1][0], /Dopisane do „SEO LIVE”: 0 \| do „URL INSPEKCJA”: 0/);
  });

  test('ręczne oczekiwania i wiersze wyników istniejącego adresu nie są ruszane', () => {
    const gas = project({
      files: twoUrls,
      extraSheets: {
        [LIVE]: [
          ['URL', 'Oczekiwany status HTTP', 'Oczekiwany URL docelowy', 'Oczekiwany title', 'Oczekiwany H1', 'Oczekiwany canonical', 'Oczekiwane robots', 'Oczekiwane schema (@type)', 'Wynik (live)', 'Różnice', 'Sprawdzono', 'Indeks Google (URL INSPEKCJA)'],
          ['https://www.example.pl/dla-firm/', '', '', 'Kurier dla firm', '', '', '', 'Organization', 'OK', '', '2026-09-06 09:00', 'ZAINDEKSOWANY (PASS)']
        ]
      }
    });
    gas.odswiezMonitoringZSitemap();
    const row = plain(gas.$sheet(LIVE))[1];
    assert.equal(row[0], 'https://www.example.pl/dla-firm/');
    assert.equal(row[3], 'Kurier dla firm', 'expectation preserved');
    assert.equal(row[8], 'OK', 'result preserved');
    assert.equal(row[11], 'ZAINDEKSOWANY (PASS)');
    assert.deepEqual(col(gas, LIVE), ['https://www.example.pl/dla-firm/', 'https://www.example.pl/'], 'only the missing URL appended');
  });

  test('adres monitorowany, którego nie ma w sitemapie, zostaje i jest zgłoszony jako wyjątek', () => {
    const gas = project({
      files: twoUrls,
      extraSheets: { [LIVE]: [['URL'], ['https://www.example.pl/kurier-ekspresowy-warszawa/', '', '', '', '', '', '', '', '', '', '', '']] }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.deepEqual(plain(out.seoLive.extra), ['https://www.example.pl/kurier-ekspresowy-warszawa/']);
    assert.equal(col(gas, LIVE).includes('https://www.example.pl/kurier-ekspresowy-warszawa/'), true, 'never removed');
    assert.match(gas.$alerts[0][0], /Monitorowane mimo braku w sitemapie \(nie są usuwane, sprawdź czy tak ma być\):\n- https:\/\/www\.example\.pl\/kurier-ekspresowy-warszawa\/$/);
  });

  test('SITEMAP URLS jest przepisywany: adres usunięty z sitemapy znika z listy, ale zostaje w monitoringu', () => {
    const gas = project({ files: twoUrls });
    gas.odswiezMonitoringZSitemap();
    assert.equal(col(gas, URLS).length, 2);

    const gas2 = project({
      files: { [INDEX]: urlset([['https://www.example.pl/', '']]) },
      extraSheets: {
        [URLS]: [URLS_HEADER, ['https://www.example.pl/', INDEX, '', 'x'], ['https://www.example.pl/dla-firm/', INDEX, '', 'x']],
        [LIVE]: [['URL'], ['https://www.example.pl/'], ['https://www.example.pl/dla-firm/']]
      }
    });
    const out = plain(gas2.odswiezMonitoringZSitemap());
    assert.deepEqual(col(gas2, URLS), ['https://www.example.pl/'], 'the list mirrors the sitemap');
    assert.deepEqual(plain(out.seoLive.extra), ['https://www.example.pl/dla-firm/']);
    assert.equal(col(gas2, LIVE).length, 2, 'monitoring keeps both');
  });
});

describe('#89: błędy i limity', () => {
  test('nieosiągalna sitemapa jest zgłoszona, pozostałe są przetwarzane', () => {
    const gas = project({
      files: {
        [INDEX]: sitemapindex([PAGES, POSTS]),
        [PAGES]: urlset([['https://www.example.pl/a/', '']])
      }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 1);
    assert.deepEqual(plain(out.errors).map(e => e.sitemap), [POSTS]);
    assert.match(plain(out.errors)[0].error, /^HTTP 404$/);
    assert.match(gas.$alerts[0][0], /Sitemapy, których nie udało się pobrać:\n- https:\/\/www\.example\.pl\/post-sitemap\.xml: HTTP 404/);
  });

  test('sitemapa wskazująca na siebie nie zapętla przebiegu', () => {
    const gas = project({ files: { [INDEX]: sitemapindex([INDEX, PAGES]), [PAGES]: urlset([['https://www.example.pl/a/', '']]) } });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.files, 2, 'each file fetched once');
    assert.equal(out.urls, 1);
  });

  test('limit adresów przerywa zbieranie i mówi o tym wprost', () => {
    const many = Array.from({ length: 5100 }, (_, i) => ['https://www.example.pl/p' + i + '/', '']);
    const gas = project({ files: { [INDEX]: urlset(many) } });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 5000);
    assert.equal(out.truncated, true);
    assert.match(gas.$alerts[0][0], /UWAGA: przerwano na limicie \(30 plików \/ 5000 adresów\)\. Lista jest niepełna\.$/);
  });

  test('#89/Codex: więcej adresów niż 1000-wierszowa siatka nowego arkusza – siatka jest powiększana przed zapisem', () => {
    const many = Array.from({ length: 1500 }, (_, i) => ['https://www.example.pl/p' + i + '/', '']);
    const gas = project({ files: { [INDEX]: urlset(many) } });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 1500);

    const ss = gas.SpreadsheetApp.getActive();
    [URLS, LIVE, INSPECT].forEach(name => {
      assert.ok(ss.getSheetByName(name).getMaxRows() >= 1501, name + ': siatka powiększona');
      assert.equal(col(gas, name).length, 1500, name + ': wszystkie adresy zapisane');
    });
  });

  test('#89/Codex: spakowana sitemapa .xml.gz jest rozpakowywana przed parsowaniem', () => {
    const GZ = 'https://www.example.pl/page-sitemap.xml.gz';
    const gas = project({
      sitemaps: [{ path: GZ }],
      files: { [GZ]: { code: 200, text: ' bajty gzip', gzip: urlset([['https://www.example.pl/a/', '2026-09-01']]) } }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 1, 'without ungzip the parser would silently find nothing');
    assert.deepEqual(plain(out.errors), []);
    assert.equal(plain(gas.$sheet(URLS))[1][0], 'https://www.example.pl/a/');
    assert.deepEqual(col(gas, LIVE), ['https://www.example.pl/a/']);
  });

  test('#89/Codex: odpowiedź 200, która nie jest sitemapą, jest błędem, a nie cichym zerem adresów', () => {
    const gas = project({
      files: { [INDEX]: '<!doctype html><html><body>Strona nie istnieje</body></html>' },
      extraSheets: { [LIVE]: [['URL'], ['https://www.example.pl/stara/']] }
    });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 0);
    assert.deepEqual(plain(out.errors), [{ sitemap: INDEX, error: 'odpowiedź nie wygląda na XML sitemapy' }]);
    assert.match(gas.$alerts[0][0], /Sitemapy, których nie udało się pobrać:\n- https:\/\/www\.example\.pl\/sitemap_index\.xml: odpowiedź nie wygląda na XML sitemapy/);
    assert.deepEqual(col(gas, LIVE), ['https://www.example.pl/stara/'], 'monitoring untouched');
  });

  test('pusta, ale poprawna sitemapa nie jest błędem', () => {
    const gas = project({ files: { [INDEX]: urlset([]) } });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.urls, 0);
    assert.deepEqual(plain(out.errors), []);
  });

  test('brak sitemap w Search Console → komunikat, żadnego zapisu do monitoringu', () => {
    const gas = project({ sitemaps: [], files: {} });
    const out = plain(gas.odswiezMonitoringZSitemap());
    assert.equal(out.empty, true);
    assert.equal(gas.$sheet(LIVE), undefined, 'monitoring sheets not created');
    assert.match(gas.$alerts[0][0], /^Search Console nie zna żadnej sitemapy dla tej witryny/);
  });

  test('brak siteUrl → jasny błąd przed jakimkolwiek zapytaniem; zajęty lock → odmowa', () => {
    const s = sheets();
    s[GSC_SHEET][1] = ['siteUrl', ''];
    const gas = loadProject({ sheets: s, fetch: () => { throw new Error('must not fetch'); } });
    assert.throws(() => gas.odswiezMonitoringZSitemap(), /Brak siteUrl w arkuszu Konfiguracja GSC/);

    const busy = project({ files: {}, load: { lockHeld: true } });
    assert.throws(() => busy.odswiezMonitoringZSitemap(), /Inne uruchomienie jeszcze trwa \(adresy z sitemap\)/);
    assert.equal(busy.$fetchCalls.length, 0);
  });
});

describe('#89: menu i trigger', () => {
  test('menu SEO / GSC ma odświeżanie i instalację triggera', () => {
    const gas = project({ files: {} });
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn).slice(-2), ['odswiezMonitoringZSitemap', 'ustawTygodnioweOdswiezanieSitemap']);
  });

  test('trigger tygodniowy: poniedziałek 06:00, godzinę przed inspekcją URL, zastępuje stary', () => {
    const gas = project({ files: {}, load: { triggers: ['odswiezMonitoringZSitemapTrigger', 'sprawdzIndeksowanieTrigger'] } });
    gas.ustawTygodnioweOdswiezanieSitemap();
    const mine = gas.$triggers.filter(t => t.getHandlerFunction() === 'odswiezMonitoringZSitemapTrigger');
    assert.equal(mine.length, 1);
    assert.deepEqual(plain(mine[0].$spec), { handler: 'odswiezMonitoringZSitemapTrigger', everyDays: null, atHour: 6, weekDay: 'MONDAY' });
    assert.equal(gas.$triggers.length, 2, 'the URL inspection trigger is untouched');
    assert.match(gas.$alerts[0][0], /poniedziałek, ok\. 6:00/);
  });

  test('handler triggera nie otwiera okna, ale synchronizuje', () => {
    const gas = project({ files: { [INDEX]: urlset([['https://www.example.pl/a/', '']]) } });
    const out = plain(gas.odswiezMonitoringZSitemapTrigger());
    assert.equal(out.urls, 1);
    assert.equal(gas.$alerts.length, 0);
    assert.deepEqual(col(gas, INSPECT), ['https://www.example.pl/a/']);
  });
});
