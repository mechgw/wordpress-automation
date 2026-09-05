# GitHub label taxonomy

`labels.json` is the declarative source of truth for labels managed by this repository. The model follows the same governance pattern as `system.produkcja`, but keeps only the families that are useful here.

The **Sync GitHub labels** Action reconciles names, colors and descriptions after the manifest reaches `main`, and can also be run manually. It is intentionally non-destructive: labels outside the manifest are left alone. Explicit one-time removals live under `migrations.delete`.

## Classification rules

| Family | Rule | Meaning |
| --- | --- | --- |
| Priority `P0`–`P4` | exactly 1 per open Issue | Business/operational order of work. |
| Risk `T1`–`T3` | exactly 1 when work can change production behaviour | Cost/risk of getting the change wrong, not implementation effort. |
| `area:*` | 1 or more | Where the work belongs. |
| State | 0 or more | `blocked`, `needs-triage`, `monitoring`. |
| Change type | 0 or more | Compatible with Release Drafter / Conventional Commits. |
| `policy:*` | 0 or more | Cross-cutting invariant or policy affected by the work. |

Priority and risk are independent. A tiny but urgent production defect can be `P0` + `T1`; a large security-sensitive refactor can be `P2` + `T3`.

Priority lives in the label, not in the Issue title. After migration, do not prefix titles with `[P0]`, `[P1]`, etc.; duplicating the value in the title would create two sources of truth that can drift apart.

## Color semantics

The colors are deliberately consistent with the established taxonomy in `system.produkcja`:

- warm colors — urgency (`P0` → `P2`);
- grey — low priority / monitoring;
- cool blue/indigo — risk tiers;
- near-black — blocked;
- green — every `area:*` label;
- purple — every `policy:*` label.

The color is only a visual cue. The label name and description always carry the meaning.

## Areas

The initial closed set is:

- `area:wordpress`
- `area:seo`
- `area:analytics`
- `area:gsc`
- `area:ga4`
- `area:forminator`
- `area:apps-script`
- `area:github`
- `area:tests`
- `area:security`

Add a new area only when an existing area would make filtering misleading. Do not create ad-hoc labels directly in the GitHub UI; change `labels.json` in a reviewed PR.

## Typical examples

A WordPress route-layout defect that is currently blocking correct production rendering:

`P0` · `T2` · `bug` · `area:wordpress` · `area:seo`

A post-deployment SEO measurement task waiting for enough data:

`P1` · `T1` · `monitoring` · `area:seo` · `area:analytics` · `area:gsc`

A CI or repository-governance improvement:

`P2` · `T1` · `chore` · `area:github` · `area:tests`

## Changing the taxonomy

1. Edit `.github/labels.json` in a branch.
2. Run `npm test`; `test/labels.test.js` validates the manifest contract.
3. Open a PR and follow the normal review gate.
4. After merge, **Sync GitHub labels** applies the reviewed state to the repository.

Do not enable implicit pruning. Label deletion is a migration and must be named explicitly so the audit trail explains why it disappeared.
