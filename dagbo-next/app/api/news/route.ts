import { NextResponse } from "next/server";
export const dynamic="force-dynamic";
export async function GET(){
 const key=process.env.FMP_API_KEY;
 if(!key)return NextResponse.json({ok:false,events:[],error:"Economic calendar provider is not configured. No events are fabricated."},{status:503});
 try{
  const from=new Date().toISOString().slice(0,10);const end=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  const url=new URL("https://financialmodelingprep.com/stable/economic-calendar");url.searchParams.set("from",from);url.searchParams.set("to",end);url.searchParams.set("apikey",key);
  const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(10000)});if(!r.ok)return NextResponse.json({ok:false,events:[],error:"Economic calendar provider request failed."},{status:502});
  const data=await r.json();if(!Array.isArray(data))return NextResponse.json({ok:false,events:[],error:"Provider returned an invalid calendar response."},{status:502});
  const events=data.map((x:any)=>({date:x.date||x.datetime,country:x.country,event:x.event,impact:x.impact,actual:x.actual,estimate:x.estimate,previous:x.previous})).filter((x:any)=>x.event);
  return NextResponse.json({ok:true,source:"Financial Modeling Prep",events},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({ok:false,events:[],error:"Economic calendar timed out."},{status:502});}
}