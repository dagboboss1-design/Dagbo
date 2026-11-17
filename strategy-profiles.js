/* DAGBO SIGNAL — trading-style strategy profiles
 * Profile taxonomy and routing preferences. Detection is only claimed where the
 * underlying scanner actually evaluates the required market data.
 */
(function(root){
  'use strict';
  var profiles = [
    {
      id:'scalping', name:'Scalping', tag:'5m · seconds to minutes', timeframes:['5'], primary:'5m', primaryTf:'5',
      sessions:['London open','New York open'], nigeriaWindow:'09:00–18:00 WAT',
      objective:'Capture short intraday moves with tight invalidation and strict spread/liquidity filters.',
      filters:['Closed-candle confirmation','Spread and volatility check','No trade outside configured session','Avoid high-impact news unless Event mode is enabled'],
      indicators:['RSI (7)','EMA 9 / 20 / 50','MACD (6,13,5)','Stochastic (5,3,3)','ATR (14)','VWAP','ADX (14)','Volume vs 20-bar average'],
      priority:[
        ['Momentum','RSI + MACD + Volume','Three-way momentum confirmation'],
        ['Trend pullback','Stochastic + ADX + EMA','Pullback in a strong short-term trend'],
        ['Intraday value','VWAP + Stochastic + Volume','VWAP reclaim/rejection with participation'],
        ['Breakout','Donchian + ADX + ATR','Range break with strength and volatility'],
        ['Trend flip','Supertrend + RSI + Volume','New direction with momentum confirmation'],
        ['Structure','Break & Retest','Closed-candle retest of a broken level'],
        ['Liquidity','Liquidity Sweep Reversal','Sweep and close back through equal highs/lows'],
        ['SMC','FVG + Order Block Mitigation','Only when displacement and invalidation are measurable'],
        ['Session','London/NY Session Open Play','Opening range and session liquidity'],
        ['Pattern','Bull/Bear Flag and Pennant','Impulse followed by a tight continuation pause'],
        ['Candlestick','Engulfing / Pin Bar / Inside Bar','At a mapped level, with close confirmation'],
        ['Reversal','Turtle Soup / Swing Failure Pattern','False break of a confirmed recent extreme']
      ]
    },
    {
      id:'day', name:'Day Trading', tag:'15m–1h · same-day trades', timeframes:['15m','30m','1h'], primary:'15m', primaryTf:'15',
      sessions:['London session','New York session','London–New York overlap'], nigeriaWindow:'Session-aware · WAT display',
      objective:'Trade the session trend, opening ranges, intraday levels and confirmed breakouts. Close or manage before the relevant market close.',
      filters:['Use 15m setup with 1h context','Respect instrument trading hours','Check economic calendar before entry','No overnight carry by default'],
      indicators:['RSI (14)','EMA 20 / 50 / 200','MACD (12,26,9)','ADX (14)','ATR (14)','VWAP','Bollinger Bands','Volume / tick-volume baseline'],
      priority:[
        ['Trend','EMA + MACD + ADX','Trend direction, momentum and strength'],
        ['Momentum','RSI + MACD + Volume','Momentum confirmation with participation'],
        ['Session range','Asian Range Breakout','London break of the completed Asian range'],
        ['Key levels','Previous Day High/Low','Break, rejection or sweep of prior-day extremes'],
        ['Structure','BOS / CHoCH / MSS','Confirmed swing break and retest'],
        ['Liquidity','Equal Highs/Lows Sweep','Liquidity grab followed by close back inside'],
        ['Value','VWAP Reversion / VWAP + RSI','Intraday value reclaim or rejection'],
        ['Breakout','Consolidation Breakout','Close outside a defined range, then retest'],
        ['Pattern','Head & Shoulders / Double Top-Bottom','Only after neckline confirmation'],
        ['Candlestick','Morning/Evening Star / Engulfing','At session levels or supply/demand'],
        ['Risk','ATR stop + fixed fractional sizing','Position size from stop distance and account risk']
      ]
    },
    {
      id:'swing', name:'Swing Trading', tag:'4h–1d · days to weeks', timeframes:['4h','1d'], primary:'4h', primaryTf:'240',
      sessions:['Multi-session'], nigeriaWindow:'No intraday session gate',
      objective:'Capture multi-day directional legs and pullbacks while accounting for overnight and weekend gaps.',
      filters:['4h setup with daily trend context','Use wider structure-based invalidation','Check scheduled macro events and weekend gap exposure','Do not apply scalping time windows'],
      indicators:['RSI (14)','EMA 20 / 50 / 200','MACD (12,26,9)','ADX (14)','ATR (14)','Bollinger Bands','CCI (20)','OBV / MFI where volume is reliable'],
      priority:[
        ['Trend following','Multi-TF EMA + RSI + MACD','Daily/H4 alignment with momentum'],
        ['Trend strength','EMA + MACD + ADX','Avoid weak, directionless conditions'],
        ['Retracement','Fibonacci + EMA','38.2%, 50% or 61.8% confluence with trend support'],
        ['Breakout','Donchian + ADX + ATR','Multi-day range breakout'],
        ['Pattern','Cup & Handle / Falling-Rising Wedge','Wait for neckline or boundary close'],
        ['Structure','Higher High / Higher Low or Lower High / Lower Low','Pullback entry after swing structure confirms'],
        ['SMC','Daily/4h Order Block + FVG','Require displacement and defined invalidation'],
        ['Levels','Weekly Open / Weekly Pivot','Reaction at higher-timeframe reference levels'],
        ['Candlestick','Engulfing / Morning Star / Evening Star','At daily or 4h support/resistance'],
        ['Risk','ATR + structure stop','Account for overnight gap risk']
      ]
    },
    {
      id:'h4', name:'H4', tag:'4h · dedicated higher-timeframe setups', timeframes:['4h'], primary:'4h', primaryTf:'240',
      sessions:['Multi-session'], nigeriaWindow:'No intraday session gate',
      objective:'Run an independent 4-hour technical setup scan. This profile is separate from multi-timeframe H4 intelligence and Hedging basket alerts.',
      filters:['Use only fully closed 4H candles','Require trend, momentum and structure agreement','Use ATR-based invalidation and targets','No scalping session restriction'],
      indicators:['EMA 20 / 50','RSI (14)','MACD (12,26,9)','ADX (14)','ATR (14)','Bollinger Bands','Swing highs/lows'],
      priority:[
        ['Trend','H4 EMA + MACD + RSI','4-hour trend direction and momentum confirmation'],
        ['Trend strength','EMA + MACD + ADX','Filter weak and directionless conditions'],
        ['Structure','BOS / CHoCH / MSS','Confirmed 4H swing break'],
        ['Liquidity','Equal Highs/Lows Sweep','Sweep and close back through a confirmed level'],
        ['SMC','H4 Order Block + FVG','Require displacement and measurable invalidation'],
        ['Pattern','Head & Shoulders / Double Top-Bottom','Wait for neckline confirmation'],
        ['Candlestick','Engulfing / Pin Bar','Only at a mapped 4H level'],
        ['Risk','ATR + structure stop','Set risk from the 4H invalidation distance']
      ]
    },
    {
      id:'position', name:'Position Trading', tag:'1d–1w · weeks to months', timeframes:['1d','1w'], primary:'1d', primaryTf:'1day',
      sessions:['Macro cycle'], nigeriaWindow:'No intraday session gate',
      objective:'Follow major macro and structural trends. Prioritize fundamental regime, broad levels and portfolio risk over frequent entries.',
      filters:['Daily setup with weekly/monthly context','Macro calendar and central-bank regime check','Carry, swap and funding costs matter','Lower turnover; no scalping triggers'],
      indicators:['EMA 50 / 100 / 200','Weekly RSI (14)','Weekly MACD','ADX (14)','ATR (14)','ROC','Relative strength','Long-term support/resistance'],
      priority:[
        ['Macro trend','Macro Trend Trading','Rates, inflation, employment and policy regime'],
        ['Intermarket','DXY / yields / gold / commodities','Use only verified and timestamped data'],
        ['Trend','Weekly EMA + MACD + ADX','Major trend and strength confirmation'],
        ['Relative strength','Relative Strength Rotation','Compare instruments on consistent lookback windows'],
        ['Carry','Carry Trade Context','Yield differential plus financing and risk checks'],
        ['Structure','Weekly BOS / major S/R flip','Confirmed higher-timeframe break and retest'],
        ['Pattern','Rounding Top/Bottom / multi-month base','Require long-duration structure confirmation'],
        ['Risk','Portfolio exposure / fixed fractional','Correlations, concentration and drawdown limits']
      ]
    },
    {
      id:'event', name:'News & Event', tag:'Event window · release-driven', timeframes:['5m','15m','1h'], primary:'15m', primaryTf:'15',
      sessions:['Scheduled release window','Central-bank events'], nigeriaWindow:'Event time shown in WAT',
      objective:'Prepare for scheduled economic releases and measure post-release reaction. Direction and volatility likelihood remain separate assessments.',
      filters:['Require a verified event, timestamp and affected currencies','Check actual vs forecast vs previous when available','No directional call from headline sentiment alone','Wait for post-release price confirmation','If event data is missing, show unavailable—not a guessed bias'],
      indicators:['ATR expansion','Pre-event range/compression','Post-release candle close','Volume/tick-volume anomaly','DXY and yield reaction where available'],
      priority:[
        ['Economic release','CPI / NFP / PMI / rate decisions','Compare verified actual, consensus and prior values'],
        ['Central bank','Rate Decision / Press Conference','Separate statement, decision and press-conference phases'],
        ['Volatility','ATR Breakout / Range Expansion','Measure movement against recent realized volatility'],
        ['Price action','Break & Retest / Failed Breakout','Wait for the market to confirm direction'],
        ['Cross-market','DXY / yields / gold reaction','Only with synchronized available data'],
        ['Risk','Event gap and slippage control','No fixed tight stop assumption during release volatility']
      ]
    }
  ];
  var allStyles = [
    ['Scalping','scalping'],['Day Trading','day'],['Swing Trading','swing'],['Position Trading','position'],['Momentum','scalping day swing'],['Mean Reversion','scalping day swing'],['Trend Following','day swing position'],['Contrarian','day swing position'],['Range Trading','scalping day swing'],['Breakout','scalping day swing']
  ];
  function getProfiles(){return profiles.slice();}
  function getProfile(id){return profiles.find(function(p){return p.id===id;})||profiles[0];}
  root.DagboStrategyProfiles={getProfiles:getProfiles,getProfile:getProfile,allStyles:allStyles};
})(typeof window!=='undefined'?window:this);
