const COUNTRIES = [
  { currency: "USD", country: "united states" },
  { currency: "EUR", country: "euro area" },
  { currency: "GBP", country: "united kingdom" },
  { currency: "JPY", country: "japan" },
  { currency: "CAD", country: "canada" },
  { currency: "AUD", country: "australia" },
  { currency: "CHF", country: "switzerland" },
  { currency: "NZD", country: "new zealand" }
];
const PAIRS = ["EURUSD","GBPUSD","USDJPY","USDCHF","USDCAD","AUDUSD","NZDUSD","EURGBP","EURJPY","GBPJPY","AUDJPY","CADJPY","CHFJPY","EURAUD","GBPAUD","GBPCAD","AUDCAD","NZDCAD"];
const number = value => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[, %]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
function pick(rows, terms) {
  return rows.find(row => terms.some(term => String(row.Category || "").toLowerCase().includes(term)));
}
function freshness(row) {
  if (!row || !row.LatestValueDate) return false;
  const age = Date.now() - Date.parse(row.LatestValueDate);
  return Number.isFinite(age) && age >= -86400000 && age <= 240 * 86400000;
}
function percentile(values, value, reverse) {
  if (!values.length || value == null) return null;
  const sorted = values.slice().sort((a,b)=>a-b);
  let below = sorted.filter(x => x < value).length;
  let equal = sorted.filter(x => x === value).length;
  let score = 100 * (below + equal / 2) / sorted.length;
  return reverse ? 100 - score : score;
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.TRADING_ECONOMICS_API_KEY;
  if (!key) return res.status(503).json({ configured: false, error: "Fundamental data provider is not configured. Add TRADING_ECONOMICS_API_KEY in Cloudflare Worker Secrets." });
  try {
    const snapshots = await Promise.all(COUNTRIES.map(async item => {
      const url = "https://api.tradingeconomics.com/country/" + encodeURIComponent(item.country) + "?f=json";
      const response = await fetch(url, { headers: { Authorization: key } });
      if (!response.ok) throw new Error("Trading Economics returned HTTP " + response.status + " for " + item.currency);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("Invalid macro data for " + item.currency);
      const rate = pick(rows, ["interest rate"]);
      const growth = pick(rows, ["gdp growth"]);
      const jobs = pick(rows, ["unemployment rate"]);
      const inflation = pick(rows, ["inflation rate"]);
      return {
        currency: item.currency, country: item.country,
        rate: freshness(rate) ? number(rate.LatestValue) : null,
        growth: freshness(growth) ? number(growth.LatestValue) : null,
        unemployment: freshness(jobs) ? number(jobs.LatestValue) : null,
        inflation: freshness(inflation) ? number(inflation.LatestValue) : null,
        dates: [rate,growth,jobs,inflation].filter(freshness).map(x=>x.LatestValueDate),
        sources: [rate,growth,jobs,inflation].filter(freshness).map(x=>x.Source).filter(Boolean)
      };
    }));
    const rates=snapshots.map(x=>x.rate).filter(x=>x!=null), growths=snapshots.map(x=>x.growth).filter(x=>x!=null), jobs=snapshots.map(x=>x.unemployment).filter(x=>x!=null);
    const scored=snapshots.map(item=>{
      const parts=[
        {name:"Interest-rate support",value:percentile(rates,item.rate,false),weight:.40},
        {name:"GDP growth",value:percentile(growths,item.growth,false),weight:.35},
        {name:"Labour-market strength",value:percentile(jobs,item.unemployment,true),weight:.25}
      ].filter(x=>x.value!=null);
      const totalWeight=parts.reduce((sum,x)=>sum+x.weight,0);
      const score=parts.length>=2?Math.round(parts.reduce((sum,x)=>sum+x.value*x.weight,0)/totalWeight):null;
      return {...item,score,coverage:parts.length,drivers:parts};
    });
    const byCurrency=Object.fromEntries(scored.map(x=>[x.currency,x]));
    const pairs=PAIRS.map(pair=>{
      const base=byCurrency[pair.slice(0,3)],quote=byCurrency[pair.slice(3,6)];
      if(!base||!quote||base.score==null||quote.score==null) return {pair,bias:"INSUFFICIENT_DATA",score:null};
      const score=Math.round(base.score-quote.score);
      return {pair,bias:score>=12?"BUY":score<=-12?"SELL":"NEUTRAL",score,baseScore:base.score,quoteScore:quote.score};
    });
    const valid=scored.filter(x=>x.score!=null);
    return res.status(200).json({
      configured:true,provider:"Trading Economics",updatedAt:new Date().toISOString(),
      methodology:"Relative cross-country score: interest-rate support 40%, GDP growth 35%, inverse unemployment 25%. Scores are percentiles within the covered major economies. Inflation is shown as context, not automatically treated as bullish or bearish.",
      currencies:scored,pairs,coverage:valid.length+"/"+COUNTRIES.length,
      warnings:["Relative macro context only; not a standalone entry signal.","Missing or stale indicators are excluded. At least two of three scored indicators are required.","Higher interest rates can support a currency but may also reflect inflation or financial stress."]
    });
  } catch(error) {
    console.error("DAGBO fundamental analysis error:",error.message);
    return res.status(502).json({configured:true,error:"Fundamental provider request failed. Check the API subscription, key and provider limits."});
  }
};
