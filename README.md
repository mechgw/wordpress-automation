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
- `Status.gs` — import status: run records in Script Properties, one-line status in the config cells, the `IMPORT LOG` sheet, the *Dane* menu.
- `Alerts.gs` — e-mail alerts on the incident model (open once, silent while open, close on recovery) and the daily freshness guard.
- `UrlInspection.gs` — Google index status of key URLs from the Search Console URL Inspection API, written into the `URL INSPEKCJA` sheet.
- `Version.gs` — placeholders only; the deploy workflow overwrites it with the release tag, commit and time before `clasp push`, and the sheet shows that tag as a menu (*Szczegóły wdrożenia*). The drift check ignores this file.
- `eslint.config.js` — lint rules with Apps Script services declared as globals.
- `.claspignore` — only `*.gs` and `appsscript.json` are ever pushed to Apps Script.

## Secrets and configuration

Do not commit credentials or API secrets. Runtime credentials belong in Apps Script **Script Properties**.

The WordPress bridge currently expects properties such as:

- `WP_BASE_URL`
- `WP_USERNAME`
- `WP_APP_PASSWORD`
- `WP_ALLOW_WRITES`
- `WP_REST_NAMESPACE` — namespace of the site-specific REST bridge snippet, e.g. `acme` for `/wp-json/acme/v1/seo-meta`.

Optional:

- `SITE_DOMAIN` — domain used to auto-pick the GA4 property by its web stream URL. Falls back to the host of `WP_BASE_URL`; with neither set, the property has to be chosen by hand in the config sheet.
- `ALERT_EMAIL` — recipient of import alerts (one address or a comma-separated list). Without it nothing is sent and nothing fails; incidents are still tracked and shown in *Status danych*. A value that is not an address (for example `TRUE`) is never used: *Status danych* and the guard dialog show it as `NIEPRAWIDŁOWY ADRES` until it is fixed.
- `ALERT_RECOVERY` — `FALSE` disables the "import works again" e-mail; the incident is still closed. Default: enabled.

`WP_ALLOW_WRITES` should remain disabled unless a write operation is intentionally being performed.

### Concurrency and idempotency

- **One script lock** (`Lock.gs`, `LockService.getScriptLock`) wraps every GSC/GA4 import and the whole *Wykonaj polecenia* loop. It is a short `tryLock` (5 s) with no queueing: a second run that finds the lock held stops with `Inne uruchomienie jeszcze trwa (…)`. For imports that refusal is recorded as a failed run in the status cell, so a lost run is visible instead of two runs writing the same sheet or the same WordPress page.
- **Command statuses in `WP COMMANDS`:** `PENDING` is picked up; `RUNNING` means a run was interrupted after the row was claimed (Apps Script time limit, crash). Such a row is never re-executed automatically: check the page in WordPress, then set `ERROR`, or `PENDING` with a new `command_id`. `SKIPPED` means a write command was refused because it has no `command_id` or a result for that `command_id` already exists in `WP RESULTS`; to run it again, give it a new id. Read commands may be repeated freely.
- **Menu *WordPress → Wykonaj wiersze DRY_RUN naprawdę*** asks for confirmation, flips `DRY_RUN` rows to `PENDING` and runs them; it refuses while `WP_DRY_RUN` is still `TRUE`.

`WP_DRY_RUN=TRUE` turns *Wykonaj polecenia* into a rehearsal: every write command runs its validations, reads and snapshot exactly as for real, but the write request is stopped right before `UrlFetchApp.fetch` and the command row gets status `DRY_RUN` with the method, URL and payload that would have been sent. Reads still execute. Dry run and the real write share one request builder (`buildWpRequest_`), so the preview cannot differ from production. Dry run works without `WP_ALLOW_WRITES`; without `WP_DRY_RUN` the write guard stays as it is.

Nothing site-specific (domain, company name, REST namespace) is hardcoded in the sources; it all lives in Script Properties so the repository can stay public.

### Import status (is the data fresh?)

