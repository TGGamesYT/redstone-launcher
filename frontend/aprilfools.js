(function(){

const _af_style=document.createElement('style');
_af_style.textContent=`
#_af_player{position:fixed;bottom:20px;right:20px;width:160px;background:#004400;border:2px solid #ffff00;color:#ffff00;padding:10px;cursor:move;z-index:99999;font-family:'Comic Neue','Comic Sans MS',cursive;text-align:center;display:none;user-select:none;}
#_af_player ._af_title{font-weight:bold;color:#00ff00;font-size:11px;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase;}
#_af_status{font-size:11px;color:#ccffcc;margin-bottom:6px;display:block;}
#_af_vol{width:100%;margin-bottom:6px;accent-color:#00ff00;}
#_af_tog{width:100%;background:#005500;border:2px solid #00ff00;color:#ffff00;font-family:inherit;font-size:11px;padding:4px 0;cursor:pointer;text-transform:uppercase;letter-spacing:1px;}
#_af_tog:hover{background:#007700;border-color:#ffff00;}
#_af_toasts{position:fixed;top:55px;left:50%;transform:translateX(-50%);z-index:9999997;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;}
._af_toast{background:#004400;border:2px solid #ffff00;color:#ffff00;font-family:'Comic Neue','Comic Sans MS',cursive;font-size:13px;padding:6px 14px;white-space:nowrap;opacity:0;animation:_afTi .15s forwards,_afTo .3s 2.5s forwards;}
@keyframes _afTi{to{opacity:1}}
@keyframes _afTo{to{opacity:0}}
@keyframes _afFall{to{top:110vh;transform:rotate(720deg)}}
@keyframes _afWob{0%{transform:rotate(0)}25%{transform:rotate(1.2deg)}75%{transform:rotate(-1.2deg)}100%{transform:rotate(0)}}
@keyframes _afGrav{0%{transform:translateY(0) rotate(0deg)}100%{transform:translateY(var(--gy)) rotate(var(--gr))}}
._af_grav_item{animation:_afGrav var(--gd) cubic-bezier(.4,0,1,1) forwards!important;}
@keyframes _afBsodIn{from{opacity:0}to{opacity:1}}
#_af_bsod{display:none;position:fixed;inset:0;background:#0078d7;color:white;z-index:9999999;font-family:'Courier New',monospace;padding:60px 80px;animation:_afBsodIn .1s;}
#_af_bsod ._sad{font-size:110px;display:block;margin-bottom:16px;}
#_af_bsod h1{font-size:44px;margin:0 0 24px;}
#_af_bsod p{font-size:15px;line-height:1.8;max-width:600px;}
#_af_bsod ._pct{font-size:20px;margin-top:28px;}
#_af_crack_canvas{position:fixed;inset:0;pointer-events:none;z-index:9999998;display:none;}
#_af_cursor_canvas{position:fixed;inset:0;pointer-events:none;z-index:888888;}
._af_js_img{position:fixed;z-index:99999999;pointer-events:none;display:none;max-width:340px;max-height:340px;object-fit:contain;}
._af_fakepopup{position:fixed;background:#f0f0f0;border:2px solid #999;box-shadow:3px 3px 8px rgba(0,0,0,0.4);z-index:9999990;font-family:Tahoma,Arial,sans-serif;min-width:280px;cursor:default;}
._af_fakepopup ._fptitle{background:linear-gradient(to right,#003c74,#1f6fc5);color:white;padding:4px 8px;font-size:12px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;}
._af_fakepopup ._fptitle ._fpx{cursor:pointer;font-size:14px;line-height:1;padding:1px 4px;background:#c0392b;color:white;border:1px solid #922b21;}
._af_fakepopup ._fpx:hover{background:#e74c3c;}
._af_fakepopup ._fpbody{padding:16px 14px 10px;font-size:12px;color:#111;line-height:1.5;}
._af_fakepopup ._fpbody img{vertical-align:middle;margin-right:6px;width:32px;height:32px;}
._af_fakepopup ._fpbtns{padding:6px 10px 10px;display:flex;gap:6px;justify-content:flex-end;}
._af_fakepopup ._fpbtns button{font-family:Tahoma,Arial,sans-serif;font-size:11px;padding:3px 14px;border:1px solid #888;background:#e8e8e8;cursor:pointer;}
._af_fakepopup ._fpbtns button:hover{background:#cce;}
`;
document.head.appendChild(_af_style);

const _af_playerHTML=`<div id="_af_player"><div class="_af_title">🌿 april fools</div><span id="_af_status">loading...</span><input type="range" id="_af_vol" min="0" max="1" step="0.01" value="0.5"><button id="_af_tog">stop</button></div>`;
const _af_bsodHTML=`<div id="_af_bsod"><span class="_sad">:(</span><h1>Your PC ran into a problem.</h1><p>Dirtstone Launcher found an error and the launcher needs to restart.<br><br>Error: APRIL_FOOLS_EXCEPTION (0x0000LMAO)<br><br>If you'd like to know more, search online for:<br><strong>DIRTSTONE_LAUNCHER_HAS_FALLEN</strong></p><p class="_pct" id="_af_bsod_pct">0% complete</p></div>`;
const _af_toastsHTML=`<div id="_af_toasts"></div>`;
const _af_crackHTML=`<canvas id="_af_crack_canvas"></canvas>`;
const _af_cursorHTML=`<canvas id="_af_cursor_canvas"></canvas>`;
const _af_jsHTML=`<img id="_af_js_img" class="_af_js_img" src="" alt="">`;

document.body.insertAdjacentHTML('beforeend',_af_playerHTML+_af_bsodHTML+_af_toastsHTML+_af_crackHTML+_af_cursorHTML+_af_jsHTML);

const _aud=new Audio('April_Fools.mp3');
_aud.loop=true;
_aud.volume=parseFloat(localStorage.getItem('_af_vol')?? '0.5');

const _pl=document.getElementById('_af_player');
const _st=document.getElementById('_af_status');
const _tog=document.getElementById('_af_tog');
const _vol=document.getElementById('_af_vol');
_vol.value=_aud.volume;

let _volT;
_vol.oninput=e=>{
  _aud.volume=parseFloat(e.target.value);
  localStorage.setItem('_af_vol',e.target.value);
  clearTimeout(_volT);
  _volT=setTimeout(()=>{
    _aud.volume=0.5;_vol.value=0.5;
    localStorage.setItem('_af_vol','0.5');
    _toast('nice try. volume reset 😂');
  },2000);
};

_tog.onclick=()=>_aud.paused?_aud.play():_aud.pause();
_aud.onplay=()=>{_st.textContent='▶ playing';_tog.textContent='stop';};
_aud.onpause=()=>{_st.textContent='⏸ paused';_tog.textContent='play';};
setInterval(()=>{if(!_aud.paused)localStorage.setItem('_af_time',_aud.currentTime);},500);

let _drag=false,_dx,_dy;
_pl.onmousedown=e=>{
  if(e.target===_vol||e.target===_tog)return;
  _drag=true;_dx=e.clientX-_pl.offsetLeft;_dy=e.clientY-_pl.offsetTop;
};
document.addEventListener('mousemove',e=>{
  if(!_drag)return;
  _pl.style.left=(e.clientX-_dx)+'px';_pl.style.top=(e.clientY-_dy)+'px';
  _pl.style.bottom='auto';_pl.style.right='auto';
});
document.addEventListener('mouseup',()=>_drag=false);

function _startAud(){
  _pl.style.display='block';
  _aud.currentTime=0;
  _aud.play().catch(()=>{
    _st.textContent=' click to unmute';
    const u=()=>{_aud.play();document.removeEventListener('click',u);};
    document.addEventListener('click',u);
  });
}

const _stime=localStorage.getItem('_af_start');
if(!_stime){
  localStorage.setItem('_af_start',Date.now());
  _st.textContent=' 15s...';
  setTimeout(()=>{localStorage.setItem('_af_active','1');_startAud();},15000);
} else if(localStorage.getItem('_af_active')==='1'){
  _startAud();
} else {
  const _rem=15000-(Date.now()-parseInt(_stime));
  if(_rem<=0){localStorage.setItem('_af_active','1');_startAud();}
  else{_st.textContent=' soon...';setTimeout(()=>{localStorage.setItem('_af_active','1');_startAud();},_rem);}
}

let _tc=0,_tt;
_pl.querySelector('._af_title').addEventListener('click',()=>{
  _tc++;clearTimeout(_tt);_tt=setTimeout(()=>_tc=0,1200);
  if(_tc>=5){_tc=0;_aud.playbackRate=_aud.playbackRate===1?1.3:1;_toast(_aud.playbackRate>1?'🎵 sped up lmao':'back to normal speed');}
});

function _toast(msg){
  const t=document.createElement('div');
  t.className='_af_toast';t.textContent=msg;
  document.getElementById('_af_toasts').appendChild(t);
  setTimeout(()=>t.remove(),3100);
}

const _cCanvas=document.getElementById('_af_cursor_canvas');
const _cCtx=_cCanvas.getContext('2d');
function _resizeCursor(){_cCanvas.width=window.innerWidth;_cCanvas.height=window.innerHeight;}
_resizeCursor();
window.addEventListener('resize',_resizeCursor);
const _parts=[];
document.addEventListener('mousemove',e=>{
  for(let i=0;i<3;i++){
    _parts.push({x:e.clientX,y:e.clientY,vx:(Math.random()-.5)*2,vy:(Math.random()-.5)*2-1,life:1,c:['🌿','RL','IS','🗑️'][Math.floor(Math.random()*4)]});
  }
});
(function _animC(){
  _cCtx.clearRect(0,0,_cCanvas.width,_cCanvas.height);
  for(let i=_parts.length-1;i>=0;i--){
    const p=_parts[i];p.x+=p.vx;p.y+=p.vy;p.vy+=.05;p.life-=.04;
    if(p.life<=0){_parts.splice(i,1);continue;}
    _cCtx.globalAlpha=p.life;_cCtx.font='14px serif';_cCtx.fillText(p.c,p.x,p.y);
  }
  _cCtx.globalAlpha=1;
  requestAnimationFrame(_animC);
})();

let _gravActive=false;
function _gravity(){
  if(_gravActive)return;_gravActive=true;_toast('💀 gravity enabled');
  const els=[...document.querySelectorAll('.profile-item,.sidebar .menu li,h1,h2,h3,input,select,button:not(#_af_tog):not(#min-btn):not(#max-btn):not(#close-btn)')];
  els.forEach(el=>{
    const r=el.getBoundingClientRect();
    const dist=window.innerHeight-r.top+50;
    el.style.setProperty('--gy',dist+'px');
    el.style.setProperty('--gr',(Math.random()*80-40)+'deg');
    el.style.setProperty('--gd',(.5+Math.random()*.7)+'s');
    el.classList.add('_af_grav_item');
  });
  setTimeout(()=>{
    els.forEach(el=>{el.classList.remove('_af_grav_item');el.style.removeProperty('--gy');el.style.removeProperty('--gr');el.style.removeProperty('--gd');});
    _gravActive=false;_toast('gravity off. for now.');
  },4000);
}

let _bpct=0,_biv;
function _bsod(){
  const b=document.getElementById('_af_bsod');
  b.style.display='block';_bpct=0;
  const p=document.getElementById('_af_bsod_pct');
  clearInterval(_biv);
  _biv=setInterval(()=>{
    _bpct+=Math.floor(Math.random()*5)+1;
    if(_bpct>=100){
      _bpct=100;clearInterval(_biv);
      setTimeout(()=>{
        try{ipcRenderer.send('close-app');}catch(e){window.close();}
      },2000);
    }
    p.textContent=_bpct+'% complete';
  },100);
}

const _crCvs=document.getElementById('_af_crack_canvas');
const _crCtx=_crCvs.getContext('2d');
let _crActive=false;
function _crack(){
  if(_crActive)return;_crActive=true;
  _crCvs.width=window.innerWidth;_crCvs.height=window.innerHeight;
  _crCvs.style.display='block';
  const rng=(a,b)=>a+Math.random()*(b-a);
  const g=_crCtx.createRadialGradient(innerWidth/2,innerHeight/2,innerHeight*.2,innerWidth/2,innerHeight/2,innerHeight*.9);
  g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(0,0,0,0.6)');
  _crCtx.fillStyle=g;_crCtx.fillRect(0,0,innerWidth,innerHeight);
  const impacts=[{x:innerWidth*.38,y:innerHeight*.31},{x:innerWidth*.68,y:innerHeight*.15},{x:innerWidth*.12,y:innerHeight*.69}];
  _crCtx.strokeStyle='rgba(255,255,255,.85)';_crCtx.lineWidth=1.5;_crCtx.shadowColor='rgba(255,255,200,.5)';_crCtx.shadowBlur=3;
  impacts.forEach(({x,y})=>{
    const arms=8+Math.floor(Math.random()*5);
    for(let i=0;i<arms;i++){
      const ang=(i/arms)*Math.PI*2+rng(-.3,.3);const len=rng(60,230);
      let cx=x,cy=y,rem=len;
      _crCtx.beginPath();_crCtx.moveTo(cx,cy);
      for(let s=0,segs=Math.floor(rng(3,7));s<segs;s++){
        const sg=rng(14,rem*.6),dr=rng(-.4,.4);
        cx+=Math.cos(ang+dr)*sg;cy+=Math.sin(ang+dr)*sg;
        _crCtx.lineTo(cx,cy);rem-=sg;if(rem<10)break;
        if(Math.random()<.4){const ba=ang+rng(.4,1.2)*(Math.random()<.5?1:-1);_crCtx.moveTo(cx,cy);_crCtx.lineTo(cx+Math.cos(ba)*rng(20,75),cy+Math.sin(ba)*rng(20,75));_crCtx.moveTo(cx,cy);}
      }
      _crCtx.stroke();
    }
    _crCtx.beginPath();_crCtx.arc(x,y,rng(4,9),0,Math.PI*2);_crCtx.strokeStyle='rgba(255,255,255,.95)';_crCtx.lineWidth=2;_crCtx.stroke();
    _crCtx.strokeStyle='rgba(255,255,255,.85)';_crCtx.lineWidth=1.5;
  });
  _toast('oh no you broke the screen');
  setTimeout(()=>{
    _crCvs.style.pointerEvents='auto';_crCvs.style.cursor='pointer';
    _crCvs.onclick=()=>{_crCvs.style.display='none';_crCvs.style.pointerEvents='none';_crActive=false;_toast('screen fixed. probably.');};
  },800);
}
window.addEventListener('resize',()=>{if(_crActive){_crCvs.width=innerWidth;_crCvs.height=innerHeight;}});

const _jsEl=document.getElementById('_af_js_img');
let _jsShowing=false;
function _jumpscare(){
  if(_jsShowing)return;_jsShowing=true;
  _jsEl.src='data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="%23002200"/><text x="50%" y="45%" text-anchor="middle" font-size="120" font-family="serif">👻</text><text x="50%" y="75%" text-anchor="middle" font-size="28" fill="%2300ff00" font-family="Comic Sans MS,cursive">BOO!</text></svg>';
  _jsEl.style.cssText=`position:fixed;z-index:99999999;pointer-events:none;display:block;width:300px;height:300px;left:${Math.random()*(innerWidth-300)}px;top:${Math.random()*(innerHeight-300)}px;animation:none;`;
  _jsEl.style.transform='scale(1)';
  document.body.style.animation='_afScr .08s 3';
  const ss=document.createElement('style');
  ss.textContent='@keyframes _afScr{0%,100%{filter:none}50%{filter:invert(1) hue-rotate(90deg)}}';
  document.head.appendChild(ss);
  setTimeout(()=>{_jsEl.style.display='none';_jsShowing=false;document.body.style.animation='';},1200);
}

const _fakePopupData=[
  {title:'Windows Security Alert',icon:'⚠️',body:'Your Minecraft launcher has been detected as suspicious software. Virus: <b>DIRT_BLOCK_TROJAN</b><br><br>Your computer will send your data to TG and Muaves in 30 seconds.',btns:['Panic','Ignore','Delete Minecraft']},
  {title:'Dirtstone Update Required',icon:'',body:'A critical update is available:<br><b>Dirtstone Launcher v67.420.69</b><br><br>This update adds even more green and removes the close button permanently.',btns:['Update Now','Update Later','No thanks','Update Anyway']},
  {title:'Java Runtime Error',icon:'☕',body:'<b>java.lang.GrassBlockException:</b><br>The selected instance has too much redstone.<br>Please remove all redstone before continuing.<br><br>Error code: 0xDIRT',btns:['OK','Also OK','Not OK']},
  {title:'Microsoft Account Required',icon:'',body:'You must sign in with a Microsoft account to continue.<br><br>Also your account has been temporarily banned for excessive grass placement.<br><br>Ban expires: April 2nd 2026',btns:['Sign In','Appeal Ban','Buy Minecraft Again']},
  {title:'Disk Full Warning',icon:'💾',body:'Your disk is full. Dirtstone Launcher has detected <b>847 GB</b> of dirt blocks stored on your hard drive.<br><br>Please delete some dirt to continue.',btns:['Delete Dirt','Keep Dirt','What is Dirt']},
  {title:'Critical Error',icon:'',body:'The launcher has encountered a fatal exception:<br><b>NullPointerException: user.brain not found</b><br><br>Sending crash report to Notch...',btns:['OK','Also send to Herobrine']},
  {title:'Congratulations! ',icon:'',body:'You are the <b>1,000,000th visitor!</b><br><br>You have won a FREE Minecraft cape!<br><br>Please enter your Microsoft account password to claim your prize.',btns:['Claim Prize','Too good to be true']},
  {title:'RAM Upgrade Needed',icon:'',body:'Dirtstone Launcher requires more RAM.<br><br>Current RAM: <b>why is it all dirt</b><br>Required RAM: <b>yes</b><br><br>Please insert 64 dirt blocks into your RAM slot.',btns:['OK','Buy More Dirt']},
];

let _fpDrag=false,_fpDX,_fpDY,_fpEl=null;
function _fakePopup(){
  const d=_fakePopupData[Math.floor(Math.random()*_fakePopupData.length)];
  const fp=document.createElement('div');
  fp.className='_af_fakepopup';
  fp.style.cssText=`left:${100+Math.random()*(innerWidth-400)}px;top:${100+Math.random()*(innerHeight-250)}px;`;
  const btns=d.btns.map(b=>`<button onclick="this.closest('._af_fakepopup').remove()">${b}</button>`).join('');
  fp.innerHTML=`<div class="_fptitle"><span>${d.icon} ${d.title}</span><span class="_fpx">✕</span></div><div class="_fpbody">${d.body}</div><div class="_fpbtns">${btns}</div>`;
  fp.querySelector('._fpx').onclick=()=>fp.remove();
  const titleBar=fp.querySelector('._fptitle');
  titleBar.addEventListener('mousedown',e=>{
    _fpDrag=true;_fpEl=fp;
    _fpDX=e.clientX-fp.offsetLeft;_fpDY=e.clientY-fp.offsetTop;
  });
  document.addEventListener('mousemove',e=>{
    if(!_fpDrag||!_fpEl)return;
    _fpEl.style.left=(e.clientX-_fpDX)+'px';_fpEl.style.top=(e.clientY-_fpDY)+'px';
  });
  document.addEventListener('mouseup',()=>{_fpDrag=false;_fpEl=null;});
  document.body.appendChild(fp);
}

let _wobbing=false,_lx=0,_lt=0,_shacc=0;
document.addEventListener('mousemove',e=>{
  const now=Date.now(),dist=Math.abs(e.clientX-_lx),dt=Math.max(1,now-_lt);
  const spd=dist/dt*1000;_lx=e.clientX;_lt=now;
  if(spd>1600)_shacc+=dist;else _shacc=Math.max(0,_shacc-8);
  if(_shacc>600&&!_wobbing){
    _wobbing=true;_shacc=0;
    document.body.style.animation='_afWob .12s linear infinite';
    _toast('STOP SHAKING THE LAUNCHER');
    setTimeout(()=>{document.body.style.animation='';_wobbing=false;_toast('ok fine');},3500);
  }
});

const _KONAMI=['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let _ki=0;
document.addEventListener('keydown',e=>{
  if(e.key===_KONAMI[_ki]){_ki++;if(_ki===_KONAMI.length){_ki=0;_party();}}else _ki=0;
  if(e.key==='F8'){e.preventDefault();_gravity();}
  if(e.key==='F9'){e.preventDefault();_bsod();}
  if(e.key==='F7'){e.preventDefault();_crack();}
  if(e.key==='F6'){e.preventDefault();_jumpscare();}
});

function _party(){
  _toast('PARTY MODE');
  const em=['L','🌿','L','🌿','L','🌿','L','🌿'];
  let n=0;const iv=setInterval(()=>{
    const el=document.createElement('div');
    el.textContent=em[Math.floor(Math.random()*em.length)];
    el.style.cssText=`position:fixed;font-size:${24+Math.random()*24}px;pointer-events:none;left:${Math.random()*90}vw;top:-2em;z-index:9999996;animation:_afFall ${1.5+Math.random()*2}s linear forwards;`;
    document.body.appendChild(el);setTimeout(()=>el.remove(),4000);
    if(++n>=80)clearInterval(iv);
  },60);
}

let _closeN=0,_closeTim;
const _closeBtn=document.getElementById('close-btn');
if(_closeBtn){
  _closeBtn.addEventListener('click',e=>{
    e.stopPropagation();_closeN++;
    clearTimeout(_closeTim);_closeTim=setTimeout(()=>_closeN=0,1200);
    if(_closeN===2)_toast("you can't close this that easily ");
    if(_closeN===3)_fakePopup();
    if(_closeN===4)_bsod();
    if(_closeN===5)_jumpscare();
    if(_closeN>=7){try{ipcRenderer.send('close-app');}catch(e){window.close();}}
  });
}

const _fakeErrs=[
  '§ java.lang.NullPointerException: this is fine',
  '§ OutOfMemoryError: we ran out of dirt',
  '§ FATAL: too much green. shutting down.',
  '§ Exception in thread "main" lol',
  '§ Segfault (april core dumped)',
  '§ Error 404: minecraft.jar not found. have you tried turning it off?',
  '§ WARN: your grass block usage is above recommended levels',
  '§ CRITICAL: herobrine detected in chunk 0,0',
];
let _eI=0;
setInterval(()=>{if(Math.random()<.12){_toast(_fakeErrs[_eI++%_fakeErrs.length]);}},7000);

let _jsTimer;
function _scheduleJumpscare(){
  const delay=25000+Math.random()*40000;
  _jsTimer=setTimeout(()=>{
    _jumpscare();
    _scheduleJumpscare();
  },delay);
}
_scheduleJumpscare();

let _fpTimer;
function _scheduleFakePopup(){
  const delay=18000+Math.random()*30000;
  _fpTimer=setTimeout(()=>{
    _fakePopup();
    _scheduleFakePopup();
  },delay);
}
setTimeout(_scheduleFakePopup,12000);

const _hint=document.createElement('div');
_hint.style.cssText='position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-family:Comic Neue,Comic Sans MS,cursive;font-size:10px;color:#004400;pointer-events:none;z-index:9999;letter-spacing:1px;';
_hint.textContent='april fools 2026  •  F6 F7 F8 F9  •  konami code';
document.body.appendChild(_hint);

})();