# Architecture Decisions

## ADR-020 — Recoverable OCR provider selection and quality-gated queue failures

**Status:** Accepted 2026-09-12 for the OCR production-recovery candidate; this
record is not a production deployment receipt.

**Context:** The deployed application lineage is anchored to `d1b06732`, while
the current recovery worktree must handle provider model retirement, malformed or
placeholder vision output, and queue retries that cannot repair a permanent
configuration or data-quality failure. OCR remains an untrusted draft source and
must not become an authority for inventory quantities, prices or safety claims.

**Decision:** The recovery candidate keeps `AIRouter` as the single provider
boundary and makes Qwen `qwen3.7-flash` the first provider for vision, receipt
OCR, chat and ranking through the DashScope international OpenAI-compatible
endpoint (`QWEN_BASE_URL`, `QWEN_MODEL`). Structured requests disable thinking
to bound OCR latency. Groq remains a legacy compatible fallback only when
`GROQ_FALLBACK_ENABLED=true`; native Cloudflare vision is added only when
`CLOUDFLARE_VISION_FALLBACK=true`. DeepSeek remains the optional text/ranking
fallback only when `DEEPSEEK_FALLBACK_ENABLED=true`, and Z.ai/GLM the optional
vision/text extension path only when `GLM_FALLBACK_ENABLED=true`. The deployed
SHA is not changed by this record. Production mock fallback remains disabled.

Every fridge or receipt result is parsed through the existing Zod contracts and a
quality gate that removes generic/placeholder labels and confidence below `0.6`;
an empty usable set returns `AI_SCAN_NO_USABLE_ITEMS`. Providers expose typed
errors with retry intent. `MODEL_NOT_FOUND`, `AUTHENTICATION_FAILED`,
`PERMISSION_DENIED`, `LICENSE_REQUIRED`, `SCHEMA_VALIDATION`, `INVALID_RESPONSE`
and `AI_SCAN_NO_USABLE_ITEMS` are permanent. `REQUEST_TIMEOUT`, `NETWORK_ERROR`,
`RATE_LIMITED` and `UPSTREAM_ERROR` may retry within the existing queue attempt
limit and dead-letter flow. Public scan responses expose bounded, actionable
failure codes without provider credentials or raw image data.

**Consequences:** This is a code/config recovery with one additive D1 migration
(`0023_scan_request_fingerprint.sql`) and no data backfill, inventory/auth/Week/
PayOS change or automatic production deployment. The migration must be applied
and schema-gated before deploying code that reads the new scan identity columns.
The existing queue lease, idempotency, tenant fencing and rollback rules remain
authoritative. Candidate model access, provider licensing, exact-SHA CI, canary
health and readiness must be verified before release. OCR output still requires
human review/confirmation and does not create trusted retail offers.

The initial 20-25 second timeout was insufficient for full-page receipt OCR: a
production-sized Vietnamese receipt took about 51 seconds in a non-PII Qwen
smoke. The candidate therefore uses a 60 second Qwen request timeout and a 75
second Worker/queue guard, while retaining the existing 10 minute queue lease.

**Alternatives considered:** Retrying every provider error, silently falling back
to mock fixtures in production, or treating any syntactically valid OCR line as
usable. Rejected because retries cannot fix permanent provider/configuration
failures and fabricated or low-quality rows could enter a household draft.

## ADR-019 — T07 planner-wide best-effort account compute budget

**Status:** Accepted 2026-09-09 after authenticated fan-out reproduction.

**Decision:** Add one planner-only `planner-compute:<authenticated-user>` bucket
at 10 requests per 60 seconds for generation, regeneration, swaps, shopping and
on-demand explanations, alongside existing per-path controls. Keep read/feedback,
auth and payment policies unchanged. Reuse the installed limiter rather than
introducing a quota/reservation platform.

**Evidence and consequences:** Alternating two plan IDs previously admitted an
eleventh compute request; regressions now reject it before T04. KV read/put remains
non-atomic and eventually consistent, with same-key write throttling and explicit
isolate-local fallback. Neither fail-closed nor the account key promises an exact
global quota. Keep hard per-request search bounds and staged rollout; require a
separate recovery-safe atomic design only if measured abuse demands it. Exact
tests, guarantees and Cloudflare references are in `T07_H2_ABUSE.md`.

