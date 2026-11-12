"use strict";

// DAGBO multi-market spike analysis.
// Scores are rule-based research scores, NOT calibrated probabilities or trade guarantees.

const SYMBOLS = Object.freeze({
  EURUSD:"EUR/USD", GBPUSD:"GBP/USD", USDJPY:"USD/JPY", USDCHF:"USD/CHF",
  USDCAD:"USD/CAD", AUDUSD:"AUD/USD", NZDUSD:"NZD/USD",
  EURJPY:"EUR/JPY", EURGBP:"EUR/GBP", EURCHF:"EUR/CHF", EURAUD:"EUR/AUD",
  EURCAD:"EUR/CAD", EURNZD:"EUR/NZD", GBPJPY:"GBP/JPY", GBPCHF:"GBP/CHF",
  GBPAUD:"GBP/AUD", GBPCAD:"GBP/CAD", GBPNZD:"GBP/NZD",
  AUDJPY:"AUD/JPY", AUDCHF:"AUD/CHF", AUDCAD:"AUD/CAD", AUDNZD:"AUD/NZD",
  NZDJPY:"NZD/JPY", NZDCHF:"NZD/CHF", NZDCAD:"NZD/CAD",
  CADJPY:"CAD/JPY", CADCHF:"CAD/CHF", CHFJPY:"CHF/JPY",
  XAUUSD:"XAU/USD", XAGUSD:"XAG/USD",
  US30:"DJI", US100:"NDX", NAS100:"NDX", US500:"SPX",
  BTCUSD:"BTC/USD", ETHUSD:"ETH/USD"
});

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandles(input) {
  if (!Array.isArray(input)) return [];
  return input.map(c => ({
    datetime: String(c.datetime || c.date || ""),
    open: number(c.open), high: number(c.high),
    low: number(c.low), close: number(c.close),
    volume: number(c.volume)
  })).filter(c =>
    c.open !== null && c.high !== null && c.low !== null && c.close !== null &&
    c.high >= c.low && c.high >= Math.max(c.open,c.close) &&
    c.low <= Math.min(c.open,c.close)
  ).sort((a,b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

function average(values) {
  return values.length ? values.reduce((s,v)=>s+v,0)/values.length : 0;
}

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2/(period+1);
  let result = values[0];
  for (let i=1;i<values.length;i++) result = values[i]*k + result*(1-k);
  return result;
}

function trueRanges(candles) {
  return candles.map((c,i) => {
    const previous = candles[i-1];
    return previous
      ? Math.max(c.high-c.low,Math.abs(c.high-previous.close),Math.abs(c.low-previous.close))
      : c.high-c.low;
  });
}

function levelFor(score) {
  if (score >= 75) return "HIGH";
  if (score >= 60) return "ELEVATED";
  if (score >= 40) return "WATCH";
  return "LOW";
}

function analyze(candlesInput, pair, mode, event) {
  const candles = normalizeCandles(candlesInput);
  if (candles.length < 30) {
    return { ready:false, pair, mode, reason:"At least 30 valid completed candles are required." };
  }

  const closes = candles.map(c=>c.close);
  const ranges = candles.map(c=>c.high-c.low);
  const tr = trueRanges(candles);
  const last = candles[candles.length-1];
  const prior = candles.slice(-21,-1);
  const priorRanges = ranges.slice(-21,-1);
  const priorAtr = average(tr.slice(-21,-1));
  if (!(priorAtr > 0) || !(last.close > 0)) {
    return { ready:false, pair, mode, reason:"Market range is insufficient for a reliable calculation." };
  }

  const recentSix = ranges.slice(-7,-1);
  const compressionRatio = average(recentSix)/(average(priorRanges)||priorAtr);
  const expansionRatio = (tr[tr.length-1]||0)/priorAtr;
  const recentMove = last.close - candles[candles.length-4].close;
  const momentumAtr = recentMove/priorAtr;
  const swingHigh = Math.max(...prior.map(c=>c.high));
  const swingLow = Math.min(...prior.map(c=>c.low));
  const breakout = last.close > swingHigh ? "BUY" : last.close < swingLow ? "SELL" : "WAIT";

  const volumeValues = candles.slice(-21,-1).map(c=>c.volume).filter(v=>v!==null && v>0);
  const currentVolume = last.volume;
  const volumeRatio = volumeValues.length && currentVolume>0
    ? currentVolume/average(volumeValues) : null;

  // Spike setup score combines squeeze, current expansion, momentum, structure and volume.
  // It is intentionally called a score, not a probability, until calibrated on held-out data.
  let score = 0;
  const evidence = [];
  if (compressionRatio < 0.65) { score+=20; evidence.push("Recent ranges are compressed"); }
  else if (compressionRatio < 0.82) { score+=12; evidence.push("Recent ranges are below baseline"); }
  if (expansionRatio >= 1.8) { score+=25; evidence.push("Latest true range is sharply expanded"); }
  else if (expansionRatio >= 1.35) { score+=16; evidence.push("Latest true range is expanding"); }
  if (Math.abs(momentumAtr) >= 1.2) { score+=20; evidence.push("Short-term price acceleration is strong"); }
  else if (Math.abs(momentumAtr) >= 0.7) { score+=12; evidence.push("Short-term momentum is increasing"); }
  if (breakout !== "WAIT") { score+=20; evidence.push("Price closed beyond the previous 20-bar range"); }
  if (volumeRatio !== null && volumeRatio >= 2) { score+=15; evidence.push("Reported volume is at least twice its recent average"); }
  else if (volumeRatio !== null && volumeRatio >= 1.4) { score+=8; evidence.push("Reported volume is above its recent average"); }
  score = Math.min(100,score);

  // Direction is a separate agreement vote. No direction is forced when evidence conflicts.
  const votes = [];
  const fast = ema(closes.slice(-30),9);
  const slow = ema(closes.slice(-30),21);
  if (fast>slow) votes.push({name:"EMA trend",direction:"BUY"});
  else if (fast<slow) votes.push({name:"EMA trend",direction:"SELL"});
  if (recentMove>priorAtr*0.15) votes.push({name:"Price momentum",direction:"BUY"});
  else if (recentMove< -priorAtr*0.15) votes.push({name:"Price momentum",direction:"SELL"});
  if (breakout!=="WAIT") votes.push({name:"Range breakout",direction:breakout});
  if (last.close>last.open && (last.close-last.open)/Math.max(last.high-last.low,1e-12)>=0.55)
    votes.push({name:"Candle pressure",direction:"BUY"});
  else if (last.close<last.open && (last.open-last.close)/Math.max(last.high-last.low,1e-12)>=0.55)
    votes.push({name:"Candle pressure",direction:"SELL"});

  const buyVotes = votes.filter(v=>v.direction==="BUY").length;
  const sellVotes = votes.filter(v=>v.direction==="SELL").length;
  const totalVotes = votes.length;
  const direction = buyVotes>=3 && buyVotes>sellVotes ? "BUY" :
    sellVotes>=3 && sellVotes>buyVotes ? "SELL" : "WAIT";
  const directionAgreementPct = totalVotes
    ? Math.round(Math.max(buyVotes,sellVotes)/totalVotes*100) : 0;

  let spikeScore = score;
  if (mode==="PRE_NEWS") {
    // Upcoming high-impact news raises event-risk context only; it does not choose direction.
    spikeScore = Math.min(100,spikeScore+15);
    evidence.unshift("High-impact event is approaching; volatility risk is elevated");
  }

  return {
    ready:true, pair, mode, direction,
    directionAgreementPct,
    spikeScore, spikeLevel:levelFor(spikeScore),
    event: event || null,
    metrics: {
      atr: Number(priorAtr.toPrecision(8)),
      compressionRatio: Number(compressionRatio.toFixed(2)),
      expansionRatio: Number(expansionRatio.toFixed(2)),
      momentumAtr: Number(momentumAtr.toFixed(2)),
      breakout, volumeRatio: volumeRatio===null?null:Number(volumeRatio.toFixed(2))
    },
    voteCount:{buy:buyVotes,sell:sellVotes,total:totalVotes},
    evidence,
    candleTime:last.datetime || null,
    disclaimer:"Research score and directional agreement are experimental, not calibrated probabilities or guaranteed trade signals. Confirm price, spread and risk independently."
  };
}

function selectCompletedBefore(candlesInput, cutoffMs, intervalMinutes, windowMinutes) {
  const candles = normalizeCandles(candlesInput);
  return candles.filter(c => {
    const start = Date.parse(c.datetime);
    return Number.isFinite(start) &&
      start + intervalMinutes*60000 <= cutoffMs &&
      start >= cutoffMs-windowMinutes*60000;
  });
}

module.exports = { SYMBOLS, normalizeCandles, analyze, selectCompletedBefore };
