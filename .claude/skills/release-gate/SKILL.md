---
name: release-gate
description: Verification gate for InvoiceExtract changes. Use before declaring any change ready, before committing, or when asked to verify/validate a change and report PASS/FAIL/SKIPPED.
---

# Release gate — InvoiceExtract

Stack: Node.js (CommonJS, Express, better-sqlite3). Tests are standalone
offline scripts under `test/*.test.js`, run with `node test/<file>.test.js`
(there is no `npm test` script). Tests use temp DBs and block outbound network
(`test/helpers/offline.js`).

## Order (do not skip or reorder)

1. **Inspect** — read the touched code and the tests that cover it.
2. **Focused tests** — the test file(s) directly covering the change.
3. **Relevant suites** — related tests (e.g. auth change → `private-beta-auth`,
   `auth-logging`; upload/PDF change → `pdf-parse-worker`,
   `mobile-image-intake`, `pre-beta-hardening`; proxy/rate limit → `proxy`).
4. **One full gate** — once, at the end:
   `for f in test/*.test.js; do node "$f" || echo "FAIL: $f"; done`
5. **Syntax / static checks** — `node --check <file>` for each touched `.js`;
   `ruff check` only if Python files were touched (none exist today).
6. **`git diff --check`** — no whitespace errors.
7. **Secret / privacy review** — diff contains no keys, tokens, `.env` values,
   real emails, real invoice content, or real filenames.
8. **Git review** — use the `git-safety` skill: branch, status, only intended
   files changed.
9. **Commit** — only if the task authorizes it.
10. **Final report**.

## Rules

- `SKIPPED` is not `PASS`. Report every step as PASS / FAIL / SKIPPED (+ reason).
- No "probably", "should pass", "likely fine": run it or mark it SKIPPED.
- Report real outputs (counts, failing assertion); never summarize a failure as
  a pass.
- Do not rerun the full suite repeatedly; rerun only focused tests while fixing,
  then one final full gate.
- No real provider calls (Anthropic, Stripe, Resend) unless the task explicitly
  authorizes them. Keep provider credentials blank in test runs.
- Classify each result as:
  - **CODE VERIFIED** — proven by offline tests/static checks in this repo.
  - **LIVE-ONLY / ENVIRONMENT** — depends on Render, real providers, DNS,
    real proxy topology, or production data; state it is not verified here.

## Final report template

```
Inspect:          PASS/FAIL
Focused tests:    PASS/FAIL/SKIPPED  (files, counts)
Relevant suites:  PASS/FAIL/SKIPPED
Full gate:        PASS/FAIL/SKIPPED  (n passed / n failed)
Static checks:    PASS/FAIL/SKIPPED
git diff --check: PASS/FAIL
Secret/privacy:   PASS/FAIL
Git review:       PASS/FAIL
Commit:           <hash> / NOT AUTHORIZED
CODE VERIFIED:    ...
LIVE-ONLY:        ...
```