## ADR-018 — T06B opt-in presentation and minimal plan discovery

**Status:** Accepted 2026-09-09 for the authorized T06B task.

**Decision:** Reuse React Router, TanStack Query, owner-fenced cookie transport,
existing cards/buttons/dialogs and Frigo colors. `VITE_MEAL_PLANNER_ENABLED=true`
enables `/planner`; the independent server flag remains authoritative. Legacy Week
is retained. The browser sends scheduling/action intent, never engine contexts,
shortages or prices. Queries are owner-scoped, mutations are explicitly triggered,
revision-fenced and not retried automatically. Swap/regenerate replace the entire
plan response and discard previous shopping results. Past plans remain historical;
creating a new future plan is explicit rather than silently editing past meals.

T06A lacks cross-device discovery and a named swap-choice source. Add only a
creator/household-scoped current-plan lookup and a bounded read-only recipe-title/ID
catalog projection. Choices are not eligibility claims: the unchanged swap service
checks restrictions and replans. No new persistence or engine algorithm is needed.

Optional on-demand AI may reorder/select only server-grounded reason IDs. It returns
no factual prose, tools or commands. Schema/subset validation, a bounded timeout,
feature disable and deterministic fallback keep structured facts separate and safe.
Frontend vi/en text templates display the same reasons without any AI dependency.
Exact money is formatted through BigInt/Intl parts; authoritative arithmetic stays
on the server. Shopping checkboxes are ephemeral reminders, not purchases.

**Consequences:** No frontend plan-content persistence or UUID entry needed for
restoration. No full history/candidate-eligibility API, private recipe authoring,
generated recipes, payment or production cutover. Preview fixtures use isolated
in-memory D1 and real test sessions; they never install a production auth bypass.
T07 owns deferred aggregate quotas and final security/performance review.

## ADR-017 — T06A trusted backend and minimal current-plan persistence

**Status:** Accepted 2026-09-09. Supersedes ADR-016's combined delivery scope;
its frontend/AI presentation portions are deferred to T06B.

**Decision:** An opt-in Hono application boundary accepts scheduling/action intent
only. Existing cookie/CSRF/tenancy/rate-limit infrastructure remains authoritative.
One D1 batch preloads catalog, household inventory, typed T03 preferences/history,
nutrition and instructions; only server composition creates opaque T02–T05 contexts.
No request/AI plan, price, shortage, substitution review or safety assertion is accepted.
Missing reviewed safety/retail sources stay missing; no legacy benchmark promotion.

Keep final generated plans private to the authorized creating member because T03
personalization is private. Legacy Week storage is incompatible and remains intact.
Add minimal current-plan/annotation tables (0022), membership composite FKs, scoped
creation retry keys and atomic optimistic revision updates. Persist versioned,
validated final DTO plus a narrow T05 input projection, never search state, opaque
handles, ranking context or reviewer evidence. This changes only T05's accepted
input projection/codec, not arithmetic or optimizer policy. Exact money and quantity
strings cross the API boundary, with known/unknown and proof metadata preserved.

Swaps establish server-validated locks and replay the entire plan from current
inventory, rather than patching one slot. If the bounded search cannot produce a
complete valid replacement, leave the current revision unchanged. Regeneration may
return valid partial/incomplete results. SHA-256 source comparisons expose practical
staleness, not reservations. Shopping is generated on demand from plan ID/revision
and refuses stale source/time; no stale shopping cache or purchase command exists.

**Consequences:** No revision-history platform or distributed command ledger. Exact
creation retries avoid repeated planning after a completed write, but simultaneous
first requests may both compute before one durable result wins. Existing rate
limits are per account/path and best-effort under KV degradation; aggregate quotas
remain T07. Cooked annotations do not fabricate actual cooked history or consume
stock. T06B consumes only `meal-planning-api.ts`, `meal-shopping-api.ts` and
`API_INTEGRATION.md`; new endpoints do not replace legacy Week, settings or cooking.
No PayOS, authentication redesign, production deployment or AI work is authorized.

## ADR-016 — Authenticated generated-plan integration and bounded AI presentation

**Status:** Accepted for T06 implementation, 2026-09-09

