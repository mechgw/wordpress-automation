'use strict';

/**
 * Komendy WordPress (#48): pętla processWpCommands, każda komenda odczytu i
 * zapisu wraz ze snapshotami, strażnikami i odczytem kontrolnym, oraz tryb
 * próbny WP_DRY_RUN, który przechodzi przez ten sam builder żądań i zatrzymuje
 * się dopiero tuż przed wysyłką.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');
const { fakeWordPress } = require('./helpers/wordpress');

const PROPS = { WP_BASE_URL: 'https://www.example.pl', WP_USERNAME: 'bot', WP_APP_PASSWORD: 'pw', WP_REST_NAMESPACE: 'acme' };
const WRITE = { ...PROPS, WP_ALLOW_WRITES: 'TRUE' };
const DRY = { ...PROPS, WP_DRY_RUN: 'TRUE' };

const COMMANDS_HEADER = ['id', 'created_at', 'action', 'target', 'field', 'value', 'confirm', 'status', 'http', 'message', 'result_ref', 'done_at', 'note'];
const RESULTS_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];
const SNAPSHOTS_HEADER = ['snapshot_id', 'command_id', 'wp_id', 'slug', 'title', 'excerpt', 'content', 'status', 'modified', 'at', 'rm_title', 'rm_desc', 'rm_captured', 'snapshot_kind', 'media_before_json'];

const cmd = (action, target = '', field = '', value = '', confirm = 'YES', status = 'PENDING', id = 'CMD-1') =>
  [id, '2026-09-05', action, target, field, value, confirm, status, '', '', '', '', ''];

const SAMPLE_PAGES = [
  { id: 7, slug: 'home', status: 'publish', title: 'Home', excerpt: 'Ex', content: 'Witaj w firmie Acme. Zapraszamy.', rankMath: { title: 'Home SEO', description: 'Opis' } },
  { id: 8, slug: 'szkic', status: 'draft', title: 'Szkic', content: 'Treść szkicu' },
  { id: 9, slug: 'pusty', status: 'draft', title: '', content: '' }
];
const SAMPLE_MEDIA = [{ id: 21, slug: 'logo', title: 'Logo', alt_text: 'stare alt', source_url: 'https://www.example.pl/wp-content/uploads/logo.png' }];

function project({ props = WRITE, commands = [], wp, snapshots = [], sheets = {} } = {}) {
  const fake = wp || fakeWordPress({ pages: SAMPLE_PAGES, media: SAMPLE_MEDIA });
  const gas = loadProject({
    properties: props,
    sheets: Object.assign({
      'WP COMMANDS': [COMMANDS_HEADER, ...commands],
      'WP RESULTS': [RESULTS_HEADER],
      'WP SNAPSHOTS': [SNAPSHOTS_HEADER, ...snapshots]
    }, sheets),
    fetch: fake.fetch
  });
  gas.$wp = fake.state;
  return gas;
}

const row = (gas, n = 2) => gas.$sheet('WP COMMANDS')[n - 1];
const status = (gas, n = 2) => row(gas, n)[7];
const message = (gas, n = 2) => String(row(gas, n)[9]);
const results = gas => gas.$sheet('WP RESULTS').slice(1);
const snapshots = gas => gas.$sheet('WP SNAPSHOTS').slice(1);
const writes = gas => gas.$wp.writes;

describe('processWpCommands: pętla i statusy', () => {
  test('przetwarza tylko wiersze PENDING i zapisuje DONE z kodem, komunikatem, referencją i czasem', () => {
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '7'), cmd('GET_PAGE_BY_ID', '8', '', '', 'YES', 'DONE', 'CMD-2'), cmd('GET_PAGE_BY_ID', '8', '', '', 'YES', '', 'CMD-3')] });
    gas.processWpCommands();
    assert.equal(status(gas, 2), 'DONE');
    assert.equal(row(gas, 2)[8], 200);
    assert.match(message(gas, 2), /^Pobrano stronę WordPress ID 7 \(home\)$/);
    assert.equal(row(gas, 2)[10], 'WP RESULTS!A2:M2');
    assert.ok(row(gas, 2)[11] instanceof gas.$Date, 'done_at is a Date');
    assert.equal(status(gas, 3), 'DONE', 'already DONE row untouched');
    assert.equal(status(gas, 4), '', 'row without status untouched');
    assert.equal(results(gas).length, 1);
  });

  test('błąd komendy daje ERROR z komunikatem i kodem HTTP, kolejne komendy nadal się wykonują', () => {
    const gas = project({ commands: [cmd('GET_PAGE_BY_ID', '999'), cmd('GET_PAGE_BY_ID', '7', '', '', 'YES', 'PENDING', 'CMD-2')] });
    gas.processWpCommands();
    assert.equal(status(gas, 2), 'ERROR');
    assert.equal(row(gas, 2)[8], 404);
    assert.match(message(gas, 2), /WordPress REST API HTTP 404/);
    assert.equal(status(gas, 3), 'DONE');
  });

  test('nieobsługiwana akcja, brak arkusza i pusty arkusz', () => {
    const gas = project({ commands: [cmd('DELETE_EVERYTHING', '7')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /Nieobsługiwana akcja: DELETE_EVERYTHING/);
    assert.throws(() => loadProject({ properties: WRITE, sheets: {} }).processWpCommands(), /Brak arkusza WP COMMANDS/);
    assert.doesNotThrow(() => project({ commands: [] }).processWpCommands());
  });
});

describe('komendy odczytu', () => {
  test('GET_PAGE_BY_SLUG: znaleziona, nieznaleziona, wiele, brak sluga', () => {
    let gas = project({ commands: [cmd('GET_PAGE_BY_SLUG', 'home')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(plain(results(gas)[0].slice(2, 5)), [7, 'home', 'publish']);
    assert.equal(results(gas)[0][12], 'OK', 'Rank Math available');

    gas = project({ commands: [cmd('GET_PAGE_BY_SLUG', 'nie-ma')] });
    gas.processWpCommands();
    assert.match(message(gas), /Nie znaleziono strony o slug: nie-ma/);

    gas = project({ commands: [cmd('GET_PAGE_BY_SLUG', 'dup')], wp: fakeWordPress({ pages: [{ id: 1, slug: 'dup' }, { id: 2, slug: 'dup' }] }) });
    gas.processWpCommands();
    assert.match(message(gas), /więcej niż jedną stronę/);

    gas = project({ commands: [cmd('GET_PAGE_BY_SLUG', '')] });
    gas.processWpCommands();
    assert.match(message(gas), /Brak sluga/);
  });

  test('GET_PAGE_BY_ID i GET_RANK_MATH_META walidują ID i zapisują wiersz wyniku', () => {
    let gas = project({ commands: [cmd('GET_PAGE_BY_ID', 'abc')] });
    gas.processWpCommands();
    assert.match(message(gas), /wymaga numerycznego ID/);

    gas = project({ commands: [cmd('GET_RANK_MATH_META', '7')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /wraz z surowymi polami Rank Math/);
    assert.deepEqual(plain(results(gas)[0].slice(10, 12)), ['Home SEO', 'Opis']);

    gas = project({ commands: [cmd('GET_RANK_MATH_META', '7')], wp: fakeWordPress({ pages: [{ id: 7, slug: 'home', hasRankMath: false }] }) });
    gas.processWpCommands();
    assert.match(message(gas), /Brak pola cc_rank_math/);
  });

  test('GET_ALL_PAGES stronicuje po X-WP-TotalPages, nie dubluje i zwraca zakres wyników', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, slug: `p${i}`, status: i < 3 ? 'publish' : 'draft' }));
    const gas = project({ commands: [cmd('GET_ALL_PAGES')], wp: fakeWordPress({ pages: many, perPage: 2 }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /Pobrano wszystkie dostępne strony WordPress: 5$/);
    assert.equal(results(gas).length, 5);
    assert.equal(row(gas)[10], 'WP RESULTS!A2:M6');
    const listCalls = gas.$fetchCalls.filter(c => c.url.includes('/pages?context=edit&status='));
    assert.ok(listCalls.length >= 4, 'publish: 2 pages, draft: 1 page, others: 1 each');
  });

  test('GET_MEDIA_BY_ID i SEARCH_MEDIA', () => {
    let gas = project({ commands: [cmd('GET_MEDIA_BY_ID', '21')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /Pobrano media WordPress ID 21 \(logo\.png\)/);
    assert.equal(results(gas)[0][12], 'MEDIA');
    assert.equal(JSON.parse(results(gas)[0][8]).alt_text, 'stare alt');

    gas = project({ commands: [cmd('SEARCH_MEDIA', 'logo')] });
    gas.processWpCommands();
    assert.match(message(gas), /Znaleziono media dla „logo”: 1/);
    assert.equal(row(gas)[10], 'WP RESULTS!A2:M2');

    gas = project({ commands: [cmd('SEARCH_MEDIA', 'nic-takiego')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /Brak mediów pasujących do: nic-takiego/);
    assert.equal(results(gas).length, 0);

    gas = project({ commands: [cmd('SEARCH_MEDIA', '  ')] });
    gas.processWpCommands();
    assert.match(message(gas), /wymaga tekstu wyszukiwania/);
  });
});

describe('strażnik zapisu', () => {
  const WRITE_ACTIONS = [
    ['CREATE_PAGE_DRAFT', 'nowa', 'Tytuł', 'treść'], ['PUBLISH_PAGE', '8'], ['UPDATE_MEDIA_FIELD', '21', 'alt_text', 'x'],
    ['UPDATE_RANK_MATH_FIELD', '7', 'rank_math_title', 'x'], ['UPDATE_PAGE_FIELD', '7', 'title', 'x'],
    ['REPLACE_PAGE_CONTENT_TEXT', '7', 'Acme', 'ACME'], ['COPY_PAGE_LAYOUT', '8', '7'], ['RESTORE_SNAPSHOT', 'WP-S-x']
  ];

  test('każda komenda zapisu odmawia bez WP_ALLOW_WRITES i bez confirm=YES, zanim wyśle cokolwiek', () => {
    for (const [action, target, field, value] of WRITE_ACTIONS) {
      const off = project({ props: PROPS, commands: [cmd(action, target, field, value)] });
      off.processWpCommands();
      assert.equal(status(off), 'ERROR', action);
      assert.match(message(off), /Zapisy do WordPressa są wyłączone/, action);
      assert.equal(off.$fetchCalls.length, 0, `${action}: no request without writes`);

      const noConfirm = project({ commands: [cmd(action, target, field, value, 'NO')] });
      noConfirm.processWpCommands();
      assert.match(message(noConfirm), /Brak potwierdzenia YES/, action);
      assert.equal(noConfirm.$fetchCalls.length, 0, `${action}: no request without confirm`);
    }
  });
});

describe('CREATE_PAGE_DRAFT', () => {
  test('tworzy szkic, sprawdza odczytem kontrolnym i zapisuje wynik', () => {
    const gas = project({ commands: [cmd('CREATE_PAGE_DRAFT', 'Nowa-Strona', 'Nowa strona', '<p>Treść</p>')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /Utworzono szkic strony WordPress ID 22 o slugu \/nowa-strona\/\. Strona NIE została opublikowana\./);
    assert.deepEqual(writes(gas)[0], { method: 'POST', path: '/wp-json/wp/v2/pages', body: { title: 'Nowa strona', slug: 'nowa-strona', content: '<p>Treść</p>', status: 'draft' } });
    assert.equal(gas.$wp.pages.get(22).status, 'draft');
    assert.equal(results(gas)[0][3], 'nowa-strona');
  });

  test('odmawia duplikatu sluga, złego sluga, braku tytułu i treści', () => {
    const run = (target, field, value) => { const g = project({ commands: [cmd('CREATE_PAGE_DRAFT', target, field, value)] }); g.processWpCommands(); return g; };
    assert.match(message(run('home', 'T', 'x')), /Strona o slugu home już istnieje \(ID 7, status publish\)/);
    assert.match(message(run('Zły slug!', 'T', 'x')), /bezpiecznego sluga/);
    assert.match(message(run('ok-slug', '', 'x')), /wymaga tytułu/);
    assert.match(message(run('ok-slug', 'T', '   ')), /wymaga treści/);
    assert.equal(writes(run('Zły slug!', 'T', 'x')).length, 0);
  });

  test('odczyt kontrolny różny od zlecenia jest błędem, choć WordPress odpowiedział 201', () => {
    const gas = project({ commands: [cmd('CREATE_PAGE_DRAFT', 'nowa', 'T', 'x')], wp: fakeWordPress({ pages: SAMPLE_PAGES, readBackLies: true }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /Odczyt kontrolny utworzonej strony nie zgadza się/);
  });

  test('odpowiedź bez ID jest błędem', () => {
    const gas = project({ commands: [cmd('CREATE_PAGE_DRAFT', 'nowa', 'T', 'x')], wp: fakeWordPress({ pages: SAMPLE_PAGES, failures: { 'POST /wp-json/wp/v2/pages': { code: 201, text: '{}' } } }) });
    gas.processWpCommands();
    assert.match(message(gas), /odpowiedź nie zawiera ID/);
  });
});

describe('PUBLISH_PAGE', () => {
  test('publikuje szkic po snapshocie i potwierdza odczytem', () => {
    const gas = project({ commands: [cmd('PUBLISH_PAGE', '8')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /Opublikowano stronę ID 8 \/szkic\/\. Snapshot przed publikacją: WP-S-\d{8}-\d{6}-8-/);
    assert.deepEqual(writes(gas), [{ method: 'POST', path: '/wp-json/wp/v2/pages/8', body: { status: 'publish' } }]);
    assert.equal(snapshots(gas).length, 1);
    assert.deepEqual(plain(snapshots(gas)[0].slice(2, 5)), [8, 'szkic', 'Szkic']);
    assert.equal(snapshots(gas)[0][7], 'draft', 'snapshot keeps the pre-publish status');
    assert.equal(gas.$wp.pages.get(8).status, 'publish');
  });

  test('już opublikowana → idempotentnie bez zapisu; nie-szkic → odmowa; niekompletna → odmowa', () => {
    let gas = project({ commands: [cmd('PUBLISH_PAGE', '7')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.match(message(gas), /jest już opublikowana\. Nie wykonano zmiany\./);
    assert.equal(writes(gas).length, 0);

    gas = project({ commands: [cmd('PUBLISH_PAGE', '5')], wp: fakeWordPress({ pages: [{ id: 5, slug: 'p', status: 'pending', title: 'T', content: 'c' }] }) });
    gas.processWpCommands();
    assert.match(message(gas), /publikuje wyłącznie strony ze statusem draft.*pending/);

    gas = project({ commands: [cmd('PUBLISH_PAGE', '9')] });
    gas.processWpCommands();
    assert.match(message(gas), /Nie publikuję niekompletnej strony ID 9/);
    assert.equal(snapshots(gas).length, 0, 'no snapshot before validation passes');
  });

  test('brak potwierdzenia publikacji w odczycie kontrolnym jest błędem', () => {
    const gas = project({ commands: [cmd('PUBLISH_PAGE', '8')], wp: fakeWordPress({ pages: SAMPLE_PAGES, readBackLies: true }) });
    gas.processWpCommands();
    assert.match(message(gas), /nie potwierdził publikacji/);
  });
});

describe('UPDATE_PAGE_FIELD i REPLACE_PAGE_CONTENT_TEXT', () => {
  test('UPDATE_PAGE_FIELD zapisuje snapshot, wysyła jedno pole i zapisuje stan po zmianie', () => {
    const gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'Nowy tytuł')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(writes(gas), [{ method: 'POST', path: '/wp-json/wp/v2/pages/7', body: { title: 'Nowy tytuł' } }]);
    assert.equal(snapshots(gas)[0][4], 'Home', 'snapshot holds the old title');
    assert.equal(results(gas)[0][6], 'Nowy tytuł');
    assert.match(message(gas), /Zaktualizowano title strony ID 7\. Snapshot przed zmianą: WP-S-/);
  });

  test('UPDATE_PAGE_FIELD odrzuca pole spoza listy i nienumeryczne ID bez żądań', () => {
    let gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'status', 'publish')] });
    gas.processWpCommands();
    assert.match(message(gas), /Niedozwolone pole: status\. Dozwolone: title, excerpt, content/);
    assert.equal(gas.$fetchCalls.length, 0);
    gas = project({ commands: [cmd('UPDATE_PAGE_FIELD', 'home', 'title', 'x')] });
    gas.processWpCommands();
    assert.match(message(gas), /wymaga ID strony/);
  });

  test('REPLACE_PAGE_CONTENT_TEXT podmienia fragment występujący dokładnie raz', () => {
    const gas = project({ commands: [cmd('REPLACE_PAGE_CONTENT_TEXT', '7', 'firmie Acme', 'firmie ACME S.A.')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.equal(writes(gas)[0].body.content, 'Witaj w firmie ACME S.A.. Zapraszamy.');
    assert.equal(gas.$wp.pages.get(7).content, 'Witaj w firmie ACME S.A.. Zapraszamy.');
    assert.equal(snapshots(gas).length, 1);
  });

  test('REPLACE_PAGE_CONTENT_TEXT odmawia przy 0 lub 2 wystąpieniach i pustym fragmencie', () => {
    const run = (find, repl) => { const g = project({ commands: [cmd('REPLACE_PAGE_CONTENT_TEXT', '7', find, repl)] }); g.processWpCommands(); return g; };
    assert.match(message(run('nie ma', 'x')), /znaleziono: 0/);
    assert.match(message(run('a', 'x')), /znaleziono: [2-9]/);
    assert.match(message(run('', 'x')), /wymaga tekstu do znalezienia/);
    assert.equal(writes(run('nie ma', 'x')).length, 0);
  });

  test('REPLACE_PAGE_CONTENT_TEXT: odczyt kontrolny bez podmiany jest błędem', () => {
    const gas = project({ commands: [cmd('REPLACE_PAGE_CONTENT_TEXT', '7', 'Acme', 'X')], wp: fakeWordPress({ pages: SAMPLE_PAGES, readBackLies: true }) });
    gas.processWpCommands();
    assert.match(message(gas), /nie potwierdził dokładnej podmiany/);
  });
});

describe('UPDATE_RANK_MATH_FIELD i UPDATE_MEDIA_FIELD', () => {
  test('Rank Math: snapshot z polami SEO, zapis przez bridge, odczyt kontrolny', () => {
    const gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_description', 'Nowy opis')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(writes(gas), [{ method: 'POST', path: '/wp-json/acme/v1/seo-meta', body: { post_id: 7, field: 'rank_math_description', value: 'Nowy opis' } }]);
    assert.deepEqual(plain(snapshots(gas)[0].slice(10, 13)), ['Home SEO', 'Opis', 'TRUE']);
    assert.equal(results(gas)[0][11], 'Nowy opis');
  });

  test('Rank Math: pole spoza listy i rozjazd odczytu kontrolnego', () => {
    let gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_canonical', 'x')] });
    gas.processWpCommands();
    assert.match(message(gas), /Niedozwolone pole Rank Math: rank_math_canonical/);
    gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_title', 'x')], wp: fakeWordPress({ pages: SAMPLE_PAGES, readBackLies: true }) });
    gas.processWpCommands();
    assert.match(message(gas), /odczyt kontrolny nie zgadza się z zapisem\. Pole: rank_math_title/);
  });

  test('#88: robots idzie osobnym endpointem seo-robots, ze snapshotem i odczytem kontrolnym', () => {
    const gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'noindex, follow')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(writes(gas), [{ method: 'POST', path: '/wp-json/acme/v1/seo-robots', body: { post_id: 7, value: 'noindex,follow' } }]);
    assert.match(message(gas), /Zaktualizowano rank_math_robots strony ID 7/);
    assert.match(message(gas), /Snapshot przed zmianą: WP-S-/);
  });

  test('#88: arkusz snapshotów sprzed robots jest poszerzany o brakujące kolumny', () => {
    // Istniejący arkusz ma dokładnie 15 kolumn nagłówka, więc zapis 17-kolumnowego
    // wiersza wymaga najpierw dołożenia kolumn — inaczej setValues rzuca wyjątkiem.
    const gas = project({
      commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'noindex')],
      sheets: { 'WP SNAPSHOTS': { rows: [SNAPSHOTS_HEADER], maxColumns: SNAPSHOTS_HEADER.length } }
    });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    const header = gas.$sheet('WP SNAPSHOTS')[0];
    assert.equal(header[15], 'rank_math_robots');
    assert.equal(header[16], 'rank_math_robots_captured');
    assert.equal(snapshots(gas)[0][16], 'TRUE');
  });

  test('#88: pusta wartość czyści robots, kolejność dyrektyw nie powoduje fałszywego rozjazdu', () => {
    const pages = [Object.assign({}, SAMPLE_PAGES[0], { robots: 'noindex,follow' })];
    const cleared = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', '')], wp: fakeWordPress({ pages }) });
    cleared.processWpCommands();
    assert.equal(status(cleared), 'DONE');
    assert.deepEqual(writes(cleared), [{ method: 'POST', path: '/wp-json/acme/v1/seo-robots', body: { post_id: 7, value: '' } }]);

    // WordPress oddaje dyrektywy w innej kolejności niż zapisane; to nie jest rozjazd.
    const swapped = fakeWordPress({ pages: [Object.assign({}, SAMPLE_PAGES[0], { robots: '' })] });
    const original = swapped.fetch;
    const gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'follow,noindex')], wp: Object.assign({}, swapped, {
      fetch: (url, params) => {
        const res = original(url, params);
        if (res.json && Object.prototype.hasOwnProperty.call(res.json, 'cc_rank_math_robots') && res.json.cc_rank_math_robots) {
          res.json.cc_rank_math_robots = res.json.cc_rank_math_robots.split(',').reverse().join(',');
        }
        return res;
      }
    }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
  });

  test('#88: zła i sprzeczna dyrektywa są odrzucane przed jakimkolwiek żądaniem', () => {
    const bad = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'niepoprawna')] });
    bad.processWpCommands();
    assert.match(message(bad), /Niedozwolona dyrektywa robots: niepoprawna\. Dozwolone: index, noindex/);
    assert.deepEqual(writes(bad), [], 'nic nie poszło do WordPressa');

    const contradiction = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'index,noindex')] });
    contradiction.processWpCommands();
    assert.match(message(contradiction), /Sprzeczne dyrektywy robots: index i noindex naraz/);
    assert.deepEqual(writes(contradiction), []);

    const follow = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'follow,nofollow')] });
    follow.processWpCommands();
    assert.match(message(follow), /Sprzeczne dyrektywy robots: follow i nofollow naraz/);
  });

  test('#88: stary snippet bez pola robots → jasny komunikat, żaden zapis i żaden snapshot', () => {
    const pages = [Object.assign({}, SAMPLE_PAGES[0], { hasRobots: false })];
    const gas = project({ commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'noindex')], wp: fakeWordPress({ pages }) });
    gas.processWpCommands();
    assert.match(message(gas), /Most nie udostępnia pola cc_rank_math_robots.*Zaktualizuj snippet page-layout-rest-bridge\.php/s);
    assert.deepEqual(writes(gas), []);
    assert.equal(snapshots(gas).length, 0, 'brak snapshotu, bo komenda padła przed zapisem');
  });

  test('#88: rozjazd odczytu kontrolnego robots jest błędem', () => {
    const gas = project({
      commands: [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_robots', 'noindex')],
      wp: fakeWordPress({ pages: SAMPLE_PAGES, readBackLies: true })
    });
    gas.processWpCommands();
    assert.match(message(gas), /odczyt kontrolny nie zgadza się z zapisem\. Pole: rank_math_robots/);
  });

  test('media: snapshot MEDIA z JSON stanu, zapis jednego pola, odczyt kontrolny', () => {
    const gas = project({ commands: [cmd('UPDATE_MEDIA_FIELD', '21', 'alt_text', 'Logo firmy')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(writes(gas), [{ method: 'POST', path: '/wp-json/wp/v2/media/21', body: { alt_text: 'Logo firmy' } }]);
    const snap = snapshots(gas)[0];
    assert.equal(snap[13], 'MEDIA');
    assert.equal(JSON.parse(snap[14]).alt_text, 'stare alt');
    assert.match(message(gas), /Zaktualizowano alt_text mediów ID 21\. Snapshot przed zmianą: WP-SM-/);
  });

  test('media: pole spoza listy, nienumeryczne ID, rozjazd odczytu', () => {
    let gas = project({ commands: [cmd('UPDATE_MEDIA_FIELD', '21', 'source_url', 'x')] });
    gas.processWpCommands();
    assert.match(message(gas), /Niedozwolone pole mediów: source_url/);
    gas = project({ commands: [cmd('UPDATE_MEDIA_FIELD', 'logo', 'alt_text', 'x')] });
    gas.processWpCommands();
    assert.match(message(gas), /wymaga numerycznego ID mediów/);
    gas = project({ commands: [cmd('UPDATE_MEDIA_FIELD', '21', 'alt_text', 'x')], wp: fakeWordPress({ media: SAMPLE_MEDIA, readBackLies: true }) });
    gas.processWpCommands();
    assert.match(message(gas), /odczyt kontrolny mediów nie zgadza się/);
  });
});

describe('RESTORE_SNAPSHOT', () => {
  const pageSnapshot = ['WP-S-1', 'CMD-0', 7, 'home', 'Stary tytuł', 'Stary excerpt', 'Stara treść', 'publish', '', '', 'Stare SEO', 'Stary opis', 'TRUE', 'PAGE', ''];

  test('przywraca stronę wraz z Rank Math i zapisuje snapshot bezpieczeństwa', () => {
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-1')], snapshots: [pageSnapshot] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.equal(writes(gas)[0].path, '/wp-json/wp/v2/pages/7');
    assert.deepEqual(writes(gas)[0].body, { title: 'Stary tytuł', excerpt: 'Stary excerpt', content: 'Stara treść', status: 'publish' });
    assert.deepEqual(writes(gas).slice(1).map(w => [w.body.field, w.body.value]), [['rank_math_title', 'Stare SEO'], ['rank_math_description', 'Stary opis']]);
    assert.equal(gas.$wp.pages.get(7).title, 'Stary tytuł');
    assert.equal(snapshots(gas).length, 2, 'safety snapshot appended');
    assert.equal(snapshots(gas)[1][4], 'Home', 'safety snapshot holds the pre-rollback title');
    assert.match(message(gas), /wraz z polami Rank Math\. UWAGA: snapshot powstał przed obsługą robots.*Snapshot stanu sprzed rollbacku: WP-S-/);
  });

  test('bez Rank Math w snapshocie pola SEO nie są dotykane', () => {
    const snap = pageSnapshot.slice(); snap[12] = 'FALSE';
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-1')], snapshots: [snap] });
    gas.processWpCommands();
    assert.equal(writes(gas).length, 1);
    assert.match(message(gas), /dla strony ID 7\. UWAGA: snapshot powstał przed obsługą robots/);
  });

  test('#88: snapshot z robots cofa też robots i potwierdza to odczytem kontrolnym', () => {
    const snap = pageSnapshot.slice().concat(['noindex,follow', 'TRUE']);
    const pages = [Object.assign({}, SAMPLE_PAGES[0], { robots: 'index' })];
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-1')], snapshots: [snap], wp: fakeWordPress({ pages }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    const robotsWrite = writes(gas).find(w => w.path.endsWith('/seo-robots'));
    assert.deepEqual(robotsWrite.body, { post_id: 7, value: 'noindex,follow' });
    assert.equal(gas.$wp.pages.get(7).robots, 'noindex,follow', 'ustawienie faktycznie cofnięte');
    assert.match(message(gas), /Robots przywrócone: "noindex,follow"/);
  });

  test('#88: pusty robots w snapshocie też jest cofany, jako powrót do domyślnych', () => {
    const snap = pageSnapshot.slice().concat(['', 'TRUE']);
    const pages = [Object.assign({}, SAMPLE_PAGES[0], { robots: 'noindex' })];
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-1')], snapshots: [snap], wp: fakeWordPress({ pages }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    assert.equal(gas.$wp.pages.get(7).robots, '');
    assert.match(message(gas), /Robots przywrócone: "domyślne Rank Math"/);
  });

  test('#88: rollback, który nie cofnął robots, jest błędem, a nie cichym sukcesem', () => {
    const snap = pageSnapshot.slice().concat(['noindex', 'TRUE']);
    const pages = [Object.assign({}, SAMPLE_PAGES[0], { robots: 'index' })];
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-1')], snapshots: [snap], wp: fakeWordPress({ pages, readBackLies: true }) });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /Rollback zapisał robots, ale odczyt kontrolny nie zgadza się ze snapshotem/);
  });

  test('przywraca snapshot MEDIA pole po polu z kontrolą', () => {
    const mediaSnap = ['WP-SM-1', 'CMD-0', 21, 'logo', 'Logo', '', '', 'MEDIA', '', '', '', '', '', 'MEDIA', JSON.stringify({ id: 21, title: 'Logo stare', alt_text: 'alt stare', caption: 'c', description: 'd' })];
    const gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-SM-1')], snapshots: [mediaSnap] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
    assert.deepEqual(writes(gas).map(w => Object.keys(w.body)[0]), ['title', 'alt_text', 'caption', 'description']);
    assert.equal(gas.$wp.media.get(21).alt_text, 'alt stare');
    assert.match(message(gas), /Przywrócono snapshot MEDIA WP-SM-1 dla mediów ID 21/);
  });

  test('brak snapshotu, pusty target, uszkodzony JSON MEDIA', () => {
    let gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-S-nope')], snapshots: [pageSnapshot] });
    gas.processWpCommands();
    assert.match(message(gas), /Nie znaleziono snapshotu: WP-S-nope/);
    gas = project({ commands: [cmd('RESTORE_SNAPSHOT', '')] });
    gas.processWpCommands();
    assert.match(message(gas), /wymaga snapshot_id/);
    const bad = ['WP-SM-2', '', 21, '', '', '', '', 'MEDIA', '', '', '', '', '', 'MEDIA', '{not json'];
    gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-SM-2')], snapshots: [bad] });
    gas.processWpCommands();
    assert.match(message(gas), /Nie można odczytać media_before_json/);
    const empty = ['WP-SM-3', '', 21, '', '', '', '', 'MEDIA', '', '', '', '', '', 'MEDIA', '{}'];
    gas = project({ commands: [cmd('RESTORE_SNAPSHOT', 'WP-SM-3')], snapshots: [empty] });
    gas.processWpCommands();
    assert.match(message(gas), /nie zawiera prawidłowych danych/);
  });
});

describe('tryb próbny WP_DRY_RUN', () => {
  test('komenda zapisu przechodzi walidacje, odczyty i snapshot, ale żaden POST nie wychodzi; wiersz dostaje DRY_RUN z opisem żądania', () => {
    const gas = project({ props: DRY, commands: [cmd('UPDATE_PAGE_FIELD', '7', 'title', 'Nowy tytuł')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DRY_RUN');
    assert.equal(row(gas)[8], '');
    assert.equal(message(gas), 'DRY RUN – nie wysłano. POST https://www.example.pl/wp-json/wp/v2/pages/7 | payload: {"title":"Nowy tytuł"}');
    assert.equal(writes(gas).length, 0, 'no write reached WordPress');
    assert.equal(gas.$wp.pages.get(7).title, 'Home');
    assert.equal(snapshots(gas).length, 1, 'snapshot of the current state was still taken');
    assert.equal(gas.$fetchCalls.every(c => c.params.method === 'get'), true);
  });

  test('dry run działa bez WP_ALLOW_WRITES, ale bez WP_DRY_RUN blokada zapisów pozostaje', () => {
    const dry = project({ props: DRY, commands: [cmd('PUBLISH_PAGE', '8')] });
    dry.processWpCommands();
    assert.equal(status(dry), 'DRY_RUN');
    assert.match(message(dry), /POST https:\/\/www\.example\.pl\/wp-json\/wp\/v2\/pages\/8 \| payload: \{"status":"publish"\}/);

    const off = project({ props: PROPS, commands: [cmd('PUBLISH_PAGE', '8')] });
    off.processWpCommands();
    assert.equal(status(off), 'ERROR');
  });

  test('walidacje w dry run nadal odrzucają złe komendy, więc podgląd nie kłamie', () => {
    const gas = project({ props: DRY, commands: [cmd('REPLACE_PAGE_CONTENT_TEXT', '7', 'nie ma', 'x')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /znaleziono: 0/);
  });

  test('komendy odczytu w dry run wykonują się normalnie', () => {
    const gas = project({ props: DRY, commands: [cmd('GET_PAGE_BY_ID', '7')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE');
  });

  test('dry run opisuje dokładnie żądanie z tego samego buildera co zapis (bridge, create, media)', () => {
    const cases = [
      [cmd('CREATE_PAGE_DRAFT', 'nowa', 'T', 'x'), 'POST https://www.example.pl/wp-json/wp/v2/pages | payload: {"title":"T","slug":"nowa","content":"x","status":"draft"}'],
      [cmd('UPDATE_RANK_MATH_FIELD', '7', 'rank_math_title', 'S'), 'POST https://www.example.pl/wp-json/acme/v1/seo-meta | payload: {"post_id":7,"field":"rank_math_title","value":"S"}'],
      [cmd('UPDATE_MEDIA_FIELD', '21', 'alt_text', 'A'), 'POST https://www.example.pl/wp-json/wp/v2/media/21 | payload: {"alt_text":"A"}'],
      [cmd('COPY_PAGE_LAYOUT', '8', '7'), 'POST https://www.example.pl/wp-json/acme/v1/page-layout | payload: {"target_post_id":8,"source_post_id":7}']
    ];
    for (const [command, expected] of cases) {
      const gas = project({ props: DRY, commands: [command] });
      gas.processWpCommands();
      assert.equal(status(gas), 'DRY_RUN', command[2]);
      assert.equal(message(gas), 'DRY RUN – nie wysłano. ' + expected, command[2]);
      assert.equal(writes(gas).length, 0, command[2]);
    }
  });

  test('buildWpRequest_ jest jedynym źródłem żądania: dry run i zapis dają identyczny url, metodę i payload', () => {
    const real = project({ commands: [cmd('UPDATE_PAGE_FIELD', '7', 'excerpt', 'E')] });
    real.processWpCommands();
    const sent = real.$fetchCalls.find(c => c.params.method === 'post');
    const dry = project({ props: DRY, commands: [cmd('UPDATE_PAGE_FIELD', '7', 'excerpt', 'E')] });
    dry.processWpCommands();
    assert.equal(message(dry), `DRY RUN – nie wysłano. POST ${sent.url} | payload: ${sent.params.payload}`);
  });
});
