# DAGBO SIGNAL — clean build

This folder is the isolated rebuild. The existing production application is not changed by this project.

## Principles
- Real provider data only; missing or invalid data returns an explicit error.
- No signal generation until data freshness, closed-candle handling, instrument mapping and strategy evidence are validated.
- Keep API keys server-side in environment variables.
- Separate signal detection, risk calculation, journal state, notifications and UI into testable modules.

## Initial environment
- `TWELVE_DATA_API_KEY` — required for supported FX/metals candle retrieval.

## Run
`npm install && npm run dev`

## Current scope
Foundation shell, health endpoint and a fail-closed Twelve Data candle endpoint. Additional instruments/providers are added only after provider coverage and response formats are verified.

## Required private environment variables

Add these only to the separate Vercel project **dagbo-signal-next** (never to the live production project):

- `TWELVE_DATA_API_KEY` — FX and metals candles.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — shared cache, push subscriptions and alert deduplication.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — browser push delivery.
- `DAGBO_CRON_SECRET` — long random bearer secret protecting scheduled scans.
- `FMP_API_KEY` — optional primary economic calendar; the news page and scanner fall back to the public Forex Factory calendar if it is absent.
- `GROQ_API_KEY` — AI endpoint when enabled.

Do not put secrets in client-side variables or source code. The app's Settings page reports whether these values are present.

## News alert scheduler

The protected endpoint is `GET /api/cron/news`. Configure an external scheduler such as Cron-job.org to call the full deployment URL plus `/api/cron/news` every minute, with an HTTP header:

`Authorization: Bearer YOUR_DAGBO_CRON_SECRET`

A one-minute cadence is needed so the 1-hour and 15-minute event windows are not skipped. The route deduplicates each event alert in Redis and reports the observed post-release market move only after enough completed 1-minute candles exist. A successful HTTP response confirms the scan ran, not that a phone notification was delivered; check the returned counters and device push test separately.

## Safety

- Missing or invalid provider data returns NO DECISION / NO TRADE; never substitute made-up prices.
- Hedging page is advisory and does not place or modify broker orders.
- Pre-news momentum is not a prediction of the event outcome.
- Existing production deployment is not part of this project.
