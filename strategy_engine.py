"""
════════════════════════════════════════════════════════════════
  TRADING ENGINE — engine.py
  335 registry entries; chart/PA groups include parameterized variants
  30 single + 65 double + 100 triple + 60 chart + 60 PA + 20 hybrid
════════════════════════════════════════════════════════════════
"""
import json, numpy as np, pandas as pd
from dataclasses import dataclass
from typing import Dict, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

# ══════════════════════════════════════════════════════════════
# CONFIG
# ══════════════════════════════════════════════════════════════
@dataclass
class RiskConfig:
    risk_per_trade: float = 0.01
    max_drawdown: float = 0.20
    atr_sl_mult: float = 1.5
    atr_tp_mult: float = 3.0
    trailing: bool = True
    # Broker/instrument settings. Set these from the broker contract specification.
    # spread is the full bid/ask spread expressed in price units, not pips.
    spread: float = 0.0
    commission_per_lot: float = 0.0  # charged per lot per side, in account currency
    swap_per_lot_per_day: float = 0.0  # signed: positive credit, negative charge
    contract_size: float = 1.0  # units represented by one lot
    quote_to_account_rate: float = 1.0  # converts quote-currency PnL into account currency
    bars_per_day: float = 24.0  # set to 96 for 15m, 288 for 5m, etc.

# ══════════════════════════════════════════════════════════════
# DATA LOADER
# ══════════════════════════════════════════════════════════════
class Data:
    @staticmethod
    def yahoo(symbol="BTC-USD", interval="1h", period="3mo") -> pd.DataFrame:
        import yfinance as yf
        df = yf.download(symbol, interval=interval, period=period, progress=False, auto_adjust=True)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.columns = [c.lower() for c in df.columns]
        df = df[['open','high','low','close','volume']].dropna()
        return df

    @staticmethod
    def binance(symbol="BTCUSDT", interval="1h", limit=500) -> pd.DataFrame:
        import requests
        r = requests.get("https://api.binance.com/api/v3/klines",
                         params={"symbol": symbol, "interval": interval, "limit": limit}, timeout=10)
        raw = r.json()
        df = pd.DataFrame(raw, columns=['t','open','high','low','close','volume','ct','qav','n','tbb','tbq','ig'])
        for c in ['open','high','low','close','volume']:
            df[c] = df[c].astype(float)
        return df[['open','high','low','close','volume']]

    @staticmethod
    def synthetic(n=500, seed=42) -> pd.DataFrame:
        if n < 1:
            raise ValueError("n must be at least 1")
        rng = np.random.default_rng(seed)
        close = 100 + np.cumsum(rng.normal(0, 0.5, n))
        open_ = np.r_[close[0], close[:-1]] + rng.normal(0, 0.15, n)
        high = np.maximum(open_, close) + rng.uniform(0.01, 0.8, n)
        low = np.minimum(open_, close) - rng.uniform(0.01, 0.8, n)
        return pd.DataFrame({
            'open': open_, 'high': high, 'low': low, 'close': close,
            'volume': rng.integers(1000, 10000, n)
        })

# ══════════════════════════════════════════════════════════════
# INDICATORS
# ══════════════════════════════════════════════════════════════
class I:
    @staticmethod
    def sma(s, p): return s.rolling(p).mean()
    @staticmethod
    def ema(s, p): return s.ewm(span=p, adjust=False).mean()

    @staticmethod
    def rsi(s, p=14):
        d = s.diff()
        gain = d.clip(lower=0).rolling(p, min_periods=p).mean()
        loss = -d.clip(upper=0).rolling(p, min_periods=p).mean()
        rs = gain / loss.replace(0, np.nan)
        out = 100 - 100/(1+rs)
        out = out.where(loss.ne(0), 100.0)
        out = out.where(gain.ne(0), 0.0)
        out = out.where(~(gain.eq(0) & loss.eq(0)), 50.0)
        return out

    @staticmethod
    def macd(s, f=12, sl=26, sg=9):
        m = I.ema(s, f) - I.ema(s, sl); sig = I.ema(m, sg); return m, sig, m-sig

    @staticmethod
    def bb(s, p=20, std=2):
        mid = s.rolling(p).mean(); sd = s.rolling(p).std()
        return mid+std*sd, mid, mid-std*sd

    @staticmethod
    def atr(df, p=14):
        hl = df['high']-df['low']
        hc = (df['high']-df['close'].shift()).abs()
        lc = (df['low']-df['close'].shift()).abs()
        return pd.concat([hl,hc,lc], axis=1).max(axis=1).rolling(p).mean()

    @staticmethod
    def stoch(df, k=14, d=3):
        ll = df['low'].rolling(k).min(); hh = df['high'].rolling(k).max()
        span = (hh-ll).replace(0, np.nan)
        kk = (100*(df['close']-ll)/span).clip(0, 100)
        return kk, kk.rolling(d, min_periods=d).mean()

    @staticmethod
    def adx(df, p=14):
        up = df['high'].diff(); dn = -df['low'].diff()
        pdm = np.where((up>dn)&(up>0), up, 0.0)
        mdm = np.where((dn>up)&(dn>0), dn, 0.0)
        tr = I.atr(df, p)
        pdi = 100*pd.Series(pdm, index=df.index).rolling(p).mean()/tr
        mdi = 100*pd.Series(mdm, index=df.index).rolling(p).mean()/tr
        dx = 100*(pdi-mdi).abs()/(pdi+mdi)
        return dx.rolling(p).mean(), pdi, mdi

    @staticmethod
    def cci(df, p=20):
        tp = (df['high']+df['low']+df['close'])/3
        ma = tp.rolling(p).mean(); md = (tp-ma).abs().rolling(p).mean()
        return (tp-ma)/(0.015*md)

    @staticmethod
    def williams(df, p=14):
        hh = df['high'].rolling(p).max(); ll = df['low'].rolling(p).min()
        return -100*(hh-df['close'])/(hh-ll).replace(0, np.nan)

    @staticmethod
    def obv(df): return (np.sign(df['close'].diff())*df['volume']).cumsum()

    @staticmethod
    def mfi(df, p=14):
        tp = (df['high']+df['low']+df['close'])/3; mf = tp*df['volume']
        pos = mf.where(tp>tp.shift(), 0).rolling(p).sum()
        neg = mf.where(tp<tp.shift(), 0).rolling(p).sum()
        ratio = pos / neg.replace(0, np.nan)
        out = 100 - 100/(1+ratio)
        out = out.where(neg.ne(0), 100.0)
        out = out.where(pos.ne(0), 0.0)
        out = out.where(~(pos.eq(0) & neg.eq(0)), 50.0)
        return out

    @staticmethod
    def vwap(df):
        tp = (df['high']+df['low']+df['close'])/3
        return (tp*df['volume']).cumsum()/df['volume'].cumsum()

    @staticmethod
    def supertrend(df, p=10, mult=3):
        hl2 = (df['high']+df['low'])/2
        atr = I.atr(df, p)
        basic_upper = hl2 + mult*atr
        basic_lower = hl2 - mult*atr
        final_upper = basic_upper.copy()
        final_lower = basic_lower.copy()
        trend = pd.Series(0, index=df.index, dtype=int)
        st = pd.Series(np.nan, index=df.index, dtype=float)
        for i in range(1, len(df)):
            if pd.isna(atr.iloc[i]) or pd.isna(atr.iloc[i-1]):
                continue
            final_upper.iloc[i] = (basic_upper.iloc[i]
                if basic_upper.iloc[i] < final_upper.iloc[i-1] or df['close'].iloc[i-1] > final_upper.iloc[i-1]
                else final_upper.iloc[i-1])
            final_lower.iloc[i] = (basic_lower.iloc[i]
                if basic_lower.iloc[i] > final_lower.iloc[i-1] or df['close'].iloc[i-1] < final_lower.iloc[i-1]
                else final_lower.iloc[i-1])
            prev = trend.iloc[i-1] or 1
            if prev == 1:
                trend.iloc[i] = -1 if df['close'].iloc[i] < final_lower.iloc[i] else 1
            else:
                trend.iloc[i] = 1 if df['close'].iloc[i] > final_upper.iloc[i] else -1
            st.iloc[i] = final_lower.iloc[i] if trend.iloc[i] == 1 else final_upper.iloc[i]
        return st, trend

    @staticmethod
    def donchian(df, p=20):
        return df['high'].rolling(p).max(), df['low'].rolling(p).min()

    @staticmethod
    def keltner(df, p=20, mult=2):
        mid = I.ema(df['close'], p); a = I.atr(df, p)
        return mid+mult*a, mid, mid-mult*a

    @staticmethod
    def ichimoku(df):
        c = (df['high'].rolling(9).max()+df['low'].rolling(9).min())/2
        b = (df['high'].rolling(26).max()+df['low'].rolling(26).min())/2
        return c, b, (c+b)/2, (df['high'].rolling(52).max()+df['low'].rolling(52).min())/2

    @staticmethod
    def roc(s, p=10): return s.pct_change(p)*100

    @staticmethod
    def trix(s, p=15):
        e = I.ema(I.ema(I.ema(s, p), p), p); return e.pct_change()*100

    @staticmethod
    def psar(df, af=0.02, maxaf=0.2):
        psar = df['close'].copy(); bull = True; v = af; ep = df['high'].iloc[0]
        for i in range(1, len(df)):
            psar.iloc[i] = psar.iloc[i-1] + v*(ep-psar.iloc[i-1])
            if bull:
                if df['low'].iloc[i] < psar.iloc[i]:
                    bull=False; psar.iloc[i]=ep; ep=df['low'].iloc[i]; v=af
                elif df['high'].iloc[i] > ep: ep=df['high'].iloc[i]; v=min(v+af, maxaf)
            else:
                if df['high'].iloc[i] > psar.iloc[i]:
                    bull=True; psar.iloc[i]=ep; ep=df['high'].iloc[i]; v=af
                elif df['low'].iloc[i] < ep: ep=df['low'].iloc[i]; v=min(v+af, maxaf)
        return psar

    @staticmethod
    def ultimate(df, p1=7, p2=14, p3=28):
        bp = df['close'] - pd.concat([df['low'], df['close'].shift()], axis=1).min(axis=1)
        tr = pd.concat([df['high'], df['close'].shift()], axis=1).max(axis=1) - \
             pd.concat([df['low'], df['close'].shift()], axis=1).min(axis=1)
        a1 = bp.rolling(p1).sum()/tr.rolling(p1).sum()
        a2 = bp.rolling(p2).sum()/tr.rolling(p2).sum()
        a3 = bp.rolling(p3).sum()/tr.rolling(p3).sum()
        return 100*(4*a1+2*a2+a3)/7

    @staticmethod
    def aroon(df, p=25):
        up = df['high'].rolling(p+1).apply(lambda x: x.argmax(), raw=True)
        dn = df['low'].rolling(p+1).apply(lambda x: x.argmin(), raw=True)
        return 100*up/p, 100*dn/p

    @staticmethod
    def force_index(df):
        return (df['close']-df['close'].shift())*df['volume']

