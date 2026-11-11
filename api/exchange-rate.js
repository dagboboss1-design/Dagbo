module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="GET")return res.status(405).json({error:"GET required"});
  try{
    const r=await fetch("https://open.er-api.com/v6/latest/USD",{headers:{"Accept":"application/json"}});
    if(!r.ok)throw new Error("Provider HTTP "+r.status);
    const d=await r.json(),rate=Number(d&&d.rates&&d.rates.NGN);
    if(d.result!=="success"||!Number.isFinite(rate)||rate<=0)throw new Error("Invalid USD/NGN rate");
    return res.status(200).json({base:"USD",quote:"NGN",usdNgn:rate,updatedAt:d.time_last_update_utc||null,timestamp:d.time_last_update_unix||null,provider:"open.er-api.com"});
  }catch(e){console.error("DAGBO exchange-rate lookup failed:",e.message);return res.status(502).json({error:"Live USD/NGN rate is temporarily unavailable"});}
};