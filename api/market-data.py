from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen
import json
import math
import os

import pandas as pd
from strategy_engine import S, evaluate_live


SYMBOLS = {
    "XAUUSD": "XAU/USD", "GOLD": "XAU/USD", "XAGUSD": "XAG/USD", "SILVER": "XAG/USD",
    "EURUSD": "EUR/USD", "GBPUSD": "GBP/USD", "USDJPY": "USD/JPY", "GBPJPY": "GBP/JPY",
    "AUDUSD": "AUD/USD", "USDCHF": "USD/CHF", "USDCAD": "USD/CAD", "NZDUSD": "NZD/USD",
    "EURJPY": "EUR/JPY", "EURGBP": "EUR/GBP",
    "US30": "DJI", "US100": "NDX", "NAS100": "NDX", "US500": "SPX"
}
BINANCE_SYMBOLS = {
    "BTC": "BTCUSDT", "BTCUSD": "BTCUSDT", "BTCUSDT": "BTCUSDT",
    "ETH": "ETHUSDT", "ETHUSD": "ETHUSDT", "ETHUSDT": "ETHUSDT"
}
COINBASE_PRODUCTS = {
    "BTC": "BTC-USD", "BTCUSD": "BTC-USD", "BTCUSDT": "BTC-USD",
    "ETH": "ETH-USD", "ETHUSD": "ETH-USD", "ETHUSDT": "ETH-USD"
}