Every GSC and GA4 import, manual or from the daily trigger, records its outcome in Script Properties (`LAST_IMPORT_GSC`, `LAST_IMPORT_GA4`: last run and last successful run with timestamp, row counts, error, duration). Two places show it:

- **Cells** `Konfiguracja GSC!B8` and `Konfiguracja GA4!B9`, one line each, readable by people and by anything that reads the sheet through the API:

  | Cell text | Meaning |
  | --- | --- |
  | `AKTYWNE – ostatni import: 2026-09-05 06:02 \| 1234 wierszy \| trigger: TAK` | last run succeeded, data is fresh, daily trigger installed |
  | `BŁĄD 2026-09-06 06:01: <message> \| ostatni poprawny import: 2026-09-05 06:02 \| trigger: TAK` | last run failed; the data is from the previous successful run |
  | `NIEAKTUALNE – …` | last successful import is older than 36 hours (or there is none); do not trust the data |
  | `BRAK IMPORTU – uruchom import z menu \| trigger: NIE` | never imported |

- **Menu *Dane* → *Status danych***: the same for both sources plus schedule, last run result, manual/trigger and duration. *Odśwież status w komórkach* rewrites the cells (for example after installing a trigger).

A failed trigger run therefore never masquerades as a fresh import, and the cells say whether the trigger is still installed.

**History and anomalies** (`IMPORT LOG` sheet, created automatically): every run appends a row with time, source, run type (`trigger` / `ręczny`; the daily import counts as `trigger` only when Apps Script invoked it from the time-driven trigger, the same menu item run by hand is `ręczny`), days in the imported range (`0` on failed runs, where the range is unknown), result, row count, duration, details and error or warning. Rows older than 90 days are pruned wherever they sit, so sorting the sheet by hand is safe; the anomaly rule also ignores expired rows and orders history by time, not by row position. After each successful run the row count is compared with the median of the last 7 successful runs of the **same profile** (source + run type + days), so a daily 1-day trigger import is never compared with a manual 90-day backfill. Fewer than 7 runs in a profile means no alarm. Zero rows with a positive median, or fewer than half the median, adds `UWAGA: mało danych: <n> wierszy vs mediana <m>` to the status cell, the *Status danych* dialog and the log row. The import itself still counts as successful; the warning is a signal to look at the source.

### E-mail alerts (incident model)

Alerts are sent by `MailApp` (scope `script.send_mail`; the first deploy with this scope requires re-authorising the script once) to `ALERT_EMAIL`. They do not fire per event but per **incident**, one per source, stored in the same `LAST_IMPORT_*` record:

| Transition | What happens |
| --- | --- |
| OK → problem | incident opens, **one** e-mail with source, time, manual/trigger, the error or the anomaly text and the last good import |
| problem → problem | silence; the incident only updates its reason and details (an error after an anomaly, a new error message) |
| problem → OK | incident closes; e-mail *Import ponownie działa* unless `ALERT_RECOVERY=FALSE` |

A problem is a failed run (`BŁĄD`, including a refused lock) or a row-count anomaly (`UWAGA, mało danych`). Subjects start with `[wordpress-automation]`; every body ends with the sheet URL and the deployed version. Sending is best-effort: a `MailApp` failure (daily quota, bad address) is logged and never changes the outcome of the import or the guard. An incident whose opening e-mail could not be sent (no `ALERT_EMAIL` yet, quota) is notified once on the next occurrence after sending becomes possible, then falls silent as usual.

**Stale data** has no run to react to, so a daily guard (`sprawdzAktualnoscImportow`, menu *Dane → Sprawdź aktualność importów*) checks both sources: a source that is `NIEAKTUALNE` or `BRAK IMPORTU` opens a `stale` incident and all such sources go into **one** aggregate e-mail; while the incident is open the guard stays quiet. When the source is fresh again the guard closes the incident (recovery e-mail, same switch). Incidents opened by a failed run are left to the import path. *Dane → Sprawdź aktualność teraz (alerty)* runs the same check from the menu and shows a dialog with both sources, the incidents opened and closed, and whether an e-mail went out or why it did not (no address, invalid address, `MailApp` error). *Dane → Włącz codzienne alerty e-mail* installs the guard trigger around 08:00, after the GSC and GA4 imports; the dialog says where alerts go, or warns that `ALERT_EMAIL` is missing or invalid. *Status danych* shows the open incident per source, the recipient and whether the guard trigger is installed.

