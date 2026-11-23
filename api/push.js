const webpush = require("web-push");
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const SUBSCRIPTIONS = "dagbo:push:subscriptions";
const aiRateFallback = new Map();
const AI_RATE_LIMIT = 15;
const AI_RATE_WINDOW_SECONDS = 600;

async function checkAiRateLimit(req) {
  const forwarded = req.headers["x-real-ip"] ||
    (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0].trim() : "");
  const ip = String(forwarded || "unknown").slice(0, 100);
  const id = crypto.createHash("sha256").update(ip).digest("hex");
  const key = "dagbo:ai:rate:" + id;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const redis = getRedis();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, AI_RATE_WINDOW_SECONDS);
      return { allowed: count <= AI_RATE_LIMIT, remaining: Math.max(0, AI_RATE_LIMIT - count) };
    } catch (error) {
      console.error("DAGBO AI rate-limit Redis error:", error.message);
    }
  }

  // Fallback for deployments without Redis; serverless instances may have separate counters.
  const now = Date.now();
  const current = aiRateFallback.get(id);
  if (!current || now - current.startedAt >= AI_RATE_WINDOW_SECONDS * 1000) {
    aiRateFallback.set(id, { startedAt: now, count: 1 });
    return { allowed: true, remaining: AI_RATE_LIMIT - 1 };
  }
  current.count += 1;
  return { allowed: current.count <= AI_RATE_LIMIT, remaining: Math.max(0, AI_RATE_LIMIT - current.count) };
}

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Push storage is not configured");
  return new Redis({ url, token });
}

