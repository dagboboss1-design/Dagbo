# DAGBO specialist AI reviewers

BOSS1 remains the primary assistant. Specialist responses are advisory only and cannot create trade entries, change risk limits, or execute orders.

## Optional news / geopolitical second opinions

Set these server-side Vercel environment variables on the preview project:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL` (the current Claude model ID enabled for the account)
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (the current Gemini model ID enabled for the account)

The API keys must never be placed in browser code, localStorage, or public build variables. The integration runs only for news/geopolitical/economic-event questions, uses short timeouts, and silently skips an unavailable reviewer. BOSS1 labels the extra opinion as an independent review, not a verified news feed. It does not use these opinions to create BUY/SELL signals.

The existing `/api/push?action=health` response reports whether each key/model pair is configured. A true flag means configuration exists; it does not prove that the provider accepted a request.

## Specialist boundaries

- Claude: independent news/factual uncertainty review in the current integration. Code auditing belongs in a separate CI/review workflow, not a live trading request.
- Gemini: independent news/context review in the current integration. Chart-image review requires a deliberate image-upload/data path and is not enabled by this change.
- Quant reviewer: must validate deterministic strategy calculations and historical tests; do not use a language model as the source of risk arithmetic.
- BOSS1: merges useful caveats and remains responsible for explaining uncertainty. No specialist may override market-data freshness checks, market-hours gates, or risk limits.

## Required next integration work

1. Add a dedicated code-review CI job with a separately configured reviewer credential and read-only repository scope.
2. Add chart-image input with size/type validation and explicit user consent before sending an image to a vision model.
3. Build deterministic quant regression tests before exposing any model-generated strategy commentary.
