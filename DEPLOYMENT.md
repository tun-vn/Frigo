# Frigo Deployment Guide

Operational runbook for CI/CD, environments, migrations, health, cleanup,
rate limiting, and rollback. All automated deploy steps live in
`.github/workflows/ci.yml` (validation) and `.github/workflows/deploy.yml`
(deployment). Nothing in this repository deploys automatically to production.

## Pipeline

```text
Pull request
     ↓
CI (ci.yml: lint, typecheck, tests, migration smoke, build)
     ↓
merge to main → CI runs again on main
     ↓
staging deploy (deploy.yml, after CI succeeds on main)   [requires wrangler.staging.jsonc]
     ↓
staging post-deploy smoke (read-only)
     ↓
production: manual workflow_dispatch + confirm input + GitHub Environment approval
     ↓
pre-deploy schema gate (read-only) → production deploy → production smoke
```

## CI (`.github/workflows/ci.yml`)

Runs on pull requests to `main`/`master` and pushes to `main`, `master`, and
`codex/security-hardening-sync`. Permissions are limited
to `contents: read`; fork PRs receive no secrets. Steps:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm check:migrations` — replays every migration into in-memory SQLite
   with foreign-key/integrity assertions (`scripts/migration-smoke.sh`)
6. `pnpm build`

## Staging

Staging is a separate Cloudflare deployment and must never share production
D1/KV/R2/queues. Configuration lives in `wrangler.staging.jsonc`
(git-committed), created from `wrangler.staging.jsonc.example`.

Manual setup (operator, once):

1. Provision in the Cloudflare account: D1 database (`frigo-db-staging`),
   KV namespace, R2 bucket. Do not reuse production identifiers.
2. Copy `wrangler.staging.jsonc.example` → `wrangler.staging.jsonc` and fill
   in the real staging IDs and `APP_URL` (the exact staging frontend origin).
   Provision independent staging `JWT_SECRET` and `OTP_HASH_SECRET` Worker
   secrets before exercising authentication. The template already sets safe staging vars
   (`ENVIRONMENT: staging`, `AI_MOCK_MODE: true`, `SCAN_QUEUE_MODE: sync`,
   Turnstile **test** keys, `workers_dev: true`).
3. `wrangler d1 migrations apply frigo-db-staging --remote --config wrangler.staging.jsonc`
4. GitHub: create a `staging` environment; add secrets
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; add the repository
   variable `STAGING_URL` (the workers.dev URL, e.g.
   `https://frigo-staging.<account>.workers.dev`).

Behavior:

- Deploys automatically after CI succeeds on a push to `main`.
- If `wrangler.staging.jsonc` does not exist, the job emits a notice and
  skips — staging is never half-configured, and it can never inherit
  production bindings from `wrangler.jsonc`.
- Staging smoke runs `scripts/post-deploy-smoke.sh "$STAGING_URL"`.

## Production gate

Production deploys are dispatched manually: **Actions → Deploy → Run
workflow **from main**, `environment: production`, `confirm_production: true`,
`ref: <full SHA or refs/tags/v*>`, and `hardened_sha: <exact approved final hardening SHA>`.
The release must be contained in main, contain that hardened commit, and have
successful exact-SHA main-push CI. The `production` job additionally runs under the GitHub
`production` environment.

Required GitHub configuration (manual, cannot be done in code):

1. Create a GitHub **Environment** named `production` with **required
   reviewers** (approval gate). Until configured, the confirm input is the
   only gate — configure reviewers before relying on this pipeline.
2. Add environment secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
   Scope the API token to this account/zone with Workers Scripts:Edit,
   D1:Edit, and Queue permissions. Never put credentials in YAML.
3. Required repository variable `PRODUCTION_URL`: an exact HTTPS origin matching
   the deployment's `APP_URL`. There is no hardcoded production smoke fallback.

The production job re-runs lint/typecheck/tests/migration-smoke/build, then:

