'use strict';

const SYMBOLS = {
  XAUUSD:'XAU/USD', EURUSD:'EUR/USD', GBPUSD:'GBP/USD', USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY', AUDUSD:'AUD/USD', USDCHF:'USD/CHF', USDCAD:'USD/CAD',
  NZDUSD:'NZD/USD', EURJPY:'EUR/JPY', EURGBP:'EUR/GBP', BTCUSD:'BTC/USD',
  ETHUSD:'ETH/USD'
};
const INDEX_PAIRS = new Set(['US30','US100','NAS100','US500']);
const INTERVALS = {'5':'5min','15':'15min','60':'1h','240':'4h','D':'1day'};

module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Method not allowed'});

  const pair=String(req.query.pair||'XAUUSD').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const interval=String(req.query.interval||'15');
  if(INDEX_PAIRS.has(pair)) {
    return res.status(503).json({
      error:'DIRECT INDEX DATA UNAVAILABLE · No exact index CFD feed is connected. ETF proxy prices are not valid substitutes.',
      pair, marketDataType:'UNAVAILABLE'
    });
  }
  if(!SYMBOLS[pair]||!INTERVALS[interval]) {
    return res.status(400).json({error:'Unsupported market or timeframe'});
  }

  const key=process.env.TWELVE_DATA_API_KEY || process.env.NEWS_SPIKE_TWELVE_DATA_API_KEY;
  if(!key) return res.status(503).json({error:'Live chart data is not configured. Add TWELVE_DATA_API_KEY in Vercel environment variables.'});

  const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(SYMBOLS[pair])+
    '&interval='+encodeURIComponent(INTERVALS[interval])+'&timezone=UTC&outputsize=250&apikey='+encodeURIComponent(key);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8500);
  try {
    const upstream=await fetch(url,{headers:{'Accept':'application/json'},signal:controller.signal});
    const data=await upstream.json();
    if(!upstream.ok||data.status==='error'||!Array.isArray(data.values)) {
      return res.status(502).json({error:data.message||'Live candles are unavailable for this market',provider:'Twelve Data'});
    }
    const candles=data.values.map(c=>({
      time:Math.floor(Date.parse(String(c.datetime||'').replace(' ','T')+'Z')/1000),
      open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume||0)
    })).filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(Number.isFinite)&&
      c.open>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.low>0)
      .sort((a,b)=>a.time-b.time);
    if(candles.length<30) return res.status(502).json({error:'Provider returned fewer than 30 valid chart candles.',provider:'Twelve Data'});
    return res.status(200).json({
      pair,interval,candles,source:'Twelve Data',sourceSymbol:SYMBOLS[pair],
      marketDataType:'DIRECT',timezone:'UTC',updatedAt:new Date().toISOString()
    });
  } catch(error) {
    const timedOut=error&&error.name==='AbortError';
    return res.status(timedOut?504:502).json({
      error:timedOut?'Chart data request timed out. Retry shortly.':'Could not retrieve live chart candles.',
      provider:'Twelve Data'
    });
  } finally {
    clearTimeout(timer);
  }
};
