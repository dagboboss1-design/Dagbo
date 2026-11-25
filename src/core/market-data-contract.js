/**
 * Shared canonical market-data contract used at provider boundaries.
 * Candles are UTC, positive, internally consistent OHLC values with strictly
 * increasing timestamps. Invalid or stale data must never be tradable.
 */
const TIMEFRAMES = new Set(["1", "5", "15", "30", "60", "240", "1day", "1week"]);
function toNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function normalizeCandle(row) {
  if (!row || typeof row !== "object") return null;
  const rawTime = String(row.datetime || row.time || row.timestamp || "");
  const time = Date.parse(rawTime.includes("T") ? rawTime : rawTime.replace(" ", "T") + "Z");
  const open = toNumber(row.open ?? row.o), high = toNumber(row.high ?? row.h);
  const low = toNumber(row.low ?? row.l), close = toNumber(row.close ?? row.c);
  const volume = toNumber(row.volume ?? row.v ?? 0);
  if (!Number.isFinite(time) || [open, high, low, close, volume].some(value => value === null) ||
      open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return { datetime: new Date(time).toISOString().slice(0, 19).replace("T", " "),
    open: String(open), high: String(high), low: String(low), close: String(close), volume: String(volume) };
}
function validateMarketData(payload, options = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { valid: false, errors: ["Payload must be an object"] };
  const pair = String(payload.pair || "").toUpperCase();
  const timeframe = String(payload.timeframe || payload.tf || "");
  const provider = String(payload.provider || "");
  if (!/^[A-Z0-9]{3,12}$/.test(pair)) errors.push("Invalid market pair");
  if (!TIMEFRAMES.has(timeframe)) errors.push("Unsupported timeframe");
  if (!provider) errors.push("Missing provider identity");
  if (!Array.isArray(payload.values)) errors.push("Candles must be an array");
  const candles = Array.isArray(payload.values) ? payload.values.map(normalizeCandle) : [];
  if (candles.some(candle => !candle)) errors.push("One or more candles failed OHLC validation");
  const valid = candles.filter(Boolean);
  if (valid.length < (options.minimumCandles || 30)) errors.push("Insufficient valid candles");
  const times = valid.map(candle => Date.parse(candle.datetime.replace(" ", "T") + "Z"));
  for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) { errors.push("Candle timestamps must be strictly increasing"); break; }
  return { valid: errors.length === 0, errors, payload: errors.length ? null :
    { ...payload, pair, timeframe, provider, marketDataType: "DIRECT", values: valid } };
}
module.exports = { normalizeCandle, validateMarketData, TIMEFRAMES };
