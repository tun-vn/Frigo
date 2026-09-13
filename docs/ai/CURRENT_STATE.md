# Frigo current state - final PR metadata reconciled

> This checkpoint retains the historical production receipt and separately tracks
> the unreleased OCR recovery candidate dated 2026-09-12.

## Release status

- T01-T07: COMPLETE.
- T01: **COMPLETE**
- T02: **COMPLETE**
- T03: **COMPLETE**
- T04: **COMPLETE**
- T05: **COMPLETE**
- T06A: **COMPLETE**
- T06B: **COMPLETE**
- T07: **COMPLETE**
- Release Integration: **COMPLETE**
- Release Publication: **COMPLETE**
- Main Integration: **COMPLETE**
- Main CI: **PASS**
- Production reconciliation: **COMPLETE - SCHEMA AND WORKER CUTOVER VERIFIED** (2026-09-10).
- OCR production recovery: **COMPLETE - DEPLOYED AND VERIFIED** (2026-09-13).

## Authoritative source

- GitHub source of truth: main.
- Deployed application SHA: `bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`.
- Commits after the deployed application are documentation-only receipt merges;
  verify the current `main` head from GitHub when preparing a later release.
- Current `github-frigo/main` observed 2026-09-12: `db2377fd9f63d1be38ce3882c6d8173e0bf9e497`.
- GitHub API redirects `vn-2c/Frigo` to canonical public repository
  `Tungjpstore/Frigo`; the configured `github-frigo` remote remains the alias.
- OCR recovery branch: `codex/ocr-production-recovery`, based at `d8ca112a5ac5eb215f36a3f89b4218e2fc691371`;
  candidate implementation is committed at `ec87aec` and deployed through
  merge commit `bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`.
- The 2026-09-13 PR #17 merge added the OCR recovery implementation to `main`;
  production now reports the merge SHA and Worker version recorded below.
- PRODUCTION_APPLICATION_BASE_SHA:
  `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- PRE_CLEANUP_MAIN_HEAD: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
- APPLICATION INTEGRATION: complete in main at `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- Verified application SHA: `0b20061e7dc7405df68b18a18da4166e09494ecd`.
- Verified release head: `0420807968538f61b669569d064c404f67032174`.
- Main head before this correction: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
- The main merge tree is source-equivalent to the verified release head.
- Changes after the historical application base now include the merged OCR
  recovery implementation and its additive migration; the production receipt
  is anchored to `bdb0dda0…`.

## Verification snapshot

| Gate | Result |
| --- | --- |
| Full suite | 1,487 tests / 87 files PASS |
| Focused T02-T07 | 819 tests / 40 files PASS |
| Clean D1 | 22 / 22 migrations PASS |
| Upgrade sanity | 0020 -> 0022 PASS |
| Existing data | 776 rows / 58 tables preserved |
| Browser | 264 assertions / 36 phases PASS |
| Payment-adjacent | 82 tests / 7 files PASS |
| Main CI | 34396319671 SUCCESS |
| Previous final-head CI | 34405307196 SUCCESS |

These are the preserved release gates; the post-cutover local gates and remote
schema/Week checks are recorded in the receipt below.

## Deployment and production boundary

- Previous release deploy workflow `34396457582`: **SUCCESS**.
- Previous docs-cleanup deploy workflow `34405457796`: **SUCCESS**.
- Release packaging completed.
- Staging was not provisioned; no staging deployment occurred.
- Production DB migration: **COMPLETE** - D1 `frigo-db` ledger contains exactly `0001` through `0023`; `0023` was applied additively on 2026-09-13 after the retained backup.
- Production deployment: **COMPLETE** - Worker deployed with Wrangler OAuth from candidate SHA `bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`.
- Production reconciliation: **COMPLETE** - post-cutover source, schema, health and traffic checks passed.
- Active deployment: Cloudflare version `df7225c9-6f20-4206-9f16-573de6a69c43`, 100% traffic, deployed 2026-09-13T01:01:24Z.
- OCR recovery: **DEPLOYED AND VERIFIED**. Remote D1 `0023` is applied and gated;
  Qwen secret and non-PII smoke passed; readiness reports commit `bdb0dda0…`.
- Planner rollout: NOT STARTED.
- Production secret `QWEN_API_KEY` was added from the operator clipboard; its
  value is never stored in the repository or logs. Existing secret names include
  `JWT_SECRET`,
  `OTP_HASH_SECRET`, `TURNSTILE_SECRET_KEY`, `QWEN_API_KEY` and optional
  `GROQ_API_KEY`. The Qwen key value is not written to the repository or logs.