function configureVapid() {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function getId(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

function authorized(req) {
  const secret = process.env.SIGNAL_PUSH_SECURITY || process.env.Signal_push_security || process.env.SIGNAL_PUSH_SECRET || process.env.DAGBO_CRON_SECRET || process.env.CRON_SECRET;
  const supplied = req.headers.authorization || "";
  if (!secret) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from("Bearer " + secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validSubscription(sub) {
  return !!(sub && typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") && sub.keys &&
    typeof sub.keys.p256dh === "string" && typeof sub.keys.auth === "string");
}


function getConfiguredAIProviders() {
  return {
    openai: !!(process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY),
    claude: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Gemini_API_Key),
    groq: !!process.env.GROQ_API_KEY
  };
}

function chooseAIProvider(task) {
  const section = String(task || "assistant").toLowerCase();
  if (section === "signals") return "claude";
  if (section === "journal") return "openai";
  if (section === "assistant" || section === "boss1") return "groq";
  if (section === "news") return "gemini";
  if (section === "fast") return "groq";
  return "openai";
}

function getAIProviderOrder(primary, configured) {
  // Keep each page's preferred model first, then use Groq as a dependable
  // general-purpose fallback. Groq itself falls back to OpenAI.
  const order = primary === "groq" ? ["groq", "openai"] : [primary, "groq"];
  return order.filter(function(name, index, all) {
    return !!configured[name] && all.indexOf(name) === index;
  });
}

async function callAIProvider(provider, messages, maxTokens) {
  const outputLimit = Number.isInteger(maxTokens) ? Math.max(60, Math.min(500, maxTokens)) : 500;
  const systemMessage = messages.find(function(m) { return m.role === "system"; });
  const conversation = messages.filter(function(m) { return m.role !== "system"; });
  let url, headers = { "Content-Type": "application/json" }, body, model;

  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;
    if (!key) throw new Error("OpenAI is not configured");
    model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
    url = "https://api.openai.com/v1/chat/completions";
    headers.Authorization = "Bearer " + key;
    body = { model: model, messages: messages, temperature: 0.3, max_tokens: outputLimit };
  } else if (provider === "claude") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Claude is not configured");
    model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: model,
      max_tokens: outputLimit,
      system: systemMessage ? systemMessage.content : "",
      messages: conversation.map(function(m) {
        return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
      })
    };
  } else if (provider === "gemini") {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Gemini_API_Key;
    if (!key) throw new Error("Gemini is not configured");
    model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
    body = {
      systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
      contents: conversation.map(function(m) {
        return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
      }),
      generationConfig: { temperature: 0.3, maxOutputTokens: outputLimit }
    };
  } else {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("Groq is not configured");
    model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    url = "https://api.groq.com/openai/v1/chat/completions";
    headers.Authorization = "Bearer " + key;
    body = { model: model, messages: messages, temperature: 0.3, max_tokens: outputLimit };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3500)
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const status = response.status;
    const message = data && data.error && data.error.message;
    throw new Error(provider + " request failed (" + status + ")" + (message ? ": " + String(message).slice(0, 180) : ""));
  }

  let answer = "";
  if (provider === "claude") {
    answer = (data.content || []).filter(function(part) { return part && part.type === "text"; })
      .map(function(part) { return part.text || ""; }).join("\n");
  } else if (provider === "gemini") {
    answer = data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(part) { return part.text || ""; }).join("\n") : "";
  } else {
    answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "";
  }
  if (typeof answer !== "string" || !answer.trim()) throw new Error(provider + " returned an empty answer");
  return { answer: answer.trim(), provider: provider, model: model };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const action = req.query && req.query.action;

  try {
    if (req.method === "GET" && action === "health") {
      const aiProviders = getConfiguredAIProviders();
      const checks = {
        ai: Object.keys(aiProviders).some(function(name) { return aiProviders[name]; }),
        aiProviders: aiProviders,
        pushPublicKey: !!process.env.VAPID_PUBLIC_KEY,
        pushPrivateKey: !!process.env.VAPID_PRIVATE_KEY,
        pushSubject: !!process.env.VAPID_SUBJECT,
        pushStorage: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
        marketData: !!process.env.TWELVE_DATA_API_KEY,
        cronSecret: !!(process.env.CRON_SECRET || process.env.SIGNAL_PUSH_SECRET || process.env.DAGBO_CRON_SECRET || process.env.SIGNAL_PUSH_SECURITY || process.env.Signal_push_security)
      };
      return res.status(200).json({
        success: true,
        services: checks,
        ready: {
          ai: checks.ai,
          push: checks.pushPublicKey && checks.pushPrivateKey && checks.pushSubject && checks.pushStorage,
          scanner: checks.marketData && checks.pushPublicKey && checks.pushPrivateKey && checks.pushSubject && checks.pushStorage && checks.cronSecret
        },
        note: "This endpoint reports whether required environment variables exist. It does not test third-party API calls or scheduled job execution."
      });
    }
    if (req.method === "GET" && action === "public-key") {
      if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(503).json({ error: "Push notifications are not configured on the server" });
      }
      return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    }

    if (req.method === "POST" && action === "test") {
      const subscription = req.body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid subscription" });
      configureVapid();
      await webpush.sendNotification(subscription, JSON.stringify({
        title: "DAGBO SIGNAL — Test",
        body: "Your push notifications are working.",
        url: "/settings.html"
      }), { TTL: 60, urgency: "normal" });
      return res.status(200).json({ success: true, message: "Test notification sent to this device" });
    }

    if (req.method === "POST" && action === "subscribe") {
      const subscription = req.body;
      if (!validSubscription(subscription)) return res.status(400).json({ error: "Invalid subscription" });
      const redis = getRedis();
      const id = getId(subscription.endpoint);
      await redis.set("dagbo:push:sub:" + id, JSON.stringify(subscription));
      await redis.sadd(SUBSCRIPTIONS, id);
      return res.status(201).json({ success: true, message: "Notifications enabled" });
    }

    if (req.method === "POST" && action === "unsubscribe") {
      const endpoint = req.body && req.body.endpoint;
      if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
        return res.status(400).json({ error: "Invalid endpoint" });
      }
      const redis = getRedis();
      const id = getId(endpoint);
      await redis.del("dagbo:push:sub:" + id);
      await redis.srem(SUBSCRIPTIONS, id);
      return res.status(200).json({ success: true, message: "Notifications disabled" });
    }

    if (req.method === "POST" && action === "send") {
      if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
      const { pair, signal, entry, stopLoss, takeProfit, timeframe, signalId } = req.body || {};
      const normalizedPair = typeof pair === "string" ? pair.trim().toUpperCase() : "";
      const normalizedSignal = typeof signal === "string" ? signal.trim().toUpperCase() : "";
      const allowed = ["STRONG BUY", "WEAK BUY", "STRONG SELL", "WEAK SELL"];
      const priceEntry = Number(entry), priceSL = Number(stopLoss), priceTP = Number(takeProfit);
      const isBuy = normalizedSignal.includes("BUY");
      const validPrices = [priceEntry, priceSL, priceTP].every(n => Number.isFinite(n) && n > 0) &&
        (isBuy ? priceSL < priceEntry && priceTP > priceEntry : priceSL > priceEntry && priceTP < priceEntry);
      if (!/^[A-Z0-9]{3,12}$/.test(normalizedPair) ||
          !allowed.includes(normalizedSignal) || !validPrices) {
        return res.status(400).json({ error: "Invalid signal. A valid pair, direction and correctly ordered Entry/SL/TP are required." });
      }
      const safeTimeframe = ["5m", "15m", "30m", "1h", "4h", "1d"].includes(String(timeframe || "").toLowerCase())
        ? String(timeframe).toLowerCase() : "unspecified";
      const dedupeSource = String(signalId || [normalizedPair, normalizedSignal, safeTimeframe, priceEntry, priceSL, priceTP].join("|")).slice(0, 300);
      const dedupeHash = crypto.createHash("sha256").update(dedupeSource).digest("hex");
      configureVapid();
      const redis = getRedis();
      const claimed = await redis.set("dagbo:push:signal:" + dedupeHash, "sent", { nx: true, ex: 60 * 60 * 6 });
      if (claimed !== "OK") {
        return res.status(200).json({ success: true, duplicate: true, sent: 0, message: "This signal notification was already processed." });
      }
      const ids = await redis.smembers(SUBSCRIPTIONS);
      let sent = 0, failed = 0, removed = 0;

      for (const id of ids) {
        const key = "dagbo:push:sub:" + id;
        try {
          const stored = await redis.get(key);
          if (!stored) { await redis.srem(SUBSCRIPTIONS, id); continue; }
          const sub = typeof stored === "string" ? JSON.parse(stored) : stored;
          await webpush.sendNotification(sub, JSON.stringify({
            title: "DAGBO SIGNAL — " + normalizedPair,
            body: normalizedSignal + " signal detected for " + normalizedPair + " (" + safeTimeframe + "). Entry " + priceEntry + ", SL " + priceSL + ", TP " + priceTP + ".",
            pair: normalizedPair, signal: normalizedSignal, timeframe: safeTimeframe,
            entry: priceEntry, stopLoss: priceSL, takeProfit: priceTP,
            url: "/signals.html"
          }), { TTL: 60, urgency: "high", topic: "dagbo-" + normalizedPair });
          sent++;
        } catch (error) {
          failed++;
          if ([404, 410].includes(error.statusCode)) {
            await redis.del(key);
            await redis.srem(SUBSCRIPTIONS, id);
            removed++;
          } else {
            console.error("DAGBO push delivery error:", error.message);
          }
        }
      }
      return res.status(200).json({ success: true, total: ids.length, sent, failed, removed });
    }

    // 5. DAGBO AI — task routing with one automatic fallback provider.
    if (req.method === "POST" && action === "ask-ai") {
      const { question, name, subscription, marketContext, history, task } = req.body || {};
      if (typeof question !== "string" || !question.trim() || question.length > 2000) {
        return res.status(400).json({ error: "A valid question is required" });
      }

      const rate = await checkAiRateLimit(req);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(AI_RATE_WINDOW_SECONDS));
        return res.status(429).json({ error: "Dagbo AI is receiving too many requests. Please wait a few minutes and try again." });
      }

      const safeMarketContext = typeof marketContext === "string" ? marketContext.slice(0, 2500) : "";
      const safeName = typeof name === "string" ? name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().slice(0, 32) : "Oga";
      const safeHistory = Array.isArray(history) ? history.slice(-10).filter(function(item) {
        return item && (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" && item.content.trim().length > 0;
      }).map(function(item) {
        return { role: item.role, content: item.content.slice(0, 1200) };
      }) : [];
      const validTasks = ["assistant", "boss1", "signals", "journal", "news", "fast"];
      const selectedTask = validTasks.includes(String(task || "").toLowerCase()) ? String(task).toLowerCase() : "assistant";

      // For explicit live-price questions, only pass a verified Twelve Data quote.
      const pairSymbols = {
        XAUUSD:"XAU/USD", GOLD:"XAU/USD", EURUSD:"EUR/USD", GBPUSD:"GBP/USD",
        USDJPY:"USD/JPY", GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDCHF:"USD/CHF",
        USDCAD:"USD/CAD", NZDUSD:"NZD/USD", EURJPY:"EUR/JPY", EURGBP:"EUR/GBP",
        BTCUSD:"BTC/USD", ETHUSD:"ETH/USD", US30:"DJI", US100:"NDX", NAS100:"NDX", US500:"SPX"
      };
      const asksPrice = /\b(price|quote|trading at|how much is|current value)\b/i.test(question);
      const asksAnalysis = /\b(analy[sz]e|analysis|chart|signal|setup|buy|sell|long|short|trend|direction|entry|technical|market structure|support|resistance|bias)\b/i.test(question);
      const normalizedQuestion = question.toUpperCase().replace(/[^A-Z0-9]/g, "");
      let quotePair = Object.keys(pairSymbols).find(function(pair) {
        return new RegExp("\b" + pair + "\b", "i").test(question) ||
          normalizedQuestion.indexOf(pair.replace(/[^A-Z0-9]/g, "")) >= 0;
      });
      if (!quotePair && (asksPrice || asksAnalysis) && /\b(this pair|current pair|selected pair|my chart|the chart)\b/i.test(question) && safeMarketContext) {
        try {
          const snapshot = JSON.parse(safeMarketContext);
          const walk = function(value) {
            if (!value || typeof value !== "object") return null;
            for (const key of Object.keys(value)) {
              const normalized = key.toUpperCase().replace("/", "").replace("_", "");
              if (pairSymbols[normalized]) return normalized;
              const found = walk(value[key]);
              if (found) return found;
            }
            return null;
          };
          quotePair = walk(snapshot);
        } catch (_) {}
      }
      let liveQuoteContext = "";
      let liveCandleContext = "";
      if (asksAnalysis && quotePair && process.env.TWELVE_DATA_API_KEY) {
        const candleSymbols = {
          XAUUSD:"XAU/USD", GOLD:"XAU/USD", EURUSD:"EUR/USD", GBPUSD:"GBP/USD",
          USDJPY:"USD/JPY", GBPJPY:"GBP/JPY", AUDUSD:"AUD/USD", USDCHF:"USD/CHF",
          USDCAD:"USD/CAD", NZDUSD:"NZD/USD", EURJPY:"EUR/JPY", EURGBP:"EUR/GBP",
          BTCUSD:"BTC/USD", ETHUSD:"ETH/USD"
        };
        const candleSymbol = candleSymbols[quotePair];
        if (candleSymbol) {
          const tf = /\b(5m|5 min|5-minute|5 minute)\b/i.test(question) ? "5min" :
            /\b(30m|30 min|30-minute|30 minute)\b/i.test(question) ? "30min" :
            /\b(1h|1 hour|hourly)\b/i.test(question) ? "1h" :
            /\b(4h|4 hour|4-hour)\b/i.test(question) ? "4h" : "15min";
          try {
            const candleUrl = "https://api.twelvedata.com/time_series?symbol=" +
              encodeURIComponent(candleSymbol) + "&interval=" + encodeURIComponent(tf) +
              "&timezone=UTC&outputsize=24&apikey=" + encodeURIComponent(process.env.TWELVE_DATA_API_KEY);
            const candleResponse = await fetch(candleUrl, { signal: AbortSignal.timeout(2200) });
            const candleData = await candleResponse.json();
            if (candleResponse.ok && Array.isArray(candleData.values) && candleData.values.length >= 5) {
              const bars = candleData.values.slice(0, 20).reverse().map(function(bar) {
                return {
                  time: bar.datetime,
                  open: Number(bar.open), high: Number(bar.high),
                  low: Number(bar.low), close: Number(bar.close),
                  volume: Number(bar.volume || 0)
                };
              }).filter(function(bar) {
                return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite);
              });
              if (bars.length >= 5) {
                liveCandleContext = "FRESH TWELVE DATA OHLC CANDLES for " + quotePair +
                  " on " + tf + " timeframe, UTC, newest candle timestamp " +
                  bars[bars.length - 1].time + ". Candles oldest-to-newest: " +
                  JSON.stringify(bars) +
                  ". Use these candles for structure and setup analysis; do not claim indicators that were not calculated.";
              }
            } else {
              liveCandleContext = "Fresh candles are unavailable for " + quotePair +
                ". Do not issue a directional trade call or invent entry/SL/TP.";
            }
          } catch (candleError) {
            liveCandleContext = "Live candle request failed for " + quotePair +
              ". Do not issue a directional trade call or invent entry/SL/TP.";
            console.warn("DAGBO AI candle context unavailable:", candleError.message);
          }
        } else {
          liveCandleContext = "No supported live candle mapping is available for " + quotePair +
            ". Ask the user to select a supported FX, GOLD or crypto pair; do not invent chart analysis.";
        }
      } else if (asksAnalysis && !quotePair) {
        liveCandleContext = "No instrument was identified. Ask the user which pair or market and timeframe to analyse.";
      }
      if (asksPrice && !asksAnalysis) {
        const quoteKey = process.env.TWELVE_DATA_API_KEY;
        if (quotePair && quoteKey) {
          try {
            const quoteUrl = "https://api.twelvedata.com/quote?symbol=" +
              encodeURIComponent(pairSymbols[quotePair]) + "&apikey=" + encodeURIComponent(quoteKey);
            const quoteResponse = await fetch(quoteUrl, { signal: AbortSignal.timeout(1800) });
            const quote = await quoteResponse.json();
            const price = Number(quote.close || quote.price);
            if (quoteResponse.ok && Number.isFinite(price) && price > 0) {
              liveQuoteContext = "Verified Twelve Data quote for " + quotePair +
                ": latest price " + price + ", timestamp " + (quote.datetime || quote.timestamp || "not supplied") + ".";
            } else {
              liveQuoteContext = "Live quote unavailable for " + quotePair + ". Do not guess the price.";
            }
          } catch (_) {
            liveQuoteContext = "Live quote service unavailable. Do not guess the price.";
          }
        } else {
          liveQuoteContext = quotePair
            ? "Live quote API key is not configured. Do not guess the price."
            : "No pair could be identified from the question or saved chart context. Ask which pair the user means.";
        }
      }

      const taskInstructions = {
        signals: "You are DAGBO's Signals analyst. Interpret only supplied, timestamped market data and technical evidence; explain confluence, invalidation and uncertainty. Never invent an entry, stop or target.",
        journal: "You are DAGBO's trading journal coach. Analyse only supplied journal records, calculate only from supplied figures, identify execution patterns and risk discipline. Never invent trades or results.",
        news: "You are DAGBO's news analyst. Separate verified facts, actual values, forecasts and unknowns; explain affected assets and possible scenarios without presenting forecasts as facts.",
        boss1: "You are DAGBO's BOSS1 trading coach. Teach clearly, check reasoning and emphasise risk management.",
        fast: "You are DAGBO's fast assistant. Be concise and use only supplied facts."
      };
      const isSimpleQuestion = question.trim().split(/\s+/).length <= 12 &&
        !/\b(analy[sz]e|analysis|chart|signal|setup|buy|sell|long|short|trend|direction|entry|technical|market structure|support|resistance|bias|compare|difference|explain|teach|steps|how to|how do i|why|calculate|review|journal|news|strategy|plan)\b/i.test(question);
      const answerTokenLimit = isSimpleQuestion ? 100 : 500;
      const systemPrompt = (taskInstructions[selectedTask] || "You are DAGBO's AI Market Commander.") + " You are assisting " + (safeName || "Oga") +
        ". Answer exactly what the user asks and perform the requested task; do not add unrelated advice. Be concise, clear and Nigerian-friendly; use Pidgin naturally when useful. For simple factual questions, answer in ONE short sentence, ideally under 20 words. Do not add greetings, headings, bullet points, repeated explanations or unsolicited follow-up. For detailed requests, give only the details needed. For live-price questions, use only a verified live quote supplied in the context; if unavailable, say so and never guess. Never invent prices, news, indicators or market conditions. Treat device snapshots as potentially stale. When asked for a trade signal or setup, provide pair, BUY/SELL/WAIT, timeframe, entry, stop loss and take profit only when supported by fresh market data and a valid setup. If fresh data or a valid setup is missing, return WAIT and say entry/SL/TP are unavailable. Never guarantee profits. Ordinary answers should usually be 1-4 short sentences.";
      const userContent = question.trim() +
        (liveQuoteContext ? "\n\nLIVE QUOTE CONTEXT: " + liveQuoteContext : "") +
        (liveCandleContext ? "\n\nLIVE CHART CONTEXT: " + liveCandleContext : "") +
        (safeMarketContext ? "\n\nLatest saved DAGBO signal context (device snapshot; may be stale): " + safeMarketContext : "");
      const messages = [{ role: "system", content: systemPrompt }]
        .concat(safeHistory)
        .concat([{ role: "user", content: userContent }]);

      const configured = getConfiguredAIProviders();
      const primary = chooseAIProvider(selectedTask);
      const providerOrder = getAIProviderOrder(primary, configured);
      if (!providerOrder.length) {
        return res.status(503).json({
          error: "AI service is not configured. Please contact support."
        });
      }

      let result = null;
      let lastError = null;
      const attempts = [];
      for (const providerName of providerOrder) {
        const startedAt = Date.now();
        try {
          result = await callAIProvider(providerName, messages, answerTokenLimit);
          attempts.push({ provider: providerName, ok: true, latencyMs: Date.now() - startedAt });
          break;
        } catch (error) {
          lastError = error;
          attempts.push({ provider: providerName, ok: false, latencyMs: Date.now() - startedAt });
          console.warn("DAGBO AI provider unavailable:", providerName, error.message);
        }
      }
      if (!result) {
        return res.status(502).json({
          error: "AI service is temporarily unavailable. Please try again shortly.",
        });
      }

      if (isSimpleQuestion) {
        const firstSentence = result.answer.match(/^[\s\S]*?[.!?](?:\s|$)/);
        let concise = firstSentence ? firstSentence[0].trim() : result.answer.trim();
        const words = concise.split(/\s+/);
        if (words.length > 32) concise = words.slice(0, 32).join(" ").replace(/[,:;\-]+$/, "") + "…";
        result.answer = concise;
      }

      // Notify only the device that asked the question. Notification failure never blocks the answer.
      if (validSubscription(subscription)) {
        try {
          configureVapid();
          await webpush.sendNotification(subscription, JSON.stringify({
            title: "🤖 Dagbo AI Answer",
            body: result.answer.replace(/\s+/g, " ").slice(0, 190) + (result.answer.length > 190 ? "…" : ""),
            url: "/ai.html",
            tag: "dagbo-ai-" + Date.now()
          }), { TTL: 60, urgency: "normal" });
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) {
            try {
              const redis = getRedis();
              const id = getId(subscription.endpoint);
              await redis.del("dagbo:push:sub:" + id);
              await redis.srem(SUBSCRIPTIONS, id);
            } catch (cleanupError) {
              console.error("DAGBO AI subscription cleanup error:", cleanupError.message);
            }
          } else {
            console.error("DAGBO AI push delivery error:", error.message);
          }
        }
      }

      return res.status(200).json({
        success: true,
        answer: result.answer,
        task: selectedTask
      });
    }

    if (req.method === "POST" && action === "scan-summary") {
      const { subscription, summary, timeframe, scannedAt } = req.body || {};
      if (!validSubscription(subscription)) return res.status(400).json({ error: "A valid device push subscription is required" });
      const safeSummary = typeof summary === "string" ? summary.replace(/[<>]/g, "").slice(0, 220) : "";
      const safeTimeframe = typeof timeframe === "string" ? timeframe.slice(0, 12) : "current";
      if (!safeSummary) return res.status(400).json({ error: "Scan summary is required" });
      configureVapid();
      await webpush.sendNotification(subscription, JSON.stringify({
        title: "DAGBO SIGNAL — Scan complete",
        body: safeSummary + " · " + safeTimeframe + (scannedAt ? " · " + String(scannedAt).slice(0, 30) : ""),
        url: "/signals.html",
        tag: "dagbo-scan-summary"
      }), { TTL: 120, urgency: "normal", topic: "dagbo-scan" });
      return res.status(200).json({ success: true, message: "Scan summary notification sent to this device" });
    }

    return res.status(404).json({ error: "Unknown push action" });
  } catch (error) {
    console.error("DAGBO PUSH ERROR:", error.message);
    return res.status(500).json({ error: error.message || "Push service failed" });
  }
};
