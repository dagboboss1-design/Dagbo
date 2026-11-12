# DAGBO Multi-Pair Spike Predictor — Phase 1

This branch adds an isolated experimental analysis engine. It does not replace existing signals, news alerts, notifications, chart, journal, or app navigation.

## API

- `GET /api/spike-predictor?pair=EURUSD&mode=live`
- `GET /api/spike-predictor?pair=GBPJPY&mode=pre-news`

Supported instruments are defined in `lib/spike-engine.js`. Data availability depends on the Twelve Data account and symbol coverage. Several CFD aliases share provider symbols (for example, US100 and NAS100 both map to NDX); broker naming and provider entitlements must be checked before enabling these instruments publicly.

## Check Twelve Data symbol coverage

The coverage checker uses the API key from the environment and never prints it. Run the four core instruments first:

```sh
TWELVE_DATA_API_KEY=your_key node scripts/check-twelve-data-symbols.js
```

To check every unique provider symbol in the engine:

```sh
TWELVE_DATA_API_KEY=your_key node scripts/check-twelve-data-symbols.js --all
```

On PowerShell, set the environment variable for the current session first:

```powershell
$env:TWELVE_DATA_API_KEY="your_key"
node scripts/check-twelve-data-symbols.js
```

You can also run the manual GitHub workflow: open the repository's **Actions** tab, choose **Check Twelve Data Coverage**, then select **Run workflow**. Leave `all_symbols` off for the four core pairs. For this workflow, first add a repository Actions secret named `TWELVE_DATA_API_KEY` under **Settings → Secrets and variables → Actions**. Use the same provider key stored in Vercel, but do not paste it into chat, code, or the workflow file. If that GitHub secret is not set, the workflow stops safely with a clear message.

Do not commit the key, put it in source code, or send it in chat. The default check makes four sequential 5-minute candle requests. The optional `--all` check makes one request per unique provider symbol and may consume more API credits. A successful two-candle response confirms basic access only, not historical depth or continuous uptime.

## Modes

- LIVE: analyses recent completed 5-minute candles for volatility compression/expansion, acceleration, 20-bar range breaks, available volume, and directional vote agreement.
- PRE-NEWS: finds a matching high-impact calendar event within 20 minutes, selects completed 15-minute candles ending before the 15-minute pre-release cutoff, and adds event-risk context. The upcoming forecast/unknown actual result does not decide BUY or SELL.

## Important score interpretation

`spikeScore` is a transparent, rule-based setup score, not a calibrated probability. `directionAgreementPct` is the share of directional votes on the leading side, not a statistical win probability. Both require historical calibration and out-of-sample validation before public marketing as predictive accuracy.

The endpoint is read-only and does not place trades or send notifications. It requires the existing `TWELVE_DATA_API_KEY` server environment variable. It is not yet connected to cron scanning or the Signals page.

## Historical evaluation

The walk-forward evaluator uses only candles available at each signal timestamp and scores later candles separately.

```sh
node --test tests/*.test.js
node scripts/backtest-spike.js ./data/EURUSD-5min.json EURUSD
```

Input may be a JSON array of candles or a Twelve Data response object with a `values` array. The report separates spike-detection precision/recall from directional trade win rate and average R. It uses conservative stop-first handling when a candle touches both target and stop. Results are gross of costs unless `ROUND_TRIP_COST` is set to a price-unit cost.

Run each pair separately. Keep an earlier date range for rule development and a later untouched range for out-of-sample validation. Do not tune thresholds on the final test range. This evaluator does not itself establish predictive accuracy; real historical candles and realistic pair/session costs are required.

## Tests

Run with Node.js:

```sh
node --test tests/*.test.js
```