## Production cutover receipt (2026-09-10)

Verified against `https://frigo.tungjpstore.net` after the cutover:

- Worker readiness: HTTP 200, `status=degraded`, `environment=production`, and
  full `commit=d1b06732f8a80db4e77986df31ff28d9f04641fa`; database/queue/AI/email
  are `ok`/`configured`, rate limiting is `kv-best-effort`, and the only issue is
  the non-blocking warning `CONFIG_PLUS_GRANT_SECRET_MISSING`.
- Liveness and landing smoke: `GET /` and `GET /api/v1/health` returned HTTP 200;
  readiness smoke passed with database `ok` and no fatal configuration issue.
- Exact remote schema gate: PASS; migration ledger is exactly 22 entries
  (`0001`-`0022`), foreign-key violations are `0`, and the Week strict
  reconciliation is 2/2 plans with 0 orphan rows and 0 mismatches.
- Key preserved row counts: users 28, households 28, inventory items 13,
  recipes 59, meal plans 2, scan queue jobs 15, sessions 2, auth OTPs 0.
- CORS verification: the exact trusted origin receives its own ACAO header;
  path-bearing, localhost and arbitrary origins receive no ACAO header.
- Backup retained at `.artifacts/frigo-db-pre-main-d1b0673-20260910T205627Z.sql`,
  mode 600, 521095 bytes, SHA-256
  `000c9cb88d6045afb19cca6ce3e1caa308b20ffa214dbb2cddfca0cb78d722eb`.
- Deployment used a clean detached checkout at the approved main SHA and
  `GIT_COMMIT` injection only; no planner flag, PayOS/payment path or secret
  value was changed.

## OCR production-recovery candidate (2026-09-12)

The candidate addresses provider/model recovery and scan failure handling without
changing the production receipt above:

- Candidate schema now includes additive migration `0023_scan_request_fingerprint.sql`;
  local replay and schema checks cover `0001`-`0023`. Production D1 migration
  `0023` was applied after backup `.artifacts/frigo-db-pre-ocr-20260913T005253Z.sql`
  (SHA-256 `bc62e5844c6a838a3b1b98d29dffa39c9d6cf6e1d570617e843c9e3e820bb088`).

- Qwen `qwen3.7-flash` is the primary provider for vision, receipt OCR, chat and
  recipe ranking through the DashScope international OpenAI-compatible endpoint
  (`QWEN_BASE_URL`, `QWEN_MODEL`); structured requests disable thinking. Groq is
  retained only as an explicit legacy fallback (`GROQ_FALLBACK_ENABLED=true`),
  and is disabled in the candidate vars.
- Native Cloudflare vision remains opt-in through
  `CLOUDFLARE_VISION_FALLBACK=false`. DeepSeek remains the optional text/ranking
  fallback when `DEEPSEEK_FALLBACK_ENABLED=true`, and Z.ai/GLM the optional
  vision/text extension path when `GLM_FALLBACK_ENABLED=true`; a GLM-5.3 Flash
  upgrade is future work and is not claimed as active.
- Vision and receipt responses pass Zod validation plus a deterministic quality
  gate: generic/placeholder labels and confidence below `0.6` are removed;
  no usable rows return `AI_SCAN_NO_USABLE_ITEMS` instead of a fabricated draft.
- Typed provider errors classify permanent `MODEL_NOT_FOUND`, auth/permission,
  license, schema/invalid-response and quality failures separately from retryable
  `REQUEST_TIMEOUT`, `NETWORK_ERROR`, `RATE_LIMITED` and `UPSTREAM_ERROR` errors;
  queue retries remain bounded by the existing attempt/DLQ contract.
- Scan status responses expose bounded error codes and retry metadata; OCR output
  remains untrusted draft data requiring review and confirmation.
- Focused local checks on 2026-09-13: Qwen provider ESLint PASS;
  provider/recovery, queue, quota, scan-route and UI tests PASS. The complete
  candidate `pnpm check` gate is green: 1,579 tests / 93 files PASS, lint,
  typecheck, migration replay through `0023` and production build all PASS.
- Live provider access is **VERIFIED**: non-PII chat smoke returned HTTP 200 from
  DashScope with model `qwen3.7-flash` and response `OK`. Production readiness
  returned HTTP 200 with `ai=configured`, database/queue `ok`, and only the
  existing non-blocking `CONFIG_PLUS_GRANT_SECRET_MISSING` warning.

