'use strict';

/**
 * #92: kolejka recrawl. Klasyfikuje strony po zestawieniu daty zmiany
 * (lastmod z sitemapy albo Dziennik zmian) z ostatnim crawlem Google i mówi,
 * którą stronę zgłosić ręcznie w Search Console. Niczego nie zgłasza sama.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, freezeClock } = require('./helpers/gas');

const QUEUE = 'RECRAWL QUEUE';
const SITEMAP = 'SITEMAP URLS';
const INSPECT = 'URL INSPEKCJA';
const LIVE = 'SEO LIVE';
const LOG = 'Dziennik zmian';
const QUEUE_HEADER = ['URL', 'Data zmiany', 'Źródło daty zmiany', 'Ostatni crawl Google', 'Dni od zmiany', 'Status', 'Powód', 'Wyciszone', 'Powiadomiono', 'Sprawdzono'];
const U = slug => 'https://www.example.pl/' + slug + '/';

/** Wiersz URL INSPEKCJA: A adres, B werdykt, C pokrycie, F ostatni crawl. */
const inspectRow = (url, crawl, verdict = 'ZAINDEKSOWANY (PASS)', coverage = 'Submitted and indexed') =>
  [url, verdict, coverage, url, url, crawl, 'ALLOWED', '2026-09-06 07:00', '', ''];
/** Wiersz SEO LIVE: A adres, G oczekiwane robots, I wynik, J różnice. */
const liveRow = (url, over = {}) =>
  [url, '', '', '', '', '', over.robots || '', '', over.result || 'OK', over.diffs || '', '2026-09-06 09:00', ''];
const sitemapRow = (url, lastmod) => [url, 'https://www.example.pl/sitemap.xml', lastmod, '2026-09-06 06:00'];

function project(sheets, properties) {
  return freezeClock(loadProject({ sheets: sheets, properties: properties || {} }), 2026, 8, 6);
}

/** Wiersz kolejki dla adresu, jako obiekt po nazwach kolumn. */
function queueRow(gas, url) {
  const grid = plain(gas.$sheet(QUEUE) || []);
  const row = grid.slice(1).find(r => r[0] === url);
  if (!row) return null;
  const out = {};
  QUEUE_HEADER.forEach((name, i) => { out[name] = row[i]; });
  return out;
}