**Decision:** Extend the existing Hono/session/CSRF/tenant boundary and React
application through an explicit `/planner` route; legacy Week remains unchanged.
The application service loads D1 catalog, household inventory and scoped T03
preferences/history before invoking T04 and T05. Client requests express intent,
never authoritative inventory, shortages, prices, reviews or domain contexts.
Missing retail offers remain missing; legacy benchmarks/OCR are not trusted quotes.
Absent whole-dish safety reviews cannot satisfy hard safety constraints.

Persist final generated-plan revisions separately from incompatible legacy Week
rows. Plans are private to their creating member within the authorized household
because T03 personal preferences/history are private. Revision writes use optimistic
concurrency and idempotency; reads reauthorize and expose source staleness. Swap and
explicit regeneration replay sequential planning, never patch downstream stock
arithmetic. Marked-cooked annotations do not consume stock or fabricate actual
`cooked_meals` history. No inventory acceptance or legacy cutover is introduced.

Versioned allowlisted DTOs expose exact decimal quantity strings and minor-unit
money strings, preserving uncertainty and best-known versus proven conclusions.
AI is independently disabled by default and requested on demand only. It may choose
among grounded presentation templates, not generate authoritative factual prose.
Its bounded schema, provider timeout and deterministic fallback are independent of
planning. No long-tail recipe publication or private recipe authoring is introduced.

**Consequences:** An additive revision/annotation migration is justified by durable
API identities, not a second optimizer. No search frontier is persisted. Existing
rate-limit infrastructure supplies abuse control, not a globally atomic paid quota.
Full source revalidation is required before any future acceptance/cooking adapter.
The T05 option cap remains ID-order-sensitive; T07 should audit selection quality
without changing the best-known/proof distinction. No payments, deployment or
unrelated authentication/infrastructure changes are authorized.

## ADR-015 — Trusted, generated-only economic evaluation of the fixed T04 plan

**Status:** Accepted 2026-09-09 (T05)

**Decision:** T04 per-slot deficits are the sole purchase-demand authority; no second
stock deduction or hidden replanning loop. Reuse exact T02 Quantity arithmetic.
Legacy VND benchmark/package tables lack a trustworthy offer-price relationship,
so accept a validated opaque server-owned, household-scoped price/package snapshot
without a new retail persistence platform. Currency is explicit; safe-integer minor
unit inputs, BigInt monetary arithmetic and decimal-string outputs prevent rounding
and overflow. Stale/estimated/foreign/unpriced observations remain qualified unknowns.

Use bounded iterative per-ingredient package enumeration plus additive aggregation.
Cost-first is the default; an explicit dimensionless cost-premium policy may reduce
surplus without absurd spending. Hard budgets constrain those upgrades; soft targets
only diagnose. Expose best-known versus exhaustive minima, and derive infeasibility
only from proven lower bounds that account for unknown-price alternatives. Keep
T04, shopping and budget feasibility/search completeness separate.

Surplus is not certain waste. Report existing remainder and new purchase surplus
separately using only dated expiry evidence; unknown risk remains unknown. No
global optimal-waste/allocation claim. See `SHOPPING_OPTIMIZER.md` for full proof,
limits, exact money fields, trust/temporal semantics and T06 output.

**Consequences:** No schema migration, live pricing, FX, route/UI cutover, real
inventory mutation, actual purchase or payment. Existing Week/standalone shopping
stays unchanged. This task's explicit no-replanning directive supersedes the older
T05 packet's proposed feedback loop; future orchestration must explicitly invoke
T04. Trusted catalog providers must authorize/review offers; a callback wrapper
does not turn client price/product/safety claims into authority.

Entries identify the task in which they were accepted. Supersede an ADR explicitly; do not silently rewrite
the agreed architecture. Later tasks must record migration and compatibility impact.

## ADR-001 — Extend existing identities and runtime boundaries

**Status:** Accepted 2026-09-08

**Context:** D1 and static catalogs already model ingredients/recipes. Inventory
and Week have household isolation, command fencing and compatibility migrations.
Replacing these for a new greenfield planner would duplicate or break live behavior.

**Decision:** Extend existing tables/IDs additively. Keep Ingredient, Inventory Item,
Retail Product, Recipe/line, Family, Nutrition, Preferences, Plan and Shopping as
separate concepts. Keep static normalization/`ALL_RECIPES` readers and all current
routes unchanged in T01. New catalog helpers are explicit library calls, not APIs.