## Verification commands

- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm check:migrations`: PASS (`migration-smoke=ok`).
- `pnpm build`: PASS.
- `pnpm test`: 1,427/1,487 passed; 60 failures are confined to the two known
  shell/jsdom UI suites (`localStorage`/`container` unavailable). Hosted exact-SHA
  CI run `34413458369` remains the authoritative 1,487/87 PASS gate.
- `pnpm schema:check:remote`: PASS; `pnpm week:reconcile:remote -- --strict --json`: PASS.
- `pnpm audit --prod`: 2 moderate `react-router` advisories via
  `react-router-dom` (patched upstream at 7.18.0; major upgrade not included in
  this cutover). Full dependency audit reports 21 findings, with the remainder
  confined to development/tooling paths (`wrangler`/`miniflare`/`jsdom`).
- Read-only lineage checks: `git ls-remote --heads github-frigo main` returned
  `db2377fd9f63d1be38ce3882c6d8173e0bf9e497`; `git rev-list --left-right --count
  HEAD...github-frigo/main` returned `0 2`; no remote fetch or mutation was run.
- `git diff --check`: PASS for this documentation checkpoint.
- OCR candidate local lint/typecheck/test/build/migration checks: **PASS** on
  2026-09-13. Hosted PR #17 CI run `34728606704` also passed (1,579 tests / 93
  files). Live non-PII Qwen smoke, migration `0023`, deployment and readiness
  evidence are verified; only the non-blocking Plus Grant warning remains.
- Wrangler OAuth is authenticated as `tungbipdz@gmail.com` (account
  `ef250a88911fd24073cb73d1c07e0218`).

## PR #8 metadata

PR #8 METADATA:

Authoritative GitHub state: `MERGED`, `isDraft=false`,
`mergedAt=2026-09-09T19:38:59Z`, `closedAt=2026-09-09T19:38:59Z`,
`mergeCommit=23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`, base `main`, head
`hoplite/kirrha-5f4057f0` at `0420807968538f61b669569d064c404f67032174`.

Application integration and PR metadata are separate facts: application
integration is complete in main at `23ef51d`; PR #8 was already merged and was
not reopened, re-merged or modified.

## Kirrha archival state

Kirrha is two commits ahead of current main and differs in four `docs/ai/` files
only. There are no application differences on that historical branch that are
absent from main. Do not merge or revert kirrha.

## Protected areas

PayOS/payment code untouched.

No real payment performed.

## Next task

Next task: MONITOR OCR QUALITY/LATENCY AND SCHEDULE REACT ROUTER UPGRADE

Keep the deployed Worker and planner flags at their safe defaults while the OCR
candidate is validated. Run the focused provider/queue/UI tests, all required
local gates and an authorized live-provider smoke against the exact candidate SHA;
then obtain hosted CI, readiness and canary evidence before any production deploy.
No remote migration or production secret change has been performed for this
candidate. Migration `0023_scan_request_fingerprint.sql` is required before a
guarded deploy; do not touch PayOS/payment or use a down-migration. Until a new
readiness receipt exists, the production receipt remains the direct Wrangler
deployment above; rollback is code-only to a schema-compatible SHA.

The deployed receipt is anchored to main SHA
`d1b06732f8a80db4e77986df31ff28d9f04641fa`; the pre-cleanup main head is
`41d2de6bc76331322cc63e8038432b0b02f60da1`.

## OCR image payload optimization (2026-09-13)

- Local candidate `src/web/lib/private-image.ts` now decodes gallery images in
  memory, caps the longest side at 2,000 px, and emits JPEG quality `0.82` only
  when the derivative is smaller; small images are never upscaled.
- The original `File` is not modified or persisted. Private-session fencing and
  cancellation cover the async bitmap/canvas path; unsupported browsers fall
  back to the existing `FileReader` data URL flow.
- The attached 1,086x1,448 receipt measured 2,116,353 bytes as PNG. A local
  JPEG quality-0.82 conversion measured 382,334 bytes (81.9% reduction) without
  changing pixel dimensions. Provider OCR recall has not yet been re-run on the
  browser-generated derivative.
- Regression coverage: `tests/unit/scan-privacy.test.tsx` now has 11 passing
  tests, including resize, no-upscale and cancellation cases.
- Status: **COMMITTED LOCALLY / NOT DEPLOYED** at `ba3d872eea2d677e38f94adb8355f493c4c45852`.
  Next action is device/browser OCR smoke with the attached receipt, then open
  the release review for promotion.
