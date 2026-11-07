'use strict';

/**
 * Odczyt stanu issue dla bramki audytu (#139, #231).
 *
 * Stan jest autorytatywny w chwili wykonania, nigdy z payloadu zdarzenia.
 * Dwa źródła, bo żadne nie ma wszystkiego:
 *   - REST: treść i `performed_via_github_app` issue oraz komentarzy (GraphQL
 *     tego pola nie ma), a przy komentarzach autor i data utworzenia;
 *   - GraphQL: bariera rewizji (`userContentEdits`), `lastEditedAt` komentarzy,
 *     oś czasu etykiet i etykiety repozytorium.
 * Komentarze z obu źródeł łączy identyfikator (`id` w REST to `databaseId`
 * w GraphQL). Każdą kolekcję stronicujemy do końca, osobno: najnowsza komenda
 * bywa daleko poza pierwszą stroną, historia etykiet decyduje o objęciu
 * bramką, a wspólna pętla dla niezależnych kursorów duplikuje wyniki tej
 * kolekcji, która skończyła się wcześniej.
 */

// Moduł, nie rozpakowana funkcja: test podstawia `execFileSync` bez sieci.
const childProcess = require('child_process');

// Wartość `lastEditedAt`, gdy nie wiadomo, czy komentarz edytowano. Traktujemy
// ją jak edycję (fail-closed): komentarz, którego nie ma w odpowiedzi GraphQL,
// nie może być werdyktem.
const EDIT_UNKNOWN = 'unknown';

// `userContentEdits` zwraca edycje OD NAJNOWSZEJ, więc najnowszą daje
// `first: 1`, a `last: 1` - najstarszą (sprawdzone na #139: first:3 → 06:13,
// 06:13, 06:13; last:3 → 05:10, 04:55, 04:46).
const ISSUE_QUERY = `
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

const COMMENTS_QUERY = `
  query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      issue(number:$number) {
        comments(first:100, after:$cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { databaseId lastEditedAt }
        }
      }
    }
  }`;

const TIMELINE_QUERY = `
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

// Etykiety istniejące w repozytorium (#211): z tabeli „Triage” nakładamy tylko
// takie, a `gh issue edit --add-label` na nieznanej kończy się błędem.
const REPO_LABELS_QUERY = `
  query($owner:String!, $name:String!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      labels(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }`;

/** Uruchamia `gh` i zwraca standardowe wyjście; błąd `gh` przerywa przebieg. */
function run(args) {
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Bariera rewizji: czas ostatniej edycji TREŚCI. Issue nigdy nieedytowana nie ma
 * wpisu w `userContentEdits` - wtedy barierą jest moment utworzenia; brak issue
 * daje pustą barierę, a ta wyłącza zapis (fail-closed).
 */
function revisionBarrier(issueNode) {
  const edited = issueNode?.userContentEdits?.nodes?.[0]?.editedAt;
  return edited || issueNode?.createdAt || '';
}

/** Zapytania GraphQL o jedno issue i o repozytorium, przez podany `gh`. */
function graphqlReader(repo, issue, gh) {
  const [owner, name] = repo.split('/');
  const ask = (query, cursor, scoped) => {
    const args = ['api', 'graphql', '-f', 'query=' + query, '-F', 'owner=' + owner, '-F', 'name=' + name];
    if (scoped) args.push('-F', 'number=' + issue);
    // Kursor jako surowy napis (-f): -F rzutowałby wartość wyglądającą na liczbę.
    if (cursor) args.push('-f', 'cursor=' + cursor);
    return JSON.parse(gh(args)).data.repository;
  };
  const scope = (repository, scoped) => {
    if (!scoped) return repository;
    if (!repository.issue) throw new Error('Nie znaleziono issue #' + issue + ' w ' + repo);
    return repository.issue;
  };
  const collect = (query, field, scoped) => {
    const all = [];
    let cursor = null;
    for (;;) {
      const page = scope(ask(query, cursor, scoped), scoped)[field];
      all.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return all;
      cursor = page.pageInfo.endCursor;
    }
  };
  return { issueNode: () => scope(ask(ISSUE_QUERY, null, true), true), collect };
}

/** Nazwa aplikacji, przez którą powstał wpis; '' dla `gh` albo przeglądarki. */
function appName(entry) {
  return (entry.performed_via_github_app || {}).name || '';
}

/** Komentarze REST ze znacznikiem edycji z GraphQL; brak znacznika = nieznany. */
function mergeComments(restPages, editedById) {
  return [].concat(...restPages).map(comment => ({
    body: comment.body || '',
    authorAssociation: comment.author_association || '',
    createdAt: comment.created_at || '',
    app: appName(comment),
    lastEditedAt: editedById.has(comment.id) ? editedById.get(comment.id) : EDIT_UNKNOWN
  }));
}

/** Zdarzenie osi czasu etykiet w kształcie, który czyta `lastScopeEntryAt`. */
function labelEvent(node) {
  return {
    type: node.__typename === 'LabeledEvent' ? 'LABELED' : 'UNLABELED',
    label: node.label ? node.label.name : '',
    createdAt: node.createdAt
  };
}

/**
 * Stan issue w chwili wykonania, w kształcie wejścia `reconcileIssue()`.
 * `gh(args)` zwraca standardowe wyjście polecenia jako napis.
 */
function fetchInput(repo, issue, gh = run) {
  const graphql = graphqlReader(repo, issue, gh);
  const issueNode = graphql.issueNode();
  const edited = new Map(graphql.collect(COMMENTS_QUERY, 'comments', true).map(node => [node.databaseId, node.lastEditedAt]));
  const labelEvents = graphql.collect(TIMELINE_QUERY, 'timelineItems', true).map(labelEvent);
  const repoLabels = graphql.collect(REPO_LABELS_QUERY, 'labels', false).map(label => label.name);
  const rest = JSON.parse(gh(['api', 'repos/' + repo + '/issues/' + issue]));
  const restComments = JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/' + repo + '/issues/' + issue + '/comments?per_page=100']));

  return {
    state: String(issueNode.state || '').toLowerCase(),
    labels: issueNode.labels.nodes.map(label => label.name),
    createdAt: String(issueNode.createdAt || ''),
    bodyHtml: String(issueNode.bodyHTML || ''),
    body: rest.body || '',
    app: appName(rest),
    barrier: revisionBarrier(issueNode),
    comments: mergeComments(restComments, edited),
    labelEvents: labelEvents,
    repoLabels: repoLabels
  };
}

module.exports = { fetchInput, revisionBarrier, run, EDIT_UNKNOWN };