describe('#92: klasyfikacja', () => {
  test('crawl nowszy od zmiany → AKTUALNE; starszy, ale świeży → OCZEKUJE NA RECRAWL; starszy niż próg → WARTO POPROSIĆ RĘCZNIE', () => {
    const gas = project({
      [SITEMAP]: [['URL', 'Sitemapa źródłowa', 'lastmod', 'Odczytano'],
        sitemapRow(U('a'), '2026-09-01'), sitemapRow(U('b'), '2026-09-04'), sitemapRow(U('c'), '2026-08-20')],
      [INSPECT]: [['URL'], inspectRow(U('a'), '2026-09-03 08:00'), inspectRow(U('b'), '2026-09-02 08:00'), inspectRow(U('c'), '2026-08-19 08:00')],
      [LIVE]: [['URL'], liveRow(U('a')), liveRow(U('b')), liveRow(U('c'))]
    });
    const out = plain(gas.kolejkaRecrawl());

    assert.equal(queueRow(gas, U('a')).Status, 'AKTUALNE');
    assert.equal(queueRow(gas, U('a'))['Powód'], 'crawl po ostatniej zmianie');

    assert.equal(queueRow(gas, U('b')).Status, 'OCZEKUJE NA RECRAWL');
    assert.equal(queueRow(gas, U('b'))['Dni od zmiany'], 2);
    assert.equal(queueRow(gas, U('b'))['Powód'], 'zmiana 2 dni temu, crawl jeszcze może nadejść');

    assert.equal(queueRow(gas, U('c')).Status, 'WARTO POPROSIĆ RĘCZNIE');
    assert.equal(queueRow(gas, U('c'))['Powód'], 'zmiana 17 dni temu, Google nadal nie odwiedził strony');

    assert.deepEqual(plain(out.recommended).map(r => r.url), [U('c')]);
    assert.equal(out.staleDays, 7);
    assert.match(gas.$alerts[0][0], /^Kolejka recrawl \(nic nie jest zgłaszane do Google automatycznie\):\nAdresów: 3 \| próg oczekiwania: 7 dni\n/);
    assert.match(gas.$alerts[0][0], /Do ręcznego zgłoszenia w Search Console \(„Poproś o zindeksowanie”\):\n- https:\/\/www\.example\.pl\/c\/\n {2}zmiana 17 dni temu/);
  });

  test('brak crawla → BRAK CRAWLA i rekomendacja; brak daty zmiany → BRAK DATY ZMIANY bez rekomendacji', () => {
    const gas = project({
      [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('nowa'), '2026-09-05'), sitemapRow(U('bez-daty'), '')],
      [INSPECT]: [['URL'], inspectRow(U('nowa'), '', 'NIEZNANY (VERDICT_UNSPECIFIED)', ''), inspectRow(U('bez-daty'), '2026-09-01 08:00')],
      [LIVE]: [['URL'], liveRow(U('nowa'), { result: '' }), liveRow(U('bez-daty'))]
    });
    const out = plain(gas.kolejkaRecrawl());
    assert.equal(queueRow(gas, U('nowa')).Status, 'BRAK CRAWLA');
    assert.equal(queueRow(gas, U('nowa'))['Powód'], 'Google jeszcze nie odwiedził tego adresu');
    assert.equal(queueRow(gas, U('bez-daty')).Status, 'BRAK DATY ZMIANY');
    assert.deepEqual(plain(out.recommended).map(r => r.url), [U('nowa')]);
  });

  test('strona działa, ale Google ma ją poza indeksem → rekomendacja niezależnie od dat (przypadek 404 w indeksie)', () => {
    const gas = project({
      [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('poznan'), '2026-09-03')],
      [INSPECT]: [['URL'], inspectRow(U('poznan'), '2026-09-05 08:00', 'BŁĄD INDEKSOWANIA (FAIL)', 'Not found (404)')],
      [LIVE]: [['URL'], liveRow(U('poznan'))]
    });
    const out = plain(gas.kolejkaRecrawl());
    assert.equal(queueRow(gas, U('poznan')).Status, 'WARTO POPROSIĆ RĘCZNIE');
    assert.equal(queueRow(gas, U('poznan'))['Powód'], 'strona działa (live OK), ale Google jej nie ma w indeksie: BŁĄD INDEKSOWANIA (FAIL) – Not found (404)');
    assert.equal(out.recommended.length, 1, 'crawl nowszy od zmiany nie przykrywa braku w indeksie');
  });
});

