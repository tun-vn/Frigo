# Frigo AI Handoff - final PR state reconciled

## Authoritative release

AUTHORITATIVE REPOSITORY: `vn-2c/Frigo`

CANONICAL GITHUB REPOSITORY (redirect observed 2026-09-12): `Tungjpstore/Frigo`

The configured `github-frigo` remote retains the `vn-2c/Frigo` alias.

AUTHORITATIVE BRANCH: `main`

PRODUCTION_APPLICATION_BASE_SHA:
`23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`

DEPLOYED_APPLICATION_SHA:
`d1b06732f8a80db4e77986df31ff28d9f04641fa`

MAIN_RELEASE_LINEAGE:
`d1b06732f8a80db4e77986df31ff28d9f04641fa` plus documentation-only receipt
merges; resolve the current `main` head from GitHub for a future release.

APPLICATION_RELEASE_MERGE_SHA:
`23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`

PRE_CLEANUP_MAIN_HEAD:
`41d2de6bc76331322cc63e8038432b0b02f60da1`

VERIFIED APPLICATION SHA: `0b20061e7dc7405df68b18a18da4166e09494ecd`

VERIFIED RELEASE HEAD: `0420807968538f61b669569d064c404f67032174`

MAIN CI: `34396319671 SUCCESS`

PREVIOUS FINAL-HEAD CI: `34405307196 SUCCESS`

PREVIOUS RELEASE DEPLOY WORKFLOW: `34396457582 SUCCESS`

PREVIOUS DOCS-CLEANUP DEPLOY WORKFLOW: `34405457796 SUCCESS`

PRODUCTION: **DEPLOYED AND VERIFIED**

DEPLOYED_MAIN_SHA:
`d1b06732f8a80db4e77986df31ff28d9f04641fa`

PRODUCTION_WORKER_VERSION:
`48e0c366-3c8a-4f2b-a2d5-965785995431` (100% traffic)

OCR_RECOVERY_BRANCH: `codex/ocr-production-recovery`

OCR_RECOVERY_BASE_SHA:
`d8ca112a5ac5eb215f36a3f89b4218e2fc691371`

OCR_RECOVERY_STATUS: **CANDIDATE / NOT DEPLOYED**

OCR_RECOVERY_CHECKPOINT: 2026-09-13; implementation `ec87aec` and documentation
`56968ba` are pushed on the feature branch. The deployed Worker and production D1 remain
at the receipt above until a separately authorized release is verified.

## Current status

T01-T07: COMPLETE

Release Integration: **COMPLETE**

Main Integration: **COMPLETE**

GitHub source of truth: main.

APPLICATION INTEGRATION: complete in main at `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.

The main merge tree is source-equivalent to the verified release head. Changes
after the production application base on GitHub remain documentation-only; the
separate OCR recovery branch contains candidate code/config/test changes that
are not part of `main` or production.

## Production cutover receipt

**Status: COMPLETE - SCHEMA AND WORKER CUTOVER VERIFIED (2026-09-10).**
Migrations `0019` -> `0022` were applied in order after the retained D1 export,
then the Worker was deployed from a clean checkout of the approved `main` SHA.

### Live runtime

- Target: `https://frigo.tungjpstore.net` (Cloudflare Worker; no Frigo
  production process is running in this local checkout).
- Liveness and landing smoke returned HTTP 200.
- Readiness returned HTTP 200 with `status=degraded`, `environment=production`,
  and full `commit=d1b06732f8a80db4e77986df31ff28d9f04641fa`.
- Readiness services are database/queue/AI/email `ok` or `configured`, rate
  limiting is `kv-best-effort`, and the only issue is the non-blocking warning
  `CONFIG_PLUS_GRANT_SECRET_MISSING`; `config.ok=true` and no fatal issue were
  observed.
- Active Cloudflare version is `48e0c366-3c8a-4f2b-a2d5-965785995431` at 100%
  traffic (deployment started 2026-09-10T21:08:00Z).

### Source and schema comparison

- The deployed Worker reports the approved main SHA; no source-only divergence
  remains on the public runtime.
