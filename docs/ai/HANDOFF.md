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
`df7225c9-6f20-4206-9f16-573de6a69c43` (100% traffic)

OCR_RECOVERY_BRANCH: `codex/ocr-production-recovery`

OCR_RECOVERY_BASE_SHA:
`d8ca112a5ac5eb215f36a3f89b4218e2fc691371`

OCR_RECOVERY_STATUS: **DEPLOYED AND VERIFIED**

OCR_RECOVERY_CHECKPOINT: 2026-09-13; implementation `ec87aec` merged as
`bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`. Worker version
`df7225c9-6f20-4206-9f16-573de6a69c43` serves 100% traffic and production D1 is
at migration `0023`.

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
  Local replay/schema checks cover `0001`-`0023`; production D1 now includes
  `0023` after the retained pre-0023 export. Worker deployment is verified.

Focused local checks and the full candidate gates passed on 2026-09-13:
`pnpm check` reports 1,579 tests / 93 files PASS, lint/typecheck/migration replay
through `0023` and build PASS; hosted PR #17 CI run `34728606704` is also green.
Live provider access is verified: a non-PII Qwen smoke returned HTTP 200 with
model `qwen3.7-flash` and `OK`; the key value is not stored in the repository or
logs. No separate staged canary was used; the guarded deploy went to 100% after
backup, migration and schema gate.

## Deployment and production boundary

Release packaging completed. Staging was not provisioned, so no staging deploy
occurred. The GitHub production environment/secrets are not provisioned, so the
approved release was deployed directly with Wrangler OAuth from a clean SHA
checkout; the same schema, smoke and readiness receipts were captured locally.

Production now reports candidate commit `bdb0dda0…`; readiness and liveness smoke
passed after deployment. Wrangler OAuth is authenticated as `tungbipdz@gmail.com`
for account `ef250a88911fd24073cb73d1c07e0218`.

PRODUCTION LOCAL RECONCILIATION COMPLETE - SCHEMA/CODE CUTOVER VERIFIED

Production local reconciliation: COMPLETE - post-cutover checks passed

PRODUCTION DATABASE MIGRATION COMPLETE - `frigo-db` at `0022`

Production DB migration: COMPLETE - exact ledger `0001` through `0022`

PRODUCTION DEPLOYMENT COMPLETE - Worker version `48e0c366-3c8a-4f2b-a2d5-965785995431`

Production deployment: COMPLETE - readiness commit matches `d1b06732...`

Planner rollout: NOT STARTED. `PLUS_GRANT_SECRET` remains intentionally absent
and is reported as a warning; no secret values were read or changed.

## OCR image optimization candidate (2026-09-13)

`src/web/lib/private-image.ts` contains an uncommitted client-side optimization:
gallery images are decoded in memory, constrained to a 2,000 px longest side and
encoded as JPEG quality 0.82 only when smaller than the source. Small images are
not upscaled; originals are never mutated or stored; cancellation/session fencing
and a FileReader fallback are preserved. The attached receipt measured 2,116,353
bytes as PNG versus 382,334 bytes after a local quality-0.82 conversion (81.9%
reduction, same dimensions). Focused privacy/image tests pass 11/11. The
implementation is committed locally at `ba3d872eea2d677e38f94adb8355f493c4c45852`
but is not deployed; browser/device OCR recall and latency smoke is still
required before release.

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

Next task: MONITOR OCR QUALITY/LATENCY AND SCHEDULE REACT ROUTER UPGRADE

Keep the deployed Worker and planner flags at safe defaults while the OCR
candidate is validated. Run focused provider/queue/UI tests and all required
local gates, then obtain authorized live-provider smoke, hosted CI, readiness and
canary evidence before any production deploy. Apply and verify additive migration
`0023_scan_request_fingerprint.sql` first; no production secret change is implied.
Do not touch PayOS/payment or use a down-migration. Rollback remains code-only to a schema-compatible SHA;
reserve D1 restore/export for an incident. Configure the GitHub `production`
environment, `PRODUCTION_URL` and Cloudflare secrets before the next guarded
release, and schedule the tested React Router major upgrade separately.

## Qwen runtime governance candidate (current task)

WORKING_BRANCH: `feat/qwen-ai-runtime-cost-router`

BASE_SHA: `05423f2ad675006a4c7913e696f1979b3fcaae59`

