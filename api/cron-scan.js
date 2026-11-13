const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const SYMBOLS = {
  XAUUSD: "XAU/USD", GOLD: "XAU/USD", DXY: "DXY",
  EURUSD: "EUR/USD", GBPUSD: "GBP/USD", USDJPY: "USD/JPY",
  GBPJPY: "GBP/JPY", AUDUSD: "AUD/USD", USDCHF: "USD/CHF",
  USDCAD: "USD/CAD", NZDUSD: "NZD/USD", EURJPY: "EUR/JPY", EURGBP: "EUR/GBP",
  EURCHF: "EUR/CHF", EURAUD: "EUR/AUD", EURCAD: "EUR/CAD", EURNZD: "EUR/NZD",
  GBPCHF: "GBP/CHF", GBPAUD: "GBP/AUD", GBPCAD: "GBP/CAD", GBPNZD: "GBP/NZD",
  AUDJPY: "AUD/JPY", AUDCHF: "AUD/CHF", AUDCAD: "AUD/CAD", AUDNZD: "AUD/NZD",
  NZDJPY: "NZD/JPY", NZDCHF: "NZD/CHF", NZDCAD: "NZD/CAD",
  CADJPY: "CAD/JPY", CADCHF: "CAD/CHF", CHFJPY: "CHF/JPY",
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
  const secret = process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECURITY || process.env.SIGNAL_PUSH_SECRET;
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
async function fetchPreNewsCandles(pair, cutoffMs, apiKey) {
  const symbol = SYMBOLS[pair];
  if (!symbol) throw new Error("No Twelve Data symbol mapping for " + pair);
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(symbol) +
    "&interval=15min&outputsize=60&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "No candle data");
  }
  // Twelve Data timestamps mark candle starts. Only use candles that had
  // fully closed by the release-minus-15-minute cutoff.
  const completed = data.values.map(c => {
    const t = Date.parse(String(c.datetime).replace(" ", "T") + (String(c.datetime).includes("Z") || /[+-]\\d\\d:\\d\\d$/.test(String(c.datetime)) ? "" : "Z"));
    return { candle: c, start: t, closeTime: t + 15 * 60 * 1000 };
  }).filter(x => Number.isFinite(x.start) && x.closeTime <= cutoffMs && x.start >= cutoffMs - 30 * 60 * 1000)
    .sort((a,b) => a.start - b.start);
  if (completed.length < 2) throw new Error("Need two completed 15-minute candles ending before the pre-news cutoff");
  return completed.slice(-2).map(x => x.candle);
}

function preNewsMove(candles) {
  if (!Array.isArray(candles) || candles.length !== 2) return null;
  const firstOpen = num(candles[0].open);
  const lastClose = num(candles[1].close);
  if (firstOpen === null || lastClose === null || firstOpen === 0) return null;
  const pct = (lastClose - firstOpen) / firstOpen * 100;
  const direction = pct > 0 ? "BUY" : pct < 0 ? "SELL" : "WAIT";
  return { direction, pct };
}