# ══════════════════════════════════════════════════════════════
# CANDLESTICKS
# ══════════════════════════════════════════════════════════════
class C:
    body = staticmethod(lambda c: abs(c['close']-c['open']))
    rng  = staticmethod(lambda c: c['high']-c['low'])
    uw   = staticmethod(lambda c: c['high']-max(c['open'], c['close']))
    lw   = staticmethod(lambda c: min(c['open'], c['close'])-c['low'])

    @staticmethod
    def doji(c):  return C.body(c) <= 0.1*C.rng(c)
    @staticmethod
    def hammer(c): return C.lw(c) > 2*C.body(c) and C.uw(c) < 0.3*C.body(c)
    @staticmethod
    def star(c):  return C.uw(c) > 2*C.body(c) and C.lw(c) < 0.3*C.body(c)

    @staticmethod
    def bull_engulf(p, c):
        return p['close']<p['open'] and c['close']>c['open'] and c['close']>p['open'] and c['open']<p['close']
    @staticmethod
    def bear_engulf(p, c):
        return p['close']>p['open'] and c['close']<c['open'] and c['close']<p['open'] and c['open']>p['close']
    @staticmethod
    def inside(p, c): return c['high'] < p['high'] and c['low'] > p['low']

    @staticmethod
    def scan(df):
        n = len(df)
        out = pd.DataFrame(index=df.index)
        out['doji']    = df.apply(C.doji, axis=1)
        out['hammer']  = df.apply(C.hammer, axis=1)
        out['star']    = df.apply(C.star, axis=1)
        out['bull_engulf'] = [False]+[C.bull_engulf(df.iloc[i-1], df.iloc[i]) for i in range(1, n)]
        out['bear_engulf'] = [False]+[C.bear_engulf(df.iloc[i-1], df.iloc[i]) for i in range(1, n)]
        out['inside']      = [False]+[C.inside(df.iloc[i-1], df.iloc[i]) for i in range(1, n)]
        return out

# ══════════════════════════════════════════════════════════════
# PRICE ACTION
# ══════════════════════════════════════════════════════════════
class PA:
    @staticmethod
    def sr(df, w=20):
        return df['low'].rolling(w).min(), df['high'].rolling(w).max()

    @staticmethod
    def bos(df, lb=5):
        rh = df['high'].rolling(lb).max(); rl = df['low'].rolling(lb).min()
        return (df['close'] > rh.shift(1)), (df['close'] < rl.shift(1))

    @staticmethod
    def fvg(df):
        return (df['low'] > df['high'].shift(2)), (df['high'] < df['low'].shift(2))

    @staticmethod
    def order_blocks(df, lookback=20, atr_period=14, displacement_atr=1.2,
                     swing_lookback=5, max_age=50):
        """Causal OB approximation: last opposing candle before an ATR-sized
        displacement that breaks a prior swing. Signal only on a later zone
        retest with a directional close; no future candles are consulted.
        Returns (bullish_retest, bearish_retest) boolean Series.
        """
        n = len(df)
        bull = pd.Series(False, index=df.index)
        bear = pd.Series(False, index=df.index)
        atr = I.atr(df, atr_period)
        active_bull = None  # (zone_low, zone_high, created_index)
        active_bear = None
        bull_was_touch = False
        bear_was_touch = False
        for i in range(max(2, swing_lookback + 1), n):
            o, h, l, c = (float(df[k].iloc[i]) for k in ('open','high','low','close'))
            av = atr.iloc[i]
            if pd.isna(av) or av <= 0:
                continue
            prior_high = float(df['high'].iloc[i-swing_lookback:i].max())
            prior_low = float(df['low'].iloc[i-swing_lookback:i].min())
            body = abs(c-o)
            bullish_break = c > o and body >= displacement_atr*av and c > prior_high
            bearish_break = c < o and body >= displacement_atr*av and c < prior_low

            # Expire zones and invalidate them if price closes clean through them.
            if active_bull:
                zl, zh, zi = active_bull
                if i-zi > max_age or c < zl:
                    active_bull = None
                    bull_was_touch = False
            if active_bear:
                zl, zh, zi = active_bear
                if i-zi > max_age or c > zh:
                    active_bear = None
                    bear_was_touch = False

            if bullish_break:
                start = max(0, i-lookback)
                candidates = [j for j in range(i-1, start-1, -1)
                              if df['close'].iloc[j] < df['open'].iloc[j]]
                if candidates:
                    j = candidates[0]
                    active_bull = (float(df['low'].iloc[j]),
                                   float(max(df['open'].iloc[j], df['close'].iloc[j])), i)
                    bull_was_touch = False
            elif bearish_break:
                start = max(0, i-lookback)
                candidates = [j for j in range(i-1, start-1, -1)
                              if df['close'].iloc[j] > df['open'].iloc[j]]
                if candidates:
                    j = candidates[0]
                    active_bear = (float(min(df['open'].iloc[j], df['close'].iloc[j])),
                                   float(df['high'].iloc[j]), i)
                    bear_was_touch = False

            # Do not signal on the displacement candle itself; require a later retest.
            if active_bull and i > active_bull[2]:
                zl, zh, _ = active_bull
                touched = l <= zh and h >= zl
                bull.iloc[i] = touched and not bull_was_touch and c > o and c >= zh
                bull_was_touch = touched
            if active_bear and i > active_bear[2]:
                zl, zh, _ = active_bear
                touched = h >= zl and l <= zh
                bear.iloc[i] = touched and not bear_was_touch and c < o and c <= zl
                bear_was_touch = touched
        return bull, bear

    @staticmethod
    def ob(df, m=1.5):
        # Compatibility helper for older strategies: true when a valid OB retest occurs.
        bull, bear = PA.order_blocks(df, displacement_atr=m)
        return bull | bear

    @staticmethod
    def trendline(df, pivot_bars=3, max_pivots=2, min_slope_atr=0.02):
        """Confirmed-pivot trendline breaks. A pivot is usable only after its
        right-hand confirmation bars have closed, avoiding look-ahead bias.
        Returns bullish and bearish break Series.
        """
        n = len(df)
        bull = pd.Series(False, index=df.index)
        bear = pd.Series(False, index=df.index)
        atr = I.atr(df, 14)
        lows, highs = [], []
        for i in range(2*pivot_bars+1, n):
            pivot_i = i-pivot_bars
            lo_window = df['low'].iloc[pivot_i-pivot_bars:pivot_i+pivot_bars+1]
            hi_window = df['high'].iloc[pivot_i-pivot_bars:pivot_i+pivot_bars+1]
            if len(lo_window) == 2*pivot_bars+1 and df['low'].iloc[pivot_i] == lo_window.min():
                lows.append((pivot_i, float(df['low'].iloc[pivot_i])))
            if len(hi_window) == 2*pivot_bars+1 and df['high'].iloc[pivot_i] == hi_window.max():
                highs.append((pivot_i, float(df['high'].iloc[pivot_i])))
            av = atr.iloc[i]
            if pd.isna(av) or av <= 0:
                continue
            # Descending resistance break = bullish; rising support break = bearish.
            if len(highs) >= max_pivots:
                (x1,y1),(x2,y2) = highs[-max_pivots:]
                if x2 > x1 and y2 < y1:
                    line_now = y1 + (y2-y1)*(i-x1)/(x2-x1)
                    line_prev = y1 + (y2-y1)*(i-1-x1)/(x2-x1)
                    bull.iloc[i] = df['close'].iloc[i] > line_now and df['close'].iloc[i-1] <= line_prev
            if len(lows) >= max_pivots:
                (x1,y1),(x2,y2) = lows[-max_pivots:]
                if x2 > x1 and y2 > y1:
                    line_now = y1 + (y2-y1)*(i-x1)/(x2-x1)
                    line_prev = y1 + (y2-y1)*(i-1-x1)/(x2-x1)
                    bear.iloc[i] = df['close'].iloc[i] < line_now and df['close'].iloc[i-1] >= line_prev
        return bull, bear

    @staticmethod
    def sweep(df, lb=10):
        ph = df['high'].rolling(lb).max().shift(1)
        pl = df['low'].rolling(lb).min().shift(1)
        return (df['low']<pl)&(df['close']>pl), (df['high']>ph)&(df['close']<ph)

    @staticmethod
    def trend(df, w=50):
        e = I.ema(df['close'], w)
        return np.where(df['close']>e, 1, np.where(df['close']<e, -1, 0))

# ══════════════════════════════════════════════════════════════
# HELPER: turn a per-bar boolean into a -1/0/1 signal
# ══════════════════════════════════════════════════════════════
def _sig(pos, neg=None):
    pos = np.asarray(pos, dtype=bool)
    if neg is None:
        return np.where(pos, 1, 0).astype(int)
    neg = np.asarray(neg, dtype=bool)
    return np.where(pos, 1, np.where(neg, -1, 0)).astype(int)

def _fill(sig):
    """Forward-fill NaN bools into 0."""
    s = pd.Series(sig)
    return s.fillna(0).astype(int).values

# ══════════════════════════════════════════════════════════════
# REGISTRY
# ══════════════════════════════════════════════════════════════
class S:
    REGISTRY: Dict[str, Callable] = {}
    @classmethod
    def add(cls, name):
        def deco(fn):
            cls.REGISTRY[name] = fn
            return fn
        return deco

# ──────────────────────────────────────────────────────────────
# A. SINGLE INDICATOR — 30 strategies
# ──────────────────────────────────────────────────────────────
@S.add("01_rsi")
def s01(df):
    r = I.rsi(df['close'])
    return _fill(np.where(r<30, 1, np.where(r>70, -1, 0)))

@S.add("02_ema_cross")
def s02(df):
    e = I.ema(df['close'], 50)
    return _sig(df['close']>e, df['close']<e)

@S.add("03_macd")
def s03(df):
    m, sg, _ = I.macd(df['close'])
    return _sig(m>sg, m<sg)

@S.add("04_bb")
def s04(df):
    u, m, l = I.bb(df['close'])
    return _sig(df['close']<l, df['close']>u)

@S.add("05_stoch")
def s05(df):
    k, d = I.stoch(df)
    return _sig((k<20)&(k>d), (k>80)&(k<d))

@S.add("06_adx")
def s06(df):
    a, p, m = I.adx(df)
    return _sig((a>25)&(p>m), (a>25)&(m>p))

@S.add("07_cci")
def s07(df):
    c = I.cci(df)
    return _sig(c<-100, c>100)

@S.add("08_volume")
def s08(df):
    v = df['volume']
    return _sig(v > 2*v.rolling(20).mean())

@S.add("09_atr_break")
def s09(df):
    a = I.atr(df)
    return _sig(df['close'] > df['open']+1.5*a, df['close'] < df['open']-1.5*a)

@S.add("10_psar")
def s10(df):
    p = I.psar(df)
    return _sig(df['close']>p, df['close']<p)

@S.add("11_vwap")
def s11(df):
    v = I.vwap(df)
    return _sig(df['close']>v, df['close']<v)

@S.add("12_ichimoku")
def s12(df):
    _, _, sa, sb = I.ichimoku(df)
    return _sig(df['close']>np.maximum(sa,sb), df['close']<np.minimum(sa,sb))

@S.add("13_fib")
def s13(df):
    hi = df['high'].rolling(50).max(); lo = df['low'].rolling(50).min()
    return _sig(df['close'] < lo+0.382*(hi-lo), df['close'] > lo+0.618*(hi-lo))

@S.add("14_donchian")
def s14(df):
    h, l = I.donchian(df)
    return _sig(df['close']>h.shift(1), df['close']<l.shift(1))