1. **Pre-deploy schema gate (read-only):** `scripts/d1-schema-gate.sh remote`
   SELECTs the expected schema from remote D1. It does not mutate anything.
2. **Deploy:** `wrangler deploy --var GIT_COMMIT:<sha>`.
3. **Smoke:** `scripts/post-deploy-smoke.sh` — landing page, liveness, and
   readiness (must not be `unhealthy`, database must answer).

## Migrations

- Apply migrations once through Wrangler's migration ledger. The smoke test
  validates the full chain against fresh SQLite and repeats only selected
  idempotent backfills; it does not prove every migration can be run twice.
  Migrations 0014/0015 add columns, and 0017 rebuilds `auth_otps` without the
  plaintext `code` column. These are not unrestricted replay/rollback scripts.
- The pipeline **never applies remote migrations automatically**. If the
  schema gate fails because a new migration is missing, an operator applies
  it explicitly and re-dispatches:

  ```bash
  pnpm wrangler d1 migrations apply frigo-db --remote
  ```

- Order is validate → migration approval → deploy, so application code is
  never shipped onto an absent schema. New migrations are added to
  `scripts/migration-smoke.sh` (and `scripts/d1-schema-gate.sql`) as part of
  the same PR.

### Auth/queue hardening cutover

The release owner must confirm migrations **0014–0017** in the target D1 ledger
before deploying this hardening code. Do not assume the reported earlier
deployment applied them to the intended environment. Keep a recoverable D1
checkpoint and coordinate the schema/code cutover: pre-hardening auth code
cannot issue OTPs after 0017 removes `auth_otps.code`.

Migration 0015 intentionally clears legacy sessions; users must sign in again.
Migration 0017 discards challenges without HMAC digests, while preserving
digest-backed challenges. Keep `OTP_HASH_SECRET` stable to preserve those
challenges. Migration 0016 starts a new quota ledger; it does not backfill
pre-cutover scan usage. The product/release owner must accept that allowance
reset or approve a separate reviewed reconciliation before rollout. No remote
backfill or migration is performed by this PR.

The separate payment-owner review remains responsible for migration 0018 and
payment activation; this section does not certify payment behavior.

### OCR provider recovery candidate

The OCR recovery adds configuration/code plus the additive migration
`0023_scan_request_fingerprint.sql`; it has performed no remote data operation.
Apply and verify that migration before deploying the candidate Worker. Until an
exact-SHA deployment and readiness receipt are captured, the candidate must be
treated as unreleased and production remains on the previously recorded Worker
SHA.

The candidate sends vision, receipt, chat and ranking requests to Qwen
`qwen3.7-flash` through the DashScope international OpenAI-compatible endpoint
(`QWEN_BASE_URL`, `QWEN_MODEL`). Qwen is the first provider in every applicable
route and structured requests disable thinking to keep OCR latency bounded.
Confirm model access with a live, non-PII provider smoke before approval. Groq is
kept as a legacy compatible fallback only when `GROQ_FALLBACK_ENABLED=true`;
merely storing `GROQ_API_KEY` does not enable it alongside Qwen. Native
Cloudflare vision is only added when
`CLOUDFLARE_VISION_FALLBACK=true`, and its model/license must be verified
separately. DeepSeek remains the optional text/ranking fallback when
`DEEPSEEK_FALLBACK_ENABLED=true`, and Z.ai/GLM the optional vision/text
extension path when `GLM_FALLBACK_ENABLED=true`; a future GLM-5.3 Flash upgrade requires a
separate model/access verification. Never enable mock output in production to
mask provider failure.

Every fridge/receipt response is validated against the Zod contract and a
deterministic quality gate. Generic or placeholder labels and confidence below
`0.6` are discarded; if no usable row remains, the operation fails with
`AI_SCAN_NO_USABLE_ITEMS` and does not create a fabricated draft. Provider
errors are typed for queue policy: `MODEL_NOT_FOUND`,
`AUTHENTICATION_FAILED`, `PERMISSION_DENIED`, `LICENSE_REQUIRED`,
`SCHEMA_VALIDATION`, `INVALID_RESPONSE` and quality failures are permanent;
`REQUEST_TIMEOUT`, `NETWORK_ERROR`, `RATE_LIMITED` and `UPSTREAM_ERROR` may
retry within the existing queue attempt limit and dead-letter flow. Public scan
status returns bounded error codes/retry metadata, not provider credentials or
raw image content.

