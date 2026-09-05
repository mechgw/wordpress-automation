# wordpress-automation

Google Apps Script automation for WordPress, Google Search Console and Google Analytics 4 workflows.

## Project status

The repository is the canonical source for the Apps Script project. The current production version is the [latest release](https://github.com/mechgw/wordpress-automation/releases/latest).

Merging into `main` does **not** deploy anything. Publishing a GitHub release triggers the *Deploy to Apps Script* workflow for that tag, and a maintainer approves it in the `production` environment before anything is pushed. The same workflow can also be run by hand against `main`.

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

The approval gate is a repository setting, not something the workflow creates. Settings → Environments → `production` must have **Required reviewers** enabled and deployment branches limited to `main` and `v*` tags. Without that, the deploy workflow would push as soon as it is triggered.

The Google account behind `CLASPRC_JSON` must also have the Apps Script API switched on at <https://script.google.com/home/usersettings>, otherwise `clasp push` fails with "User has not enabled the Apps Script API".

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
- **review-ack** — green only when (1) Copilot code review is not in progress and (2) the bot comments were acknowledged with a `/reviewed` comment.

### Acknowledging bot reviews

1. Wait until Copilot has finished. While it is running it is listed as a requested reviewer and the check stays red. A bot that errors out or hits its usage limit (Codex does this regularly) does not block anything.
2. Read the comments. Fix what is worth fixing, reply to the rest, resolve the threads (required before merge).
3. Post a PR comment that starts with `/reviewed`, followed by a short note on what was accepted and what was rejected. It has to be newer than the last commit and the last bot comment, so a new push or a new bot review means a new `/reviewed`.

The check is re-evaluated on every push, review request and PR comment. Copilot finishing its review produces no event, so the `/reviewed` comment is what turns the check green. If it ever looks stale, post `/reviewed` again or run *Review gate* by hand with the PR number.

```bash
gh pr comment <number> --body "/reviewed accepted the permissions fix, skipped the wording nit"
```

Dependabot opens weekly PRs for GitHub Actions and npm dev dependencies.

## Deploying to Apps Script

The normal path is a release:

1. Merge the changes into `main` and make sure CI is green.
2. Releases → open the draft prepared by Release Drafter → *Publish release*. This creates the `vX.Y.Z` tag.
3. Actions → the *Deploy to Apps Script* run that just started → *Review deployments* → approve `production`. Nothing is pushed until approved.

The workflow checks out the released tag, runs lint, prints the files clasp will push, runs `clasp push --force`, and records an immutable Apps Script version named after the tag. Pre-releases are ignored.

For an ad-hoc deploy of `main` without a release: Actions → *Deploy to Apps Script* → *Run workflow*, optionally ticking *create_version*, then approve it the same way.

Only `main` and `v*` tags are allowed to deploy to `production`.

## Drift check

*Apps Script drift check* runs every Monday (and on demand). It pulls the live project and compares it with `main`. If someone edited code directly in the Apps Script editor, the run fails and attaches a patch with the differences so the change can be brought back into the repository.

## Releases

Release notes live on the [Releases page](https://github.com/mechgw/wordpress-automation/releases) and are prepared automatically by **Release Drafter**. There is no `CHANGELOG.md`; the published releases are the changelog.

- PRs are labelled from their title where possible.
- Merging a PR into `main` refreshes the draft release.
- `feat`/`new` resolve to a minor bump; everything else to a patch bump.

Publishing the draft from the Releases page is what triggers a deployment (see above). The initial baseline is `v2.8.0`; future versions follow Semantic Versioning.

## License

MIT.
