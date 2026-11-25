# DAGBO SIGNAL

**Signal Wey No Dey Lie.** DAGBO SIGNAL is a single, mobile-first trading workspace for market analysis, trade planning, risk management, journaling and learning.

## Product structure

DAGBO remains one application with one navigation experience and shared settings. Its six departments are:

- **DAGBO TRADE** — Signals, charts, alerts and execution.
- **DAGBO INTELLIGENCE** — Market news, economic calendar, heatmap and opportunity context.
- **DAGBO QUANT** — Strategy research, trading profiles and higher-timeframe analysis.
- **DAGBO JOURNAL** — Trade records, risk tracking, trader score and replay.
- **DAGBO AI** — AI assistant and BOSS1.
- **DAGBO ACADEMY** — Trading education and worked examples.

**DAGBO CORE** provides shared infrastructure; it is not a separate department. Each of the six departments now has its own engine module under `src/departments/engines/`, a namespaced service interface, and health checks. Department modules invoke only their own page adapters; cross-department communication uses CORE's public service/event boundary.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for ownership rules, migration sequence and current status.

## Market-data principles

- Twelve Data remains the primary market-price and candle provider.
- FCS is used for economic-calendar data.
- FMP is a backup news source, not a replacement for the primary news feed.
- Every signal must be based on fresh, validated market data. Missing or stale data must be reported as unavailable, never replaced with invented prices.
- API credentials belong in the deployment environment, never in client-side files or committed source.

## Development and checks

The project is a static web application with Vercel API handlers.

Run the automated CORE tests with:

```sh
npm test
```

The department-core GitHub Actions workflow runs CORE and all six department-engine boundary tests on pushes to the architecture branch and on pull requests targeting `main`.

## Safe rollout

Department migration is incremental. Existing pages and API handlers remain the source of live behaviour until each department has been migrated and tested. Git deployments are currently disabled in `vercel.json` while the architecture work is being validated. Do not merge the feature branch or enable production deployment without an explicit release decision.