**Consequences:** T01 data is not automatically visible in old screens. T02 needs
an explicit audited catalog adapter and import/drift policy; no hidden dual source
switch. Household commands, Week dual-write and old DTOs stay compatible. Leaf
foundation imports avoid expanding the existing domain/recipe barrel cycle.

**Alternatives considered:** New ingredient/recipe replacement tables; wholesale
ORM migration; immediate D1 runtime cutover. Rejected as unnecessary risk/scope.

## ADR-002 — Multilingual exact alias keys, explicit ambiguity

**Status:** Accepted 2026-09-08

**Context:** Existing aliases are loose strings; runtime uses first substring
matches. SQL cannot reliably perform full Unicode normalization on historical data.

**Decision:** Preserve raw aliases, add canonicalized language and nullable
normalized key. App uses NFKC/whitespace/lowercase, preserving accents. Unique
non-NULL `(language, normalized_alias)`; look up exact locale plus `und` and fail
closed as ambiguous if more than one ingredient matches. Atomic authoring also
indexes localized/default names. Preserve old NULL keys for reviewed promotion.

**Consequences:** Locale collisions are rejected; cross-locale/und ambiguity is
represented, not resolved by insertion order. Japanese works without a special
schema; retail quantity stripping/fuzzy NLP/automatic locale fallback wait. New
SQL writers must follow application normalization. No destructive alias backfill.

**Alternatives considered:** Global unlocalized alias uniqueness, accent folding,
SQL `lower()` backfill, first-match fuzzy resolution. Rejected for false matches.

## ADR-003 — Physical dimensions versus contextual retail quantities

**Status:** Accepted 2026-09-08

**Context:** Strict conversion already exists alongside a legacy numeric fallback.
Retail packages and count units lack universal mass/density.

**Decision:** Preserve `StandardUnit` and strict helpers. Add mirrored unit reference
data/typed dimensions: mass g/kg, volume ml/l, piece count, contextual pack/bunch/
slice. Only exact physical factors are universal; contextual identity is not proof
that two differently sized packages can be pooled.

The SQL catalog constrains codes/dimensions/bases/factors to this supported set;
adding a unit requires a matching typed change and migration, not an arbitrary row.

**Consequences:** No arbitrary onion/egg/package-to-gram conversion. Product-specific
content/estimates and rounding policy belong to T05. Tests detect SQL/type drift.
No change to legacy inventory conversions or guarded cooking commands.

**Hardening clarification:** `areUnitsCompatible`/`convertUnitStrict` accept
same-unit quantity identity, not proof of physical equivalence. `pack -> pack`
and `slice -> slice` count the same defined package/slice context; `piece -> piece`
counts the same canonical item. Neither proves mass, volume, or equivalence across
different product sizes. `UNIT_DEFINITIONS.dimension` distinguishes those cases.

**Alternatives considered:** Convert all units to grams; introduce a generic
conversion graph now. Rejected as unsafe or speculative.

## ADR-004 — Explicit nutrition basis, provenance and unknown safety state

**Status:** Accepted 2026-09-08

**Context:** Runtime recipes have optional unproven macro totals; no ingredient
nutrition schema or structured allergen evidence exists.

**Decision:** Store nullable nutrient observations in independent basis-aware
profiles (kcal/g/mg), linked to ingredients or recipe versions. Distinguish
authoritative/imported/calculated/estimated with a reference. Separate ingredient
allergen/dietary assertions from unknown/reviewed state and recipe classifications.

**Consequences:** NULL is not zero; absence of tags is not safe. Existing macros
are not promoted or reinterpreted. Later code chooses trusted applicable profiles
and current recipe version; authoritative labeling alone is not verification.
No complete nutrition database, nutrient calculator or allergy guarantee in T01.
ADR-009 clarifies and enforces that only the current recipe version is stored.
Missing dietary assertions also remain unknown; no meat tag is not evidence of
vegetarian suitability. Imported/AI classifications are not an allergy authority.

**Alternatives considered:** Unqualified totals on recipes, JSON nutrition blob,
implicitly safe empty tags. Rejected for arithmetic/safety ambiguity.

## ADR-005 — Families as bounded relational slots and options

**Status:** Accepted 2026-09-08

