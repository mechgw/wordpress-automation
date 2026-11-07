'use strict';

/**
 * #231: strony bramki audytu - kto napisał treść, kto napisał komentarz.
 *
 * Wszystko idzie z jednego konta GitHuba, więc stronę wyznaczają protokołowe
 * sygnały: podpis ostatniej linii, etykieta `by:agent` i aplikacja, przez którą
 * powstał wpis (`performed_via_github_app`). Testy sprawdzają każdą gałąź
 * dokładnym powodem, bo powód trafia do logu przebiegu i jest jedynym śladem,
 * dlaczego issue została w `audit:pending`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sides = require('../scripts/quality/issue-audit-sides.js');
const { CLAUDE, GPT, GPT_APP, BY_AGENT, signatureSide, leadingLine, authorSide, commentSide, reviewerOf } = sides;

const SIGN_CLAUDE = '_— Claude Code (agent lokalny)_';
const SIGN_GPT = '_— ChatGPT_';

describe('#231 stałe stron', () => {
  test('nazwy stron, aplikacja konektora i etykieta agenta', () => {
    assert.equal(CLAUDE, 'claude');
    assert.equal(GPT, 'gpt');
    assert.equal(GPT_APP, 'ChatGPT Codex Connector');
    assert.equal(BY_AGENT, 'by:agent');
  });

  test('recenzentem jest strona przeciwna; nieustalony autor nie ma recenzenta', () => {
    assert.equal(reviewerOf(CLAUDE), GPT);
    assert.equal(reviewerOf(GPT), CLAUDE);
    for (const side of ['', undefined, null, 'owner', 'constructor']) assert.equal(reviewerOf(side), '', String(side));
  });
});

describe('#231 leadingLine: pierwsza niepusta linia bez wciętego kodu', () => {
  test('zwraca przyciętą pierwszą niepustą linię', () => {
    assert.equal(leadingLine('/audit-ok'), '/audit-ok');
    assert.equal(leadingLine('  /audit-ok  \nreszta'), '/audit-ok');
    assert.equal(leadingLine('\n \n\t \n/audit-ok\nreszta'), '/audit-ok');
    assert.equal(leadingLine('/audit-ok\r\nreszta'), '/audit-ok');
    assert.equal(leadingLine('/audit-ok\rreszta'), '/audit-ok');
    assert.equal(leadingLine('   /audit-ok'), '/audit-ok', 'trzy spacje to jeszcze nie kod');
  });

  test('cztery spacje, tabulator albo spacje przed tabulatorem to blok kodu - brak linii', () => {
    for (const body of ['    /audit-ok', '\t/audit-ok', ' \t/audit-ok', '  \t/audit-ok', '   \t/audit-ok', '      /audit-ok', '\n\n    /audit-ok\n/audit-changes']) {
      assert.equal(leadingLine(body), '', JSON.stringify(body));
    }
  });

  test('pusty, biały albo nietekstowy wpis nie ma linii', () => {
    for (const body of ['', '   ', '\n\n', '\t\n ', null, undefined]) assert.equal(leadingLine(body), '', String(body));
  });

  test('wartość spoza napisu jest zamieniana na napis, a 0 to nadal tekst', () => {
    assert.equal(leadingLine(0), '0');
    assert.equal(leadingLine({ toString: () => '/audit-ok' }), '/audit-ok');
  });
});

describe('#231 signatureSide: podpis w ostatniej niepustej linii', () => {
  test('podpisy kanoniczne w kursywie i gołe', () => {
    assert.equal(signatureSide('Treść.\n\n' + SIGN_CLAUDE), CLAUDE);
    assert.equal(signatureSide('Treść.\n\n' + SIGN_GPT), GPT);
    assert.equal(signatureSide('Treść.\n\n— Claude Code (agent lokalny)'), CLAUDE);
    assert.equal(signatureSide('Treść.\n\n— ChatGPT'), GPT);
  });

  test('białe znaki, końcowe puste linie i CRLF nie przeszkadzają', () => {
    assert.equal(signatureSide('Treść.\r\n\r\n' + SIGN_GPT + '\r\n'), GPT);
    assert.equal(signatureSide('Treść.\n\n   ' + SIGN_GPT + '   \n\n\n'), GPT);
    assert.equal(signatureSide(SIGN_CLAUDE), CLAUDE, 'sam podpis to też podpis');
  });

  test('podpis nie w ostatniej linii, we wcięciu albo przekręcony nie jest podpisem', () => {
    const bodies = [
      SIGN_GPT + '\nTreść po podpisie.', 'Treść.\n\n    ' + SIGN_GPT, 'Treść.\n\n\t' + SIGN_GPT,
      'Treść.\n\n_- ChatGPT_', 'Treść.\n\n__— ChatGPT__', 'Treść.\n\n_— ChatGPT__', 'Treść.\n\n__— ChatGPT_',
      'Treść.\n\n_— chatgpt_', 'Treść.\n\n— ChatGPT.', 'Treść.\n\n_— ChatGPT_ _— ChatGPT_', 'Treść.\n\n_ _',
      'Treść.\n\n__', 'Treść.\n\n_', 'Treść.\n\nconstructor', 'Treść.\n\n__proto__', 'Treść.\n\ntoString', '', '   ', null, undefined
    ];
    for (const body of bodies) assert.equal(signatureSide(body), '', JSON.stringify(body));
  });
});

describe('#231 authorSide: autor ustalony tylko przy zgodności trzech sygnałów', () => {
  const CZYSTE = ['P2', 'T2'];
  const AGENT = ['P2', 'T2', BY_AGENT];

  test('podpis Claude + by:agent + utworzone przez gh (pole puste) - Claude', () => {
    for (const app of ['', null, undefined]) {
      assert.deepEqual(authorSide('x\n\n' + SIGN_CLAUDE, AGENT, app),
        { side: CLAUDE, reason: 'podpis Claude Code + by:agent + utworzone przez gh' }, String(app));
    }
  });

  test('podpis ChatGPT + brak by:agent + konektor — ChatGPT', () => {
    assert.deepEqual(authorSide('x\n\n' + SIGN_GPT, CZYSTE, GPT_APP),
      { side: GPT, reason: 'podpis ChatGPT + bez by:agent + utworzone przez ChatGPT Codex Connector' });
    assert.equal(authorSide('x\n\n' + SIGN_GPT, undefined, GPT_APP).side, GPT, 'brak listy etykiet to brak by:agent');
  });

  test('brak podpisu - nieustalony, także gdy reszta sygnałów się zgadza', () => {
    const reason = 'brak podpisu strony w ostatniej linii treści';
    assert.deepEqual(authorSide('x', AGENT, ''), { side: '', reason });
    assert.deepEqual(authorSide('x', CZYSTE, GPT_APP), { side: '', reason });
    assert.deepEqual(authorSide(undefined, AGENT, ''), { side: '', reason });
  });

  test('nieznana aplikacja - nieustalony, z nazwą aplikacji w powodzie', () => {
    assert.deepEqual(authorSide('x\n\n' + SIGN_CLAUDE, AGENT, 'Inna'),
      { side: '', reason: 'zgłoszenie utworzone przez nieznaną aplikację "Inna"' });
    assert.deepEqual(authorSide('x\n\n' + SIGN_GPT, CZYSTE, 'Inna'),
      { side: '', reason: 'zgłoszenie utworzone przez nieznaną aplikację "Inna"' });
  });

  test('podpis Claude bez by:agent albo przez konektor - nieustalony', () => {
    assert.deepEqual(authorSide('x\n\n' + SIGN_CLAUDE, CZYSTE, ''),
      { side: '', reason: 'podpis Claude Code bez etykiety by:agent' });
    assert.deepEqual(authorSide('x\n\n' + SIGN_CLAUDE, AGENT, GPT_APP),
      { side: '', reason: 'podpis Claude Code, ale zgłoszenie utworzył ChatGPT Codex Connector' });
  });

  test('podpis ChatGPT z by:agent albo przez gh - nieustalony', () => {
    assert.deepEqual(authorSide('x\n\n' + SIGN_GPT, AGENT, GPT_APP),
      { side: '', reason: 'podpis ChatGPT przy etykiecie by:agent' });
    assert.deepEqual(authorSide('x\n\n' + SIGN_GPT, AGENT, ''),
      { side: '', reason: 'podpis ChatGPT przy etykiecie by:agent' });
    assert.deepEqual(authorSide('x\n\n' + SIGN_GPT, CZYSTE, ''),
      { side: '', reason: 'podpis ChatGPT, ale zgłoszenia nie utworzył ChatGPT Codex Connector' });
  });
});

describe('#231 commentSide: podpis komentarza zgodny z aplikacją, przez którą powstał', () => {
  test('Claude przez gh, ChatGPT przez konektor', () => {
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_CLAUDE, app: '' }), CLAUDE);
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_CLAUDE }), CLAUDE, 'brak pola app to brak aplikacji');
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_CLAUDE, app: null }), CLAUDE);
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_GPT, app: GPT_APP }), GPT);
  });

  test('podpis niezgodny z aplikacją, brak podpisu albo obca aplikacja - brak strony', () => {
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_GPT, app: '' }), '');
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_CLAUDE, app: GPT_APP }), '');
    assert.equal(commentSide({ body: 'x\n\n' + SIGN_GPT, app: 'Inna' }), '');
    assert.equal(commentSide({ body: 'x', app: '' }), '');
    assert.equal(commentSide({ body: 'x', app: GPT_APP }), '');
    assert.equal(commentSide({}), '');
  });
});

describe('#231 podpis Claude z dopiskiem roli', () => {
  const DASH = String.fromCharCode(0x2014);
  const claude = rest => 'Treść.\n\n_' + DASH + ' Claude Code (' + rest + ')_';

  test('dopisek roli po przecinku nie zmienia strony (koordynator podpisuje wpisy z rolą)', () => {
    assert.equal(signatureSide(claude('agent lokalny, koordynator')), CLAUDE);
    assert.equal(signatureSide(claude('agent lokalny, rola z kilkoma słowami, i drugim przecinkiem')), CLAUDE);
    assert.equal(signatureSide('Treść.\n\n' + DASH + ' Claude Code (agent lokalny, koordynator)'), CLAUDE);
  });

  test('autor z dopiskiem roli jest ustalony tak samo jak bez dopiska', () => {
    const body = 'x\n\n_' + DASH + ' Claude Code (agent lokalny, koordynator)_';
    assert.equal(authorSide(body, ['by:agent'], '').side, CLAUDE);
  });

  test('pusty dopisek, zagnieżdżony nawias, tekst po nawiasie albo inna rola bazowa nie są podpisem', () => {
    for (const rest of ['agent lokalny,', 'agent lokalny, ', 'agent lokalny, a (b)', 'agent zdalny', 'Agent lokalny', 'agent lokalny koordynator']) {
      assert.equal(signatureSide(claude(rest)), '', rest);
    }
    assert.equal(signatureSide(claude('agent lokalny') + ' x'), '');
    assert.equal(signatureSide('Treść.\n\n_' + DASH + ' Claude Code (agent lokalny) x_'), '');
    assert.equal(signatureSide('Treść.\n\n_' + DASH + ' ChatGPT (konektor)_'), '', 'dopisek dotyczy tylko podpisu Claude');
  });

  test('podpis jest dopasowany od początku do końca linii, nie jako fragment', () => {
    assert.equal(signatureSide('Treść.\n\nzgoda ' + DASH + ' ChatGPT'), '');
    assert.equal(signatureSide('Treść.\n\nx ' + DASH + ' Claude Code (agent lokalny)'), '');
    assert.equal(signatureSide('Treść.\n\n' + DASH + ' ChatGPT koniec'), '');
    assert.equal(signatureSide('Treść.\n\n' + DASH + ' Claude Code (agent lokalny) koniec'), '');
  });

  test('kursywa musi obejmować cały podpis: podkreślnik w środku linii go nie otwiera ani nie zamyka', () => {
    assert.equal(signatureSide('Treść.\n\ntekst_' + DASH + ' ChatGPT_'), '');
    assert.equal(signatureSide('Treść.\n\n_' + DASH + ' ChatGPT_ koniec'), '');
    assert.equal(signatureSide('Treść.\n\n_' + DASH + ' ChatGPT_'), GPT);
  });
});

describe('#231 leadingLine: wcięcie liczy się tylko na początku linii', () => {
  test('tabulator i cztery spacje w środku linii nie robią z niej bloku kodu', () => {
    assert.equal(leadingLine('/audit-ok\tuzasadnienie'), '/audit-ok\tuzasadnienie');
    assert.equal(leadingLine('/audit-ok    uzasadnienie'), '/audit-ok    uzasadnienie');
    assert.equal(leadingLine('a\tb'), 'a\tb');
  });
});
