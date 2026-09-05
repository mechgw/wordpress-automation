# wordpress-automation

Google Apps Script automation for WordPress, Google Search Console and Google Analytics 4 workflows.

## Project status

The repository is the canonical source for the Apps Script project. The current production baseline is **v2.8.0**.

Deployment to Google Apps Script is manual but automated: merging into `main` does **not** deploy anything. A maintainer triggers the *Deploy to Apps Script* workflow and approves it in the `production` environment.

## Files

- `appsscript.json` — Apps Script manifest and OAuth scopes.
- `Kod.gs` — shared entry points and Google Search Console integration.
- `GA4.gs` — Google Analytics 4 and Ads-related automation.
- `WordPress.gs` — WordPress REST automation bridge.
- `eslint.config.js` — lint rules with Apps Script services declared as globals.
- `.claspignore` — only `*.gs` and `appsscript.json` are ever pushed to Apps Script.

## Secrets and configuration

Do not commit credentials or API secrets. Runtime credentials belong in Apps Script **Script Properties**.

The WordPress bridge currently expects properties such as:

- `WP_BASE_URL`
- `WP_USERNAME`
- `WP_APP_PASSWORD`
- `WP_ALLOW_WRITES`

`WP_ALLOW_WRITES` should remain disabled unless a write operation is intentionally being performed.

### GitHub repository secrets

The deploy and drift-check workflows need two repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `CLASPRC_JSON` | Full contents of `~/.clasprc.json` after running `clasp login` locally. |
| `APPS_SCRIPT_ID` | The Apps Script project id (Apps Script editor → Project settings → Script ID). |

Rotate `CLASPRC_JSON` by running `clasp login` again and updating the secret.

## Local development

```bash
npm ci
npm run lint
```

To work against the live Apps Script project, install clasp and log in once:

```bash
npm install -g @google/clasp
clasp login
```

Then create a git-ignored `.clasp.json` with the project id:

```json
{ "scriptId": "<script id>", "rootDir": ".", "scriptExtensions": ["gs"] }
```

`scriptExtensions` matters: clasp 3 defaults to `.js`, which would pull the sources as `Kod.js` next to `Kod.gs`.

`clasp status` lists what would be pushed. Do not run `clasp push` locally; use the deploy workflow so every deployment is reviewed and logged.

## Development workflow

`main` is protected: changes land only through pull requests, CI must pass, force-pushes are blocked.

PR titles must follow Conventional Commits (enforced by the *PR title* check). Release Drafter uses the prefix to resolve the next version:

- `feat:` / `new:` — new functionality; minor release.
- `fix:` / `bug:` / `hotfix:` — bug fix; patch release.
- `docs:` — documentation; patch release.
- `chore:` / `refactor:` / `ci:` / `test:` / `style:` — maintenance; patch release.

### CI checks on every PR

- **validate** — manifest is valid JSON, no duplicated `.gs.gs` files, ESLint passes on all `.gs` sources.
- **secret-scan** — Gitleaks scans the full history for committed secrets.
- **pr-title** — title follows the Conventional Commits format above.

Dependabot opens weekly PRs for GitHub Actions and npm dev dependencies.

## Deploying to Apps Script

1. Merge the change into `main` and make sure CI is green.
2. Actions → *Deploy to Apps Script* → *Run workflow*. Optionally tick *create_version* to also record an immutable Apps Script version.
3. Approve the pending `production` deployment. Nothing is pushed until approved.

The workflow runs lint again, prints the files clasp will push, and then runs `clasp push --force` against the script id from the secret.

## Drift check

*Apps Script drift check* runs every Monday (and on demand). It pulls the live project and compares it with `main`. If someone edited code directly in the Apps Script editor, the run fails and attaches a patch with the differences so the change can be brought back into the repository.

## Releases

Release notes are prepared automatically by **Release Drafter**.

- PRs are labelled from their title where possible.
- Merging a PR into `main` refreshes the draft release.
- `feat`/`new` resolve to a minor bump; everything else to a patch bump.

Publish the draft from the Releases page when a deployment is done. The initial baseline is `v2.8.0`; future versions follow Semantic Versioning.

## License

MIT.