CANONICAL_MAIN_CHANGED: **NO**

PRODUCTION_DEPLOYED: **NO CHANGE / NOT AUTHORIZED**

The branch adds a fetch-compatible `QwenTaskRuntime` behind `AIRouter`. Tasks
resolve to logical roles (`QWEN_FAST`, `QWEN_FAST_CANARY`, `QWEN_MULTIMODAL`,
`QWEN_OCR`, `QWEN_REASONING`, `QWEN_JUDGE`) in one governance table. Physical
model IDs are supplied only by `AI_MODEL_*` configuration. Normal text uses the
pinned `qwen3.7-flash-2026-07-15`; OCR uses `qwen-vl-ocr`; multimodal work uses
`qwen3.8-flash`; reasoning and judge are disabled unless explicitly enabled.

The runtime enforces per-task input/output budgets, a per-operation call/token
ceiling, one repair plus one policy-approved escalation, Zod structured-output
validation, scan quality gates and cost metadata. `AIUsageLedger` aggregates
task/model calls, tokens, costs, failures, retries, escalation and latency;
Worker logs include only non-PII metadata. `AI_QWEN_ONLY=true` prevents legacy
Groq, DeepSeek, GLM and native Cloudflare providers from being constructed.

Inventory safety is unchanged: AI returns observation/candidate data only. The
existing normalization, validation, review, reconciliation, fencing and
idempotent inventory command remain the sole authority for mutations.

Final T08-T12 Inventory Truth end-to-end certification is still pending the
later unification with the separate `frigo-dev` lineage. This candidate does
not import that code or migrations; it only proves that Qwen runtime/provider
modules have no direct authoritative inventory mutation path.

Offline evaluation assets are `tests/fixtures/ai-golden.json`,
`tests/unit/ai-golden-dataset.test.ts` and `scripts/ai-eval.mjs`; run
`pnpm ai:eval -- --dry-run`. The command makes no live provider call and no CI
test requires an Alibaba credential.

Verification recorded for this checkpoint:

- Application checkpoint: `21c442d`.
- `pnpm check`: PASS — 1,606 tests / 95 files; lint, typecheck, migration replay
  and production build all PASS. Remote D1 schema and Week parity checks were
  skipped because no release flags were supplied.
- `pnpm ai:eval -- --dry-run`: PASS; fixture-only report, no Alibaba/Qwen call.
- `git diff --check`: PASS after the documentation edits.
- Focused command (`pnpm vitest run tests/unit/ai-runtime-governance.test.ts
  tests/unit/ai-router.test.ts tests/unit/qwen-provider.test.ts
  tests/unit/config-validation.test.ts tests/unit/meal-planning-explanation.test.ts
  tests/unit/scan-privacy.test.tsx tests/integration/scan-queue-retry-policy.test.ts
  tests/integration/scan-async-canary.test.ts`): **119 tests / 8 files PASS**;
  queue/idempotency regression coverage remains green.
- `pnpm audit --prod`: FAIL (2 moderate `react-router` advisories; patched
  upstream at `>=7.18.0`). This pre-existing dependency follow-up is outside
  the Qwen runtime scope; no package upgrade was made in this checkpoint.
- Secret scan, protected-path scan and provider/model search were clean. No
  PayOS/payment, unrelated auth, remote migration, merge or deployment action
  was performed.
- Local `main` is a separate divergent ref (`f6a48a1`); canonical source for
  this candidate is `github-frigo/main` at `05423f2`, and no local ref was
  changed.
- Final review found no concrete runtime defect requiring a code fix. Readiness
  already probes the additive scan columns from migration `0023`, and the
  deployment documentation correctly scopes the native `AI` binding to the
  explicit `CLOUDFLARE_VISION_FALLBACK=true` path.
- Publication checkpoint: `feat/qwen-ai-runtime-cost-router` is now published
  on `github-frigo` by a normal non-force push; `git ls-remote` verified the
  remote branch SHA matches the local candidate and canonical `main` remains
  `05423f2`. GitHub emitted only the repository-relocation notice to
  `Tungjpstore/Frigo`; no merge, deployment, remote migration or production
  change has occurred.

Next action after publication: request code review or a separately authorized
Qwen benchmark, then promote a pinned alias only through the documented
golden-dataset process. Do not merge, migrate remotely or deploy from this
branch.
