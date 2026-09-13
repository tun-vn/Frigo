# Scan Queue Contract

`frigo-scan-queue` uses at-least-once delivery. The Worker consumer accepts
only versioned, tenant-scoped messages:

```json
{
  "type": "scan.process.v1",
  "jobId": "scan_job_scan_123",
  "scanId": "scan_123",
  "userId": "user_123",
  "householdId": "household_123",
  "imageKey": "users/user_123/scans/scan_123/original.webp",
  "scanType": "fridge",
  "idempotencyKey": "scan_123:v1"
}
```

The consumer persists `scan_queue_jobs` and transitions both the job and scan
through `pending -> processing -> ready` or `failed`. A duplicate delivery is
acknowledged without invoking AI again. A processing lease older than ten
minutes may be reclaimed after a crashed isolate. Retryable AI/R2 failures are
requeued for up to `max_attempts` (default 3); invalid messages, missing scans,
missing images, and tenant conflicts are permanent failures and are acked after
being logged (jobs with a valid scan are also recorded as `failed`). The
production consumer is configured with the Cloudflare dead-letter queue
`frigo-scan-dlq` for retained poison-message payloads after retry exhaustion.

AI provider failures use a typed classification rather than retrying every
exception. `MODEL_NOT_FOUND`, `AUTHENTICATION_FAILED`, `PERMISSION_DENIED`,
`LICENSE_REQUIRED`, `SCHEMA_VALIDATION`, `INVALID_RESPONSE` and
`AI_SCAN_NO_USABLE_ITEMS` are permanent for the current job. `REQUEST_TIMEOUT`,
`NETWORK_ERROR`, `RATE_LIMITED` and `UPSTREAM_ERROR` are retryable until the
normal attempt limit. `scan_queue_jobs.error_code` stores the bounded
classification; the public scan status exposes only an actionable code/message
and attempt counters, never provider credentials or raw image data.
OCR output is still an untrusted review draft and must not bypass confirmation.

Before sending jobs, apply the complete migration ledger through the candidate's
current migration (including `0012_scan_queue_jobs.sql` and, for the OCR
recovery candidate, `0023_scan_request_fingerprint.sql`) to the target D1
database and verify with `pnpm check:migrations`/the remote schema gate. Deploy
the Worker only after the schema gate confirms the new columns are present.

## Canary rollout

`SCAN_QUEUE_MODE=async` is the production setting after provider smoke
validation. Use `SCAN_QUEUE_MODE=sync` as the rollback switch if queue health
degrades, then send a small test cohort after recovery,
and watch queue metrics plus `scan_queue_jobs` status transitions. Roll back to
`sync` if retry rate, consumer lag, or failed jobs increase; pending scans can
then be reprocessed by the synchronous endpoint without changing the D1 schema.

For the Qwen runtime candidate, verify the role aliases and DashScope access with
a non-PII provider smoke before deployment. Production sets
`AI_QWEN_ONLY=true`, so Groq, Cloudflare, DeepSeek and GLM are not constructed;
their adapters remain compatibility-only when Qwen-only mode is disabled.
Reasoning/judge roles are off by default. A model/license/configuration failure
is not repaired by replaying the same message; fix configuration or upload a
new scan.
The recovery adds migration `0023_scan_request_fingerprint.sql` and must remain
marked unreleased until exact-SHA CI, guarded migration, readiness and canary
evidence are recorded.
