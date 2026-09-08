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

const gate = require('../scripts/quality/issue-audit-gate.js');
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
