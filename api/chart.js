'use strict';
const SYMBOLS = {
  XAUUSD:'XAU/USD',EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',
  GBPJPY:'GBP/JPY',AUDUSD:'AUD/USD',USDCHF:'USD/CHF',USDCAD:'USD/CAD',
  NZDUSD:'NZD/USD',EURJPY:'EUR/JPY',EURGBP:'EUR/GBP',BTCUSD:'BTC/USD',
  ETHUSD:'ETH/USD',US30:'DJI',US100:'NDX',US500:'SPX'
};
const INTERVALS = {'5':'5min','15':'15min','60':'1h','240':'4h','D':'1day'};
module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  const pair=String(req.query.pair||'XAUUSD').toUpperCase();
  const interval=String(req.query.interval||'15');
  if(!SYMBOLS[pair]||!INTERVALS[interval])return res.status(400).json({error:'Unsupported market or timeframe'});
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key)return res.status(503).json({error:'Live chart data is not configured. Add TWELVE_DATA_API_KEY in Cloudflare Worker secrets.'});
  const url='https://api.twelvedata.com/time_series?symbol='+encodeURIComponent(SYMBOLS[pair])+
    '&interval='+encodeURIComponent(INTERVALS[interval])+'&timezone=UTC&outputsize=250&apikey='+encodeURIComponent(key);
  try{
    const upstream=await fetch(url);const data=await upstream.json();
    if(!upstream.ok||data.status==='error'||!Array.isArray(data.values))
      return res.status(502).json({error:data.message||'Live candles are unavailable for this market'});
    const candles=data.values.map(c=>({time:Math.floor(Date.parse(c.datetime.replace(' ','T')+'Z')/1000),
      open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume||0)}))
      .filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(Number.isFinite))
      .sort((a,b)=>a.time-b.time);
    return res.status(200).json({pair,interval,candles,source:'Twelve Data',timezone:'UTC'});
  }catch(e){return res.status(502).json({error:'Could not retrieve live candles'});}
};
