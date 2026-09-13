# Frigo Release Candidate / GitHub Release Finalized

> Historical release receipt. The separate `codex/ocr-production-recovery`
> worktree is an unreleased candidate and is not included in the deployment
> facts below.

## Engineering

- T01-T07: COMPLETE.
- APPLICATION INTEGRATION: complete in main at `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- PRODUCTION_APPLICATION_BASE_SHA: `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- PRE_CLEANUP_MAIN_HEAD: `41d2de6bc76331322cc63e8038432b0b02f60da1`.
- Verified application SHA: `0b20061e7dc7405df68b18a18da4166e09494ecd`.
- Verified final release head: `0420807968538f61b669569d064c404f67032174`.
- Main merge SHA: `23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`.
- Deployed application SHA: `d1b06732f8a80db4e77986df31ff28d9f04641fa`.
- Main has advanced only through documentation-only receipt merges after the
  deployed application; resolve its current head from GitHub for a future release.
- The main merge tree is source-equivalent to the verified release head.
- Release Integration: COMPLETE.
- Release Publication: COMPLETE.
- Main Integration: COMPLETE.

## Verification evidence

- Full: **1,487 tests / 87 files PASS**.
- Focused T02-T07: **819 tests / 40 files PASS**.
- D1 clean: **22 / 22 migrations PASS**.
- Upgrade sanity: **0020 -> 0022 PASS**.
- Existing rows preserved: **776 rows / 58 tables**.
- Browser: **264 assertions / 36 phases PASS**.
- Payment-adjacent: **82 tests / 7 files PASS**.
- Final release CI: **PASS**.
- Main CI: 34396319671 SUCCESS.
- Previous final-head CI: 34405307196 SUCCESS.
- Historical PR #8 validation: 34394236696 SUCCESS.

The verified release head, verified application SHA and application release merge
are all ancestors of current main. The diff from the verified release head to
the application release merge is empty, and all later changes are docs-only.

## Deployment workflow

- Previous release deploy workflow: `34396457582 SUCCESS`.
- Previous docs-cleanup deploy workflow: `34405457796 SUCCESS`.
- Release packaging completed.
- Staging not provisioned / no staging deploy. Build, exact-head recheck, staging
  deploy and smoke steps were skipped after the configuration check.
- Production deployment completed directly with Wrangler OAuth because the
  GitHub production environment/secrets are not provisioned.
- Production D1 `frigo-db` is at migration `0022`; no migration was rerun during
  deployment.

Post-cutover local gates: `pnpm lint`, `pnpm typecheck`,
`pnpm check:migrations` and `pnpm build` PASS. Local `pnpm test` reports
1,427/1,487 PASS; its 60 failures are confined to two UI suites whose shell
runner lacks functional `localStorage`/`container`. Hosted exact-SHA CI
`34413458369` remains the authoritative 1,487/87 PASS gate.

`pnpm audit --prod` reports 2 moderate `react-router` advisories through
`react-router-dom`; the upstream fix requires React Router `>=7.18.0`, so this
cutover leaves the dependency unchanged and schedules a separately tested
major-version upgrade.

## Feature flags and rollout

Checked-in planner/UI/AI safe defaults remain according to the existing rollout
policy. No planner flags or production secrets were changed.
Planner rollout: NOT STARTED.

### OCR recovery candidate (unreleased)

The current worktree adds a Qwen-first provider configuration, but this
historical release receipt does not claim it is deployed. Qwen `qwen3.7-flash`
is the primary vision/receipt/chat/ranking model through the DashScope
international endpoint. Groq is disabled unless `GROQ_FALLBACK_ENABLED=true`;
Cloudflare Vision is opt-in through `CLOUDFLARE_VISION_FALLBACK`. DeepSeek
remains the optional text/ranking fallback when
`DEEPSEEK_FALLBACK_ENABLED=true`, and Z.ai/GLM the optional vision/text
extension path when `GLM_FALLBACK_ENABLED=true`. GLM-5.3 Flash is
future model work, not an active production setting. Full local candidate gates
passed on 2026-09-13 (1,579 tests / 93 files, lint, typecheck, migration replay
and build); hosted PR #17 CI run `34728606704` is green. Live non-PII smoke,
readiness and canary evidence are still required before release.
A read-only probe of the supplied test credential against `https://api.b.ai/v1/models`
returned HTTP 401 (`Invalid token`); the credential was not persisted.

The candidate adds `0023_scan_request_fingerprint.sql` for durable scan replay
identity. Local candidate checks must cover migrations `0001`-`0023`; production
D1 remains at `0022` until the migration is explicitly applied during release.

