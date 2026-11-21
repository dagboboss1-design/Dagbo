import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
type Candle={open:number;high:number;low:number;close:number;time:string};
function trend(c:Candle[]){if(c.length<30)return "INSUFFICIENT DATA";const closes=c.map(x=>x.close);const avg=(n:number)=>closes.slice(-n).reduce((a,b)=>a+b,0)/n;const fast=avg(9),slow=avg(26),last=closes.at(-1)!;if(fast>slow&&last>fast)return "BULLISH";if(fast<slow&&last<fast)return "BEARISH";return "SIDEWAYS";}
export async function GET(req:NextRequest){
 const pair=(req.nextUrl.searchParams.get("pair")||"XAUUSD").toUpperCase();const exposure=(req.nextUrl.searchParams.get("exposure")||"BUY").toUpperCase();
 if(!["XAUUSD","EURUSD","GBPUSD","GBPJPY","USDJPY","AUDUSD","USDCHF"].includes(pair)||!["BUY","SELL"].includes(exposure))return NextResponse.json({ok:false,status:"NO DECISION",reason:"Unsupported instrument or exposure."},{status:400});
 try{
  const origin=req.nextUrl.origin;
  const [one,four]=await Promise.all(["1h","4h"].map(async tf=>{const r=await fetch(`${origin}/api/market-data?pair=${pair}&tf=${tf}`,{cache:"no-store"});return r.json();}));
  if(!one.ok||!four.ok)return NextResponse.json({ok:false,status:"NO DECISION",reason:one.error||four.error||"Live candles unavailable. No hedge view generated."},{status:503});
  const t1=trend(one.candles as Candle[]),t4=trend(four.candles as Candle[]);
  if(t1==="INSUFFICIENT DATA"||t4==="INSUFFICIENT DATA")return NextResponse.json({ok:false,status:"NO DECISION",reason:"Not enough verified candles."},{status:503});
  const opposite=(exposure==="BUY"&&t1==="BEARISH"&&t4==="BEARISH")||(exposure==="SELL"&&t1==="BULLISH"&&t4==="BULLISH");
  const mixed=t1!==t4||t1==="SIDEWAYS"||t4==="SIDEWAYS";
  return NextResponse.json({ok:true,pair,exposure,trend1h:t1,trend4h:t4,status:opposite?"HEDGE REVIEW":mixed?"HOLD / REVIEW":"NO HEDGE SIGNAL",action:opposite?"Review reducing or hedging exposure; confirm structure and margin first.":mixed?"Timeframes disagree or are ranging. Avoid adding a hedge based on this scan.":"Higher-timeframe trend does not currently oppose your position.",reason:opposite?"Both 1H and 4H trend filters oppose your stated exposure.":mixed?"There is no aligned opposing trend confirmation.":"No aligned opposing trend detected.",confidence:opposite?"Two-timeframe agreement":"Not scored",warning:"This is a simple EMA trend filter, not a full correlation, order-flow or portfolio-margin model."},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({ok:false,status:"NO DECISION",reason:"Market analysis failed. No hedge recommendation issued."},{status:502});}
}