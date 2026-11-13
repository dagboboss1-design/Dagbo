(function(){
  if(document.getElementById('dagboFundamentalWidget')) return;
  var host=document.querySelector('main');
  if(!host) return;
  var box=document.createElement('section');box.id='dagboFundamentalWidget';
  box.style.cssText='margin:14px 0;padding:15px;border:1px solid #31513e;border-radius:14px;background:linear-gradient(145deg,#0e2118,#0a1512);color:#effff5';
  box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong style="font-size:15px">◈ Fundamental Market Context</strong><a href="fundamental.html" style="color:#71e6a1;font-size:11px;font-weight:800;text-decoration:none">OPEN →</a></div><div id="dagboFundamentalQuick" style="font-size:12px;color:#a9c9b6;margin-top:9px">Loading macro context…</div>';
  var anchor=host.querySelector('h1')||host.firstElementChild;
  if(anchor&&anchor.parentNode) anchor.parentNode.insertBefore(box,anchor.nextSibling); else host.prepend(box);
  fetch('/api/fundamentals',{cache:'no-store'}).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'Not configured');return d})}).then(function(data){
    var target=document.getElementById('dagboFundamentalQuick');
    var pairs=(data.pairs||[]).filter(function(x){return x.bias==='BUY'||x.bias==='SELL'}).sort(function(a,b){return Math.abs(b.score)-Math.abs(a.score)}).slice(0,4);
    if(!pairs.length){target.textContent=data.error||'Macro data is not available yet. Add the provider key in Cloudflare Secrets.';return;}
    target.textContent=pairs.map(function(x){return x.pair+' '+x.bias+' ('+(x.score>0?'+':'')+x.score+')'}).join('  ·  ')+'  |  Relative macro bias, not an entry signal.';
  }).catch(function(err){document.getElementById('dagboFundamentalQuick').textContent=err.message+' · Open Fundamental Analysis for details.'});
})();