@S.add("15_keltner")
def s15(df):
    u, m, l = I.keltner(df)
    return _sig(df['close']<l, df['close']>u)

@S.add("16_roc")
def s16(df):
    r = I.roc(df['close'])
    return _sig(r>0, r<0)

@S.add("17_williams")
def s17(df):
    w = I.williams(df)
    return _sig(w<-80, w>-20)

@S.add("18_mfi")
def s18(df):
    m = I.mfi(df)
    return _sig(m<20, m>80)

@S.add("19_obv")
def s19(df):
    o = I.obv(df); ma = o.rolling(20).mean()
    return _sig(o>ma, o<ma)

@S.add("20_supertrend")
def s20(df):
    _, t = I.supertrend(df)
    return np.full(len(df), t, dtype=int)

@S.add("21_momentum")
def s21(df):
    m = df['close'] - df['close'].shift(10)
    return _sig(m>0, m<0)

@S.add("22_chaikin")
def s22(df):
    ad = ((2*df['close']-df['high']-df['low'])/(df['high']-df['low']).replace(0,1))*df['volume']
    c = ad.rolling(3).mean()-ad.rolling(10).mean()
    return _sig(c>0, c<0)

@S.add("23_aroon")
def s23(df):
    u, d = I.aroon(df)
    return _sig((u>70)&(d<30), (d>70)&(u<30))

@S.add("24_trix")
def s24(df):
    t = I.trix(df['close'])
    return _sig(t>0, t<0)

@S.add("25_ultimate")
def s25(df):
    u = I.ultimate(df)
    return _sig(u<30, u>70)

@S.add("26_dmi")
def s26(df):
    _, p, m = I.adx(df)
    return _sig(p>m, m>p)

@S.add("27_channel_mid")
def s27(df):
    h, l = I.donchian(df); mid = (h+l)/2
    return _sig(df['close']<mid, df['close']>mid)

@S.add("28_force")
def s28(df):
    f = I.force_index(df)
    return _sig(f>0, f<0)

@S.add("29_zigzag")
def s29(df):
    w = 5
    h, l = I.donchian(df, w)
    return _sig(df['close']>=h, df['close']<=l)

@S.add("30_pivot")
def s30(df):
    p = (df['high'].shift()+df['low'].shift()+df['close'].shift())/3
    return _sig(df['close']<p*0.99, df['close']>p*1.01)

# ──────────────────────────────────────────────────────────────
# B. TWO INDICATORS — 65 strategies
# ──────────────────────────────────────────────────────────────
def _and(a_fn, b_fn, want=1):
    """Apply a_fn and b_fn, AND their `want` signals, return -1/0/1."""
    a = a_fn(); b = b_fn()
    return _sig((a==want)&(b==want), (a==-want)&(b==-want))

@S.add("31_rsi_macd")
def s31(df):
    r = I.rsi(df['close']); m, sg, _ = I.macd(df['close'])
    return _sig((r<40)&(m>sg), (r>60)&(m<sg))

@S.add("32_ema_rsi")
def s32(df):
    e = I.ema(df['close'], 200); r = I.rsi(df['close'])
    return _sig((df['close']>e)&(r>50), (df['close']<e)&(r<50))

@S.add("33_macd_vol")
def s33(df):
    m, sg, _ = I.macd(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((m>sg)&v, (m<sg)&v)

@S.add("34_bb_rsi")
def s34(df):
    u, _, l = I.bb(df['close']); r = I.rsi(df['close'])
    return _sig((df['close']<l)&(r<30), (df['close']>u)&(r>70))

@S.add("35_stoch_ema")
def s35(df):
    k, d = I.stoch(df); e = I.ema(df['close'], 50)
    return _sig((k>d)&(df['close']>e), (k<d)&(df['close']<e))

@S.add("36_adx_ema")
def s36(df):
    a, _, _ = I.adx(df); e = I.ema(df['close'], 50)
    return _sig((a>25)&(df['close']>e), (a>25)&(df['close']<e))

@S.add("37_macd_sr")
def s37(df):
    m, sg, _ = I.macd(df['close']); lo, hi = PA.sr(df)
    return _sig((m>sg)&(df['close']<lo*1.02), (m<sg)&(df['close']>hi*0.98))

@S.add("38_rsi_bb")
def s38(df):
    return s34(df)

@S.add("39_atr_ema")
def s39(df):
    e = I.ema(df['close'], 50); a = I.atr(df)
    return _sig((df['close']>e)&(a>a.rolling(20).mean()), (df['close']<e)&(a>a.rolling(20).mean()))

@S.add("40_cci_ma")
def s40(df):
    c = I.cci(df); e = I.ema(df['close'], 50)
    return _sig((c>100)&(df['close']>e), (c<-100)&(df['close']<e))

@S.add("41_vol_price")
def s41(df):
    v = df['volume']>df['volume'].rolling(20).mean()
    up = df['close']>df['close'].shift()
    return _sig(v&up, v&~up)

@S.add("42_stoch_macd")
def s42(df):
    k, d = I.stoch(df); m, sg, _ = I.macd(df['close'])
    return _sig((k<20)&(k>d)&(m>sg), (k>80)&(k<d)&(m<sg))

@S.add("43_vwap_rsi")
def s43(df):
    v = I.vwap(df); r = I.rsi(df['close'])
    return _sig((df['close']>v)&(r>50), (df['close']<v)&(r<50))

@S.add("44_ichi_rsi")
def s44(df):
    _, _, sa, sb = I.ichimoku(df); r = I.rsi(df['close'])
    return _sig((df['close']>np.maximum(sa,sb))&(r>50), (df['close']<np.minimum(sa,sb))&(r<50))

@S.add("45_fib_ema")
def s45(df):
    e = I.ema(df['close'], 50); hi = df['high'].rolling(50).max(); lo = df['low'].rolling(50).min()
    lvl = lo+0.618*(hi-lo)
    near = (df['close']-lvl).abs() < 0.01*lvl
    return _sig(near&(df['close']>e), near&(df['close']<e))

@S.add("46_macd_bb")
def s46(df):
    m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close'])
    return _sig((m>sg)&(df['close']<l), (m<sg)&(df['close']>u))

@S.add("47_rsi_adx")
def s47(df):
    r = I.rsi(df['close']); a, _, _ = I.adx(df)
    return _sig((r>50)&(a>25), (r<50)&(a>25))

@S.add("48_stoch_vol")
def s48(df):
    k, d = I.stoch(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((k>d)&(k<20)&v, (k<d)&(k>80)&v)

@S.add("49_ema_atr_cross")
def s49(df):
    f = I.ema(df['close'], 20); s = I.ema(df['close'], 50); a = I.atr(df)
    return _sig((f>s)&(a>a.rolling(20).mean()), (f<s)&(a>a.rolling(20).mean()))

@S.add("50_cci_bb")
def s50(df):
    c = I.cci(df); u, _, l = I.bb(df['close'])
    return _sig((c<-100)&(df['close']<l), (c>100)&(df['close']>u))

@S.add("51_psar_ema")
def s51(df):
    p = I.psar(df); e = I.ema(df['close'], 50)
    return _sig((df['close']>p)&(df['close']>e), (df['close']<p)&(df['close']<e))

@S.add("52_macd_rsi")
def s52(df):
    m, sg, _ = I.macd(df['close']); r = I.rsi(df['close'])
    return _sig((m>sg)&(r>50), (m<sg)&(r<50))

@S.add("53_vwap_vol")
def s53(df):
    v = I.vwap(df); vol = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>v)&vol, (df['close']<v)&vol)

@S.add("54_adx_stoch")
def s54(df):
    a, _, _ = I.adx(df); k, d = I.stoch(df)
    return _sig((a>25)&(k<20)&(k>d), (a>25)&(k>80)&(k<d))

@S.add("55_ema_vol")
def s55(df):
    e = I.ema(df['close'], 50); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>e)&v, (df['close']<e)&v)

@S.add("56_bb_stoch")
def s56(df):
    u, _, l = I.bb(df['close']); k, d = I.stoch(df)
    return _sig((df['close']<l)&(k<20)&(k>d), (df['close']>u)&(k>80)&(k<d))

@S.add("57_rsi_atr")
def s57(df):
    r = I.rsi(df['close']); a = I.atr(df)
    return _sig((r<30)&(a>a.rolling(20).mean()), (r>70)&(a>a.rolling(20).mean()))

@S.add("58_macd_adx")
def s58(df):
    m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((m>sg)&(a>25), (m<sg)&(a>25))

@S.add("59_ichi_vol")
def s59(df):
    _, _, sa, sb = I.ichimoku(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>np.maximum(sa,sb))&v, (df['close']<np.minimum(sa,sb))&v)

@S.add("60_fib_rsi")
def s60(df):
    hi = df['high'].rolling(50).max(); lo = df['low'].rolling(50).min()
    lvl = lo+0.618*(hi-lo); near = (df['close']-lvl).abs() < 0.01*lvl
    r = I.rsi(df['close'])
    return _sig(near&(r<40), near&(r>60))

@S.add("61_supertrend_rsi")
def s61(df):
    _, t = I.supertrend(df); r = I.rsi(df['close'])
    return _sig((t==1)&(r>50), (t==-1)&(r<50))

@S.add("62_donchian_atr")
def s62(df):
    h, l = I.donchian(df); a = I.atr(df); av = a>a.rolling(20).mean()
    return _sig((df['close']>h.shift(1))&av, (df['close']<l.shift(1))&av)

@S.add("63_williams_ema")
def s63(df):
    w = I.williams(df); e = I.ema(df['close'], 50)
    return _sig((w<-80)&(df['close']>e), (w>-20)&(df['close']<e))

@S.add("64_obv_ema")
def s64(df):
    o = I.obv(df); ma = o.rolling(20).mean(); e = I.ema(df['close'], 50)
    return _sig((o>ma)&(df['close']>e), (o<ma)&(df['close']<e))

@S.add("65_mfi_bb")
def s65(df):
    m = I.mfi(df); u, _, l = I.bb(df['close'])
    return _sig((m<20)&(df['close']<l), (m>80)&(df['close']>u))

@S.add("66_supertrend_adx")
def s66(df):
    _, t = I.supertrend(df); a, _, _ = I.adx(df)
    return _sig((t==1)&(a>25), (t==-1)&(a>25))

@S.add("67_rsi_ichimoku")
def s67(df):
    _, _, sa, sb = I.ichimoku(df); r = I.rsi(df['close'])
    return _sig((df['close']>np.maximum(sa,sb))&(r>50), (df['close']<np.minimum(sa,sb))&(r<50))

@S.add("68_aroon_macd")
def s68(df):
    u, d = I.aroon(df); m, sg, _ = I.macd(df['close'])
    return _sig((u>70)&(m>sg), (d>70)&(m<sg))

@S.add("69_roc_ema")
def s69(df):
    r = I.roc(df['close']); e = I.ema(df['close'], 50)
    return _sig((r>0)&(df['close']>e), (r<0)&(df['close']<e))

@S.add("70_trix_macd")
def s70(df):
    t = I.trix(df['close']); m, sg, _ = I.macd(df['close'])
    return _sig((t>0)&(m>sg), (t<0)&(m<sg))