describe('#92: wykluczenia', () => {
  test('adres spoza sitemapy, celowy noindex i przekierowanie nie są rekomendowane', () => {
    const gas = project({
      [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('noindex'), '2026-08-01'), sitemapRow(U('redirect'), '2026-08-01')],
      [INSPECT]: [['URL'], inspectRow(U('stara-301'), '2026-01-01 08:00', 'WYKLUCZONY (NEUTRAL)', 'Page with redirect'), inspectRow(U('noindex'), '2026-01-01 08:00'), inspectRow(U('redirect'), '2026-01-01 08:00')],
      [LIVE]: [['URL'],
        liveRow(U('stara-301'), { result: 'UWAGA: 1 różnic(e)', diffs: 'cel: https://www.example.pl/nowa/ (oczekiwano ' + U('stara-301') + ')' }),
        liveRow(U('noindex'), { robots: 'noindex' }),
        liveRow(U('redirect'), { result: 'UWAGA: 1 różnic(e)', diffs: 'cel: https://www.example.pl/inna/ (oczekiwano ' + U('redirect') + ')' })]
    });
    const out = plain(gas.kolejkaRecrawl());
    assert.equal(queueRow(gas, U('stara-301'))['Powód'], 'poza sitemapą (monitorowana ręcznie, nie zgłaszamy)');
    assert.equal(queueRow(gas, U('noindex'))['Powód'], 'celowy noindex');
    assert.match(queueRow(gas, U('redirect'))['Powód'], /^strona przekierowuje; napraw przekierowanie/);
    ['stara-301', 'noindex', 'redirect'].forEach(s => assert.equal(queueRow(gas, U(s)).Status, 'WYKLUCZONA / NIE DOTYCZY'));
    assert.deepEqual(plain(out.recommended), []);
    assert.match(gas.$alerts[0][0], /\nNic nie wymaga ręcznego zgłoszenia\./);
  });

  test('Wyciszone = TAK wyłącza rekomendację i przetrwa przepisanie arkusza', () => {
    const sheets = {
      [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('stara'), '2026-08-01')],
      [INSPECT]: [['URL'], inspectRow(U('stara'), '2026-07-01 08:00')],
      [LIVE]: [['URL'], liveRow(U('stara'))],
      [QUEUE]: [QUEUE_HEADER, [U('stara'), '', '', '', '', '', '', 'TAK', '', '']]
    };
    const gas = project(sheets);
    const out = plain(gas.kolejkaRecrawl());
    assert.equal(queueRow(gas, U('stara')).Status, 'WYKLUCZONA / NIE DOTYCZY');
    assert.equal(queueRow(gas, U('stara'))['Powód'], 'wyciszone ręcznie');
    assert.equal(queueRow(gas, U('stara')).Wyciszone, 'TAK', 'the flag survives the rewrite');
    assert.deepEqual(plain(out.recommended), []);
    assert.equal(out.muted, 1);
  });
});

describe('#92: źródło daty zmiany', () => {
  const base = {
    [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('a'), '2026-08-20')],
    [INSPECT]: [['URL'], inspectRow(U('a'), '2026-08-25 08:00')],
    [LIVE]: [['URL'], liveRow(U('a'))]
  };

  test('nowsza data z Dziennika zmian wygrywa z lastmod i jest wskazana jako źródło', () => {
    const gas = project(Object.assign({}, base, {
      [LOG]: [['Data', 'URL', 'Opis'], ['2026-09-04', U('a'), 'przepisany title']]
    }));
    gas.kolejkaRecrawl();
    const row = queueRow(gas, U('a'));
    assert.equal(row['Data zmiany'].slice(0, 10), '2026-09-04');
    assert.equal(row['Źródło daty zmiany'], 'Dziennik zmian');
    assert.equal(row.Status, 'OCZEKUJE NA RECRAWL', 'crawl 25.08 jest starszy niż zmiana 04.09');
  });

  test('starsza data z Dziennika zmian nie psuje lastmod', () => {
    const gas = project(Object.assign({}, base, {
      [LOG]: [['Data', 'URL'], ['2026-07-01', U('a')]]
    }));
    gas.kolejkaRecrawl();
    const row = queueRow(gas, U('a'));
    assert.equal(row['Data zmiany'].slice(0, 10), '2026-08-20');
    assert.equal(row['Źródło daty zmiany'], 'lastmod z sitemapy');
    assert.equal(row.Status, 'AKTUALNE');
  });

  test('Dziennik zmian bez rozpoznawalnych kolumn jest pomijany, a raport mówi o tym wprost', () => {
    const gas = project(Object.assign({}, base, { [LOG]: [['Co zmieniono', 'Kto'], ['title', 'GW']] }));
    gas.kolejkaRecrawl();
    assert.match(gas.$alerts[0][0], /Uwaga: nie znaleziono kolumn z adresem i datą w „Dziennik zmian”; daty zmian pochodzą wyłącznie z sitemapy\.$/);
    assert.equal(queueRow(gas, U('a'))['Źródło daty zmiany'], 'lastmod z sitemapy');
  });

  test('brak arkusza Dziennik zmian też jest zgłaszany, ale nie jest błędem', () => {
    const gas = project(base);
    gas.kolejkaRecrawl();
    assert.match(gas.$alerts[0][0], /Uwaga: brak arkusza „Dziennik zmian”; daty zmian pochodzą wyłącznie z sitemapy\.$/);
    assert.equal(queueRow(gas, U('a')).Status, 'AKTUALNE');
  });

  test('daty jako obiekty Date z arkusza są czytane tak samo jak teksty', () => {
    const gas = project(base);
    const sitemapSheet = gas.$sheet(SITEMAP);
    sitemapSheet[1][2] = new gas.$Date(2026, 8, 4);
    gas.kolejkaRecrawl();
    assert.equal(queueRow(gas, U('a'))['Data zmiany'].slice(0, 10), '2026-09-04');
    assert.equal(queueRow(gas, U('a')).Status, 'OCZEKUJE NA RECRAWL');
  });

  test('próg oczekiwania jest konfigurowalny przez RECRAWL_STALE_DAYS', () => {
    const sheets = {
      [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('a'), '2026-09-02')],
      [INSPECT]: [['URL'], inspectRow(U('a'), '2026-09-01 08:00')],
      [LIVE]: [['URL'], liveRow(U('a'))]
    };
    const dflt = project(sheets);
    dflt.kolejkaRecrawl();
    assert.equal(queueRow(dflt, U('a')).Status, 'OCZEKUJE NA RECRAWL', '4 dni < 7');

    const strict = project(sheets, { RECRAWL_STALE_DAYS: '3' });
    strict.kolejkaRecrawl();
    assert.equal(queueRow(strict, U('a')).Status, 'WARTO POPROSIĆ RĘCZNIE', '4 dni >= 3');
    assert.equal(plain(strict.kolejkaRecrawl()).staleDays, 3);

    const bogus = project(sheets, { RECRAWL_STALE_DAYS: 'nie liczba' });
    assert.equal(plain(bogus.kolejkaRecrawl()).staleDays, 7, 'unreadable value falls back to the default');
  });
});

