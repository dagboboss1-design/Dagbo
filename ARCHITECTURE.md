# DAGBO SIGNAL — Department Architecture

## Product shape

DAGBO remains one mobile-first application, one brand, one user settings model,
and one navigation experience. Internally it is divided into six independently
owned departments:

| Department | Engine module | Page ownership |
|---|---|---|
| DAGBO TRADE | `src/departments/engines/trade.js` | signals, chart, alerts |
| DAGBO INTELLIGENCE | `src/departments/engines/intelligence.js` | news, market heatmap, signal insights |
| DAGBO QUANT | `src/departments/engines/quant.js` | strategy lab, trading profiles, higher-timeframe hedging |
| DAGBO JOURNAL | `src/departments/engines/journal.js` | journal, trader score, replay |
| DAGBO AI | `src/departments/engines/ai.js` | AI assistant, BOSS1 |
| DAGBO ACADEMY | `src/departments/engines/academy.js` | learn |

## DAGBO CORE responsibilities

- Shared market-data access and normalized quote/candle contracts.
- Shared settings and user preferences.
- Authentication and authorization when introduced.
- Notification delivery and subscription management.
- Namespaced events and explicit public service calls between departments.
- Health/status reporting and diagnostics.

CORE owns shared infrastructure, not the trading decisions of each department.

## Independence rules

1. Each department registers its own services under its own ID in CORE.
2. A department may consume CORE services through documented public contracts.
3. A department must not import another department's private implementation.
4. Page adapters are local to the owning department; they cannot call another
   department's private functions.
5. Cross-department communication uses namespaced CORE events or explicit
   public service invocation.
6. A failed provider or department must not crash unrelated departments.
7. Every market-data result must carry source, timestamp, symbol, timeframe and
   freshness/status metadata.
8. Missing, stale or invalid data is unavailable — never silently substituted
   with fabricated prices, volume, news or confirmations.
9. Each department owns its validation, errors, diagnostics and tests.

## Engine boundary implementation

- `engine-kit.js` provides shared registration mechanics only; it contains no
  trading or product-domain decisions.
- Each of the six engine modules exports one registration function and owns
  its own service names, route allowlist, page adapter and domain events.
- CORE rejects unknown service owners, duplicate services and unowned routes.
- Service calls are scoped to the owning department. A page-local service
  returns an explicit unavailable response when called from another page.
- The Journal page exposes a namespaced refresh adapter; other adapters use
  their owning page's existing public UI entry points.
- The current HTML pages still contain some legacy calculation/rendering code.
  Those algorithms are invoked only through their owning department adapter;
  moving every calculation into separately bundled files is a later internal
  refactor and is not required to establish the service boundary.

## Validation

Run `npm test`. The suite covers CORE registration, route ownership, service
isolation, event naming, health aggregation, market-data validation and all
six department engine registration/ownership boundaries.

## Current implementation status

The six independent department engine modules and their CORE service
boundaries are implemented. The shared market-data contract is enforced at
the candle provider, chart and scheduled higher-timeframe boundaries. Tests
verify that each department exposes only its own service interface and that
page-local operations reject calls from another department's page.

The modules preserve the existing app and trading UI. Some page algorithms
remain in their legacy page scripts behind department-owned adapters; no
production merge or deployment is implied by this feature branch.
