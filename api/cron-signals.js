const webpush = require("web-push");
const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// --- THE MATH ENGINES ---
function calculateRSI(closes, period) {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    let diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  let rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1];
  let k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function getSystem1(candles) {
  let closes = candles.map(c => parseFloat(c.close));
  let lastClose = closes[closes.length-1];
  let rsi = calculateRSI(closes, 14);
  let ema20 = calculateEMA(closes, 20);
  let ema50 = calculateEMA(closes, 50);
  let score = 0;
  if (rsi < 35) score++; 
  if (rsi > 65) score--;
  if (lastClose > ema20 && ema20 > ema50) score++;
  if (lastClose < ema20 && ema20 < ema50) score--;
  return score >= 1 ? 'BUY' : (score <= -1 ? 'SELL' : 'WAIT');
}

function getSystem2(candles) {
  let last = candles[candles.length-1];
  let prev = candles[candles.length-2];
  let o = parseFloat(last.open), c = parseFloat(last.close), h = parseFloat(last.high), l = parseFloat(last.low);
  let po = parseFloat(prev.open), pc = parseFloat(prev.close);
  let score = 0;
  let body = Math.abs(c - o);
  let lowerWick = Math.min(o, c) - l;
  let upperWick = h - Math.max(o, c);
  if (lowerWick > body * 2) score++;
  if (upperWick > body * 2) score--;
  if (c > o && pc < po && c > po && o < pc) score++;
  if (c < o && pc > po && c < po && o > pc) score--;
  return score >= 1 ? 'BUY' : (score <= -1 ? 'SELL' : 'WAIT');
}

function getSystem3(candles) {
  let last = candles[candles.length-1];
  let lastClose = parseFloat(last.close);
  let highs = candles.slice(-20).map(c => parseFloat(c.high));
  let lows = candles.slice(-20).map(c => parseFloat(c.low));
  let recentHigh = Math.max(...highs);
  let recentLow = Math.min(...lows);
  if (lastClose < recentLow + (recentHigh - recentLow) * 0.2) return 'BUY';
  if (lastClose > recentHigh - (recentHigh - recentLow) * 0.2) return 'SELL';
  return 'WAIT';
}

function getFinalSignal(s1, s2, s3) {
  let dirs = [s1, s2, s3];
  if (dirs.includes('WAIT')) return 'NO TRADE';
  let buys = dirs.filter(d => d === 'BUY').length;
  if (buys === 3) return 'STRONG BUY';
  if (buys === 2) return 'WEAK BUY';
  if (buys === 1) return 'WEAK SELL';
  return 'STRONG SELL';
}

// --- MAIN ROBOT FUNCTION ---
module.exports = async function handler(req, res) {
  // 1. Check secret so only you can run this
  const supplied = req.headers.authorization || "";
  const expected = `Bearer ${process.env.SIGNAL_PUSH_SECRET || ""}`;
  if (!process.env.SIGNAL_PUSH_SECRET || supplied !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: "No Twelve Data Key in Vercel" });

  // Pairs to check (You can add more, but be careful of Twelve Data 800/day limit)
  // 4 pairs x 96 times a day = 384 requests. Safe!
  const pairsToCheck = ['XAU/USD', 'EUR/USD', 'GBP/USD', 'BTC/USD'];
  let signalsFound = [];

  for (let pair of pairsToCheck) {
    try {
      let url = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=15min&outputsize=60&apikey=${API_KEY}`;
      let response = await fetch(url);
      let data = await response.json();

      if (data.values && data.values.length > 20) {
        let candles = data.values.reverse();
        let s1 = getSystem1(candles);
        let s2 = getSystem2(candles);
        let s3 = getSystem3(candles);
        let final = getFinalSignal(s1, s2, s3);

        // Only notify for STRONG signals
        if (final === 'STRONG BUY' || final === 'STRONG SELL') {
          signalsFound.push({ pair, final });
        }
      }
    } catch (e) { console.error("Fetch error:", e); }
  }

  // Send the push notifications
  if (signalsFound.length > 0) {
    const payloadBase = {
      title: `DAGBO SIGNAL ALERT`,
      body: signalsFound.map(s => `${s.pair}: ${s.final}`).join(" | "),
      url: "/signals.html",
      tag: "dagbo-alert"
    };

    // Get all subscribed phones from Redis
    const ids = await redis.smembers("dagbo:push:subscriptions");
    for (const id of ids) {
      const stored = await redis.get(`dagbo:push:sub:${id}`);
      if (stored) {
        const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
        try {
          await webpush.sendNotification(sub, JSON.stringify(payloadBase));
        } catch (err) {
          if ([404, 410].includes(err.statusCode)) {
            await redis.del(`dagbo:push:sub:${id}`);
            await redis.srem("dagbo:push:subscriptions", id);
          }
        }
      }
    }
  }

  return res.status(200).json({ success: true, checked: pairsToCheck.length, signals: signalsFound });
};
