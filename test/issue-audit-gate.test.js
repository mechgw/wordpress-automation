'use strict';

/**
 * #139: bramka audytu specyfikacji issue.
 *
 * Numeracja testów odpowiada macierzy z opisu #139 (29 przypadków w pięciu
 * grupach). Grupa „odporność na utracone i przestawione runy” jest tu
 * najważniejsza: GitHub Actions ANULUJE oczekujący run, gdy przyjdzie kolejne
 * zdarzenie, więc poprawność nie może zależeć od tego, że każdy handler się
 * wykonał. Reconciler ma naprawiać stan z dowolnego punktu.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const gate = require('../scripts/quality/issue-audit-gate.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'quality', 'issue-audit-gate.js');
const { reconcile, DEFAULT_CONFIG, AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES } = gate;

/**
 * HTML, który GitHub renderuje z podanego Markdownu (#211).
 *
 * Bramka czyta tabelę „Triage” z `bodyHTML`, więc testy potrzebują prawdziwego
 * wyniku renderera, a nie jego imitacji: imitacja zgadzałaby się z naszym
 * czytnikiem z definicji. Wyniki leżą w `test/fixtures/triage-rendered.json`,
 * kluczem jest Markdown. Nowy przypadek dopisuje się sam:
 *   UPDATE_TRIAGE_FIXTURES=1 node --test test/issue-audit-gate.test.js
 * (wymaga zalogowanego `gh`; renderuje `POST /markdown` w trybie `gfm`).
 */
const RENDERED_PATH = path.join(__dirname, 'fixtures', 'triage-rendered.json');
const RENDERED = fs.existsSync(RENDERED_PATH) ? JSON.parse(fs.readFileSync(RENDERED_PATH, 'utf8')) : {};

function render(markdown) {
  if (!markdown) return '';
  if (Object.prototype.hasOwnProperty.call(RENDERED, markdown)) return RENDERED[markdown];
  if (!process.env.UPDATE_TRIAGE_FIXTURES) {
    throw new Error('Brak wyrenderowanego HTML-a dla treści testu; uruchom ' +
      'UPDATE_TRIAGE_FIXTURES=1 node --test test/issue-audit-gate.test.js\n' + markdown);
  }
  const source = path.join(os.tmpdir(), 'triage-fixture-' + process.pid + '.md');
  fs.writeFileSync(source, markdown);
  try {
    RENDERED[markdown] = execFileSync('gh', ['api', 'markdown', '-F', 'text=@' + source, '-f', 'mode=gfm'], { encoding: 'utf8' });
  } finally {
    fs.unlinkSync(source);
  }
  const sorted = {};
  Object.keys(RENDERED).sort().forEach(key => { sorted[key] = RENDERED[key]; });
  fs.mkdirSync(path.dirname(RENDERED_PATH), { recursive: true });
  fs.writeFileSync(RENDERED_PATH, JSON.stringify(sorted, null, 2) + '\n');
  return RENDERED[markdown];
}

const GATE_ACTIVE = DEFAULT_CONFIG.gateActiveSince;
// Rewizja sprzed wdrożenia bramki (issue „legacy”) i po wdrożeniu.
const OLD = '2026-09-01T10:00:00Z';
const NEW = '2026-09-08T10:00:00Z';
const LATER = '2026-09-08T12:00:00Z';
const LATEST = '2026-09-08T14:00:00Z';

const labeled = (label, createdAt) => ({ type: 'LABELED', label, createdAt });
const unlabeled = (label, createdAt) => ({ type: 'UNLABELED', label, createdAt });

// Podpisy i aplikacje stron (#231). Wszystko idzie z jednego konta, więc stronę
// wyznacza podpis ostatniej linii zgodny z `performed_via_github_app`: ChatGPT
// pisze przez konektor, Claude Code przez `gh` (pole puste).
const SIGN_CLAUDE = '_— Claude Code (agent lokalny)_';
const SIGN_GPT = '_— ChatGPT_';
const GPT_APP = 'ChatGPT Codex Connector';

// Domyślnie werdykt pisze Claude przez `gh` pod treścią ChatGPT; testy macierzy
// #231 odwracają strony jawnie.
const cmd = (kind, createdAt, extra = {}) => Object.assign({
  body: '/audit-' + kind + '\n\nUzasadnienie.\n\n' + SIGN_CLAUDE,
  authorAssociation: 'OWNER',
  createdAt: createdAt,
  app: '',
  lastEditedAt: null
}, extra);

// Domyślnie treść napisał ChatGPT (bez `by:agent`, przez konektor): autor
// ustalony, więc audytuje Claude. Etykiet nie dotykamy, żeby testy zakresu
// i triage'u mówiły o swoim.
const issue = (over = {}) => Object.assign({
  state: 'open',
  labels: ['P2', 'T2'],
  body: 'Treść.\n\n' + SIGN_GPT,
  app: GPT_APP,
  barrier: NEW,
  comments: []
}, over);