## Configuration safety (config gate)

`validateEnvironment(env)` (`src/worker/config/validation.ts`) runs on every
request in production (wired as `productionConfigGate`). Fatal issues reject
the request with `503 CONFIG_INVALID` plus sanitized issue **codes** —
messages never embed secret values or binding IDs. Non-production is never
gated; development runs via `pnpm dev:worker`, which forces
`--var ENVIRONMENT:development`.

Fatal in production: missing/invalid/non-HTTPS `APP_URL` (including loopback), `AI_MOCK_MODE=true`,
`WEEK_SCHEMA_MODE != dual`, `SCAN_QUEUE_MODE != async`, missing `DB`,
`CACHE`, `JWT_SECRET`, `OTP_HASH_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
missing `QWEN_API_KEY`, missing `SCAN_QUEUE` while async, or missing `IMAGES` while
async scan processing is enabled. The native `AI` binding is required only when
`CLOUDFLARE_VISION_FALLBACK=true`; it is not required for the Qwen-primary path.

`wrangler.jsonc` versions the existing production frontend origin as `APP_URL`;
review any environment override against the exact origin sending cookie
requests. The staging template's origin placeholder must be replaced. Missing
or malformed origins now fail readiness instead of appearing healthy while
CSRF denies authentication requests.

The auth/release owner provisions `OTP_HASH_SECRET` as an independent random
secret (at least 32 random bytes recommended) in each Worker environment, never
in Wrangler vars, Git, or frontend bundles. `.dev.vars.example` lists the local
secret names without values. No credential rotation is required by the
stabilization patch. Rotating the OTP key invalidates outstanding challenges;
there is no multi-key fallback, so coordinate intentional rotation and code
resends rather than changing the key on every deployment.

The OCR recovery candidate defaults to Qwen `qwen3.7-flash` through
`QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1` and
`QWEN_MODEL=qwen3.7-flash` (`packages/ai/src/providers/qwen.ts`).
`GROQ_FALLBACK_ENABLED=false` keeps the legacy Groq adapter out of the provider
chain; `CLOUDFLARE_VISION_FALLBACK=false` likewise keeps native Cloudflare vision
opt-in. `DEEPSEEK_FALLBACK_ENABLED=false` and `GLM_FALLBACK_ENABLED=false` keep
those extension providers disabled until explicitly enabled. The AI/provider
owner must confirm model access and capture a non-PII live smoke before
deployment; mock-AI tests and the isolated preview do not verify live provider
availability.

Warnings (reported, non-blocking): no email provider (`SEND_EMAIL` binding or
`RESEND_API_KEY`), missing `PLUS_GRANT_SECRET`. Turnstile is not optional in
production: either missing/blank key is fatal, including when both are absent.
Explicit development/staging may omit the pair; configured secrets still enforce
verification. Login, registration, forgot-password and OTP resend require tokens.

## Health / readiness

- `GET /api/v1/health` — public liveness, minimal payload (`status`, `app`,
  `timestamp`). No environment or feature-flag disclosure.
- `GET /api/v1/health/ready` — sanitized readiness for load balancers and
  operators: `status` ∈ `ok | degraded | unhealthy` (HTTP 200 / 200 / 503),
  per-service states (`database`, `queue`, `ai`, `email`, `rateLimiting`),
  config issue codes, and deployment traceability (`version`, `commit` from
  the `GIT_COMMIT` var). Unauthenticated but sanitized by construction — no
  secrets, tokens, or binding IDs.
- `GET /api/v1/config` — public Turnstile site key (unchanged).

### Scan failure and retry observability

`scan_queue_jobs.error_code` records the bounded classification used for the
current attempt. Permanent provider/configuration/data-quality failures move the
scan to `failed` immediately and are acknowledged; retryable transport/provider
failures return to `pending` until `max_attempts` is reached, then follow the
existing `frigo-scan-dlq` path. The queue still preserves tenant fencing,
idempotency and lease reclaim. A failed scan may be retried with a new upload;
do not replay a known permanent model/license/schema failure without changing
the underlying configuration or input.

## Scheduled cleanup

`wrangler.jsonc` sets a daily `0 3 * * *` UTC cron. `src/worker/services/cleanup.ts`
deletes, per retention window (env-overridable, days):

| Task | Target | Default |
| --- | --- | --- |
| expired OTPs | `auth_otps` past `expires_at` | `CLEANUP_OTP_RETENTION_DAYS=7` |
| expired sessions | `sessions_v2` past `expires_at` | `CLEANUP_SESSION_RETENTION_DAYS=30` |
| stale scan reservations | old `reserved` quota rows and pending queue intents | `CLEANUP_RESERVED_SCAN_RETENTION_MINUTES=60` |
| terminal ready jobs | `scan_queue_jobs` status `ready` | `CLEANUP_READY_JOB_RETENTION_DAYS=30` |
| terminal failed jobs | `scan_queue_jobs` status `failed` | `CLEANUP_FAILED_JOB_RETENTION_DAYS=90` |

Properties: replay-safe (plain DELETEs, safe to run twice), never touches
`pending`/`processing` jobs or live rows, timestamps normalized through
`datetime(column)` because the app writes ISO strings while D1 defaults write
`YYYY-MM-DD HH:MM:SS`, production skips all cleanup when the config gate is
fatal, and per-task failures are reported (not thrown) so one bad table never
cancels the rest. Session revocation is authoritative in D1
`sessions_v2.revoked_at`; historical KV `revoked_*` entries are not consulted.

## Rate limiting

`src/worker/middleware/rate-limit.ts`:

- **Primary:** Cloudflare KV — the only globally coherent limiter available.
- **Degraded (best-effort, default):** on KV failure or unbound namespace the
  limiter falls back to isolate-local counters, sets
  `X-RateLimit-Mode: degraded-isolate-local`, and logs a one-time warning.
  Isolate-local counters are NOT globally atomic (many isolates per worker)
  — this is abuse control, not enforcement.
- **Fail-closed:** `enforcement: 'fail-closed'` on a limiter (or the
  `RATE_LIMIT_ENFORCEMENT=fail-closed` var production-wide) rejects requests
  with `503 RATE_LIMIT_UNAVAILABLE` when KV fails in production. Recommended
  for security-critical limiters (auth/OTP — owned by Thread 2, not yet
  applied here to avoid touching auth routes). Do not use rate limiting for
  quota/financial enforcement.

## Rollback

- **Code rollback:** redeploy a known-good, migrated-schema-compatible SHA — *Actions → Deploy → Run
  workflow*, `environment: production`, `confirm_production: true`,
  `ref: <previous-good-sha>` and the approved compatible `hardened_sha`.
  The target must contain the repository's minimum hardening floor and pass
  exact-SHA CI/migration-ledger checks. Same gates run. Concurrency is serialized
  (`cancel-in-progress: false`), so an in-flight deploy must finish first.
  After 0017, do not select a pre-hardening SHA that reads/writes plaintext
  OTPs or authenticates legacy sessions. Prefer a forward fix or a tested
  compatible hardening release.
- **Data rollback:** the hardening schema is not a universal superset: 0017
  removes the plaintext OTP column and 0015 clears old sessions. Do NOT revert D1 migrations in
  production (no down-migrations exist). If a migration must be undone,
  restore from a D1 time-travel restore / export and treat it as an incident.
- **Week dual-write:** shadow writes keep legacy and canonical tables in sync
  during rollbacks; never flip `WEEK_SCHEMA_MODE` away from `dual` as part of
  a rollback (the config gate fails closed if you do).
- **Queue consumer:** a rollback must retain the 0014 claim-token fencing
  contract while jobs are in flight. A pre-fencing worker is not a safe
  rollback target merely because the extra columns exist. Compatible workers
  reclaim leases; poison messages still land in `frigo-scan-dlq`.
- **OCR recovery rollback:** the candidate adds the additive `0023_scan_request_fingerprint.sql`
  migration. Roll back only to a Worker that is schema-compatible with 0023 (or
  restore the pre-0023 database backup as an approved incident action). Do not
  use a mock fixture as a production fallback. If candidate queue jobs contain
  new typed error codes, inspect/retry them only after the selected Worker
  understands the codes; otherwise upload a fresh scan after restoring provider
  configuration.
- **Config rollback:** if a config mistake shipped, fix the var/secrets and
  redeploy; the config gate blocks any request until configuration is valid
  (fail closed, loud).

## Traceability

Every deploy stamps `GIT_COMMIT` (Wrangler var). `/api/v1/health/ready`
exposes `commit` + `version` + `environment`; workflow logs show the exact
SHA deployed. Structured production request logs include `requestId`,
`method`, `path`, `status`, `durationMs` (response header `X-Request-Id`).

## Final hardening release cutover

`scripts/release-check.mjs` is a source-only release gate, with local tests.
It validates main ancestry and immutable refs, the approved hardened ancestor,
the latest exact-SHA main-push CI run, and a contiguous migration manifest with
SHA-256 checksums. The workflow stores candidate/production manifests for 90 days;
the release owner must archive approved receipts longer-term. Candidate validation
is not proof of deployment: the production receipt must also contain the observed
D1 migration names and a readiness response matching the exact SHA/environment.
Source migration checksums do not certify the contents of the remote database.

1. Before rollout, the owner independently establishes the actual production SHA
   and migration ledger. Repository deployment metadata currently does not prove
   either. Preserve any production-ahead commits; never force-push main.
2. Review PR #2 and require green hosted checks at its exact final head. Merge
   normally with a **merge commit**, retaining the exact hardened commits.
   Squash/rebase merging breaks the ancestry gate and is not the prescribed cutover.
3. Require successful CI on the resulting main SHA; create an approved release tag
   on that SHA. Dispatch the workflow from main, selecting that immutable SHA/tag
   and the final hardening SHA. Configure required production Environment reviewers
   separately; source code cannot enforce the repository's reviewer settings.
4. Confirm stable `OTP_HASH_SECRET`, mandatory production Turnstile keys, HTTPS
   `APP_URL`, exact `PRODUCTION_URL`, Qwen model/license/provider availability
   and the appropriate schema/code cutover. For this OCR candidate, verify
   `qwen3.7-flash` through the configured DashScope endpoint, plus any explicitly
   enabled Groq/Cloudflare/GLM fallback, with a non-PII smoke. No remote
   migrations run automatically.
5. Production approval, deployment, readiness/SHA receipt and monitoring are
   separate owner actions, not performed by final hardening.

**Rollback compatibility:** migrations 0015 and 0017 intentionally invalidate old
sessions/remove plaintext OTP storage. Pre-hardening auth is not a safe code
rollback on a database at 0017+. New challenges use contextual HMAC v2; old v1
challenges remain valid only until expiry. A rollback must understand v2 (or
explicitly invalidate outstanding challenges), opaque sessions, quota ledger,
queue fencing and Week dual-write. Database restoration is a separate approved
incident procedure, not a code rollback. Unknown later migration names block the
release gate until explicitly reviewed.

Local development now defaults Vite's API proxy to `127.0.0.1:8787`, never the
production hostname. The managed preview uses `scripts/security-preview.mjs`
(in-memory SQLite, no outbound backend fetch, no real mail/AI). Verify
`/api/v1/health/ready` reports `development` before any local browser mutation.