@S.add("71_ultimate_rsi")
def s71(df):
    u = I.ultimate(df); r = I.rsi(df['close'])
    return _sig((u<30)&(r<40), (u>70)&(r>60))

@S.add("72_dmi_ema")
def s72(df):
    _, p, m = I.adx(df); e = I.ema(df['close'], 50)
    return _sig((p>m)&(df['close']>e), (m>p)&(df['close']<e))

@S.add("73_keltner_rsi")
def s73(df):
    _, _, l = I.keltner(df); r = I.rsi(df['close'])
    u, _, _ = I.keltner(df)
    return _sig((df['close']<l)&(r<40), (df['close']>u)&(r>60))

@S.add("74_psar_adx")
def s74(df):
    p = I.psar(df); a, _, _ = I.adx(df)
    return _sig((df['close']>p)&(a>25), (df['close']<p)&(a>25))

@S.add("75_vwap_macd")
def s75(df):
    v = I.vwap(df); m, sg, _ = I.macd(df['close'])
    return _sig((df['close']>v)&(m>sg), (df['close']<v)&(m<sg))

@S.add("76_bb_ema")
def s76(df):
    u, _, l = I.bb(df['close']); e = I.ema(df['close'], 50)
    return _sig((df['close']<l)&(df['close']>e), (df['close']>u)&(df['close']<e))

@S.add("77_rsi_williams")
def s77(df):
    r = I.rsi(df['close']); w = I.williams(df)
    return _sig((r<40)&(w<-80), (r>60)&(w>-20))

@S.add("78_adx_bb")
def s78(df):
    a, _, _ = I.adx(df); u, _, l = I.bb(df['close'])
    return _sig((a<20)&(df['close']<l), (a<20)&(df['close']>u))

@S.add("79_obv_bb")
def s79(df):
    o = I.obv(df); ma = o.rolling(20).mean(); u, _, l = I.bb(df['close'])
    return _sig((o>ma)&(df['close']<l), (o<ma)&(df['close']>u))

@S.add("80_mfi_rsi")
def s80(df):
    m = I.mfi(df); r = I.rsi(df['close'])
    return _sig((m<20)&(r<40), (m>80)&(r>60))

@S.add("81_cci_rsi")
def s81(df):
    c = I.cci(df); r = I.rsi(df['close'])
    return _sig((c<-100)&(r<40), (c>100)&(r>60))

@S.add("82_psar_rsi")
def s82(df):
    p = I.psar(df); r = I.rsi(df['close'])
    return _sig((df['close']>p)&(r>50), (df['close']<p)&(r<50))

@S.add("83_donchian_rsi")
def s83(df):
    h, l = I.donchian(df); r = I.rsi(df['close'])
    return _sig((df['close']>h.shift(1))&(r>50), (df['close']<l.shift(1))&(r<50))

@S.add("84_keltner_adx")
def s84(df):
    _, m, _ = I.keltner(df); a, _, _ = I.adx(df)
    return _sig((df['close']>m)&(a>25), (df['close']<m)&(a>25))

@S.add("85_ultimate_ema")
def s85(df):
    u = I.ultimate(df); e = I.ema(df['close'], 50)
    return _sig((u<30)&(df['close']>e), (u>70)&(df['close']<e))

@S.add("86_williams_macd")
def s86(df):
    w = I.williams(df); m, sg, _ = I.macd(df['close'])
    return _sig((w<-80)&(m>sg), (w>-20)&(m<sg))

@S.add("87_aroon_rsi")
def s87(df):
    u, d = I.aroon(df); r = I.rsi(df['close'])
    return _sig((u>70)&(r>50), (d>70)&(r<50))

@S.add("88_bb_adx")
def s88(df):
    u, _, l = I.bb(df['close']); a, _, _ = I.adx(df)
    return _sig((df['close']<l)&(a>25), (df['close']>u)&(a>25))

@S.add("89_trix_ema")
def s89(df):
    t = I.trix(df['close']); e = I.ema(df['close'], 50)
    return _sig((t>0)&(df['close']>e), (t<0)&(df['close']<e))

@S.add("90_roc_rsi")
def s90(df):
    r = I.roc(df['close']); rsi = I.rsi(df['close'])
    return _sig((r>0)&(rsi>50), (r<0)&(rsi<50))

@S.add("91_dmi_stoch")
def s91(df):
    _, p, m = I.adx(df); k, d = I.stoch(df)
    return _sig((p>m)&(k>d), (m>p)&(k<d))

@S.add("92_vwap_ema")
def s92(df):
    v = I.vwap(df); e = I.ema(df['close'], 50)
    return _sig((df['close']>v)&(df['close']>e), (df['close']<v)&(df['close']<e))

@S.add("93_macd_ema")
def s93(df):
    m, sg, _ = I.macd(df['close']); e = I.ema(df['close'], 200)
    return _sig((m>sg)&(df['close']>e), (m<sg)&(df['close']<e))

@S.add("94_bb_mfi")
def s94(df):
    u, _, l = I.bb(df['close']); m = I.mfi(df)
    return _sig((df['close']<l)&(m<30), (df['close']>u)&(m>70))

@S.add("95_supertrend_macd")
def s95(df):
    _, t = I.supertrend(df); m, sg, _ = I.macd(df['close'])
    return _sig((t==1)&(m>sg), (t==-1)&(m<sg))

# ──────────────────────────────────────────────────────────────
# C. THREE INDICATORS — 100 strategies
# ──────────────────────────────────────────────────────────────
@S.add("96_rsi_macd_vol")
def s96(df):
    r = I.rsi(df['close']); m, sg, _ = I.macd(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((r>50)&(m>sg)&v, (r<50)&(m<sg)&v)

@S.add("97_ema_rsi_atr")
def s97(df):
    e = I.ema(df['close'], 200); r = I.rsi(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>e)&(r>50)&av, (df['close']<e)&(r<50)&av)

@S.add("98_bb_rsi_macd")
def s98(df):
    u, _, l = I.bb(df['close']); r = I.rsi(df['close']); m, sg, _ = I.macd(df['close'])
    return _sig((df['close']<l)&(r<35)&(m>sg), (df['close']>u)&(r>65)&(m<sg))

@S.add("99_stoch_adx_ema")
def s99(df):
    a, _, _ = I.adx(df); k, d = I.stoch(df); e = I.ema(df['close'], 50)
    return _sig((a>25)&(k>d)&(df['close']>e), (a>25)&(k<d)&(df['close']<e))

@S.add("100_macd_vol_sr")
def s100(df):
    m, sg, _ = I.macd(df['close']); v = df['volume']>df['volume'].rolling(20).mean(); lo, hi = PA.sr(df)
    return _sig((m>sg)&v&(df['close']<lo*1.02), (m<sg)&v&(df['close']>hi*0.98))

@S.add("101_rsi_stoch_bb")
def s101(df):
    r = I.rsi(df['close']); k, _ = I.stoch(df); u, _, l = I.bb(df['close'])
    return _sig((r<35)&(k<20)&(df['close']<l), (r>65)&(k>80)&(df['close']>u))

@S.add("102_ema_adx_vol")
def s102(df):
    f = I.ema(df['close'], 20); s = I.ema(df['close'], 50); a, _, _ = I.adx(df)
    v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((f>s)&(a>25)&v, (f<s)&(a>25)&v)

@S.add("103_vwap_macd_atr")
def s103(df):
    v = I.vwap(df); m, sg, _ = I.macd(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>v)&(m>sg)&av, (df['close']<v)&(m<sg)&av)

@S.add("104_ichi_rsi_vol")
def s104(df):
    _, _, sa, sb = I.ichimoku(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>np.maximum(sa,sb))&(r>50)&v, (df['close']<np.minimum(sa,sb))&(r<50)&v)

@S.add("105_cci_ema_bb")
def s105(df):
    c = I.cci(df); e = I.ema(df['close'], 50); u, _, l = I.bb(df['close'])
    return _sig((c>100)&(df['close']>e)&(df['close']<u), (c<-100)&(df['close']<e)&(df['close']>l))

@S.add("106_psar_macd_rsi")
def s106(df):
    p = I.psar(df); m, sg, _ = I.macd(df['close']); r = I.rsi(df['close'])
    return _sig((df['close']>p)&(m>sg)&(r>50), (df['close']<p)&(m<sg)&(r<50))
@S.add("107_fib_rsi_vol")
def s107(df):
    hi = df['high'].rolling(50).max(); lo = df['low'].rolling(50).min()
    lvl = lo+0.618*(hi-lo); near = (df['close']-lvl).abs() < 0.015*lvl
    r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig(near&(r<40)&v, near&(r>60)&v)

@S.add("108_adx_stoch_ema")
def s108(df):
    return s99(df)

@S.add("109_macd_bb_atr")
def s109(df):
    m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((m>sg)&(df['close']<l)&av, (m<sg)&(df['close']>u)&av)

