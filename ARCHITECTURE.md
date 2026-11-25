# DAGBO SIGNAL — Department Architecture

## Product shape

DAGBO remains one mobile-first application, one brand, one user settings model,
and one navigation experience. Internally it is divided into six independently
owned departments:

| Department | Existing page ownership |
|---|---|
| DAGBO TRADE | signals, chart, alerts |
| DAGBO INTELLIGENCE | news, market heatmap, signal insights |
| DAGBO QUANT | strategy lab, trading profiles, higher-timeframe hedging |
| DAGBO JOURNAL | journal, trader score, replay |
| DAGBO AI | AI assistant, BOSS1 |
| DAGBO ACADEMY | learn |

## DAGBO CORE responsibilities

- Shared market-data access and normalized quote/candle contracts.
- Shared settings and user preferences.
- Authentication and authorization when introduced.
- Notification delivery and subscription management.
- Namespaced events between departments.
- Health/status reporting and diagnostics.

CORE owns shared infrastructure, not the trading decisions of each department.

## Independence rules

1. A department may consume CORE services through documented contracts.
2. A department must not import another department's private implementation.
3. A failed provider or department must not crash unrelated departments.
4. Every market-data result must carry source, timestamp, symbol, timeframe and
   freshness/status metadata.
5. Missing, stale or invalid data is unavailable — never silently substituted
   with fabricated prices, volume, news or confirmations.
6. Each department owns its validation, errors, diagnostics and tests.
7. Cross-department communication uses namespaced events or explicit contracts.

## Migration sequence

1. Add this registry and ownership map without changing current page behaviour.
2. Inventory and test existing data/API code; establish shared market-data contracts.
3. Migrate DAGBO TRADE first, because signal correctness and entry/SL/TP integrity
   are the highest-priority user-facing workflow.
4. Migrate INTELLIGENCE and QUANT as separate analysis/data providers.
5. Connect JOURNAL, AI and ACADEMY through stable contracts.
6. Add department-level health panels and end-to-end tests.

## Current implementation status

The registry and department ownership map are scaffolding only. Existing HTML
pages and API handlers continue to run their current code. A department must
not be labelled operational until its real code has been migrated, tested and
its required provider/data checks pass.
