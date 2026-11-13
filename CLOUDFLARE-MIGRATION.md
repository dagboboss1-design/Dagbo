# DAGBO Cloudflare compatibility branch

This branch prepares a Cloudflare Workers deployment while keeping the existing Vercel deployment and `main` branch unchanged.

## Cloudflare-specific work completed

- `wrangler.toml` uses a Cloudflare Worker entry point and the existing root-level HTML/CSS/JS files as static assets.
- `.assetsignore` excludes backend source, workflow files, package metadata, local secrets files and migration notes from public static assets.
- `cloudflare/worker.js` routes every existing `/api/*` endpoint through a Fetch-to-Vercel adapter. The adapter supplies the request fields and response methods used by the current handlers.
- The compatibility date is `2026-11-13`. This date enables Cloudflare's current Node.js compatibility behavior and access to Worker bindings through `process.env`.
- `lib/redis.js` lazily creates the Upstash Redis client. Missing Redis secrets no longer crash the Worker during module startup.
- Push notifications use `@block65/webcrypto-web-push` through `lib/push-adapter.js`, avoiding the old Node-oriented `web-push` dependency.
- VAPID configuration is deferred until a notification is actually sent, so missing push secrets do not crash Worker startup.
- Cron endpoints use the same accepted secret names: `DAGBO_CRON_SECRET`, `CRON_SECRET`, `SIGNAL_PUSH_SECURITY`, or `SIGNAL_PUSH_SECRET`.
- `api/health.js` reports the cron secret consistently.
- GitHub Actions validates the bundle and runs local Worker smoke tests for static assets, API routing, environment variables, Node crypto authentication checks and protection of backend source files.

## Required Cloudflare Worker secrets

Add these in Cloudflare Dashboard → Workers & Pages → DAGBO Worker → Settings → Variables and Secrets. Mark credentials as secrets. Do not commit their values.

Required for the main features:
- `TRADING_ECONOMICS_API_KEY` (optional paid/provider credential for macro time-series indicators and relative currency-strength analysis; not needed for the free ShowMyTrades calendar)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `TWELVE_DATA_API_KEY`
- `GROQ_API_KEY`
- `DAGBO_CRON_SECRET` (use the same value already stored in GitHub Actions)

Required for push notifications:
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

Optional:
- `NEWS_SPIKE_TWELVE_DATA_API_KEY`
- `SPIKE_TWELVE_DATA_API_KEY`
- `CRON_SECRET`
- `SIGNAL_PUSH_SECURITY`
- `SIGNAL_PUSH_SECRET`

The optional Twelve Data spike keys are fallbacks; `TWELVE_DATA_API_KEY` is sufficient for the shared provider setup. Use one cron secret consistently where possible.

## Free economic calendar integration

- `/api/calendar` now proxies ShowMyTrades' public economic calendar endpoint. It needs no account, API key, or new Cloudflare secret.
- The News page countdown and the scheduled news monitor use this feed for high-impact releases across USD, EUR, GBP, JPY, AUD, NZD, CAD, CHF and CNY.
- The normalized event data includes scheduled UTC time, impact, actual, forecast, previous, event status, confidence and schedule-change metadata where supplied.
- News spike alerts continue to separate pre-release price/flow context from post-release observed results. Actual-versus-forecast is displayed as event context; it is not treated as a guaranteed price direction.
- The News page links to ShowMyTrades' calendar and identifies the source. See https://showmytrades.com/docs/api/economic-calendar.
- No `TRADING_ECONOMICS_API_KEY` is required for this calendar. The separate macro time-series endpoint still uses Trading Economics until another indicators provider is integrated.

## Fundamental analysis integration

- `fundamental.html` provides the dedicated macro dashboard.
- `/api/fundamentals` retrieves published macro snapshots for USD, EUR, GBP, JPY, CAD, AUD, CHF and NZD from Trading Economics.
- The relative currency score uses interest-rate support (40%), GDP growth (35%) and inverse unemployment (25%); inflation is shown as context and is not mechanically scored.
- Fundamental context widgets are added to Signals, Market News and Opportunity & Trend Intelligence. The dedicated page is linked in the main navigation and Home.
- The macro score is contextual confirmation only. It must not override price action or independently trigger a trade. Missing or stale series are excluded.

## Validation status and remaining work

The GitHub workflow must pass both:
1. Wrangler's `deploy --dry-run` bundle check.
2. The local Worker runtime smoke tests.

These checks do not validate real Upstash credentials, live Twelve Data/Groq requests, actual browser push delivery, or the scheduled GitHub Actions calls. Those require Cloudflare secrets and end-to-end tests after a Worker preview is deployed.

Do not point the production domain or scheduled workflows to Cloudflare until the preview passes those end-to-end tests. The existing GitHub Actions workflows still use the current Vercel URLs intentionally; they must be switched to the verified Cloudflare Worker URL as a separate cutover step.