@S.add("110_supertrend_rsi_vol")
def s110(df):
    _, t = I.supertrend(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((t==1)&(r>50)&v, (t==-1)&(r<50)&v)

@S.add("111_donchian_adx_atr")
def s111(df):
    h, l = I.donchian(df); a, _, _ = I.adx(df); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((df['close']>h.shift(1))&(a>25)&av, (df['close']<l.shift(1))&(a>25)&av)

@S.add("112_vwap_stoch_vol")
def s112(df):
    v = I.vwap(df); k, d = I.stoch(df); vol = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']<v)&(k<20)&(k>d)&vol, (df['close']>v)&(k>80)&(k<d)&vol)

@S.add("113_ema_macd_adx")
def s113(df):
    e = I.ema(df['close'], 50); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((df['close']>e)&(m>sg)&(a>25), (df['close']<e)&(m<sg)&(a>25))

@S.add("114_rsi_cci_vol")
def s114(df):
    r = I.rsi(df['close']); c = I.cci(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((r<40)&(c<-100)&v, (r>60)&(c>100)&v)

@S.add("115_bb_adx_atr")
def s115(df):
    u, _, l = I.bb(df['close']); a, _, _ = I.adx(df); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((df['close']<l)&(a<20)&av, (df['close']>u)&(a<20)&av)

@S.add("116_ichi_stoch_adx")
def s116(df):
    _, _, sa, sb = I.ichimoku(df); k, d = I.stoch(df); a, _, _ = I.adx(df)
    return _sig((df['close']>np.maximum(sa,sb))&(k>d)&(a>25), (df['close']<np.minimum(sa,sb))&(k<d)&(a>25))

@S.add("117_macd_obv_ema")
def s117(df):
    m, sg, _ = I.macd(df['close']); o = I.obv(df); ma = o.rolling(20).mean(); e = I.ema(df['close'], 50)
    return _sig((m>sg)&(o>ma)&(df['close']>e), (m<sg)&(o<ma)&(df['close']<e))

@S.add("118_fib_macd_adx")
def s118(df):
    hi = df['high'].rolling(50).max(); lo = df['low'].rolling(50).min()
    lvl = lo+0.618*(hi-lo); near = (df['close']-lvl).abs() < 0.015*lvl
    m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig(near&(m>sg)&(a>25), near&(m<sg)&(a>25))

@S.add("119_williams_ema_vol")
def s119(df):
    w = I.williams(df); e = I.ema(df['close'], 50); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((w<-80)&(df['close']>e)&v, (w>-20)&(df['close']<e)&v)

@S.add("120_psar_adx_atr")
def s120(df):
    p = I.psar(df); a, _, _ = I.adx(df); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((df['close']>p)&(a>25)&av, (df['close']<p)&(a>25)&av)

@S.add("121_vwap_rsi_atr")
def s121(df):
    v = I.vwap(df); r = I.rsi(df['close']); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((df['close']>v)&(r>50)&av, (df['close']<v)&(r<50)&av)

@S.add("122_stoch_macd_adx")
def s122(df):
    k, d = I.stoch(df); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((k>d)&(m>sg)&(a>25), (k<d)&(m<sg)&(a>25))

@S.add("123_donchian_rsi_vol")
def s123(df):
    h, l = I.donchian(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>h.shift(1))&(r>50)&v, (df['close']<l.shift(1))&(r<50)&v)

@S.add("124_supertrend_bb_rsi")
def s124(df):
    _, t = I.supertrend(df); u, _, l = I.bb(df['close']); r = I.rsi(df['close'])
    return _sig((t==1)&(df['close']<l)&(r<40), (t==-1)&(df['close']>u)&(r>60))

@S.add("125_mfi_ema_atr")
def s125(df):
    m = I.mfi(df); e = I.ema(df['close'], 50); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((m<20)&(df['close']>e)&av, (m>80)&(df['close']<e)&av)

@S.add("126_cci_adx_vol")
def s126(df):
    c = I.cci(df); a, _, _ = I.adx(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((c>100)&(a>25)&v, (c<-100)&(a>25)&v)

@S.add("127_ichi_macd_atr")
def s127(df):
    _, _, sa, sb = I.ichimoku(df); m, sg, _ = I.macd(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>np.maximum(sa,sb))&(m>sg)&av, (df['close']<np.minimum(sa,sb))&(m<sg)&av)

@S.add("128_ema_stoch_bb")
def s128(df):
    e = I.ema(df['close'], 50); k, d = I.stoch(df); u, _, l = I.bb(df['close'])
    return _sig((df['close']>e)&(k>d)&(df['close']<u), (df['close']<e)&(k<d)&(df['close']>l))

@S.add("129_rsi_macd_adx")
def s129(df):
    r = I.rsi(df['close']); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((r>50)&(m>sg)&(a>25), (r<50)&(m<sg)&(a>25))

@S.add("130_supertrend_rsi_adx")
def s130(df):
    _, t = I.supertrend(df); r = I.rsi(df['close']); a, _, _ = I.adx(df)
    return _sig((t==1)&(r>50)&(a>25), (t==-1)&(r<50)&(a>25))

@S.add("131_macd_bb_vol")
def s131(df):
    m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((m>sg)&(df['close']<l)&v, (m<sg)&(df['close']>u)&v)

@S.add("132_ema_rsi_macd")
def s132(df):
    e = I.ema(df['close'], 200); r = I.rsi(df['close']); m, sg, _ = I.macd(df['close'])
    return _sig((df['close']>e)&(r>50)&(m>sg), (df['close']<e)&(r<50)&(m<sg))

@S.add("133_adx_cci_bb")
def s133(df):
    a, _, _ = I.adx(df); c = I.cci(df); u, _, l = I.bb(df['close'])
    return _sig((a>25)&(c>100)&(df['close']<u), (a>25)&(c<-100)&(df['close']>l))

@S.add("134_ichi_rsi_macd")
def s134(df):
    _, _, sa, sb = I.ichimoku(df); r = I.rsi(df['close']); m, sg, _ = I.macd(df['close'])
    return _sig((df['close']>np.maximum(sa,sb))&(r>50)&(m>sg), (df['close']<np.minimum(sa,sb))&(r<50)&(m<sg))

@S.add("135_vwap_ema_rsi")
def s135(df):
    v = I.vwap(df); e = I.ema(df['close'], 50); r = I.rsi(df['close'])
    return _sig((df['close']>v)&(df['close']>e)&(r>50), (df['close']<v)&(df['close']<e)&(r<50))

@S.add("136_psar_supertrend_rsi")
def s136(df):
    p = I.psar(df); _, t = I.supertrend(df); r = I.rsi(df['close'])
    return _sig((df['close']>p)&(t==1)&(r>50), (df['close']<p)&(t==-1)&(r<50))

@S.add("137_donchian_macd_adx")
def s137(df):
    h, l = I.donchian(df); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((df['close']>h.shift(1))&(m>sg)&(a>25), (df['close']<l.shift(1))&(m<sg)&(a>25))

@S.add("138_keltner_rsi_vol")
def s138(df):
    u, _, l = I.keltner(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']<l)&(r<40)&v, (df['close']>u)&(r>60)&v)

@S.add("139_williams_mfi_ema")
def s139(df):
    w = I.williams(df); m = I.mfi(df); e = I.ema(df['close'], 50)
    return _sig((w<-80)&(m<20)&(df['close']>e), (w>-20)&(m>80)&(df['close']<e))

@S.add("140_aroon_trix_adx")
def s140(df):
    u, d = I.aroon(df); t = I.trix(df['close']); a, _, _ = I.adx(df)
    return _sig((u>70)&(t>0)&(a>25), (d>70)&(t<0)&(a>25))

@S.add("141_roc_rsi_ema")
def s141(df):
    ro = I.roc(df['close']); r = I.rsi(df['close']); e = I.ema(df['close'], 50)
    return _sig((ro>0)&(r>50)&(df['close']>e), (ro<0)&(r<50)&(df['close']<e))

@S.add("142_ultimate_macd_bb")
def s142(df):
    u_ = I.ultimate(df); m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close'])
    return _sig((u_<30)&(m>sg)&(df['close']<l), (u_>70)&(m<sg)&(df['close']>u))

@S.add("143_force_obv_ema")
def s143(df):
    f = I.force_index(df); o = I.obv(df); ma = o.rolling(20).mean(); e = I.ema(df['close'], 50)
    return _sig((f>0)&(o>ma)&(df['close']>e), (f<0)&(o<ma)&(df['close']<e))

@S.add("144_cci_stoch_adx")
def s144(df):
    c = I.cci(df); k, d = I.stoch(df); a, _, _ = I.adx(df)
    return _sig((c>100)&(k>d)&(a>25), (c<-100)&(k<d)&(a>25))

@S.add("145_mfi_bb_rsi")
def s145(df):
    m = I.mfi(df); u, _, l = I.bb(df['close']); r = I.rsi(df['close'])
    return _sig((m<20)&(df['close']<l)&(r<40), (m>80)&(df['close']>u)&(r>60))

@S.add("146_supertrend_adx_atr")
def s146(df):
    _, t = I.supertrend(df); a, _, _ = I.adx(df); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((t==1)&(a>25)&av, (t==-1)&(a>25)&av)

@S.add("147_macd_rsi_obv")
def s147(df):
    m, sg, _ = I.macd(df['close']); r = I.rsi(df['close']); o = I.obv(df); ma = o.rolling(20).mean()
    return _sig((m>sg)&(r>50)&(o>ma), (m<sg)&(r<50)&(o<ma))

@S.add("148_ema_bb_vol")
def s148(df):
    e = I.ema(df['close'], 50); u, _, l = I.bb(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>e)&(df['close']<u)&v, (df['close']<e)&(df['close']>l)&v)

@S.add("149_donchian_rsi_atr")
def s149(df):
    h, l = I.donchian(df); r = I.rsi(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>h.shift(1))&(r>50)&av, (df['close']<l.shift(1))&(r<50)&av)

