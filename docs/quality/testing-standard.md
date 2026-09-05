# Testing standard

Core standard for tests in this repository: which layers exist, what every test must look like,
what is forbidden, and how the gates enforce it. Companion documents:

- [test-matrix-template.md](test-matrix-template.md) — the matrix filled in before writing tests.
- `.github/PULL_REQUEST_TEMPLATE.md` — where the evidence is recorded.
- `.quality/coverage-policy.json`, `.quality/changed-lines-ignore.json` — the coverage contract.

Adapted from the Laravel `system` repository's testing governance, scaled to a Google Apps Script
project with no database, no UI framework and no browser.

## 1. Layers

| Layer                 | What it is                                                                                       | Runs where                       | Speed   |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- | ------- |
| **Unit (VM)**         | `node --test` loading the `.gs` files into a VM with stubbed Google services (`test/helpers/gas.js`) | locally, pre-commit, CI          | ms      |
| **Sheet manual test** | Menu items *Sprawdź połączenie*, *Test Rank Math bridge*, *Test biblioteki mediów* run in the sheet | by a person, before/after deploy | seconds |
| **Runtime gate**      | Drift check (live project == `main`), deploy workflow (lint, push, immutable version)             | GitHub Actions                   | minutes |

Every layer catches something the others cannot: the VM layer proves logic and contracts, the
sheet test proves credentials and endpoints, the runtime gate proves what is actually deployed.
None of them replaces another.

## 2. Ten operational rules

| #   | Rule                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **One behavior per test.** Several assertions are fine when they describe one outcome; unrelated checks go to separate tests.                            |
| 2   | **State over behavior.** Assert the returned value, the thrown error, the request that would be sent, the sheet cell that would be written. Not "the function was called". |
| 3   | **Matrix first.** Non-trivial change or test-only task: fill the [matrix](test-matrix-template.md) before writing code. Trivial change: a short matrix, but present. |
| 4   | **Changed lines are covered.** 100% of statement lines you add or change in `*.gs` must run under a test. Exceptions go to `.quality/changed-lines-ignore.json` with a reason. |
| 5   | **Ratchet, never regress.** Per-file thresholds in `.quality/coverage-policy.json` only go up. Lowering one needs a rationale and a follow-up issue.     |
| 6   | **Regression mandate.** A bug fix ships with a test that failed before the fix and passes after, plus at least one edge case.                          |
| 7   | **Stubs, not the network.** No real calls to Google, WordPress or GA4 from tests. `UrlFetchApp` is stubbed and the request shape is asserted.           |
| 8   | **No assertion roulette.** A wall of `assert.equal` on unrelated fields is rejected in review. Name the behavior; split the test.                        |
| 9   | **Realm-aware.** Objects and dates crossing the VM boundary are compared via `plain()` and created with `gas.$Date` (see §5).                            |
| 10  | **Pre-commit is the floor, CI is the ceiling.** The hook runs lint, tests and the coverage gate on staged files; CI repeats them against `main`.        |

## 3. Gold standard for every test

- **Name states the behavior**, not the function: `'rejects a namespace with a slash'`, not
  `'getWpConfig_ test 3'`. Suites (`describe`) are named after the source file plus the area.
- **Arrange / Act / Assert** are visually separate. Exactly one action in *Act*.
- **Deterministic**: fixed dates via `new gas.$Date(2026, 8, 5)`, fixed properties, fixed fetch
  responses. Never `new Date()` without control, never real time zones.
- **Isolated**: every test builds its own project with `loadProject({...})`; no shared mutable
  state between tests.
- **Assert the contract the caller sees**: return value, thrown `Error` with its message
  (`assert.throws(fn, /Brak Script Property: X/)`), the `UrlFetchApp` call recorded in
  `gas.$fetchCalls`, the value written through a stubbed sheet range.
- **Error paths are first-class**: missing property, malformed property, non-JSON response, HTTP
  error code. A happy-path-only suite for a function that validates input is incomplete.
- **Assertion diversity for side-effecting functions**: a function that fetches and writes must be
  asserted on both the request and the write, not on one of them.

## 4. Forbidden

- **Tautologies**: asserting the value the test itself just set.
- **"No error" as the only assertion**: `assert.doesNotThrow` alone proves nothing; pair it with an
  outcome.
- **Testing implementation details**: private helper call order, internal variable names.
- **Over-stubbing**: if the result can be asserted directly, do not stub the function producing it.
- **Snapshots of Google API payloads**: assert the fields you rely on.
- **Retries or sleeps inside tests**.
- **Tests that write files into the repository** or leave artifacts (coverage output goes to
  `coverage/`, which is git-ignored).
- **Hardcoded site identity**: no real domains, company names, property ids or credentials in
  fixtures. Use `example.pl`, `acme`, `123456`.

## 5. Harness notes (`test/helpers/gas.js`)

- `loadProject(opts)` runs `Version.gs`, `Kod.gs`, `GA4.gs`, `WordPress.gs` in one VM context, so
  cross-file globals work exactly as in Apps Script.
- Options: `properties` (Script Properties), `sheets` (`{ name: rows }` for `SpreadsheetApp`),
  `fetch` (function returning `{ code, text, headers }`), `skip` / `override` for source files.
- `gas.$fetchCalls` records every `UrlFetchApp.fetch(url, params)`.
- `gas.$Date` is the VM's `Date`; `instanceof Date` checks in the sources fail for host dates.
- `plain(value)` strips the VM prototype so `assert.deepEqual` works on returned objects.
- New source file? Add it to `SOURCES` in the helper, otherwise the coverage gate reports it as
  not loaded.
- Need a Google service the stubs lack? Extend the stub in the helper with the smallest surface
  the test needs, and assert through it (the write to a range, the trigger created).

## 6. Gates

| Gate                          | Where                | What fails it                                                                 |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| Forbidden artifacts           | pre-commit           | `.clasp.json`, `.clasprc.json`, `coverage/`, `node_modules/` staged           |
| ESLint                        | pre-commit, CI       | any lint error in `*.gs`, `test/`, `scripts/`, `eslint.config.js`             |
| Unit tests                    | pre-commit, CI       | any failing test                                                              |
| Per-file coverage             | pre-commit, CI       | a `*.gs` file below its threshold in `.quality/coverage-policy.json`          |
| Changed-lines coverage        | pre-commit (staged), CI (vs `main`) | a changed statement line in `*.gs` with zero hits and no registered exception |
| PR title, secret scan, review-ack | CI               | see README                                                                    |

Run the whole thing by hand:

```bash
npm run quality:gate -- --changed=base:origin/main
```

## 7. Coverage deficit procedure

When a changed line genuinely cannot run in the VM (an Apps Script dialog, trigger installation, a
service the stubs do not model yet):

1. Try the smallest stub extension first. Most "impossible" lines only need a fake range or a fake
   trigger builder.
2. If it is still not worth it in this change, add an entry to
   `.quality/changed-lines-ignore.json` with the exact lines, a reason that names what covers them
   instead (sheet test menu, drift check) and, if a stub is planned, the follow-up issue.
3. Mention the exception in the PR's *Coverage deficit justification* section.
4. Remove the entry when the stubbed test lands. The registry is a queue, not a graveyard.
