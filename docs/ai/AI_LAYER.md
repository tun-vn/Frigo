# T06B grounded explanation layer

## Responsibility and contract

The optional presentation layer is downstream of the authoritative, persisted T04
result. It never generates a meal, changes eligibility or calculates a quantity,
nutrition, expiry, shortage, shopping result or budget. AI-generated recipes and
instruction rewriting are deferred; existing recipe instructions remain available.

`POST /api/v1/meal-planning/plans/:id/explanation` takes only
`{revision,slotId,locale:'vi'|'en'}`. Strict shared Zod schemas live in
`packages/domain/src/meal-planning-presentation.ts`. Authorization, creator-private
household scope, cookie/CSRF/owner fences, no-store responses, body limits and
sanitized errors are inherited unchanged from T06A. Missing/unselected slots fail
422; stale revisions fail 409. Membership and revision are rechecked after the
provider call so an obsolete explanation is not returned as the current one.

The server derives allowed fact/template IDs from the selected meal's persisted
`reasons`, not client data. The provider receives only locale and those IDs, never
recipe titles, instruction text, stock, private preferences, identity or numbers.
This avoids recipe/user-content prompt injection and unnecessary disclosure. The
system message explicitly denies tools, mutations and any new factual claims.

AI output must be a strict JSON object `{reasonCodes:[...]}` containing every
grounded ID exactly once. Unknown IDs, removed uncertainty, duplicates, prose,
HTML, Markdown, extra fields, malformed JSON and oversized output are rejected.
The provider can change ordering only; it cannot author a factual sentence. The
response binds plan/revision/slot and includes `source:'ai'|'deterministic'` and a
typed `fallbackReason`. The frontend renders reviewed/localized templates as text,
keeping all authoritative structured values and freshness separately visible.
These are snapshot explanations, never proof that stale stock remains available.

## Feature flag, cost and failure behavior

`MEAL_PLANNER_AI_ENABLED` must be exactly `true`; default and all other values
return deterministic reason IDs without calling a provider. Basic plan list/detail
reads, generation, swaps and shopping do not call AI. Explanation is on-demand.

`meal-planning-explanation.ts` reuses existing `AIRouter` and its native
`CloudflareAIProvider` transport with a bounded binding adapter. For this T06B
explanation route, the adapter fixes the existing
`@cf/meta/llama-3.1-8b-instruct` model, structured messages, temperature 0 and a
**256 output-token** cap, never tools or streaming. One call only, no automatic
retry/fan-out. Existing external provider chat implementations are deliberately
not used for explanations: they do not expose equivalent bounded-output
controls. T06B added no provider keys or configuration; the later OCR recovery
candidate has its own Qwen/fallback configuration and is documented separately
in `CURRENT_STATE.md` and `DEPLOYMENT.md`.

The caller waits at most **2500 ms** for the provider. Timeout returns the full
deterministic ID set; late output is ignored. The native binding interface does not
provide a cancellation guarantee, so an already-started request may finish after
that deadline; its output-token cap still applies. This is a response-time bound,
not a claim of canceled provider computation. Existing legacy friendly provider
outage prose is explicitly not accepted as AI success.

Disabled AI, empty reasons, absent native binding, explicit mock mode, timeout,
provider outage/rate rejection, malformed output or fabricated/dropped fact IDs all
fall back deterministically. Rejected raw outputs and provider errors are not
returned or logged. The route retains T06A's 10/minute/account/path limit and now
shares T07's 10/minute/account planner compute bucket with generation, regeneration,
swap and shopping. Non-atomic KV/isolate enforcement is still best-effort, not a
global atomic quota or monetary guarantee. See ADR-019 and `T07_H2_ABUSE.md`.

## Verification ownership

The final frontend implementation renders explanation IDs through localized React
text templates, never `dangerouslySetInnerHTML`. Reasons are visible before any AI
request and remain visible on network/API failure. Revision-keyed detail remounts
discard obsolete explanations. The native browser suite exercises disabled-AI
fallback against the real Worker; unit/HTTP suites cover enabled success, timeout,
missing provider, outage, malformed/invented/dropped output and post-latency fences.
Exact final commands/counts are in `T06B_VERIFICATION.md`; no live-provider success
is claimed. **AI-generated recipes remain deferred beyond T06B.**

Backend coverage lives in `tests/unit/meal-planning-explanation.test.ts` and
`tests/integration/meal-planning-presentation-http.test.ts`: strict grounding,
disabled/no-facts/missing-provider/outage/timeout fallback, bounded native calls,
catalog-title injection exclusion, creator/household/CSRF/owner guards, current-plan
ordering and reload discovery, bounded catalog choices, rejected unsafe swap,
revision conflicts and membership loss during AI latency, plus no domain writes.
Frontend/browser evidence and the mandatory T06B state/handoff updates are owned
by the coordinating task.

## Executed backend verification

- `pnpm exec vitest run tests/integration/meal-planning-presentation-http.test.ts tests/unit/meal-planning-explanation.test.ts tests/integration/meal-planning-http.test.ts tests/integration/meal-planning-persistence.test.ts`: **93 tests / 4 files PASS** (27 new HTTP, 18 AI unit, 48 existing T06A regressions).
- `pnpm typecheck`: **PASS**, including both web/test and Worker targets.
- `pnpm exec eslint packages/db/src/meal-planning.ts packages/domain/src/meal-planning-presentation.ts src/worker/routes/meal-planning.ts src/worker/services/meal-planning.ts src/worker/services/meal-planning-explanation.ts tests/integration/meal-planning-presentation-http.test.ts tests/unit/meal-planning-explanation.test.ts`: **PASS**.
- `git diff --check`: **PASS**.
- Review added a failing HTTP regression for membership revoked between the new
  current-plan membership check and lookup: expected 403, received 200 with null.
  Empty results now recheck membership; the complete focused suite above passed.
  Catalog-read membership loss and explanation source/fallback combinations are
  also covered without weakening existing assertions.

These are local backend checks, not live-provider or hosted/deployment evidence.
Full-project/browser gates are recorded by the coordinating task. No schema,
migration, T02–T05 algorithm, existing auth or payment code changed in this scope.
