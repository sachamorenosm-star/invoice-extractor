---
name: security-review
description: Non-destructive security review of the InvoiceExtract codebase (auth, magic links, uploads, parsing, logging privacy, config). Use when asked for a security review, audit, or hardening check of the repo — not for live pentesting.
---

# Security review — InvoiceExtract (non-destructive)

Static, read-only review of code and config. Offline tests may be run.

## Hard limits

- No destructive pentest, no live scans or requests against deployed hosts
  without explicit authorization.
- No provider calls (Anthropic, Stripe, Resend).
- No brute force, no flooding, no load tests.
- No real user data, real invoices, or real emails — use synthetic fixtures.
- Do not print secret values found; report file + line only.

## Checklist (where to look)

| Area | Check | Main files |
|---|---|---|
| Secret leakage | hardcoded keys/tokens; `.env` not tracked (`git ls-files \| grep -i env`) | repo-wide, `.gitignore` |
| Auth / session | JWT secret source, expiry, cookie flags (`httpOnly`, `secure`, `sameSite`) | `src/middleware/auth.js`, `src/services/authService.js` |
| Magic link | single use, expiry, token hashing, no token in logs/redirects | `src/routes/auth.js`, `authService.js` |
| Rate limiting | coverage of login, extract, waitlist, feedback | `src/server.js`, `src/routes/*` |
| Proxy trust | `trust proxy` / `TRUST_PROXY_HOPS` cannot be spoofed via `X-Forwarded-For` | `src/server.js` |
| Upload validation | size/count limits, MIME **and** magic-byte check, extension handling | `src/middleware/upload.js`, `src/utils/validators.js` |
| Malformed files / parser DoS | PDF parsing isolated with timeout, page caps, image limits | `src/utils/pageCounter.js`, `pdfPageCountWorker.js` |
| Logging privacy | no invoice content, filenames, emails, tokens, JWTs in logs | `src/**`, `errorHandler.js`, `requestId.js` |
| Error handling | no stack traces / internal paths to clients | `src/middleware/errorHandler.js` |
| SQLite persistence | DB path on persistent disk, backup/restore assumptions, quota atomicity | `src/services/database.js`, `scripts/sqlite-backup.js` |
| Provider config | missing keys fail closed, model/config from env, Stripe webhook signature | `claudeService.js`, `stripeService.js`, `src/routes/stripe.js`, `src/utils/config.js` |
| CORS / headers | allowed origins, credentials, Helmet/CSP | `src/server.js` |
| Export | CSV/formula injection in Excel/CSV export | `src/services/excelService.js`, `src/routes/export.js` |
| Dependencies | `npm audit --omit=dev` (read-only, only if network allowed; never `audit fix`) | `package-lock.json` |

## Severity

- **P0** — exploitable now: auth bypass, secret exposed, invoice data leak.
- **P1** — serious with realistic preconditions (spoofable rate limit, token in logs, parser DoS).
- **P2** — defense-in-depth gap, hardening missing.
- **P3** — hygiene / informational.

## Finding format

```
[P1][CODE] <title>
Where: src/... :line
Issue: ...
Impact: ...
Fix: ... (proposal only — do not change code unless the task authorizes it)
```

Tag every finding **CODE** (provable from the repo) or **ENVIRONMENT/LIVE**
(depends on Render config, real proxy topology, provider dashboards, DNS).
End with counts per severity and what was NOT verified.
