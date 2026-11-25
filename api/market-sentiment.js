const FMP_BASE = "https://financialmodelingprep.com/stable/commitment-of-traders-analysis";

// COT futures are a weekly institutional-positioning proxy, not live retail sentiment.
// Pair mapping uses the corresponding currency futures; inverse USD pairs reverse
// the futures direction. Unsupported markets are reported as unavailable.
const CONTRACTS = {
  XAUUSD: [{ symbol:"GC", sign:1, label:"COMEX Gold" }],
  GOLD: [{ symbol:"GC", sign:1, label:"COMEX Gold" }],
  EURUSD: [{ symbol:"6E", sign:1, label:"Euro FX" }],
  GBPUSD: [{ symbol:"6B", sign:1, label:"British Pound" }],
  USDJPY: [{ symbol:"6J", sign:-1, label:"Japanese Yen (inverse USD quote)" }],
  GBPJPY: [{ symbol:"6B", sign:1, label:"British Pound" }, { symbol:"6J", sign:-1, label:"Japanese Yen (inverse quote)" }],
  EURJPY: [{ symbol:"6E", sign:1, label:"Euro FX" }, { symbol:"6J", sign:-1, label:"Japanese Yen (inverse quote)" }],
  AUDUSD: [{ symbol:"6A", sign:1, label:"Australian Dollar" }],
  USDCAD: [{ symbol:"6C", sign:-1, label:"Canadian Dollar (inverse USD quote)" }],
  USDCHF: [{ symbol:"6S", sign:-1, label:"Swiss Franc (inverse USD quote)" }],
  NZDUSD: [{ symbol:"6N", sign:1, label:"New Zealand Dollar" }]
};
function isoDate(date) { return date.toISOString().slice(0,10); }
function number(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
function getNet(row) {
  const long=number(row.currentLongMarketSituation);
  const short=number(row.currentShortMarketSituation);
  if(long!==null&&short!==null) return long-short;
  const net=number(row.netPostion!==undefined?row.netPostion:row.netPosition);
  const oi=number(row.openInterestAll||row.open_interest_all);
  if(net!==null&&oi>0) return net/oi*100;
  return null;
}
async function fetchContract(symbol,key,from,to) {
  const url=FMP_BASE+"?symbol="+encodeURIComponent(symbol)+"&from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to)+"&apikey="+encodeURIComponent(key);
  const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(6500)});
  let data={};try{data=await response.json();}catch(_){}
  if(!response.ok||!Array.isArray(data)||data.Error||data["Error Message"]) {
    const detail=data&&(data["Error Message"]||data.message||data.Error);
    throw new Error(String(detail||("FMP COT "+symbol+" HTTP "+response.status)));
  }
  const rows=data.filter(row=>row&&row.date&&getNet(row)!==null).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
  if(!rows.length) throw new Error("No COT positioning rows for "+symbol);
  return rows[0];
}
module.exports=async function handler(req,res) {
  res.setHeader("Cache-Control","s-maxage=21600, stale-while-revalidate=43200");
  if(req.method!=="GET") return res.status(405).json({success:false,error:"GET required"});
  const pair=String(req.query&&req.query.pair||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const contracts=CONTRACTS[pair];
  if(!contracts) return res.status(200).json({success:true,pair,status:"UNAVAILABLE",direction:"WAIT",detail:"FMP COT positioning is not mapped for this market."});
  const key=process.env.FMP_API_KEY||process.env.FINANCIAL_MODELING_PREP_API_KEY||process.env.FMP_ACCESS_KEY||process.env.FMP_KEY;
  if(!key) return res.status(503).json({success:false,pair,status:"UNAVAILABLE",direction:"WAIT",error:"FMP API key is not configured for COT positioning."});
  const now=new Date(),from=new Date(now.getTime()-90*86400000);
  try {
    const rows=await Promise.all(contracts.map(async contract=>({contract,row:await fetchContract(contract.symbol,key,isoDate(from),isoDate(now))})));
    const details=rows.map(({contract,row})=>{
      const ageDays=(now.getTime()-Date.parse(row.date))/86400000;
      return {symbol:contract.symbol,label:contract.label,date:row.date,netScore:getNet(row)*contract.sign,marketSentiment:row.marketSentiment||row.marketSituation||"Positioning data",ageDays};
    });
    if(details.some(item=>!Number.isFinite(item.ageDays)||item.ageDays<0||item.ageDays>14)) {
      return res.status(200).json({success:true,pair,status:"STALE",direction:"WAIT",source:"FMP COT Analysis",details,detail:"The latest COT report is older than 14 days. It is not used as current sentiment."});
    }
    const score=details.reduce((sum,item)=>sum+item.netScore,0)/details.length;
    const direction=score>=8?"BUY":score<=-8?"SELL":"WAIT";
    return res.status(200).json({success:true,pair,status:direction==="WAIT"?"NEUTRAL":"ACTIVE",direction,score:Number(score.toFixed(2)),source:"FMP Commitment of Traders · weekly futures positioning",asOf:details.map(x=>x.date).sort()[details.length-1],details,detail:details.map(x=>x.label+": "+x.marketSentiment+" ("+x.netScore.toFixed(1)+" net positioning score)").join(" · ")});
  } catch(error) {
    console.error("DAGBO FMP COT positioning error:",error.message);
    return res.status(502).json({success:false,pair,status:"UNAVAILABLE",direction:"WAIT",source:"FMP COT Analysis",error:"FMP COT positioning is unavailable: "+String(error.message||error)});
  }
};
