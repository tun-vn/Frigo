# Frigo task board

## Completed release work

- T01-T07: COMPLETE.
- T01 ✅
- T02 ✅
- T03 ✅
- T04 ✅
- T05 ✅
- T06A ✅
- T06B ✅
- T07 ✅
- Release Integration ✅
- Release Publication ✅
- Main Integration ✅
- Main CI ✅

| Task | Status | Evidence |
| --- | --- | --- |
| T01 Domain/data foundation | COMPLETE | Preserved foundation and hardening lineage |
| T02 Recipe engine | COMPLETE | `0051276` / `ef13acd` in the merged release |
| T03 Ranking/personalization | COMPLETE | `01f9d87` / `3592de9` |
| T04 Weekly planner | COMPLETE | `ebd538b` |
| T05 Shopping/budget/waste | COMPLETE | `4f3f539` / `899b6d7` |
| T06A Backend/API/trust/persistence | COMPLETE | `9f420c0` / `ca60ced` / `c46330c` |
| T06B Frontend/UX/AI presentation/E2E | COMPLETE | `0fc78a4` / `6d4e873` |
| T07 Final hardening | COMPLETE | Final application SHA `0b20061e` |
| Release Integration | ✅ COMPLETE | Application integration in main at `23ef51d` |
| Release Publication | ✅ COMPLETE | Release docs published |
| Main Integration | ✅ COMPLETE | Main merge SHA `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d` |
| Main CI | ✅ PASS | Run `34396319671` |

## Next authorized work

- Production Reconciliation ✅ COMPLETE - post-cutover verified
- Production DB Migration ✅ COMPLETE - `frigo-db` ledger `0001`-`0023`
- Controlled Production Deployment ✅ COMPLETE - Worker SHA `bdb0dda0`
- OCR production recovery (maintenance) ✅ COMPLETE - deployed and verified
- Planner Rollout ⏳

Do not invent T08. OCR recovery is a bounded maintenance candidate, not a new
product task or a production deployment. Planner rollout remains separately
authorized work.

GitHub source of truth: main.
Deployed application SHA: `bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`.
Post-deployment GitHub `main` changes are documentation-only receipt merges; the
OCR candidate is merged and deployed at 100% traffic.
Current `github-frigo/main`: `db2377fd9f63d1be38ce3882c6d8173e0bf9e497`;
the `codex/ocr-production-recovery` branch was merged via PR #17 and its code is
deployed in production.
Release Integration: COMPLETE.
Main Integration: COMPLETE.
PRE_CLEANUP_MAIN_HEAD: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
APPLICATION INTEGRATION: complete in main at `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
Production reconciliation: COMPLETE - schema/code/health/traffic verified.
Production DB migration: COMPLETE - exact ledger `0001` through `0023`.
Production deployment: COMPLETE - version `df7225c9-6f20-4206-9f16-573de6a69c43`.
Planner rollout: NOT STARTED.

## OCR image optimization maintenance (2026-09-13)

- Browser preprocessing candidate: **IMPLEMENTED LOCALLY, NOT DEPLOYED**.
- Scope: in-memory resize cap (2,000 px), JPEG quality 0.82, smaller-output
  guard, cancellation/session fencing and FileReader fallback.
- Evidence: 11/11 focused privacy/image tests pass; sample receipt conversion
  measured 81.9% smaller at unchanged 1,086x1,448 dimensions.
- Gate: run browser/device OCR recall and latency smoke before committing or
  promoting; do not alter PayOS, schema or provider secrets.
OCR recovery status: COMPLETE - DEPLOYED AND VERIFIED.
Next task: monitor OCR quality/latency and schedule the separate React Router upgrade.

## Frozen release evidence

- PRODUCTION_APPLICATION_BASE_SHA:
  `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- Verified application SHA: `0b20061e7dc7405df68b18a18da4166e09494ecd`.
- Verified release head: `0420807968538f61b669569d064c404f67032174`.
- Previous final-head CI: `34405307196 SUCCESS`.
- Previous release deploy workflow: `34396457582 SUCCESS`.
- Full: **1,487 tests / 87 files PASS**; focused: **819 tests / 40 files PASS**.
- D1: **23 / 23 migrations PASS**; upgrade **0020 -> 0023 PASS**.
- Existing rows preserved: **776 rows / 58 tables**.
- Browser: **264 assertions / 36 phases PASS**.
- Payment-adjacent: **82 tests / 7 files PASS**.
- Previous docs-cleanup deploy workflow `34405457796`: packaging completed; staging was not
  provisioned and no staging deploy occurred. The current production cutover was
  completed directly with Wrangler OAuth because GitHub production configuration
  is not provisioned.

## PR #8 metadata and archival branches