describe('#139 zakres bramki', () => {
  test('1: P0/P1/P2 bez tieru są w zakresie', () => {
    for (const priority of ['P0', 'P1', 'P2']) {
      assert.equal(reconcile(issue({ labels: [priority] })).label, AUDIT_PENDING, priority);
    }
  });

  test('2: P3/P4 z T2/T3 są w zakresie', () => {
    for (const labels of [['P3', 'T2'], ['P4', 'T3']]) {
      assert.equal(reconcile(issue({ labels })).label, AUDIT_PENDING, labels.join('+'));
    }
  });

  test('3: P3/P4 z T1 są poza zakresem', () => {
    const result = reconcile(issue({ labels: ['P3', 'T1'] }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, '');
  });

  test('4: brak P* i T* jest poza zakresem — od tego jest needs-triage', () => {
    const result = reconcile(issue({ labels: ['enhancement', 'area:seo'] }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, '');
  });

  test('5: wejście w zakres po wdrożeniu obejmuje bramką nawet starą issue', () => {
    const result = reconcile(issue({ labels: ['P2'], barrier: OLD, labelEvents: [labeled('P2', NEW)] }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_PENDING);
  });

  test('6: zmiana etykiety przy zakresie in → in nie obejmuje bramką niczego', () => {
    // Etykieta spoza rodziny zakresu: dołożona po wdrożeniu, ale zakres się nie zmienił.
    assert.equal(reconcile(issue({
      labels: ['P2', 'area:seo'], barrier: OLD,
      labelEvents: [labeled('P2', OLD), labeled('area:seo', NEW)]
    })).action, 'none');
    // Etykieta zakresu, ale issue była w zakresie także bez niej.
    assert.equal(reconcile(issue({
      labels: ['P1', 'T2'], barrier: OLD,
      labelEvents: [labeled('P1', OLD), labeled('T2', NEW)]
    })).action, 'none');
  });

  test('7: wyjście z zakresu usuwa rodzinę audit:*', () => {
    const result = reconcile(issue({ labels: ['P3', 'T1', AUDIT_PENDING] }));
    assert.equal(result.action, 'clear');
    assert.equal(result.label, '');
  });
});

describe('#139 rollout bez backfillu', () => {
  test('8: stara issue w zakresie bez nowych zdarzeń zostaje bez audit:*', () => {
    const result = reconcile(issue({ barrier: OLD }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, '');
    assert.match(result.reason, /nieobjęta bramką/);
  });

  test('9: stara issue z treścią zmienioną po wdrożeniu wchodzi do bramki', () => {
    assert.equal(reconcile(issue({ barrier: NEW })).label, AUDIT_PENDING);
  });

  test('10: stara issue z realnym out → in wchodzi do bramki', () => {
    assert.equal(reconcile(issue({
      labels: ['T2'], barrier: OLD, labelEvents: [labeled('T2', NEW)]
    })).label, AUDIT_PENDING);
  });

  test('10a: utracony run od pierwszej etykiety zakresu nie gubi objęcia bramką', () => {
    // Copilot/Codex na PR #141: przy szybkim P2 → T2 concurrency anuluje run od
    // P2, a payload kolejnego runu zawiera już tylko T2. Odtworzenie zakresu
    // z osi czasu etykiet nie zależy od tego, który run przeżył.
    const result = reconcile(issue({
      labels: ['P2', 'T2'], barrier: OLD,
      labelEvents: [labeled('P2', NEW), labeled('T2', LATER)]
    }));
    assert.equal(result.label, AUDIT_PENDING, 'przejście out → in zapisane trwale w historii');
  });

  test('10b: wejście w zakres sprzed wdrożenia nadal nie obejmuje bramką', () => {
    const result = reconcile(issue({
      labels: ['P2'], barrier: OLD, labelEvents: [labeled('P2', '2026-08-20T09:00:00Z')]
    }));
    assert.equal(result.action, 'none');
    assert.match(result.reason, /nieobjęta bramką/);
  });

  test('10c: powrót do zakresu po wypadnięciu liczy się jako nowe wejście', () => {
    const result = reconcile(issue({
      labels: ['P2'], barrier: OLD,
      labelEvents: [labeled('P2', '2026-08-01T09:00:00Z'), unlabeled('P2', '2026-08-15T09:00:00Z'), labeled('P2', NEW)]
    }));
    assert.equal(result.label, AUDIT_PENDING, 'liczy się OSTATNIE wejście, nie pierwsze');
  });

  test('granica GATE_ACTIVE_SINCE jest domknięta od dołu', () => {
    assert.equal(reconcile(issue({ barrier: GATE_ACTIVE })).label, AUDIT_PENDING);
  });

  test('data startu bramki jest konfigurowalna per repozytorium', () => {
    // Ten sam skrypt obsługuje kilka repozytoriów, a każde weszło do bramki
    // innego dnia. Zaszyta data zrobiłaby w drugim repo cichy backfill.
    const later = { gateActiveSince: '2026-09-09T00:00:00Z' };
    assert.equal(reconcile(issue({ barrier: NEW }), later).action, 'none',
      'przy późniejszej dacie startu ta sama issue jest jeszcze nieobjęta');
    assert.equal(reconcile(issue({ barrier: NEW })).label, AUDIT_PENDING,
      'a przy domyślnej — objęta');

    const earlier = { gateActiveSince: '2026-08-01T00:00:00Z' };
    assert.equal(reconcile(issue({ barrier: OLD }), earlier).label, AUDIT_PENDING,
      'wcześniejsza data startu obejmuje starsze issue');
  });
});

describe('#139 komenda audytu', () => {
  test('11: komenda na początku komentarza jest rozpoznawana', () => {
    assert.equal(reconcile(issue({ comments: [cmd('ok', LATER)] })).label, AUDIT_OK);
    assert.equal(reconcile(issue({ comments: [cmd('changes', LATER)] })).label, AUDIT_CHANGES);
  });

  test('12: /audit-okfoo i komenda w środku tekstu nie są komendą', () => {
    const bodies = ['/audit-okfoo', 'Zgadzam się, /audit-ok', '/audit-nope', 'audit-ok'];
    for (const body of bodies) {
      assert.equal(gate.parseCommand(body, DEFAULT_CONFIG), '', JSON.stringify(body));
    }
    const result = reconcile(issue({ comments: [cmd('ok', LATER, { body: '/audit-okfoo' })] }));
    assert.equal(result.label, AUDIT_PENDING, 'to nie jest rozstrzygnięcie');
  });

  test('13: autor spoza OWNER/MEMBER/COLLABORATOR nic nie zmienia', () => {
    for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', '']) {
      const result = reconcile(issue({ comments: [cmd('ok', LATER, { authorAssociation: association })] }));
      assert.equal(result.label, AUDIT_PENDING, association || '(puste)');
    }
  });

  test('15: komenda na issue poza zakresem nic nie zmienia', () => {
    const result = reconcile(issue({ labels: ['P3', 'T1'], comments: [cmd('ok', LATER)] }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, '');
  });

  test('16a: /audit-ok na starej issue w zakresie to dobrowolne wejście', () => {
    const result = reconcile(issue({ barrier: OLD, comments: [cmd('ok', LATER)] }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_OK);
  });

  test('16b: /audit-changes na starej issue wchodzi do bramki i blokuje pracę', () => {
    const result = reconcile(issue({ barrier: OLD, comments: [cmd('changes', LATER)] }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_CHANGES, 'świadome zablokowanie starej specyfikacji');
  });

  test('17: zdarzenie na issue zamkniętej nie zmienia etykiet', () => {
    const result = reconcile(issue({ state: 'closed', labels: ['P2', AUDIT_OK], comments: [cmd('changes', LATER)] }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, AUDIT_OK, 'archiwum zostaje nietknięte');
  });
});

describe('#139 bariera rewizji', () => {
  test('18: komenda starsza niż ostatnia edycja treści nie rozstrzyga', () => {
    // Recenzent zaakceptował wersję A, potem autor zmienił treść na B.
    const result = reconcile(issue({ barrier: LATER, labels: ['P2', AUDIT_OK], comments: [cmd('ok', NEW)] }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_PENDING);
  });

  test('19: komenda nowsza niż ostatnia edycja treści rozstrzyga', () => {
    assert.equal(reconcile(issue({ barrier: NEW, comments: [cmd('ok', LATER)] })).label, AUDIT_OK);
    assert.equal(reconcile(issue({ barrier: NEW, comments: [cmd('changes', LATER)] })).label, AUDIT_CHANGES);
  });

  test('20: brak bariery oznacza brak zapisu (fail-closed)', () => {
    for (const barrier of ['', null, undefined]) {
      const result = reconcile(issue({ barrier, labels: ['P2', AUDIT_OK], comments: [cmd('changes', LATEST)] }));
      assert.equal(result.action, 'none', String(barrier));
      assert.equal(result.label, AUDIT_OK, 'nie zgadujemy przy braku danych');
    }
  });

  test('21: dla issue nigdy nieedytowanej barierą jest createdAt', () => {
    assert.equal(gate.revisionBarrier({ createdAt: NEW, userContentEdits: { nodes: [] } }), NEW);
    assert.equal(gate.revisionBarrier({ createdAt: NEW, userContentEdits: { nodes: [{ editedAt: LATER }] } }), LATER);
    assert.equal(gate.revisionBarrier({ createdAt: NEW }), NEW, 'brak pola nie wywraca odczytu');
    assert.equal(gate.revisionBarrier(null), '', 'a brak issue daje pustą barierę → fail-closed');
  });

  test('21a: barierą jest NAJNOWSZA edycja treści, czyli pierwszy węzeł', () => {
    // `userContentEdits` zwraca edycje od najnowszej. Wersja z `last: 1` brała
    // edycję najstarszą i cofała barierę o godziny — spóźnione `/audit-ok`
    // wyglądało wtedy na nowsze od treści i było przyjmowane.
    const nodes = [{ editedAt: LATEST }, { editedAt: LATER }, { editedAt: NEW }];
    assert.equal(gate.revisionBarrier({ createdAt: OLD, userContentEdits: { nodes } }), LATEST);
  });

  test('21b: każde zapytanie o historię edycji pobiera pierwszą, nie ostatnią', () => {
    // Kolejność jest własnością API, nie funkcji: `revisionBarrier()` dostaje
    // gotową listę i nie wie, skąd pochodzi. Pilnujemy więc kształtu zapytania
    // na źródle, bo pomyłka `first`/`last` jest cicha i wyłącza barierę rewizji.
    //
    // Sprawdzamy ARGUMENTY każdego wywołania, a nie dosłowny tekst: inaczej
    // spacja albo dodatkowy parametr (`after:`) przepuściłyby regresję.
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'quality', 'issue-audit-fetch.js'), 'utf8');
    const calls = [...source.matchAll(/userContentEdits\s*\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(calls.length, 'zapytanie musi w ogóle pobierać historię edycji treści');
    for (const args of calls) {
      assert.match(args, /\bfirst\s*:\s*1\b/, 'najnowsza edycja to first: 1');
      assert.doesNotMatch(args, /\blast\s*:/, '`last:` zwraca edycję NAJSTARSZĄ');
    }
  });
});

describe('#139 odporność na utracone i przestawione runy', () => {
  test('22: utracony run od edycji treści zostaje naprawiony przez kolejne zdarzenie', () => {
    // audit:ok dla wersji A, autor zmienia treść na B, run `edited` anulowany.
    // Kolejne, neutralne zdarzenie liczy stan od nowa i cofa do pending.
    const result = reconcile(issue({
      labels: ['P2', 'T2', AUDIT_OK],
      barrier: LATER,
      comments: [cmd('ok', NEW)]
    }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_PENDING, 'niezaakceptowana wersja treści nie może zostać z audit:ok');
  });

  test('23: przy dwóch komendach po tej samej rewizji wygrywa nowsza, nie ostatni run', () => {
    const comments = [cmd('ok', LATER), cmd('changes', LATEST)];
    assert.equal(reconcile(issue({ comments })).label, AUDIT_CHANGES);
    // Ta sama treść w odwrotnej kolejności na liście: wynik zależy od czasu
    // komentarza, nie od kolejności, w jakiej dane dotarły.
    assert.equal(reconcile(issue({ comments: comments.slice().reverse() })).label, AUDIT_CHANGES);
  });

  test('24: spóźniony run dla wersji A nie przywraca jej stanu po edycji do B', () => {
    // Run wystartował dla komendy z NEW, ale wykonuje się po edycji z LATER.
    // Czyta stan w chwili wykonania, więc widzi już nową rewizję.
    const result = reconcile(issue({ labels: ['P2', AUDIT_PENDING], barrier: LATER, comments: [cmd('ok', NEW)] }));
    assert.equal(result.action, 'none');
    assert.equal(result.label, AUDIT_PENDING);
  });

  test('25: dowolna sekwencja zostawia maksymalnie jedną etykietę audit:*', () => {
    const states = [
      issue({ comments: [cmd('ok', LATER)] }),
      issue({ labels: ['P2', AUDIT_PENDING], comments: [cmd('changes', LATER)] }),
      issue({ labels: ['P3', 'T1', AUDIT_OK] }),
      issue({ labels: ['P2', AUDIT_CHANGES], barrier: LATEST })
    ];
    for (const state of states) {
      const result = reconcile(state);
      const applied = result.action === 'clear' ? [] : [result.label].filter(Boolean);
      assert.ok(applied.length <= 1, JSON.stringify(result));
    }
  });

  test('25a: duplikat rodziny audit:* jest sprzątany, mimo zgodnej pierwszej etykiety', () => {
    // Copilot/Codex na PR #141: przy `desired === current` wcześniejsza wersja
    // wracała z `none` i nadmiarowa etykieta zostawała na zawsze, bo każdy
    // kolejny przebieg widział stan jako zgodny.
    const result = reconcile(issue({
      labels: ['P2', AUDIT_OK, AUDIT_PENDING],
      comments: [cmd('ok', LATER)]
    }));
    assert.equal(result.action, 'set', 'zapis wymuszony, żeby apply usunęło duplikat');
    assert.equal(result.label, AUDIT_OK);
    assert.match(result.reason, /duplikat/);
  });

  test('25b: duplikat na issue poza zakresem jest czyszczony w całości', () => {
    const result = reconcile(issue({ labels: ['P3', 'T1', AUDIT_OK, AUDIT_CHANGES] }));
    assert.equal(result.action, 'clear');
    assert.equal(result.label, '');
  });

  test('26: powtórzony run bez zmiany stanu nie zapisuje nic', () => {
    const state = issue({ labels: ['P2', 'T2', AUDIT_OK], comments: [cmd('ok', LATER)] });
    const first = reconcile(state);
    assert.equal(first.action, 'none', 'stan już zgodny');
    // Idempotencja: ten sam wejściowy stan daje ten sam wynik.
    assert.deepEqual(reconcile(state), first);
  });
});

describe('#139 ślad dla człowieka', () => {
  test('27: cofnięcie do pending jest jawnym sygnałem dla komentarza-znacznika', () => {
    const result = reconcile(issue({ labels: ['P2', AUDIT_OK], barrier: LATEST, comments: [cmd('ok', LATER)] }));
    assert.equal(result.action, 'set');
    assert.equal(result.label, AUDIT_PENDING, 'workflow publikuje marker właśnie na tym przejściu');
  });

  test('28: komentarz-znacznik nie jest komendą i nie wywołuje rozstrzygnięcia', () => {
    const marker = { body: 'Treść issue zmieniona — stan cofnięty do `audit:pending`.', authorAssociation: 'OWNER', createdAt: LATEST };
    const result = reconcile(issue({ comments: [marker] }));
    assert.equal(result.label, AUDIT_PENDING);
    assert.equal(gate.latestDecision([marker], NEW, DEFAULT_CONFIG), null);
  });
});

describe('#139 CLI: konfiguracja daty startu nie może zawieść po cichu', () => {
  // Wywołanie bez sieci: walidacja argumentów następuje przed pierwszym `gh`,
  // więc błędne wejście kończy się kodem 2, zanim cokolwiek zostanie pobrane.
  const run = (extra, env = {}) => spawnSync(process.execPath,
    [SCRIPT, '--issue', '1', '--repo', 'owner/name', '--dry-run', ...extra],
    { encoding: 'utf8', env: { ...process.env, AUDIT_GATE_ACTIVE_SINCE: '', ...env } });

  test('flaga bez wartości kończy przebieg kodem 2, zamiast wracać do domyślnej', () => {
    const r = run(['--gate-active-since']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /bez wartości/);
  });

  test('pusta wartość flagi też jest błędem', () => {
    // W workflow `--gate-active-since "$ZMIENNA"` z pustą zmienną przekazuje
    // właśnie pusty argument. To najgroźniejszy wariant, bo wygląda poprawnie.
    const r = run(['--gate-active-since', '']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /bez wartości/);
  });

  test('wartość, która nie jest datą, kończy przebieg kodem 2', () => {
    const r = run(['--gate-active-since', 'wczoraj']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /RRRR-MM-DD/);
  });

  test('daty, które new Date() po cichu normalizuje, są odrzucane', () => {
    // Zmierzone w Node 24: '0' → 1999-12-31, '2026' → 2026-01-01,
    // '2026-09-08' → północ UTC, a '2026-02-30T00:00:00Z' → 2 marca.
    // Każdy wariant cofnąłby moment startu bramki i objął audytem archiwum.
    for (const value of ['0', '2026', '2026-09-08', '2026-9-8T07:00:00Z', '2026-09-08T07:00:00']) {
      const r = run(['--gate-active-since', value]);
      assert.equal(r.status, 2, value + ' → ' + r.stderr);
      assert.match(r.stderr, /RRRR-MM-DD/, value);
    }
  });

  test('kształt poprawny, ale data nieistniejąca, też jest odrzucana', () => {
    const r = run(['--gate-active-since', '2026-02-30T00:00:00Z']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /nie istnieje/);
  });

  test('poprawna data i brak flagi przechodzą walidację', () => {
    // Odcinamy `gh` z PATH, żeby test nie dotykał sieci: skrypt ma dojść
    // do pobierania stanu i dopiero tam polec, a nie odrzucić poprawne wejście.
    // Windows używa `Path`, POSIX `PATH` — czyścimy oba.
    const offline = { PATH: '', Path: '' };
    for (const extra of [[], ['--gate-active-since', '2026-09-08T07:00:00Z']]) {
      const r = run(extra, offline);
      assert.doesNotMatch(String(r.stderr), /gate-active-since/,
        'walidacja odrzuciła poprawne wejście: ' + JSON.stringify(extra));
      assert.notEqual(r.status, 2, r.stderr);
    }
  });
});

describe('#211 triage: etykiety z tabeli albo needs-triage', () => {
  // Numeracja 1–12 odpowiada macierzy z opisu #211.
  const { reconcileTriage, reconcileIssue, labelChanges, NEEDS_TRIAGE } = gate;
  const TRIAGE_ACTIVE = DEFAULT_CONFIG.triageActiveSince;
  const CREATED = '2026-09-28T10:00:00Z';
  const NOW = '2026-09-28T10:00:05Z';
  const REPO_LABELS = ['P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3', 'area:github', 'area:business',
    'enhancement', NEEDS_TRIAGE, AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES];

  const tabela = (...wiersze) => ['## Problem', '', 'Opis.', '', '## Triage', '',
    '| wymiar | wartość | uzasadnienie |', '| --- | --- | --- |', ...wiersze, '', 'Powiązania: #1.'].join('\n');
  // `body` to Markdown; bramka dostaje HTML, który renderuje z niego GitHub.
  const nowa = ({ body = '', ...over } = {}) => issue(Object.assign({
    labels: [], createdAt: CREATED, barrier: CREATED, bodyHtml: render(body), repoLabels: REPO_LABELS
  }, over));
  const plainRows = rows => JSON.parse(JSON.stringify(rows));
  const przebieg = (input, config) => reconcileIssue(input, config, NOW);
  // Stan po zapisie przebiegu: tak wygląda issue, gdy czyta ją kolejny run.
  const poZapisie = (input, outcome) => {
    const changes = labelChanges(outcome, input.labels, DEFAULT_CONFIG);
    return Object.assign({}, input, {
      labels: input.labels.filter(name => !changes.remove.includes(name)).concat(changes.add)
    });
  };

  test('1: nowa issue bez etykiet, tabela z **P1** i **T2** — etykiety z tabeli i audit:pending w jednym przebiegu', () => {
    const input = nowa({ body: tabela('| priorytet | **P1** | pilne |', '| ryzyko | **T2** | wspólny skrypt |') });
    const outcome = przebieg(input);
    assert.deepEqual(outcome.triage.add, ['P1', 'T2']);
    assert.deepEqual(outcome.triage.remove, []);
    assert.equal(outcome.audit.action, 'set');
    assert.equal(outcome.audit.label, AUDIT_PENDING);
    assert.deepEqual(labelChanges(outcome, input.labels, DEFAULT_CONFIG), { add: ['P1', 'T2', AUDIT_PENDING], remove: [] });
  });

  test('2: tabela bez pogrubień, wiersz „ryzyko zmiany”', () => {
    const outcome = przebieg(nowa({ body: tabela('| priorytet | P1 | pilne |', '| ryzyko zmiany | T2 | wspólny skrypt |') }));
    assert.deepEqual(outcome.triage.add, ['P1', 'T2']);
    assert.equal(outcome.audit.label, AUDIT_PENDING);
  });

  test('3: wiersz priorytetu z dwoma tokenami — brak P* z tabeli, needs-triage', () => {
    const outcome = przebieg(nowa({ body: tabela('| priorytet | **P1** albo P2 | do decyzji |', '| ryzyko | **T1** | mała zmiana |') }));
    assert.deepEqual(outcome.triage.add, ['T1', NEEDS_TRIAGE]);
    assert.match(outcome.triage.reason, /brak triage'u: P/);
    assert.equal(outcome.audit.action, 'none', 'T1 bez P* jest poza zakresem bramki audytu');
  });

  test('4: issue ma już P3, a tabela mówi P1 — P3 zostaje, nic nie jest nadpisywane', () => {
    const outcome = przebieg(nowa({ labels: ['P3'], body: tabela('| priorytet | **P1** | pilne |', '| ryzyko | **T1** | mała zmiana |') }));
    assert.deepEqual(outcome.triage.add, ['T1']);
    assert.deepEqual(outcome.triage.remove, []);
    assert.deepEqual(outcome.labels, ['P3', 'T1']);
  });

  test('4: rodzina z dwiema etykietami nie jest ani uzupełniana, ani porządkowana — needs-triage', () => {
    const input = nowa({ labels: ['P1', 'P2', 'T1'], body: tabela('| priorytet | **P1** | pilne |') });
    const triage = reconcileTriage(input);
    assert.deepEqual(triage.add, [NEEDS_TRIAGE]);
    assert.deepEqual(triage.remove, [], 'istniejących etykiet nie zdejmujemy');
  });

  test('5: brak sekcji „Triage” i brak etykiet — needs-triage, bez etykiet audytu', () => {
    const outcome = przebieg(nowa({ body: '## Problem\n\nOpis bez triage\'u.' }));
    assert.deepEqual(outcome.triage.add, [NEEDS_TRIAGE]);
    assert.equal(outcome.audit.action, 'none');
    assert.equal(outcome.audit.label, '');
  });

  test('6: issue z needs-triage dostaje ręcznie P2 i T1 — needs-triage usunięte, audit:pending', () => {
    const input = nowa({ labels: [NEEDS_TRIAGE, 'P2', 'T1'] });
    const outcome = przebieg(input);
    assert.deepEqual(outcome.triage.add, []);
    assert.deepEqual(outcome.triage.remove, [NEEDS_TRIAGE]);
    assert.equal(outcome.audit.label, AUDIT_PENDING);
    assert.deepEqual(labelChanges(outcome, input.labels, DEFAULT_CONFIG), { add: [AUDIT_PENDING], remove: [NEEDS_TRIAGE] });
  });

  test('7: konfiguracja P,area — nałożone P2 i area:business, brak T* nie daje needs-triage', () => {
    const body = tabela('| priorytet | **P2** | proces |', '| obszar | `area:business` | |');
    const outcome = przebieg(nowa({ body }), { triageRequired: ['P', 'area'] });
    assert.deepEqual(outcome.triage.add, ['P2', 'area:business']);
    assert.match(outcome.triage.reason, /triage kompletny/);
    assert.equal(outcome.audit.label, AUDIT_PENDING);
  });

  test('7: rodzina niewymagana nie jest brana z tabeli', () => {
    const body = tabela('| priorytet | **P3** | proces |', '| ryzyko | **T3** | duża zmiana |', '| obszar | `area:business` | |');
    const outcome = przebieg(nowa({ body }), { triageRequired: ['P', 'area'] });
    assert.deepEqual(outcome.triage.add, ['P3', 'area:business']);
  });

  test('8: tabela z area:nieistniejąca — etykieta pominięta, przy wymaganym area needs-triage', () => {
    const body = tabela('| priorytet | **P2** | proces |', '| obszar | `area:nieistniejąca` | |');
    const outcome = przebieg(nowa({ body }), { triageRequired: ['P', 'area'] });
    assert.deepEqual(outcome.triage.add, ['P2', NEEDS_TRIAGE]);
    assert.match(outcome.triage.reason, /brak triage'u: area/);
  });

  test('8: bez listy etykiet repozytorium nic nie jest nakładane (fail-closed)', () => {
    const triage = reconcileTriage(nowa({ repoLabels: undefined, body: tabela('| priorytet | **P1** | pilne |') }));
    assert.deepEqual(triage.add, []);
    assert.deepEqual(triage.remove, []);
  });

  test('9: issue zamknięta — bez zmian', () => {
    const input = nowa({ state: 'closed', labels: [NEEDS_TRIAGE, 'P2', 'T1'], body: tabela('| priorytet | **P1** | pilne |') });
    const outcome = przebieg(input);
    assert.deepEqual(labelChanges(outcome, input.labels, DEFAULT_CONFIG), { add: [], remove: [] });
  });

  test('11: issue sprzed startu triage\'u, po starcie bramki, z tabelą — ani etykiet, ani needs-triage', () => {
    const created = '2026-09-20T10:00:00Z';
    assert.ok(created >= GATE_ACTIVE && created < TRIAGE_ACTIVE, 'przedział między startem bramki a startem triage\'u');
    const input = nowa({ createdAt: created, barrier: created, body: tabela('| priorytet | **P1** | pilne |', '| ryzyko | **T2** | zmiana |') });
    const outcome = przebieg(input);
    assert.deepEqual(labelChanges(outcome, input.labels, DEFAULT_CONFIG), { add: [], remove: [] });
    assert.match(outcome.triage.reason, /sprzed startu triage'u/);
  });

  test('11: granica startu triage\'u jest domknięta od dołu, a data jest konfigurowalna', () => {
    assert.deepEqual(reconcileTriage(nowa({ createdAt: TRIAGE_ACTIVE })).add, [NEEDS_TRIAGE]);
    assert.deepEqual(reconcileTriage(nowa(), { triageActiveSince: '2026-09-29T00:00:00Z' }).add, []);
    assert.deepEqual(reconcileTriage(nowa({ createdAt: '' })).add, [], 'bez daty utworzenia nie zgadujemy');
  });

  test('wiersz liczy się, gdy pierwsza komórka ZACZYNA się od nazwy wymiaru', () => {
    const body = tabela('| poprzedni priorytet | **P4** | przed korektą |', '| priorytet | **P1** | pilne |',
      '| Ryzyko zmiany | **T2** | wielka litera |', '| szacowane ryzyko | **T3** | nie ten wiersz |');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T2']);
  });

  test('wartość z drugiej komórki: token w uzasadnieniu nie robi niejednoznaczności', () => {
    const body = tabela('| priorytet | **P2** | nie P1, bo bez wpływu na produkcję |', '| ryzyko zmiany | **T2** | T3 dopiero przy migracji |');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P2', 'T2']);
  });

  test('area:* jest czytana w całości — nieznana nazwa z istniejącym krótszym prefiksem nie staje się krótszą etykietą (PR #216)', () => {
    // `area:github` istnieje, `area:github_extra` i `area:github/docs` nie.
    for (const nazwa of ['area:github_extra', 'area:github/docs', 'area:github.docs']) {
      const body = tabela('| priorytet | **P3** | proces |', '| obszar | `' + nazwa + '` | |');
      const triage = reconcileTriage(nowa({ body }), { triageRequired: ['P', 'area'] });
      assert.deepEqual(triage.add, ['P3', NEEDS_TRIAGE], nazwa);
    }
    const znane = REPO_LABELS.concat(['area:github_extra']);
    const body = tabela('| priorytet | **P3** | proces |', '| obszar | area:github_extra | |');
    assert.deepEqual(reconcileTriage(nowa({ body, repoLabels: znane }), { triageRequired: ['P', 'area'] }).add, ['P3', 'area:github_extra']);
  });

  test('już nałożona area:* z podkreśleniem albo ukośnikiem spełnia rodzinę (PR #216)', () => {
    for (const nazwa of ['area:apps_script', 'area:web/front']) {
      const triage = reconcileTriage(nowa({ labels: ['P3', nazwa] }), { triageRequired: ['P', 'area'] });
      assert.deepEqual(triage.add, [], nazwa);
      assert.match(triage.reason, /triage kompletny/, nazwa);
    }
  });

  // --- Co jest tabelą, rozstrzyga renderer GitHuba (PR #216) ------------------
  //
  // Bramka czyta `bodyHTML`. Poniższe przypadki to kolejne rundy recenzji wersji,
  // która czytała Markdown: każdy z nich dawał etykiety z treści niebędącej
  // widoczną tabelą. Treści są tu Markdownem, a HTML pochodzi z renderera GitHuba
  // (`test/fixtures/triage-rendered.json`).
  const sekcja = (...wiersze) => ['## Triage', '', '| wymiar | wartość |', '| --- | --- |', ...wiersze];
  const WLASCIWA = sekcja('| priorytet | **P1** |', '| ryzyko | **T3** |');
  const PRZYKLAD = sekcja('| priorytet | **P4** |', '| ryzyko | **T1** |');
  const KOD = {
    'blok z grawisów': ['```md', ...PRZYKLAD, '```'],
    'blok z tyld': ['~~~', ...PRZYKLAD, '~~~'],
    'cztery grawisy z zagnieżdżonym blokiem trzech': ['````md', '```md', ...PRZYKLAD, '```', '````'],
    'krótszy znacznik nie zamyka bloku': ['`````', '````', ...PRZYKLAD, '`````'],
    'znacznik z dopiskiem nie zamyka bloku': ['```md', '``` js', ...PRZYKLAD, '```'],
    'tyldy w bloku z grawisów': ['```md', '~~~', ...PRZYKLAD, '```'],
    'wcięcie czterema spacjami': PRZYKLAD.map(l => '    ' + l),
    'wcięcie tabulatorem': PRZYKLAD.map(l => '\t' + l),
    'wcięcie spacją i tabulatorem': PRZYKLAD.map(l => ' \t' + l),
    'blok <pre>': ['<pre>', ...PRZYKLAD, '</pre>'],
    'komentarz HTML': ['<!--', ...PRZYKLAD, '-->']
  };

  test('przykład sekcji „Triage” w kodzie albo komentarzu przed właściwą sekcją nie jest czytany (PR #216)', () => {
    for (const [nazwa, blok] of Object.entries(KOD)) {
      const body = ['## Problem', '', 'Przykład zapisu:', '', ...blok, '', ...WLASCIWA].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T3'], nazwa);
    }
  });

  test('sekcja „Triage” z samym przykładem w kodzie albo komentarzu daje needs-triage (PR #216)', () => {
    for (const [nazwa, blok] of Object.entries(KOD)) {
      // Wnętrze bloku bez nagłówka: sama tabela-przykład pod prawdziwym nagłówkiem sekcji.
      const wnetrze = blok.filter(l => !/##\s+Triage/.test(l));
      const body = ['## Triage', '', 'Przykład zapisu:', '', ...wnetrze].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, [NEEDS_TRIAGE], nazwa);
    }
  });

  test('wiersz w kodzie albo komentarzu wewnątrz sekcji nie dokłada wartości (PR #216)', () => {
    const body = [...sekcja('| priorytet | **P1** |'), '', '```', '| ryzyko | **T1** |', '```', '', '<!-- | ryzyko | **T1** | -->', '',
      '    | ryzyko | **T1** |', '', '| wymiar | wartość |', '| --- | --- |', '| ryzyko | **T3** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T3']);
  });

  test('linie z | bez wiersza separatora to zwykły tekst, nie tabela (PR216-MARKDOWN-TABLE-01)', () => {
    for (const linie of [['priorytet | P1', 'ryzyko | T2'], ['| priorytet | P1 |', '| ryzyko | T2 |']]) {
      const body = ['## Triage', '', ...linie].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, [NEEDS_TRIAGE], linie[0]);
    }
    // Poprawna tabela nie potrzebuje separatorów na brzegach.
    const bezBrzegow = ['## Triage', '', 'wymiar | wartość', '--- | ---', 'priorytet | **P1**', 'ryzyko zmiany | **T2**', '', 'Zdanie bez tabeli.'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: bezBrzegow })).add, ['P1', 'T2']);
    // Wcięcie do trzech spacji nadal jest tabelą.
    const wcieta = sekcja('| priorytet | **P1** |', '| ryzyko | **T2** |').map(l => '   ' + l).join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: wcieta })).add, ['P1', 'T2']);
  });

  test('\\| zostaje treścią komórki — dwa tokeny w jednej komórce to brak etykiety (PR216-ESCAPED-PIPE-02)', () => {
    const body = sekcja('| priorytet | P1 \\| P2 | do decyzji |', '| ryzyko | **T1** | |').join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['T1', NEEDS_TRIAGE]);
    assert.equal(gate.triageTableRows(render(body))[1][1], 'P1 | P2');
  });

  test('linia pozioma w każdym zapisie i podkreślony nagłówek kończą sekcję (PR216-THEMATIC-BREAK-03)', () => {
    const dalej = ['| wymiar | wartość |', '| --- | --- |', '| ryzyko | **T3** |'];
    for (const linia of ['---', '***', '___', '* * *', '- - -', '_ _ _', '  -----  ']) {
      const body = [...sekcja('| priorytet | **P1** |'), '', linia, '', ...dalej].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', NEEDS_TRIAGE], linia);
    }
    for (const podkreslenie of ['---', '===']) {
      const body = [...sekcja('| priorytet | **P1** |'), '', 'Inna sekcja', podkreslenie, '', ...dalej].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', NEEDS_TRIAGE], 'podkreślenie ' + podkreslenie);
    }
  });

  test('znacznik zapisany jako kod inline nie ukrywa dalszej treści (PR216-INLINE-PRE-04)', () => {
    const body = ['## Problem', '', 'Przykłady wstawiaj w `<pre>`, komentarze w `<!--`, a tabelę w `<table>`.', '', ...WLASCIWA].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T3']);
  });

  test('nagłówek sekcji: drugi poziom, dowolna wielkość liter, także wcięty i z zamykającymi # (PR #216)', () => {
    for (const naglowek of ['## Triage', '  ## Triage', '## Triage ##', '## triage', '## **Triage**']) {
      const body = [naglowek, '', '| wymiar | wartość |', '| --- | --- |', '| priorytet | **P1** |', '| ryzyko | **T2** |'].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T2'], naglowek);
    }
    for (const naglowek of ['# Triage', '### Triage', '## Triage i ryzyko', '**Triage**']) {
      const body = [naglowek, '', '| wymiar | wartość |', '| --- | --- |', '| priorytet | **P1** |', '| ryzyko | **T2** |'].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, [NEEDS_TRIAGE], naglowek);
    }
  });

  test('z dwóch sekcji „Triage” czytana jest pierwsza, a tabela poza sekcją wcale', () => {
    const dwie = [...sekcja('| priorytet | **P1** |'), '', '## Uwagi', '', 'Tekst.', '', ...sekcja('| priorytet | **P2** |', '| ryzyko | **T2** |')].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: dwie })).add, ['P1', NEEDS_TRIAGE], 'druga sekcja nie dokłada ani P2, ani T2');

    const poza = ['## Zakres', '', '| wymiar | wartość |', '| --- | --- |', '| priorytet | **P1** |', '', '## Triage', '', 'Do ustalenia.', '',
      '## Inne', '', '| wymiar | wartość |', '| --- | --- |', '| ryzyko | **T2** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: poza })).add, [NEEDS_TRIAGE]);
    assert.deepEqual(gate.triageTableRows(render(poza)), []);
  });

  test('sekcja i tabela liczą się tylko na poziomie dokumentu — cytat, lista i <details> to przykłady (PR #216)', () => {
    const cytat = linie => linie.map(l => ('> ' + l).trimEnd());
    const PRZYKLADY = {
      cytat: cytat(PRZYKLAD),
      'cytat w cytacie': cytat(cytat(PRZYKLAD)),
      'element listy': ['- przykład:', ''].concat(PRZYKLAD.map(l => (l ? '  ' + l : l))),
      '<details>': ['<details>', '<summary>Przykład</summary>', '', ...PRZYKLAD, '', '</details>'],
      // Zwykły `div` autora, także z klasą udającą opakowanie GitHuba: GitHub usuwa `class` z treści.
      '<div>': ['<div>', '', ...PRZYKLAD, '', '</div>'],
      '<div class="markdown-heading">': ['<div class="markdown-heading">', '', ...PRZYKLAD, '', '</div>'],
      '<section>': ['<section>', '', ...PRZYKLAD, '', '</section>']
    };
    for (const [nazwa, blok] of Object.entries(PRZYKLADY)) {
      // Zagnieżdżony przykład przed właściwą sekcją: nie zostaje „pierwszą sekcją”.
      const przed = ['## Problem', '', ...blok, '', ...WLASCIWA].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body: przed })).add, ['P1', 'T3'], nazwa + ' przed sekcją');
      // Sam zagnieżdżony przykład, bez sekcji na poziomie dokumentu.
      const sam = ['## Problem', '', ...blok].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body: sam })).add, [NEEDS_TRIAGE], nazwa + ' bez właściwej sekcji');
      // Zagnieżdżona tabela wewnątrz właściwej sekcji nie dokłada wartości i jej nie kończy.
      const wSekcji = [...sekcja('| priorytet | **P1** |'), '', ...blok, '', '| wymiar | wartość |', '| --- | --- |', '| ryzyko | **T3** |'].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body: wSekcji })).add, ['P1', 'T3'], nazwa + ' w sekcji');
    }
    // Elementy bez treści (złamanie wiersza, linia pozioma) przed sekcją nie zostawiają otwartego poziomu.
    const zPustymi = ['Wstęp  ', 'druga linia', '', '---', '', ...WLASCIWA].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: zPustymi })).add, ['P1', 'T3']);
    // Linia pozioma w cytacie nie kończy sekcji; kończy ją dopiero linia na poziomie dokumentu.
    const liniaWCytacie = [...sekcja('| priorytet | **P1** |'), '', '> uwaga', '>', '> ---', '', '| wymiar | wartość |', '| --- | --- |', '| ryzyko | **T3** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: liniaWCytacie })).add, ['P1', 'T3']);
  });

  test('przekreślona wartość nie jest wartością (PR #216)', () => {
    const poprawiona = tabela('| priorytet | ~~P1~~ **P2** | po korekcie |', '| ryzyko | ~~T3~~ T2 | po korekcie |');
    assert.deepEqual(reconcileTriage(nowa({ body: poprawiona })).add, ['P2', 'T2']);
    const wycofana = tabela('| priorytet | ~~P1~~ | wycofane |', '| ryzyko | **T1** | |');
    assert.deepEqual(reconcileTriage(nowa({ body: wycofana })).add, ['T1', NEEDS_TRIAGE]);
  });

  test('czytnik HTML: atrybuty, starszy kształt nagłówka, encje i przekreślenia', () => {
    const rows = html => plainRows(gate.triageTableRows(html));
    // Kształt z `bodyHTML`: atrybuty na znacznikach, opakowanie tabeli.
    assert.deepEqual(rows('<h2 dir="auto">Triage</h2>\n<markdown-accessiblity-table><table role="table">\n<thead>\n<tr>\n<th>wymiar</th>\n<th>wartość</th>\n</tr>\n</thead>\n' +
      '<tbody>\n<tr>\n<td>priorytet</td>\n<td align="center"><strong>P1</strong></td>\n</tr>\n</tbody>\n</table></markdown-accessiblity-table>'),
    [['wymiar', 'wartość'], ['priorytet', 'P1']]);
    // Starszy kształt: kotwica wewnątrz nagłówka; `>` w wartości atrybutu nie kończy znacznika.
    assert.deepEqual(rows('<H2><a id="user-content-triage" class="anchor" aria-label="a > b" href="#triage"><svg class="octicon"></svg></a>Triage</H2>' +
      '<TABLE><TR><TD title="x > y">ryzyko</TD><TD><code class="notranslate">T2</code></TD></TR></TABLE>'), [['ryzyko', 'T2']]);
    // Przekreślenie w każdym zapisie znika; encje są rozwijane po zdjęciu znaczników.
    assert.deepEqual(rows('<h2>Triage</h2><table><tr><td>priorytet</td><td><del>P1</del> <s>P3</s> <strike>P4</strike> P2 &amp; &lt;b&gt;</td></tr></table>'),
      [['priorytet', 'P2 & <b>']]);
    // Znaczniki w komórce mogą mieć atrybuty, także z `>` w wartości.
    assert.deepEqual(rows('<h2>Triage</h2><table><tr><td>priorytet</td><td><del class="x">P1</del> P2 <a title="a > b" href="#x">zob.</a></td></tr></table>'),
      [['priorytet', 'P2 zob.']]);
    // Koniec sekcji: nagłówek dowolnego poziomu albo linia pozioma, także samozamykająca.
    for (const koniec of ['<h3 dir="auto">Dalej</h3>', '<hr>', '<hr />', '<HR class="x">']) {
      assert.deepEqual(rows('<h2>Triage</h2><p>tekst</p>' + koniec + '<table><tr><td>priorytet</td><td>P1</td></tr></table>'), [], koniec);
    }
    // Opakowania dokładane przez GitHuba nie są poziomem zagnieżdżenia: nagłówek w `div`, tabela w elemencie
    // o nazwie z literówką albo bez niej.
    for (const opakowanie of ['markdown-accessiblity-table', 'markdown-accessibility-table']) {
      assert.deepEqual(rows('<div class="markdown-heading" dir="auto"><h2 tabindex="-1" class="heading-element" dir="auto">Triage</h2>' +
        '<a id="user-content-triage" class="anchor" href="#triage"><svg class="octicon"></svg></a></div>\n' +
        '<' + opakowanie + '><table role="table"><tbody><tr><td>priorytet</td><td>P1</td></tr></tbody></table></' + opakowanie + '>'),
      [['priorytet', 'P1']], opakowanie);
    }
    // `div` jest opakowaniem tylko z klasą `markdown-heading`; każdy inny to kontener autora.
    const wDiv = atrybuty => rows('<div' + atrybuty + '><h2>Triage</h2><table><tr><td>priorytet</td><td>P1</td></tr></table></div>');
    for (const atrybuty of ['', ' class="example"', ' class="not-markdown-heading"', ' class="markdown-heading-x"', ' data-class="markdown-heading"',
      ' id="user-content-x"', ' title="class=\'markdown-heading\'"']) {
      assert.deepEqual(wDiv(atrybuty), [], '<div' + atrybuty + '>');
    }
    for (const atrybuty of [' class="markdown-heading"', ' dir="auto" class="x markdown-heading y"', ' CLASS=\'markdown-heading\'']) {
      assert.deepEqual(wDiv(atrybuty), [['priorytet', 'P1']], '<div' + atrybuty + '>');
    }
    // Opakowanie samo nie jest elementem poziomu: zostają jego dzieci, w kolejności dokumentu.
    const nazwy = (html, przezroczyste) => plainRows(gate.topLevelElements(html, name => przezroczyste.includes(name)).map(e => e.name));
    assert.deepEqual(nazwy('<div><h2>a</h2><br></div><p>b <em>c</em></p><hr><ul><li>d</li></ul>', ['div']), ['h2', 'br', 'p', 'hr', 'ul']);
    assert.deepEqual(nazwy('<div><h2>a</h2><br></div><p>b</p>', []), ['div', 'p']);
    // Zagnieżdżenie: nagłówek i tabela w cytacie nie liczą się, a cytat w sekcji jej nie kończy.
    assert.deepEqual(rows('<blockquote><h2>Triage</h2><table><tr><td>priorytet</td><td>P4</td></tr></table></blockquote>'), []);
    assert.deepEqual(rows('<h2>Triage</h2><blockquote><h3>Cytat</h3><hr><table><tr><td>priorytet</td><td>P4</td></tr></table></blockquote>' +
      '<table><tr><td>ryzyko</td><td>T2</td></tr></table>'), [['ryzyko', 'T2']]);
    // Tabela w komórce jest treścią tej komórki, a nie osobnymi wierszami.
    assert.deepEqual(rows('<h2>Triage</h2><table><tbody><tr><td>uwagi</td><td><table><tr><td>priorytet</td><td>P0</td></tr></table></td></tr>' +
      '<tr><td>ryzyko</td><td>T1</td></tr></tbody></table>'), [['uwagi', 'priorytetP0'], ['ryzyko', 'T1']]);
    // Uszkodzony HTML: obcy znacznik zamykający jest pomijany, a element bez zamknięcia zostawia resztę zagnieżdżoną.
    assert.deepEqual(rows('</p><h2>Triage</h2></span><table><tr><td>priorytet</td><td>P1</td></tr></table>'), [['priorytet', 'P1']]);
    assert.deepEqual(rows('<section><h2>Triage</h2><table><tr><td>priorytet</td><td>P1</td></tr></table>'), []);
    // Tekst udający strukturę jest w HTML-u zakodowany encjami i struktury nie tworzy.
    assert.deepEqual(rows('<p><code>&lt;h2&gt;Triage&lt;/h2&gt;&lt;table&gt;&lt;tr&gt;&lt;td&gt;priorytet&lt;/td&gt;&lt;td&gt;P0&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</code></p>' +
      '<p><span title="&lt;h2&gt;Triage&lt;/h2&gt;">s</span></p>'), []);
    for (const pusty of ['', null, undefined, '<p>bez sekcji</p>', '<h2>Triage</h2><p>bez tabeli</p>', '<h2>Triage</h2><table><tr></tr></table>']) {
      assert.deepEqual(rows(pusty), [], String(pusty));
    }
  });

  test('needs-triage już obecne przy brakach — bez zapisu; kolejny przebieg po zapisie też nic nie zmienia', () => {
    assert.deepEqual(reconcileTriage(nowa({ labels: [NEEDS_TRIAGE] })).add, []);

    const input = nowa({ body: tabela('| priorytet | **P1** | pilne |', '| ryzyko | **T2** | zmiana |') });
    const drugi = poZapisie(input, przebieg(input));
    assert.deepEqual(drugi.labels, ['P1', 'T2', AUDIT_PENDING]);
    assert.deepEqual(labelChanges(przebieg(drugi), drugi.labels, DEFAULT_CONFIG), { add: [], remove: [] });
  });

  test('etykieta z tabeli liczy się jako wejście w zakres bramki w tym samym przebiegu', () => {
    // Issue sprzed startu bramki, objęta triage'em przez wcześniejszą datę startu:
    // jedynym powodem objęcia audytem jest etykieta nałożona właśnie teraz, a jej
    // jeszcze nie ma na osi czasu.
    const input = nowa({ createdAt: OLD, barrier: OLD, body: tabela('| priorytet | **P1** | pilne |', '| ryzyko | **T2** | zmiana |') });
    const outcome = przebieg(input, { triageActiveSince: '2026-08-01T00:00:00Z' });
    assert.deepEqual(outcome.triage.add, ['P1', 'T2']);
    assert.equal(outcome.audit.label, AUDIT_PENDING);
  });

  test('triage i sprzątanie audytu idą jednym zestawem zmian', () => {
    // P3 + T1 jest poza zakresem bramki, więc stare audit:ok znika razem z needs-triage.
    const input = nowa({ labels: [NEEDS_TRIAGE, 'P3', 'T1', AUDIT_OK] });
    assert.deepEqual(labelChanges(przebieg(input), input.labels, DEFAULT_CONFIG), { add: [], remove: [NEEDS_TRIAGE, AUDIT_OK] });
  });
});