def fetch_json(url, headers=None, timeout=12):
    request = Request(url, headers=headers or {"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:240]
        except Exception:
            pass
        raise RuntimeError("Market provider HTTP " + str(exc.code) + (": " + detail if detail else ""))
    except URLError as exc:
        raise RuntimeError("Market provider connection failed: " + str(exc.reason))
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError("Market provider returned invalid JSON")


def binance_candles(pair, timeframe):
    symbol = BINANCE_SYMBOLS[pair]
    url = (
        "https://data-api.binance.vision/api/v3/klines?symbol=" + quote(symbol) +
        "&interval=" + timeframe + "m&limit=250"
    )
    rows = fetch_json(url)
    if not isinstance(rows, list) or len(rows) < 30:
        raise RuntimeError("Binance returned fewer than 30 candles")
    values = []
    for row in rows:
        values.append({
            "datetime": datetime.fromtimestamp(int(row[0]) / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "open": str(row[1]), "high": str(row[2]), "low": str(row[3]),
            "close": str(row[4]), "volume": str(row[5])
        })
    return {
        "pair": pair, "symbol": symbol, "timeframe": timeframe,
        "provider": "Binance Spot · Public Market Data", "providerExchange": "Binance",
        "values": values
    }


def coinbase_candles(pair, timeframe):
    product = COINBASE_PRODUCTS[pair]
    granularity = int(timeframe) * 60
    url = "https://api.exchange.coinbase.com/products/" + quote(product, safe="") + "/candles?granularity=" + str(granularity)
    rows = fetch_json(url, headers={"Accept": "application/json", "User-Agent": "DAGBO-SIGNAL/1.0"})
    if not isinstance(rows, list) or len(rows) < 30:
        raise RuntimeError("Coinbase returned fewer than 30 candles")
    values = []
    for row in reversed(rows[:250]):
        values.append({
            "datetime": datetime.fromtimestamp(int(row[0]), timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "low": str(row[1]), "high": str(row[2]), "open": str(row[3]),
            "close": str(row[4]), "volume": str(row[5])
        })
    return {
        "pair": pair, "symbol": product, "timeframe": timeframe,
        "provider": "Coinbase Exchange · Public Market Data", "providerExchange": "Coinbase",
        "values": values
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        if params.get("health") == ["1"]:
            return self._send(200, {
                "service": "DAGBO market data + 335 strategy engine",
                "status": "READY", "strategyCount": len(S.REGISTRY)
            })

        raw_pair = str(params.get("pair", [""])[0]).upper().strip()
        pair = "".join(ch for ch in raw_pair if ch.isalnum())
        timeframe = str(params.get("tf", ["15"])[0]).strip()
        if timeframe not in ("5", "15"):
            return self._send(400, {"error": "Timeframe must be 5 or 15 minutes"})

        if pair in BINANCE_SYMBOLS:
            try:
                result = binance_candles(pair, timeframe)
                return self._send(200, result, "s-maxage=15, stale-while-revalidate=30")
            except Exception as primary_error:
                try:
                    result = coinbase_candles(pair, timeframe)
                    return self._send(200, result, "s-maxage=15, stale-while-revalidate=30")
                except Exception as backup_error:
                    return self._send(502, {
                        "error": "Binance and Coinbase market candles are temporarily unavailable.",
                        "providers": ["Binance", "Coinbase"],
                        "detail": str(backup_error)[:180]
                    })

        symbol = SYMBOLS.get(pair)
        if not symbol:
            return self._send(400, {"error": "Unsupported market pair"})
        api_key = os.environ.get("TWELVE_DATA_API_KEY")
        if not api_key:
            return self._send(503, {"error": "Market data is not configured. Add TWELVE_DATA_API_KEY in Vercel."})

        url = (
            "https://api.twelvedata.com/time_series?symbol=" + quote(symbol, safe="") +
            "&interval=" + timeframe + "min&outputsize=250&timezone=UTC&apikey=" + quote(api_key, safe="")
        )
        try:
            data = fetch_json(url)
            if not isinstance(data, dict) or data.get("status") == "error" or not isinstance(data.get("values"), list):
                message = data.get("message", "Market data provider did not return candles") if isinstance(data, dict) else "Invalid market data response"
                return self._send(502, {"error": message, "provider": "Twelve Data"})
            if len(data["values"]) < 30:
                return self._send(502, {"error": "Twelve Data returned fewer than 30 candles", "provider": "Twelve Data"})
            meta = data.get("meta") or {}
            return self._send(200, {
                "pair": pair, "timeframe": timeframe, "provider": "Twelve Data",
                "providerExchange": meta.get("exchange"), "values": data["values"]
            }, "s-maxage=30, stale-while-revalidate=60")
        except Exception as exc:
            return self._send(502, {"error": "Could not retrieve market candles", "detail": str(exc)[:180]})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 500000:
                return self._send(413, {"error": "Request body must be between 1 byte and 500 KB."})
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            pair = str(payload.get("pair", "")).strip().upper()
            timeframe = str(payload.get("timeframe", "")).strip()
            candles = payload.get("candles")

            if not pair or len(pair) > 16 or not pair.isalnum():
                return self._send(400, {"error": "A valid market pair is required."})
            if timeframe not in ("5", "15"):
                return self._send(400, {"error": "Timeframe must be 5 or 15 minutes."})
            if not isinstance(candles, list) or not 60 <= len(candles) <= 250:
                return self._send(400, {"error": "Provide 60 to 250 closed candles."})

            rows = []
            for index, candle in enumerate(candles):
                if not isinstance(candle, dict):
                    return self._send(400, {"error": "Invalid candle at index " + str(index)})
                try:
                    row = {
                        key: float(candle.get(key, 0 if key == "volume" else "nan"))
                        for key in ("open", "high", "low", "close", "volume")
                    }
                except (TypeError, ValueError):
                    return self._send(400, {"error": "Non-numeric candle at index " + str(index)})
                if not all(math.isfinite(value) for value in row.values()):
                    return self._send(400, {"error": "Non-finite candle value at index " + str(index)})
                if (row["open"] <= 0 or row["close"] <= 0 or row["low"] <= 0 or
                    row["high"] < max(row["open"], row["close"]) or
                    row["low"] > min(row["open"], row["close"]) or
                    row["high"] < row["low"] or row["volume"] < 0):
                    return self._send(400, {"error": "Invalid OHLCV relationship at index " + str(index)})
                rows.append(row)

            result = evaluate_live(pd.DataFrame(rows))
            result.update({"pair": pair, "timeframe": timeframe})
            if result["errorCount"]:
                result["direction"] = "WAIT"
                result["status"] = "DEGRADED"
            else:
                result["status"] = "READY"
            return self._send(200, result)
        except Exception as exc:
            return self._send(500, {"error": "Strategy evaluation failed.", "detail": str(exc)[:240]})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.end_headers()

    def _send(self, code, payload, cache_control=None):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", cache_control or "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
