'use strict';

/**
 * #109: duża treść strony poza limitem komórki Arkuszy.
 *
 * Komórka mieści 50 000 znaków, więc pełna wymiana treści długiej strony była
 * niewykonalna. Treść przychodzi teraz z zakładki payloadów, podzielona na
 * części, a w komendzie zostaje sama referencja.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain, CELL_CHAR_LIMIT } = require('./helpers/gas');
const { fakeWordPress } = require('./helpers/wordpress');

const PAYLOADS = 'WP PAYLOADS';
const PAYLOADS_HEADER = ['payload_id', 'part', 'content', 'note'];
const COMMANDS_HEADER = ['id', 'created_at', 'action', 'target', 'field', 'value', 'confirm', 'status', 'http', 'message', 'result_ref', 'done_at', 'note'];
const RESULTS_HEADER = ['result_id', 'command_id', 'wp_id', 'slug', 'status', 'link', 'title', 'modified', 'content', 'at', 'rm_title', 'rm_desc', 'kind'];
const SNAPSHOTS_HEADER = ['snapshot_id', 'command_id', 'wp_id', 'slug', 'title', 'excerpt', 'content', 'status', 'modified', 'at', 'rm_title', 'rm_desc', 'rm_captured', 'snapshot_kind', 'media_before_json', 'rank_math_robots', 'rank_math_robots_captured'];

const WRITE = {
  WP_BASE_URL: 'https://www.example.pl',
  WP_USERNAME: 'bot',
  WP_APP_PASSWORD: 'pw',
  WP_REST_NAMESPACE: 'acme',
  WP_ALLOW_WRITES: 'TRUE'
};

const cmd = (value, field = 'content', id = 'CMD-1') =>
  [id, '2026-09-06', 'UPDATE_PAGE_FIELD', '7', field, value, 'YES', 'PENDING', '', '', '', '', ''];

function project({ payloads = [], commands = [], props = WRITE, wp } = {}) {
  const fake = wp || fakeWordPress({ pages: [{ id: 7, slug: 'home', status: 'publish', title: 'Home', content: 'stara treść' }] });
  const gas = loadProject({
    properties: props,
    sheets: {
      'WP COMMANDS': [COMMANDS_HEADER, ...commands],
      'WP RESULTS': [RESULTS_HEADER],
      'WP SNAPSHOTS': [SNAPSHOTS_HEADER],
      [PAYLOADS]: [PAYLOADS_HEADER, ...payloads]
    },
    fetch: fake.fetch
  });
  gas.$wp = fake.state;
  return gas;
}

const message = gas => String(gas.$sheet('WP COMMANDS')[1][9]);
const status = gas => gas.$sheet('WP COMMANDS')[1][7];

describe('#109: referencja do payloadu', () => {
  const gas = loadProject({});

  test('rozpoznaje tylko wąską, jednoznaczną postać referencji', () => {
    assert.equal(gas.isPayloadReference_('payload:strona-glowna'), true);
    assert.equal(gas.isPayloadReference_(' payload:abc '), true, 'spacje wokół nie mają znaczenia');
    assert.equal(gas.isPayloadReference_('payload:a b'), false, 'spacja w identyfikatorze to nie referencja');
    assert.equal(gas.isPayloadReference_('<p>payload:abc</p>'), false, 'treść zawierająca to słowo nie jest referencją');
    assert.equal(gas.isPayloadReference_(''), false);
    assert.equal(gas.isPayloadReference_(null), false);
  });
});

describe('#109: sklejanie payloadu', () => {
  test('skleja części w kolejności numerów, nie w kolejności wierszy', () => {
    const gas = project({ payloads: [['tekst', 3, 'trzy'], ['tekst', 1, 'raz '], ['tekst', 2, 'dwa ']] });
    const out = plain(gas.resolvePayload_('payload:tekst'));
    assert.equal(out.text, 'raz dwa trzy');
    assert.equal(out.parts, 3);
    assert.equal(out.chars, 12);
    assert.match(out.digest, /^[0-9a-f]{16}$/);
  });

  test('obsługuje treść powyżej limitu komórki, czyli powód istnienia tego mechanizmu', () => {
    const chunk = 'x'.repeat(CELL_CHAR_LIMIT - 100);
    const gas = project({ payloads: [['duzy', 1, chunk], ['duzy', 2, chunk]] });
    const out = plain(gas.resolvePayload_('payload:duzy'));
    assert.equal(out.chars, 2 * (CELL_CHAR_LIMIT - 100));
    assert.ok(out.chars > CELL_CHAR_LIMIT, 'jedna komórka by tego nie pomieściła');
  });

  test('luka w numeracji zatrzymuje komendę, zamiast wysłać treść z dziurą', () => {
    const gas = project({ payloads: [['tekst', 1, 'a'], ['tekst', 3, 'c']] });
    assert.throws(() => gas.resolvePayload_('payload:tekst'), /niekompletne części: oczekiwano 2, jest 3/);
  });

  test('zduplikowana część też jest niekompletnością, a nie sklejeniem na chybił trafił', () => {
    const gas = project({ payloads: [['tekst', 1, 'a'], ['tekst', 1, 'b']] });
    assert.throws(() => gas.resolvePayload_('payload:tekst'), /niekompletne części/);
  });

  test('numer części musi być liczbą całkowitą od 1', () => {
    for (const bad of [0, -1, 1.5, 'pierwsza']) {
      const gas = project({ payloads: [['tekst', bad, 'a']] });
      assert.throws(() => gas.resolvePayload_('payload:tekst'), /numer części musi być liczbą całkowitą/);
    }
  });

  test('brak payloadu, brak zakładki i payload pusty mają osobne komunikaty', () => {
    assert.throws(() => project({ payloads: [['inny', 1, 'a']] }).resolvePayload_('payload:tekst'), /nie ma żadnych części/);
    assert.throws(() => loadProject({}).resolvePayload_('payload:tekst'), /Brak zakładki „WP PAYLOADS”/);
    assert.throws(() => project({ payloads: [['tekst', 1, '']] }).resolvePayload_('payload:tekst'), /jest pusty/);
  });

  test('przekroczenie sufitu rozmiaru jest odrzucane z podaniem liczb', () => {
    // Sufit to 2 mln znaków: 41 części po 50 tys. przekracza go o jedną część.
    const parts = [];
    for (let i = 1; i <= 41; i++) parts.push(['wielki', i, 'x'.repeat(50000)]);
    assert.throws(
      () => project({ payloads: parts }).resolvePayload_('payload:wielki'),
      /ma 2050000 znaków, a limit to 2000000/
    );
  });

  test('wartość, która nie jest referencją, jest odrzucana wprost', () => {
    assert.throws(() => loadProject({}).resolvePayload_('<p>treść</p>'), /To nie jest referencja do payloadu/);
  });
});

describe('#109: UPDATE_PAGE_FIELD z payloadem', () => {
  test('zapisuje sklejoną treść i potwierdza ją skrótem, nie kopiując HTML-a', () => {
    const chunk = 'y'.repeat(CELL_CHAR_LIMIT - 100);
    const gas = project({
      payloads: [['duzy', 1, chunk], ['duzy', 2, chunk]],
      commands: [cmd('payload:duzy')]
    });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    assert.equal(gas.$wp.pages.get(7).content.length, 2 * (CELL_CHAR_LIMIT - 100));
    assert.match(message(gas), /z payload duzy: 2 część\(i\), 99800 znaków, skrót [0-9a-f]{16}/);
    assert.match(message(gas), /Snapshot przed zmianą: WP-S-/);
  });

  test('niekompletny payload zatrzymuje komendę przed snapshotem i przed zapisem', () => {
    const gas = project({
      payloads: [['tekst', 2, 'druga']],
      commands: [cmd('payload:tekst')]
    });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /niekompletne części/);
    assert.equal(gas.$sheet('WP SNAPSHOTS').length, 1, 'żaden snapshot nie powstał');
    assert.deepEqual(gas.$wp.writes, [], 'żaden zapis nie poszedł do WordPressa');
  });

  test('rozjazd odczytu kontrolnego jest błędem i nazywa prawdopodobną przyczynę', () => {
    const wp = fakeWordPress({
      pages: [{ id: 7, slug: 'home', status: 'publish', content: 'stara' }],
      readBackLies: true
    });
    const gas = project({ payloads: [['tekst', 1, 'nowa treść']], commands: [cmd('payload:tekst')], wp });
    gas.processWpCommands();
    assert.equal(status(gas), 'ERROR');
    assert.match(message(gas), /odczyt kontrolny nie zgadza się z payloadem/);
    assert.match(message(gas), /unfiltered_html/);
  });

  test('różnica w końcach linii nie jest rozjazdem treści', () => {
    const gas = project({ payloads: [['tekst', 1, 'wiersz\r\ndrugi\n\n']], commands: [cmd('payload:tekst')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
  });

  test('zwykła wartość działa jak dotąd i nie przechodzi przez payloady', () => {
    const gas = project({ commands: [cmd('<p>krótka treść</p>')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    assert.equal(gas.$wp.pages.get(7).content, '<p>krótka treść</p>');
    assert.doesNotMatch(message(gas), /payload/);
  });

  test('referencja w innym polu niż content jest traktowana jak zwykły tekst', () => {
    const gas = project({ payloads: [['tekst', 1, 'a']], commands: [cmd('payload:tekst', 'title')] });
    gas.processWpCommands();
    assert.equal(status(gas), 'DONE', message(gas));
    assert.equal(gas.$wp.pages.get(7).title, 'payload:tekst', 'tytuł to nie miejsce na wielki payload');
  });
});

describe('#109: przygotowanie zakładki z menu', () => {
  test('tworzy zakładkę z nagłówkiem i tłumaczy sposób użycia', () => {
    const gas = loadProject({});
    gas.przygotujZakladkePayloadow();
    assert.deepEqual(gas.$sheet(PAYLOADS)[0], PAYLOADS_HEADER);
    const text = gas.$alerts[0][0];
    assert.match(text, /jest gotowa \(wierszy z danymi: 0\)/);
    assert.match(text, /numerując part od 1 bez luk i duplikatów/);
    assert.match(text, /payload:<identyfikator>/);
  });

  test('na istniejącej zakładce nie kasuje danych i podaje ich liczbę', () => {
    const gas = project({ payloads: [['tekst', 1, 'a'], ['tekst', 2, 'b']] });
    gas.przygotujZakladkePayloadow();
    assert.equal(gas.$sheet(PAYLOADS).length, 3, 'nagłówek plus dwie części');
    assert.match(gas.$alerts[0][0], /wierszy z danymi: 2/);
  });

  test('pozycja jest w menu WordPress, obok wykonywania poleceń', () => {
    const gas = loadProject({});
    gas.onOpen();
    const wp = gas.$menus.find(m => m.title === 'WordPress');
    assert.ok(wp.items.map(i => i.fn).includes('przygotujZakladkePayloadow'));
  });
});

describe('#109: tryb próbny i skrót treści', () => {
  test('dry run opisuje duży payload rozmiarem i skrótem, nie treścią', () => {
    const chunk = 'z'.repeat(40000);
    const gas = project({
      payloads: [['duzy', 1, chunk], ['duzy', 2, chunk]],
      commands: [cmd('payload:duzy')],
      props: Object.assign({}, WRITE, { WP_ALLOW_WRITES: 'FALSE', WP_DRY_RUN: 'TRUE' })
    });
    gas.processWpCommands();
    assert.equal(status(gas), 'DRY_RUN');
    assert.match(message(gas), /payload: \d+ znaków, skrót [0-9a-f]{16} \(za duży, żeby go tu wypisać\)/);
    assert.equal(message(gas).length < 400, true, 'komunikat nie może zawierać całej treści');
    assert.doesNotMatch(message(gas), /zzzz/);
  });

  test('mały payload jest nadal wypisywany w całości, bo to pomaga', () => {
    const gas = project({
      commands: [cmd('<p>krótka</p>')],
      props: Object.assign({}, WRITE, { WP_ALLOW_WRITES: 'FALSE', WP_DRY_RUN: 'TRUE' })
    });
    gas.processWpCommands();
    assert.match(message(gas), /payload: \{"content":"<p>krótka<\/p>"\}/);
  });

  test('skrót jest stabilny, zależny od treści i skrócony do 16 znaków', () => {
    const gas = loadProject({});
    assert.equal(gas.contentDigest_('abc'), gas.contentDigest_('abc'));
    assert.notEqual(gas.contentDigest_('abc'), gas.contentDigest_('abd'));
    assert.match(gas.contentDigest_(''), /^[0-9a-f]{16}$/);
  });
});
