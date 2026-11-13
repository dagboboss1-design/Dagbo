# DAGBO Cloudflare compatibility branch

This branch prepares a Cloudflare Workers deployment while keeping the existing Vercel deployment and `main` branch unchanged.

## What is in place

- `wrangler.toml` points Cloudflare Workers at `cloudflare/worker.js`.
- Static website files are served through the Workers Static Assets binding.
- Requests under `/api/*` are routed through a Fetch-to-Vercel compatibility adapter.
- The adapter translates Cloudflare Fetch API requests into the `req`/`res` interface used by the existing API handlers.
- The compatibility date is `2026-11-13`, which enables Cloudflare's current Node.js compatibility behavior and populated `process.env`.
- The Cloudflare branch replaces the Node-oriented `web-push` dependency with `@block65/webcrypto-web-push`. The shared API handlers use `lib/push-adapter.js` to send notifications through Web Crypto and `fetch`.

## Important before production

This is a migration scaffold, not a production-ready migration yet. Do not point the live domain here until the Cloudflare build and endpoint tests pass.

The remaining API code uses `@upstash/redis`, CommonJS `require`, Node `crypto`, `Buffer`, and `process.env`. These rely on Cloudflare's Node compatibility support and must be confirmed by the dry-run build and endpoint tests. The Cloudflare push adapter must also be tested with real browser subscriptions before production.

## Local checks

1. Install dependencies with `npm install`.
2. Run `npx wrangler deploy --dry-run` to validate bundling without deploying.
3. Run `npx wrangler dev` and test every API route.
4. Add secrets in Cloudflare Workers settings; never commit secrets:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `TWELVE_DATA_API_KEY`
   - `GROQ_API_KEY`
   - `DAGBO_CRON_SECRET`
   - `SIGNAL_PUSH_SECURITY` (if used)
   - `VAPID_SUBJECT`
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`

The scheduled GitHub Actions workflows still call the Vercel hostname. Update them only after the Cloudflare deployment has passed end-to-end tests and the new Worker URL is known.
