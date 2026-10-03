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

const { spawnSync } = require('child_process');

const gate = require('../scripts/quality/issue-audit-gate.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'quality', 'issue-audit-gate.js');
const { reconcile, DEFAULT_CONFIG, AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES } = gate;

const GATE_ACTIVE = DEFAULT_CONFIG.gateActiveSince;
// Rewizja sprzed wdrożenia bramki (issue „legacy”) i po wdrożeniu.
const OLD = '2026-09-01T10:00:00Z';
const NEW = '2026-09-08T10:00:00Z';
const LATER = '2026-09-08T12:00:00Z';
const LATEST = '2026-09-08T14:00:00Z';

const labeled = (label, createdAt) => ({ type: 'LABELED', label, createdAt });
const unlabeled = (label, createdAt) => ({ type: 'UNLABELED', label, createdAt });

const cmd = (kind, createdAt, extra = {}) => Object.assign({
  body: '/audit-' + kind + '\n\nUzasadnienie.',
  authorAssociation: 'OWNER',
  createdAt: createdAt
}, extra);

const issue = (over = {}) => Object.assign({
  state: 'open',
  labels: ['P2', 'T2'],
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
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'quality', 'issue-audit-gate.js'), 'utf8');
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
  const nowa = (over = {}) => issue(Object.assign({
    labels: [], createdAt: CREATED, barrier: CREATED, body: '', repoLabels: REPO_LABELS
  }, over));
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

  test('przykład „## Triage” w bloku kodu przed właściwą sekcją nie jest czytany (PR #216)', () => {
    const body = ['## Problem', '', 'Przykład tabeli:', '', '```md', '## Triage', '', '| priorytet | **P4** | przykład |',
      '| ryzyko | **T1** | przykład |', '```', '', '~~~', '## Triage', '| priorytet | **P4** | przykład |', '~~~', '',
      '## Triage', '', '| wymiar | wartość |', '| --- | --- |', '| priorytet | **P1** |', '```', '| ryzyko | **T1** |', '```',
      '| ryzyko | **T3** |'].join('\n');
    const outcome = przebieg(nowa({ body }));
    assert.deepEqual(outcome.triage.add, ['P1', 'T3']);
    assert.equal(outcome.audit.label, AUDIT_PENDING);
  });

  test('blok kodu zamyka tylko ten sam znacznik, a z dwóch sekcji „Triage” czytana jest pierwsza (PR #216)', () => {
    const wBloku = ['```md', '~~~', '## Triage', '| priorytet | **P4** | przykład |', '| ryzyko | **T1** | przykład |', '```', '',
      '## Triage', '', '| priorytet | **P1** |', '| ryzyko | **T3** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: wBloku })).add, ['P1', 'T3']);

    const dwie = ['## Triage', '', '| priorytet | **P1** |', '', '## Uwagi', '', 'Tekst.', '', '## Triage', '', '| priorytet | **P2** |',
      '| ryzyko | **T2** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: dwie })).add, ['P1', NEEDS_TRIAGE], 'druga sekcja nie dokłada ani P2, ani T2');
  });

  test('blok kodu zamyka znacznik tego samego znaku, co najmniej tej samej długości i bez dopisku (PR #216)', () => {
    const wlasciwa = ['', '## Triage', '', '| priorytet | **P1** |', '| ryzyko | **T3** |'];
    const przyklad = ['## Triage', '| priorytet | **P4** | przykład |', '| ryzyko | **T1** | przykład |'];
    const warianty = {
      'cztery grawisy z zagnieżdżonym blokiem trzech': ['````md', '```md'].concat(przyklad, ['```', '````']),
      'krótszy znacznik nie zamyka': ['`````', '````'].concat(przyklad, ['`````']),
      'znacznik z dopiskiem nie zamyka': ['```md', '``` js'].concat(przyklad, ['```']),
      'tyldy z zagnieżdżonymi tyldami': ['~~~~', '~~~'].concat(przyklad, ['~~~', '~~~~'])
    };
    for (const [nazwa, blok] of Object.entries(warianty)) {
      const body = ['## Problem', ''].concat(blok, wlasciwa).join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T3'], nazwa);
    }
  });

  test('komentarz HTML nie jest czytany: przykład przed sekcją ani wykomentowany wiersz w sekcji (PR #216)', () => {
    const body = ['<!--', '## Triage', '| priorytet | **P4** | przykład z szablonu |', '| ryzyko | **T1** | przykład |', '-->', '',
      '## Triage', '', '| priorytet | **P1** |', '<!-- | ryzyko | **T1** | -->', '| ryzyko | **T3** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T3']);

    const niezamkniety = ['## Triage', '', '| priorytet | **P1** |', '<!--', '| ryzyko | **T3** |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body: niezamkniety })).add, ['P1', NEEDS_TRIAGE], 'niezamknięty komentarz ukrywa resztę treści');
  });

  test('nagłówek sekcji wcięty do trzech spacji albo z zamykającymi # jest nagłówkiem (PR #216)', () => {
    for (const naglowek of ['  ## Triage', '## Triage ##', '## triage']) {
      const body = [naglowek, '', '| priorytet | **P1** |', '| ryzyko | **T2** |', '', '   ## Dalej', '| ryzyko | **T3** |'].join('\n');
      assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T2'], naglowek);
    }
  });

  test('tabela bez zewnętrznych separatorów | też jest czytana (PR #216)', () => {
    const body = ['## Triage', '', 'wymiar | wartość', '--- | ---', 'priorytet | **P1**', 'ryzyko zmiany | **T2**', '', 'Zdanie bez tabeli.'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, ['P1', 'T2']);
  });

  test('tabela poza sekcją „Triage” nie jest czytana', () => {
    const body = ['## Zakres', '', '| priorytet | **P1** | pilne |', '', '## Triage', '', 'Do ustalenia.', '',
      '## Inne', '', '| ryzyko | **T2** | zmiana |'].join('\n');
    assert.deepEqual(reconcileTriage(nowa({ body })).add, [NEEDS_TRIAGE]);
    assert.deepEqual(gate.triageTableRows(body), []);
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
