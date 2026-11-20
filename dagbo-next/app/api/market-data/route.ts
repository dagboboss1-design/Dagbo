import { NextRequest, NextResponse } from "next/server";

const ALLOWED = new Set(["EUR/USD","GBP/USD","USD/JPY","GBP/JPY","AUD/USD","USD/CHF","XAU/USD"]);
const INTERVALS: Record<string,string> = {"5m":"5min","15m":"15min","1h":"1h","4h":"4h","1d":"1day"};
export async function GET(request: NextRequest) {
  const pair = (request.nextUrl.searchParams.get("pair") || "EURUSD").toUpperCase().replace("_","/").replace("-","/");
  const tf = request.nextUrl.searchParams.get("tf") || "15m";
  const symbol = pair.includes("/") ? pair : pair === "XAUUSD" ? "XAU/USD" : pair.length === 6 ? `${pair.slice(0,3)}/${pair.slice(3)}` : pair;
  const interval = INTERVALS[tf];
  if (!ALLOWED.has(symbol) || !interval) return NextResponse.json({ok:false,error:"Unsupported pair or timeframe",source:null}, {status:400});
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) return NextResponse.json({ok:false,error:"Market data provider is not configured. No simulated prices are returned.",source:null}, {status:503});
  try {
    const url = new URL("https://api.twelvedata.com/time_series");
    url.searchParams.set("symbol",symbol); url.searchParams.set("interval",interval); url.searchParams.set("outputsize","120"); url.searchParams.set("timezone","UTC"); url.searchParams.set("apikey",key);
    const response = await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(12000)});
    const payload = await response.json();
    if (!response.ok || payload.status === "error" || !Array.isArray(payload.values)) return NextResponse.json({ok:false,error:payload.message || "Market provider returned no candle data",source:"Twelve Data"}, {status:502});
    const candles = payload.values.slice().reverse().map((c:Record<string,string>)=>({time:c.datetime,open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:c.volume==null?null:Number(c.volume)}));
    if (candles.some((c:{open:number;high:number;low:number;close:number})=>![c.open,c.high,c.low,c.close].every(Number.isFinite))) return NextResponse.json({ok:false,error:"Provider returned invalid candle values",source:"Twelve Data"}, {status:502});
    return NextResponse.json({ok:true,pair:symbol,timeframe:tf,source:"Twelve Data",candles,latest:candles.at(-1)?.time,receivedAt:new Date().toISOString()},{headers:{"Cache-Control":"no-store"}});
  } catch {
    return NextResponse.json({ok:false,error:"Market data request failed or timed out",source:"Twelve Data"},{status:502});
  }
}