async function sendNewsAlerts(apiKey) {
  const now = Date.now();
  let eventsChecked = 0, newsAlerts = 0, preNewsSignals = 0;
  try {
    const response = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: { "User-Agent": "DAGBO-SIGNAL-Economic-Calendar/1.0" }
    });
    if (!response.ok) throw new Error("Economic calendar HTTP " + response.status);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid economic calendar response");

    const upcoming = rows.map(row => ({
      name: String(row.title || "Economic event").slice(0, 120),
      currency: String(row.country || "GLOBAL").toUpperCase(),
      impact: String(row.impact || ""),
      date: new Date(row.date)
    })).filter(event => event.impact.toLowerCase() === "high" &&
      Number.isFinite(event.date.getTime()) && event.date.getTime() > now &&
      event.date.getTime() <= now + 45 * 60 * 1000);
    eventsChecked = upcoming.length;

    for (const event of upcoming) {
      const eventId = crypto.createHash("sha256")
        .update(event.name + "|" + event.currency + "|" + event.date.toISOString()).digest("hex").slice(0, 20);
      const minutesToEvent = (event.date.getTime() - now) / 60000;
      const newsKey = "dagbo:news:alert:" + eventId;
      if (minutesToEvent <= 30 && !(await redis.get(newsKey))) {
        await broadcast("📰 HIGH-IMPACT NEWS COMING",
          event.currency + " · " + event.name + " is scheduled in about " +
          Math.max(1, Math.round(minutesToEvent)) +
          " minutes. Check spreads, volatility and your risk plan. Verify the live calendar.",
          "news-event-" + eventId);
        await redis.set(newsKey, "1", { ex: 60 * 60 * 24 * 2 });
        newsAlerts++;
      }

      // Analyse the event currency, its forex crosses, plus DXY and Gold
      // as broad USD/precious-metal context. This is not USD-only analysis.
      const cutoffMs = event.date.getTime() - 15 * 60 * 1000;
      if (now < cutoffMs || now >= event.date.getTime()) continue;
      const signalKey = "dagbo:news:pre-signal:" + eventId;
      if (await redis.get(signalKey)) continue;

      const forexPairs = Object.keys(SYMBOLS).filter(pair =>
        pair.length === 6 && /^[A-Z]{6}$/.test(pair) &&
        (event.currency === "GLOBAL" || pair.includes(event.currency)));
      const preNewsPairs = Array.from(new Set(["DXY", "XAUUSD", ...forexPairs]));
      const fetched = await Promise.all(preNewsPairs.map(async pair => {
        try {
          const candles = await fetchPreNewsCandles(pair, cutoffMs, apiKey);
          return { pair, ...preNewsMove(candles) };
        } catch (err) {
          return { pair, direction: "WAIT", error: err.message };
        }
      }));
      const byPair = Object.fromEntries(fetched.map(x => [x.pair, x]));

      // For a currency-specific event, a rising BASE/QUOTE pair supports
      // strength in the base currency; a falling pair supports quote strength.
      const currencyVotes = forexPairs.map(pair => {
        const item = byPair[pair];
        if (!item || item.error || item.direction === "WAIT") return null;
        return pair.startsWith(event.currency)
          ? (item.direction === "BUY" ? 1 : -1)
          : (item.direction === "SELL" ? 1 : -1);
      }).filter(v => v !== null);
      const strengthScore = currencyVotes.reduce((sum, v) => sum + v, 0);
      const strengthPct = currencyVotes.length
        ? Math.round(Math.abs(strengthScore) / currencyVotes.length * 100) : 0;
      const currencyBias = event.currency === "GLOBAL" ? "MIXED / REVIEW MARKETS" :
        currencyVotes.length < 2 || Math.abs(strengthScore) < 2 ? "WAIT / MIXED" :
        strengthScore > 0 ? event.currency + " STRENGTH" : event.currency + " WEAKNESS";

      const movementLines = preNewsPairs.map(pair => {
        const item = byPair[pair];
        return item && !item.error
          ? pair + " " + item.direction + " (" + item.pct.toFixed(3) + "%)"
          : pair + " unavailable";
      });
      const gold = byPair.XAUUSD, dxy = byPair.DXY;
      const goldBias = gold && !gold.error ? gold.direction : "WAIT";
      const dxyBias = dxy && !dxy.error ? dxy.direction : "WAIT";
      const body = "15m-before-news analysis: " + event.currency + " " + event.name +
        ". " + event.currency + " currency bias: " + currencyBias +
        " · " + strengthPct + "% pair agreement. XAUUSD: " + goldBias +
        ". DXY: " + dxyBias +
        ". Uses two completed 15m candles from the 30-minute window ending 15m before release. " +
        movementLines.join(" · ") +
        ". Cross-market correlations can change; WAIT means evidence is mixed or insufficient. NOT A GUARANTEED TRADE; confirm spreads, chart and risk.";
      await broadcast("⚠️ PRE-NEWS BIAS — " + event.currency + " / GOLD",
        body, "pre-news-" + eventId);
      await redis.set(signalKey, "1", { ex: 60 * 60 * 24 * 2 });
      preNewsSignals++;
    }
  } catch (error) {
    console.error("DAGBO pre-news calendar check failed:", error.message);
  }
  return { eventsChecked, newsAlerts, preNewsSignals };
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