### URL inspection (what Google has in its index)

`URL INSPEKCJA` sheet, column A = addresses to watch (created with its header on first run). *SEO / GSC → Sprawdź indeksowanie (URL INSPEKCJA)* calls the Search Console URL Inspection API for every address and writes, in the same row: verdict (`ZAINDEKSOWANY (PASS)`, `WYKLUCZONY (NEUTRAL)`, `BŁĄD INDEKSOWANIA (FAIL)`, `NIEZNANY`), coverage state as Google phrases it (for example `Excluded by 'noindex' tag`), canonical according to Google and according to the page, last crawl, robots.txt state, check time. A verdict or coverage different from the previous run is flagged in *Zmiana* as `ZMIANA: old → new`; an unchanged state clears the flag. One failing address goes into *Błąd* with the check time and keeps its previous values; the other rows are still processed. Addresses without `http(s)://` are rejected without a request.

The result is the state **in Google's index**, not the live page: after changing `noindex`, a canonical or the content, the row changes only after Google recrawls the page (the live check is a separate tool, issue #53). The API allows 2000 inspections per site per day; one run handles at most 150 addresses and reports the rest as skipped, so run it again for the remainder. *Włącz cotygodniową inspekcję URL* installs a weekly trigger (Monday, around 07:00) that runs the same check without a dialog. The run holds the shared script lock and uses the existing read-only Search Console scope.

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
npm test
```

### Unit tests

`test/` holds Node unit tests (`node --test`, no extra packages). `test/helpers/gas.js` loads the `.gs` files into a VM context with small stand-ins for the Google services (`SpreadsheetApp`, `PropertiesService`, `UrlFetchApp`, `Utilities`, `ScriptApp`), so the shared global scope of Apps Script is reproduced and the pure helpers plus the configuration layer can be exercised without Google:

- date parsing and shifting, hostname/domain matching, GA4 row extraction, WordPress response helpers;
- `getWpConfig_` / `wpBridgePath_` validation (missing or malformed Script Properties), `wpFetch_` request shape and response parsing;
- `getGa4Config_` defaults, `Version.gs` presence/absence;
- `testGA4` end to end against stubbed Admin/Data API responses (property auto-pick by stream domain, ambiguous and empty cases, what lands in the config sheet);
- the WordPress bridge flows: `testRankMathBridge`, `getPageRawById_`, `writeRankMathField_`, `getPageLayout_`, `copyPageLayout_`, including the result rows appended to *WP RESULTS* and every named failure path.

The sheet stub is a real cell grid: fixtures start at row 1, `gas.$cell('Konfiguracja GA4', 'B9')` reads a cell, `gas.$sheet(name)` the whole grid, `gas.$alerts` the UI alerts, and `fetchRouter([[urlSubstring, response], ...])` routes stubbed HTTP calls.

Everything that talks to Sheets, GA4 or WordPress for real stays covered by the sheet's *Sprawdź połączenie* / *Test …* menu items and the drift check. Two VM gotchas when writing tests: create `Date` objects with `gas.$Date`, and compare objects returned from the sources through `plain()` (different realm, different prototypes).

### Quality gates and standards

- **Standard:** [docs/quality/testing-standard.md](docs/quality/testing-standard.md) (layers, ten rules, gold standard, forbidden patterns). Plan tests with [docs/quality/test-matrix-template.md](docs/quality/test-matrix-template.md) and record evidence in the PR template.
- **Coverage gate:** `npm run quality:gate -- --changed=base:origin/main` runs the tests with V8 coverage and enforces two rules: per-file thresholds from `.quality/coverage-policy.json` (a ratchet, thresholds only go up) and **100% coverage of changed `*.gs` lines**. Justified exceptions live in `.quality/changed-lines-ignore.json`.
- **Pre-commit hook:** `npm ci` points git at `.githooks/` (`core.hooksPath`). On every commit the hook blocks credentials and build artifacts, lints the staged files, and runs the tests plus the coverage gate on the staged `*.gs` lines. `git commit --no-verify` skips it locally; CI runs the same gate against `main` and blocks the merge.
- **CI:** the `validate` job runs lint, tests and the gate against the PR base commit.
- **Deploy:** the deploy workflow runs lint, tests and the per-file thresholds on the tag being deployed, after the `production` approval and before `clasp push`. Tests therefore guard every stage: commit, merge, deploy.

To work against the live Apps Script project, log in once (clasp is installed by `npm ci`):

```bash
npx clasp login
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
3. Post a PR comment that starts with `/reviewed`, followed by a short note on what was accepted and what was rejected. It has to be newer than the last commit and the last bot **review** (a review object or an inline comment), so a new push or a new bot review means a new `/reviewed`. Plain bot comments to the PR, such as Codex's usage-limit notice, do not reset it. The logic lives in `scripts/quality/review-ack.js` with unit tests in `test/review-ack.test.js`.

