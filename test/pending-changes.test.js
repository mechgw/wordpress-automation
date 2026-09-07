'use strict';

/**
 * #130: SEO LIVE rozpoznaje zmiany oczekujące na wykonanie.
 *
 * Wyścig operacyjny: polecenie przygotowane wieczorem, poranny live check widzi
 * jeszcze stary stan i alarmuje, a polecenie wykonuje się później tego samego
 * dnia. Alert jest wtedy prawdziwy, ale bezużyteczny.
 *
 * Testy pilnują przede wszystkim tego, co NIE może wyciszyć alertu, bo tłumienie
 * prawdziwej regresji byłoby znacznie gorsze niż jeden alert za dużo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, plain } = require('./helpers/gas');

const SHEET = 'SEO LIVE';
const HEADER = [
  'URL', 'Oczekiwany status HTTP', 'Oczekiwany URL docelowy', 'Oczekiwany title', 'Oczekiwany H1',
  'Oczekiwany canonical', 'Oczekiwane robots', 'Oczekiwane schema (@type)', 'Wynik (live)',
  'Różnice', 'Sprawdzono', 'Indeks Google (URL INSPEKCJA)'
];
const COMMANDS = 'WP COMMANDS';
const COMMANDS_HEADER = ['id', 'created_at', 'action', 'target', 'field', 'value', 'confirm', 'status', 'http', 'message', 'result_ref', 'done_at', 'note'];

const URL = 'https://www.example.pl/dane/';
const PROPS = { WP_BASE_URL: 'https://www.example.pl', WP_USERNAME: 'bot', WP_APP_PASSWORD: 'pw', WP_REST_NAMESPACE: 'acme' };

const hoursAgo = h => new Date(Date.now() - h * 3600000);
/** Strona serwuje index, a wiersz oczekuje noindex: jedna różnica w robots. */
const pageHtml = '<html><head><title>Dane</title><meta name="robots" content="index, follow"></head><body><h1>Dane</h1></body></html>';
const row = () => [URL, '', '', '', '', '', 'noindex', '', '', '', '', ''];
const command = (extra = {}) => [
  extra.id || 'CMD-1',
  extra.createdAt || hoursAgo(2),
  extra.action || 'UPDATE_RANK_MATH_FIELD',
  extra.target || '7',
  extra.field === undefined ? 'rank_math_robots' : extra.field,
  'noindex',
  extra.confirm || 'YES',
  extra.status || 'PENDING',
  '', '', '', '', ''
];

function project({ commands = [], properties = {}, seoRow = row() } = {}) {
  return loadProject({
    properties: Object.assign({}, PROPS, properties),
    sheets: {
      [SHEET]: [HEADER, seoRow],
      [COMMANDS]: [COMMANDS_HEADER, ...commands]
    },
    fetch: url => {
      if (String(url).indexOf('/wp-json/wp/v2/pages/7') === 0 || String(url).indexOf('/wp-json/wp/v2/pages/7') > 0) {
        return { code: 200, text: JSON.stringify({ id: 7, link: URL }) };
      }
      if (String(url).indexOf('/wp-json/') > 0) return { code: 404, text: '{}' };
      return { code: 200, text: pageHtml };
    }
  });
}

const resultOf = gas => String(gas.$sheet(SHEET)[1][8]);
const detailsOf = gas => String(gas.$sheet(SHEET)[1][9]);

describe('#130: mapowanie pola na różnicę', () => {
  const gas = loadProject({});

  test('tylko jawnie wymienione pary dają aspekt', () => {
    assert.equal(gas.pendingChangeAspect_('UPDATE_RANK_MATH_FIELD', 'rank_math_robots'), 'robots:');
    assert.equal(gas.pendingChangeAspect_('UPDATE_RANK_MATH_FIELD', 'rank_math_title'), 'title:');
    assert.equal(gas.pendingChangeAspect_('PUBLISH_PAGE', ''), 'status:');
  });

  test('pole spoza mapy nie wycisza niczego', () => {
    assert.equal(gas.pendingChangeAspect_('UPDATE_RANK_MATH_FIELD', 'rank_math_description'), '');
    assert.equal(gas.pendingChangeAspect_('UPDATE_PAGE_FIELD', 'content'), '');
    assert.equal(gas.pendingChangeAspect_('RESTORE_SNAPSHOT', ''), '');
  });
});

