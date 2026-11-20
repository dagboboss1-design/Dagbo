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