The check runs on every push and review request. Every PR comment (including `/reviewed`) re-runs the latest evaluation for that PR, so the comment is what turns the check green; Copilot finishing its review produces no event on its own. If it ever looks stale, post `/reviewed` again or run *Review gate* by hand with the PR number.

```bash
gh pr comment <number> --body "/reviewed accepted the permissions fix, skipped the wording nit"
```

Dependabot opens weekly PRs for GitHub Actions and npm dev dependencies.

## Deploying to Apps Script

The normal path is a release:

1. Merge the changes into `main` and make sure CI is green.
2. Releases → open the draft prepared by Release Drafter → *Publish release*. This creates the `vX.Y.Z` tag.
3. Actions → the *Deploy to Apps Script* run that just started → *Review deployments* → approve `production`. Nothing is pushed until approved.

The workflow checks out the released tag, runs lint and the tests, prints the files clasp will push, runs `clasp push --force`, records an immutable Apps Script version named after the tag, and then **verifies the live project**: it pulls the project back and compares it with the tag (`scripts/quality/apps-script-compare.js`, the same script the drift check uses). A red verification step means the push already happened but the project differs; investigate or roll back with `deploy_ref`. The job summary lists the pushed files, the version and the comparison result. Pre-releases are ignored.

For an ad-hoc deploy without a release: Actions → *Deploy to Apps Script* → *Run workflow*, leave *Use workflow from* on `main`, keep *deploy_ref* as `main`, optionally tick *create_version*, then approve it the same way.

**Rollback**: same dialog, still run from `main`, but set *deploy_ref* to the previous release tag (for example `v2.9.1`). The workflow verifies the tag exists, checks it out, lints it, and after approval pushes those sources to Apps Script. Always keep *Use workflow from* on `main`: that dropdown selects the workflow definition, and older tags carry older definitions.

```bash
gh workflow run deploy-apps-script.yml --ref main -f deploy_ref=v2.9.1
```

clasp is a pinned dev dependency (`package-lock.json`), so local runs and both workflows use the same version; Dependabot proposes upgrades.

## Drift check

*Apps Script drift check* runs every Monday (and on demand). It pulls the live project and compares it with `main` using `scripts/quality/apps-script-compare.js` (trailing newlines normalised, `Version.gs` ignored, only `*.gs` and `appsscript.json` compared). If someone edited code directly in the Apps Script editor, the run fails and attaches a patch with the differences so the change can be brought back into the repository.

## Releases

Release notes live on the [Releases page](https://github.com/mechgw/wordpress-automation/releases) and are prepared automatically by **Release Drafter**. There is no `CHANGELOG.md`; the published releases are the changelog.

- PRs are labelled from their title where possible.
- Merging a PR into `main` refreshes the draft release.
- `feat`/`new` resolve to a minor bump; everything else to a patch bump.

Publishing the draft from the Releases page is what triggers a deployment (see above). The initial baseline is `v2.8.0`; future versions follow Semantic Versioning.

## License

MIT.