describe('#92: e-mail tylko o nowych rekomendacjach', () => {
  const sheets = () => ({
    [SITEMAP]: [['URL', 'S', 'lastmod', 'O'], sitemapRow(U('stara'), '2026-08-01'), sitemapRow(U('swieza'), '2026-09-05')],
    [INSPECT]: [['URL'], inspectRow(U('stara'), '2026-07-01 08:00'), inspectRow(U('swieza'), '2026-09-06 08:00')],
    [LIVE]: [['URL'], liveRow(U('stara')), liveRow(U('swieza'))]
  });

  test('pierwszy przebieg wysyła jeden mail z listą, drugi milczy, znacznik trafia do arkusza', () => {
    const gas = project(sheets(), { ALERT_EMAIL: 'alerty@example.pl' });
    const out = plain(gas.kolejkaRecrawlTrigger());
    assert.equal(gas.$alerts.length, 0, 'the trigger opens no dialog');
    assert.deepEqual(plain(out.newRecommended).map(r => r.url), [U('stara')]);
    assert.equal(gas.$mails.length, 1);
    assert.equal(gas.$mails[0].subject, '[wordpress-automation] Do zgłoszenia w Search Console: 1 stron(y)');
    assert.match(gas.$mails[0].body, /Te strony warto ręcznie zgłosić w Search Console przez „Poproś o zindeksowanie”:\n\n- https:\/\/www\.example\.pl\/stara\/\n {2}zmiana 36 dni temu/);
    assert.match(gas.$mails[0].body, /Nic nie zostało zgłoszone automatycznie/);
    assert.ok(queueRow(gas, U('stara')).Powiadomiono, 'notification recorded in the sheet');

    gas.$mails.length = 0;
    const second = plain(gas.kolejkaRecrawlTrigger());
    assert.deepEqual(plain(second.newRecommended), [], 'the same recommendation is not repeated');
    assert.equal(second.recommended.length, 1, 'but it stays in the queue');
    assert.equal(gas.$mails.length, 0);
  });

  test('powrót do stanu bez rekomendacji czyści znacznik, więc kolejny problem zgłosi się ponownie', () => {
    const s = sheets();
    const gas = project(s, { ALERT_EMAIL: 'alerty@example.pl' });
    gas.kolejkaRecrawlTrigger();
    assert.ok(queueRow(gas, U('stara')).Powiadomiono);

    // Google w końcu odwiedził stronę: crawl nowszy niż zmiana.
    gas.$sheet(INSPECT)[1][5] = '2026-09-06 09:00';
    gas.$mails.length = 0;
    gas.kolejkaRecrawlTrigger();
    assert.equal(queueRow(gas, U('stara')).Status, 'AKTUALNE');
    assert.equal(queueRow(gas, U('stara')).Powiadomiono, '', 'marker cleared');
    assert.equal(gas.$mails.length, 0);

    // Kolejna zmiana, znowu bez crawla: mail wychodzi ponownie.
    gas.$sheet(SITEMAP)[1][2] = '2026-09-06';
    gas.$sheet(INSPECT)[1][5] = '2026-08-01 09:00';
    gas.$sheet(SITEMAP)[1][2] = '2026-08-20';
    gas.kolejkaRecrawlTrigger();
    assert.equal(gas.$mails.length, 1);
  });

  test('bez ALERT_EMAIL nic nie jest wysyłane, znacznik nie jest ustawiany, kolejka i tak działa', () => {
    const gas = project(sheets());
    const out = plain(gas.kolejkaRecrawlTrigger());
    assert.equal(gas.$mails.length, 0);
    assert.equal(out.recommended.length, 1);
    assert.equal(queueRow(gas, U('stara')).Powiadomiono, '', 'nothing was notified, so nothing is marked');
  });
});