describe('#130: co wycisza alert, a co nie', () => {
  test('T3: zatwierdzone polecenie w oknie oczekiwania daje PENDING CHANGE zamiast alertu', () => {
    const gas = project({ commands: [command()] });
    const summary = plain(gas.sprawdzStronyLive());
    assert.match(resultOf(gas), /^PENDING CHANGE: 1 różnic/);
    assert.match(detailsOf(gas), /oczekuje polecenie: CMD-1/);
    assert.equal(summary.pending, 1);
    assert.deepEqual(summary.newProblems, [], 'to nie jest nowa regresja');
    assert.deepEqual(summary.problems, [], 'ani problem do maila');
  });

  test('T4: po przekroczeniu progu niewykonane polecenie samo staje się alertem', () => {
    const gas = project({ commands: [command({ createdAt: hoursAgo(60) })] });
    const summary = plain(gas.sprawdzStronyLive());
    assert.equal(resultOf(gas), 'UWAGA: zmiana oczekuje zbyt długo');
    assert.match(detailsOf(gas), /czeka dłużej niż 48 h i nadal nie zostało wykonane/);
    assert.equal(summary.warnings, 1);
    assert.equal(summary.newProblems.length, 1, 'to już jest problem');
  });

  test('T5: polecenie bez potwierdzenia nie wycisza', () => {
    const gas = project({ commands: [command({ confirm: 'NO' })] });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/);
  });

  test('T6: tryb próbny i polecenie już wykonane nie wyciszają', () => {
    for (const status of ['DRY_RUN', 'DONE', 'ERROR', 'SKIPPED']) {
      const gas = project({ commands: [command({ status: status })] });
      gas.sprawdzStronyLive();
      assert.match(resultOf(gas), /^UWAGA: 1 różnic/, 'status ' + status + ' nie jest obietnicą zmiany');
    }
  });

  test('polecenie dla innej strony nie wycisza', () => {
    const gas = project({ commands: [command({ target: '99' })] });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/);
  });

  test('polecenie zmieniające inne pole nie wycisza różnicy w robots', () => {
    const gas = project({ commands: [command({ field: 'rank_math_description' })] });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/);
  });

  test('jedna niewyjaśniona różnica znosi wyciszenie całego wiersza', () => {
    // Wiersz oczekuje też innego title, czego polecenie o robots nie naprawi.
    const seoRow = [URL, '', '', 'Inny tytuł', '', '', 'noindex', '', '', '', '', ''];
    const gas = project({ commands: [command()], seoRow: seoRow });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 2 różnic/, 'brak ciszy, gdy cokolwiek zostaje niewyjaśnione');
  });

  test('brak poleceń zachowuje dotychczasowe zachowanie', () => {
    const gas = project({});
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/);
  });

  test('próg oczekiwania da się skonfigurować', () => {
    const gas = project({
      commands: [command({ createdAt: hoursAgo(5) })],
      properties: { SEO_LIVE_PENDING_GRACE_HOURS: '4' }
    });
    gas.sprawdzStronyLive();
    assert.equal(resultOf(gas), 'UWAGA: zmiana oczekuje zbyt długo');
    assert.match(detailsOf(gas), /dłużej niż 4 h/);
  });

  test('nieprawidłowy próg wraca do wartości domyślnej', () => {
    const gas = loadProject({ properties: { SEO_LIVE_PENDING_GRACE_HOURS: 'dużo' } });
    assert.equal(gas.pendingChangeGraceHours_(), 48);
    const zero = loadProject({ properties: { SEO_LIVE_PENDING_GRACE_HOURS: '0' } });
    assert.equal(zero.pendingChangeGraceHours_(), 48);
  });
});

describe('#130: monitoring pozostaje read-only', () => {
  test('przebieg nie wysyła do WordPressa żadnego zapisu', () => {
    const gas = project({ commands: [command()] });
    gas.sprawdzStronyLive();
    const writes = gas.$fetchCalls.filter(c => String((c.params && c.params.method) || 'get').toLowerCase() !== 'get');
    assert.deepEqual(writes, [], 'live check nigdy nie zapisuje');
  });

  test('polecenie zostaje w kolejce nietknięte', () => {
    const gas = project({ commands: [command()] });
    gas.sprawdzStronyLive();
    const line = gas.$sheet(COMMANDS)[1];
    assert.equal(line[7], 'PENDING', 'status bez zmian');
    assert.equal(line[9], '', 'żadnego komunikatu wykonania');
  });

  test('brak konfiguracji WordPressa nie wycisza i nie wywraca przebiegu', () => {
    // wpFetch_ rzuca, gdy brakuje Script Properties; live check ma to przeżyć
    // i zachować się jak dotąd, a nie zamilknąć ani paść.
    const gas = loadProject({
      sheets: { [SHEET]: [HEADER, row()], [COMMANDS]: [COMMANDS_HEADER, command()] },
      fetch: () => ({ code: 200, text: pageHtml })
    });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/);
  });

  test('niedostępne WordPress API nie wycisza niczego', () => {
    const gas = loadProject({
      properties: PROPS,
      sheets: { [SHEET]: [HEADER, row()], [COMMANDS]: [COMMANDS_HEADER, command()] },
      fetch: url => (String(url).indexOf('/wp-json/') > 0
        ? { code: 500, text: 'awaria' }
        : { code: 200, text: pageHtml })
    });
    gas.sprawdzStronyLive();
    assert.match(resultOf(gas), /^UWAGA: 1 różnic/, 'brak dopasowania prowadzi do alertu, nie do ciszy');
  });
});