**Context:** Structured recipe lines exist, but modeling every fried-rice variation
as a separate dish scales poorly and obscures canonical identity.

**Decision:** Families define base servings and min/max selection slots; options
carry canonical ingredient, quantity and unit. Recipes optionally reference a
family. Core recipe quantities/servings remain existing relational fields; add
provenance/version/review fields and descriptive classifications.

**Consequences:** FK/unique/check constraints plus full-object validation protect
authoring. Families require an atomic complete write; SQL alone cannot enforce
aggregate option counts. T02 owns bounded generation and coherent instructions;
options are not arbitrary safe substitutions. Current global source metadata does
not create private user recipe ownership/publication authority.

**Hardening clarification:** Finite slots do not bound computational work. T02
must enforce `MAX_VARIANT_CANDIDATES_PER_FAMILY` (initial default 64) and
`MAX_VARIANT_SEARCH_STATES_PER_FAMILY` (initial default 1024) while exploring, not
after constructing the Cartesian product. Reaching either budget must return
deterministic truncation metadata, not a false claim of exhaustive infeasibility.
These are T02 requirements, not a generator or runtime policy implemented in T01.

**Alternatives considered:** Unstructured JSON templates, EAV rule engine, storing
all variations. Rejected for weak referential integrity or premature complexity.

## ADR-006 — Lot condition evidence without inventory rewrite

**Status:** Accepted 2026-09-08

**Context:** Inventory has storage/expiry but no date kind/source or opening evidence.
Rewriting inventory commands would threaten event/revision/idempotency guarantees.

**Decision:** Add nullable opening timestamp and unknown-default expiry kind/source
to existing lots; separate sourced ingredient/storage/package-state shelf-life
guidelines. Do not backfill guesses or expose side-channel writes in T01.

Non-unknown expiry evidence requires a date in both the combined validated input
and future-write SQL triggers. Removing that date must reset its evidence atomically.

**Consequences:** Existing HTTP projections remain unchanged. A future validated
condition endpoint must share the inventory command transaction/version. Guidelines
are advisory, not lot expiry; unknown opening does not imply sealed. Timezone and
expiry-priority logic wait for T03/T04.

**Alternatives considered:** Recompute every expiry from ingredient defaults or
infer source from `data_source`. Rejected as potentially unsafe historical rewriting.

## ADR-007 — Deterministic core and repository-owned delivery protocol

**Status:** Accepted 2026-09-08

**Context:** Future agents cannot rely on this task's conversation; current AI and
planner overlap later work, but neither is a complete safe optimizer.

**Decision:** Persist specification, ADRs, current reality, task graph and fixed
handoff in `docs/ai`; root AGENTS points there. Deterministic code/DB enforce stock,
constraints, allergies, expiry and budgets. AI only proposes/explains validated
data after the deterministic core is stable. Deliver T01–T07 incrementally.

**Consequences:** All seven task packets describe explicit incremental improvements,
not a replacement platform. Update state/board/handoff after every task and report
exact checks/failures. Older security reports remain linked historical references.

**Alternatives considered:** Chat-only handoff, prompt-only/LLM planning, a single
large implementation task. Rejected for recoverability and correctness risk.

## ADR-008 — Strict canonical ingredient identity, separate from catalog IDs

**Status:** Accepted 2026-09-08 (T01 hardening)

**Context:** All 45 seeded D1 ingredient IDs, all 45 static ingredient IDs, and
385 static recipe ingredient references (43 distinct IDs) use uppercase ASCII
snake case. The general `CatalogIdSchema` and case-sensitive SQL primary key
previously allowed a separate `chicken_breast` beside `CHICKEN_BREAST`.

**Decision:** Canonical ingredient IDs must match `^[A-Z][A-Z0-9_]*$`, be at most
100 characters, and contain no surrounding whitespace or implicit coercion.
Use a dedicated `CanonicalIngredientIdSchema` for catalog authoring, alias target
IDs, storage guidelines, recipe lines and family options. Recipe/family/profile
IDs, slugs and locale keys retain their existing distinct contracts. SQL guards
reject invalid ingredient INSERTs and ID UPDATEs, including NULL and embedded NUL.

**Consequences:** Importers must explicitly map external IDs to existing canonical
identities; do not uppercase unknown IDs or derive them from translations. No
existing legitimate seed/catalog ID changes. Published/applied 0019 is immutable;
append 0020. Its preflight stops on invalid existing IDs without renaming, merging
or deleting rows. The catalog owner must review any failing data before retrying.

