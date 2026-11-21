import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
type Candle = { time: string; open: number; high: number; low: number; close: number; volume?: number | null };
const DURATIONS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
const CRYPTO = new Set(["BTCUSD", "ETHUSD"]);
const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / Math.max(1, a.length);
function ema(values: number[], period: number) {
  const k = 2 / (period + 1); let out = values[0] ?? 0;
  for (const v of values.slice(1)) out = v * k + out * (1 - k);
  return out;
}
function rsi(values: number[], period = 14) {
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
function atr(c: Candle[], period = 14) {
  const rows = c.slice(-(period + 1));
  const ranges = rows.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - rows[i].close), Math.abs(x.low - rows[i].close)));
  return mean(ranges);
}
function marketOpen(pair: string, now: Date) {
  if (CRYPTO.has(pair)) return true;
  const day = now.getUTCDay(), hour = now.getUTCHours();
  return (day >= 1 && day <= 4) || (day === 0 && hour >= 21) || (day === 5 && hour < 21);
}
function candleTime(s: string) {
  const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  return new Date(normalized).getTime();
}
export async function GET(req: NextRequest) {
  const pair = (req.nextUrl.searchParams.get("pair") || "XAUUSD").toUpperCase();
  const tf = req.nextUrl.searchParams.get("tf") || "15m";
  const duration = DURATIONS[tf];
  if (!duration) return NextResponse.json({ ok: false, status: "NO TRADE", error: "Unsupported timeframe." }, { status: 400 });
  const now = new Date();
  if (!marketOpen(pair, now)) return NextResponse.json({ ok: true, status: "NO TRADE", reason: "Market is closed. No new setup is issued.", pair, timeframe: tf, checkedAt: now.toISOString() });
  try {
    const response = await fetch(new URL("/api/market-data?pair=" + encodeURIComponent(pair) + "&tf=" + encodeURIComponent(tf), req.nextUrl.origin), { cache: "no-store" });
    const feed = await response.json();
    if (!response.ok || !feed.ok || feed.stale) return NextResponse.json({ ok: false, status: "NO TRADE", reason: feed.error || "Live market data is unavailable or stale.", pair, timeframe: tf }, { status: 503 });
    const candles = (feed.candles as Candle[]).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite) && candleTime(c.time) + duration <= now.getTime());
    if (candles.length < 60) return NextResponse.json({ ok: true, status: "NO TRADE", reason: "Not enough completed candles for a reliable multi-indicator check.", pair, timeframe: tf });
    const closes = candles.map(c => c.close), last = candles.at(-1)!, prev = candles.at(-2)!;
    const e20 = ema(closes.slice(-80), 20), e50 = ema(closes.slice(-120), 50);
    const r = rsi(closes), macdLine = ema(closes.slice(-100), 12) - ema(closes.slice(-100), 26);
    const macdPrev = ema(closes.slice(-101, -1), 12) - ema(closes.slice(-101, -1), 26);
    const mid = mean(closes.slice(-20)), sd = Math.sqrt(mean(closes.slice(-20).map(x => (x - mid) ** 2)));
    const upper = mid + 2 * sd, lower = mid - 2 * sd;
    const trend = e20 > e50 && last.close > e20 ? "BUY" : e20 < e50 && last.close < e20 ? "SELL" : "FLAT";
    const indicator = trend === "BUY" && r >= 50 && r <= 72 && macdLine > macdPrev ? "BUY" : trend === "SELL" && r <= 50 && r >= 28 && macdLine < macdPrev ? "SELL" : "FLAT";
    const body = Math.abs(last.close - last.open), range = Math.max(last.high - last.low, Number.EPSILON);
    const bullishEngulf = last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close;
    const bearishEngulf = last.close < last.open && prev.close > prev.open && last.close <= prev.open && last.open >= prev.close;
    const bullishPin = last.close > last.open && (Math.min(last.open, last.close) - last.low) > body * 1.8 && (last.high - Math.max(last.open, last.close)) < range * .25;
    const bearishPin = last.close < last.open && (last.high - Math.max(last.open, last.close)) > body * 1.8 && (Math.min(last.open, last.close) - last.low) < range * .25;
    const swing = candles.slice(-21, -1), resistance = Math.max(...swing.map(c => c.high)), support = Math.min(...swing.map(c => c.low));
    const bullBreak = last.close > resistance, bearBreak = last.close < support;
    const priceAction = bullishEngulf || bullishPin || bullBreak ? "BUY" : bearishEngulf || bearishPin || bearBreak ? "SELL" : "FLAT";
    const structure = bullBreak && last.close > upper ? "BUY" : bearBreak && last.close < lower ? "SELL" : "FLAT";
    const votes = [indicator, priceAction, structure];
    const buys = votes.filter(x => x === "BUY").length, sells = votes.filter(x => x === "SELL").length;
    const side = buys >= 2 && buys > sells ? "BUY" : sells >= 2 && sells > buys ? "SELL" : "NONE";
    const volatility = atr(candles);
    const entry = last.close, risk = volatility * 1.5;
    const sl = side === "BUY" ? entry - risk : entry + risk;
    const tp1 = side === "BUY" ? entry + risk * 2 : entry - risk * 2;
    const tp2 = side === "BUY" ? entry + risk * 3.5 : entry - risk * 3.5;
    const reasons = [
      "EMA20/EMA50 trend: " + trend,
      "RSI14: " + r.toFixed(1) + (r >= 70 || r <= 30 ? " (extreme)" : ""),
      "MACD momentum: " + (macdLine > macdPrev ? "rising" : macdLine < macdPrev ? "falling" : "flat"),
      bullishEngulf ? "Bullish engulfing" : bearishEngulf ? "Bearish engulfing" : bullishPin ? "Bullish pin bar" : bearishPin ? "Bearish pin bar" : bullBreak ? "20-candle resistance break" : bearBreak ? "20-candle support break" : "No confirmed reversal or breakout pattern",
      "Bollinger context: " + (last.close > upper ? "above upper band" : last.close < lower ? "below lower band" : "inside bands")
    ];
    if (side === "NONE" || !Number.isFinite(risk) || risk <= 0) return NextResponse.json({ ok: true, status: "NO TRADE", reason: "Confluence is insufficient. Wait for at least two independent evidence groups to agree.", pair, timeframe: tf, evidence: reasons, votes, checkedAt: now.toISOString() });
    const expiryAt = new Date(candleTime(last.time) + duration).toISOString();
    if (now.getTime() >= new Date(expiryAt).getTime()) return NextResponse.json({ ok: true, status: "NO TRADE", reason: "The setup candle has expired. Wait for a fresh closed-candle scan.", pair, timeframe: tf });
    return NextResponse.json({ ok: true, status: buys === 3 || sells === 3 ? "STRONG " + side : "WEAK " + side, side, pair, timeframe: tf, entry, sl, tp1, tp2, riskReward: "1:2 / 1:3.5", confidenceVotes: Math.max(buys, sells) + "/3", evidence: reasons, source: feed.source, candleTime: last.time, expiresAt: expiryAt, checkedAt: now.toISOString(), warning: "Technical confluence is not a guarantee. Confirm spread, session and position size before entry." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    return NextResponse.json({ ok: false, status: "NO TRADE", reason: error?.message || "Signal scan failed. No trade generated." }, { status: 503 });
  }
}
