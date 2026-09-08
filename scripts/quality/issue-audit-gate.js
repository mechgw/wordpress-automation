#!/usr/bin/env node
'use strict';

/**
 * Bramka audytu specyfikacji issue (#139).
 *
 * Issue w zakresie dostaje jawny stan audytu: `audit:pending`, `audit:ok` albo
 * `audit:changes`. Recenzent rozstrzyga komentarzem zaczynającym się od
 * `/audit-ok` albo `/audit-changes`, a edycja treści unieważnia rozstrzygnięcie.
 *
 * Model: RECONCILER, nie zestaw handlerów zdarzeń. GitHub Actions przy
 * `cancel-in-progress: false` trzyma w grupie tylko jeden run `pending`
 * i ANULUJE go, gdy przyjdzie kolejne zdarzenie. Zdarzenie nie jest więc
 * opóźniane, tylko tracone. Dlatego każdy run czyta aktualny stan i wylicza
 * z niego etykietę docelową; utrata jednego runu nie gubi semantyki, bo
 * następny run naprawia stan.
 *
 * Konsekwencje tej decyzji, których nie wolno „uprościć”:
 *   1. stan czytamy w chwili wykonania, nigdy z payloadu zdarzenia;
 *   2. bariera rewizji pochodzi z `userContentEdits`, nie z komentarza-znacznika
 *      (marker publikuje anulowalny run, więc nie może być źródłem prawdy);
 *   3. brak bariery = brak zapisu (fail-closed);
 *   4. najnowszej komendy szukamy po WSZYSTKICH komentarzach, nie po pierwszej
 *      stronie.
 *
 * Moduł eksportuje czystą funkcję `reconcile()` (testowaną jednostkowo) oraz
 * tryb CLI, który pobiera dane przez `gh` i nakłada etykiety:
 *   node scripts/quality/issue-audit-gate.js --issue <numer> [--repo owner/name]
 *     [--dry-run]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const AUDIT_PENDING = 'audit:pending';
const AUDIT_OK = 'audit:ok';
const AUDIT_CHANGES = 'audit:changes';

const DEFAULT_CONFIG = {
  auditLabels: [AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES],
  // Zakres bramki: priorytet P0-P2 ALBO tier T2/T3. Brak P* i T* znaczy
  // „przed triage'em” — od tego jest `needs-triage`, nie bramka audytu.
  scopeLabels: ['P0', 'P1', 'P2', 'T2', 'T3'],
  // Tak samo jak review-gate.yml:92. To NIE jest literalne sprawdzenie
  // uprawnienia `write`; nazywamy to po imieniu, żeby specyfikacja nie
  // obiecywała czegoś, czego implementacja nie robi.
  commandAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  commandPattern: /^\s*\/audit-(ok|changes)\b/,
  // Bramka nie obejmuje wstecz issue sprzed swojego wdrożenia. Bez tej stałej
  // reconciler wyliczyłby `audit:pending` dla całego archiwum, czyli zrobiłby
  // backfill, którego świadomie nie chcemy.
  gateActiveSince: '2026-09-08T00:00:00Z'
};

/** Czy zestaw etykiet kwalifikuje issue do bramki. */
function inScope(labels, cfg) {
  return (labels || []).some(name => cfg.scopeLabels.includes(name));
}

/** Wszystkie obecne etykiety rodziny audit. Kardynalność ma być 0 lub 1, ale
 *  ręczna edycja albo awaria potrafi zostawić dwie — reconciler musi to widzieć. */
function auditLabelsPresent(labels, cfg) {
  return (labels || []).filter(name => cfg.auditLabels.includes(name));
}

/** Etykieta stanu audytu obecna na issue; '' gdy żadnej. */
function currentAuditLabel(labels, cfg) {
  return auditLabelsPresent(labels, cfg)[0] || '';
}

/** Rodzaj komendy w treści komentarza; '' gdy komentarz nie jest komendą. */
function parseCommand(body, cfg) {
  const match = cfg.commandPattern.exec(String(body || ''));
  return match ? match[1] : '';
}

/**
 * Najnowsza WAŻNA komenda: rozpoznana, od osoby uprawnionej i nowsza niż
 * bariera rewizji. Komenda starsza od bariery dotyczy nieaktualnej treści
 * i nie może niczego rozstrzygać.
 */
function latestDecision(comments, barrier, cfg) {
  return (comments || [])
    .filter(c => cfg.commandAssociations.includes(String(c.authorAssociation || '')))
    .filter(c => parseCommand(c.body, cfg))
    .filter(c => String(c.createdAt || '') > barrier)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .pop() || null;
}

