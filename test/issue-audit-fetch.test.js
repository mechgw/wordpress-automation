'use strict';

/**
 * #231: odczyt stanu issue dla bramki audytu.
 *
 * REST daje to, czego nie ma GraphQL (`performed_via_github_app` issue i
 * komentarzy), GraphQL daje barierę rewizji, znacznik edycji komentarza, oś
 * czasu etykiet i etykiety repozytorium. Testy podstawiają `gh`, więc nic nie
 * wychodzi do sieci; sprawdzają, że dane obu źródeł zostają połączone po
 * identyfikatorze komentarza, a brak danych o edycji nie wygląda na brak edycji.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { fetchInput } = require('../scripts/quality/issue-audit-fetch.js');

const REPO = 'owner/name';

/** Zbiera `-f`/`-F klucz=wartość` z wywołania `gh api graphql`. */
function variables(args) {
  const vars = {};
  args.forEach((arg, i) => {
    if ((arg === '-f' || arg === '-F') && args[i + 1].includes('=')) {
      const text = args[i + 1];
      vars[text.slice(0, text.indexOf('='))] = { value: text.slice(text.indexOf('=') + 1), flag: arg };
    }
  });
  return vars;
}

/**
 * Atrapa `gh`: odpowiada na zapytania REST i GraphQL zadanymi danymi i zapisuje
 * wywołania. `data.commentPages`, `data.timelinePages`, `data.labelPages` to
 * listy stron GraphQL (po jednej odpowiedzi na kursor).
 */
function fakeGh(data) {
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] !== 'api') throw new Error('nieoczekiwane wywołanie: ' + args.join(' '));
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: graphql(args) } });
    if (args[1] === `repos/${REPO}/issues/${data.number}`) return JSON.stringify(data.rest);
    if (args.includes('--paginate') && args.includes('--slurp') &&
        args[args.length - 1] === `repos/${REPO}/issues/${data.number}/comments?per_page=100`) {
      return JSON.stringify(data.restCommentPages);
    }
    throw new Error('nieoczekiwane wywołanie: ' + args.join(' '));
  };

  function page(pages, cursor) {
    const index = cursor ? Number(cursor.value.replace('cursor-', '')) : 0;
    const last = index === pages.length - 1;
    return { pageInfo: { hasNextPage: !last, endCursor: last ? null : 'cursor-' + (index + 1) }, nodes: pages[index] };
  }

  function graphql(args) {
    const query = args.find(arg => arg.startsWith('query=')) || '';
    const vars = variables(args);
    if (query.includes('userContentEdits')) return { issue: data.issueNode === undefined ? defaultIssueNode : data.issueNode };
    if (query.includes('comments(first')) return { issue: { comments: page(data.commentPages, vars.cursor) } };
    if (query.includes('timelineItems')) return { issue: { timelineItems: page(data.timelinePages, vars.cursor) } };
    if (query.includes('labels(first') && !query.includes('issue(')) return { labels: page(data.labelPages, vars.cursor) };
    throw new Error('nieoczekiwane zapytanie: ' + query);
  }

  const defaultIssueNode = {
    state: 'OPEN',
    createdAt: '2026-10-01T10:00:00Z',
    bodyHTML: '<h2>Triage</h2>',
    labels: { nodes: [{ name: 'P2' }, { name: 'by:agent' }] },
    userContentEdits: { nodes: [{ editedAt: '2026-10-02T10:00:00Z' }, { editedAt: '2026-10-01T11:00:00Z' }] }
  };
  return { gh, calls };
}

const baseData = (over = {}) => Object.assign({
  number: 7,
  rest: { body: 'Treść.\n\n_— Claude Code (agent lokalny)_', performed_via_github_app: null },
  restCommentPages: [[]],
  commentPages: [[]],
  timelinePages: [[]],
  labelPages: [[{ name: 'P2' }, { name: 'needs-triage' }]]
}, over);

