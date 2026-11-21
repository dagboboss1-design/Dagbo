# DAGBO SIGNAL — isolated Next.js application

This directory is the clean rebuild deployed by the separate Vercel project **dagbo-signal-next**. The existing DAGBO production site is not changed.

## Included application areas

- Overview and workspace navigation
- Live market-data endpoint and closed-candle confluence scan (EMA, RSI, MACD, Bollinger context, price action and breakout evidence)
- Candlestick chart with local saved trendline, horizontal, rectangle and long/short position drawings
- News calendar with a fail-closed news-spike monitoring endpoint
- Hedging review using live 1H/4H candles
- Local trade journal with candle-based SL/TP monitoring while the page is open
- BOSS1 AI with voice input, speech playback and the latest five questions
- Account settings for balance, risk, enabled pairs and live USD/NGN conversion
- Email/username registration and login; Google OAuth flow is ready when Google client credentials are supplied
- Browser push subscription, test notification and signed-in scan notifications

## Required private environment

- `TWELVE_DATA_API_KEY` — FX, metals and index candles supported by the account.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — candle cache, push subscriptions, alert deduplication and account records.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — browser push delivery.
- `DAGBO_CRON_SECRET` — bearer token protecting scheduled scans. It is also configured as the Vercel automation-bypass secret so Cron-job.org can reach protected preview routes.
- `DAGBO_AUTH_SECRET` — signs account sessions.
- `GROQ_API_KEY` — BOSS1 AI.
- `FMP_API_KEY` — optional primary economic calendar. The news route falls back to the public Forex Factory calendar.
- `DAGBO_GOOGLE_CLIENT_ID` and `DAGBO_GOOGLE_CLIENT_SECRET` — optional Google sign-in credentials. Set the OAuth redirect URI to `https://YOUR_PREVIEW_HOST/api/auth/google/callback` (and the eventual production host when promoted).

All keys remain server-side. Do not add secrets to browser code or commit them to Git.

## News alert scheduler

The protected endpoint is `GET /api/cron/news`. Configure Cron-job.org to call the preview alias plus `/api/cron/news` every minute. Send both headers with the same `DAGBO_CRON_SECRET` value:

- `x-vercel-protection-bypass: YOUR_DAGBO_CRON_SECRET`
- `Authorization: Bearer YOUR_DAGBO_CRON_SECRET`

The route deduplicates each event alert in Redis and sends 1-hour reminders, 15-minute pre-event context and observed post-release price movement. A successful scan response does not guarantee that a phone notification was delivered; verify a device subscription with the Settings test button.

## Safety and limitations

- Missing, invalid or stale provider data means NO TRADE / NO DECISION; no fake prices or fabricated entries.
- Signal scans use completed candles and return Entry, SL, TP1, TP2 and an expiry boundary only when independent evidence groups agree.
- US index market hours use the New York regular session; exchange holidays are not yet sourced from a dedicated holiday calendar.
- The journal's SL/TP monitor runs while its page is open; it is not a broker connection or guaranteed background monitor.
- The account system stores password hashes and signed sessions in Redis. Email verification and password-reset email delivery require a connected mail provider.
- Google sign-in remains unavailable until the Google OAuth client ID and secret are added.
- News scanning still requires the external one-minute scheduler to be configured.
- Hedging is advisory only and does not place broker orders.