**Alternatives considered:** Case-insensitive uniqueness with case-flexible IDs;
automatic uppercasing/backfill. Rejected because every current legitimate ID
already follows one strict convention and coercion would hide import mistakes.

## ADR-009 — Nutrition links belong only to the current recipe version

**Status:** Accepted 2026-09-08 (T01 hardening; clarifies ADR-004)

**Context:** T01 has one row per recipe, not historical recipe-version identities.
The positive `recipe_nutrition.recipe_version` check alone allowed impossible or
stale links, despite readers being instructed to select the current version.

**Decision:** Every nutrition link must equal its parent recipe's current version.
0020 guards link INSERT/UPDATE and blocks parent version changes (including
replacement INSERTs) while dependent nutrition links remain. To revise a recipe,
explicitly unlink its nutrition, update the recipe/version, then link newly
validated profiles in one D1 batch. Failure rolls the entire batch back. Profiles
are retained; nothing is implicitly relabeled or recomputed.

**Consequences:** No historical recipe version support is implied. Preflight
rejects existing mismatches for owner review rather than dropping evidence or
guessing a version. Deleting a recipe still intentionally cascades its links;
linked profiles themselves remain protected from deletion by foreign keys.

**Alternatives considered:** Historical recipe-version tables or automatic link
version updates. Rejected as out of scope or liable to attach stale nutrition to
changed ingredients/servings.

## ADR-010 — Traceable imported and AI recipe provenance

**Status:** Accepted 2026-09-08 (T01 hardening)

**Context:** Source type and verification were independent, but imported/AI
recipes and families could omit all traceability.

**Decision:** `imported` and `ai_generated` recipes/families require a nonblank,
NUL-free source reference. Legacy/curated/user-generated references are optional
(omitted/SQL NULL); any supplied reference must also be nonblank and NUL-free.
An internal dataset-row, import-batch or generation-job ID suffices; no public URL
is required. Zod and 0020 INSERT/UPDATE guards enforce these presence rules,
including Unicode whitespace. Zod additionally bounds authoring text lengths.
Family source types still exclude `legacy`; defaults remain legacy/curated,
unverified, version 1. A reference never confers verification or publication rights.

**Consequences:** Preflight rejects opaque existing imports/AI rows without
inventing references. Catalog owners must supply authentic evidence before retrying.
Global references must not contain private user data or credentials. No import,
generation, ownership or review endpoint is implemented in T01.

**Alternatives considered:** Require public URLs or a full provenance subsystem;
infer traceability from source type. Rejected as unnecessary or unauditable.

## ADR-011 — Indexed quantity feasibility, not runtime ranking or consumption planning

**Status:** Accepted 2026-09-08 (T02)

**Decision:** Add a reusable leaf availability index and per-candidate reservation
session. Re-export unchanged strict unit semantics from a leaf module to avoid
barrel cycles. Aggregate compatible physical lots and canonical piece quantities;
contextual package labels alone never prove equivalent contents. Preserve explicit
missing/partial/unresolved/satisfied outcomes and diagnostics. Duplicate identical
lot IDs count once; conflicting/invalid related stock is quarantined as uncertainty.
Use exact decimal rational intermediate arithmetic and explicit finite Number
boundaries; arithmetic range failures are reported, never coerced to zero coverage.

Aggregate repeated compatible requirements before serving scaling, retain source
line indices and units (mixed physical units use their base). Preserve mathematical
fractional pieces with an explicit flag: existing T01 quantity contracts allow
fractions. No hidden whole-item/purchase rounding or Week portion optimizer.
Reserve direct required demand first, then approved substitutions, then optional
demand. Lot-ID order is only a reproducible feasibility witness, not FEFO, actual
stock consumption or a multi-meal simulation. Each candidate starts independently.

Caller supplies an explicit as-of date and authorized household-scoped inventory.
Past use-by is unavailable; past best-before is not automatically unsafe; elapsed
unknown/estimated dates require review and remain uncertain. Freshness rescue flags
are carried as raw witness facts, not recalculated/weighted expiry priorities.