describe('#231 fetchInput: dane REST i GraphQL w jednym stanie', () => {
  test('łączy issue, komentarze, oś czasu i etykiety repozytorium', () => {
    const { gh } = fakeGh(baseData({
      rest: { body: 'Treść.', performed_via_github_app: { name: 'ChatGPT Codex Connector' } },
      restCommentPages: [[
        { id: 11, body: '/audit-ok', author_association: 'MEMBER', created_at: '2026-10-03T10:00:00Z', performed_via_github_app: { name: 'ChatGPT Codex Connector' } },
        { id: 12, body: 'x', author_association: 'NONE', created_at: '2026-10-03T11:00:00Z', performed_via_github_app: null }
      ]],
      commentPages: [[{ databaseId: 11, lastEditedAt: null }, { databaseId: 12, lastEditedAt: '2026-10-03T12:00:00Z' }]],
      timelinePages: [[
        { __typename: 'LabeledEvent', createdAt: '2026-10-01T10:00:00Z', label: { name: 'P2' } },
        { __typename: 'UnlabeledEvent', createdAt: '2026-10-01T11:00:00Z', label: { name: 'T1' } }
      ]]
    }));
    assert.deepEqual(fetchInput(REPO, '7', gh), {
      state: 'open',
      labels: ['P2', 'by:agent'],
      createdAt: '2026-10-01T10:00:00Z',
      bodyHtml: '<h2>Triage</h2>',
      body: 'Treść.',
      app: 'ChatGPT Codex Connector',
      barrier: '2026-10-02T10:00:00Z',
      comments: [
        { body: '/audit-ok', authorAssociation: 'MEMBER', createdAt: '2026-10-03T10:00:00Z', app: 'ChatGPT Codex Connector', lastEditedAt: null },
        { body: 'x', authorAssociation: 'NONE', createdAt: '2026-10-03T11:00:00Z', app: '', lastEditedAt: '2026-10-03T12:00:00Z' }
      ],
      labelEvents: [
        { type: 'LABELED', label: 'P2', createdAt: '2026-10-01T10:00:00Z' },
        { type: 'UNLABELED', label: 'T1', createdAt: '2026-10-01T11:00:00Z' }
      ],
      repoLabels: ['P2', 'needs-triage']
    });
  });

  test('issue utworzona przez gh i bez treści: aplikacja i treść to puste napisy', () => {
    const { gh } = fakeGh(baseData({ rest: { body: null, performed_via_github_app: null } }));
    const input = fetchInput(REPO, '7', gh);
    assert.equal(input.app, '');
    assert.equal(input.body, '');
  });

  test('komentarz nieobecny w odpowiedzi GraphQL ma nieznany stan edycji (fail-closed)', () => {
    const { gh } = fakeGh(baseData({
      restCommentPages: [[{ id: 21, body: '/audit-ok', author_association: 'OWNER', created_at: '2026-10-03T10:00:00Z' }]],
      commentPages: [[{ databaseId: 99, lastEditedAt: null }]]
    }));
    const [comment] = fetchInput(REPO, '7', gh).comments;
    assert.equal(comment.lastEditedAt, 'unknown');
    assert.equal(comment.app, '', 'brak pola aplikacji to brak aplikacji');
    assert.equal(comment.authorAssociation, 'OWNER');
  });

  test('brakujące pola komentarza REST to puste napisy, nie undefined', () => {
    const { gh } = fakeGh(baseData({ restCommentPages: [[{ id: 31 }]], commentPages: [[{ databaseId: 31, lastEditedAt: null }]] }));
    assert.deepEqual(fetchInput(REPO, '7', gh).comments, [
      { body: '', authorAssociation: '', createdAt: '', app: '', lastEditedAt: null }
    ]);
  });

  test('bariera: bez edycji treści jest nią createdAt, a stan issue jest zapisany małymi literami', () => {
    const { gh } = fakeGh(baseData({
      issueNode: { state: 'CLOSED', createdAt: '2026-10-01T10:00:00Z', bodyHTML: null, labels: { nodes: [] }, userContentEdits: { nodes: [] } }
    }));
    const input = fetchInput(REPO, '7', gh);
    assert.equal(input.barrier, '2026-10-01T10:00:00Z');
    assert.equal(input.state, 'closed');
    assert.equal(input.bodyHtml, '');
    assert.deepEqual(input.labels, []);
  });

  test('zdarzenie osi czasu ze skasowaną etykietą nie ma nazwy', () => {
    const { gh } = fakeGh(baseData({ timelinePages: [[{ __typename: 'LabeledEvent', createdAt: '2026-10-01T10:00:00Z', label: null }]] }));
    assert.deepEqual(fetchInput(REPO, '7', gh).labelEvents, [{ type: 'LABELED', label: '', createdAt: '2026-10-01T10:00:00Z' }]);
  });

  test('nie znaleziono issue - błąd z numerem i repozytorium', () => {
    const { gh } = fakeGh(baseData({ issueNode: null }));
    assert.throws(() => fetchInput(REPO, '7', gh), /Nie znaleziono issue #7 w owner\/name/);
  });
});

describe('#231 fetchInput: stronicowanie każdej kolekcji osobno', () => {
  test('komentarze GraphQL, oś czasu i etykiety repozytorium są czytane do ostatniej strony', () => {
    const { gh, calls } = fakeGh(baseData({
      restCommentPages: [[{ id: 1, body: 'a', author_association: 'OWNER', created_at: '2026-10-03T10:00:00Z' }],
        [{ id: 2, body: 'b', author_association: 'OWNER', created_at: '2026-10-03T11:00:00Z' }]],
      commentPages: [[{ databaseId: 1, lastEditedAt: null }], [{ databaseId: 2, lastEditedAt: '2026-10-04T00:00:00Z' }]],
      timelinePages: [[{ __typename: 'LabeledEvent', createdAt: '2026-10-01T10:00:00Z', label: { name: 'A' } }],
        [{ __typename: 'LabeledEvent', createdAt: '2026-10-01T11:00:00Z', label: { name: 'B' } }],
        [{ __typename: 'UnlabeledEvent', createdAt: '2026-10-01T12:00:00Z', label: { name: 'A' } }]],
      labelPages: [[{ name: 'x' }], [{ name: 'y' }]]
    }));
    const input = fetchInput(REPO, '7', gh);
    assert.deepEqual(input.comments.map(c => [c.body, c.lastEditedAt]), [['a', null], ['b', '2026-10-04T00:00:00Z']]);
    assert.deepEqual(input.labelEvents.map(e => e.label), ['A', 'B', 'A']);
    assert.deepEqual(input.repoLabels, ['x', 'y']);
    const graphqlCalls = calls.filter(args => args[1] === 'graphql');
    const withCursor = graphqlCalls.map(variables).filter(vars => vars.cursor);
    assert.deepEqual(withCursor.map(vars => vars.cursor.value).sort(), ['cursor-1', 'cursor-1', 'cursor-1', 'cursor-2']);
    assert.ok(withCursor.every(vars => vars.cursor.flag === '-f'), 'kursor jako surowy napis (-f), nie wartość rzutowana przez -F');
  });

  test('zapytania o issue niosą numer jako -F number, a zapytanie o etykiety repozytorium go nie niesie', () => {
    const { gh, calls } = fakeGh(baseData());
    fetchInput(REPO, '7', gh);
    const graphqlCalls = calls.filter(args => args[1] === 'graphql');
    assert.equal(graphqlCalls.length, 4, 'issue, komentarze, oś czasu, etykiety repozytorium');
    for (const args of graphqlCalls) {
      const vars = variables(args);
      assert.deepEqual([vars.owner.value, vars.name.value], ['owner', 'name']);
      const isRepoLabels = args.find(arg => arg.startsWith('query=')).includes('labels(first') && !args.find(arg => arg.startsWith('query=')).includes('issue(');
      assert.equal(Boolean(vars.number), !isRepoLabels, args.find(arg => arg.startsWith('query=')).slice(0, 40));
      if (vars.number) assert.deepEqual(vars.number, { value: '7', flag: '-F' });
    }
  });

  test('REST dla komentarzy jest stronicowany i spłaszczany przez --paginate --slurp', () => {
    const { gh, calls } = fakeGh(baseData());
    fetchInput(REPO, '7', gh);
    const rest = calls.filter(args => args[1] !== 'graphql');
    assert.deepEqual(rest.map(args => args[args.length - 1]).sort(),
      [`repos/${REPO}/issues/7`, `repos/${REPO}/issues/7/comments?per_page=100`].sort());
    const comments = rest.find(args => args[args.length - 1].includes('/comments'));
    assert.ok(comments.includes('--paginate') && comments.includes('--slurp'));
  });
});

describe('#231 fetchInput: kształt wywołań i dane brakujące', () => {
  test('zapytanie GraphQL idzie jako -f query (surowy napis), a repozytorium i numer jako -F', () => {
    const { gh, calls } = fakeGh(baseData());
    fetchInput(REPO, '7', gh);
    for (const args of calls.filter(call => call[1] === 'graphql')) {
      assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f']);
      assert.ok(args[3].startsWith('query='), args[3].slice(0, 20));
      assert.deepEqual(args.slice(4, 8), ['-F', 'owner=owner', '-F', 'name=name']);
    }
  });

  test('issue bez stanu i daty utworzenia daje puste napisy, nie „undefined”', () => {
    const { gh } = fakeGh(baseData({ issueNode: { labels: { nodes: [] }, userContentEdits: { nodes: [] } } }));
    const input = fetchInput(REPO, '7', gh);
    assert.equal(input.state, '');
    assert.equal(input.createdAt, '');
    assert.equal(input.barrier, '');
    assert.equal(input.bodyHtml, '');
  });
});

describe('#231 run: uruchomienie gh', () => {
  const childProcess = require('child_process');
  const { run } = require('../scripts/quality/issue-audit-fetch.js');

  test('wywołuje gh z argumentami, wyjściem tekstowym i dużym buforem', () => {
    const original = childProcess.execFileSync;
    const seen = [];
    childProcess.execFileSync = (...call) => { seen.push(call); return 'wynik'; };
    try {
      assert.equal(run(['api', 'x']), 'wynik');
    } finally {
      childProcess.execFileSync = original;
    }
    assert.deepEqual(seen, [['gh', ['api', 'x'], { encoding: 'utf8', maxBuffer: 33554432 }]]);
  });

  test('błąd gh przerywa przebieg zamiast zwracać puste dane', () => {
    const original = childProcess.execFileSync;
    childProcess.execFileSync = () => { throw new Error('gh: brak autoryzacji'); };
    try {
      assert.throws(() => run(['api', 'x']), /brak autoryzacji/);
    } finally {
      childProcess.execFileSync = original;
    }
  });
});

describe('#231 revisionBarrier: brakujące pola nie wywracają odczytu', () => {
  const { revisionBarrier } = require('../scripts/quality/issue-audit-fetch.js');
  const CREATED = '2026-10-01T10:00:00Z';

  test('edycje bez listy węzłów albo z węzłem bez daty cofają się do utworzenia issue', () => {
    assert.equal(revisionBarrier({ createdAt: CREATED, userContentEdits: {} }), CREATED);
    assert.equal(revisionBarrier({ createdAt: CREATED, userContentEdits: { nodes: [{}] } }), CREATED);
    assert.equal(revisionBarrier({ createdAt: CREATED, userContentEdits: null }), CREATED);
  });

  test('najnowsza edycja wygrywa z utworzeniem; brak issue to pusta bariera', () => {
    assert.equal(revisionBarrier({ createdAt: CREATED, userContentEdits: { nodes: [{ editedAt: '2026-10-02T10:00:00Z' }] } }), '2026-10-02T10:00:00Z');
    assert.equal(revisionBarrier(undefined), '');
    assert.equal(revisionBarrier({}), '');
  });
});