- Remote D1 ledger is exactly `0001` through `0022`; the exact schema gate passes,
  foreign-key violations are `0`, and 65 user tables are present.
- `pnpm week:reconcile:remote -- --strict --json` passes 2/2 plans, 0 orphan
  rows and 0 mismatches (14 Week days, 16 slots and 30 shopping rows observed).

### Backup and rehearsal

- Export: `.artifacts/frigo-db-pre-main-d1b0673-20260910T205627Z.sql`,
  mode 600, 521095 bytes, SHA-256
  `000c9cb88d6045afb19cca6ce3e1caa308b20ffa214dbb2cddfca0cb78d722eb`.
- Temporary-copy replay of `0019` -> `0022` passed foreign-key/integrity checks
  and all `0020` preflight guards before the remote apply.
- Key post-cutover counts remain users 28, households 28, inventory items 13,
  recipes 59, meal plans 2, scan queue jobs 15, sessions 2 and auth OTPs 0.
- Migrations are additive and order-dependent. There are no down-migrations;
  retain the additive schema and use only a schema-compatible code rollback.

### Operational finding and gate

- CORS probes now return the exact ACAO for the trusted origin and no ACAO for
  path-bearing, localhost or arbitrary origins.
- No planner flag, PayOS/payment path or production secret value was changed.

## Verification receipt

- Full: 1,487 tests / 87 files PASS.
- Focused T02-T07: 819 tests / 40 files PASS.
- D1 clean: 22 / 22 migrations PASS.
- Upgrade sanity: 0020 -> 0022 PASS.
- Existing rows preserved: 776 rows / 58 tables.
- Browser: 264 assertions / 36 phases PASS.
- Payment-adjacent: 82 tests / 7 files PASS.
- Final release CI: PASS.
- Post-cutover local gates: `pnpm lint`, `pnpm typecheck`,
  `pnpm check:migrations` and `pnpm build` PASS.
- Local `pnpm test`: 1,427/1,487 PASS; 60 failures are limited to the two shell
  UI suites because `localStorage`/`container` are unavailable in this runner.
- Hosted exact-SHA CI `34413458369`: 1,487 tests / 87 files PASS.
- Dependency audit: `pnpm audit --prod` reports 2 moderate `react-router`
  advisories (current v6 line; upstream fix requires v7.18.0). Treat the
  dependency upgrade as a separately tested follow-up; no emergency package
  change was made during this production cutover.
- `git diff --check`: PASS for the OCR candidate. `pnpm check` on 2026-09-13
  passed 1,579 tests / 93 files plus lint, typecheck, migration replay through
  `0023` and build. Hosted PR #17 CI run `34728606704` passed the same checks;
  live-provider smoke and production canary remain pending.

The local UI limitation is environmental; the hosted exact-SHA CI remains the
authoritative full-suite gate.

## OCR production-recovery candidate

The candidate is a code/config recovery with additive migration
`0023_scan_request_fingerprint.sql`; it does not amend the historical cutover
receipt or authorize a deployment.

- Qwen `qwen3.7-flash` is explicitly set as the primary provider for vision,
  receipt OCR, chat and ranking through the DashScope international endpoint
  (`QWEN_BASE_URL`, `QWEN_MODEL`); structured requests disable thinking. Groq is
  an opt-in legacy fallback through `GROQ_FALLBACK_ENABLED=true`, and is
  disabled in the candidate vars.
- Native Cloudflare vision is opt-in through `CLOUDFLARE_VISION_FALLBACK` and is
  `false` in the candidate worktree vars. DeepSeek remains the optional
  text/ranking fallback when `DEEPSEEK_FALLBACK_ENABLED=true`, and Z.ai/GLM the
  optional vision/text extension path when `GLM_FALLBACK_ENABLED=true`; GLM-5.3
  Flash is future model work, not an active claim.
- Zod plus a deterministic quality gate removes generic/placeholder labels and
  confidence below `0.6`; an empty usable result is the permanent
  `AI_SCAN_NO_USABLE_ITEMS` failure. OCR output remains reviewable draft data,
  not trusted inventory, price or safety authority.