/**
 * Kiedy issue OSTATNI raz weszła w zakres bramki (`out → in`); '' gdy nigdy.
 *
 * Pierwotny projekt czytał to z payloadu zdarzenia `labeled`, bo założyliśmy,
 * że zakresu „przed” nie da się odtworzyć ze stanu. To założenie było błędne
 * i miało dokładnie tę wadę, którą reszta reconcilera eliminuje: gdy run od
 * pierwszej etykiety zakresu zostanie anulowany przez kolejne zdarzenie,
 * następny run dostaje już inną etykietę w payloadzie, jej usunięcie nie
 * wyprowadza issue z zakresu i przejście przepada bezpowrotnie.
 *
 * Timeline etykiet jest źródłem autorytatywnym. Odtwarzamy stan wstecz od
 * bieżącego zestawu: idąc od najnowszego zdarzenia cofamy jego skutek i
 * pytamy, czy w tym momencie zakres zmienił się z „poza” na „w”.
 */
function lastScopeEntryAt(currentLabels, labelEvents, cfg) {
  const events = (labelEvents || [])
    .filter(e => e && e.label && e.createdAt)
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  let labels = (currentLabels || []).slice();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const after = inScope(labels, cfg);
    labels = event.type === 'LABELED'
      ? labels.filter(name => name !== event.label)
      : labels.concat([event.label]);
    if (after && !inScope(labels, cfg)) return event.createdAt;
  }
  return '';
}

/**
 * Bariera rewizji: czas ostatniej edycji TREŚCI. Issue nigdy nieedytowana nie ma
 * wpisu w `userContentEdits` — wtedy barierą jest moment utworzenia.
 */
function revisionBarrier(issueNode) {
  const edits = (issueNode && issueNode.userContentEdits && issueNode.userContentEdits.nodes) || [];
  return (edits.length && edits[edits.length - 1].editedAt) || (issueNode && issueNode.createdAt) || '';
}

/**
 * Czy issue jest OBJĘTA bramką. Alternatywa czterech warunków — wystarczy
 * jeden. Gdy nie zachodzi żaden, issue w zakresie zostaje poza bramką i run
 * nie zapisuje nic; nie nadaje `audit:pending`.
 */
function isEngaged(input, barrier, decision, cfg) {
  if (currentAuditLabel(input.labels, cfg)) return true;
  if (barrier >= cfg.gateActiveSince) return true;
  const entry = lastScopeEntryAt(input.labels, input.labelEvents, cfg);
  if (entry && entry >= cfg.gateActiveSince) return true;
  // Dobrowolne wejście przez komendę. Warunek liczymy ze stanu (istnieje ważna
  // komenda po barierze), a nie z rodzaju bieżącego zdarzenia — dzięki temu
  // zachowanie jest takie samo także wtedy, gdy run od komentarza przepadł
  // i naprawia stan dopiero kolejne zdarzenie.
  return Boolean(decision);
}

/**
 * @param {object} input
 * @param {string}   input.state       'open' | 'closed'
 * @param {string[]} input.labels      aktualne etykiety issue
 * @param {string}   input.barrier     ISO: ostatnia edycja treści albo createdAt
 * @param {Array}    input.comments    [{ body, authorAssociation, createdAt }]
 * @param {Array}    [input.labelEvents] [{ type: 'LABELED'|'UNLABELED', label, createdAt }]
 * @param {object}   [config]
 * @returns {{ action: 'none'|'set'|'clear', label: string, reason: string }}
 */