describe('#211 CLI: konfiguracja triage\'u nie może zawieść po cichu', () => {
  const run = (extra, env = {}) => spawnSync(process.execPath,
    [SCRIPT, '--issue', '1', '--repo', 'owner/name', '--dry-run', ...extra],
    { encoding: 'utf8', env: { ...process.env, AUDIT_GATE_ACTIVE_SINCE: '', AUDIT_TRIAGE_ACTIVE_SINCE: '', AUDIT_TRIAGE_REQUIRED: '', ...env } });

  test('10: niepoprawna wartość --triage-required to błąd konfiguracji, bez zapisu', () => {
    for (const value of ['P,X', 'p', 'P,P', 'P,,T', 'P T', 'priorytet']) {
      const r = run(['--triage-required', value]);
      assert.equal(r.status, 2, value + ' → ' + r.stderr);
      assert.match(r.stderr, /--triage-required przyjmuje rodziny/, value);
    }
  });

  test('10: --triage-required bez wartości albo z pustą wartością też jest błędem', () => {
    for (const extra of [['--triage-required'], ['--triage-required', '']]) {
      const r = run(extra);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /--triage-required podano bez wartości/);
    }
  });

  test('10: niepoprawna wartość ze zmiennej środowiskowej jest odrzucana tak samo', () => {
    const r = run([], { AUDIT_TRIAGE_REQUIRED: 'P,obszar' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--triage-required przyjmuje rodziny/);
  });

  test('12: --triage-active-since bez wartości albo z niepoprawną datą to błąd konfiguracji', () => {
    for (const extra of [['--triage-active-since'], ['--triage-active-since', '']]) {
      const r = run(extra);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /--triage-active-since podano bez wartości/);
    }
    for (const value of ['wczoraj', '2026-09-27', '2026-9-27T00:00:00Z']) {
      const r = run(['--triage-active-since', value]);
      assert.equal(r.status, 2, value + ' → ' + r.stderr);
      assert.match(r.stderr, /--triage-active-since musi mieć postać RRRR-MM-DD/, value);
    }
    const r = run(['--triage-active-since', '2026-02-30T00:00:00Z']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--triage-active-since wskazuje datę, która nie istnieje/);
    const env = run([], { AUDIT_TRIAGE_ACTIVE_SINCE: 'wczoraj' });
    assert.equal(env.status, 2, env.stderr);
  });

  test('poprawna konfiguracja triage\'u przechodzi walidację', () => {
    const offline = { PATH: '', Path: '' };
    for (const extra of [['--triage-required', 'P,area'], ['--triage-required', 'P,T,area'],
      ['--triage-active-since', '2026-09-27T00:00:00Z']]) {
      const r = run(extra, offline);
      assert.doesNotMatch(String(r.stderr), /--triage-/, 'walidacja odrzuciła poprawne wejście: ' + JSON.stringify(extra));
      assert.notEqual(r.status, 2, r.stderr);
    }
  });
});

