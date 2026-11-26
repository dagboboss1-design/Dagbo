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
      id:'hedging', name:'Hedging', tag:'Basket · correlation and exposure management', timeframes:['1h'], primary:'1h', primaryTf:'60',
      basketMode:true, sessions:['Multi-session'], nigeriaWindow:'Continuous monitoring · WAT display',
      objective:'Separate basket-level hedge intelligence. Evaluate correlated instruments and combined currency exposure; never treat a single-pair directional setup as a hedge.',
      filters:['Require synchronized, timestamped prices for both legs','Measure rolling correlation and currency exposure','Check both legs and combined basket risk before alerting','Do not call positively correlated same-direction exposure a hedge','Hedge alerts are informational; they do not guarantee risk reduction'],
      indicators:['Rolling return correlation','Currency exposure by leg','Relative strength and direction','DXY / higher-timeframe context','Combined basket risk'],
      priority:[
        ['Cross-market','Pair correlation and relative strength','Only compare synchronized market data'],
        ['Intermarket','DXY and higher-timeframe context','Use verified daily and 4H direction'],
        ['Structure','Entry and invalidation on both legs','Both legs need independently defined risk'],
        ['Risk','Combined exposure and hedge effectiveness','Flag when both legs increase the same currency exposure']
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
        ['Momentum','RSI + MACD reaction','Confirm the post-release direction from closed candles'],
        ['Volume','Provider volume expansion','Count only when the market-data provider supplies usable volume'],
        ['Price action','Break & Retest / Failed Breakout','Wait for the market to confirm direction'],
        ['Cross-market','DXY / yields / gold reaction','Only with synchronized available data'],
        ['Risk','Event gap and slippage control','No fixed tight stop assumption during release volatility']
      ]
    }
  ];
  // Additional selectable style presets. Each preset selects its own
  // timeframe set and detector groups; the shared confluence engine still
  // requires closed candles and independent evidence before issuing a signal.
  function addPreset(id,name,tag,baseId,timeframes,primaryTf,objective,priority){
    var base=profiles.find(function(p){return p.id===baseId;});
    var preset=Object.assign({},base,{
      id:id,name:name,tag:tag,timeframes:timeframes,primary:timeframes[0],
      primaryTf:primaryTf,objective:objective,priority:priority,
      filters:(base.filters||[]).slice()
    });
    profiles.push(preset);
  }
  addPreset('momentum','Momentum','5m–30m · momentum continuation','scalping',['5m','15m','30m'],'5',
    'Find confirmed continuation when trend, momentum and participation align.',
    [['Momentum','RSI + MACD + Volume','Require momentum direction and participation'],['Trend','EMA + MACD','Trade with the short-term trend'],['Breakout','Donchian + ADX + ATR','Require a closed-range break'],['Structure','Break & Retest','Confirm the broken level holds'],['Pattern','Bull/Bear Flag','Require continuation confirmation'],['Candlestick','Engulfing / Pin Bar','Use candle confirmation at a level']]);
  addPreset('mean-reversion','Mean Reversion','15m–1h · return toward value','day',['15m','30m','1h'],'15',
    'Look for stretched price returning toward a measured value area; avoid fading strong trends.',
    [['Value','VWAP Reversion / VWAP + RSI','Require a value-area reaction'],['Momentum','RSI + MACD','Confirm exhaustion or momentum loss'],['Reversal','Reversal Pattern','Require a confirmed reversal pattern'],['Liquidity','Liquidity Sweep Reversal','Require sweep and close back inside'],['Candlestick','Engulfing / Pin Bar','Require reversal candle confirmation'],['Trend strength','EMA + MACD + ADX','Avoid strong directional trend conditions']]);
  addPreset('trend-following','Trend Following','4h–1w · follow established trend','swing',['4h','1d','1w'],'240',
    'Follow established higher-timeframe direction and enter confirmed pullbacks.',
    [['Trend following','Multi-TF EMA + RSI + MACD','Require higher-timeframe direction'],['Trend strength','EMA + MACD + ADX','Filter weak trends'],['Retracement','Fibonacci + EMA','Seek pullback confluence'],['Structure','Higher High / Higher Low','Confirm continuation structure'],['Breakout','Donchian + ADX + ATR','Confirm trend expansion'],['Candlestick','Engulfing / Pin Bar','Confirm pullback rejection']]);
  addPreset('contrarian','Contrarian','15m–4h · confirmed countertrend','day',['15m','1h','4h'],'15',
    'Only consider countertrend opportunities after a confirmed failure of the prior move.',
    [['Reversal','Reversal Pattern','Require confirmed reversal structure'],['Liquidity','Equal Highs/Lows Sweep','Require failed breakout and reclaim'],['Pattern','Head & Shoulders / Double Top-Bottom','Wait for neckline confirmation'],['Candlestick','Engulfing / Pin Bar','Require reversal candle at a level'],['Key levels','Previous Day High/Low','Use major reference levels'],['Trend','EMA + MACD','Flag countertrend status clearly']]);
  addPreset('range','Range Trading','15m–1h · bounded markets','day',['15m','30m','1h'],'15',
    'Trade confirmed reactions at range boundaries; do not trade when the range breaks.',
    [['Value','VWAP Reversion / VWAP + RSI','Measure return toward range value'],['Liquidity','Equal Highs/Lows Sweep','Detect failed range-edge breaks'],['Reversal','Reversal Pattern','Require rejection at range boundary'],['Candlestick','Engulfing / Pin Bar','Confirm boundary reaction'],['Key levels','Previous Day High/Low','Map range edges'],['Trend strength','EMA + MACD + ADX','Avoid strong trend conditions']]);
  addPreset('breakout','Breakout Trading','5m–4h · confirmed range expansion','day',['15m','30m','1h'],'15',
    'Find confirmed closes beyond defined ranges with volatility and retest confirmation.',
    [['Breakout','Consolidation Breakout','Require a close outside the range'],['Trend strength','EMA + MACD + ADX','Require directional strength'],['Momentum','RSI + MACD + Volume','Confirm participation'],['Structure','BOS / CHoCH / MSS','Confirm structural break'],['Pattern','Bull/Bear Flag','Check continuation structure'],['Volume','Volume expansion','Use volume only when supplied by provider']]); 
  var allStyles = profiles.map(function(p){return [p.name,p.id];});
  function getProfiles(){return profiles.slice();}
  function getProfile(id){return profiles.find(function(p){return p.id===id;})||profiles[0];}
  root.DagboStrategyProfiles={getProfiles:getProfiles,getProfile:getProfile,allStyles:allStyles};
})(typeof window!=='undefined'?window:this);
