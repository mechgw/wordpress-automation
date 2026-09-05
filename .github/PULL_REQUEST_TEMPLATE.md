<!--
Title: Conventional Commits (feat: / fix: / docs: / chore: / ci: / test: / refactor:), lowercase subject.
Fields that do not apply → "N/A (reason)". Do not leave placeholders.
Standards: docs/quality/testing-standard.md, docs/quality/test-matrix-template.md
-->

## Context

- **Why:** one sentence on the value of this change.
- **Problem:** what is wrong or missing today.
- **Solution:** what changed and how it addresses the problem.
- **Details (optional):** risks, edge cases, decisions.

## Test matrix

<!-- From docs/quality/test-matrix-template.md. Trivial change: scenario table + residual risk. -->

| ID  | Scenario | Criticality | Layer (Unit / Sheet / Runtime) | Test |
| --- | -------- | ----------- | ------------------------------ | ---- |
| T1  |          |             |                                |      |

**Residual risk / deferred:** none, or list with reason and follow-up issue.

## Evidence matrix

<!-- Tick with a short confirmation, or N/A with a reason. -->

- [ ] **Unit (VM):** tests added/updated in `test/`, `npm test` green
- [ ] **Coverage:** changed `*.gs` lines 100% covered (`npm run quality:gate -- --changed=base:origin/main`), per-file thresholds met
- [ ] **Sheet manual test:** which menu item was run and its result, or N/A
- [ ] **Runtime:** drift check / deploy dry run / rollback plan for workflow or deploy changes, or N/A
- [ ] **Security:** credentials, Script Properties, public repo hygiene (no site identity in code), or N/A

**Coverage deficit justification:** none, or the entries added to `.quality/changed-lines-ignore.json` and why.

## Bot reviews

- [ ] Copilot finished; comments read, accepted ones applied, rejected ones answered in-thread
- [ ] `/reviewed` comment posted (turns the `review-ack` check green)

## Links

Fixes: #`<nr>` or Refs: #`<nr>`

## Before merge

- [ ] Title follows the convention
- [ ] `validate`, `secret-scan`, `pr-title`, `review-ack` green
- [ ] Follow-ups listed above or `none`
