(function(){
  if(document.getElementById('dagboFundamentalWidget')) return;
  var host=document.querySelector('main');
  if(!host) return;
  var box=document.createElement('section');box.id='dagboFundamentalWidget';
  box.style.cssText='margin:14px 0;padding:15px;border:1px solid #31513e;border-radius:14px;background:linear-gradient(145deg,#0e2118,#0a1512);color:#effff5';
  var heading=document.createElement('div');heading.style.cssText='display:flex;justify-content:space-between;align-items:center;gap:8px';
  var title=document.createElement('strong');title.style.fontSize='15px';title.textContent='◈ Fundamental & Economic Event Context';
  var open=document.createElement('a');open.href='fundamental.html';open.textContent='OPEN →';open.style.cssText='color:#71e6a1;font-size:11px;font-weight:800;text-decoration:none';
  heading.append(title,open);
  var macro=document.createElement('div');macro.style.cssText='font-size:12px;color:#a9c9b6;margin-top:9px';macro.textContent='Loading relative macro context…';
  var events=document.createElement('div');events.style.cssText='font-size:12px;color:#c5d8ca;margin-top:9px;padding-top:9px;border-top:1px solid #31513e';events.textContent='Loading economic events…';
  box.append(heading,macro,events);
  var anchor=host.querySelector('h1')||host.firstElementChild;
  if(anchor&&anchor.parentNode) anchor.parentNode.insertBefore(box,anchor.nextSibling); else host.prepend(box);
  fetch('/api/fundamentals',{cache:'no-store'}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Macro data unavailable');return d})}).then(function(data){
    var pairs=(data.pairs||[]).filter(function(x){return x.bias==='BUY'||x.bias==='SELL'}).sort(function(a,b){return Math.abs(b.score)-Math.abs(a.score)}).slice(0,4);
    macro.textContent=pairs.length?pairs.map(function(x){return x.pair+' '+x.bias+' ('+(x.score>0?'+':'')+x.score+')'}).join(' · ')+' · Relative macro context, not an entry signal.': 'Macro provider is not configured or has insufficient recent data.';
  }).catch(function(err){macro.textContent=err.message+' · Macro time-series data is separate from the free event calendar.'});
  fetch('/api/calendar',{cache:'no-store'}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Calendar unavailable');return d})}).then(function(data){
    var upcoming=(data.events||[]).filter(function(e){return ['high','medium'].includes(String(e.impact).toLowerCase())&&Date.parse(e.date)>Date.now()}).slice(0,3);
    events.textContent=upcoming.length?'UPCOMING EVENTS · '+upcoming.map(function(e){return e.currency+' '+e.name+' · '+new Date(e.date).toLocaleString('en-NG',{dateStyle:'short',timeStyle:'short'})+' · '+e.impact.toUpperCase()}).join(' | '):'No upcoming high/medium events in the current calendar window.';
    var credit=document.createElement('a');credit.href='https://showmytrades.com/tools/economic-calendar';credit.target='_blank';credit.rel='noopener noreferrer';credit.textContent='Calendar data by ShowMyTrades';credit.style.cssText='display:block;color:#71e6a1;font-size:10px;margin-top:7px;text-decoration:none';events.appendChild(credit);
  }).catch(function(err){events.textContent=err.message});
})();