@S.add("150_stoch_macd_vol")
def s150(df):
    k, d = I.stoch(df); m, sg, _ = I.macd(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((k>d)&(m>sg)&v, (k<d)&(m<sg)&v)

@S.add("151_ichi_supertrend_rsi")
def s151(df):
    _, _, sa, sb = I.ichimoku(df); _, t = I.supertrend(df); r = I.rsi(df['close'])
    return _sig((df['close']>np.maximum(sa,sb))&(t==1)&(r>50), (df['close']<np.minimum(sa,sb))&(t==-1)&(r<50))

@S.add("152_cci_rsi_vol")
def s152(df):
    c = I.cci(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((c>100)&(r>50)&v, (c<-100)&(r<50)&v)

@S.add("153_williams_stoch_macd")
def s153(df):
    w = I.williams(df); k, d = I.stoch(df); m, sg, _ = I.macd(df['close'])
    return _sig((w<-80)&(k>d)&(m>sg), (w>-20)&(k<d)&(m<sg))

@S.add("154_psar_ema_adx")
def s154(df):
    p = I.psar(df); e = I.ema(df['close'], 50); a, _, _ = I.adx(df)
    return _sig((df['close']>p)&(df['close']>e)&(a>25), (df['close']<p)&(df['close']<e)&(a>25))

@S.add("155_keltner_bb_rsi")
def s155(df):
    ku, _, kl = I.keltner(df); u, _, l = I.bb(df['close']); r = I.rsi(df['close'])
    return _sig((df['close']<kl)&(df['close']<l)&(r<40), (df['close']>ku)&(df['close']>u)&(r>60))

@S.add("156_aroon_macd_vol")
def s156(df):
    u, d = I.aroon(df); m, sg, _ = I.macd(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((u>70)&(m>sg)&v, (d>70)&(m<sg)&v)

@S.add("157_trix_ema_rsi")
def s157(df):
    t = I.trix(df['close']); e = I.ema(df['close'], 50); r = I.rsi(df['close'])
    return _sig((t>0)&(df['close']>e)&(r>50), (t<0)&(df['close']<e)&(r<50))

@S.add("158_roc_adx_vol")
def s158(df):
    r = I.roc(df['close']); a, _, _ = I.adx(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((r>0)&(a>25)&v, (r<0)&(a>25)&v)

@S.add("159_ultimate_rsi_ema")
def s159(df):
    u = I.ultimate(df); r = I.rsi(df['close']); e = I.ema(df['close'], 50)
    return _sig((u<30)&(r<40)&(df['close']>e), (u>70)&(r>60)&(df['close']<e))

@S.add("160_force_macd_bb")
def s160(df):
    f = I.force_index(df); m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close'])
    return _sig((f>0)&(m>sg)&(df['close']<l), (f<0)&(m<sg)&(df['close']>u))

@S.add("161_obv_rsi_adx")
def s161(df):
    o = I.obv(df); ma = o.rolling(20).mean(); r = I.rsi(df['close']); a, _, _ = I.adx(df)
    return _sig((o>ma)&(r>50)&(a>25), (o<ma)&(r<50)&(a>25))

@S.add("162_macd_rsi_bb")
def s162(df):
    m, sg, _ = I.macd(df['close']); r = I.rsi(df['close']); u, _, l = I.bb(df['close'])
    return _sig((m>sg)&(r>50)&(df['close']<l), (m<sg)&(r<50)&(df['close']>u))

@S.add("163_ema_cci_adx")
def s163(df):
    e = I.ema(df['close'], 50); c = I.cci(df); a, _, _ = I.adx(df)
    return _sig((df['close']>e)&(c>100)&(a>25), (df['close']<e)&(c<-100)&(a>25))

@S.add("164_ichi_williams_macd")
def s164(df):
    _, _, sa, sb = I.ichimoku(df); w = I.williams(df); m, sg, _ = I.macd(df['close'])
    return _sig((df['close']>np.maximum(sa,sb))&(w<-80)&(m>sg), (df['close']<np.minimum(sa,sb))&(w>-20)&(m<sg))

@S.add("165_mfi_ema_rsi")
def s165(df):
    m = I.mfi(df); e = I.ema(df['close'], 50); r = I.rsi(df['close'])
    return _sig((m<20)&(df['close']>e)&(r<40), (m>80)&(df['close']<e)&(r>60))

@S.add("166_supertrend_bb_adx")
def s166(df):
    _, t = I.supertrend(df); u, _, l = I.bb(df['close']); a, _, _ = I.adx(df)
    return _sig((t==1)&(df['close']<l)&(a>25), (t==-1)&(df['close']>u)&(a>25))

@S.add("167_stoch_rsi_vol")
def s167(df):
    k, d = I.stoch(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((k>d)&(r>50)&v, (k<d)&(r<50)&v)

@S.add("168_vwap_cci_atr")
def s168(df):
    v = I.vwap(df); c = I.cci(df); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>v)&(c>100)&av, (df['close']<v)&(c<-100)&av)

@S.add("169_donchian_ema_adx")
def s169(df):
    h, l = I.donchian(df); e = I.ema(df['close'], 50); a, _, _ = I.adx(df)
    return _sig((df['close']>h.shift(1))&(df['close']>e)&(a>25), (df['close']<l.shift(1))&(df['close']<e)&(a>25))

@S.add("170_ultimate_mfi_bb")
def s170(df):
    u_ = I.ultimate(df); m = I.mfi(df); u, _, l = I.bb(df['close'])
    return _sig((u_<30)&(m<20)&(df['close']<l), (u_>70)&(m>80)&(df['close']>u))

@S.add("171_aroon_rsi_vol")
def s171(df):
    u, d = I.aroon(df); r = I.rsi(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((u>70)&(r>50)&v, (d>70)&(r<50)&v)

@S.add("172_trix_rsi_ema")
def s172(df):
    t = I.trix(df['close']); r = I.rsi(df['close']); e = I.ema(df['close'], 50)
    return _sig((t>0)&(r>50)&(df['close']>e), (t<0)&(r<50)&(df['close']<e))

@S.add("173_psar_macd_adx")
def s173(df):
    p = I.psar(df); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((df['close']>p)&(m>sg)&(a>25), (df['close']<p)&(m<sg)&(a>25))

@S.add("174_force_cci_rsi")
def s174(df):
    f = I.force_index(df); c = I.cci(df); r = I.rsi(df['close'])
    return _sig((f>0)&(c>100)&(r>50), (f<0)&(c<-100)&(r<50))

@S.add("175_keltner_adx_atr")
def s175(df):
    _, mid, _ = I.keltner(df); a, _, _ = I.adx(df); at = I.atr(df)
    av = at>at.rolling(20).mean()
    return _sig((df['close']>mid)&(a>25)&av, (df['close']<mid)&(a>25)&av)

@S.add("176_obv_macd_bb")
def s176(df):
    o = I.obv(df); ma = o.rolling(20).mean(); m, sg, _ = I.macd(df['close']); u, _, l = I.bb(df['close'])
    return _sig((o>ma)&(m>sg)&(df['close']<l), (o<ma)&(m<sg)&(df['close']>u))

@S.add("177_roc_stoch_ema")
def s177(df):
    r = I.roc(df['close']); k, d = I.stoch(df); e = I.ema(df['close'], 50)
    return _sig((r>0)&(k>d)&(df['close']>e), (r<0)&(k<d)&(df['close']<e))

@S.add("178_williams_adx_vol")
def s178(df):
    w = I.williams(df); a, _, _ = I.adx(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((w<-80)&(a>25)&v, (w>-20)&(a>25)&v)

@S.add("179_mfi_cci_macd")
def s179(df):
    m = I.mfi(df); c = I.cci(df); ma, sg, _ = I.macd(df['close'])
    return _sig((m<20)&(c<-100)&(ma>sg), (m>80)&(c>100)&(ma<sg))

@S.add("180_vwap_williams_adx")
def s180(df):
    v = I.vwap(df); w = I.williams(df); a, _, _ = I.adx(df)
    return _sig((df['close']>v)&(w<-80)&(a>25), (df['close']<v)&(w>-20)&(a>25))

@S.add("181_supertrend_obv_rsi")
def s181(df):
    _, t = I.supertrend(df); o = I.obv(df); ma = o.rolling(20).mean(); r = I.rsi(df['close'])
    return _sig((t==1)&(o>ma)&(r>50), (t==-1)&(o<ma)&(r<50))

@S.add("182_donchian_stoch_atr")
def s182(df):
    h, l = I.donchian(df); k, d = I.stoch(df); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']>h.shift(1))&(k>d)&av, (df['close']<l.shift(1))&(k<d)&av)

@S.add("183_bb_rsi_atr")
def s183(df):
    u, _, l = I.bb(df['close']); r = I.rsi(df['close']); a = I.atr(df)
    av = a>a.rolling(20).mean()
    return _sig((df['close']<l)&(r<30)&av, (df['close']>u)&(r>70)&av)

@S.add("184_ema_mfi_rsi")
def s184(df):
    e = I.ema(df['close'], 50); m = I.mfi(df); r = I.rsi(df['close'])
    return _sig((df['close']>e)&(m<30)&(r<40), (df['close']<e)&(m>70)&(r>60))

@S.add("185_psar_stoch_vol")
def s185(df):
    p = I.psar(df); k, d = I.stoch(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>p)&(k>d)&v, (df['close']<p)&(k<d)&v)

@S.add("186_aroon_adx_ema")
def s186(df):
    u, d = I.aroon(df); a, _, _ = I.adx(df); e = I.ema(df['close'], 50)
    return _sig((u>70)&(a>25)&(df['close']>e), (d>70)&(a>25)&(df['close']<e))

@S.add("187_cci_williams_macd")
def s187(df):
    c = I.cci(df); w = I.williams(df); m, sg, _ = I.macd(df['close'])
    return _sig((c>100)&(w<-20)&(m>sg), (c<-100)&(w>-80)&(m<sg))

@S.add("188_vwap_aroon_rsi")
def s188(df):
    v = I.vwap(df); u, d = I.aroon(df); r = I.rsi(df['close'])
    return _sig((df['close']>v)&(u>70)&(r>50), (df['close']<v)&(d>70)&(r<50))

@S.add("189_trix_cci_ema")
def s189(df):
    t = I.trix(df['close']); c = I.cci(df); e = I.ema(df['close'], 50)
    return _sig((t>0)&(c>100)&(df['close']>e), (t<0)&(c<-100)&(df['close']<e))

@S.add("190_ultimate_bb_vol")
def s190(df):
    u_ = I.ultimate(df); u, _, l = I.bb(df['close']); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((u_<30)&(df['close']<l)&v, (u_>70)&(df['close']>u)&v)

@S.add("191_keltner_macd_adx")
def s191(df):
    _, mid, _ = I.keltner(df); m, sg, _ = I.macd(df['close']); a, _, _ = I.adx(df)
    return _sig((df['close']>mid)&(m>sg)&(a>25), (df['close']<mid)&(m<sg)&(a>25))

@S.add("192_obv_ema_mfi")
def s192(df):
    o = I.obv(df); ma = o.rolling(20).mean(); e = I.ema(df['close'], 50); m = I.mfi(df)
    return _sig((o>ma)&(df['close']>e)&(m<30), (o<ma)&(df['close']<e)&(m>70))

@S.add("193_roc_williams_stoch")
def s193(df):
    r = I.roc(df['close']); w = I.williams(df); k, d = I.stoch(df)
    return _sig((r>0)&(w<-80)&(k>d), (r<0)&(w>-20)&(k<d))

@S.add("194_psar_aroon_vol")
def s194(df):
    p = I.psar(df); u, d = I.aroon(df); v = df['volume']>df['volume'].rolling(20).mean()
    return _sig((df['close']>p)&(u>70)&v, (df['close']<p)&(d>70)&v)

@S.add("195_force_cci_bb")
def s195(df):
    f = I.force_index(df); c = I.cci(df); u, _, l = I.bb(df['close'])
    return _sig((f>0)&(c>100)&(df['close']<u), (f<0)&(c<-100)&(df['close']>l))

# ──────────────────────────────────────────────────────────────
# D. CHART PATTERNS — 60 strategies (10 patterns × 6 variants)
# ──────────────────────────────────────────────────────────────
class CH:
    @staticmethod
    def swings(df, w=5):
        h, l = [], []
        for i in range(w, len(df)-w):
            if df['high'].iloc[i] == df['high'].iloc[i-w:i+w+1].max(): h.append((i, df['high'].iloc[i]))
            if df['low'].iloc[i] == df['low'].iloc[i-w:i+w+1].min(): l.append((i, df['low'].iloc[i]))
        return h, l

    @staticmethod
    def hs(df, w=5):
        h, _ = CH.swings(df, w)
        if len(h)>=3:
            h1,h2,h3 = h[-3][1], h[-2][1], h[-1][1]
            if h2>h1 and h2>h3 and abs(h1-h3)<0.03*h1: return -1
        return 0
    @staticmethod
    def ihs(df, w=5):
        _, l = CH.swings(df, w)
        if len(l)>=3:
            l1,l2,l3 = l[-3][1], l[-2][1], l[-1][1]
            if l2<l1 and l2<l3 and abs(l1-l3)<0.03*l1: return 1
        return 0
    @staticmethod
    def dt(df, w=5):
        h, _ = CH.swings(df, w)
        if len(h)>=2 and abs(h[-1][1]-h[-2][1])<0.02*h[-1][1]: return -1
        return 0
    @staticmethod
    def db(df, w=5):
        _, l = CH.swings(df, w)
        if len(l)>=2 and abs(l[-1][1]-l[-2][1])<0.02*l[-1][1]: return 1
        return 0
    @staticmethod
    def tri(df, w=5):
        r = df.iloc[-max(10, w*4):]
        return 1 if r['high'].std()<0.05*r['high'].mean() else 0
    @staticmethod
    def flag(df, w=5):
        r = df.iloc[-max(6, w*2):]
        return 1 if r['close'].iloc[-1]>r['close'].iloc[0] else -1
    @staticmethod
    def cup(df, w=5):
        span = max(20, w*12)
        if len(df) < span: return 0
        r = df.iloc[-span:]
        trough_pos = int(np.argmin(r['low'].to_numpy()))
        return 1 if 3 <= trough_pos <= len(r)-4 else 0
    @staticmethod
    def wedge(df, w=5):
        r = df.iloc[-max(10, w*4):]
        return 1 if r['high'].std()<0.04*r['high'].mean() and r['low'].std()<0.04*r['low'].mean() else 0
    @staticmethod
    def diamond(df, w=5):
        r = df.iloc[-max(12, w*6):]
        return 1 if r['high'].std()>0.06*r['high'].mean() and r['low'].std()>0.06*r['low'].mean() else 0
    @staticmethod
    def chan(df, w=5):
        r = df.iloc[-max(10, w*4):]
        return 1 if (r['close'].iloc[-1]-r['close'].iloc[0])/r['close'].iloc[0] > 0.02 else -1

def _chart_make(fn, variant):
    def strat(df):
        out = np.zeros(len(df), int)
        if len(df):
            out[-1] = fn(df, w=3 + 2*variant)
        return out
    return strat

_patterns = [
    ("hs", CH.hs), ("ihs", CH.ihs), ("dt", CH.dt), ("db", CH.db),
    ("tri", CH.tri), ("flag", CH.flag), ("cup", CH.cup),
    ("wedge", CH.wedge), ("diamond", CH.diamond), ("chan", CH.chan),
]
for i in range(60):
    pname, pfn = _patterns[i % len(_patterns)]
    variant = i // len(_patterns)
    S.REGISTRY[f"{196+i:03d}_chart_{pname}_w{3+2*variant}"] = _chart_make(pfn, variant)

# ──────────────────────────────────────────────────────────────
# E. PRICE ACTION — 60 strategies
# ──────────────────────────────────────────────────────────────
def _pa_make(fn):
    return fn

@S.add("256_pa_sr_bounce")
def p256(df):
    lo, hi = PA.sr(df)
    return _sig(df['close']<lo*1.01, df['close']>hi*0.99)

@S.add("257_pa_bos")
def p257(df):
    b, s = PA.bos(df)
    return _sig(b, s)

@S.add("258_pa_choch")
def p258(df):
    b = PA.bos(df)[0].rolling(3).sum()>=2
    s = PA.bos(df)[1].rolling(3).sum()>=2
    return _sig(b, s)

@S.add("259_pa_fvg")
def p259(df):
    fb, fs = PA.fvg(df)
    return _sig(fb, fs)

@S.add("260_pa_ob")
def p260(df):
    bull, bear = PA.order_blocks(df)
    return _sig(bull, bear)

@S.add("261_pa_sweep")
def p261(df):
    sl, sh = PA.sweep(df)
    return _sig(sl, sh)

@S.add("262_pa_pinbar")
def p262(df):
    sc = C.scan(df)
    return _sig(sc['hammer'], sc['star'])

@S.add("263_pa_engulf")
def p263(df):
    sc = C.scan(df)
    return _sig(sc['bull_engulf'], sc['bear_engulf'])

@S.add("264_pa_inside")
def p264(df):
    sc = C.scan(df)
    return _sig(sc['inside'], None)

@S.add("265_pa_trendline")
def p265(df):
    bull, bear = PA.trendline(df)
    return _sig(bull, bear)

# Five distinct confirmation horizons (2–6 bars) for each of the 10 PA rules.
def _pa_confirm(fn, bars):
    def strat(df):
        raw = pd.Series(fn(df), index=df.index).fillna(0).astype(int)
        bull = raw.eq(1).rolling(bars, min_periods=bars).sum().eq(bars)
        bear = raw.eq(-1).rolling(bars, min_periods=bars).sum().eq(bars)
        return _sig(bull, bear)
    return strat

_pa_variations = [
    p256, p257, p258, p259, p260, p261, p262, p263, p264, p265,
]
for i in range(50):
    fn = _pa_variations[i % 10]
    bars = 2 + (i // 10)
    S.REGISTRY[f"{266+i:03d}_pa_confirm_{bars}bar_{i%10}"] = _pa_confirm(fn, bars)

# ──────────────────────────────────────────────────────────────
# F. HYBRID — 20 strategies
# ──────────────────────────────────────────────────────────────
@S.add("316_hybrid_mtf")
def h316(df):
    e1 = I.ema(df['close'], 20); e2 = I.ema(df['close'], 50); r = I.rsi(df['close'])
    return _sig((e1>e2)&(r>50), (e1<e2)&(r<50))

@S.add("317_hybrid_pa_rsi")
def h317(df):
    b, s = PA.bos(df); r = I.rsi(df['close'])
    return _sig(b&(r>50), s&(r<50))

@S.add("318_hybrid_pa_macd")
def h318(df):
    b, s = PA.bos(df); m, sg, _ = I.macd(df['close'])
    return _sig(b&(m>sg), s&(m<sg))

@S.add("319_hybrid_candle_ema")
def h319(df):
    sc = C.scan(df); e = I.ema(df['close'], 50)
    return _sig(sc['bull_engulf']&(df['close']>e), sc['bear_engulf']&(df['close']<e))

@S.add("320_hybrid_sweep_rsi")
def h320(df):
    sl, sh = PA.sweep(df); r = I.rsi(df['close'])
    return _sig(sl&(r<40), sh&(r>60))

@S.add("321_hybrid_fvg_macd")
def h321(df):
    fb, fs = PA.fvg(df); m, sg, _ = I.macd(df['close'])
    return _sig(fb&(m>sg), fs&(m<sg))

@S.add("322_hybrid_ob_ema")
def h322(df):
    bull, bear = PA.order_blocks(df); e = I.ema(df['close'], 50)
    return _sig(bull&(df['close']>e), bear&(df['close']<e))

@S.add("323_hybrid_pa_adx")
def h323(df):
    b, s = PA.bos(df); a, _, _ = I.adx(df)
    return _sig(b&(a>25), s&(a>25))

@S.add("324_hybrid_sr_rsi")
def h324(df):
    lo, hi = PA.sr(df); r = I.rsi(df['close'])
    return _sig((df['close']<lo*1.01)&(r<40), (df['close']>hi*0.99)&(r>60))

@S.add("325_hybrid_candle_bb")
def h325(df):
    sc = C.scan(df); u, _, l = I.bb(df['close'])
    return _sig((sc['hammer']|sc['bull_engulf'])&(df['close']<l), (sc['star']|sc['bear_engulf'])&(df['close']>u))

@S.add("326_hybrid_supertrend_pa")
def h326(df):
    _, t = I.supertrend(df); b, s = PA.bos(df)
    return _sig((t==1)&b, (t==-1)&s)

@S.add("327_hybrid_ichi_pa")
def h327(df):
    _, _, sa, sb = I.ichimoku(df); b, s = PA.bos(df)
    return _sig(b&(df['close']>np.maximum(sa,sb)), s&(df['close']<np.minimum(sa,sb)))

@S.add("328_hybrid_vwap_pa")
def h328(df):
    v = I.vwap(df); b, s = PA.bos(df)
    return _sig(b&(df['close']>v), s&(df['close']<v))

@S.add("329_hybrid_ema_mfi_pa")
def h329(df):
    e = I.ema(df['close'], 50); m = I.mfi(df); b, s = PA.bos(df)
    return _sig(b&(df['close']>e)&(m<40), s&(df['close']<e)&(m>60))

@S.add("330_hybrid_vol_pa")
def h330(df):
    v = df['volume']>df['volume'].rolling(20).mean(); b, s = PA.bos(df)
    return _sig(b&v, s&v)

@S.add("331_hybrid_bb_pa")
def h331(df):
    u, _, l = I.bb(df['close']); b, s = PA.bos(df)
    return _sig(b&(df['close']<u), s&(df['close']>l))

@S.add("332_hybrid_atr_pa")
def h332(df):
    a = I.atr(df); av = a>a.rolling(20).mean(); b, s = PA.bos(df)
    return _sig(b&av, s&av)

@S.add("333_hybrid_stoch_pa")
def h333(df):
    k, d = I.stoch(df); b, s = PA.bos(df)
    return _sig(b&(k>d), s&(k<d))

@S.add("334_hybrid_williams_pa")
def h334(df):
    w = I.williams(df); b, s = PA.bos(df)
    return _sig(b&(w<-40), s&(w>-60))

@S.add("335_hybrid_master")
def h335(df):
    r = I.rsi(df['close']); m, sg, _ = I.macd(df['close'])
    a, _, _ = I.adx(df); b, s = PA.bos(df); e = I.ema(df['close'], 50)
    return _sig(b&(r>50)&(m>sg)&(a>25)&(df['close']>e),
                s&(r<50)&(m<sg)&(a>25)&(df['close']<e))

# ══════════════════════════════════════════════════════════════
# REGISTRY COUNT = 335 (chart and PA entries use distinct parameter/confirmation variants)
# ══════════════════════════════════════════════════════════════
assert len(S.REGISTRY) >= 335, f"Only {len(S.REGISTRY)} strategies — need 335"
# If we overshot, keep first 335 (rare)
if len(S.REGISTRY) > 335:
    keep = list(S.REGISTRY.keys())[:335]
    S.REGISTRY = {k: S.REGISTRY[k] for k in keep}

# ══════════════════════════════════════════════════════════════
# BACKTESTER
# ══════════════════════════════════════════════════════════════
class BT:
    def __init__(self, df, signals, cfg=None, capital=10000):
        required = {'open', 'high', 'low', 'close', 'volume'}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f"Missing OHLCV columns: {sorted(missing)}")
        if capital <= 0:
            raise ValueError("capital must be greater than zero")
        self.df = df.reset_index(drop=True).copy()
        for col in required:
            self.df[col] = pd.to_numeric(self.df[col], errors='coerce')
        if self.df[list(required)].isna().any().any():
            raise ValueError("OHLCV data contains missing or non-numeric values")
        if (self.df['high'] < self.df[['open','close','low']].max(axis=1)).any():
            raise ValueError("Invalid OHLC data: high is below another candle price")
        if (self.df['low'] > self.df[['open','close','high']].min(axis=1)).any():
            raise ValueError("Invalid OHLC data: low is above another candle price")
        self.sig = pd.Series(signals).reset_index(drop=True).fillna(0).astype(int)
        if len(self.sig) != len(self.df):
            raise ValueError("signals length must match dataframe length")
        if not self.sig.isin([-1, 0, 1]).all():
            raise ValueError("signals must contain only -1, 0, or 1")
        self.cfg = cfg or RiskConfig()
        if not (0 < self.cfg.risk_per_trade <= 0.05):
            raise ValueError("risk_per_trade must be > 0 and <= 5%")
        if self.cfg.atr_sl_mult <= 0 or self.cfg.atr_tp_mult <= 0:
            raise ValueError("ATR stop/target multipliers must be positive")
        if not (0 < self.cfg.max_drawdown <= 1):
            raise ValueError("max_drawdown must be in (0, 1]")
        if self.cfg.spread < 0 or self.cfg.commission_per_lot < 0:
            raise ValueError("spread and commission cannot be negative")
        if (self.cfg.contract_size <= 0 or self.cfg.quote_to_account_rate <= 0
                or self.cfg.bars_per_day <= 0):
            raise ValueError("contract_size, quote_to_account_rate and bars_per_day must be positive")
        self.cap = float(capital)
        self.init = float(capital)
        self.peak = float(capital)
        self.trades = []
        self.equity = [float(capital)]
        self.total_costs = 0.0

    def run(self):
        if len(self.df) < 2:
            return {'final': round(self.cap, 2), 'return%': 0.0, 'trades': 0,
                    'win_rate%': 0.0, 'profit_factor': 0.0, 'max_drawdown%': 0.0,
                    'total_costs': 0.0}
        atr = I.atr(self.df)
        pos = 0
        entry = sl = tp = lots = 0.0
        entry_i = None
        peak_equity = self.cap
        max_dd = 0.0

        def close_trade(exit_price, bar_i, reason):
            nonlocal pos, entry, lots, entry_i
            gross = ((exit_price-entry)*lots*self.cfg.contract_size
                     *self.cfg.quote_to_account_rate*pos)
            held_bars = max(0, bar_i-entry_i)
            held_days = held_bars/self.cfg.bars_per_day
            # Full quoted spread is paid once on a completed round trip.
            spread_cost = (self.cfg.spread*lots*self.cfg.contract_size
                           *self.cfg.quote_to_account_rate)
            commission_cost = 2*self.cfg.commission_per_lot*lots
            swap_credit = self.cfg.swap_per_lot_per_day*lots*held_days
            costs = spread_cost + commission_cost - swap_credit
            net = gross-costs
            self.cap += net
            self.total_costs += costs
            self.peak = max(self.peak, self.cap)
            self.trades.append({
                'entry': round(entry, 8), 'exit': round(exit_price, 8),
                'side': pos, 'lots': round(lots, 8),
                'entry_bar': entry_i, 'exit_bar': bar_i,
                'gross_pnl': round(gross, 2), 'costs': round(costs, 2),
                'pnl': round(net, 2), 'reason': reason
            })
            pos = 0
            return net

        for i in range(1, len(self.df)):
            signal = int(self.sig.iloc[i-1])  # only prior closed candle is actionable
            o, h, l, c = (float(self.df[k].iloc[i]) for k in ('open','high','low','close'))
            av = float(atr.iloc[i-1]) if pd.notna(atr.iloc[i-1]) else 0.0

            if pos:
                stop_hit = (pos == 1 and l <= sl) or (pos == -1 and h >= sl)
                target_hit = (pos == 1 and h >= tp) or (pos == -1 and l <= tp)
                reverse = signal == -pos
                if (pos == 1 and o <= sl) or (pos == -1 and o >= sl):
                    close_trade(o, i, 'stop_gap')
                elif (pos == 1 and o >= tp) or (pos == -1 and o <= tp):
                    close_trade(o, i, 'target_gap')
                elif stop_hit:  # conservative if stop and target both occur
                    close_trade(sl, i, 'stop')
                elif target_hit:
                    close_trade(tp, i, 'target')
                elif reverse:
                    close_trade(o, i, 'reverse')
                elif self.cfg.trailing and av > 0:
                    if pos == 1:
                        sl = max(sl, h-self.cfg.atr_sl_mult*av)
                    else:
                        sl = min(sl, l+self.cfg.atr_sl_mult*av)

            if pos == 0 and signal and av > 0 and self.cap > 0:
                dd = (self.peak-self.cap)/self.peak if self.peak else 1
                if dd < self.cfg.max_drawdown:
                    stop_distance = self.cfg.atr_sl_mult*av
                    risk_cash = self.cap*self.cfg.risk_per_trade
                    # Size is in lots. Include estimated round-trip costs in sizing.
                    per_lot_risk = ((stop_distance+self.cfg.spread)*self.cfg.contract_size
                            *self.cfg.quote_to_account_rate + 2*self.cfg.commission_per_lot)
                    if per_lot_risk <= 0:
                        continue
                    lots = risk_cash/per_lot_risk
                    pos = signal
                    entry = o
                    sl = entry-pos*stop_distance
                    tp = entry+pos*self.cfg.atr_tp_mult*av
                    entry_i = i
                    same_bar_stop = (pos == 1 and l <= sl) or (pos == -1 and h >= sl)
                    same_bar_target = (pos == 1 and h >= tp) or (pos == -1 and l <= tp)
                    if same_bar_stop:  # stop takes priority if both levels trade
                        close_trade(sl, i, 'stop')
                    elif same_bar_target:
                        close_trade(tp, i, 'target')

            unrealized = ((c-entry)*lots*self.cfg.contract_size
                           *self.cfg.quote_to_account_rate*pos) if pos else 0.0
            equity_now = self.cap+unrealized
            peak_equity = max(peak_equity, equity_now)
            if peak_equity > 0:
                max_dd = max(max_dd, (peak_equity-equity_now)/peak_equity)
            self.equity.append(equity_now)

        if pos:
            close_trade(float(self.df['close'].iloc[-1]), len(self.df)-1, 'end_of_test')
            self.equity[-1] = self.cap

        wins = [t for t in self.trades if t['pnl'] > 0]
        gross_profit = sum(t['pnl'] for t in wins)
        gross_loss = abs(sum(t['pnl'] for t in self.trades if t['pnl'] <= 0))
        profit_factor = (gross_profit/gross_loss if gross_loss else
                         (float('inf') if gross_profit else 0.0))
        return {
            'initial': round(self.init, 2), 'final': round(self.cap, 2),
            'return%': round((self.cap/self.init-1)*100, 2),
            'trades': len(self.trades),
            'win_rate%': round(len(wins)/len(self.trades)*100, 2) if self.trades else 0.0,
            'profit_factor': round(profit_factor, 2) if np.isfinite(profit_factor) else 'inf',
            'max_drawdown%': round(max_dd*100, 2),
            'total_costs': round(self.total_costs, 2),
            'cost_model': {'spread': self.cfg.spread,
                           'commission_per_lot_per_side': self.cfg.commission_per_lot,
                           'swap_per_lot_per_day': self.cfg.swap_per_lot_per_day,
                           'contract_size': self.cfg.contract_size,
                           'quote_to_account_rate': self.cfg.quote_to_account_rate,
                           'bars_per_day': self.cfg.bars_per_day}
        }

# ══════════════════════════════════════════════════════════════
# PARALLEL RUN ALL 335
# ══════════════════════════════════════════════════════════════
def run_all(df, capital=10000, workers=8):
    if workers < 1:
        raise ValueError("workers must be at least 1")
    if capital <= 0:
        raise ValueError("capital must be greater than zero")
    results = {}
    def _run(item):
        name, fn = item
        try:
            return name, BT(df, fn(df), capital=capital).run()
        except Exception as e:
            return name, {'error': str(e)}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for f in as_completed([ex.submit(_run, it) for it in S.REGISTRY.items()]):
            n, r = f.result()
            results[n] = r
    return results


# ══════════════════════════════════════════════════════════════
# LIVE 335-STRATEGY CONSENSUS
# ══════════════════════════════════════════════════════════════
def evaluate_live(df):
    """Evaluate all registered strategy variants on the latest closed candle.

    The 335 entries are grouped into six strategy families. A family casts
    one directional vote only when at least two variants are active and at
    least 55% of its directional votes agree. Overall direction needs at
    least three agreeing families and >=60% agreement among active families.
    This is a group-agreement filter, not a probability or win-rate estimate.
    """
    required = {"open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError("Missing OHLCV columns: " + ", ".join(sorted(missing)))
    if len(df) < 60:
        raise ValueError("At least 60 closed candles are required")

    groups = {
        "single": {"label": "Single indicators", "start": 1, "end": 30},
        "double": {"label": "Two-factor combinations", "start": 31, "end": 95},
        "triple": {"label": "Three-factor combinations", "start": 96, "end": 195},
        "chart": {"label": "Chart patterns", "start": 196, "end": 255},
        "price_action": {"label": "Price action", "start": 256, "end": 315},
        "hybrid": {"label": "Hybrid strategies", "start": 316, "end": 335},
    }
    stats = {
        key: {"label": item["label"], "buy": 0, "sell": 0, "neutral": 0,
              "direction": "WAIT", "active": 0}
        for key, item in groups.items()
    }
    buy_names, sell_names, errors = [], [], []

    for name, fn in S.REGISTRY.items():
        try:
            number = int(str(name).split("_", 1)[0])
            group_key = next(
                key for key, item in groups.items()
                if item["start"] <= number <= item["end"]
            )
            output = fn(df)
            values = np.asarray(output)
            latest = values.item() if values.ndim == 0 else values[-1]
            vote = 0 if pd.isna(latest) else int(np.sign(float(latest)))
            if vote not in (-1, 0, 1):
                vote = 0
            bucket = stats[group_key]
            if vote > 0:
                bucket["buy"] += 1
                buy_names.append(name)
            elif vote < 0:
                bucket["sell"] += 1
                sell_names.append(name)
            else:
                bucket["neutral"] += 1
        except Exception as exc:
            errors.append({"strategy": name, "error": str(exc)[:180]})

    active_groups = []
    for bucket in stats.values():
        directional = bucket["buy"] + bucket["sell"]
        bucket["active"] = directional
        if directional >= 2:
            buy_share = bucket["buy"] / directional
            sell_share = bucket["sell"] / directional
            if buy_share >= 0.55:
                bucket["direction"] = "BUY"
                active_groups.append("BUY")
            elif sell_share >= 0.55:
                bucket["direction"] = "SELL"
                active_groups.append("SELL")

    buy_groups = active_groups.count("BUY")
    sell_groups = active_groups.count("SELL")
    active_count = len(active_groups)
    agreement = (max(buy_groups, sell_groups) / active_count * 100) if active_count else 0.0
    direction = "WAIT"
    if buy_groups >= 3 and buy_groups / active_count >= 0.60:
        direction = "BUY"
    elif sell_groups >= 3 and sell_groups / active_count >= 0.60:
        direction = "SELL"

    return {
        "strategyCount": len(S.REGISTRY),
        "evaluated": len(S.REGISTRY) - len(errors),
        "errorCount": len(errors),
        "errors": errors[:5],
        "direction": direction,
        "agreementPct": round(agreement, 1),
        "buyGroups": buy_groups,
        "sellGroups": sell_groups,
        "activeGroups": active_count,
        "buyVotes": len(buy_names),
        "sellVotes": len(sell_names),
        "groupVotes": stats,
        "buyStrategies": buy_names[:10],
        "sellStrategies": sell_names[:10],
        "interpretation": "Group agreement only; not a win probability or guaranteed trade outcome."
    }

# ══════════════════════════════════════════════════════════════
# VERCEL HANDLER
# ══════════════════════════════════════════════════════════════
try:
    from http.server import BaseHTTPRequestHandler
    from urllib.parse import urlparse, parse_qs

    class handler(BaseHTTPRequestHandler):
        def do_GET(self):
            try:
                q = parse_qs(urlparse(self.path).query)
                mode = q.get('mode', ['all'])[0]
                sym = q.get('symbol', ['BTC-USD'])[0]
                intr = q.get('interval', ['1h'])[0]
                per = q.get('period', ['3mo'])[0]
                strat = q.get('strategy', [None])[0]

                df = Data.yahoo(sym, intr, per)
                if df.empty:
                    return self._send(400, {'error': 'no data'})

                if mode == 'list':
                    return self._send(200, {'count': len(S.REGISTRY),
                                            'strategies': list(S.REGISTRY.keys())})
                if mode == 'one' and strat in S.REGISTRY:
                    return self._send(200, BT(df, S.REGISTRY[strat](df)).run())
                if mode == 'all':
                    return self._send(200, run_all(df))
                return self._send(400, {'error': 'unknown mode'})
            except Exception as e:
                self._send(500, {'error': str(e)})

        def _send(self, code, obj):
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(obj, default=str).encode())
except ImportError:
    pass

# ══════════════════════════════════════════════════════════════
# LOCAL TEST
# ══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    df = Data.synthetic(500)
    print(f"Strategies loaded: {len(S.REGISTRY)}")
    results = run_all(df)
    ok = [(k, v) for k, v in results.items() if 'error' not in v]
    ok.sort(key=lambda x: x[1].get('return%', -999), reverse=True)
    print(f"Valid results: {len(ok)}")
    print("\nTOP 10:")
    for name, r in ok[:10]:
        print(f"  {name}: {r['return%']}% | {r['trades']} trades | WR {r['win_rate%']}%")