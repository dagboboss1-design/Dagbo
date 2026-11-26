'use strict';
const { Redis } = require("@upstash/redis");
const { claimTwelveDataSlot } = require("../lib/twelve-data-quota");

const SYMBOLS = {
  XAUUSD:'XAU/USD',EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY',AUDUSD:'AUD/USD',USDCHF:'USD/CHF',USDCAD:'USD/CAD',
  NZDUSD:'NZD/USD',EURJPY:'EUR/JPY',EURGBP:'EUR/GBP',BTCUSD:'BTC/USD',
  ETHUSD:'ETH/USD'
};
const INTERVALS = {'5':'5min','15':'15min','30':'30min','60':'1h','240':'4h','D':'1day','W':'1week'};
const memoryCache = new Map();
const CACHE_SECONDS = 55;

function redisClient() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null;
  return new Redis({url:process.env.UPSTASH_REDIS_REST_URL,token:process.env.UPSTASH_REDIS_REST_TOKEN});
}
module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const pair=String(req.query.pair||'XAUUSD').toUpperCase();
  const interval=String(req.query.interval||'15');
  if(['US30','US100','NAS100','US500'].includes(pair))return res.status(503).json({error:'DIRECT INDEX DATA UNAVAILABLE · This index has no connected direct price feed. ETF proxy prices are not valid substitutes.',pair,marketDataType:'UNAVAILABLE'});
  if(!SYMBOLS[pair]||!INTERVALS[interval])return res.status(400).json({error:'Unsupported market or timeframe'});
  const cacheKey='dagbo:chart:'+pair+':'+interval;
  const memory=memoryCache.get(cacheKey);
  if(memory&&memory.expiresAt>Date.now())return res.status(200).json(memory.data);
  let redis;
  try{
    redis=redisClient();
    if(!redis)return res.status(503).json({error:'Shared market-data quota store is unavailable. Chart data is paused to protect your Twelve Data limit.'});
    const cached=await redis.get(cacheKey);
    if(cached){
      const data=typeof cached==='string'?JSON.parse(cached):cached;
      memoryCache.set(cacheKey,{data,expiresAt:Date.now()+CACHE_SECONDS*1000});
      return res.status(200).json(data);
    }
    const allowed=await claimTwelveDataSlot(redis);
    if(!allowed)return res.status(429).json({error:'Shared Twelve Data minute quota is busy. Wait a moment and retry.'});
    const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(SYMBOLS[pair])+
      '&interval='+encodeURIComponent(INTERVALS[interval])+'&timezone=UTC&outputsize=250&apikey='+encodeURIComponent(process.env.TWELVE_DATA_API_KEY||'');
    if(!process.env.TWELVE_DATA_API_KEY)return res.status(503).json({error:'Twelve Data chart key is not configured.'});
    const upstream=await fetch(url,{signal:AbortSignal.timeout(7000)});
    const data=await upstream.json();
    if(!upstream.ok||data.status==='error'||!Array.isArray(data.values))return res.status(502).json({error:data.message||'Live candles are unavailable for this market'});
    const candles=data.values.map(c=>({time:Math.floor(Date.parse(c.datetime.replace(' ','T')+'Z')/1000),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume||0)}))
      .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(Number.isFinite)).sort((a,b)=>a.time-b.time);
    if(!candles.length)return res.status(502).json({error:'The market provider returned no valid candles.'});
    const result={pair,interval,candles,source:'Twelve Data',marketDataType:'DIRECT',timezone:'UTC'};
    try{await redis.set(cacheKey,JSON.stringify(result),{ex:CACHE_SECONDS});}
    catch(cacheError){console.warn('DAGBO chart cache write failed:',cacheError.message);}
    memoryCache.set(cacheKey,{data:result,expiresAt:Date.now()+CACHE_SECONDS*1000});
    return res.status(200).json(result);
  }catch(error){
    console.error('DAGBO chart data error:',error.message);
    return res.status(502).json({error:'Could not retrieve live candles. Try again shortly.'});
  }
};
