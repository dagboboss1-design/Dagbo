# DAGBO Cloudflare compatibility branch

This branch prepares a Cloudflare Workers deployment while keeping the existing Vercel deployment and `main` branch unchanged.

## What is in place

- `wrangler.toml` points Cloudflare Workers at `cloudflare/worker.js`.
- Static website files are served through the Workers Static Assets binding.
- Requests under `/api/*` are routed through a compatibility adapter to the existing API handlers.
- The adapter translates Fetch API requests into the Vercel-style `req`/`res` interface currently used by the API files.
- Compatibility date is set to 2026-11-13. Cloudflare's current Node.js compatibility behavior is enabled by that date, including Node built-in compatibility and populated `process.env`.

## Important before production

This is a migration scaffold, not a production-ready migration yet. Do not point the live domain here until the Cloudflare build and endpoint tests pass.

The API modules still contain Node/CommonJS dependencies, including `web-push`, `@upstash/redis`, `crypto`, `Buffer`, and `process.env`. Cloudflare's Node compatibility layer supports many Node APIs but not every Node package. In particular, the Web Push package must be verified in the Workers runtime; Cloudflare documents some Node modules as stubs rather than full implementations. If `web-push` uses an unsupported API, replace only the Cloudflare branch's push transport with a Web-Crypto-based implementation such as `@block65/webcrypto-web-push`, preserving the Vercel implementation on `main`.

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

The scheduled GitHub Actions workflows currently call the Vercel hostname. Update them only after the Cloudflare deployment has passed end-to-end tests and the new Worker URL is known.
