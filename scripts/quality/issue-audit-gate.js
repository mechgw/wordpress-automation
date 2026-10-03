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
 * Triage (#211). Issue bez etykiet triage'u była dla bramki niewidoczna, więc
 * ten sam reconciler pilnuje też ich: brakujące etykiety wymaganych rodzin
 * bierze z tabeli w sekcji `## Triage` treści (czytanej z HTML-a, który
 * renderuje GitHub: `bodyHTML`), a gdy to nie wystarcza, nakłada
 * `needs-triage`. Stan audytu liczy w tym samym przebiegu, już z nowymi
 * etykietami: zapis z `GITHUB_TOKEN` nie uruchamia kolejnego runu workflow,
 * więc „następny przebieg” by nie nadszedł.
 *
 * Moduł eksportuje czyste funkcje `reconcile()`, `reconcileTriage()`
 * i `reconcileIssue()` (testowane jednostkowo) oraz tryb CLI, który pobiera dane
 * przez `gh` i nakłada etykiety:
 *   node scripts/quality/issue-audit-gate.js --issue <numer> [--repo owner/name]
 *     [--gate-active-since <ISO>] [--triage-active-since <ISO>]
 *     [--triage-required <rodziny>] [--dry-run]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const AUDIT_PENDING = 'audit:pending';
const AUDIT_OK = 'audit:ok';
const AUDIT_CHANGES = 'audit:changes';
const NEEDS_TRIAGE = 'needs-triage';

/**
 * Rodziny etykiet triage'u (#211). `row`: początek pierwszej komórki wiersza
 * tabeli „Triage”; `label`: czy etykieta issue należy do rodziny; `token`:
 * etykieta w komórce z wartością; `single`: rodzina o kardynalności „dokładnie
 * jedna” (dla `area` wystarczy co najmniej jedna).
 *
 * `label` i `token` są rozdzielone celowo. Nazwę `area:*` z tabeli czytamy
 * w całości, do białego znaku albo separatora: wzorzec zawężony do liter i cyfr
 * skracał `area:github_extra` do `area:github` i nakładał inną etykietę niż
 * podana, a już nałożonej etykiety z podkreśleniem nie zaliczał do rodziny
 * (PR #216).
 */
const TRIAGE_FAMILIES = {
  P: { row: 'priorytet', label: /^P[0-4]$/, token: /\bP[0-4]\b/g, single: true },
  T: { row: 'ryzyko', label: /^T[1-3]$/, token: /\bT[1-3]\b/g, single: true },
  area: { row: 'obszar', label: /^area:./, token: /\barea:[^\s|`*,;]+/g, single: false }
};

const DEFAULT_CONFIG = {
  auditLabels: [AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES],
  // Zakres bramki: priorytet P0-P2 ALBO tier T2/T3. Brak P* i T* znaczy
  // „przed triage'em” — od tego jest `needs-triage` (`reconcileTriage`), nie
  // bramka audytu.
  scopeLabels: ['P0', 'P1', 'P2', 'T2', 'T3'],
  // Tak samo jak review-gate.yml:92. To NIE jest literalne sprawdzenie
  // uprawnienia `write`; nazywamy to po imieniu, żeby specyfikacja nie
  // obiecywała czegoś, czego implementacja nie robi.
  commandAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  commandPattern: /^\s*\/audit-(ok|changes)\b/,
  // Bramka nie obejmuje wstecz issue sprzed swojego wdrożenia. Bez tej stałej
  // reconciler wyliczyłby `audit:pending` dla całego archiwum, czyli zrobiłby
  // backfill, którego świadomie nie chcemy.
  //
  // Wartość domyślna dotyczy TEGO repozytorium. Skrypt obsługuje też inne
  // (np. prywatny backlog operacyjny), a każde weszło do bramki innego dnia —
  // tam datę podaje się przez `--gate-active-since` albo
  // `AUDIT_GATE_ACTIVE_SINCE`.
  gateActiveSince: '2026-09-08T00:00:00Z',
  // Rodziny etykiet, które issue musi mieć po triage'u (#211). Własność
  // repozytorium jak data startu: tutaj praktyką jest para P i T, a prywatny
  // backlog wymaga P i area — podaje je przez `--triage-required` albo
  // `AUDIT_TRIAGE_REQUIRED`.
  triageRequired: ['P', 'T'],
  // Triage obejmuje issue utworzone od tej chwili. Osobna data, bo data startu
  // bramki objęłaby wstecz całe archiwum; 2026-09-27 wszystkie otwarte issue
  // dostały triage ręcznie. Inne repozytoria: `--triage-active-since` albo
  // `AUDIT_TRIAGE_ACTIVE_SINCE`.
  triageActiveSince: '2026-09-27T00:00:00Z'
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
 *
 * UWAGA: `userContentEdits` zwraca edycje **od najnowszej**, więc najnowszą daje
 * `first: 1`, a `last: 1` — najstarszą. Pomyłka tutaj jest cicha i groźna:
 * bariera cofa się do pierwszej edycji, przez co spóźniona komenda `/audit-ok`
 * wygląda na nowszą od treści i zostaje przyjęta dla wersji, której nikt nie
 * czytał. Sprawdzone empirycznie na #139 (first:3 → 06:13, 06:13, 06:13;
 * last:3 → 05:10, 04:55, 04:46).
 */
function revisionBarrier(issueNode) {
  const edits = (issueNode && issueNode.userContentEdits && issueNode.userContentEdits.nodes) || [];
  return (edits.length && edits[0].editedAt) || (issueNode && issueNode.createdAt) || '';
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

/** Etykiety issue należące do rodziny triage'u. */
function familyLabels(labels, family) {
  return (labels || []).filter(name => TRIAGE_FAMILIES[family].label.test(String(name)));
}

/** Czy rodzina ma komplet: dokładnie jedna etykieta, a dla `area` co najmniej jedna. */
function familySatisfied(labels, family) {
  const count = familyLabels(labels, family).length;
  return TRIAGE_FAMILIES[family].single ? count === 1 : count >= 1;
}

/**
 * HTML bez atrybutów: każdy znacznik zostaje jako `<nazwa>` albo `</nazwa>`.
 * Wzorzec rozumie cudzysłowy, więc `>` w wartości atrybutu nie kończy znacznika,
 * a dalsze wyrażenia nie muszą się atrybutami przejmować.
 */
function stripAttributes(html) {
  return String(html || '').replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g,
    (match, slash, name) => '<' + slash + name.toLowerCase() + '>');
}

/** Tekst widoczny w kawałku HTML-a: bez znaczników, bez treści przekreślonej, z rozwiniętymi encjami. */
function htmlText(html) {
  return String(html || '')
    // Przekreślenie to wartość wycofana przez autora, nie druga wartość.
    .replace(/<(del|s|strike)>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Wiersze tabel z sekcji „Triage” treści issue, każdy jako lista komórek
 * z samym tekstem; bez sekcji albo bez tabeli — [].
 *
 * Wejściem jest HTML wyrenderowany przez GitHuba (`bodyHTML`), nie Markdown.
 * Kontrakt mówi o TABELI, a o tym, co jest tabelą, decyduje renderer. Wersja
 * czytająca Markdown przeszła cztery rundy recenzji (PR #216) i w każdej
 * wychodził kolejny sposób, w jaki treść niebędąca widoczną tabelą dawała
 * etykiety: przykład w bloku kodu z grawisów, tyld, wcięcia albo `<pre>`,
 * komentarz HTML, linie z `|` bez wiersza separatora, `\|` w komórce. Własny
 * czytnik musiałby powtórzyć CommonMark i GFM; HTML z GitHuba ma te
 * rozstrzygnięcia już w sobie, a tekst i wartości atrybutów są w nim
 * zakodowane encjami, więc znacznik w treści nie udaje struktury.
 *
 * Sekcja zaczyna się od pierwszego nagłówka drugiego poziomu o treści „Triage”
 * i kończy na następnym nagłówku albo linii poziomej. Nierozpoznany kształt
 * HTML-a daje brak wierszy, czyli `needs-triage` (fail-closed).
 */
function triageTableRows(bodyHtml) {
  const html = stripAttributes(bodyHtml);
  const heading = /<h([1-6])>([\s\S]*?)<\/h\1>/g;
  let start = -1;
  for (let match = heading.exec(html); match; match = heading.exec(html)) {
    if (match[1] === '2' && htmlText(match[2]).toLowerCase() === 'triage') {
      start = heading.lastIndex;
      break;
    }
  }
  if (start < 0) return [];
  const rest = html.slice(start);
  const end = rest.search(/<h[1-6]>|<hr>/);
  const section = end < 0 ? rest : rest.slice(0, end);

  const rows = [];
  (section.match(/<table>[\s\S]*?<\/table>/g) || []).forEach(table => {
    (table.match(/<tr>[\s\S]*?<\/tr>/g) || []).forEach(row => {
      const cells = (row.match(/<t[dh]>[\s\S]*?<\/t[dh]>/g) || []).map(htmlText);
      if (cells.length) rows.push(cells);
    });
  });
  return rows;
}

/**
 * Etykieta rodziny zapisana w tabeli „Triage”; '' gdy tabela jej nie rozstrzyga.
 *
 * Wartość czytamy z DRUGIEJ komórki wiersza (kolumna „wartość”), nie z całego
 * wiersza: uzasadnienie w trzeciej potrafi wymieniać inne priorytety. Komórka
 * musi zawierać dokładnie jeden token rodziny — przy zerze albo kilku tabela
 * jest niejednoznaczna i nie zgadujemy.
 */
function triageLabelFromTable(rows, family) {
  const def = TRIAGE_FAMILIES[family];
  const tokens = [];
  rows.forEach(cells => {
    if (String(cells[0] || '').toLowerCase().indexOf(def.row) !== 0) return;
    (String(cells[1] || '').match(def.token) || []).forEach(token => {
      if (!tokens.includes(token)) tokens.push(token);
    });
  });
  return tokens.length === 1 ? tokens[0] : '';
}

/**
 * Triage issue (#211): etykiety do nałożenia i zdjęcia, bez dotykania audytu.
 *
 * Zasady, których nie wolno „uprościć”:
 *   1. istniejących etykiet nie nadpisujemy i nie usuwamy — po triage'u źródłem
 *      prawdy są etykiety, tabela jest tylko propozycją autora;
 *   2. z tabeli uzupełniamy wyłącznie rodzinę WYMAGANĄ, której issue nie ma
 *      wcale; rodzina z dwiema etykietami zostaje do poprawienia człowiekowi;
 *   3. nakładamy tylko etykiety istniejące w repozytorium (`repoLabels`) —
 *      nieznanej nie tworzymy, a brak listy to brak zapisu (fail-closed);
 *   4. bez komentarzy: anulowany przebieg mógłby komentarz zdublować albo
 *      zgubić, a etykietę kolejny przebieg koryguje.
 *
 * @param {object} input
 * @param {string}   input.state        'open' | 'closed'
 * @param {string[]} input.labels       aktualne etykiety issue
 * @param {string}   input.createdAt    ISO: utworzenie issue
 * @param {string}   input.bodyHtml     treść issue wyrenderowana przez GitHuba (`bodyHTML`)
 * @param {string[]} input.repoLabels   etykiety istniejące w repozytorium
 * @param {object}   [config]
 * @returns {{ add: string[], remove: string[], reason: string }}
 */
function reconcileTriage(input, config = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  const none = reason => ({ add: [], remove: [], reason: reason });

  if (input.state !== 'open') return none('issue zamknięta');
  const created = Date.parse(String(input.createdAt || ''));
  if (isNaN(created)) return none('brak daty utworzenia issue (fail-closed)');
  if (created < Date.parse(cfg.triageActiveSince)) return none('issue sprzed startu triage\'u');

  const known = input.repoLabels || [];
  const labels = (input.labels || []).slice();
  const rows = triageTableRows(input.bodyHtml);
  const add = [];
  cfg.triageRequired.forEach(family => {
    if (familyLabels(labels, family).length) return;
    const label = triageLabelFromTable(rows, family);
    if (!label || !known.includes(label)) return;
    add.push(label);
    labels.push(label);
  });

  const missing = cfg.triageRequired.filter(family => !familySatisfied(labels, family));
  const flagged = labels.includes(NEEDS_TRIAGE);
  const remove = [];
  if (missing.length && !flagged && known.includes(NEEDS_TRIAGE)) add.push(NEEDS_TRIAGE);
  if (!missing.length && flagged) remove.push(NEEDS_TRIAGE);

  const fromTable = add.filter(name => name !== NEEDS_TRIAGE);
  const reason = (missing.length ? 'brak triage\'u: ' + missing.join(', ') : 'triage kompletny') +
    (fromTable.length ? '; z tabeli: ' + fromTable.join(', ') : '');
  return { add: add, remove: remove, reason: reason };
}

/**
 * Pełny przebieg: najpierw triage, potem stan audytu wyliczony z etykiet PO
 * triage'u (#211). Etykiety nałożone w tym przebiegu nie mają jeszcze wpisu na
 * osi czasu, więc dopisujemy go z chwilą `now` — inaczej `lastScopeEntryAt()`
 * nie zobaczyłby wejścia w zakres, które właśnie następuje.
 *
 * @returns {{ triage: object, audit: object, labels: string[] }}
 */
function reconcileIssue(input, config = {}, now = new Date().toISOString()) {
  const triage = reconcileTriage(input, config);
  const stamp = String(now).replace(/\.\d+Z$/, 'Z');
  const labels = (input.labels || []).filter(name => !triage.remove.includes(name)).concat(triage.add);
  const labelEvents = (input.labelEvents || [])
    .concat(triage.add.map(label => ({ type: 'LABELED', label: label, createdAt: stamp })))
    .concat(triage.remove.map(label => ({ type: 'UNLABELED', label: label, createdAt: stamp })));
  const audit = reconcile(Object.assign({}, input, { labels: labels, labelEvents: labelEvents }), config);
  return { triage: triage, audit: audit, labels: labels };
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
          bodyHTML
          labels(first:100) { nodes { name } }
          userContentEdits(first:1) { nodes { editedAt } }
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

  const askRepository = (query, cursor, withIssue) => {
    const args = ['api', 'graphql', '-f', 'query=' + query, '-F', 'owner=' + owner, '-F', 'name=' + name];
    if (withIssue) args.push('-F', 'number=' + issue);
    if (cursor) args.push('-F', 'cursor=' + cursor);
    return JSON.parse(gh(args)).data.repository;
  };

  const ask = (query, cursor) => {
    const node = askRepository(query, cursor, true).issue;
    if (!node) throw new Error('Nie znaleziono issue #' + issue + ' w ' + repo);
    return node;
  };

  const collect = (query, field, source) => {
    const all = [];
    let cursor = null;
    for (;;) {
      const page = (source || ask)(query, cursor)[field];
      all.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return all;
      cursor = page.pageInfo.endCursor;
    }
  };

  // Etykiety istniejące w repozytorium (#211): z tabeli „Triage” nakładamy tylko
  // takie, a `gh issue edit --add-label` na nieznanej kończy się błędem.
  const repoLabelsQuery = `
    query($owner:String!, $name:String!, $cursor:String) {
      repository(owner:$owner, name:$name) {
        labels(first:100, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name }
        }
      }
    }`;

  const issueNode = ask(issueQuery, null);
  const comments = collect(commentsQuery, 'comments');
  const labelEvents = collect(timelineQuery, 'timelineItems').map(node => ({
    type: node.__typename === 'LabeledEvent' ? 'LABELED' : 'UNLABELED',
    label: node.label && node.label.name,
    createdAt: node.createdAt
  }));
  const repoLabels = collect(repoLabelsQuery, 'labels', (query, cursor) => askRepository(query, cursor, false))
    .map(l => l.name);

  return {
    state: String(issueNode.state || '').toLowerCase(),
    labels: issueNode.labels.nodes.map(l => l.name),
    createdAt: String(issueNode.createdAt || ''),
    bodyHtml: String(issueNode.bodyHTML || ''),
    barrier: revisionBarrier(issueNode),
    comments: comments,
    labelEvents: labelEvents,
    repoLabels: repoLabels
  };
}

/**
 * Etykiety do dodania i zdjęcia dla całego przebiegu: triage i stan audytu
 * razem, żeby poszły jednym zapisem. `current` to etykiety issue sprzed
 * przebiegu — zdejmujemy tylko faktycznie obecne, bo `gh issue edit
 * --remove-label` na nieistniejącej etykiecie kończy się błędem.
 */
function labelChanges(outcome, current, cfg) {
  const add = outcome.triage.add.slice();
  const remove = outcome.triage.remove.slice();
  if (outcome.audit.action !== 'none') {
    if (outcome.audit.label) add.push(outcome.audit.label);
    cfg.auditLabels
      .filter(name => name !== outcome.audit.label)
      .filter(name => (current || []).includes(name))
      .forEach(name => remove.push(name));
  }
  return { add: add, remove: remove };
}

function apply(repo, issue, changes) {
  if (!changes.add.length && !changes.remove.length) return;
  const args = ['issue', 'edit', String(issue), '--repo', repo];
  changes.add.forEach(name => args.push('--add-label', name));
  changes.remove.forEach(name => args.push('--remove-label', name));
  gh(args);
}

/** Błąd konfiguracji: komunikat dla Actions i kod 2, bez żadnego zapisu. */
function configError(message) {
  console.error('::error::' + message);
  process.exit(2);
}

/**
 * Data startu z flagi albo zmiennej środowiskowej jako ISO; '' gdy nie podano.
 *
 * Data startu jest własnością repozytorium, nie skryptu: ten sam skrypt
 * obsługuje kilka repozytoriów, a każde weszło do bramki innego dnia. Zła
 * wartość cofa moment startu i robi cichy backfill całego archiwum, dlatego
 * niepoprawną odrzucamy, zamiast po cichu wracać do domyślnej.
 */
function parseSince(flag, given, raw) {
  const since = String(raw || '');
  // Podana flaga bez wartości albo z pustą wartością to najgroźniejszy przypadek:
  // w workflow `--gate-active-since "$GATE_ACTIVE_SINCE"` z niezdefiniowaną
  // zmienną przekazuje pusty argument. Milczące zejście do wartości domyślnej
  // cofnęłoby moment startu i objęło całe archiwum — dlatego brak wartości jest
  // błędem, nie sygnałem „użyj domyślnej”.
  if (given && !since.trim()) configError(flag + ' podano bez wartości; nie zgaduję daty startu.');
  if (!since) return '';

  // `new Date()` jest zbyt pobłażliwe, żeby użyć go jako walidacji.
  // Zmierzone w Node 24: '0' → 1999-12-31, '2026' → 2026-01-01, a '2026-02-30'
  // (także w pełnej formie z 'Z') → 2026-03-02. Każdy z tych wariantów cofa
  // moment startu i po cichu obejmuje archiwum, czyli robi dokładnie to, czemu
  // ten parametr ma zapobiegać. Stąd format wymuszony wzorcem, a potem
  // sprawdzenie, że data w ogóle istnieje w kalendarzu.
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (!shape.test(since)) {
    configError(flag + ' musi mieć postać RRRR-MM-DDTGG:MM:SSZ (UTC); otrzymano: ' + since);
  }
  const parsed = new Date(since);
  // Round-trip wyłapuje daty poprawne co do kształtu, a nieistniejące:
  // '2026-02-30T00:00:00Z' przechodzi wzorzec, ale wraca jako 2 marca.
  if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== since.slice(0, 19)) {
    configError(flag + ' wskazuje datę, która nie istnieje: ' + since);
  }
  return parsed.toISOString();
}

/**
 * Lista wymaganych rodzin triage'u (#211); null gdy nie podano. Niepoprawna
 * wartość jest błędem jak niepoprawna data: zejście do domyślnej `P,T`
 * nałożyłoby w drugim repozytorium `needs-triage` na issue, które wg jego
 * zasad mają komplet.
 */
function parseTriageRequired(flag, given, raw) {
  const value = String(raw || '');
  if (given && !value.trim()) configError(flag + ' podano bez wartości; nie zgaduję wymaganych rodzin.');
  if (!value) return null;
  const names = value.split(',').map(name => name.trim());
  const valid = names.every(name => Object.prototype.hasOwnProperty.call(TRIAGE_FAMILIES, name)) &&
    new Set(names).size === names.length;
  if (!valid) {
    configError(flag + ' przyjmuje rodziny ' + Object.keys(TRIAGE_FAMILIES).join(', ') +
      ' oddzielone przecinkami, bez powtórzeń; otrzymano: ' + value);
  }
  return names;
}

function main(argv) {
  const args = {};
  const given = {};
  const valueFlags = {
    '--issue': 'issue',
    '--repo': 'repo',
    '--gate-active-since': 'gateActiveSince',
    '--triage-active-since': 'triageActiveSince',
    '--triage-required': 'triageRequired'
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (valueFlags[argv[i]]) { given[valueFlags[argv[i]]] = true; args[valueFlags[argv[i]]] = argv[++i]; }
  }
  const repo = args.repo || process.env.GITHUB_REPOSITORY;
  if (!args.issue || !repo) {
    console.error('Usage: node scripts/quality/issue-audit-gate.js --issue <number> [--repo owner/name]');
    console.error('         [--gate-active-since <ISO>] [--triage-active-since <ISO>]');
    console.error('         [--triage-required <P,T,area>] [--dry-run]');
    process.exit(2);
  }

  const config = {};
  const gateSince = parseSince('--gate-active-since', given.gateActiveSince,
    given.gateActiveSince ? args.gateActiveSince : process.env.AUDIT_GATE_ACTIVE_SINCE);
  if (gateSince) config.gateActiveSince = gateSince;
  const triageSince = parseSince('--triage-active-since', given.triageActiveSince,
    given.triageActiveSince ? args.triageActiveSince : process.env.AUDIT_TRIAGE_ACTIVE_SINCE);
  if (triageSince) config.triageActiveSince = triageSince;
  const required = parseTriageRequired('--triage-required', given.triageRequired,
    given.triageRequired ? args.triageRequired : process.env.AUDIT_TRIAGE_REQUIRED);
  if (required) config.triageRequired = required;

  const input = fetchInput(repo, args.issue);
  const previous = currentAuditLabel(input.labels, DEFAULT_CONFIG);
  const outcome = reconcileIssue(input, config);
  const result = outcome.audit;
  const changes = labelChanges(outcome, input.labels, DEFAULT_CONFIG);
  const triageDelta = outcome.triage.add.map(name => '+' + name)
    .concat(outcome.triage.remove.map(name => '-' + name)).join(' ') || 'bez zmian';
  const summary = [
    '#' + args.issue + ' triage: ' + triageDelta + ' - ' + outcome.triage.reason,
    '#' + args.issue + ': ' + result.action + (result.label ? ' -> ' + result.label : '') + ' - ' + result.reason
  ].join('\n');

  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  // Workflow publikuje komentarz-znacznik wyłącznie na przejściu
  // „rozstrzygnięte → pending”; sam marker nie jest źródłem prawdy.
  if (process.env.GITHUB_OUTPUT) {
    const lines = ['action=' + result.action, 'label=' + result.label, 'previous=' + previous, ''];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n'));
  }
  if (!args.dryRun) apply(repo, args.issue, changes);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  reconcile,
  reconcileTriage,
  reconcileIssue,
  labelChanges,
  triageTableRows,
  triageLabelFromTable,
  TRIAGE_FAMILIES,
  NEEDS_TRIAGE,
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