describe('#139 kontrakt workflow', () => {
  // Część kryteriów żyje w YAML-u, nie w logice: guard na komentarze w PR-ach,
  // serializacja i lista zdarzeń. Bez tego testu przeszłyby niezauważone.
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'issue-audit.yml'), 'utf8');

  test('14: issue_comment ma guard na pull requesty', () => {
    assert.match(workflow, /!github\.event\.issue\.pull_request/,
      'GitHub wysyła issue_comment także dla PR-ów');
  });

  test('concurrency serializuje per issue i nie anuluje runów w locie', () => {
    assert.match(workflow, /group:\s*issue-audit-\$\{\{[^}]*issue\.number/);
    assert.match(workflow, /cancel-in-progress:\s*false/);
  });

  test('workflow podaje datę startu bramki jawnie, zamiast polegać na domyślnej', () => {
    assert.match(workflow, /GATE_ACTIVE_SINCE:\s*"\d{4}-\d{2}-\d{2}T/);
    assert.match(workflow, /--gate-active-since\s+"\$GATE_ACTIVE_SINCE"/);
  });

  test('#211: workflow podaje datę startu triage\'u i wymagane rodziny jawnie', () => {
    assert.match(workflow, /TRIAGE_ACTIVE_SINCE:\s*"2026-09-27T00:00:00Z"/);
    assert.match(workflow, /--triage-active-since\s+"\$TRIAGE_ACTIVE_SINCE"/);
    assert.match(workflow, /TRIAGE_REQUIRED:\s*"P,T"/);
    assert.match(workflow, /--triage-required\s+"\$TRIAGE_REQUIRED"/);
    assert.equal(DEFAULT_CONFIG.triageActiveSince, '2026-09-27T00:00:00Z');
    assert.deepEqual(DEFAULT_CONFIG.triageRequired, ['P', 'T']);
  });

  test('obsłużone są wszystkie zdarzenia z kryteriów akceptacji', () => {
    for (const action of ['opened', 'edited', 'labeled', 'unlabeled', 'reopened']) {
      assert.match(workflow, new RegExp('\\b' + action + '\\b'), action);
    }
    assert.match(workflow, /issue_comment:/);
  });

  test('rodzina audit:* jest w labels.json i ma opisaną kardynalność', () => {
    const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'labels.json'), 'utf8'));
    const names = labels.labels.filter(l => l.family === 'audit').map(l => l.name).sort();
    assert.deepEqual(names, [AUDIT_CHANGES, AUDIT_OK, AUDIT_PENDING].sort());
    assert.ok(labels.families.audit, 'rodzina opisana w families');
    assert.match(labels.families.audit.cardinality, /0 (lub|or) 1/);
  });
});