**Consequences:** Legacy recipe scoring, static readers, cooking commands and Week
behavior stay unchanged pending their explicit integration tasks. New functions
claim quantity feasibility only, not nutrition/allergy certification. No migration,
API, UI, payment/auth or production configuration change is required.

## ADR-012 — Explicit one-hop substitutions and bounded family traversal

**Status:** Accepted 2026-09-08 (T02)

**Decision:** Substitution rules are explicit reviewed, source-referenced quantities,
scoped to a recipe/family ID and version. Every use needs per-call approval and
positive compatibility evidence for every active constraint; missing evidence
denies use. Rules express the replacement amount per original unit, including
partial replacements, never inferred food density. No contextual conversions,
transitive substitutions, preferences or learned rules. Deterministic rule-ID order
does not claim globally optimal allocation among competing substitutes.

Family traversal is lazy with the ADR-005 limits enforced during attempted partial
states, including rejected branches; callers may lower but not exceed 64 candidates
or 1024 states per family. Canonicalize slot/options and semantic aggregate demands;
contextual demands retain separate lines and slot identities because equal labels
do not prove equivalent contents. Retain selected-slot evidence and do not persist
variants. A selected optional-slot
option is required within that variant; omission is its separate zero-selection
choice. Never emit a zero-demand variant. Truncated searches do not prove no
feasible variant exists. Family instructions/cuisine/times absent in T01 stay absent.

**Consequences:** T03 can consume structured requirement facts without repeating
inventory math. D1/static catalog snapshots remain explicit internal read-only
sources; drift/alias promotion proposals require review, not automatic writes or
runtime cutover. No new persisted substitution or variant schema is needed.

## ADR-013 — Scoped deterministic ranking, not legacy runtime cutover

**Status:** Accepted 2026-09-08 (T03)

**Decision:** Consume unmodified server-generated T02 snapshots, bound to household
and explicit calendar date, before hard gates and normalized weighted utility.
Keep T02 arithmetic untouched; add only existing family/prep metadata and a private
scope/fingerprint guard rejecting serialized or mutated candidate inputs. Candidate
review keys additionally bind demands, substitutions and lot witnesses. Review
schemas validate structure, not authority; server-owned approval/review data remains
mandatory. Unknown active hard safety/time/nutrition requirements fail closed.
No safety policy requested is not a safe-food claim. See `RANKING_ENGINE.md` for
exact scores, bounds, policy configuration, dates and nutrition source limitations.

Persist ranking-specific household and member preferences/feedback because legacy
global preferences/favorites cannot enforce household scope and Week settings are
not ranking policy. Do not auto-import global/free-form intent. Personal soft
defaults replace household defaults; hard restrictions union. Household defaults
are owner-managed, personal data membership-bound. Existing `cooked_meals` remains
the only cooking history authority; no new cooking events/commands or automatic
Week skip/swap capture. Explicit latest tastes outrank weak behavioral feedback;
cooked meals affect recency only. No separate taste aggregate or learned model.

**Consequences:** Additive persistence with canonical FKs and bulk readers, no
legacy route/ranker cutover. Static-only feedback targets require explicit reviewed
D1 registration. No safety catalog is fabricated. Nutrition adapters preserve
partial serving-basis observations as unverified; hard ranges require independently
reviewed evidence. Expiry normalizes existing allocation shares, never reallocates
stock. T04 receives candidate utility/components, not future meal decisions.

## ADR-014 — Bounded sequential planning over the T02/T03 dependency

**Status:** Accepted 2026-09-08 (T04)

**Decision:** Add an explicitly invoked, pure weekly planner. Each ordered slot
regenerates T02 availability on branch-local projected inventory and invokes T03
hard eligibility/utility with trusted server-owned context. Deterministic bounded
beam search keeps alternative futures; hard constraints never become score penalties.
Expose recipe-search and planner-search incompleteness separately. A failed bounded
search is not proof of infeasibility. No production Week/API cutover or inventory
write is performed; T06 owns an authenticated shadow/canary integration.

Reuse exact Quantity arithmetic and T02 lot witnesses. An opt-in expiry-priority
allocation order supports projected consumption while preserving T02's default
ID-order behavior. Only explicit supported expiry evidence affects priority; T02
availability remains authoritative. Servings use T02 scaling without count rounding.
One offset-bearing planning instant derives its local date and each slot's instant
using the same fixed offset, with no inferred timezone or DST rules. Actual history
is frozen at the planning instant; future choices are plan-local, not cooked events.

