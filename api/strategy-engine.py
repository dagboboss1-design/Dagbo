from http.server import BaseHTTPRequestHandler
import json
import math

import pandas as pd
from strategy_engine import S, evaluate_live


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._send(200, {
            "service": "DAGBO 335 Strategy Engine",
            "status": "READY",
            "strategyCount": len(S.REGISTRY),
            "groups": [
                {"name": "Single indicators", "count": 30},
                {"name": "Two-factor combinations", "count": 65},
                {"name": "Three-factor combinations", "count": 100},
                {"name": "Chart patterns", "count": 60},
                {"name": "Price action", "count": 60},
                {"name": "Hybrid strategies", "count": 20}
            ]
        })

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

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