function reconcile(input, config = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  const present = auditLabelsPresent(input.labels, cfg);
  const current = present[0] || '';

  // Zamknięcie kończy temat. Świadome odstępstwo od czystego reconcilera:
  // czyszczenie etykiet po fakcie zaśmiecałoby archiwum.
  if (input.state === 'closed') return { action: 'none', label: current, reason: 'issue zamknięta' };

  const barrier = String(input.barrier || '');
  if (!barrier) return { action: 'none', label: current, reason: 'brak bariery rewizji (fail-closed)' };

  if (!inScope(input.labels, cfg)) {
    return present.length
      ? { action: 'clear', label: '', reason: 'issue poza zakresem bramki' }
      : { action: 'none', label: '', reason: 'issue poza zakresem bramki' };
  }

  const decision = latestDecision(input.comments, barrier, cfg);
  if (!isEngaged(input, barrier, decision, cfg)) {
    return { action: 'none', label: current, reason: 'issue nieobjęta bramką (brak backfillu)' };
  }

  const desired = decision ? 'audit:' + parseCommand(decision.body, cfg) : AUDIT_PENDING;
  const reason = decision
    ? 'rozstrzygnięcie z ' + decision.createdAt + ' nowsze niż rewizja ' + barrier
    : 'brak ważnego rozstrzygnięcia dla rewizji ' + barrier;

  // Zgodność samej pierwszej etykiety nie wystarcza: przy duplikacie rodziny
  // (np. `audit:ok` obok `audit:pending`) trzeba wymusić zapis, żeby `apply`
  // usunęło nadmiarową. Inaczej kardynalność „0 lub 1” zostałaby złamana
  // na stałe, bo kolejne przebiegi widziałyby stan jako zgodny.
  if (desired === current && present.length === 1) {
    return { action: 'none', label: current, reason: reason + ' (bez zmiany)' };
  }
  if (present.length > 1) {
    return { action: 'set', label: desired, reason: reason + ' (usuwam duplikat rodziny audit:*)' };
  }
  return { action: 'set', label: desired, reason: reason };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Stan autorytatywny w chwili wykonania. `userContentEdits` daje czas ostatniej
 * edycji TREŚCI — w odróżnieniu od `updatedAt`, które zmienia każda etykieta
 * i każdy komentarz. Paginacja komentarzy jest obowiązkowa: najnowsza komenda
 * bywa daleko poza pierwszą stroną.
 */
function fetchInput(repo, issue) {
  const [owner, name] = repo.split('/');
  // Obie kolekcje stronicujemy do końca, każdą osobno: najnowsza komenda
  // potrafi być daleko poza pierwszą stroną, a historia etykiet decyduje
  // o objęciu bramką. Wspólna pętla dla dwóch niezależnych kursorów duplikuje
  // wyniki tej kolekcji, która skończyła się wcześniej.
  const issueQuery = `
    query($owner:String!, $name:String!, $number:Int!) {
      repository(owner:$owner, name:$name) {
        issue(number:$number) {
          state
          createdAt
          labels(first:100) { nodes { name } }
          userContentEdits(last:1) { nodes { editedAt } }
        }
      }
    }`;

  const commentsQuery = `
    query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        issue(number:$number) {
          comments(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { body authorAssociation createdAt }
          }
        }
      }
    }`;

  const timelineQuery = `
    query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        issue(number:$number) {
          timelineItems(first:100, after:$cursor, itemTypes:[LABELED_EVENT, UNLABELED_EVENT]) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on LabeledEvent { createdAt label { name } }
              ... on UnlabeledEvent { createdAt label { name } }
            }
          }
        }
      }
    }`;

  const ask = (query, cursor) => {
    const args = ['api', 'graphql', '-f', 'query=' + query,
      '-F', 'owner=' + owner, '-F', 'name=' + name, '-F', 'number=' + issue];
    if (cursor) args.push('-F', 'cursor=' + cursor);
    const node = JSON.parse(gh(args)).data.repository.issue;
    if (!node) throw new Error('Nie znaleziono issue #' + issue + ' w ' + repo);
    return node;
  };

  const collect = (query, field) => {
    const all = [];
    let cursor = null;
    for (;;) {
      const page = ask(query, cursor)[field];
      all.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return all;
      cursor = page.pageInfo.endCursor;
    }
  };

  const issueNode = ask(issueQuery, null);
  const comments = collect(commentsQuery, 'comments');
  const labelEvents = collect(timelineQuery, 'timelineItems').map(node => ({
    type: node.__typename === 'LabeledEvent' ? 'LABELED' : 'UNLABELED',
    label: node.label && node.label.name,
    createdAt: node.createdAt
  }));

  return {
    state: String(issueNode.state || '').toLowerCase(),
    labels: issueNode.labels.nodes.map(l => l.name),
    barrier: revisionBarrier(issueNode),
    comments: comments,
    labelEvents: labelEvents
  };
}

function apply(repo, issue, result, labels, cfg) {
  if (result.action === 'none') return;
  // Usuwamy tylko etykiety faktycznie obecne: `gh issue edit --remove-label`
  // na nieistniejącej etykiecie kończy się błędem.
  const remove = cfg.auditLabels
    .filter(name => name !== result.label)
    .filter(name => (labels || []).includes(name));
  if (!result.label && !remove.length) return;
  const args = ['issue', 'edit', String(issue), '--repo', repo];
  if (result.label) args.push('--add-label', result.label);
  remove.forEach(name => args.push('--remove-label', name));
  gh(args);
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue') args.issue = argv[++i];
    else if (argv[i] === '--repo') args.repo = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  if (!args.issue || !repo) {
    console.error('Usage: node scripts/quality/issue-audit-gate.js --issue <number> [--repo owner/name] [--dry-run]');
    process.exit(2);
  }

  const input = fetchInput(repo, args.issue);
  const previous = currentAuditLabel(input.labels, DEFAULT_CONFIG);
  const result = reconcile(input);
  const summary = '#' + args.issue + ': ' + result.action +
    (result.label ? ' -> ' + result.label : '') + ' - ' + result.reason;

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  // Workflow publikuje komentarz-znacznik wyłącznie na przejściu
  // „rozstrzygnięte → pending”; sam marker nie jest źródłem prawdy.
  if (process.env.GITHUB_OUTPUT) {
    const lines = ['action=' + result.action, 'label=' + result.label, 'previous=' + previous, ''];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n'));
  }
  if (!args.dryRun) apply(repo, args.issue, result, input.labels, DEFAULT_CONFIG);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  reconcile,
  inScope,
  parseCommand,
  latestDecision,
  revisionBarrier,
  lastScopeEntryAt,
  auditLabelsPresent,
  currentAuditLabel,
  DEFAULT_CONFIG,
  AUDIT_PENDING,
  AUDIT_OK,
  AUDIT_CHANGES
};