// --- SMART PAIR HEDGE + HIGHER-TIMEFRAME ENGINE ---
// Uses cached Twelve Data candles so the 5-minute cron does not repeatedly
// consume requests for monthly/weekly/daily/4H data.
const HTF_FRAMES = [
  { key: "1month", label: "Monthly", ttl: 28 * 24 * 60 * 60 },
  { key: "1week", label: "Weekly", ttl: 6 * 24 * 60 * 60 },
  { key: "1day", label: "Daily", ttl: 22 * 60 * 60 },
  { key: "4h", label: "4H", ttl: 3 * 60 * 60 + 45 * 60 }
];

function pairDecimals(pair) {
  return pair.includes("JPY") ? 3 : (pair === "XAUUSD" || pair === "GOLD" ? 2 : 5);
}
function htfDirection(candles) {
  if (!Array.isArray(candles) || candles.length < 55) return "WAIT";
  const closes = candles.map(c => num(c.close));
  if (closes.some(v => v === null)) return "WAIT";
  const fast = ema(closes, 20), slow = ema(closes, 50), last = closes[closes.length - 1];
  return fast > slow && last > fast ? "BUY" :
    fast < slow && last < fast ? "SELL" : "WAIT";
}
async function getHtfCandles(pair, frame, apiKey) {
  const cacheKey = "dagbo:htf:candles:" + pair + ":" + frame.key;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (Array.isArray(parsed) && parsed.length >= 55) return parsed;
    } catch (e) {}
  }
  const symbol = SYMBOLS[pair];
  if (!symbol) throw new Error("Unsupported pair " + pair);
  const url = "https://api.twelvedata.com/time_series?symbol=" +
    encodeURIComponent(symbol) + "&interval=" + encodeURIComponent(frame.key) +
    "&outputsize=80&timezone=UTC&apikey=" + encodeURIComponent(apiKey);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "No " + frame.label + " candles");
  }
  const candles = data.values.slice().reverse().map(c => ({
    datetime: String(c.datetime || ""),
    open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close)
  })).filter(c => c.datetime && [c.open,c.high,c.low,c.close].every(v => v !== null));
  if (candles.length < 55) throw new Error("Insufficient " + frame.label + " history");
  await redis.set(cacheKey, JSON.stringify(candles), { ex: frame.ttl });
  return candles;
}
function pearsonCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 25) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s,v)=>s+v,0)/n, my = y.reduce((s,v)=>s+v,0)/n;
  let cov=0,vx=0,vy=0;
  for(let i=0;i<n;i++){const dx=x[i]-mx,dy=y[i]-my;cov+=dx*dy;vx+=dx*dx;vy+=dy*dy;}
  return vx>0&&vy>0?cov/Math.sqrt(vx*vy):null;
}
function alignedReturns(a, b) {
  function mapReturns(rows) {
    const out = new Map();
    for(let i=1;i<rows.length;i++){
      const prev=num(rows[i-1].close),cur=num(rows[i].close);
      if(prev&&cur&&rows[i].datetime) out.set(rows[i].datetime,(cur-prev)/prev);
    }
    return out;
  }
  const x=mapReturns(a),y=mapReturns(b),keys=Array.from(x.keys()).filter(k=>y.has(k)).sort();
  return { a:keys.map(k=>x.get(k)), b:keys.map(k=>y.get(k)), bars:keys.length };
}
function tradePlan(pair, direction, candles) {
  if (!Array.isArray(candles) || candles.length < 15) return null;
  const last=candles[candles.length-1], entry=num(last.close);
  if(entry===null) return null;
  let atr=0,count=0;
  for(let i=Math.max(1,candles.length-14);i<candles.length;i++){
    const c=candles[i],p=candles[i-1],hi=num(c.high),lo=num(c.low),pc=num(p.close);
    if([hi,lo,pc].some(v=>v===null)) continue;
    atr+=Math.max(hi-lo,Math.abs(hi-pc),Math.abs(lo-pc));count++;
  }
  if(!count) return null;
  atr/=count;
  const risk=atr*1.5, reward=risk*2, buy=direction==="BUY", d=pairDecimals(pair);
  return {
    pair,direction,entry:Number(entry.toFixed(d)),
    stopLoss:Number((buy?entry-risk:entry+risk).toFixed(d)),
    takeProfit:Number((buy?entry+reward:entry-reward).toFixed(d)),
    timeframe:"4H", candleTime:last.datetime
  };
}
function currencyExposure(plan) {
  const base=plan.pair.slice(0,3), quote=plan.pair.slice(3,6), sign=plan.direction==="BUY"?1:-1;
  return { [base]:sign, [quote]:-sign };
}
function summarizeExposure(first, second) {
  const out={};
  [first,second].forEach(p=>Object.entries(currencyExposure(p)).forEach(([c,v])=>out[c]=(out[c]||0)+v));
  Object.keys(out).forEach(c=>{if(!out[c]) delete out[c];});
  return out;
}
async function runPairIntelligence(pairs, apiKey) {
  const forexPairs=pairs.filter(p=>/^[A-Z]{6}$/.test(p) && SYMBOLS[p]);
  const data={}, errors=[];
  // Fetch only missing/expired timeframe caches; monthly/weekly/daily data is cached.
  await Promise.all(forexPairs.map(async pair=>{
    data[pair]={};
    await Promise.all(HTF_FRAMES.map(async frame=>{
      try { data[pair][frame.key]=await getHtfCandles(pair,frame,apiKey); }
      catch(err){data[pair][frame.key]=null;errors.push({pair,timeframe:frame.label,error:err.message});}
    }));
  }));

  const htfSignals=[];
  for(const pair of forexPairs){
    const directions={};
    HTF_FRAMES.forEach(frame=>{directions[frame.label]=data[pair][frame.key]?htfDirection(data[pair][frame.key]):"WAIT";});
    const valid=Object.values(directions).filter(d=>d==="BUY"||d==="SELL");
    const buys=valid.filter(d=>d==="BUY").length,sells=valid.filter(d=>d==="SELL").length;
    const direction=buys>=3&&buys>sells&&directions["4H"]==="BUY"?"BUY":
      sells>=3&&sells>buys&&directions["4H"]==="SELL"?"SELL":"WAIT";
    if(direction!=="WAIT"){
      const plan=tradePlan(pair,direction,data[pair]["4h"]);
      if(plan) htfSignals.push({...plan,timeframes:directions,agreement:Math.max(buys,sells)+"/4"});
    }
  }

  const combos=[];
  for(let i=0;i<forexPairs.length;i++) for(let j=i+1;j<forexPairs.length;j++){
    const p1=forexPairs[i],p2=forexPairs[j],a=data[p1]["4h"],b=data[p2]["4h"];
    if(!a||!b) continue;
    const aligned=alignedReturns(a,b),corr=pearsonCorrelation(aligned.a,aligned.b);
    if(corr===null||aligned.bars<25||Math.abs(corr)<0.65) continue;
    const first=htfSignals.find(x=>x.pair===p1),second=htfSignals.find(x=>x.pair===p2);
    if(!first||!second) continue;
    const expectedSame=corr>=0;
    if((expectedSame&&first.direction!==second.direction)||(!expectedSame&&first.direction===second.direction)) continue;
    const exposure=summarizeExposure(first,second);
    combos.push({
      id:p1+"-"+p2,correlation:Number(corr.toFixed(2)),
      relationship:expectedSame?"POSITIVE":"NEGATIVE",
      agreement:Math.min(Number(first.agreement.split("/")[0]),Number(second.agreement.split("/")[0]))+"/4",
      legs:[first,second],currencyExposure:exposure,
      sharedUsdExposure:exposure.USD||0,
      riskNote:Math.abs(exposure.USD)>=2?"Both legs add to the same USD exposure; this is a correlated two-trade basket, not a risk-reducing hedge.":"Review combined currency exposure and position sizes; correlation does not guarantee offsetting risk."
    });
  }
  combos.sort((x,y)=>Math.abs(y.correlation)-Math.abs(x.correlation));
  const snapshot={updatedAt:new Date().toISOString(),source:"Twelve Data candles",timeframes:["Monthly","Weekly","Daily","4H"],htfSignals,combos:combos.slice(0,10),errors};
  await redis.set("dagbo:pair-intelligence:last",JSON.stringify(snapshot),{ex:60*60*24*3});

  // Notify only when a new direction/correlation combination is first detected.
  for(const signal of htfSignals){
    const key="dagbo:htf:alert:"+signal.pair;
    const signature=signal.direction+"|"+signal.candleTime;
    const old=await redis.get(key);
    if(old!==signature){
      await broadcast("🧭 HTF "+signal.direction+" — "+signal.pair,
        signal.pair+" "+signal.direction+" · Monthly "+signal.timeframes.Monthly+
        " · Weekly "+signal.timeframes.Weekly+" · Daily "+signal.timeframes.Daily+
        " · 4H "+signal.timeframes["4H"]+" · Entry "+signal.entry+
        " · SL "+signal.stopLoss+" · TP "+signal.takeProfit+
        " · "+signal.agreement+" timeframe agreement. Source: Twelve Data candles; confirm before trading.",
        "htf-"+signal.pair);
      await redis.set(key,signature,{ex:60*60*24*14});
    }
  }
  for(const combo of snapshot.combos){
    const signature=combo.legs.map(x=>x.pair+":"+x.direction+":"+x.candleTime).join("|")+"|"+combo.correlation;
    const key="dagbo:hedge:alert:"+combo.id,old=await redis.get(key);
    if(old!==signature){
      const legs=combo.legs.map(x=>x.pair+" "+x.direction+" Entry "+x.entry+" SL "+x.stopLoss+" TP "+x.takeProfit).join(" / ");
      await broadcast("🔗 SMART PAIR HEDGE SETUP",
        legs+" · "+combo.relationship+" correlation "+combo.correlation+
        " · HTF agreement "+combo.agreement+" · Combined USD exposure "+combo.sharedUsdExposure+
        ". "+combo.riskNote+" Not a guaranteed hedge or trade.",
        "smart-hedge-"+combo.id);
      await redis.set(key,signature,{ex:60*60*24*14});
    }
  }
  return snapshot;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET" && req.query && req.query.view === "pair-intelligence") {
    const raw = await redis.get("dagbo:pair-intelligence:last");
    if (!raw) return res.status(200).json({ success: true, snapshot: null, message: "No pair-intelligence scan has completed yet." });
    let snapshot = raw;
    if (typeof raw === "string") { try { snapshot = JSON.parse(raw); } catch (e) { snapshot = null; } }
    return res.status(200).json({ success: true, snapshot });
  }
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
            " · " + analysis.buyScore + " BUY / " + analysis.sellScore + " SELL votes. Sources: " +
            analysis.evidence.slice(0, 3).join("; ") + ". Confirm on chart.";
          await broadcast(title, body, "signal-" + pair);
        }
      } else if (previous && previous.signal !== "NO TRADE") {
        await broadcast("ℹ️ SIGNAL NO LONGER ACTIVE", pair + " no longer meets the multi-method confirmation rule. Review any pending setup.", "signal-ended-" + pair);
      }
      await redis.set(stateKey, JSON.stringify({ signal: analysis.signal, candleTime: analysis.candleTime, scannedAt: new Date().toISOString() }), { ex: 60 * 60 * 24 * 7 });
    }

    let pairIntelligence = null;
    try {
      pairIntelligence = await runPairIntelligence(pairsToScan, apiKey);
    } catch (pairError) {
      console.error("DAGBO pair-intelligence scan failed:", pairError.message);
    }

    const tradeSummary = await monitorTrades(results);
    const newsSummary = { delegatedTo: "/api/news-monitor", note: "Economic-news and spike alerts run in the dedicated 5-minute news monitor." };
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
      pairIntelligence: pairIntelligence ? { htfSignals: pairIntelligence.htfSignals.length, hedgeCombinations: pairIntelligence.combos.length, updatedAt: pairIntelligence.updatedAt } : null,
      newsMonitoring: newsSummary,
      note: "News alerts and spike analysis run separately for GBPUSD, GBPJPY, EURUSD and XAUUSD; pre-news bias is not a prediction or broker order."
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
