# Qwen Runtime and Model Governance

## Scope

The Worker production composition uses `AIRouter` with `AI_QWEN_ONLY=true`.
Feature services submit a semantic task to the runtime; they do not select a
physical model or provider. The runtime is fetch-based and Cloudflare Workers
compatible.

```mermaid
flowchart LR
  F[Feature/domain service] --> R[AIRouter / QwenTaskRuntime]
  R --> P[Task policy + prompt registry]
  R --> G[Budget + schema + quality gates]
  R --> Q[QwenProvider]
  Q --> D[DashScope compatible API]
  R --> T[Usage ledger]
  Q --> C[Candidate output]
  C --> V[Deterministic validation/reconciliation]
  V --> I[Inventory Truth Layer]
```

## Routing matrix

| Task | Logical role | Default physical model | Escalation | Attempts |
| --- | --- | --- | --- | ---: |
| `ingredient_normalization` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | none | 2 |
| `recipe_generation` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | `QWEN_MULTIMODAL` | 3 |
| `recipe_explanation` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | none | 2 |
| `recipe_ranking` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | none | 2 |
| `fridge_chat` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | none | 2 |
| `receipt_ocr` / `label_ocr` | `QWEN_OCR` | `qwen-vl-ocr` | `QWEN_MULTIMODAL` | 3 |
| `fridge_image_analysis` | `QWEN_MULTIMODAL` | `qwen3.8-flash` | `QWEN_REASONING` (off by default) | 3 |
| `weekly_plan` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | `QWEN_MULTIMODAL` | 3 |
| `weekly_plan_repair` | `QWEN_FAST` | `qwen3.7-flash-2026-07-15` | `QWEN_MULTIMODAL` | 3 |
| `weekly_plan_complex` | `QWEN_MULTIMODAL` | `qwen3.8-flash` | `QWEN_REASONING` (off by default) | 3 |
| `offline_evaluation` | `QWEN_JUDGE` | `qwen3.8-max-0902` | none | 1 |

The rolling `qwen3.7-flash` alias is exposed only as
`QWEN_FAST_CANARY`; shadow traffic is disabled by default.

## Safety and cost controls

- `AI_ENABLED` is a global kill switch; production requires it to be true.
- `AI_QWEN_ONLY=true` prevents Groq, DeepSeek, GLM and native Cloudflare AI
  from being constructed by the production router.
- Reasoning and judge roles require `AI_ALLOW_REASONING_MODEL=true` or
  `AI_ALLOW_JUDGE_MODEL=true`; both default to false.
- Every task has a maximum input/output budget. The operation ceiling is
  `AI_MAX_TOTAL_TOKENS` and the call ceiling is `AI_MAX_CALLS_PER_OPERATION`.
- A failed structured response gets one bounded repair attempt and, where the
  policy allows, one escalation. There is no unbounded retry loop.
- Provider usage is recorded without prompts, images, API keys or receipt text;
  the ledger aggregates calls, tokens, estimated cost, latency, failures,
  retries, escalations, OCR failures and planner repairs.

Prices are estimates held in `model-governance.ts`, versioned in telemetry and
overrideable with `AI_PRICE_*` variables. They are not a billing source of
truth.

## OCR and inventory boundary

Receipt and label tasks extract raw lines through `QWEN_OCR`; normalization and
canonical lookup remain separate. Fridge images produce provisional candidates
with confidence and evidence. The quality gate rejects generic labels,
unsupported values and low-confidence rows.

AI output never writes authoritative inventory. The existing flow remains:

`image/text -> candidate -> normalization -> validation -> confidence/review ->
existing reconciliation and fenced inventory command`.

Quantities, unit conversion, expiry ordering, prices, budget arithmetic and
duplicate detection stay deterministic.

## Configuration

The safe production values are versioned in `wrangler.jsonc`; local and staging
templates mirror the names without secrets. `QWEN_API_KEY` is a Worker secret
only and must never be committed or exposed to the browser.

## Evaluation and promotion

Offline fixtures in `tests/fixtures/ai-golden.json` cover Vietnamese, Japanese
and English extraction and
planner cases, including malformed output and low confidence. A future model
promotion requires a golden-dataset comparison of quality, schema success,
latency, token usage and estimated cost, followed by an explicit config change
and normal review/deploy process. No live benchmark is run by CI.

Run `pnpm ai:eval -- --dry-run` to inspect the fixture manifest. The command is
deliberately offline and never consumes Alibaba quota; a live benchmark needs a
separately reviewed server-side harness and explicit credentials.

This governance change is implemented on the feature branch only; it does not
modify canonical `main` or deploy production.