## Production

PRODUCTION RECONCILIATION COMPLETE - SCHEMA/CODE CUTOVER VERIFIED

Production reconciliation: COMPLETE - post-cutover source, schema, health and
traffic checks passed.

PRODUCTION DATABASE MIGRATION COMPLETE

Production DB migration: `frigo-db` exact ledger `0001` through `0022`.

PRODUCTION DEPLOYMENT COMPLETE

Production deployment: Worker version
`48e0c366-3c8a-4f2b-a2d5-965785995431`, 100% traffic.

### Production cutover receipt (2026-09-10)

- Live Worker `https://frigo.tungjpstore.net`: liveness and landing smoke return
  HTTP 200; readiness returns HTTP 200 `status=degraded`,
  `environment=production`, and full commit
  `d1b06732f8a80db4e77986df31ff28d9f04641fa`.
- Active Cloudflare version is `48e0c366-3c8a-4f2b-a2d5-965785995431` at 100%
  traffic. Readiness services are database/queue/AI/email `ok` or `configured`,
  rate limiting is `kv-best-effort`, and the only issue is the non-blocking
  warning `CONFIG_PLUS_GRANT_SECRET_MISSING`; no fatal configuration issue is
  present.
- The deployed Worker reports the approved main SHA; no source-only divergence
  remains on the public runtime.
- Exact remote schema gate and ledger check pass: all 22 migrations are present,
  foreign-key violations are `0`, and Week strict reconciliation is 2/2 plans
  with 0 orphan rows and 0 mismatches.
- Preserved counts: users 28, households 28, inventory items 13, recipes 59,
  meal plans 2, scan queue jobs 15, sessions 2 and auth OTPs 0.
- Backup export is retained locally at
  `.artifacts/frigo-db-pre-main-d1b0673-20260910T205627Z.sql`, mode 600,
  SHA-256 `000c9cb88d6045afb19cca6ce3e1caa308b20ffa214dbb2cddfca0cb78d722eb`.
- CORS returns the exact ACAO for the trusted origin and no ACAO for
  path-bearing, localhost or arbitrary origins.
- No planner flag, PayOS/payment path or secret value was changed.

## Source of truth

GitHub source of truth: main.

GitHub `main` is the authoritative release source and the production Worker now
reports the exact deployed main SHA above. The current GitHub head remains a
documentation-only continuation of the application base SHA.

## PR #8 metadata

PR #8 METADATA:

Authoritative GitHub API classification:

- `state=MERGED`
- `isDraft=false`
- `mergedAt=2026-09-09T19:38:59Z`
- `closedAt=2026-09-09T19:38:59Z`
- `mergeCommit=23ef51d6ec12a5a3e319a2d941dca39d2775cb9d`
- `base=main`
- `head=hoplite/kirrha-5f4057f0`
- `headSha=0420807968538f61b669569d064c404f67032174`

PR #8 was an historical release-integration vehicle. Its verified release tree
was merged into main before this cleanup. It was not reopened, re-merged or
modified during this task.

## Kirrha archival state

`hoplite/kirrha-5f4057f0` is two commits ahead of current main and differs in
four files only: the four `docs/ai/` release protocol documents. It contains no
application differences not already in main. Do not merge or revert this
historical documentation branch.

## Documentation-only boundary

This correction is limited to:

- `README.md`
- `DEPLOYMENT.md`
- `docs/SCAN_QUEUE.md`
- `docs/ai/RELEASE_CANDIDATE.md`
- `docs/ai/CURRENT_STATE.md`
- `docs/ai/DECISIONS.md`
- `docs/ai/TASK_BOARD.md`
- `docs/ai/HANDOFF.md`

NO APPLICATION CHANGE. PayOS/payment code untouched. No real payment performed.

## Next task

Next task: COMPLETE OCR RECOVERY VALIDATION BEFORE GUARDED DEPLOYMENT

Keep the deployed Worker and planner flags at safe defaults while the OCR
candidate is validated. Run focused provider/queue/UI tests and all required
local gates, then obtain authorized live-provider smoke, hosted CI, readiness and
canary evidence before any production deploy. Apply and verify additive migration
`0023_scan_request_fingerprint.sql` first; no production secret change is implied.
Do not touch PayOS/payment or use a down-migration. Configure the GitHub `production` environment,
`PRODUCTION_URL` and Cloudflare secrets before the next guarded release.

The deployed receipt is anchored to main SHA
`d1b06732f8a80db4e77986df31ff28d9f04641fa`; the pre-cleanup main head remains
listed above for historical traceability.
