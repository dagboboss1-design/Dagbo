module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="GET")return res.status(405).json({error:"GET required"});
  const key=process.env.TWELVE_DATA_API_KEY;
  if(!key)return res.status(503).json({error:"Live FX rate unavailable: TWELVE_DATA_API_KEY is not configured"});
  try{
    const url="https://api.twelvedata.com/exchange_rate?symbol=USD%2FNGN&dp=6&apikey="+encodeURIComponent(key);
    const response=await fetch(url,{headers:{"Accept":"application/json"}});
    const data=await response.json(),rate=Number(data&&data.rate);
    if(!response.ok||data.status==="error"||!Number.isFinite(rate)||rate<=0)throw new Error(data&&data.message?data.message:"No valid USD/NGN rate returned");
    const timestamp=Number(data.timestamp)||Math.floor(Date.now()/1000);
    return res.status(200).json({base:"USD",quote:"NGN",usdNgn:rate,timestamp,updatedAt:new Date(timestamp*1000).toISOString(),provider:"Twelve Data"});
  }catch(error){console.error("DAGBO live USD/NGN lookup failed:",error.message);return res.status(502).json({error:"Live USD/NGN rate is temporarily unavailable"});}
};