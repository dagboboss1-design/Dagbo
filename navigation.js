(function(){
  if(document.getElementById('dagboSideMenu')) return;
  var items=[
    ['⌂','Home','index.html'],['↗','Signals','signals.html'],['⌁','Chart','chart.html'],
    ['▤','Market News','news.html'],['◈','BOSS1','boss1.html'],['✳','AI Commander','ai.html'],
    ['▧','Journal','journal.html'],['◎','Trader Score','trader-score.html'],
    ['⌘','Strategy Lab','strategy-lab.html'],['▣','Learn with Examples','learn.html'],['◉','Opportunity Intelligence','signal-insights.html'],
    ['⚙','Settings','settings.html']
  ];
  var style=document.createElement('style');
  style.textContent=`
  #dagboMenuButton{position:fixed;top:calc(10px + env(safe-area-inset-top,0px));left:12px;z-index:9900;width:38px;height:38px;border:0;border-radius:8px;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;box-shadow:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
  #dagboMenuButton svg{width:24px;height:24px}
  #dagboMenuShade{position:fixed;inset:0;z-index:9901;background:rgba(0,0,0,.58);opacity:0;visibility:hidden;transition:opacity .22s,visibility .22s}
  #dagboSideMenu{position:fixed;z-index:9902;left:0;top:0;bottom:0;width:min(78vw,290px);padding:calc(16px + env(safe-area-inset-top,0px)) 0 calc(14px + env(safe-area-inset-bottom,0px));background:#171819;color:#f5f5f5;box-shadow:12px 0 38px #0006;transform:translateX(-103%);transition:transform .25s cubic-bezier(.2,.75,.25,1);display:flex;flex-direction:column;overflow:hidden}
  body.dagbo-menu-open #dagboMenuShade{opacity:1;visibility:visible}
  body.dagbo-menu-open #dagboSideMenu{transform:translateX(0)}
  #dagboSideMenu .dm-head{display:flex;align-items:center;justify-content:space-between;padding:0 18px 16px;font-size:16px;font-weight:750;letter-spacing:.3px}
  #dagboSideMenu .dm-brand{display:flex;align-items:center;gap:10px}
  #dagboSideMenu .dm-mark{width:27px;height:27px;display:block;border-radius:50%;overflow:hidden}#dagboSideMenu .dm-mark img{width:100%;height:100%;display:block}
  #dagboSideMenu .dm-close{width:38px;height:38px;border:0;border-radius:50%;background:#292a2d;color:#fff;font-size:25px;line-height:1;cursor:pointer}
  #dagboSideMenu .dm-list{overflow-y:auto;padding:2px 0 16px;overscroll-behavior:contain}
  #dagboSideMenu .dm-link{min-height:47px;display:flex;align-items:center;gap:15px;padding:0 19px;color:#e5e5e5;text-decoration:none;font-size:14px;font-weight:500;letter-spacing:.05px;border-left:2px solid transparent}
  #dagboSideMenu .dm-link:active{background:#28292c}
  #dagboSideMenu .dm-link.dm-current{background:#292a2d;border-left-color:#aeb1b5}
  #dagboSideMenu .dm-icon{width:25px;flex:none;text-align:center;font-size:17px;color:#aeb1b5}
  #dagboSideMenu .dm-separator{height:1px;background:#36373a;margin:14px 18px}
  #dagboSideMenu .dm-foot{margin-top:auto;padding:14px 22px 0;color:#777;font-size:10px;letter-spacing:.6px}
  @media(min-width:700px){#dagboSideMenu{width:290px}}
  `;
  document.head.appendChild(style);
  var button=document.createElement('button');button.id='dagboMenuButton';button.type='button';button.setAttribute('aria-label','Open navigation');
  button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
  var shade=document.createElement('div');shade.id='dagboMenuShade';
  var panel=document.createElement('aside');panel.id='dagboSideMenu';panel.setAttribute('aria-label','Main navigation');
  var current=location.pathname.split('/').pop()||'index.html';
  var links=items.map(function(item){return '<a class="dm-link '+(current===item[2]?'dm-current':'')+'" href="'+item[2]+'"><span class="dm-icon">'+item[0]+'</span><span>'+item[1]+'</span></a>'}).join('');
  panel.innerHTML='<div class="dm-head"><div class="dm-brand"><span class="dm-mark"><img src="icons/dagbo-orbit.svg" alt=""></span><span>DAGBO SIGNAL</span></div><button class="dm-close" type="button" aria-label="Close navigation">×</button></div><nav class="dm-list">'+links+'</nav><div class="dm-separator"></div><div class="dm-foot">SIGNAL WEY NO DEY LIE</div>';
  function open(){document.body.classList.add('dagbo-menu-open');button.setAttribute('aria-expanded','true')}
  function close(){document.body.classList.remove('dagbo-menu-open');button.setAttribute('aria-expanded','false')}
  button.addEventListener('click',open);shade.addEventListener('click',close);panel.querySelector('.dm-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  document.body.appendChild(button);document.body.appendChild(shade);document.body.appendChild(panel);
  document.querySelectorAll(".dg-brand").forEach(function(el){if(!el.querySelector(".dagbo-inline-mark")){var img=document.createElement("img");img.className="dagbo-inline-mark";img.src="icons/dagbo-orbit.svg";img.alt="";img.style.cssText="width:24px;height:24px;vertical-align:middle;margin-right:8px;border-radius:50%";el.prepend(img)}});
  /* DAGBO orbit loading mark: shown only while the page is loading. */
  if(document.readyState!=="complete"&&!document.getElementById("dagboOrbitLoader")){
    var loaderStyle=document.createElement("style");
    loaderStyle.textContent="@keyframes dagboOrbitSpin{to{transform:rotate(360deg)}}#dagboOrbitLoader{position:fixed;inset:0;z-index:10050;background:#000;display:grid;place-items:center;opacity:1;transition:opacity .22s ease}#dagboOrbitLoader .orbit{width:68px;height:68px;border:1.5px solid #292a2d;border-radius:50%;position:relative;animation:dagboOrbitSpin 1.2s linear infinite}#dagboOrbitLoader .orbit:before{content:'';position:absolute;width:38px;height:38px;background:#fff;border-radius:50%;left:50%;top:50%;transform:translate(-50%,-50%)}#dagboOrbitLoader .orbit:after{content:'';position:absolute;width:16px;height:16px;background:#fff;border-radius:50%;left:calc(50% + 26px);top:calc(50% + 9px);transform:translate(-50%,-50%)}@media(prefers-reduced-motion:reduce){#dagboOrbitLoader .orbit{animation:none}}";
    document.head.appendChild(loaderStyle);
    var loader=document.createElement("div");loader.id="dagboOrbitLoader";loader.setAttribute("aria-label","Loading DAGBO");loader.innerHTML='<div class="orbit" role="img" aria-label="DAGBO loading"></div>';
    document.body.appendChild(loader);
    function hideDagboLoader(){loader.style.opacity="0";setTimeout(function(){if(loader.parentNode)loader.parentNode.removeChild(loader)},240)}
    window.addEventListener("load",hideDagboLoader,{once:true});
    setTimeout(hideDagboLoader,7000);
  }

})();