T03 scores cover past-relative preference/expiry/time; additional plan terms cover
future repetition, ingredient continuity and period nutrition only. Period nutrition
targets explicitly concern household totals over requested meals, not invented daily
meal allocations. Unknown/unreviewed hard nutrition fails closed. Leftover scheduling
is deferred because legacy leftovers lack a trusted prepared-food expiry policy;
every selected meal cooks and consumes its requested servings, without hidden excess.

**Consequences:** Output includes selected demand/witnesses, shortages, per-lot deltas,
initial versioned stock, projected final stock and complete search metadata for T05.
It is generated state, not a reservation, shopping purchase or persisted Week plan.
No migration is needed. A future accepting writer must reauthorize membership and
recheck inventory/catalog/preference versions before invoking existing versioned,
idempotent Week/command paths. T03 remains immutable at `3592de9`; temporary use of
its branch is a tooling constraint only, and T04 is isolated in subsequent commits.

**T04 hardening clarification:** Incomplete input/candidate evaluation is not a
search-limit hit. `no_plan_found_without_proof` covers every unproven no-plan result;
sorted, source-tagged `search.incompleteReasons` explain missing proof while
`limitReasons`/`truncated` remain specific to actual computational caps. Existing
hard eligibility and exhaustive-proof scope are unchanged. Nutrition's neutral
utility baseline is not positive evidence: a support reason requires a positive
utility delta, above-neutral aggregate fit, and an above-neutral fully qualified
soft target covering the current meal. Empty future periods cannot justify it.
This corrects the generated-only result contract before T05 integration; no persisted
consumer, schema, allocation, scoring formula or search policy changes.

## ADR-020 — Browser-side image normalization for OCR payloads

**Status:** Proposed maintenance change, local-only on 2026-09-13.

**Decision:** Normalize gallery images before upload using `createImageBitmap` and
an in-memory canvas. Cap the longest side at 2,000 px, encode as JPEG at quality
0.82, and only use the derivative when it is smaller than the source. Do not
upscale small images, mutate the original file, persist image bytes, or log image
content. If bitmap/canvas APIs are unavailable or fail, retain the existing
`FileReader` path. Cancellation and private-session fencing apply across decode,
compression and read stages.

**Rationale:** The sample receipt is 1,086x1,448 PNG and approximately 2.1 MB;
JPEG quality 0.82 produces approximately 382 KB (81.9% smaller) at the same
dimensions, reducing request transfer/base64 and provider input overhead while
retaining the text-bearing pixels. This complements, but does not replace, the
server/provider timeout recovery already deployed.

**Release boundary:** No production deployment, schema, storage, auth, payment
or provider configuration change is implied. Promote only after browser/device
OCR smoke confirms item recall and latency against the attached receipt.

## ADR-021 — Task-based Qwen runtime and production model governance

**Status:** Accepted 2026-09-13 (architecture maintenance branch)

**Decision:** Add a single task-based runtime behind `AIRouter`. Feature and
domain code submit a semantic task and compact input; the runtime resolves a
logical Qwen role, applies per-task prompts and token ceilings, validates
structured output, performs at most one repair and one policy-approved
escalation, and emits non-PII usage/cost telemetry. Production composition sets
`AI_QWEN_ONLY=true`, so legacy Groq, DeepSeek, GLM and native Cloudflare adapters
are not constructed. Physical model IDs are configurable only through Worker
role aliases (`AI_MODEL_*`). Reasoning and judge roles are explicit opt-ins and
remain off for customer traffic by default.

**Rationale:** A centralized policy prevents accidental expensive-model use,
unbounded retries, provider drift and model names leaking into application
services. Qwen remains the only production inference family while preserving
legacy adapters for test/migration compatibility when Qwen-only mode is not
requested.

**Consequences:** OCR and fridge vision still return untrusted candidates. The
quality gate, deterministic normalization, inventory fencing and reconciliation
remain authoritative. Estimated pricing is operational telemetry, not billing
truth. The rolling `qwen3.7-flash` alias is canary-only; promotion requires an
offline golden-dataset comparison and an explicit configuration review. This
branch changes no canonical `main` code and performs no deployment.
