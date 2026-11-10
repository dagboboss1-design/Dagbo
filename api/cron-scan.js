const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY",
  GBPJPY: "GBP/JPY", AUDUSD: "AUD/USD", USDCHF: "USD/CHF",
  USDCAD: "USD/CAD", NZDUSD: "NZD/USD", EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  US30: "DJI", US100: "NDX", NAS100: "NDX", US500: "SPX",
  BTCUSD: "BTC/USD", BTC: "BTC/USD", ETHUSD: "ETH/USD", ETH: "ETH/USD"
};
const DEFAULT_PAIRS = ["XAUUSD","EURUSD","GBPUSD","US30","BTCUSD"];
const MAX_PAIRS = 6;

async function getConfiguredPairs() {
  const ids = await redis.smembers("dagbo:push:subscriptions");
  const selected = new Set();
  for (const id of ids) {
    const raw = await redis.get("dagbo:scan:pairs:" + id);
    if (!raw) continue;
    let list = [];
    try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch(e) {}
    if (Array.isArray(list)) {
      for (const item of list) {
        const pair = String(item).toUpperCase();
        if (SYMBOLS[pair]) selected.add(pair);
      }
    }
  }
  return (selected.size ? Array.from(selected) : DEFAULT_PAIRS).slice(0, MAX_PAIRS);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ema(values, period) {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function rsi(values, period) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gain += diff; else loss -= diff;
  }
  if (!loss) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}
function analyze(candles, pair) {
  const closes = candles.map(c => num(c.close));
  if (closes.some(v => v === null) || closes.length < 50) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const o=num(last.open), c=num(last.close), h=num(last.high), l=num(last.low);
  const po=num(prev.open), pc=num(prev.close);
  if ([o,c,h,l,po,pc].some(v=>v===null)) return null;
  const votes=[], evidence=[];
  const add=(name,dir,detail)=>{if(dir==="BUY"||dir==="SELL"){votes.push(dir);evidence.push(name+": "+detail+" ("+dir+")");}};
  const rv=rsi(closes,14), e20=ema(closes,20), e50=ema(closes,50);
  const trend=e20>e50&&c>e20?"BUY":e20<e50&&c<e20?"SELL":"WAIT";
  add("EMA trend",trend,"EMA20 "+(e20>e50?"above":"below")+" EMA50");
  const rsiDir=rv<32?"BUY":rv>68?"SELL":"WAIT";
  add("RSI(14)",rsiDir,"RSI "+rv.toFixed(1));
  const e12=ema(closes,12), e26=ema(closes,26);
  const prev12=ema(closes.slice(0,-1),12), prev26=ema(closes.slice(0,-1),26);
  const macd=e12-e26, prevMacd=prev12-prev26;
  const macdDir=macd>0&&macd>prevMacd?"BUY":macd<0&&macd<prevMacd?"SELL":"WAIT";
  add("MACD momentum",macdDir,"MACD "+macd.toPrecision(4));
  const body=Math.abs(c-o), range=Math.max(h-l,1e-12), lower=Math.min(o,c)-l, upper=h-Math.max(o,c);
  let candleDir="WAIT", candleName="No clear reversal pattern";
  if(c>o&&pc<po&&c>=po&&o<=pc){candleDir="BUY";candleName="Bullish engulfing";}
  else if(c<o&&pc>po&&c<=po&&o>=pc){candleDir="SELL";candleName="Bearish engulfing";}
  else if(lower>Math.max(body*2,range*.45)&&c>o){candleDir="BUY";candleName="Bullish rejection / pin bar";}
  else if(upper>Math.max(body*2,range*.45)&&c<o){candleDir="SELL";candleName="Bearish rejection / pin bar";}
  add("Candlestick reading",candleDir,candleName);
  const prior=candles.slice(-21,-1);
  const swingHigh=Math.max(...prior.map(x=>num(x.high))), swingLow=Math.min(...prior.map(x=>num(x.low)));
  const structure=c>swingHigh?"BUY":c<swingLow?"SELL":"WAIT";
  const priorTrend=ema(closes.slice(0,-1),20)>ema(closes.slice(0,-1),50)?"BUY":"SELL";
  const structureName=structure==="WAIT"?"No confirmed break":structure===priorTrend?"BOS":"CHoCH";
  add("ICT / SMC "+structureName,structure,structure==="BUY"?"close broke recent swing high":structure==="SELL"?"close broke recent swing low":"no confirmed swing break");
  const sweep=(h>swingHigh&&c<swingHigh)?"SELL":(l<swingLow&&c>swingLow)?"BUY":"WAIT";
  add("ICT liquidity sweep",sweep,sweep==="SELL"?"swept prior high and closed back below":sweep==="BUY"?"swept prior low and closed back above":"no sweep-and-reclaim");
  const twoBack=candles[candles.length-3];
  const fvg=twoBack&&l>num(twoBack.high)?"BUY":twoBack&&h<num(twoBack.low)?"SELL":"WAIT";
  add("ICT fair value gap",fvg,fvg==="BUY"?"bullish 3-candle imbalance":fvg==="SELL"?"bearish 3-candle imbalance":"no 3-candle gap");
  const recent=closes.slice(-20),mean=recent.reduce((sum,v)=>sum+v,0)/recent.length;
  const variance=recent.reduce((sum,v)=>sum+Math.pow(v-mean,2),0)/recent.length,dev=Math.sqrt(variance);
  const bb=c<mean-2*dev&&c>o?"BUY":c>mean+2*dev&&c<o?"SELL":"WAIT";
  add("Bollinger Bands(20,2)",bb,bb==="BUY"?"lower-band rejection":bb==="SELL"?"upper-band rejection":"no band-rejection setup");
  const vols=candles.slice(-21,-1).map(x=>num(x.volume)).filter(v=>v!==null);
  const currentVol=num(last.volume),avgVol=vols.length?vols.reduce((sum,v)=>sum+v,0)/vols.length:0;
  const volume= currentVol!==null&&avgVol>0&&currentVol>avgVol*1.5?(c>o?"BUY":c<o?"SELL":"WAIT"):"WAIT";
  add("Volume confirmation",volume,avgVol>0&&currentVol!==null?(currentVol/avgVol).toFixed(2)+"x 20-bar average":"volume unavailable");
  const buys=votes.filter(v=>v==="BUY").length,sells=votes.filter(v=>v==="SELL").length;
  const direction=buys>=3&&buys>sells?"BUY":sells>=3&&sells>buys?"SELL":"WAIT";
  const signal=direction==="BUY"?(buys>=6?"STRONG BUY":"BUY"):direction==="SELL"?(sells>=6?"STRONG SELL":"SELL"):"NO TRADE";
  let atr=0;
  for(let i=candles.length-14;i<candles.length;i++){
    const x=candles[i],p=candles[i-1],hi=num(x.high),lo=num(x.low),previousClose=num(p.close);
    atr+=Math.max(hi-lo,Math.abs(hi-previousClose),Math.abs(lo-previousClose));
  }
  atr/=14;
  const buy=signal.includes("BUY");
  return {
    pair,signal,entry:c,stopLoss:buy?c-atr*1.5:c+atr*1.5,
    takeProfit:buy?c+atr*2:c-atr*2,tp2:buy?c+atr*3.5:c-atr*3.5,
    rsi:Number(rv.toFixed(1)),evidence,buyScore:buys,sellScore:sells,totalMethods:9,
    structure:structureName,sweep,fvg,bb,volume,candlePattern:candleName,
    candleHigh:h,candleLow:l,candleTime:last.datetime||null
  };
}

