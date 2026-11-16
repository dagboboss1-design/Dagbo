/* DAGBO SIGNAL — Multi-method confluence engine
 * Uses closed OHLC candles only. No synthetic prices or candles.
 */
(function (root) {
  'use strict';

  function num(c, k) { return Number(c && c[k]); }
  function ema(values, period) {
    if (!values.length) return 0;
    var k = 2 / (period + 1), out = values[0];
    for (var i = 1; i < values.length; i++) out = values[i] * k + out * (1 - k);
    return out;
  }
  function rsi(values, period) {
    if (values.length <= period) return 50;
    var gain = 0, loss = 0;
    for (var i = values.length - period; i < values.length; i++) {
      var d = values[i] - values[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    if (!loss) return gain ? 100 : 50;
    return 100 - 100 / (1 + gain / loss);
  }
  function analyze(candles, _unused, profile) {
    if (!Array.isArray(candles) || candles.length < 30) return null;
    var closes = candles.map(function (c) { return num(c, 'close'); });
    if (closes.some(function (v) { return !Number.isFinite(v) || v <= 0; })) return null;
    var last = candles[candles.length - 1], prev = candles[candles.length - 2];
    var close = num(last, 'close'), open = num(last, 'open');
    var high = num(last, 'high'), low = num(last, 'low');
    var prevClose = num(prev, 'close');
    var fast = ema(closes.slice(-50), 9), slow = ema(closes.slice(-50), 21);
    var r = rsi(closes, 14);
    var macdFast = ema(closes.slice(-60), 12) - ema(closes.slice(-60), 26);
    var macdPrev = ema(closes.slice(-61, -1), 12) - ema(closes.slice(-61, -1), 26);
    var macd = macdFast - macdPrev;
    var atrTotal = 0, atrCount = 0;
    for (var i = Math.max(1, candles.length - 14); i < candles.length; i++) {
      var h = num(candles[i], 'high'), l = num(candles[i], 'low'), pc = num(candles[i - 1], 'close');
      if ([h,l,pc].every(Number.isFinite)) { atrTotal += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)); atrCount++; }
    }
    var atr = atrCount ? atrTotal / atrCount : 0;
    var trend = fast > slow && close > slow ? 'BUY' : fast < slow && close < slow ? 'SELL' : 'WAIT';
    var momentum = macd > 0 && r >= 50 ? 'BUY' : macd < 0 && r <= 50 ? 'SELL' : 'WAIT';
    var candleDir = close > open && close > prevClose ? 'BUY' : close < open && close < prevClose ? 'SELL' : 'WAIT';
    var range = high - low;
    var body = Math.abs(close - open);
    var pattern = range > 0 && body / range > 0.65 ? (close > open ? 'Strong bullish candle' : 'Strong bearish candle') : 'No strong candle pattern';
    var votes = [trend, momentum, candleDir], buy = votes.filter(function (v) { return v === 'BUY'; }).length;
    var sell = votes.filter(function (v) { return v === 'SELL'; }).length;
    var needed = profile === 'scalp' ? 2 : 2;
    var signal = buy >= needed && buy > sell ? (buy === 3 ? 'STRONG BUY' : 'BUY') :
      sell >= needed && sell > buy ? (sell === 3 ? 'STRONG SELL' : 'SELL') : 'NO TRADE';
    var evidence = [];
    if (trend !== 'WAIT') evidence.push('EMA trend ' + trend);
    if (momentum !== 'WAIT') evidence.push('Momentum confirmation ' + momentum);
    if (candleDir !== 'WAIT') evidence.push('Candle direction ' + candleDir);
    return {
      signal: signal, buyScore: buy, sellScore: sell, totalMethods: 3,
      evidence: evidence, rsi: Number(r.toFixed(1)), emaTrend: trend,
      macd: Number(macd.toPrecision(5)), structure: 'Recent price structure',
      sweep: 'Not confirmed', fvg: 'Not confirmed', bb: 'Not evaluated',
      volume: 'Not evaluated', pattern: pattern, patternDirection: candleDir,
      patternConfirmed: candleDir !== 'WAIT', confidence: Math.round(Math.max(buy, sell) / 3 * 100),
      quality: signal.indexOf('STRONG') === 0 ? 'HIGH' : signal === 'NO TRADE' ? 'WAIT' : 'MODERATE',
      source: 'EMA + RSI/MACD momentum + candle confirmation',
      threshold: needed, momentumTrigger: momentum !== 'WAIT',
      atrOk: atr > 0, candleTime: String(last.datetime || '')
    };
  }
  root.DagboConfluence = { analyze: analyze };
})(typeof window !== 'undefined' ? window : this);
