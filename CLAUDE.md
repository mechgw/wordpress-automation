# CLAUDE.md

Guidance for AI agents working in this repository. Humans: README.md is the entry point.

## What this is

Google Apps Script project (container-bound to a Google Sheet) automating WordPress, Google Search
Console and GA4 tasks. Sources are the four `*.gs` files plus `appsscript.json`. The repository is
**public**: no company names, domains, ids or credentials in code, comments, tests or fixtures. Site
identity lives in Script Properties (`WP_REST_NAMESPACE`, `SITE_DOMAIN`, `WP_*`).

## Workflow

1. Branch from `main`, PR with a Conventional Commits title.
2. Fill the PR template: test matrix + evidence matrix
   ([docs/quality/test-matrix-template.md](docs/quality/test-matrix-template.md)).
3. Wait for Copilot's review. Read every comment; apply or answer in-thread and resolve the thread.
4. Post a comment starting with `/reviewed` (only owner/collaborators count). This turns the
   `review-ack` check green; a new push or a new bot **review** (review object or inline comment)
   requires a fresh `/reviewed`. Plain bot comments to the PR, such as a usage-limit notice, do not.
5. Merge when `validate`, `secret-scan`, `pr-title`, `review-ack` are green and threads resolved.
6. Publishing the Release Drafter draft deploys the tag to Apps Script after the owner approves the
   `production` environment. Rollback: run *Deploy to Apps Script* with `deploy_ref=<tag>`.

## Quality gates

- `npm run lint` — ESLint for `*.gs` (Apps Script globals + cross-file functions), `test/`, `scripts/`.
- `npm test` — Node unit tests; `.gs` files run in a VM with stubbed Google services
  (`test/helpers/gas.js`).
- `npm run quality:gate -- --changed=base:origin/main` — per-file thresholds
  (`.quality/coverage-policy.json`) and **100% coverage of changed `*.gs` lines**; exceptions with
  reasons in `.quality/changed-lines-ignore.json`.
- Pre-commit hook (`.githooks/pre-commit`, installed by `npm ci`) runs the same on staged files.
- Three checkpoints, always: run tests locally before committing, CI before merge, deploy workflow
  before `clasp push`. Never bypass one to reach the next.
- Standards: [docs/quality/testing-standard.md](docs/quality/testing-standard.md).

## Do / don't

- Do extend the harness stubs rather than registering coverage exceptions.
- Do keep `Version.gs` as placeholders; the deploy workflow stamps it.
- Don't run `clasp push` locally; the deploy workflow is the only path to production.
- Don't touch `.clasp.json` / `.clasprc.json` (git-ignored, credentials).
- Don't lower a coverage threshold without a rationale and a follow-up issue.
