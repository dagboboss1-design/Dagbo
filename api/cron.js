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

// Math logic for the bias
function calculateBias(dxyChange, goldChange) {
  let score = Math.round(50 + (dxyChange * -10) + (goldChange * 5));
  if (score > 70) score = 70;
  if (score < 30) score = 30;
  if (score >= 58) return { action: 'BUY GOLD', color: '🟢', score };
  if (score <= 42) return { action: 'SELL GOLD', color: '🔴', score };
  return { action: 'WAIT', color: '🟡', score };
}

async function sendPush(title, body, tag) {
  const payload = JSON.stringify({ title, body, url: "/boss1.html", tag });
  const ids = await redis.smembers("dagbo:push:subscriptions");
  for (const id of ids) {
    const stored = await redis.get(`dagbo:push:sub:${id}`);
    if (stored) {
      const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
      try { await webpush.sendNotification(sub, payload); } 
      catch (err) {
        if ([404, 410].includes(err.statusCode)) {
          await redis.del(`dagbo:push:sub:${id}`);
          await redis.srem("dagbo:push:subscriptions", id);
        }
      }
    }
  }
}

module.exports = async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;
  const now = new Date();
  
  // 1. Get the next NFP (First Friday) and CPI (12th of month)
  // Note: This is a simplified calendar. For exact times, we use the webhook.
  let nextEvent = null;
  let minDiff = Infinity;

  // Check NFP and CPI for this month and next month
  for (let i = 0; i < 2; i++) {
    let m = now.getMonth() + i;
    let y = now.getFullYear();
    if (m > 11) { m = 0; y++; }

    // NFP (First Friday at 13:30 WAT)
    let d = new Date(y, m, 1);
    let offset = (5 - d.getDay() + 7) % 7;
    let nfpDate = new Date(y, m, 1 + offset, 13, 30, 0);
    if (nfpDate > now && (nfpDate - now) < minDiff) { minDiff = nfpDate - now; nextEvent = { name: 'NFP', date: nfpDate }; }

    // CPI (12th at 13:30 WAT)
    let cpiDate = new Date(y, m, 12, 13, 30, 0);
    if (cpiDate > now && (cpiDate - now) < minDiff) { minDiff = cpiDate - now; nextEvent = { name: 'CPI', date: cpiDate }; }
  }

  if (!nextEvent) return res.status(200).json({ message: "No upcoming news" });

  const minsToNews = minDiff / 60000;

  // --- TRIGGER 1: 60 MINUTES BEFORE ---
  if (minsToNews > 59 && minsToNews <= 61) {
    await sendPush("⏰ NEWS IN 1 HOUR", `${nextEvent.name} drops in 60 mins. Prepare!`, "dagbo-1hr");
    return res.status(200).json({ sent: "1hr alert" });
  }

  // --- TRIGGER 2: 15 MINUTES BEFORE (BIAS) ---
  if (minsToNews > 14 && minsToNews <= 16) {
    if (!API_KEY) return res.status(500).json({ error: "No API Key" });
    let resEur = await fetch(`https://api.twelvedata.com/quote?symbol=EUR/USD&apikey=${API_KEY}`).then(r=>r.json());
    let resGold = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${API_KEY}`).then(r=>r.json());
    
    if (resEur.close && resGold.close) {
      let dxyChg = ((parseFloat(resEur.close) - parseFloat(resEur.open)) / parseFloat(resEur.open)) * 100;
      let goldChg = ((parseFloat(resGold.close) - parseFloat(resGold.open)) / parseFloat(resGold.open)) * 100;
      let bias = calculateBias(dxyChg, goldChg);
      
      await sendPush("🎯 15-MIN BIAS", `${nextEvent.name} in 15 mins. Bias: ${bias.color} ${bias.action} (${bias.score}%)`, "dagbo-bias");
      return res.status(200).json({ sent: "bias alert" });
    }
  }

  // --- TRIGGER 3: POST-NEWS SPIKE ---
  if (minsToNews < -1 && minsToNews > -4) {
    if (!API_KEY) return res.status(500).json({ error: "No API Key" });
    let resGold = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=1&apikey=${API_KEY}`).then(r=>r.json());
    
    if (resGold.values && resGold.values.length > 0) {
      let candle = resGold.values[0];
      let open = parseFloat(candle.open);
      let close = parseFloat(candle.close);
      let changePct = ((close - open) / open) * 100;

      if (changePct >= 0.30) {
        await sendPush("🚀 SPIKE BUY", `GOLD jumped +${changePct.toFixed(2)}%! STRONG BUY.`, "dagbo-spike");
        return res.status(200).json({ sent: "buy spike" });
      } else if (changePct <= -0.30) {
        await sendPush("🔻 SPIKE SELL", `GOLD dropped ${changePct.toFixed(2)}%! STRONG SELL.`, "dagbo-spike");
        return res.status(200).json({ sent: "sell spike" });
      }
    }
  }

  return res.status(200).json({ message: "Waiting...", minsToNews: minsToNews.toFixed(1) });
};