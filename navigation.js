(function(){
  if(document.getElementById('dagboSideMenu')) return;
  var items=[
    ['⌂','Home','index.html'],['↗','Signals','signals.html'],['⌁','Chart','chart.html'],
    ['▤','Market News','news.html'],['◈','BOSS1','boss1.html'],['✳','AI Commander','ai.html'],
    ['▧','Journal','journal.html'],['◎','Trader Score','trader-score.html'],
    ['⌘','Strategy Lab','strategy-lab.html'],['◉','Opportunity Intelligence','signal-insights.html'],
    ['⚙','Settings','settings.html']
  ];
  var style=document.createElement('style');
  style.textContent=`
  #dagboMenuButton{position:fixed;top:calc(12px + env(safe-area-inset-top,0px));left:12px;z-index:9900;width:42px;height:42px;border:1px solid rgba(150,165,185,.2);border-radius:50%;background:rgba(25,27,30,.94);color:#f7f7f7;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 14px #0005;backdrop-filter:blur(12px);cursor:pointer}
  #dagboMenuButton svg{width:21px;height:21px}
  #dagboMenuShade{position:fixed;inset:0;z-index:9901;background:rgba(0,0,0,.58);opacity:0;visibility:hidden;transition:opacity .22s,visibility .22s}
  #dagboSideMenu{position:fixed;z-index:9902;left:0;top:0;bottom:0;width:min(78vw,290px);padding:calc(16px + env(safe-area-inset-top,0px)) 0 calc(14px + env(safe-area-inset-bottom,0px));background:#171819;color:#f5f5f5;box-shadow:12px 0 38px #0006;transform:translateX(-103%);transition:transform .25s cubic-bezier(.2,.75,.25,1);display:flex;flex-direction:column;overflow:hidden}
  body.dagbo-menu-open #dagboMenuShade{opacity:1;visibility:visible}
  body.dagbo-menu-open #dagboSideMenu{transform:translateX(0)}
  #dagboSideMenu .dm-head{display:flex;align-items:center;justify-content:space-between;padding:0 18px 16px;font-size:16px;font-weight:750;letter-spacing:.3px}
  #dagboSideMenu .dm-brand{display:flex;align-items:center;gap:10px}
  #dagboSideMenu .dm-mark{color:#e9bd53;font-size:20px}
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
  button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  var shade=document.createElement('div');shade.id='dagboMenuShade';
  var panel=document.createElement('aside');panel.id='dagboSideMenu';panel.setAttribute('aria-label','Main navigation');
  var current=location.pathname.split('/').pop()||'index.html';
  var links=items.map(function(item){return '<a class="dm-link '+(current===item[2]?'dm-current':'')+'" href="'+item[2]+'"><span class="dm-icon">'+item[0]+'</span><span>'+item[1]+'</span></a>'}).join('');
  panel.innerHTML='<div class="dm-head"><div class="dm-brand"><span class="dm-mark">◈</span><span>DAGBO SIGNAL</span></div><button class="dm-close" type="button" aria-label="Close navigation">×</button></div><nav class="dm-list">'+links+'</nav><div class="dm-separator"></div><div class="dm-foot">SIGNAL WEY NO DEY LIE</div>';
  function open(){document.body.classList.add('dagbo-menu-open');button.setAttribute('aria-expanded','true')}
  function close(){document.body.classList.remove('dagbo-menu-open');button.setAttribute('aria-expanded','false')}
  button.addEventListener('click',open);shade.addEventListener('click',close);panel.querySelector('.dm-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')close()});
  document.body.appendChild(button);document.body.appendChild(shade);document.body.appendChild(panel);
})();