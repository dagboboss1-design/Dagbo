"use client";
import "../feature.css";
import {useCallback,useEffect,useState} from "react";
type Trade={id:string;pair:string;side:string;entry:number;sl:number;tp:number;opened:string;status:string;exitPrice?:number;closedAt?:string};
const key="dagbo_signal_journal_v1";
const pairs=["XAUUSD","EURUSD","GBPUSD","GBPJPY","USDJPY","AUDUSD","USDCHF","US30","US100","US500","BTCUSD","ETHUSD"];
export default function JournalPage(){
 const [trades,setTrades]=useState<Trade[]>([]),[pair,setPair]=useState("XAUUSD"),[side,setSide]=useState("BUY"),[entry,setEntry]=useState(""),[sl,setSl]=useState(""),[tp,setTp]=useState(""),[ready,setReady]=useState(false),[checking,setChecking]=useState(false),[notice,setNotice]=useState("Monitoring checks run while this page is open.");
 const save=useCallback((next:Trade[])=>{setTrades(next);localStorage.setItem(key,JSON.stringify(next));},[]);
 useEffect(()=>{try{const raw=localStorage.getItem(key);if(raw)setTrades(JSON.parse(raw));}catch{}setReady(true);},[]);
 const monitor=useCallback(async()=>{
  if(!ready||checking)return;
  const open=trades.filter(t=>t.status==="OPEN");if(!open.length)return;
  setChecking(true);
  try{
   const unique=[...new Set(open.map(t=>t.pair))];
   const feeds=await Promise.all(unique.map(async p=>{try{const r=await fetch("/api/market-data?pair="+p+"&tf=1m",{cache:"no-store"});const d=await r.json();return [p,d] as const;}catch{return [p,null] as const;}}));
   const byPair=new Map(feeds);
   let changed=false;
   const next=trades.map(t=>{
    if(t.status!=="OPEN")return t;
    const d=byPair.get(t.pair);if(!d?.ok||d.stale||!Array.isArray(d.candles)||!d.candles.length)return t;
    const c=d.candles.at(-1);if(!c||![c.high,c.low,c.close].every(Number.isFinite))return t;
    const slHit=t.side==="BUY"?c.low<=t.sl:c.high>=t.sl;
    const tpHit=t.side==="BUY"?c.high>=t.tp:c.low<=t.tp;
    if(slHit&&tpHit){changed=true;return {...t,status:"REVIEW",exitPrice:c.close,closedAt:new Date().toISOString()};}
    if(slHit){changed=true;return {...t,status:"SL HIT",exitPrice:t.sl,closedAt:new Date().toISOString()};}
    if(tpHit){changed=true;return {...t,status:"TP HIT",exitPrice:t.tp,closedAt:new Date().toISOString()};}
    return t;
   });
   if(changed){save(next);setNotice("A trade level was reached. Review the updated trade status and candle.");}
   else setNotice("Latest available candle checked. Open trades remain active.");
  }catch{setNotice("Market feed unavailable. No trade status was changed.");}
  finally{setChecking(false);}
 },[ready,checking,trades,save]);
 useEffect(()=>{if(!ready)return;const timer=window.setInterval(()=>{void monitor();},60000);return()=>window.clearInterval(timer);},[ready,monitor]);
 function add(){const e=Number(entry),s=Number(sl),t=Number(tp);if(![e,s,t].every(Number.isFinite)||e<=0||s<=0||t<=0)return;const valid=side==="BUY"?s<e&&t>e:s>e&&t<e;if(!valid)return;save([{id:crypto.randomUUID(),pair,side,entry:e,sl:s,tp:t,opened:new Date().toISOString(),status:"OPEN"},...trades]);setEntry("");setSl("");setTp("");}
 function close(id:string){save(trades.map(t=>t.id===id?{...t,status:"CLOSED",closedAt:new Date().toISOString()}:t));}
 const statusColor=(s:string)=>s==="TP HIT"?"#e5e5e5":s==="SL HIT"?"#888":s==="OPEN"?"#d0d0d0":"#999";
 return <main className="feature-shell"><a className="back" href="/">← DAGBO SIGNAL</a><div className="eyebrow">TRADE RECORDS / JOURNAL</div><h1>Trade <em>journal</em></h1><p className="lead">Save planned or executed trades and monitor their stop and target levels against the latest available one-minute candles while this journal is open. This is not broker sync or guaranteed background monitoring.</p>
 <section className="feature-panel"><h2>Record a trade</h2><label>Instrument<select value={pair} onChange={e=>setPair(e.target.value)}>{pairs.map(p=><option key={p}>{p}</option>)}</select></label><label>Direction<select value={side} onChange={e=>setSide(e.target.value)}><option>BUY</option><option>SELL</option></select></label>{[[entry,setEntry,"Entry price"],[sl,setSl,"Stop loss"],[tp,setTp,"Take profit"]].map(([v,set,l]:any)=><label key={l}>{l}<input value={v} onChange={e=>set(e.target.value)} type="number" step="any" style={{background:"#080808",color:"#eee",border:"1px solid #333",borderRadius:8,padding:13}} /></label>)}<button onClick={add} disabled={!ready}>Save trade</button><p className="fine">Entry, SL and TP must be valid for the selected direction.</p></section>
 <section className="feature-panel"><div className="row-between"><h2>Trade history</h2><span className="fine">{trades.length} RECORDS</span></div><p className="fine">{checking?"Checking market candles…":notice}</p>{trades.length?trades.map(t=><article key={t.id} style={{borderTop:"1px solid #292929",padding:"15px 0"}}><div className="row-between"><b>{t.pair} · {t.side}</b><span style={{fontSize:10,color:statusColor(t.status),fontWeight:700}}>{t.status}</span></div><div className="metrics"><span>Entry<b>{t.entry}</b></span><span>SL<b>{t.sl}</b></span><span>TP<b>{t.tp}</b></span></div><p className="fine">{new Date(t.opened).toLocaleString()}{t.exitPrice!==undefined?" · Exit "+t.exitPrice:""}</p>{t.status==="OPEN"&&<button onClick={()=>close(t.id)}>Mark closed</button>}{t.status==="REVIEW"&&<p className="fine">Both SL and TP were inside the same candle range. Review the broker execution manually.</p>}</article>):<div className="empty-state">No trades recorded yet. Add a trade here or send a signal setup to your journal.</div>}</section></main>
}