function validAuth(req) {
  const secret = process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECRET;
  const auth = req.headers.authorization || "";
  if (!secret) return false;
  const a = Buffer.from(auth);
  const b = Buffer.from("Bearer " + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function vapidReady() {
  return !!(process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
async function sendToDevice(deviceId, title, body, tag, url) {
  if (!vapidReady()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const stored = await redis.get("dagbo:push:sub:" + deviceId);
  if (!stored) return false;
  const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body, tag, url: url || "/signals.html" }), { TTL: 900, urgency: "high" });
    return true;
  } catch (err) {
    if ([404,410].includes(err.statusCode)) {
      await redis.del("dagbo:push:sub:" + deviceId);
      await redis.srem("dagbo:push:subscriptions", deviceId);
    }
    throw err;
  }
}
async function broadcast(title, body, tag) {
  if (!vapidReady()) throw new Error("VAPID push keys are not configured");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const ids = await redis.smembers("dagbo:push:subscriptions");
  let sent = 0, failed = 0;
  for (const id of ids) {
    const raw = await redis.get("dagbo:push:sub:" + id);
    if (!raw) { await redis.srem("dagbo:push:subscriptions", id); continue; }
    try {
      const sub = typeof raw === "string" ? JSON.parse(raw) : raw;
      await webpush.sendNotification(sub, JSON.stringify({ title, body, tag, url: "/signals.html" }), { TTL: 900, urgency: "high" });
      sent++;
    } catch (err) {
      failed++;
      if ([404,410].includes(err.statusCode)) {
        await redis.del("dagbo:push:sub:" + id);
        await redis.srem("dagbo:push:subscriptions", id);
      } else console.error("Push delivery failed:", err.message);
    }
  }
  return { sent, failed, devices: ids.length };
}
async function monitorTrades(marketData) {
  const devices = await redis.smembers("dagbo:trades:devices");
  let closed = 0, warnings = 0;
  for (const deviceId of devices) {
    const ids = await redis.smembers("dagbo:trades:device:" + deviceId);
    for (const tradeId of ids) {
      const key = "dagbo:trade:" + deviceId + ":" + tradeId;
      const raw = await redis.get(key);
      if (!raw) { await redis.srem("dagbo:trades:device:" + deviceId, tradeId); continue; }
      const trade = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (trade.status !== "OPEN") continue;
      const market = marketData[trade.pair];
      if (!market) continue;
      const buy = trade.direction === "BUY";
      const sl = num(trade.stopLoss), tp = num(trade.takeProfit);
      if (sl === null || tp === null) continue;
      const hitSL = buy ? market.candleLow <= sl : market.candleHigh >= sl;
      const hitTP = buy ? market.candleHigh >= tp : market.candleLow <= tp;
      if (hitSL && hitTP) {
        const flag = "both-hit:" + market.candleTime;
        if (trade.lastWarning !== flag) {
          await sendToDevice(deviceId, "⚠️ TRADE REVIEW NEEDED", trade.pair + ": TP and SL both fell inside the same 15m candle. Order is unknown; check your broker/chart manually.", "trade-review-" + tradeId, "/journal.html");
          trade.lastWarning = flag;
          await redis.set(key, JSON.stringify(trade));
          warnings++;
        }
        continue;
      }
      if (hitSL || hitTP) {
        trade.status = "CLOSED";
        trade.result = hitTP ? "WIN" : "LOSS";
        trade.exit = hitTP ? tp : sl;
        trade.closeReason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
        trade.dateClosed = new Date().toISOString();
        await sendToDevice(deviceId, hitTP ? "🎯 TAKE PROFIT HIT" : "🛑 STOP LOSS HIT",
          trade.pair + " " + trade.direction + " reached " + (hitTP ? "Take Profit" : "Stop Loss") + " at " + trade.exit + ". Review and update your journal.",
          "trade-close-" + tradeId, "/journal.html");
        await redis.set(key, JSON.stringify(trade));
        closed++;
        continue;
      }
      const current = num(market.entry);
      const riskDistance = Math.abs(trade.entry - sl);
      const rewardDistance = Math.abs(tp - trade.entry);
      if (current !== null && riskDistance > 0 && rewardDistance > 0) {
        const adverseRemaining = buy ? current - sl : sl - current;
        const targetRemaining = buy ? tp - current : current - tp;
        if (adverseRemaining > 0 && adverseRemaining / riskDistance <= 0.20 && !trade.nearSlAlerted) {
          await sendToDevice(deviceId, "⚠️ PRICE NEAR STOP LOSS",
            trade.pair + " is within about 20% of the remaining distance to your Stop Loss. Review risk and your broker position.",
            "trade-near-sl-" + tradeId, "/journal.html");
          trade.nearSlAlerted = true;
          await redis.set(key, JSON.stringify(trade));
          warnings++;
        }
        if (targetRemaining > 0 && targetRemaining / rewardDistance <= 0.20 && !trade.nearTpAlerted) {
          await sendToDevice(deviceId, "🎯 PRICE NEAR TAKE PROFIT",
            trade.pair + " is within about 20% of your Take Profit distance. Consider your trade-management plan.",
            "trade-near-tp-" + tradeId, "/journal.html");
          trade.nearTpAlerted = true;
          await redis.set(key, JSON.stringify(trade));
          warnings++;
        }
      }
      const opposite = market.signal && market.signal !== "NO TRADE" &&
        ((buy && market.signal.includes("SELL")) || (!buy && market.signal.includes("BUY")));
      if (opposite) {
        const flag = "opposite:" + market.signal;
        if (trade.lastWarning !== flag) {
          await sendToDevice(deviceId, "⚠️ TRADE DIRECTION WARNING",
            market.signal + " signal appeared for " + trade.pair + " while your " + trade.direction + " trade is open. Review your risk; this does not close the trade.",
            "trade-opposite-" + tradeId, "/journal.html");
          trade.lastWarning = flag;
          await redis.set(key, JSON.stringify(trade));
          warnings++;
        }
      }
    }
  }
  return { closed, warnings };
}

module.exports = async function handler(req, res) {
  if (!validAuth(req)) return res.status(401).json({ error: "Unauthorized scheduled scan" });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Missing TWELVE_DATA_API_KEY environment variable" });
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: "Upstash Redis is not configured" });
  }

  const lock = "dagbo:cron:scan:lock";
  const acquired = await redis.set(lock, String(Date.now()), { nx: true, ex: 13 * 60 });
  if (acquired !== "OK") return res.status(200).json({ skipped: true, reason: "A scan is already running" });

  try {
    const results = {}, errors = [];
    const pairsToScan = await getConfiguredPairs();
    const fetched = await Promise.all(pairsToScan.map(async pair => {
      const symbol = SYMBOLS[pair];
      const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
        "&interval=15min&outputsize=60&apikey=" + encodeURIComponent(apiKey);
      try {
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok || data.status === "error" || !Array.isArray(data.values) || data.values.length < 50) {
          throw new Error(data.message || "Insufficient candle data");
        }
        const analysis = analyze(data.values.slice().reverse(), pair);
        if (!analysis) throw new Error("Could not calculate indicators");
        return { pair, analysis };
      } catch (err) {
        return { pair, error: err.message };
      }
    }));

    for (const item of fetched) {
      if (item.error) { errors.push({ pair: item.pair, error: item.error }); continue; }
      const pair = item.pair, analysis = item.analysis;
      results[pair] = analysis;
      const stateKey = "dagbo:scan:signal:" + pair;
      const previousRaw = await redis.get(stateKey);
      const previous = previousRaw ? (typeof previousRaw === "string" ? JSON.parse(previousRaw) : previousRaw) : null;
      if (analysis.signal !== "NO TRADE") {
        if (!previous || previous.signal !== analysis.signal) {
          const title = !previous || previous.signal === "NO TRADE" ? "🔔 NEW " + analysis.signal + " SIGNAL" :
            (previous.signal.includes("BUY") !== analysis.signal.includes("BUY") ? "🔄 SIGNAL DIRECTION CHANGED" : "📈 SIGNAL STRENGTH CHANGED");
          const body = pair + " · " + analysis.signal + " · Entry " + analysis.entry.toFixed(5) +
            " · SL " + analysis.stopLoss.toFixed(5) + " · TP " + analysis.takeProfit.toFixed(5) +
            " · 15m scan. Confirm on your chart before acting.";
          await broadcast(title, body, "signal-" + pair);
        }
      } else if (previous && previous.signal !== "NO TRADE") {
        await broadcast("ℹ️ SIGNAL NO LONGER ACTIVE", pair + " no longer meets the 2-of-3 confluence rule. Review any pending setup.", "signal-ended-" + pair);
      }
      await redis.set(stateKey, JSON.stringify({ signal: analysis.signal, candleTime: analysis.candleTime, scannedAt: new Date().toISOString() }), { ex: 60 * 60 * 24 * 7 });
    }

    const tradeSummary = await monitorTrades(results);
    const errorKey = "dagbo:scan:error:last";
    const previousErrorRaw = await redis.get(errorKey);
    if (errors.length) {
      const signature = errors.map(x => x.pair).sort().join(",");
      let previousError = null;
      try { previousError = previousErrorRaw ? (typeof previousErrorRaw === "string" ? JSON.parse(previousErrorRaw) : previousErrorRaw) : null; } catch(e) {}
      const shouldNotify = !previousError || previousError.signature !== signature ||
        Date.now() - Number(previousError.at || 0) >= 60 * 60 * 1000;
      if (shouldNotify) {
        await broadcast("⚠️ MARKET SCANNER DATA WARNING",
          "DAGBO could not get fresh data for: " + errors.map(x => x.pair).join(", ") +
          ". Other available markets were scanned. Check your Twelve Data key or API limits.",
          "scanner-data-warning");
      }
      await redis.set(errorKey, JSON.stringify({signature,at:Date.now()}), {ex:60*60*24});
    } else if (previousErrorRaw) {
      await broadcast("✅ MARKET SCANNER RECOVERED",
        "DAGBO has successfully received fresh market data again for all selected markets.",
        "scanner-data-recovered");
      await redis.del(errorKey);
    }
    const responseBody = {
      success: true, scannedAt: new Date().toISOString(),
      scanned: Object.keys(results), errors, signals: results,
      tradeMonitoring: tradeSummary,
      note: "Scheduled 15-minute market scan; alerts are informational and do not execute broker orders."
    };
    await redis.set("dagbo:cron:scan:last", JSON.stringify({
      scannedAt: responseBody.scannedAt, scanned: responseBody.scanned, errors
    }), { ex: 60 * 60 * 24 * 7 });
    return res.status(200).json(responseBody);
  } catch (err) {
    console.error("DAGBO 15m scan failed:", err);
    return res.status(502).json({ error: "15-minute scan failed", detail: err.message });
  } finally {
    await redis.del(lock);
  }
};
