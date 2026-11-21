const { Redis } = require("@upstash/redis");

const CACHE_KEY = "dagbo:fx:usd-ngn";
function apiKeys() {
  return Array.from(new Set([
    process.env.TWELVE_DATA_API_KEY,
    process.env.TWELVE_DATA_API_KEY_2,
    process.env.TWELVE_DATA_API_KEY_3,
    process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY,
    process.env.SPIKE_TWELVE_DATA_API_KEY
  ].map(value => String(value || "").trim()).filter(Boolean))).slice(0, 2);
}
function redisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}
module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="GET")return res.status(405).json({error:"GET required"});
  const redis=redisClient();
  let cached=null;
  try {
    if(redis) {
      const raw=await redis.get(CACHE_KEY);
      cached=raw?(typeof raw==="string"?JSON.parse(raw):raw):null;
      if(cached&&Date.now()-Number(cached.savedAt||0)<60*60*1000) {
        return res.status(200).json({...cached.payload,cache:"hit"});
      }
    }
  } catch(error) { console.error("DAGBO FX cache read failed:",error.message); }
  const keys=apiKeys();
  if(!keys.length) {
    if(cached&&Date.now()-Number(cached.savedAt||0)<24*60*60*1000) return res.status(200).json({...cached.payload,cache:"stale-fallback",stale:true});
    return res.status(503).json({error:"Live FX rate unavailable: no Twelve Data API key is configured"});
  }
  let lastError="No valid USD/NGN exchange rate was returned";
  for(const key of keys) {
    try {
      const url="https://api.twelvedata.com/exchange_rate?symbol=USD%2FNGN&dp=6&apikey="+encodeURIComponent(key);
      const response=await fetch(url,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(4500)});
      const data=await response.json(),rate=Number(data&&data.rate);
      if(response.ok&&data.status!=="error"&&Number.isFinite(rate)&&rate>0) {
        const timestamp=Number(data.timestamp)||Math.floor(Date.now()/1000);
        const payload={base:"USD",quote:"NGN",usdNgn:rate,timestamp,updatedAt:new Date(timestamp*1000).toISOString(),provider:"Twelve Data"};
        try { if(redis) await redis.set(CACHE_KEY,JSON.stringify({savedAt:Date.now(),payload}),{ex:24*60*60}); } catch(error) { console.error("DAGBO FX cache write failed:",error.message); }
        return res.status(200).json({...payload,cache:"miss"});
      }
      lastError=data&&data.message?String(data.message):"Twelve Data returned an invalid USD/NGN rate";
      if(response.status!==429&&!/credits|rate limit|api calls|invalid api|api key/i.test(lastError)) break;
    } catch(error) { lastError=error&&error.message?error.message:"Exchange-rate provider unavailable"; }
  }
  if(cached&&Date.now()-Number(cached.savedAt||0)<24*60*60*1000) return res.status(200).json({...cached.payload,cache:"stale-fallback",stale:true,providerWarning:lastError});
  console.error("DAGBO live USD/NGN lookup failed:",lastError);
  return res.status(502).json({error:"Live USD/NGN rate is temporarily unavailable"});
};