describe('#231 werdykt ważny tylko od strony przeciwnej autorowi treści', () => {
  // Numeracja 1-7 odpowiada macierzy z opisu #231.
  const { latestDecision, parseCommand } = gate;

  const claudeIssue = (over = {}) => issue(Object.assign({
    labels: ['P2', 'T2', 'by:agent'], body: 'Specyfikacja.\n\n' + SIGN_CLAUDE, app: ''
  }, over));
  // Werdykt ChatGPT przez konektor; werdykt Claude przez `gh` to domyślne `cmd()`.
  const gptVerdict = (kind, createdAt, extra = {}) => cmd(kind, createdAt, Object.assign({
    body: '/audit-' + kind + '\n\nUzasadnienie.\n\n' + SIGN_GPT, app: GPT_APP
  }, extra));
  const verdictBody = (first, sign = SIGN_CLAUDE) => first + '\n\nUzasadnienie.\n\n' + sign;

  test('1: treść Claude z by:agent, werdykt ChatGPT przez konektor - audit:ok i audit:changes', () => {
    assert.equal(reconcile(claudeIssue({ comments: [gptVerdict('ok', LATER)] })).label, AUDIT_OK);
    assert.equal(reconcile(claudeIssue({ comments: [gptVerdict('changes', LATER)] })).label, AUDIT_CHANGES);
  });

  test('2: podpis ChatGPT wysłany przez gh albo podpis Claude przez konektor nie mają strony - audit:pending', () => {
    const viaGh = gptVerdict('ok', LATER, { app: '' });
    assert.equal(reconcile(claudeIssue({ comments: [viaGh] })).label, AUDIT_PENDING);
    const claudeViaConnector = cmd('ok', LATER, { app: GPT_APP });
    assert.equal(reconcile(issue({ comments: [claudeViaConnector] })).label, AUDIT_PENDING);
    const otherApp = gptVerdict('ok', LATER, { app: 'Inna aplikacja' });
    assert.equal(reconcile(claudeIssue({ comments: [otherApp] })).label, AUDIT_PENDING);
  });

  test('3: treść Claude i werdykt Claude - audit:pending, to werdykt autora własnej treści', () => {
    const result = reconcile(claudeIssue({ comments: [cmd('ok', LATER)] }));
    assert.equal(result.label, AUDIT_PENDING);
    assert.equal(result.action, 'set');
    assert.match(result.reason, /brak ważnego rozstrzygnięcia/);
  });

  test('3: ten sam przypadek w drugą stronę - treść ChatGPT i werdykt ChatGPT też nie rozstrzygają', () => {
    assert.equal(reconcile(issue({ comments: [gptVerdict('ok', LATER)] })).label, AUDIT_PENDING);
    assert.equal(reconcile(issue({ comments: [gptVerdict('changes', LATER)] })).label, AUDIT_PENDING);
  });

  test('4: treść ChatGPT bez by:agent, werdykt Claude przez gh - audit:ok i audit:changes', () => {
    assert.equal(reconcile(issue({ comments: [cmd('ok', LATER)] })).label, AUDIT_OK);
    assert.equal(reconcile(issue({ comments: [cmd('changes', LATER)] })).label, AUDIT_CHANGES);
  });

  describe('5: autorstwo ustala zgodność podpisu, by:agent i aplikacji - niezgodność to audit:pending', () => {
    const BY = ['P2', 'T2', 'by:agent'];
    const przypadki = [
      ['by:agent przy treści z podpisem ChatGPT (konektor)', { labels: BY, body: 'x\n\n' + SIGN_GPT, app: GPT_APP }],
      ['by:agent przy treści z podpisem ChatGPT (gh)', { labels: BY, body: 'x\n\n' + SIGN_GPT, app: '' }],
      ['podpis Claude bez by:agent', { body: 'x\n\n' + SIGN_CLAUDE, app: '' }],
      ['podpis Claude z by:agent, ale utworzone przez konektor', { labels: BY, body: 'x\n\n' + SIGN_CLAUDE, app: GPT_APP }],
      ['podpis ChatGPT bez by:agent, ale utworzone przez gh', { body: 'x\n\n' + SIGN_GPT, app: '' }],
      ['podpis ChatGPT, utworzone przez inną aplikację', { body: 'x\n\n' + SIGN_GPT, app: 'Inna aplikacja' }],
      ['podpis Claude, utworzone przez inną aplikację', { labels: BY, body: 'x\n\n' + SIGN_CLAUDE, app: 'Inna aplikacja' }],
      ['brak podpisu przy by:agent', { labels: BY, body: 'x', app: '' }],
      ['brak podpisu bez by:agent, utworzone przez gh', { body: 'x', app: '' }],
      ['brak podpisu bez by:agent, utworzone przez konektor', { body: 'x', app: GPT_APP }],
      ['brak treści i aplikacji', { body: undefined, app: undefined }]
    ];
    for (const [nazwa, over] of przypadki) {
      test(nazwa, () => {
        const result = reconcile(issue(Object.assign({}, over, { comments: [gptVerdict('ok', LATER), cmd('ok', LATEST)] })));
        assert.equal(result.label, AUDIT_PENDING, 'żadna ze stron nie jest ustalonym recenzentem');
        assert.match(result.reason, /autorstwo nieustalone/);
      });
    }

    test('utrata by:agent cofa wcześniejsze audit:ok, bo autorstwo przestało być ustalone', () => {
      const result = reconcile(issue({
        labels: ['P2', 'T2', AUDIT_OK], body: 'x\n\n' + SIGN_CLAUDE, app: '', comments: [gptVerdict('ok', LATER)]
      }));
      assert.equal(result.action, 'set');
      assert.equal(result.label, AUDIT_PENDING);
    });

    test('ustalone autorstwo nie jest powodem pending, gdy werdykt stoi', () => {
      const result = reconcile(claudeIssue({ comments: [gptVerdict('ok', LATER)] }));
      assert.doesNotMatch(result.reason, /nieustalone/);
    });
  });

  describe('6: komenda tylko w pierwszej niepustej linii, bez wciętego kodu, bez dalszych znaków nazwy', () => {
    const nieKomendy = [
      '/audit-ok-nie', '/audit-ok_nie', '/audit-okay', '/audit-ok2', '/audit-changes-x', '/audit-changesx',
      '    /audit-ok', '\t/audit-ok', '   \t/audit-ok', 'Cytat:\n\n/audit-ok', '> /audit-ok', '`/audit-ok`',
      '```\n/audit-ok\n```', 'Zgadzam się, /audit-ok', '/AUDIT-OK', 'audit-ok'
    ];
    for (const body of nieKomendy) {
      test('nie jest komendą: ' + JSON.stringify(body), () => {
        assert.equal(parseCommand(body, DEFAULT_CONFIG), '');
        const comment = gptVerdict('ok', LATER, { body: verdictBody(body, SIGN_GPT) });
        assert.equal(reconcile(claudeIssue({ comments: [comment] })).label, AUDIT_PENDING, 'brak werdyktu');
      });
    }

    const komendy = [
      ['/audit-ok', 'ok'], ['/audit-changes', 'changes'], ['  /audit-ok', 'ok'], ['\n\n/audit-changes', 'changes'],
      ['/audit-ok\r\nUzasadnienie.', 'ok'], ['/audit-ok.', 'ok'], ['/audit-ok: tak', 'ok'], ['/audit-ok tak', 'ok'],
      ['/audit-changes!', 'changes'], ['  \n/audit-ok', 'ok']
    ];
    for (const [body, kind] of komendy) {
      test('jest komendą: ' + JSON.stringify(body), () => {
        assert.equal(parseCommand(body, DEFAULT_CONFIG), kind);
      });
    }

    test('komenda stoi w pierwszej niepustej linii, a druga komenda niżej nie zmienia werdyktu', () => {
      assert.equal(parseCommand('/audit-ok\n/audit-changes', DEFAULT_CONFIG), 'ok');
      assert.equal(parseCommand('Komentarz\n/audit-ok', DEFAULT_CONFIG), '');
      assert.equal(parseCommand(null, DEFAULT_CONFIG), '');
      assert.equal(parseCommand('', DEFAULT_CONFIG), '');
    });
  });

  describe('7: komentarz edytowany po publikacji nie jest werdyktem', () => {
    test('znacznik lastEditedAt, także tekstowy „brak danych”, unieważnia komentarz', () => {
      for (const edited of ['2026-09-08T13:00:00Z', 'unknown']) {
        const result = reconcile(claudeIssue({ comments: [gptVerdict('ok', LATER, { lastEditedAt: edited })] }));
        assert.equal(result.label, AUDIT_PENDING, edited);
      }
    });

    test('nieedytowany komentarz (null, brak pola, pusty napis) jest werdyktem', () => {
      for (const edited of [null, undefined, '']) {
        const result = reconcile(claudeIssue({ comments: [gptVerdict('ok', LATER, { lastEditedAt: edited })] }));
        assert.equal(result.label, AUDIT_OK, String(edited));
      }
    });

    test('edytowany werdykt zdejmuje audit:ok, a wcześniejszy nieedytowany nadal obowiązuje', () => {
      const earlier = gptVerdict('changes', LATER);
      const edited = gptVerdict('ok', LATEST, { lastEditedAt: '2026-09-08T15:00:00Z' });
      assert.equal(reconcile(claudeIssue({ comments: [earlier, edited] })).label, AUDIT_CHANGES);
      const result = reconcile(claudeIssue({ labels: ['P2', 'T2', 'by:agent', AUDIT_OK], comments: [edited] }));
      assert.equal(result.action, 'set');
      assert.equal(result.label, AUDIT_PENDING);
    });
  });

  describe('podpis komentarza wyznacza stronę', () => {
    const asGpt = (body, over = {}) => gptVerdict('ok', LATER, Object.assign({ body: body }, over));

    test('komentarz bez podpisu, z podpisem poza ostatnią linią albo we wcięciu nie ma strony', () => {
      const bodies = [
        '/audit-ok\n\nUzasadnienie.',
        '/audit-ok\n' + SIGN_GPT + '\nUzasadnienie.',
        '/audit-ok\n\n    ' + SIGN_GPT,
        '/audit-ok\n\n\t' + SIGN_GPT,
        '/audit-ok\n\n— ChatGPT i ktoś jeszcze',
        '/audit-ok\n\n_— ChatGPT_ _— ChatGPT_'
      ];
      for (const body of bodies) {
        assert.equal(reconcile(claudeIssue({ comments: [asGpt(body)] })).label, AUDIT_PENDING, JSON.stringify(body));
      }
    });

    test('podpis w kursywie, goły, z końcowymi pustymi liniami i CRLF jest rozpoznawany', () => {
      const bodies = [
        '/audit-ok\n\n_— ChatGPT_', '/audit-ok\n\n— ChatGPT', '/audit-ok\n\n_— ChatGPT_\n\n\n',
        '/audit-ok\r\n\r\n_— ChatGPT_\r\n', '/audit-ok\n\n  _— ChatGPT_  '
      ];
      for (const body of bodies) {
        assert.equal(reconcile(claudeIssue({ comments: [asGpt(body)] })).label, AUDIT_OK, JSON.stringify(body));
      }
    });

    test('podobny, ale inny podpis nie liczy się jako strona', () => {
      const bodies = ['/audit-ok\n\n_- ChatGPT_', '/audit-ok\n\n__— ChatGPT__', '/audit-ok\n\n_— chatgpt_', '/audit-ok\n\nconstructor',
        '/audit-ok\n\n__proto__'];
      for (const body of bodies) {
        assert.equal(reconcile(claudeIssue({ comments: [asGpt(body)] })).label, AUDIT_PENDING, JSON.stringify(body));
      }
    });
  });

  describe('wybór werdyktu spośród komentarzy', () => {
    test('nieuprawniony, własny albo edytowany komentarz nowszy od ważnego nie zasłania go', () => {
      const valid = gptVerdict('ok', LATER);
      const comments = [
        valid,
        cmd('changes', LATEST),
        gptVerdict('changes', LATEST, { authorAssociation: 'NONE' }),
        gptVerdict('changes', LATEST, { lastEditedAt: '2026-09-08T15:00:00Z' })
      ];
      assert.equal(reconcile(claudeIssue({ comments })).label, AUDIT_OK);
    });

    test('z dwóch ważnych werdyktów wygrywa nowszy, niezależnie od kolejności na liście', () => {
      const older = gptVerdict('ok', LATER);
      const newer = gptVerdict('changes', LATEST);
      assert.equal(reconcile(claudeIssue({ comments: [older, newer] })).label, AUDIT_CHANGES);
      assert.equal(reconcile(claudeIssue({ comments: [newer, older] })).label, AUDIT_CHANGES);
    });

    test('dobrowolne wejście przez komendę na starej issue działa tylko dla strony przeciwnej', () => {
      const own = reconcile(claudeIssue({ barrier: OLD, comments: [cmd('ok', LATER)] }));
      assert.equal(own.action, 'none', 'własny werdykt nie wprowadza issue do bramki');
      const foreign = reconcile(claudeIssue({ barrier: OLD, comments: [gptVerdict('ok', LATER)] }));
      assert.equal(foreign.label, AUDIT_OK);
    });

    test('issue o nieustalonym autorstwie sprzed startu bramki zostaje poza bramką', () => {
      const result = reconcile(issue({ barrier: OLD, body: 'x', app: '', comments: [cmd('ok', LATER), gptVerdict('ok', LATER)] }));
      assert.equal(result.action, 'none');
    });

    test('latestDecision bez recenzenta nie zwraca niczego, także dla komentarza bez strony', () => {
      const comments = [cmd('ok', LATER, { body: '/audit-ok\n\nBez podpisu.' }), gptVerdict('ok', LATER)];
      assert.equal(latestDecision(comments, NEW, DEFAULT_CONFIG, ''), null);
      assert.equal(latestDecision(comments, NEW, DEFAULT_CONFIG, undefined), null);
      assert.equal(latestDecision(comments, NEW, DEFAULT_CONFIG, 'claude'), null);
      assert.equal(latestDecision(comments, NEW, DEFAULT_CONFIG, 'gpt'), comments[1]);
    });
  });
});