- Typed provider failures distinguish permanent `MODEL_NOT_FOUND`, auth/permission,
  license, schema/invalid-response and quality errors from retryable
  `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `RATE_LIMITED` and `UPSTREAM_ERROR` errors.
  Queue lease, idempotency, tenant fencing, attempt limits and DLQ semantics are
  unchanged.
- Scan status responses expose bounded failure codes and retry metadata without
  provider credentials or raw image content.
- The candidate adds additive migration `0023_scan_request_fingerprint.sql`.
  Local replay/schema checks cover `0001`-`0023`; production D1 remains at
  `0022` until an explicitly authorized guarded migration step.

Focused local checks and the full candidate gates passed on 2026-09-13:
`pnpm check` reports 1,579 tests / 93 files PASS, lint/typecheck/migration replay
through `0023` and build PASS; hosted PR #17 CI run `34728606704` is also green.
Live provider access is not verified: a read-only
`https://api.b.ai/v1/models` probe with the supplied test credential returned
HTTP 401 (`Invalid token`); the credential was not persisted or echoed in
repository files. No remote migration, production secret change, Worker
deployment, hosted CI, readiness or canary result was performed for this
candidate.

## Deployment and production boundary

Release packaging completed. Staging was not provisioned, so no staging deploy
occurred. The GitHub production environment/secrets are not provisioned, so the
approved release was deployed directly with Wrangler OAuth from a clean SHA
checkout; the same schema, smoke and readiness receipts were captured locally.

The OCR recovery candidate is not included in that deployment. Production still
reports the recorded `d1b06732` application receipt and Worker version until a
new exact-SHA deployment/readiness receipt is independently captured.

Wrangler is not authenticated in the local checkout. The OAuth login URL was
opened by `npx wrangler login`, but browser automation was unavailable, so the
operator must complete the Cloudflare authorization in Chrome before any remote
migration, secret update or deploy command can run.

PRODUCTION LOCAL RECONCILIATION COMPLETE - SCHEMA/CODE CUTOVER VERIFIED

Production local reconciliation: COMPLETE - post-cutover checks passed

PRODUCTION DATABASE MIGRATION COMPLETE - `frigo-db` at `0022`

Production DB migration: COMPLETE - exact ledger `0001` through `0022`

PRODUCTION DEPLOYMENT COMPLETE - Worker version `48e0c366-3c8a-4f2b-a2d5-965785995431`

Production deployment: COMPLETE - readiness commit matches `d1b06732...`

Planner rollout: NOT STARTED. `PLUS_GRANT_SECRET` remains intentionally absent
and is reported as a warning; no secret values were read or changed.

## PR #8 authoritative metadata

PR #8 METADATA:

- State: `MERGED`
- Draft: `false`
- Merged at: `2026-09-09T19:38:59Z`
- Closed at: `2026-09-09T19:38:59Z`
- Merge commit: `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`
- Base: `main`
- Head: `hoplite/kirrha-5f4057f0`
- Head SHA: `0420807968538f61b669569d064c404f67032174`

PR #8 was not reopened, re-merged or modified during this task. Its verified
release tree is already contained in main. Application integration and PR
metadata are separate facts.

## Kirrha archival state

Kirrha is two commits ahead of current main and differs only in the four
`docs/ai/` release protocol documents. It has no application differences absent
from main. Do not merge or revert this historical branch.

## Protected areas

PayOS/payment code untouched.

No real payment performed.

## Next task

Next task: COMPLETE OCR RECOVERY VALIDATION BEFORE GUARDED DEPLOYMENT

Keep the deployed Worker and planner flags at safe defaults while the OCR
candidate is validated. Run focused provider/queue/UI tests and all required
local gates, then obtain authorized live-provider smoke, hosted CI, readiness and
canary evidence before any production deploy. Apply and verify additive migration
`0023_scan_request_fingerprint.sql` first; no production secret change is implied.
Do not touch PayOS/payment or use a down-migration. Rollback remains code-only to a schema-compatible SHA;
reserve D1 restore/export for an incident. Configure the GitHub `production`
environment, `PRODUCTION_URL` and Cloudflare secrets before the next guarded
release, and schedule the tested React Router major upgrade separately.
