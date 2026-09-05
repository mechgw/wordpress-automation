# Test matrix template

Fill this in **before** implementing a non-trivial change or a test-only task, and paste the
result into the issue or the PR (section *Matryca testów*). For a trivial change keep it to the
scenario table and residual risk; it may be short, it may not be missing.

Layers are the three from [testing-standard.md](testing-standard.md): **Unit (VM)**, **Sheet
manual test**, **Runtime gate**.

## 1. Context

- **Criticality:** Critical / High / Medium / Low
- **Golden path?** yes when the change touches any of: writes to WordPress (`WP_ALLOW_WRITES`
  paths), GA4 key-event configuration, credentials or Script Properties handling, the deploy or
  drift workflows, data written to the sheets that feed reporting.
- **Why this change, who is affected, what does a wrong result cost?**

## 2. Scope

What is tested, what is explicitly out of scope.

## 3. Scenario inventory

| ID  | Business scenario                                    | Criticality | Layer (Unit / Sheet / Runtime) | Error strategy (fail-fast / fallback) |
| --- | ---------------------------------------------------- | ----------- | ------------------------------ | ------------------------------------- |
| T1  | e.g. missing `WP_REST_NAMESPACE` blocks bridge calls | High        | Unit                           | fail-fast                             |
| T2  | e.g. namespace with a slash is rejected              | Medium      | Unit                           | fail-fast                             |

Callouts, apply when relevant:

- **Config / Script Properties change:** at least one *missing* and one *malformed* scenario.
- **External call (WordPress, GA4, GSC):** assert the request shape (URL, method, payload,
  headers) and both a success and a non-2xx / non-JSON response.
- **Sheet write:** assert the range and values written, and the behavior when the sheet is missing.
- **Date logic:** a month/year boundary and an invalid input.
- **Bug fix:** the failing input that triggered the bug, plus one neighbouring edge case.
- **Deploy / workflow change:** a runtime scenario (dry run, drift check, rollback) and the
  rollback plan.

## 4. Defense in depth

| Layer          | What already protects this area | Required in this change | Extra safeguard | Residual risk if deferred |
| -------------- | ------------------------------- | ----------------------- | --------------- | ------------------------- |
| Unit (VM)      |                                 |                         |                 |                           |
| Sheet manual   |                                 |                         |                 |                           |
| Runtime gate   |                                 |                         |                 |                           |
| Documentation  |                                 |                         |                 |                           |

## 5. Assertion inventory

Concepts to prove per scenario, not a list of `assert` calls. Assertion classes used here:

- **Return contract** (value, shape, normalisation)
- **Error contract** (thrown `Error`, message names the property/field, `httpCode`)
- **Request effect** (`UrlFetchApp` call: URL, method, headers, payload)
- **Sheet effect** (range written, values, formatting call)
- **Property effect** (Script Property read/written)
- **Runtime effect** (trigger created/removed, version stamped)
- **Boundary guard** (writes refused when `WP_ALLOW_WRITES` is off, unknown field rejected)

- **T1**: expects `Brak Script Property: WP_REST_NAMESPACE` when the property is absent
  [Error contract]
- **T2**: expects the error to quote the offending value and the allowed charset [Error contract]

## 6. Execution

Link to the issue checklist or list the tests here with `[x]` when they exist.

## 7. Residual risk and descoping

| Scenario | Why deferred | Severity | Accepted by | Follow-up issue |
| -------- | ------------ | -------- | ----------- | --------------- |
|          |              |          |             |                 |

Any reduction of the matrix after review invalidates the review; re-run it.