describe('#231 kontrakt workflow: zdarzenia komentarza i pobierane pliki', () => {
  const root = path.join(__dirname, '..');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'issue-audit.yml'), 'utf8');

  test('issue_comment reaguje na utworzenie, edycję i usunięcie komentarza', () => {
    const block = /issue_comment:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(workflow);
    assert.ok(block, 'sekcja issue_comment z listą types');
    const types = block[1].split(',').map(name => name.trim()).sort();
    assert.deepEqual(types, ['created', 'deleted', 'edited']);
  });

  test('usunięcie komentarza przechodzi warunek joba niezależnie od autora usuniętego komentarza', () => {
    const condition = /if:\s*>-\s*\n((?:\s+.*\n)+?)\s+runs-on:/.exec(workflow);
    assert.ok(condition, 'warunek joba');
    assert.match(condition[1], /github\.event\.action\s*==\s*'deleted'/);
    assert.match(condition[1], /github\.event_name\s*==\s*'issues'/);
    assert.match(condition[1], /!github\.event\.issue\.pull_request/);
    assert.match(condition[1], /OWNER.*MEMBER.*COLLABORATOR/);
  });

  test('workflow pobiera każdy plik, który bramka ładuje przez require', () => {
    const sparse = /sparse-checkout:\s*\|\s*\n((?:\s+scripts\/\S+\n)+)/.exec(workflow);
    assert.ok(sparse, 'lista sparse-checkout');
    const checkedOut = sparse[1].split('\n').map(line => line.trim()).filter(Boolean);
    const seen = new Set();
    const queue = ['scripts/quality/issue-audit-gate.js'];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
        queue.push(path.posix.join(path.posix.dirname(file), match[1]).replace(/(?<!\.js)$/, '.js'));
      }
    }
    assert.ok(seen.size >= 3, 'bramka ma co najmniej moduły stron i odczytu: ' + [...seen].join(', '));
    for (const file of seen) assert.ok(checkedOut.includes(file), file + ' nie jest pobierany przez workflow');
  });

  test('komentarz-znacznik nie twierdzi, że zmieniła się wyłącznie treść issue', () => {
    assert.match(workflow, /komentarz z werdyktem \(edycja lub usunięcie\)/);
  });
});