PR #8 METADATA: `MERGED`, `isDraft=false`, merged and closed at
`2026-09-09T19:38:59Z`, merge commit `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
Application integration is complete in main at `23ef51d`; do not merge PR #8 or
kirrha again. Kirrha remains archival documentation-only divergence.

## Protected areas

PayOS/payment code untouched.

No real payment performed.

Local production source checkout is untouched; the production D1 schema was
updated only through the approved additive migrations.

The OCR recovery worktree is separate from the production checkout. It adds the
unapplied candidate migration `0023_scan_request_fingerprint.sql` locally and
has not changed remote D1, production secrets or Worker traffic.

## Production cutover receipt (2026-09-10)

- Worker readiness: `status=degraded`, `environment=production`, full commit
  `bdb0dda0b1123c4fd940058091e3cb285d5e8eb8`; active version
  `df7225c9-6f20-4206-9f16-573de6a69c43` at 100%.
- Landing/liveness/readiness smoke passed; readiness database/queue/AI/email are
  healthy/configured and only `CONFIG_PLUS_GRANT_SECRET_MISSING` remains as a
  warning.
- Remote D1 exact ledger is `0001`-`0023`; schema gate passes and FK violations are `0`.
- Strict Week reconciliation passes 2/2 plans with 0 orphans and 0 mismatches.
- Preserved counts: users 28, households 28, inventory items 13, recipes 59,
  meal plans 2, scan queue jobs 15, sessions 2 and auth OTPs 0.
- Backup export is retained at
  `.artifacts/frigo-db-pre-main-d1b0673-20260910T205627Z.sql` with
  SHA-256 `000c9cb88d6045afb19cca6ce3e1caa308b20ffa214dbb2cddfca0cb78d722eb`.
- CORS allows the exact trusted origin and emits no ACAO for path-bearing,
  localhost or arbitrary origins. No planner flag, PayOS/payment path or secret
  value was changed. The separate T08 `xanthos` branch contains
  application/migration changes and is not part of authoritative `main`.
- Follow-up: test and schedule the React Router `>=7.18.0` upgrade for the two
  moderate production dependency advisories; do not patch it ad hoc in this
  receipt-only cutover.

## OCR production-recovery candidate (2026-09-12)

| Area | Candidate state | Release boundary |
| --- | --- | --- |
| Provider/model | Qwen `qwen3.7-flash` via DashScope international (`QWEN_BASE_URL`/`QWEN_MODEL`) is primary for vision, receipt OCR, chat and ranking; Groq is disabled unless `GROQ_FALLBACK_ENABLED=true`; Cloudflare vision fallback is opt-in via `CLOUDFLARE_VISION_FALLBACK`; DeepSeek requires `DEEPSEEK_FALLBACK_ENABLED=true` and GLM requires `GLM_FALLBACK_ENABLED=true` | Deployed at 100%; readiness `ai=configured` |
| Output quality | Zod validation plus rejection of generic/placeholder labels and confidence below `0.6`; empty usable output is `AI_SCAN_NO_USABLE_ITEMS` | OCR remains untrusted draft data and requires review/confirmation |
| Queue failures | Typed permanent `MODEL_NOT_FOUND`/auth/permission/license/schema/invalid-response/quality failures; bounded retries for `REQUEST_TIMEOUT`/`NETWORK_ERROR`/`RATE_LIMITED`/`UPSTREAM_ERROR` | Existing lease, idempotency, tenant fencing, max attempts and DLQ remain authoritative |
| Schema/data | Additive `0023_scan_request_fingerprint.sql`; no backfill or inventory/auth/Week/PayOS change | Local and remote D1 cover `0001`-`0023`; Worker deploy remains pending |
| Verification | Local/hosted gates PASS; live Qwen `qwen3.7-flash` smoke HTTP 200; D1 `0023` applied and gated; Worker version `df7225c9-6f20-4206-9f16-573de6a69c43` readiness HTTP 200 at 100% traffic | Monitor quality/latency; only `CONFIG_PLUS_GRANT_SECRET_MISSING` remains as a warning |

Candidate commits `ec87aec` and `56968ba` were merged through PR #17. Local and
hosted validation, live Qwen smoke, migration, deployment and readiness receipts
are complete; continue monitoring OCR quality and latency.

## Qwen-only runtime / cost governance candidate (2026-09-13)

| Area | Status | Evidence / next action |
| --- | --- | --- |
| Task taxonomy and logical role routing | IMPLEMENTED LOCALLY | `packages/ai/src/model-governance.ts`, `task-runtime.ts`; routing coverage is included in the full 1,606-test gate |
| Qwen-only Worker composition | IMPLEMENTED LOCALLY | scan HTTP, queue and explanation use shared config; production vars set `AI_QWEN_ONLY=true`; legacy adapters are not constructed on this path |
| Budgets, structured validation and escalation | IMPLEMENTED LOCALLY | bounded attempts/calls/tokens, Zod parse, quality gate, repair and model-capability fallback tests pass |
| Cost/usage telemetry | IMPLEMENTED LOCALLY | `AIUsageLedger`, non-PII Worker usage logs, provider usage parsing, and shadow budget reservation |
| Golden fixtures / offline harness | IMPLEMENTED LOCALLY | `tests/fixtures/ai-golden.json`; `pnpm ai:eval -- --dry-run` PASS with no live request |
| Local application checkpoint | `21c442d` | `pnpm check` PASS: 1,606 tests / 95 files, lint/typecheck/migrations/build PASS |
| Dependency audit | FOLLOW-UP REQUIRED | `pnpm audit --prod` reports two moderate `react-router` advisories; test the separate `>=7.18.0` upgrade |
| Production deployment | NOT AUTHORIZED | Do not deploy; obtain review, benchmark and hosted CI evidence first |

The candidate branch is based on canonical main SHA
`05423f2ad675006a4c7913e696f1979b3fcaae59`; canonical main and production
remain untouched. Reasoning and judge roles are disabled by default, and the
rolling `qwen3.7-flash` alias is canary-only.
