# wordpress-automation

Google Apps Script automation for WordPress, Google Search Console and Google Analytics 4 workflows.

## Project status

The repository is the canonical source for the Apps Script project. The current production baseline is prepared as **v2.8.0**.

Runtime deployment to Google Apps Script remains manual for now: merging code into `main` does not automatically deploy it to Apps Script.

## Files

- `appsscript.json` — Apps Script manifest and OAuth scopes.
- `Kod.gs` — shared entry points and Google Search Console integration.
- `GA4.gs` — Google Analytics 4 and Ads-related automation.
- `WordPress.gs` — WordPress REST automation bridge.

## Secrets and configuration

Do not commit credentials or API secrets. Runtime credentials belong in Apps Script **Script Properties**.

The WordPress bridge currently expects properties such as:

- `WP_BASE_URL`
- `WP_USERNAME`
- `WP_APP_PASSWORD`
- `WP_ALLOW_WRITES`

`WP_ALLOW_WRITES` should remain disabled unless a write operation is intentionally being performed.

## Development workflow

`main` represents the production-approved source state.

For non-trivial changes use a branch and pull request. Recommended PR title prefixes:

- `feat:` — new functionality; Release Drafter treats it as a minor release.
- `fix:` / `bug:` / `hotfix:` — bug fix; patch release.
- `docs:` — documentation; patch release.
- `chore:` / `refactor:` / `ci:` / `test:` — maintenance; patch release by default.

GitHub Actions validate the Apps Script manifest, parse-check `.gs` files and scan the repository for accidentally committed secrets.

## Releases

Release notes are prepared automatically by **Release Drafter**, based on the setup used in the companion production repository.

- PRs are automatically labelled from their title where possible.
- Merging a PR into `main` refreshes the draft release.
- `enhancement` resolves to a minor version bump.
- bug fixes and documentation resolve to a patch bump.
- maintenance changes fall back to a patch bump.

The initial baseline is `v2.8.0`. Future versions follow Semantic Versioning.

## License

MIT.