describe('#231 powody wyniku są jedynym śladem w logu przebiegu', () => {
  const claudeIssue = (over = {}) => issue(Object.assign({
    labels: ['P2', 'T2', 'by:agent'], body: 'Specyfikacja.\n\n' + SIGN_CLAUDE, app: ''
  }, over));
  const gptVerdict = (kind, createdAt, extra = {}) => cmd(kind, createdAt, Object.assign({
    body: '/audit-' + kind + '\n\nUzasadnienie.\n\n' + SIGN_GPT, app: GPT_APP
  }, extra));

  test('issue zamknięta, brak bariery, poza zakresem', () => {
    assert.deepEqual(reconcile(issue({ state: 'closed', labels: ['P2', AUDIT_OK] })),
      { action: 'none', label: AUDIT_OK, reason: 'issue zamknięta' });
    assert.deepEqual(reconcile(issue({ barrier: '', labels: ['P2', AUDIT_OK] })),
      { action: 'none', label: AUDIT_OK, reason: 'brak bariery rewizji (fail-closed)' });
    assert.deepEqual(reconcile(issue({ labels: ['P3', 'T1', AUDIT_OK] })),
      { action: 'clear', label: '', reason: 'issue poza zakresem bramki' });
    assert.deepEqual(reconcile(issue({ labels: ['P3', 'T1'] })),
      { action: 'none', label: '', reason: 'issue poza zakresem bramki' });
  });

  test('werdykt, brak werdyktu, bez zmiany i duplikat rodziny audit:*', () => {
    const reason = 'rozstrzygnięcie z ' + LATER + ' nowsze niż rewizja ' + NEW;
    assert.deepEqual(reconcile(issue({ comments: [cmd('ok', LATER)] })),
      { action: 'set', label: AUDIT_OK, reason });
    assert.deepEqual(reconcile(issue({ labels: ['P2', AUDIT_PENDING], comments: [cmd('ok', LATER)] })),
      { action: 'set', label: AUDIT_OK, reason });
    assert.deepEqual(reconcile(issue({ labels: ['P2', AUDIT_OK], comments: [cmd('ok', LATER)] })),
      { action: 'none', label: AUDIT_OK, reason: reason + ' (bez zmiany)' });
    assert.deepEqual(reconcile(issue({ labels: ['P2', AUDIT_OK, AUDIT_PENDING], comments: [cmd('ok', LATER)] })),
      { action: 'set', label: AUDIT_OK, reason: reason + ' (usuwam duplikat rodziny audit:*)' });
    assert.deepEqual(reconcile(issue()),
      { action: 'set', label: AUDIT_PENDING, reason: 'brak ważnego rozstrzygnięcia dla rewizji ' + NEW });
    assert.deepEqual(reconcile(issue({ labels: ['P2', AUDIT_PENDING] })),
      { action: 'none', label: AUDIT_PENDING, reason: 'brak ważnego rozstrzygnięcia dla rewizji ' + NEW + ' (bez zmiany)' });
  });

  test('autorstwo nieustalone niesie powód z modułu stron', () => {
    assert.deepEqual(reconcile(issue({ body: 'x', comments: [cmd('ok', LATER)] })), {
      action: 'set', label: AUDIT_PENDING,
      reason: 'autorstwo nieustalone: brak podpisu strony w ostatniej linii treści'
    });
    assert.deepEqual(reconcile(claudeIssue({ app: GPT_APP })), {
      action: 'set', label: AUDIT_PENDING,
      reason: 'autorstwo nieustalone: podpis Claude Code, ale zgłoszenie utworzył ChatGPT Codex Connector'
    });
  });

  test('komentarz z datą równą barierze albo bez daty nie jest werdyktem', () => {
    assert.equal(reconcile(claudeIssue({ comments: [gptVerdict('ok', NEW)] })).label, AUDIT_PENDING, 'ta sama sekunda co edycja treści');
    for (const createdAt of ['', null, undefined]) {
      assert.equal(reconcile(claudeIssue({ comments: [gptVerdict('ok', createdAt)] })).label, AUDIT_PENDING, String(createdAt));
    }
    assert.equal(reconcile(claudeIssue({ comments: [gptVerdict('ok', '2026-09-08T10:00:01Z')] })).label, AUDIT_OK, 'sekunda później');
  });

  test('latestDecision bez listy komentarzy albo z komentarzem bez uprawnień nie zwraca niczego', () => {
    for (const comments of [undefined, null, []]) {
      assert.equal(gate.latestDecision(comments, NEW, DEFAULT_CONFIG, 'gpt'), null, String(comments));
    }
    const noAssociation = gptVerdict('ok', LATER, { authorAssociation: undefined });
    assert.equal(gate.latestDecision([noAssociation], NEW, DEFAULT_CONFIG, 'gpt'), null);
  });
});
