# DAGBO SIGNAL — Production Readiness Audit

**Audit date:** 2026-11-16  
**Target:** Public subscription launch; design capacity target of 1,000,000 registered accounts  
**Baseline:** `main` at `3ce884ff7522707cabc817eb47f5eb398b7d0c36`  
**Production project:** `dagboboss`  
**Latest deployment observed:** `dpl_3JiXCeuL3QDzAEUUeL9DhF4c78PU` — Vercel state `READY`, production aliases include `dagboboss.vercel.app`.

## Executive status

**Not production-ready for a public subscription launch or a verified one-million-account capacity claim.** The current static/PWA experience and several serverless endpoints are present, but the repository baseline does not yet establish durable user identity, server-authoritative entitlements, a payment lifecycle, or a shared account-level journal. A READY deployment is a successful deployment state, not an end-to-end product acceptance test.

No existing production files were changed for this baseline audit. Work is isolated on the `production-readiness` branch so current production behaviour can be preserved while changes are validated.

## Confirmed repository facts

- The app is a multi-page HTML/CSS/JavaScript PWA. Main pages include Home, Signals, Chart, News, BOSS1, Journal, AI, Settings, Trader Score, Strategy Lab, Learn, and Opportunity Intelligence.
- `package.json` currently declares only `@upstash/redis` and `web-push`.
- `vercel.json` disables Git-triggered deployments for all branches. Production changes therefore require an intentional deployment workflow; pushing a commit alone will not publish it.
- The Vercel project currently reports the latest deployment in region `iad1`.
- `api/market-data.js`, `api/calendar.js`, `api/exchange-rate.js`, `api/news-signal.js`, `api/news-monitor.js`, `api/cron-scan.js`, `api/cron-signal.js`, `api/push.js`, and `api/trades.js` exist on `main`.
- The frontend calls live market data, calendar, exchange-rate, news-signal, push, and trade endpoints. Local browser storage remains central to settings, chart drawings, signal snapshots, and journal state.
- The frontend and scheduled scanner load different confluence implementations: root `dagbo-confluence.js` and `public/dagbo-confluence.js`. This is a behavioural-drift risk and must be reconciled only after comparing their public interfaces and test cases.

## Critical launch blockers

### P0 — Identity, account data and subscription authority
- No account database or authentication provider is declared in the current package manifest. Settings contains login/register wording, but this audit has not established a working identity lifecycle.
- Paid access must be checked server-side on every protected API. Client-side plan labels or localStorage must never grant Pro/VIP access.
- User settings, journal trades, notification devices, billing records and entitlements need durable account ownership and cross-device synchronisation.
- Payment webhooks must be signature-verified, idempotent and safe against duplicate/out-of-order events. Expiry, renewal, cancellation, refunds, chargebacks and grace periods need explicit state transitions.

### P0 — Trade persistence and device coupling
- `api/trades.js` is not an account-based journal API. It identifies a device by hashing a push endpoint, requires a registered push subscription for trade operations, stores trade keys beneath that device identifier, and applies a 90-day Redis expiry.
- This makes trade tracking dependent on push permission/device identity rather than a signed-in user. It is not suitable as the canonical journal for a subscriber who changes phone, browser or push endpoint.
- The UI currently saves the local journal first and treats cloud monitoring as optional. That is useful offline behaviour, but it must be migrated carefully so existing users do not lose local records.

### P0 — Capacity and reliability
- One Vercel region is currently reported. This is not evidence of global low latency or resilience.
- The AI rate-limit fallback uses an in-memory Map when Redis is unavailable. Serverless instances do not share that counter, so it is not a reliable abuse-control mechanism at scale.
- Scanner fan-out and Redis access patterns need load tests, bounded concurrency, provider-credit budgets, queueing, retry/backoff and idempotency before broad public traffic.
- No load-test evidence, SLOs, alerting/observability acceptance, backup/restore drill or incident runbook has been verified.

### P1 — Signal correctness and consistency
- Frontend Signals and scheduled scans use separate confluence files. Their analysis profiles and output contracts must be compared and tested before unification.
- Market-data and calendar endpoints require provider-level integration tests, including empty data, unsupported pairs, closed markets, stale data, rate limits, malformed responses and provider outages.
- Signal output must fail closed: no invented prices or signals when market data is unavailable or stale. Closed-candle handling and Nigeria-time scalp window need regression tests.
- Opportunity Intelligence describes snapshots saved on the device; this is not yet a server-authoritative multi-device signal history.

### P1 — Security and privacy
- Review every public endpoint for authentication, authorization, request-size limits, schema validation, abuse controls, CORS policy, secret handling and safe error responses.
- Push subscriptions are sensitive endpoint credentials. They need ownership binding to a user, lifecycle cleanup and protection from cross-account use.
- Add a documented data-retention policy, account deletion/export process, privacy notice and terms suitable for the actual markets served.

## Implementation sequence

1. **Baseline and regression tests:** preserve the current UI; inventory every route, environment variable, scheduled task and external provider; add automated tests for existing contracts.
2. **Account foundation:** choose and configure durable identity + relational database; migrate local settings/journal with conflict-safe sync; retain offline mode as a cache, not the source of truth.
3. **Entitlements and billing:** implement server-side Free/Pro/VIP entitlements, payment provider adapter, verified webhooks, idempotent subscription state machine, invoices/receipts, renewal/cancel/refund/expiry handling and admin reconciliation.
4. **API hardening:** user-scoped authorization, schema validation, distributed rate limits, request budgets, caching, idempotency, structured logs and safe errors.
5. **Market-data and scanner scale:** provider quotas, cache/deduplication, bounded parallelism, queue-based scheduled work, retry/backoff, stale-data gates and scan coverage metrics. Keep Twelve Data as the current primary provider unless a separately approved change is made.
6. **Operational readiness:** multi-region strategy where supported, database backups and restore test, monitoring/alerts, uptime checks, incident runbooks and load tests at stepped concurrency.
7. **Public-launch gate:** end-to-end tests for registration, checkout, webhook, entitlement, expiry, journal sync, signal delivery, notification preferences, cancellation and account deletion; publish only after acceptance thresholds are met.

## Verification policy

- A Git commit is not a deployment.
- A Vercel `READY` state is not proof that runtime integrations work.
- Each change must have a focused regression test and a live smoke test where credentials and provider availability permit.
- Do not alter existing VAPID, Upstash, Twelve Data or cron secrets as part of unrelated work.
- Do not enable automatic Git deployments without an explicit, tested deployment workflow.
- Do not advertise one million users as a tested capacity until a load test demonstrates the agreed workload and error/latency thresholds.

## First implementation checkpoint

The first safe implementation checkpoint is to establish automated tests and a staging/preview deployment from this branch, then replace device-bound trade storage with authenticated account-owned persistence only after the account/database foundation is selected. Do not patch `api/trades.js` to trust a client-supplied user ID; that would create an account-takeover/data-leak risk.
