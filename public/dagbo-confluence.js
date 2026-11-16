(function(root,factory){if(typeof module==="object"&&module.exports)module.exports=factory();else root.DagboConfluence=factory();})(typeof globalThis!=="undefined"?globalThis:this,function(){
"use strict";
function n(v){var x=Number(v);return Number.isFinite(x)?x:null;}
function ema(a,p){if(!a.length)return 0;var k=2/(p+1),v=a[0];for(var i=1;i<a.length;i++)v=a[i]*k+v*(1-k);return v;}
function rsi(a,p){if(a.length<=p)return 50;var g=0,l=0;for(var i=a.length-p;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}if(!l)return 100;return 100-100/(1+g/l);}
function pivots(candles,radius){var out=[];for(var i=radius;i<candles.length-radius;i++){var hi=n(candles[i].high),lo=n(candles[i].low),isH=true,isL=true;for(var j=i-radius;j<=i+radius;j++){if(j===i)continue;if(n(candles[j].high)>=hi)isH=false;if(n(candles[j].low)<=lo)isL=false;}if(isH)out.push({i,type:"H",price:hi});if(isL)out.push({i,type:"L",price:lo});}return out.sort(function(a,b){return a.i-b.i;});}
function patternScan(candles,closes){candles=candles.slice(-100);closes=closes.slice(-100);var p=pivots(candles,3),last=closes[closes.length-1],prior=closes[closes.length-2],out={direction:"WAIT",name:"No confirmed chart pattern",confirmed:false};
function near(a,b,t){return Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-9)<=t;}
for(var i=Math.max(0,p.length-9);i<=p.length-5;i++){var q=p.slice(i,i+5);if(q.length<5)continue;
if(q[0].type==="H"&&q[1].type==="L"&&q[2].type==="H"&&q[3].type==="L"&&q[4].type==="H"&&q[2].price>q[0].price*1.002&&q[2].price>q[4].price*1.002&&near(q[0].price,q[4].price,0.012)){var neck=(q[1].price+q[3].price)/2;if(prior>=neck&&last<neck){out={direction:"SELL",name:"Head and Shoulders neckline breakdown",confirmed:true};}}
if(q[0].type==="L"&&q[1].type==="H"&&q[2].type==="L"&&q[3].type==="H"&&q[4].type==="L"&&q[2].price<q[0].price*.998&&q[2].price<q[4].price*.998&&near(q[0].price,q[4].price,.012)){var neck2=(q[1].price+q[3].price)/2;if(prior<=neck2&&last>neck2){out={direction:"BUY",name:"Inverse Head and Shoulders neckline breakout",confirmed:true};}}
}
var hs=p.filter(function(x){return x.type==="H"}),ls=p.filter(function(x){return x.type==="L"});
if(out.direction==="WAIT"&&hs.length>=2){var a=hs[hs.length-2],b=hs[hs.length-1],mid= Math.min.apply(null,candles.slice(a.i+1,b.i).map(function(x){return n(x.low)}));if(near(a.price,b.price,.004)&&Number.isFinite(mid)&&last<mid&&prior>=mid)out={direction:"SELL",name:"Double Top confirmed breakdown",confirmed:true};}
if(out.direction==="WAIT"&&ls.length>=2){var c=ls[ls.length-2],d=ls[ls.length-1],peak=Math.max.apply(null,candles.slice(c.i+1,d.i).map(function(x){return n(x.high)}));if(near(c.price,d.price,.004)&&Number.isFinite(peak)&&last>peak&&prior<=peak)out={direction:"BUY",name:"Double Bottom confirmed breakout",confirmed:true};}
if(out.direction==="WAIT"&&hs.length>=3&&ls.length>=3){var h3=hs.slice(-3),l3=ls.slice(-3),fall=h3[2].price<h3[0].price*.998,rise=l3[2].price>l3[0].price*1.002;if(fall&&rise){var ceiling=(h3[2].price+h3[1].price)/2,floor=(l3[2].price+l3[1].price)/2;if(last>ceiling&&prior<=ceiling)out={direction:"BUY",name:"Symmetrical Triangle upside breakout",confirmed:true};else if(last<floor&&prior>=floor)out={direction:"SELL",name:"Symmetrical Triangle downside breakout",confirmed:true};}}
if(out.direction==="WAIT"&&hs.length>=3&&ls.length>=3){var ah=hs.slice(-3),al=ls.slice(-3),flatHigh=near(ah[0].price,ah[2].price,.004),flatLow=near(al[0].price,al[2].price,.004);if(flatHigh&&al[2].price>al[0].price*1.002&&last>ah[2].price&&prior<=ah[2].price)out={direction:"BUY",name:"Ascending Triangle resistance breakout",confirmed:true};else if(flatLow&&ah[2].price<ah[0].price*.998&&last<al[2].price&&prior>=al[2].price)out={direction:"SELL",name:"Descending Triangle support breakdown",confirmed:true};}
if(out.direction==="WAIT"&&hs.length>=3&&ls.length>=3){var wh=hs.slice(-3),wl=ls.slice(-3),hslope=wh[2].price-wh[0].price,lslope=wl[2].price-wl[0].price;if(hslope>0&&lslope>hslope*1.15&&last<wl[2].price&&prior>=wl[2].price)out={direction:"SELL",name:"Rising Wedge downside breakdown",confirmed:true};else if(lslope<0&&hslope<lslope*1.15&&last>wh[2].price&&prior<=wh[2].price)out={direction:"BUY",name:"Falling Wedge upside breakout",confirmed:true};}
if(out.direction==="WAIT"&&hs.length>=3&&ls.length>=3){var hh=hs.slice(-3),ll=ls.slice(-3);if(hh[2].price<hh[1].price&&hh[1].price<hh[0].price&&ll[2].price<ll[1].price&&ll[1].price<ll[0].price&&last>hh[2].price&&prior<=hh[2].price)out={direction:"BUY",name:"Bull Flag / channel breakout",confirmed:true};else if(hh[2].price>hh[1].price&&hh[1].price>hh[0].price&&ll[2].price>ll[1].price&&ll[1].price>ll[0].price&&last<ll[2].price&&prior>=ll[2].price)out={direction:"SELL",name:"Bear Flag / channel breakdown",confirmed:true};}
return out;}
function stochastic(candles,period,kSmooth){
var raw=[];for(var i=Math.max(period-1,candles.length-5);i<candles.length;i++){var win=candles.slice(i-period+1,i+1),hi=Math.max.apply(null,win.map(function(x){return n(x.high)})),lo=Math.min.apply(null,win.map(function(x){return n(x.low)})),cl=n(candles[i].close);raw.push(hi===lo?50:(cl-lo)/(hi-lo)*100);}
var slowKs=[];for(var j=0;j<raw.length;j++){var part=raw.slice(Math.max(0,j-kSmooth+1),j+1);slowKs.push(part.reduce(function(a,b){return a+b},0)/part.length);}
var k=slowKs[slowKs.length-1],tail=slowKs.slice(-3),d=tail.reduce(function(a,b){return a+b},0)/tail.length;return {k:k,d:d};
}
function analyze(candles,pair,profile){
profile=profile==="scalp"?"scalp":profile==="swing"?"swing":"intraday";
var isScalp=profile==="scalp",rsiPeriod=isScalp?7:14,emaFast=isScalp?20:20,emaSlow=isScalp?50:50;
if(!Array.isArray(candles)||candles.length<(isScalp?30:60))return null;
var cs=candles.map(function(x){return n(x.close)}),hs=candles.map(function(x){return n(x.high)}),ls=candles.map(function(x){return n(x.low)});
if(cs.some(function(x){return x===null})||hs.some(function(x){return x===null})||ls.some(function(x){return x===null}))return null;
var last=candles[candles.length-1],prev=candles[candles.length-2],close=cs[cs.length-1],open=n(last.open),high=hs[hs.length-1],low=ls[ls.length-1];if(open===null)return null;
var e20=ema(cs,emaFast),e50=ema(cs,emaSlow),e12=ema(cs,isScalp?6:12),e26=ema(cs,isScalp?13:26),macd=e12-e26,macdPrev=ema(cs.slice(0,-1),isScalp?6:12)-ema(cs.slice(0,-1),isScalp?13:26),rv=rsi(cs,rsiPeriod);
var trendDir=e20>e50&&close>e20&&macd>macdPrev?"BUY":e20<e50&&close<e20&&macd<macdPrev?"SELL":"WAIT";
var stoch=stochastic(candles,isScalp?5:14,3),prevStoch=stochastic(candles.slice(0,-1),isScalp?5:14,3);
var momentumDir=isScalp?((rv>50&&stoch.k>stoch.d&&stoch.k>50)?"BUY":(rv<50&&stoch.k<stoch.d&&stoch.k<50)?"SELL":"WAIT"):(rv>=55?"BUY":rv<=45?"SELL":"WAIT");
var bbPeriod=isScalp?12:20,recent=cs.slice(-bbPeriod),mean=recent.reduce(function(s,x){return s+x},0)/recent.length,sd=Math.sqrt(recent.reduce(function(s,x){return s+(x-mean)*(x-mean)},0)/recent.length),bbDir=close<mean-2*sd&&close>open?"BUY":close>mean+2*sd&&close<open?"SELL":"WAIT";
var atrPeriod=14,tr=0;for(var i=cs.length-atrPeriod;i<cs.length;i++)tr+=Math.max(hs[i]-ls[i],Math.abs(hs[i]-cs[i-1]),Math.abs(ls[i]-cs[i-1]));var atr=tr/atrPeriod,atrPct=atr/Math.max(Math.abs(close),1e-9)*100,atrOk=atrPct>=(isScalp?0.008:0.004);
var vols=candles.slice(-21,-1).map(function(x){return n(x.volume)}).filter(function(x){return x!==null&&x>0}),v=n(last.volume),avg=vols.length?vols.reduce(function(s,x){return s+x},0)/vols.length:0,volumeDir=avg>0&&v!==null&&v>=avg*1.2?(close>open?"BUY":close<open?"SELL":"WAIT"):"WAIT";
var prior=candles.slice(-(isScalp?7:21),-1),sHigh=Math.max.apply(null,prior.map(function(x){return n(x.high)})),sLow=Math.min.apply(null,prior.map(function(x){return n(x.low)})),structureDir=close>sHigh?"BUY":close<sLow?"SELL":"WAIT";
var sweepDir=high>sHigh&&close<sHigh?"SELL":low<sLow&&close>sLow?"BUY":"WAIT",twoBack=candles[candles.length-3],fvgDir=low>n(twoBack.high)?"BUY":high<n(twoBack.low)?"SELL":"WAIT";
var structureVotes=[structureDir,sweepDir,fvgDir],structureBuys=structureVotes.filter(function(x){return x==="BUY"}).length,structureSells=structureVotes.filter(function(x){return x==="SELL"}).length,structureDirFinal=structureBuys>=2?"BUY":structureSells>=2?"SELL":"WAIT";
var pattern=patternScan(candles,cs);
var groups=[{name:"Trend",dir:trendDir,detail:"EMA20/50 + "+(isScalp?"MACD(6,13)":"MACD(12,26)")},{name:"Momentum",dir:momentumDir,detail:"RSI("+rsiPeriod+")"+(isScalp?" + Stochastic(5,3,3)":"")},{name:"Volatility",dir:bbDir,detail:"Bollinger Bands("+bbPeriod+",2) · ATR "+(atrOk?"active":"too quiet")},{name:"Volume",dir:volumeDir,detail:avg>0&&v!==null?(v/avg).toFixed(2)+"x average volume":"volume unavailable"},{name:"Chart pattern",dir:pattern.direction,detail:pattern.name},{name:"Market structure",dir:structureDirFinal,detail:"BOS "+structureDir+" · sweep "+sweepDir+" · FVG "+fvgDir}];
var score={BUY:0,SELL:0},active={BUY:0,SELL:0},evidence=[];groups.forEach(function(g){if(g.dir==="BUY"||g.dir==="SELL"){score[g.dir]+=2;active[g.dir]++;evidence.push(g.name+": "+g.detail+" ("+g.dir+")");}});
var maxScore=12,confidence={BUY:Math.min(100,Math.round(score.BUY/maxScore*100+(active.BUY>=4?4:0))),SELL:Math.min(100,Math.round(score.SELL/maxScore*100+(active.SELL>=4?4:0)))};
var threshold=profile==="scalp"?65:profile==="swing"?75:70,minGroups=isScalp?3:4;
var lead=score.BUY>score.SELL?"BUY":score.SELL>score.BUY?"SELL":"WAIT";
var leadScore=lead==="WAIT"?0:score[lead],leadGroups=lead==="WAIT"?0:active[lead],leadConfidence=lead==="WAIT"?0:confidence[lead];
var dir=atrOk&&lead!=="WAIT"&&leadConfidence>=threshold&&leadGroups>=minGroups?lead:"WAIT";
var source="MAIN CONFLUENCE",momentumTrigger=null,wrNow=null,wrPrev=null;
if(!dir&&isScalp&&atrOk){
function williams(idx){var w=candles.slice(idx-13,idx+1),hh=Math.max.apply(null,w.map(function(x){return n(x.high)})),ll=Math.min.apply(null,w.map(function(x){return n(x.low)}));return hh===ll?-50:(hh-n(w[w.length-1].close))/(hh-ll)*-100;}
wrNow=williams(candles.length-1);wrPrev=williams(candles.length-2);
var breakoutHigh=Math.max.apply(null,candles.slice(-4,-1).map(function(x){return n(x.high)})),breakoutLow=Math.min.apply(null,candles.slice(-4,-1).map(function(x){return n(x.low)}));
if(wrPrev<=-80&&wrNow>-80&&close>breakoutHigh&&close>open){dir="BUY";source="FAST MOMENTUM CHANNEL";momentumTrigger="Williams %R crossed up from oversold with 3-candle price breakout";}
else if(wrPrev>=-20&&wrNow<-20&&close<breakoutLow&&close<open){dir="SELL";source="FAST MOMENTUM CHANNEL";momentumTrigger="Williams %R crossed down from overbought with 3-candle price breakdown";}
}
if(!dir)dir="WAIT";
var signal=dir==="WAIT"?"NO TRADE":(leadConfidence>=85&&source==="MAIN CONFLUENCE"?"HIGH CONFIDENCE ":"")+dir;
var confidenceValue=source==="FAST MOMENTUM CHANNEL"?65:leadConfidence;
var quality=confidenceValue>=85?"HIGH":confidenceValue>=75?"MEDIUM":"LOW";
var buy=dir==="BUY";
return {pair:pair,profile:profile,signal:signal,direction:dir,source:source,confidence:confidenceValue,quality:quality,threshold:threshold,entry:close,stopLoss:buy?close-atr*1.5:close+atr*1.5,takeProfit:buy?close+atr*2:close-atr*2,tp2:buy?close+atr*3.5:close-atr*3.5,atr:atr,atrPct:atrPct,atrOk:atrOk,rsi:Number(rv.toFixed(1)),stochasticK:Number(stoch.k.toFixed(1)),williamsR:wrNow===null?null:Number(wrNow.toFixed(1)),momentumTrigger:momentumTrigger,evidence:evidence,buyScore:score.BUY,sellScore:score.SELL,totalMethods:12,groups:groups,pattern:pattern.name,patternDirection:pattern.direction,patternConfirmed:pattern.confirmed,structure:structureDir,sweep:sweepDir,fvg:fvgDir,bb:bbDir,volume:volumeDir,candleHigh:high,candleLow:low,candleTime:last.datetime||null,macd:macd,emaTrend:trendDir};}

return {analyze:analyze,patternScan:patternScan};
});