describe('#92: arkusz, menu i trigger', () => {
  test('pusta URL INSPEKCJA → komunikat, arkusz kolejki z samym nagłówkiem', () => {
    const gas = project({ [INSPECT]: [['URL']] });
    const out = plain(gas.kolejkaRecrawl());
    assert.equal(out.total, 0);
    assert.deepEqual(plain(gas.$sheet(QUEUE)), [QUEUE_HEADER]);
    assert.match(gas.$alerts[0][0], /^Arkusz „URL INSPEKCJA” nie ma adresów/);
  });

  test('kolejka działa pod wspólnym lockiem; zajęty lock odmawia', () => {
    const gas = project({ [INSPECT]: [['URL'], inspectRow(U('a'), '2026-09-01 08:00')] });
    gas.kolejkaRecrawl();
    assert.deepEqual(plain(gas.$lock), [['tryLock', 5000], ['releaseLock']]);
    const busy = freezeClock(loadProject({ sheets: { [INSPECT]: [['URL']] }, lockHeld: true }), 2026, 8, 6);
    assert.throws(() => busy.kolejkaRecrawl(), /Inne uruchomienie jeszcze trwa \(kolejka recrawl\)/);
  });

  test('menu SEO / GSC ma obie pozycje; trigger codzienny 10:00 zastępuje stary i podaje adresata', () => {
    const gas = project({ [INSPECT]: [['URL']] }, { ALERT_EMAIL: 'alerty@example.pl' });
    gas.onOpen();
    const seo = gas.$menus.find(m => m.title === 'SEO / GSC');
    assert.deepEqual(seo.items.map(i => i.fn).slice(-2), ['kolejkaRecrawl', 'ustawCodziennaKolejkeRecrawl']);

    const withTrigger = freezeClock(loadProject({ sheets: { [INSPECT]: [['URL']] }, properties: { ALERT_EMAIL: 'alerty@example.pl' }, triggers: ['kolejkaRecrawlTrigger'] }), 2026, 8, 6);
    withTrigger.ustawCodziennaKolejkeRecrawl();
    const mine = withTrigger.$triggers.filter(t => t.getHandlerFunction() === 'kolejkaRecrawlTrigger');
    assert.equal(mine.length, 1);
    assert.deepEqual(plain(mine[0].$spec), { handler: 'kolejkaRecrawlTrigger', everyDays: 1, atHour: 10 });
    assert.match(withTrigger.$alerts[0][0], /na adres: alerty@example\.pl/);
    assert.match(withTrigger.$alerts[0][0], /Nic nie jest zgłaszane do Google automatycznie\.$/);
  });
});
