// ── Onboarding journey ───────────────────────────────────────────────────────
// First-run flow that covers the shell: brain-art welcome → sign-up (dummy
// social) → brain setup (ingest an existing brain, or create one the AI fills
// via MCP). Renders into #onboard. Bilingual via the global t(en,ar). Calls the
// global enterApp() once the user is signed in AND a brain is connected.
// All state namespaced state.ob_*.

// ── the signature rotating ASCII brain (ported from the design system's
// ascii-brain.html; source image served locally at /assets/brain.png) ──
const OB_RAMP = ' .`:;~=+*x#%@';
const OB_SECTORS = [
  { x:0.92, y:0.22, r:0.55, col:'#FF2E88', w:0.55, ph:0.0 },
  { x:0.02, y:0.66, r:0.52, col:'#52F2B8', w:0.42, ph:1.7 },
  { x:-0.98, y:0.18, r:0.50, col:'#B44BFF', w:0.66, ph:3.1 },
  { x:0.18, y:-0.38, r:0.52, col:'#FF6B3D', w:0.49, ph:4.4 },
  { x:-0.88, y:-0.56, r:0.42, col:'#FFB454', w:0.60, ph:5.5 },
];
// light-theme palette for the same sectors (deepened so the brain reads on paper)
const OB_LIGHT_COLORS = { base1:'#5E5773', base2:'#141019', cal:'#E01670', sectors:['#E01670','#0E7A50','#7A2BD0','#C8401C','#8F6100'] };
function ob_hash(n){ n=(n^61)^(n>>>16); n=n+(n<<3); n=n^(n>>>4); n=Math.imul(n,0x27d4eb2d); return((n^(n>>>15))>>>0)/4294967296; }
function ob_stopBrain(){
  if(state.ob_brainIv){ clearInterval(state.ob_brainIv); state.ob_brainIv=null; }
  if(state.ob_flareIv){ clearInterval(state.ob_flareIv); state.ob_flareIv=null; }
}
function ob_startBrain(){
  ob_stopBrain();
  const cv = document.getElementById('obBrain'); if(!cv) return;
  const bg = cv.getContext('2d');
  const COLS=130, ROWS=42, CW=cv.width/COLS, CH=cv.height/ROWS;
  const AX=1.38, AY=0.98, PITCH=0.30, PCA=Math.cos(PITCH), PSA=Math.sin(PITCH), FOV=3.1;
  let pts = state.ob_pts || null, theta=0, bT=0;
  const flare = new Float32Array(OB_SECTORS.length);
  const zbuf=new Float32Array(COLS*ROWS), bbuf=new Float32Array(COLS*ROWS);
  const cbuf=new Uint8Array(COLS*ROWS), pbuf=new Float32Array(COLS*ROWS), sbuf=new Float32Array(COLS*ROWS);
  if(!pts){
    const img=new Image();
    img.onload=()=>{
      const FW=168,FH=104,sx=270,sy=10,sw=830,sh=750;
      const off=document.createElement('canvas'); off.width=FW; off.height=FH;
      const og=off.getContext('2d'); og.fillStyle='#000'; og.fillRect(0,0,FW,FH);
      const fscale=Math.min(FW/sw,FH/sh), fdw=Math.round(sw*fscale), fdh=Math.round(sh*fscale);
      const fdx=(FW-fdw)>>1, fdy=(FH-fdh)>>1;
      og.imageSmoothingEnabled=true; og.drawImage(img,sx,sy,sw,sh,fdx,fdy,fdw,fdh);
      const data=og.getImageData(0,0,FW,FH).data, L=new Float32Array(FW*FH);
      for(let i=0;i<FW*FH;i++) L[i]=(data[i*4]*0.299+data[i*4+1]*0.587+data[i*4+2]*0.114)/255;
      const dist=new Int16Array(FW*FH).fill(-1), q=[];
      for(let y=0;y<FH;y++)for(let x=0;x<FW;x++){ const i=y*FW+x; if(L[i]<0.07){ dist[i]=0; q.push(i); } }
      for(let h=0;h<q.length;h++){ const i=q[h],x=i%FW,y=(i/FW)|0;
        for(const[ox,oy]of[[1,0],[-1,0],[0,1],[0,-1]]){ const nx=x+ox,ny=y+oy; if(nx<0||nx>=FW||ny<0||ny>=FH)continue; const ni=ny*FW+nx; if(dist[ni]===-1){ dist[ni]=dist[i]+1; q.push(ni); } } }
      let maxD=1; for(let i=0;i<FW*FH;i++) if(dist[i]>maxD) maxD=dist[i];
      const P=[], N=3400; let tries=0;
      while(P.length<N && tries<N*40){ tries++;
        const x=(Math.random()*FW)|0,y=(Math.random()*FH)|0,i=y*FW+x,lum=L[i];
        if(lum<0.09||Math.random()>Math.pow(lum,1.1))continue;
        const u=(x-fdx)/fdw,v=(y-fdy)/fdh, px=(u-0.5)*2*AX, py=(0.5-v)*2*AY;
        const halfDepth=Math.sqrt(Math.max(0,dist[i])/maxD)*0.78;
        const cal=lum>0.5&&(((u-0.40)/0.27)**2+((v-0.39)/0.15)**2)<1;
        const z=cal?(Math.random()*2-1)*Math.min(0.15,halfDepth):(Math.random()*2-1)*halfDepth;
        let sec=-1,sw2=0;
        for(let s2=0;s2<OB_SECTORS.length;s2++){ const S=OB_SECTORS[s2]; const d2=((px-S.x)/S.r)**2+((py-S.y)/S.r)**2; const wgt=Math.exp(-d2*1.6); if(wgt>sw2){ sw2=wgt; sec=s2; } }
        P.push({px,py,z,lum,cal,sec,sw:sw2,phase:ob_hash(P.length)*6.28});
      }
      pts=P; state.ob_pts=P;
    };
    img.onerror=()=>{ /* offline / missing asset — the caption still welcomes */ };
    img.src='/assets/brain.png';
  }
  state.ob_flareIv = setInterval(()=>{ flare[(Math.random()*OB_SECTORS.length)|0]=1; }, 1700);
  const draw=()=>{
    bT+=0.06; bg.clearRect(0,0,cv.width,cv.height);
    if(!pts){ bg.font='12px monospace'; bg.fillStyle='#544E64'; bg.textAlign='center'; bg.fillText(t('waking the cortex…','يستيقظ الدماغ…'), cv.width/2, cv.height/2); bg.textAlign='left'; return; }
    theta+=0.016;
    const act=OB_SECTORS.map((S,i)=>{ flare[i]*=0.955; return Math.max(0,Math.min(1,0.30+0.30*Math.sin(bT*S.w+S.ph)+flare[i])); });
    zbuf.fill(-1e9); cbuf.fill(0); sbuf.fill(0);
    const ca=Math.cos(theta),sa=Math.sin(theta), SC=(COLS/2-2)/(AX+0.45), SR=(ROWS/2-1)/(AY+0.25);
    for(const p of pts){
      const xs=p.px*ca+p.z*sa, zs0=-p.px*sa+p.z*ca, ys=p.py*PCA-zs0*PSA, zs=p.py*PSA+zs0*PCA, persp=FOV/(FOV-zs);
      const c=(COLS/2+xs*SC*persp)|0, r=(ROWS/2-ys*SR*persp)|0;
      if(c<0||c>=COLS||r<0||r>=ROWS)continue;
      const i=r*COLS+c; if(zs<=zbuf[i])continue; zbuf[i]=zs;
      const shade=0.22+0.85*Math.max(0,Math.min(1,(zs+1.5)/3.0));
      bbuf[i]=Math.min(1,Math.pow(p.lum,0.72)*1.28*shade); pbuf[i]=p.phase;
      const a=p.sec>=0?act[p.sec]*p.sw:0;
      if(p.cal){ cbuf[i]=3; sbuf[i]=0; }
      else if(a>0.24){ cbuf[i]=4+p.sec; sbuf[i]=Math.min(1,a); bbuf[i]=Math.min(1,bbuf[i]+a*0.35); }
      else cbuf[i]=bbuf[i]>0.82?2:1;
    }
    bg.font='10px "JetBrains Mono",monospace'; bg.textBaseline='top';
    // theme-aware palette: the dark set washes out to invisible on paper
    const obLight = state.theme==='light';
    const colors = obLight
      ? [null, OB_LIGHT_COLORS.base1, OB_LIGHT_COLORS.base2, OB_LIGHT_COLORS.cal, ...OB_LIGHT_COLORS.sectors]
      : [null,'#9A93A8','#EFEDF2','#FF2E88',...OB_SECTORS.map(S=>S.col)];
    for(let ci=1;ci<colors.length;ci++){ bg.fillStyle=colors[ci];
      for(let r=0;r<ROWS;r++)for(let c=0;c<COLS;c++){ const i=r*COLS+c; if(cbuf[i]!==ci)continue;
        let alpha; if(ci===3)alpha=0.82+0.18*Math.sin(bT*1.5+pbuf[i]); else if(ci>=4)alpha=0.45+0.55*sbuf[i]; else if(ci===2)alpha=(obLight?0.9:0.78)+0.1*Math.sin(bT*0.7+pbuf[i]); else alpha=(obLight?0.8:0.55)+(obLight?0.2:0.28)*Math.sin(bT*0.9+pbuf[i]);
        const ch=OB_RAMP[Math.min(OB_RAMP.length-1,(bbuf[i]*(OB_RAMP.length-1))|0)]||'.';
        bg.globalAlpha=alpha; bg.fillText(ch===' '?'.':ch, c*CW, r*CH);
      } }
    bg.globalAlpha=1;
  };
  draw();
  // reduced motion: one settled frame, no rotation loop (the neuron below does
  // the same; the interval would spin the brain forever otherwise).
  if(!window.__reduceMotion) state.ob_brainIv=setInterval(draw, 85);
}

// ── signature motion: a neuron firing a signal down its axon and FILING A
// MEMORY at the synapse (faithful port of the design system's synapse-fire.html).
// Fully cancelable via state.ob_neuronStop; honors reduce-motion (one static
// "filed" frame, no loop). Internal 1000×300 coordinate space; CSS scales it. ──
function ob_stopNeuron(){ if(state.ob_neuronStop){ try{ state.ob_neuronStop(); }catch(_){}} state.ob_neuronStop=null; }
function ob_startNeuron(){
  ob_stopNeuron();
  const ncv = document.getElementById('obNeuron'); if(!ncv) return;
  const ng = ncv.getContext('2d');
  let alive = true;
  const NW=1000, NH=300;
  function makeGlow(size,stops){ const c=document.createElement('canvas'); c.width=c.height=size;
    const g=c.getContext('2d'), r=size/2, gr=g.createRadialGradient(r,r,0,r,r,r);
    for(const[o,col] of stops) gr.addColorStop(o,col); g.fillStyle=gr; g.fillRect(0,0,size,size); return c; }
  const G={ syn:makeGlow(96,[[0,'rgba(255,255,255,1)'],[0.22,'rgba(255,46,136,.75)'],[1,'rgba(255,46,136,0)']]),
    emb:makeGlow(96,[[0,'rgba(255,255,255,1)'],[0.22,'rgba(255,107,61,.75)'],[1,'rgba(255,107,61,0)']]),
    acid:makeGlow(96,[[0,'rgba(255,255,255,1)'],[0.22,'rgba(82,242,184,.7)'],[1,'rgba(82,242,184,0)']]),
    flash:makeGlow(512,[[0,'rgba(255,235,245,.9)'],[0.3,'rgba(255,46,136,.4)'],[1,'rgba(255,46,136,0)']]) };
  const glow=(g,sprite,x,y,r,a)=>{ if(a<=0.01)return; g.globalAlpha=Math.min(1,a); g.drawImage(sprite,x-r,y-r,r*2,r*2); };
  const SOMA={x:170,y:150}, HILL={x:205,y:150};
  const RNODES=[{x:320,y:138},{x:435,y:158},{x:550,y:140},{x:660,y:154}];
  const TERM={x:745,y:148}, POST={x:815,y:148};
  const AXPTS=[HILL,...RNODES,TERM];
  const anat=document.createElement('canvas'); anat.width=NW; anat.height=NH;
  (function(){ const g=anat.getContext('2d');
    g.strokeStyle='rgba(154,147,168,0.14)'; g.lineWidth=7; g.lineCap='round';
    for(let i=0;i<AXPTS.length-1;i++){ const a=AXPTS[i],b=AXPTS[i+1], mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      g.beginPath(); g.moveTo(a.x+(mx-a.x)*0.25,a.y+(my-a.y)*0.25); g.lineTo(b.x-(b.x-mx)*0.25,b.y-(b.y-my)*0.25); g.stroke(); }
    g.strokeStyle='rgba(255,46,136,0.18)'; g.lineWidth=1;
    g.beginPath(); g.moveTo(AXPTS[0].x,AXPTS[0].y); for(const p of AXPTS.slice(1))g.lineTo(p.x,p.y); g.stroke();
    g.strokeStyle='rgba(239,237,242,0.3)'; g.lineWidth=1;
    for(const n of RNODES)g.strokeRect(n.x-3,n.y-3,6,6);
    g.fillStyle='rgba(255,46,136,0.25)'; g.fillRect(SOMA.x-8,SOMA.y-8,16,16);
    g.strokeStyle='rgba(255,46,136,0.5)'; g.strokeRect(SOMA.x-8,SOMA.y-8,16,16);
    g.fillStyle='rgba(255,107,61,0.25)'; g.beginPath(); g.arc(TERM.x,TERM.y,9,0,7); g.fill();
    g.strokeStyle='rgba(255,107,61,0.5)'; g.stroke();
    g.fillStyle='rgba(82,242,184,0.22)'; g.fillRect(POST.x-6,POST.y-6,12,12);
    g.strokeStyle='rgba(82,242,184,0.45)'; g.strokeRect(POST.x-6,POST.y-6,12,12);
  })();
  const NS={dend:0,soma:0,charge:0,head:-1,headOn:0,term:0,flash:0,shake:0,post:0,postPulse:0,label:0};
  const nodeGlow=[0,0,0,0];
  const SPK=Array.from({length:220},()=>({dead:true}));
  const emit=(x,y,n,c,spread,speed)=>{ let made=0; for(const p of SPK){ if(!p.dead)continue;
    p.dead=false; p.x=x; p.y=y; const a=(Math.random()-0.5)*spread, s=speed*(0.5+Math.random());
    p.vx=Math.cos(a)*s; p.vy=Math.sin(a)*s*0.8; p.life=1; p.decay=0.03+Math.random()*0.04; p.c=c;
    if(++made>=n)break; } };
  const emitVesicles=()=>{ let made=0; for(const p of SPK){ if(!p.dead)continue;
    p.dead=false; p.x=TERM.x+4; p.y=TERM.y+(Math.random()-0.5)*10;
    p.vx=1.6+Math.random()*2.4; p.vy=(Math.random()-0.5)*1.4; p.life=1; p.decay=0.012+Math.random()*0.012; p.c='syn'; p.vesicle=true;
    if(++made>=90)break; } };
  const segLens=[]; let axTotal=0;
  for(let i=0;i<AXPTS.length-1;i++){ const l=Math.hypot(AXPTS[i+1].x-AXPTS[i].x,AXPTS[i+1].y-AXPTS[i].y); segLens.push(l); axTotal+=l; }
  const axPoint=(f)=>{ let d=f*axTotal; for(let i=0;i<segLens.length;i++){ if(d<=segLens[i]){ const t=d/segLens[i];
    return {x:AXPTS[i].x+(AXPTS[i+1].x-AXPTS[i].x)*t,y:AXPTS[i].y+(AXPTS[i+1].y-AXPTS[i].y)*t}; } d-=segLens[i]; }
    return {...AXPTS[AXPTS.length-1]}; };
  const nodeFr=[]; { let acc=0; for(let i=0;i<segLens.length-1;i++){ acc+=segLens[i]; nodeFr.push(acc/axTotal); } }
  let jitTick=0, jit=[];
  const jitter=(n)=>{ if(jitTick++%3===0){ jit=Array.from({length:n},()=>(Math.random()-0.5)); } return jit; };
  let firstOpaque=0;
  function frame(){
    ng.globalCompositeOperation='source-over'; ng.globalAlpha=1;
    if(++firstOpaque%40===0){ ng.fillStyle='#080710'; ng.fillRect(0,0,NW,NH); }
    else{ ng.fillStyle='rgba(8,7,16,0.22)'; ng.fillRect(0,0,NW,NH); }
    ng.save(); if(NS.shake>0.2)ng.translate((Math.random()-0.5)*NS.shake,(Math.random()-0.5)*NS.shake);
    ng.globalAlpha=1; ng.drawImage(anat,0,0);
    ng.globalCompositeOperation='lighter';
    if(NS.dend>0&&NS.dend<1){
      const DEN=[[{x:40,y:60},{x:110,y:95},SOMA],[{x:30,y:150},{x:100,y:150},SOMA],[{x:45,y:245},{x:115,y:200},SOMA]];
      for(const d of DEN){ const t=NS.dend;
        const x=(1-t)*(1-t)*d[0].x+2*(1-t)*t*d[1].x+t*t*d[2].x, y=(1-t)*(1-t)*d[0].y+2*(1-t)*t*d[1].y+t*t*d[2].y;
        glow(ng,G.syn,x,y,7,0.5*t+0.15); } }
    glow(ng,G.syn,SOMA.x,SOMA.y,26,NS.soma*0.9); glow(ng,G.syn,SOMA.x,SOMA.y,60,NS.soma*0.35);
    glow(ng,G.emb,HILL.x,HILL.y,18,NS.charge);
    if(NS.headOn>0.01&&NS.head>=0){
      const headP=axPoint(NS.head), SAMP=26, js=jitter(SAMP+1);
      ng.strokeStyle='rgba(255,46,136,0.9)'; ng.lineWidth=1.6; ng.beginPath();
      const tail=Math.max(0,NS.head-0.16);
      for(let i=0;i<=SAMP;i++){ const f=tail+(NS.head-tail)*(i/SAMP), p=axPoint(f), env=Math.sin(Math.PI*(i/SAMP)), off=js[i]*5*env;
        if(i===0)ng.moveTo(p.x,p.y+off); else ng.lineTo(p.x,p.y+off); }
      ng.globalAlpha=NS.headOn; ng.stroke();
      for(let i=0;i<=SAMP;i+=3){ const f=tail+(NS.head-tail)*(i/SAMP), p=axPoint(f), tt=i/SAMP; glow(ng,G.syn,p.x,p.y,3+tt*9,tt*tt*NS.headOn); }
      glow(ng,G.syn,headP.x,headP.y,14,NS.headOn); glow(ng,G.syn,headP.x,headP.y,30,NS.headOn*0.45);
    }
    RNODES.forEach((n,i)=>{ glow(ng,G.emb,n.x,n.y,16,nodeGlow[i]); });
    glow(ng,G.emb,TERM.x,TERM.y,20,NS.term); glow(ng,G.emb,TERM.x,TERM.y,46,NS.term*0.4);
    glow(ng,G.acid,POST.x,POST.y,18,NS.post);
    if(NS.postPulse>0&&NS.postPulse<1){
      const PB=[[POST,{x:880,y:110},{x:955,y:75}],[POST,{x:890,y:150},{x:960,y:150}],[POST,{x:880,y:190},{x:950,y:225}]];
      for(const d of PB){ const t=NS.postPulse;
        const x=(1-t)*(1-t)*d[0].x+2*(1-t)*t*d[1].x+t*t*d[2].x, y=(1-t)*(1-t)*d[0].y+2*(1-t)*t*d[1].y+t*t*d[2].y;
        glow(ng,G.acid,x,y,6,0.6*(1-t)+0.2); } }
    for(const p of SPK){ if(p.dead)continue; p.x+=p.vx; p.y+=p.vy; p.vx*=0.95; p.vy*=0.95; p.life-=p.decay;
      if(p.vesicle)p.vy+=(TERM.y-p.y)*0.002;
      if(p.life<=0){ p.dead=true; p.vesicle=false; continue; }
      glow(ng,G[p.c],p.x,p.y,2.5+p.life*3,p.life); }
    if(NS.flash>0.01){ glow(ng,G.flash,TERM.x+20,TERM.y,150,NS.flash);
      ng.globalAlpha=NS.flash*0.35; ng.fillStyle='#FFD9EC'; ng.fillRect(0,0,NW,NH); }
    ng.restore(); ng.globalCompositeOperation='source-over'; ng.globalAlpha=1;
    ng.font='600 12px "Space Grotesk",sans-serif'; ng.fillStyle='rgba(206,200,220,0.9)';
    ng.fillText('S O M A',SOMA.x-24,SOMA.y+32); ng.fillText('N O D E S   O F   R A N V I E R',388,100);
    ng.fillText('S Y N A P S E',TERM.x-38,TERM.y+34); ng.fillText('N E X T   N E U R O N',POST.x+26,POST.y+46);
    if(NS.label>0.02){ ng.font='700 14px "JetBrains Mono",monospace'; ng.fillStyle='rgba(82,242,184,'+NS.label+')';
      ng.fillText('[ MEMORY FILED ]',TERM.x-46,44); }
  }
  const tween=(obj,key,to,dur,ease,delay)=> new Promise(res=>{
    const start=performance.now()+((delay||0)*1000), from=obj[key];
    function step(now){ if(!alive){ res(); return; } if(now<start){ requestAnimationFrame(step); return; }
      const t=Math.min(1,(now-start)/(dur*1000)), e=ease?ease(t):t; obj[key]=from+(to-from)*e;
      if(t<1)requestAnimationFrame(step); else res(); }
    requestAnimationFrame(step); });
  const easeIn=t=>t*t, easeOut=t=>1-(1-t)*(1-t), backOut=t=>{ const c=1.7; return 1+(c+1)*Math.pow(t-1,3)+c*Math.pow(t-1,2); };
  async function fire(){
    if(!alive)return;
    Object.assign(NS,{dend:0,soma:0,charge:0,head:-1,headOn:0,term:0,flash:0,shake:0,post:0,postPulse:0,label:0}); nodeGlow.fill(0);
    await Promise.all([tween(NS,'dend',1,0.55,easeIn),tween(NS,'soma',1,0.3,easeIn,0.3)]); if(!alive)return;
    await tween(NS,'charge',1,0.16,backOut); NS.charge=0; NS.head=0; NS.headOn=1;
    const stops=[...nodeFr,1];
    for(let i=0;i<stops.length;i++){ if(!alive)return;
      await tween(NS,'head',stops[i],0.10+0.02*i,easeIn);
      if(i<nodeFr.length){ const n=RNODES[i]; nodeGlow[i]=1; tween(nodeGlow,i,0,0.7,easeOut); emit(n.x,n.y,6,'emb',Math.PI*2,2.2); }
      NS.soma=Math.max(0,0.6-i*0.15); await new Promise(r=>setTimeout(r,55)); }
    if(!alive)return; await tween(NS,'term',1,0.3,backOut); NS.headOn=0;
    NS.flash=0.95; NS.shake=6; emitVesicles(); emit(TERM.x,TERM.y,20,'syn',Math.PI*2,3.5);
    tween(NS,'flash',0,0.7,t=>1-Math.pow(1-t,4)); tween(NS,'shake',0,0.35,easeOut);
    await tween(NS,'post',1,0.35,backOut); if(!alive)return;
    tween(NS,'label',1,0.2); tween(NS,'postPulse',1,0.8,easeIn);
    await new Promise(r=>setTimeout(r,600)); tween(NS,'term',0,0.6); tween(NS,'post',0.25,0.6);
    await new Promise(r=>setTimeout(r,900)); tween(NS,'label',0,0.5); tween(NS,'post',0,0.5); tween(NS,'soma',0,0.5);
  }
  // reduce-motion: paint ONE settled frame with the memory filed, then stop.
  if(window.__reduceMotion){
    Object.assign(NS,{soma:0.5,term:1,post:1,label:1}); frame(); alive=false;
    state.ob_neuronStop=()=>{ alive=false; }; return;
  }
  let raf=0, autoFire=0;
  const loopDraw=()=>{ if(!alive)return; frame(); raf=requestAnimationFrame(loopDraw); };
  const loopFire=()=>{ if(!alive)return; fire(); autoFire=setTimeout(loopFire,6400); };
  loopDraw(); loopFire();
  state.ob_neuronStop=()=>{ alive=false; if(raf)cancelAnimationFrame(raf); if(autoFire)clearTimeout(autoFire); };
}

// The onboarding backdrop: the same 48px grid ("square background") + radial
// synapse glow the cockpit uses, so the welcome flow isn't a bland black void.
// Pure CSS (no rAF) — cheap, and it sits BEHIND the content layer on every view.
function ob_backdrop(){
  return '<div aria-hidden="true" style="position:absolute;inset:0;z-index:0;pointer-events:none;'
      + 'background-image:linear-gradient(var(--edge) 1px,transparent 1px),linear-gradient(90deg,var(--edge) 1px,transparent 1px);'
      + 'background-size:48px 48px;opacity:.14;'
      + '-webkit-mask-image:radial-gradient(ellipse 95% 85% at 50% 34%,#000 18%,transparent 82%);'
      + 'mask-image:radial-gradient(ellipse 95% 85% at 50% 34%,#000 18%,transparent 82%)"></div>'
    + '<div aria-hidden="true" style="position:absolute;inset:0;z-index:0;pointer-events:none;'
      + 'background:radial-gradient(ellipse 72% 56% at 50% 30%,rgba(255,46,136,.06),transparent 60%),radial-gradient(ellipse 50% 40% at 82% 78%,rgba(82,242,184,.045),transparent 60%)"></div>';
}

// ── frame + shared bits ──
function ob_wordmark(){
  return '<div style="display:flex;align-items:center;justify-content:center;gap:11px;font-family:var(--pixel);font-weight:700;letter-spacing:.12em;font-size:22px;color:var(--starlight)">'
    + '<span style="width:11px;height:11px;background:var(--synapse);box-shadow:0 0 14px var(--synapse);animation:seampulse 3.2s ease-in-out infinite"></span>CALLOSIUM</div>';
}
function ob_langToggle(){
  const seg=(v,label)=>{ const on=state.lang===v; return '<button type="button" data-ob-lang="'+v+'" aria-pressed="'+(on?'true':'false')+'" style="cursor:pointer;font-family:var(--mono);font-size:11px;padding:5px 12px;border-radius:0;transition:.12s;color:'+(on?'var(--on-accent)':'var(--dust)')+';background:'+(on?'var(--synapse)':'transparent')+';border:0">'+label+'</button>'; };
  return '<div style="position:absolute;top:20px;'+(state.lang==='ar'?'left':'right')+':22px;display:flex;gap:3px;border:1px solid var(--edge2);border-radius:0;padding:3px;background:var(--surface)" role="group" aria-label="language">'+seg('en','EN')+seg('ar','ع')+'</div>';
}

// ── VIEW: hero (brain art + intro) ──
function ob_heroHTML(){
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;position:relative">'
    + ob_langToggle()
    + '<canvas id="obBrain" width="820" height="420" style="width:min(600px,72vw);height:auto;display:block;margin-bottom:4px"></canvas>'
    + ob_wordmark()
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:clamp(30px,5vw,46px);line-height:1.05;margin:18px 0 12px;color:var(--starlight)">'+t('one brain. every AI. your files.','دماغ واحد. لكل ذكاء اصطناعي. ملفاتك أنت.')+'</h1>'
    + '<p style="max-width:52ch;color:var(--dust);font-size:15px;line-height:1.7;margin-bottom:22px">'+t('Callosium turns your notes into a memory every AI can share — read and write, only where you allow. It lives on your disk. No cloud, no account with us holding your files, works with the wi-fi off.','يحوّل كالوسيوم ملاحظاتك إلى ذاكرة يتشاركها كل ذكاء اصطناعي تستخدمه — يقرأ ويكتب فقط حيث تسمح. كل شيء على قرصك. بلا سحابة، ويعمل بدون إنترنت.')+'</p>'
    // signature motion — an AI firing a signal down the axon and FILING A MEMORY
    + '<div class="on-console" style="width:min(720px,92vw);margin:0 auto 26px;border:1px solid var(--edge2);border-radius:0;overflow:hidden;background:#080710;box-shadow:0 20px 60px -30px rgba(255,46,136,.35)">'
      + '<div style="display:flex;align-items:center;gap:9px;padding:7px 13px;border-bottom:1px solid var(--edge)">'
        + '<span style="width:7px;height:7px;border-radius:50%;background:var(--synapse);box-shadow:0 0 8px var(--synapse);animation:seampulse 3.2s ease-in-out infinite"></span>'
        + '<span style="font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)">'+t('how your brain remembers','كيف يتذكّر دماغك')+'</span>'
        + '<span style="flex:1"></span>'
        + '<span style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;color:var(--faint)">'+t('an AI files a memory','ذكاء اصطناعي يحفظ ذكرى')+'</span>'
      + '</div>'
      + '<canvas id="obNeuron" width="1000" height="300" style="display:block;width:100%;height:auto;background:#080710"></canvas>'
    + '</div>'
    + '<button data-ob="signup" style="font-family:var(--pixel);font-weight:600;font-size:15px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:14px 30px;border-radius:0;cursor:pointer;transition:.15s" onmouseover="this.style.background=\'var(--synapse)\';this.style.color=\'var(--on-accent)\';this.style.boxShadow=\'0 0 28px -6px var(--synapse)\'" onmouseout="this.style.background=\'transparent\';this.style.color=\'var(--synapse-ink)\';this.style.boxShadow=\'none\'">'+t('get started','ابدأ')+' →</button>'
    + '<div style="font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:22px">'+t('local-first · private · bilingual','محلي أولًا · خاص · ثنائي اللغة')+'</div>'
    + '</div>';
}

// Brand marks for the sign-in providers (inline SVG — no external asset).
const OB_PROVIDER_LOGO = {
  google: '<svg width="17" height="17" viewBox="0 0 48 48" style="flex-shrink:0"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  apple: '<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--starlight)" style="flex-shrink:0"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>',
  github: '<svg width="16" height="16" viewBox="0 0 24 24" fill="var(--dust)" style="flex-shrink:0"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58C20.56 22.3 24 17.8 24 12.5 24 5.87 18.63.5 12 .5z"/></svg>',
};

// ── VIEW: sign-up. Real Supabase Auth (Google/Apple/GitHub OAuth or email);
// the free/local path is "continue as guest" (no account, notes never leave). ──
function ob_signupHTML(){
  const prov=(id,label)=> '<button data-ob-oauth="'+id+'" style="display:flex;align-items:center;justify-content:center;gap:11px;width:100%;font-family:var(--sans);font-weight:600;font-size:14px;color:var(--starlight);background:var(--surface2);border:1px solid var(--edge2);border-radius:0;padding:13px;cursor:pointer;transition:.13s;margin-bottom:10px" onmouseover="this.style.borderColor=\'var(--dust)\'" onmouseout="this.style.borderColor=\'var(--edge2)\'">'+OB_PROVIDER_LOGO[id]+'<span>'+label+'</span></button>';
  const err = state.ob_err ? '<div role="alert" style="font-family:var(--mono);font-size:11px;color:var(--danger);margin-top:10px;text-align:center;line-height:1.5">'+esc(state.ob_err)+'</div>' : '';
  const msg = state.ob_authMsg ? '<div role="status" style="font-family:var(--mono);font-size:11.5px;color:var(--acid);margin-top:10px;text-align:center;line-height:1.5">'+esc(state.ob_authMsg)+'</div>' : '';
  const busy = state.ob_authBusy;
  const inp = 'width:100%;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:12px 14px;font-family:var(--sans);font-size:14px;color:var(--starlight);box-sizing:border-box';
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;position:relative">'
    + ob_langToggle()
    + '<div style="width:420px;max-width:100%;text-align:center">'
    + ob_wordmark()
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:30px;margin:20px 0 8px">'+t('welcome in.','أهلًا بك.')+'</h1>'
    + '<p style="color:var(--dust);font-size:13.5px;line-height:1.6;margin-bottom:22px">'+t('sign in to save your place and sync across devices later. your notes always stay on this device.','سجّل الدخول لحفظ مكانك والمزامنة بين الأجهزة لاحقًا. ملاحظاتك تبقى دائمًا على هذا الجهاز.')+'</p>'
    + prov('google', t('Continue with Google','المتابعة عبر Google'))
    + prov('apple', t('Continue with Apple','المتابعة عبر Apple'))
    + prov('github', t('Continue with GitHub','المتابعة عبر GitHub'))
    + '<div style="display:flex;align-items:center;gap:10px;margin:16px 0"><span style="flex:1;height:1px;background:var(--edge)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--faint)">'+t('or with email','أو عبر البريد')+'</span><span style="flex:1;height:1px;background:var(--edge)"></span></div>'
    + '<input id="obName" placeholder="'+t('your name (optional)','اسمك (اختياري)')+'" aria-label="'+t('your name (optional)','اسمك (اختياري)')+'" style="'+inp+';margin-bottom:9px">'
    + '<input id="obEmail" type="email" autocomplete="email" placeholder="'+t('email','البريد الإلكتروني')+'" aria-label="'+t('email','البريد الإلكتروني')+'" style="'+inp+';margin-bottom:9px">'
    + '<input id="obPassword" type="password" autocomplete="new-password" placeholder="'+t('password','كلمة المرور')+'" aria-label="'+t('password','كلمة المرور')+'" style="'+inp+';margin-bottom:12px">'
    + '<button data-ob-email="1"'+(busy?' disabled':'')+' style="width:100%;font-family:var(--pixel);font-weight:600;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--on-accent);background:var(--synapse);border:1px solid var(--synapse);border-radius:0;padding:13px;cursor:'+(busy?'default':'pointer')+';opacity:'+(busy?'.6':'1')+'">'+(busy?t('working…','...جارٍ'):t('continue with email','المتابعة بالبريد'))+'</button>'
    + '<div style="display:flex;align-items:center;gap:10px;margin:16px 0"><span style="flex:1;height:1px;background:var(--edge)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--faint)">'+t('or','أو')+'</span><span style="flex:1;height:1px;background:var(--edge)"></span></div>'
    + '<button data-ob-signup="guest" style="width:100%;font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dust);background:transparent;border:1px solid var(--edge2);border-radius:0;padding:12px;cursor:pointer">'+t('continue as guest — stay fully local','المتابعة كضيف — محلي بالكامل')+'</button>'
    + msg + err
    + '<div style="font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:20px;line-height:1.6">'+t('an account is only for syncing and plans — the free app is fully local and never needs one.','الحساب فقط للمزامنة والخطط — التطبيق المجاني محلي بالكامل ولا يحتاج حسابًا أبدًا.')+'</div>'
    + '<div style="margin-top:14px"><button type="button" data-ob="hero" style="font-family:var(--mono);font-size:11px;color:var(--faint);cursor:pointer;background:none;border:0;padding:0">← '+t('back','رجوع')+'</button></div>'
    + '</div></div>';
}

// ── VIEW: setup choice (existing vs create) ──
function ob_choiceHTML(){
  const card=(id,icon,title,desc,cta)=> '<button type="button" data-ob="'+id+'" style="flex:1;min-width:240px;border:1px solid var(--edge2);border-radius:0;background:var(--surface);padding:26px 24px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;text-align:left;font-family:inherit;color:inherit" onmouseover="this.style.borderColor=\'var(--synapse)\';this.style.background=\'rgba(255,46,136,.04)\'" onmouseout="this.style.borderColor=\'var(--edge2)\';this.style.background=\'var(--surface)\'">'
    + '<div style="width:46px;height:46px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;background:var(--surface2);--icon:var(--synapse);margin-bottom:16px">'+icon+'</div>'
    + '<div style="font-family:var(--pixel);font-weight:600;font-size:20px;margin-bottom:8px">'+title+'</div>'
    + '<p style="color:var(--dust);font-size:13.5px;line-height:1.6;flex:1;margin-bottom:16px">'+desc+'</p>'
    + '<span style="font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--synapse)">'+cta+' →</span></button>';
  const name = state.account && state.account.name ? esc(state.account.name) : t('there','مرحبًا');
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;position:relative">'
    + ob_langToggle()
    + '<div style="width:720px;max-width:100%">'
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:32px;text-align:center;margin-bottom:8px">'+t('hey '+name+' — let’s connect your brain.','أهلًا '+name+' — لنوصل دماغك.')+'</h1>'
    + '<p style="color:var(--dust);font-size:14px;text-align:center;max-width:56ch;margin:0 auto 30px">'+t('three ways in — pick the one that matches where your stuff lives today.','ثلاث طرق للبدء — اختر ما يناسب مكان ملاحظاتك اليوم.')+'</p>'
    + '<div style="display:flex;gap:16px;flex-wrap:wrap">'
    + card('existing', px('notes',22), t('I already have notes','لديّ ملاحظات بالفعل'), t('an Obsidian vault or any folder of Markdown. Callosium reads it, connects it, and learns what it means.','مكتبة Obsidian أو أي مجلد Markdown. يقرأه كالوسيوم ويربطه ويتعلّم معناه.'), t('choose a folder','اختر مجلدًا'))
    + card('raw', px('inbox',22), t('I have raw stuff','لديّ ملفات غير مرتّبة'), t('messy text, exports, half-finished notes. Drop them in the Inbox and your AI reads, files, and links everything for you.','نصوص فوضوية وملفات مبعثرة. أسقطها في الوارد وسيقرؤها ذكاؤك ويرتّبها ويربطها عنك.'), t('build from my mess','ابنِ من فوضاي'))
    + card('blank', px('plus',22), t('Start empty','ابدأ من الصفر'), t('nothing yet? We set up the structure and hand your AI an interview: it asks about you, your work, and your people — and writes your first memories.','لا شيء بعد؟ نُجهّز البنية ويبدأ ذكاؤك بمقابلة معك: يسألك عنك وعن عملك وأشخاصك — ويكتب ذكرياتك الأولى.'), t('start the interview','ابدأ المقابلة'))
    + '</div>'
    + '<div style="text-align:center;margin-top:24px"><button type="button" data-ob="signout" style="font-family:var(--mono);font-size:11px;color:var(--faint);cursor:pointer;background:none;border:0;padding:0">'+t('sign out','تسجيل الخروج')+'</button></div>'
    + '</div></div>';
}

// ── folder picker (shared by existing + create) ──
function ob_pickerHTML(titleEn, titleAr, ctaEn, ctaAr, mode){
  const b = state.ob_browse || { dir:'', parent:null, dirs:[], mdHere:0 };
  const sel = state.ob_selected;
  // NOTE: hover styling is done in ob_wire via addEventListener — NEVER build
  // inline on* handlers from folder paths (esc() doesn't neutralise ' and the
  // handler runs in the page origin → XSS from a crafted folder name).
  const rows = (b.dirs||[]).map(d=> '<button type="button" class="ob-dir" data-ob-dir="'+esc(d.path)+'" data-ob-sel="'+(d.path===sel?'1':'0')+'" style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:0;cursor:pointer;font-family:var(--mono);font-size:12.5px;color:'+(d.path===sel?'var(--starlight)':'var(--dust)')+';background:'+(d.path===sel?'var(--surface2)':'transparent')+';width:100%;border:0;text-align:left"><span style="color:var(--synapse-ink)">▸</span>'+esc(d.name)+'</button>').join('') || '<div style="padding:14px;font-family:var(--mono);font-size:11.5px;color:var(--faint)">'+t('no sub-folders here','لا مجلدات فرعية هنا')+'</div>';
  const info = state.ob_inspect ? (state.ob_inspect.notes+' '+t('notes found','ملاحظة') + (state.ob_inspect.hasSchema?' · '+t('existing brain','دماغ موجود'):'')) : '';
  const canUse = mode==='create' ? !!sel : (state.ob_inspect && (state.ob_inspect.notes>0));
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;position:relative">'
    + ob_langToggle()
    + '<div style="width:560px;max-width:100%">'
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:28px;text-align:center;margin-bottom:8px">'+t(titleEn,titleAr)+'</h1>'
    + '<p style="color:var(--dust);font-size:13.5px;text-align:center;margin-bottom:20px">'+t('everything stays on this device.','كل شيء يبقى على هذا الجهاز.')+'</p>'
    + '<div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);overflow:hidden">'
    + '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--edge);background:var(--surface2)">'
    + (b.parent? '<button type="button" data-ob-dir="'+esc(b.parent)+'" style="cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--synapse-ink);background:none;border:0;padding:0">↑ '+t('up','أعلى')+'</button>' : '')
    + '<span style="flex:1;font-family:var(--mono);font-size:11px;color:var(--dust);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr;text-align:'+(state.lang==='ar'?'right':'left')+'">'+esc(b.dir||t('choose…','اختر…'))+'</span></div>'
    + '<div style="max-height:280px;overflow:auto;padding:8px">'+rows+'</div>'
    + (info? '<div style="padding:10px 14px;border-top:1px solid var(--edge);font-family:var(--mono);font-size:11.5px;color:var(--acid)">'+esc(info)+'</div>':'')
    + '</div>'
    // paste-a-path escape hatch — clicking down through OneDrive/Dropbox trees is
    // painful; let the user paste the exact folder (copy it from the address bar
    // in File Explorer) and jump straight there.
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<input id="obPath" spellcheck="false" autocomplete="off" placeholder="'+t('or paste a folder path here…','أو ألصق مسار مجلد هنا…')+'" aria-label="'+t('folder path','مسار المجلد')+'" value="'+esc(b.dir||'')+'" style="flex:1;min-width:0;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:10px 12px;font-family:var(--mono);font-size:12px;color:var(--starlight);box-sizing:border-box;direction:ltr">'
    + '<button data-ob-goto="1" style="font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:10px 16px;border-radius:0;cursor:pointer;white-space:nowrap">'+t('go','اذهب')+'</button>'
    + '</div>'
    + '<div style="display:flex;gap:10px;margin-top:18px;justify-content:center">'
    + '<button data-ob="choice" style="font-family:var(--mono);font-size:12px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:12px 18px;border-radius:0;cursor:pointer">'+t('back','رجوع')+'</button>'
    + '<button data-ob-use="'+mode+'" '+(canUse?'':'disabled')+' style="font-family:var(--pixel);font-weight:600;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:'+(canUse?'var(--synapse-ink)':'var(--faint)')+';background:transparent;padding:12px 22px;border-radius:0;cursor:'+(canUse?'pointer':'default')+';opacity:'+(canUse?'1':'.5')+'">'+t(ctaEn,ctaAr)+'</button>'
    + '</div>'
    + (state.ob_err?'<div role="alert" style="font-family:var(--mono);font-size:11px;color:var(--danger);text-align:center;margin-top:12px">'+esc(state.ob_err)+'</div>':'')
    + '</div></div>';
}

// ── VIEW: ingest progress ──
function ob_ingestHTML(){
  const ph = state.ob_ingest || { step:'scan', label:t('reading your notes','نقرأ ملاحظاتك'), pct:0, stats:{} };
  const phases=[['scan',t('reading your notes','نقرأ ملاحظاتك')],['graph',t('connecting the dots','نربط النقاط')],['embed',t('learning what they mean','نتعلّم معناها')]];
  const idx = phases.findIndex(p=>p[0]===ph.step);
  const rows = phases.map((p,i)=>{ const st=i<idx?'done':i===idx?'run':'idle'; return '<div style="display:flex;align-items:center;gap:12px;padding:8px 2px;font-family:var(--mono);font-size:13.5px;color:'+(st==='done'?'var(--dust)':st==='run'?'var(--starlight)':'var(--faint)')+'"><span style="width:16px;text-align:center;color:'+(st==='done'?'var(--acid)':st==='run'?'var(--synapse)':'var(--faint)')+'">'+(st==='done'?'✓':st==='run'?'▸':'·')+'</span>'+p[1]+'</div>'; }).join('');
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px">'
    + '<div style="width:480px;max-width:100%">'
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:28px;text-align:center;margin-bottom:20px">'+t('building your brain','نبني دماغك')+'</h1>'
    + '<div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);padding:22px 24px">'
    + rows
    + '<div style="height:6px;background:var(--surface2);border-radius:0;overflow:hidden;margin:16px 0 8px;position:relative"><i style="display:block;height:100%;width:'+Math.round(ph.pct||0)+'%;background:var(--synapse);transition:width .2s"></i><i style="position:absolute;top:0;left:0;height:100%;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);animation:barflow 1.3s linear infinite"></i></div>'
    + (ph.label ? '<div style="font-family:var(--mono);font-size:11.5px;color:var(--dust);margin-top:8px">'+esc(ph.label)+'</div>' : '')
    + '<div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-top:10px">'+t('runs entirely offline on this device.','يعمل بالكامل دون إنترنت على هذا الجهاز.')+'</div>'
    + '</div>'
    // escape hatch — never trap the user on this screen if the stream stalls
    + '<div style="text-align:center;margin-top:18px"><button type="button" data-ob="cancelIngest" style="font-family:var(--mono);font-size:11.5px;color:var(--faint);cursor:pointer;border-bottom:1px dashed var(--edge);padding-bottom:1px;background:none;border-top:0;border-left:0;border-right:0">'+t('cancel','إلغاء')+'</button></div>'
    + '</div></div>';
}

// ── the copy-paste kickoff prompt handed to ANY AI: it connects over MCP, then
// (raw) files the unstructured notes you drop in, (blank) interviews you and
// writes your first memories, or (existing) tidies what's there and verifies
// recall. This is the "setup tool" payload — one per onboarding door. ──
function ob_kickoffPrompt(mode){
  const tools = 'get_map, get_filing_rules, recall, list_notes, read_note, write_note, append_note, overview, glossary, brain_check';
  if(mode==='blank'){
    return "You are now connected to my brand-new, EMPTY Callosium second brain through its MCP tools ("+tools+"). Give it its first memories by interviewing me:\n\n"
      + "1. First call get_filing_rules so you know this brain's note types, folders, and naming rules — file everything by those rules, don't invent your own structure.\n"
      + "2. Ask me a few questions at a time — never a wall of questions. Cover, in this order: who I am and what I do; the projects or ventures I'm working on right now and where each one stands; the key people around me; the tools and systems I use daily; my current goals and what's blocking them.\n"
      + "3. After each round of answers, save what you learned with write_note before asking more: a profile note about me, one per project, one per person, one per key tool — clear titles, the right note type, and [[wiki-links]] between them so the graph forms from day one. write_note auto-files a type that has a home (person→People/, knowledge→Knowledge/, initiative, memory…); for a note with no automatic home — your profile of me, or a client/project — pass an explicit `path` so it lands in the right folder instead of the Inbox.\n"
      + "4. When the basics are covered, run brain_check and fix anything it flags, then run 2–3 recall queries on things I just told you and show me the brain remembers them.\n"
      + "5. Finish by calling get_map and showing me the map of what my brain now contains and what I should add next.";
  }
  if(mode==='raw' || mode==='new'){
    return "You are now connected to my new Callosium second brain through its MCP tools ("+tools+"). I'm handing you my raw, unstructured material and I want YOU to structure it into the brain — you understand content far better than any rule engine, so you do the reading and distilling; the brain gives you the rules and files each note where you tell it.\n\n"
      + "1. First call get_map to see how this brain is organized, then get_filing_rules to learn exactly where each kind of note goes plus the SENSITIVE-topics rule, naming, frontmatter, and ground-truth rules. Follow them; do not invent your own structure.\n"
      + "2. I'll point you at my raw files (documents, chat exports, notes) — they'll be in the Inbox/ folder. Read them with list_notes + read_note.\n"
      + "3. Turn each into a DISTILLED note with write_note: clear title, the right note type, [[wiki-links]] to related notes. write_note auto-files a note to its home when the type has one (person→People/, knowledge→Knowledge/, plus initiative, memory, log, milestone, reference); when a note has NO automatic home — a client/project workspace, or a Home/MOC hub — pass an explicit `path` (write_note takes one) into the folder the filing rules named, or it falls to the Inbox. Obey the SENSITIVE rule strictly — anything touching health, medical, intimate, or identity matters (mine OR a family member's) goes in Private/, and a mixed source goes WHOLLY to Private/. For any authoritative/verbatim source (a PDF, spec, contract, export), follow the ground-truth protocol. Never dump a raw transcript as a note.\n"
      + "4. CREATE THE ENTITY NOTES: for EVERY person, client, project, or tool you referenced with [[Name]], create its own short note so NO [[link]] is left dangling — a person as type person (→ People/), a tool/topic as type knowledge (→ Knowledge/), and a client or project at an explicit `path` under its Work/Projects home (project has no auto-route, so name the path yourself). Call glossary/resolve first so you don't duplicate one.\n"
      + "5. WIRE THE HUBS: create a Home note and a short MOC (map-of-content) for each major topic (each client, each life area), each written at an explicit `path` (a hub has no auto-route), and link every note into a hub so NOTHING is an orphan — every note must be reachable from a hub.\n"
      + "6. Verify: run brain_check and fix until there are ZERO broken links (create any missing entity note) and no orphans (link them to a hub); list only what genuinely needs my decision. Finish by calling get_map and summarising how you organized everything and where it landed.";
  }
  return "You are now connected to my Callosium second brain through its MCP tools ("+tools+"). Help me tidy it and confirm it works:\n\n"
    + "1. Get oriented: call get_map to learn how it's organized, then overview and brain_check to see the current state and what needs attention.\n"
    + "2. For each issue brain_check reports — broken links, orphan notes that should connect, duplicate names — fix what you safely can with the write tools (get_filing_rules tells you where things belong), and list anything that needs my decision.\n"
    + "3. Whenever you add or edit a note, use write_note / append_note so it is filed in the right folder and attributed to you.\n"
    + "4. Verify: run 2–3 recall queries on topics you saw and confirm they return the right notes. Then summarise what you found, what you fixed, and what needs me.";
}
// the pairing config's server spec ({command,args,env}) regardless of key name
function ob_serverSpec(){
  const c = state.ob_pairConfig;
  if(c && c.mcpServers){ const v = Object.values(c.mcpServers)[0]; if(v) return v; }
  if(c && c.command) return c;
  return null;
}
// ── VIEW: connect an AI (BOTH paths land here) — per-AI setup guide + kickoff ──
function ob_connectHTML(){
  const mode = state.ob_setupMode || 'raw';
  const spec = ob_serverSpec();
  const prompt = ob_kickoffPrompt(mode);
  const head = mode==='existing' ? t('your notes are connected.','ملاحظاتك متّصلة.') : t('your brain is ready.','دماغك جاهز.');
  const sub = mode==='blank'
    ? t('now hand it to an AI: pick yours below, add Callosium, give it the standing rules — then the kickoff starts an interview that writes your first memories.','الآن سلّمه لذكاء اصطناعي: اختر ذكاءك، أضف كالوسيوم وأعطه القواعد الدائمة — ثم تبدأ التعليمات الأولى مقابلة تكتب ذكرياتك الأولى.')
    : mode==='existing'
    ? t('now hand it to an AI so it uses your brain automatically, every session. pick your AI below, add Callosium, and give it the standing rules — then the kickoff.','الآن سلّمه لذكاء اصطناعي ليستخدم دماغك تلقائيًا في كل جلسة. اختر ذكاءك، أضف كالوسيوم وأعطه القواعد الدائمة — ثم التعليمات الأولى.')
    : t('now hand it to an AI so it uses your brain automatically. pick your AI below, add Callosium, and give it the standing rules — then the kickoff files whatever you drop in the Inbox.','الآن سلّمه لذكاء اصطناعي ليستخدم دماغك تلقائيًا. اختر ذكاءك، أضف كالوسيوم وأعطه القواعد الدائمة — ثم ترتّب التعليمات الأولى ما تُسقطه في الوارد.');
  const kickBox = '<div class="on-console" style="border:1px solid var(--edge2);border-radius:0;overflow:hidden;background:var(--console);text-align:left;margin-bottom:14px">'
    + '<div style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--edge);background:rgba(20,16,25,.55)"><span style="font-family:var(--pixel);font-weight:600;font-size:11px;color:var(--synapse);margin-right:8px">3</span><span style="font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dust)">'+t('first message — kick it off','أول رسالة — ابدأ')+'</span>'
    + '<button data-ob-copyprompt style="margin-left:auto;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:5px 11px;border-radius:0;cursor:pointer">'+t('copy','نسخ')+'</button></div>'
    + '<pre style="margin:0;padding:12px 14px;max-height:170px;overflow:auto;font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--starlight);direction:ltr;white-space:pre-wrap;word-break:break-word">'+esc(prompt)+'</pre></div>';
  return '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px">'
    + '<div style="width:640px;max-width:100%;text-align:center">'
    + '<div style="width:48px;height:48px;border:1px solid var(--acid);border-radius:0;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:var(--acid);font-size:20px;background:rgba(82,242,184,.08)">✓</div>'
    + '<h1 style="font-family:var(--pixel);font-weight:700;font-size:28px;margin-bottom:8px">'+head+'</h1>'
    + '<p style="color:var(--dust);font-size:14px;line-height:1.6;margin-bottom:22px">'+sub+'</p>'
    + '<div style="text-align:left">' + callosiumGuideHTML(spec) + kickBox + '</div>'
    + '<button data-ob="enter" style="margin-top:6px;font-family:var(--pixel);font-weight:600;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:12px 24px;border-radius:0;cursor:pointer">'+t('explore the cockpit →','ادخل لوحة القيادة →')+'</button>'
    + '<div style="font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:14px">'+t('you can find this guide again any time under Agents → connect an AI.','يمكنك إيجاد هذا الدليل لاحقًا في الوكلاء ← وصّل ذكاءً.')+'</div>'
    + '</div></div>';
}

// ── dispatch + paint ──
function renderOnboard(phase){
  state.onboardPhase = phase;
  // Complete an OAuth redirect on first onboarding render — if the user is
  // returning from Google/Apple/GitHub, this picks up the session and proceeds.
  if(!state.ob_sbChecked) ob_checkSupabaseSession();
  if(!state.ob_view) state.ob_view = (phase==='setup') ? 'choice' : 'hero';
  const el = $('#onboard'); if(!el) return;
  el.style.display='block';
  el.setAttribute('dir', state.lang==='ar'?'rtl':'ltr');
  const v = state.ob_view;
  let view = '';
  if(v==='hero') view = ob_heroHTML();
  else if(v==='signup') view = ob_signupHTML();
  else if(v==='choice') view = ob_choiceHTML();
  else if(v==='existing') view = ob_pickerHTML('point to your notes','وجّه إلى ملاحظاتك','use this folder','استخدم هذا المجلد','existing');
  else if(v==='create') view = ob_pickerHTML('where should your brain live?','أين يعيش دماغك؟','create here','أنشئ هنا','create');
  else if(v==='ingest') view = ob_ingestHTML();
  else if(v==='connect' || v==='createdone') view = ob_connectHTML();
  // grid + glow backdrop behind a positioned content layer, so every view sits
  // on the "square background" instead of a bland black void.
  el.innerHTML = ob_backdrop() + '<div style="position:relative;z-index:1">'+view+'</div>';
  ob_wire();
  // On the connect step, mint the AI's private MCP connection automatically so the
  // config box fills in without an extra click.
  if((v==='connect' || v==='createdone') && !state.ob_pairConfig && !state.ob_pairing && !state.ob_preview) ob_doPair();
  // signature motions: the rotating ASCII brain + the memory-filing neuron run
  // ONLY on the hero; both are torn down on every other view (no leaked loops).
  if(v==='hero'){ ob_startBrain(); ob_startNeuron(); } else { ob_stopBrain(); ob_stopNeuron(); }
}
function ob_nav(v){ state.ob_err=null; state.ob_view=v; renderOnboard(state.onboardPhase); }

async function ob_browse(dir){
  try{ const r = await post('/api/browse', dir!=null?{path:dir}:{}); if(r.error){ state.ob_err=r.error; renderOnboard(state.onboardPhase); return; } state.ob_browse=r; state.ob_selected=r.dir; state.ob_err=null; }
  // short-circuit on failure — don't fall through and inspect a stale/undefined
  // path, which would mix an unrelated inspect result with the browse error.
  catch(e){ state.ob_err='couldn’t open that folder'; renderOnboard(state.onboardPhase); return; }
  // inspect the current dir for an existing brain / note count
  try{ const ins = await post('/api/inspect', { path: state.ob_selected }); state.ob_inspect = ins.error? null : ins; }catch(e){ state.ob_inspect=null; }
  renderOnboard(state.onboardPhase);
}
async function ob_selectDir(path){
  state.ob_selected = path;
  // surface a browse failure here too (mirrors ob_browse) — otherwise the folder
  // highlights as selected but the listing never updates, with no explanation.
  try{ const r = await post('/api/browse', { path }); if(!r.error){ state.ob_browse=r; state.ob_err=null; } else { state.ob_err=r.error; } }
  catch(e){ state.ob_err='couldn’t open that folder'; }
  try{ const ins = await post('/api/inspect', { path }); state.ob_inspect = ins.error? null : ins; }catch(e){ state.ob_inspect=null; }
  renderOnboard(state.onboardPhase);
}
// Close the live stream + clear the stall watchdog. Safe to call repeatedly.
function ob_ingestCleanup(){
  try{ if(state.ob_ingestES){ state.ob_ingestES.close(); state.ob_ingestES=null; } }catch(_){}
  if(state.ob_ingestWatchdog){ clearTimeout(state.ob_ingestWatchdog); state.ob_ingestWatchdog=null; }
  if(state.ob_enterTimer){ clearTimeout(state.ob_enterTimer); state.ob_enterTimer=null; } // cancel the pending enterApp()
}
// User-initiated cancel from the progress screen — back to the folder picker.
function ob_ingestCancel(){ ob_ingestCleanup(); state.ob_view='existing'; state.ob_err=null; renderOnboard(state.onboardPhase); }
function ob_ingestStream(){
  ob_ingestCleanup();  // never leave a prior stream/watchdog running
  state.ob_view='ingest'; state.ob_ingest={ step:'scan', label:'', pct:0 }; renderOnboard(state.onboardPhase);
  const es = new EventSource(CCT_Q('/api/ingest?path='+encodeURIComponent(state.ob_selected)));
  state.ob_ingestES = es;
  let notes=0;
  // Watchdog: if the server goes silent (hangs mid-ingest and never closes the
  // connection), the EventSource emits no 'error' either — so the screen would
  // hang forever. Every event resets it; 60s of total silence trips the same
  // failure path as an error, freeing the user from the dead-end.
  const bump = ()=>{ if(state.ob_ingestWatchdog) clearTimeout(state.ob_ingestWatchdog);
    state.ob_ingestWatchdog = setTimeout(()=>{ ob_ingestCleanup(); state.ob_err='ingest stalled — try again.'; state.ob_view='existing'; renderOnboard(state.onboardPhase); }, 60000); };
  bump();
  es.addEventListener('phase', e=>{ bump(); try{ const d=JSON.parse(e.data); state.ob_ingest.step=d.step; state.ob_ingest.label=''; state.ob_ingest.pct = d.step==='scan'?15:d.step==='graph'?45:70; renderOnboard(state.onboardPhase); }catch(_){} });
  es.addEventListener('stat', e=>{ bump(); try{ const d=JSON.parse(e.data); if(d.notes) notes=d.notes; }catch(_){} });
  es.addEventListener('embed', e=>{ bump(); try{ const d=JSON.parse(e.data); if(d.total){ state.ob_ingest.pct = 70 + Math.round((d.done/d.total)*28); renderOnboard(state.onboardPhase); } }catch(_){} });
  // first run only: the ~120MB language model downloads once — show it as a
  // download, not a mysterious hang at 70%.
  es.addEventListener('model', e=>{ bump(); try{ const d=JSON.parse(e.data); state.ob_ingest.label = d.label || ''; renderOnboard(state.onboardPhase); }catch(_){} });
  es.addEventListener('done', ()=>{ ob_ingestCleanup(); state.ob_ingest.pct=100; renderOnboard(state.onboardPhase); state.ob_setupMode='existing'; state.ob_enterTimer = setTimeout(()=>{ state.ob_enterTimer=null; ob_nav('connect'); }, 700); });
  es.addEventListener('error', ()=>{ ob_ingestCleanup(); state.ob_err='ingest didn’t finish — try again.'; state.ob_view='existing'; renderOnboard(state.onboardPhase); });
}
// Guest = fully local, no hosted account (just a local record so the shell has a name).
async function ob_doSignup(provider){
  const name = (document.getElementById('obName') && document.getElementById('obName').value.trim()) || '';
  try{
    const r = await post('/api/signup', { provider, name });
    if(r.error){ state.ob_err=r.error; renderOnboard(state.onboardPhase); return; }
    state.account = r.account; state.ob_err=null;
    if(hasBrain()) enterApp(); else ob_nav('choice');
  }catch(e){ state.ob_err='couldn’t continue — the engine didn’t answer.'; renderOnboard(state.onboardPhase); }
}
// OAuth sign-in via Supabase. Redirects away, returns to this origin, and the
// session is completed on the next onboarding render (ob_checkSupabaseSession).
async function ob_oauth(provider){
  const sb = await sbEnsure(); // loads the Supabase UMD on this first auth use
  if(!sb){ state.ob_err='sign-in is offline right now — check your connection, or continue as guest.'; renderOnboard(state.onboardPhase); return; }
  state.ob_err=null; state.ob_authMsg=null;
  try{
    const { error } = await sb.auth.signInWithOAuth({ provider, options:{ redirectTo: window.location.origin } });
    if(error){ state.ob_err = /not enabled/i.test(error.message) ? (provider+' sign-in isn’t enabled on the server yet — use email, or continue as guest.') : error.message; renderOnboard(state.onboardPhase); }
  }catch(e){ state.ob_err='couldn’t start sign-in — try again, or continue as guest.'; renderOnboard(state.onboardPhase); }
}
// Email + password: try to sign in (returning user), else sign up (new user).
async function ob_emailAuth(){
  const sb = await sbEnsure(); // loads the Supabase UMD on this first auth use
  if(!sb){ state.ob_err='sign-in is offline right now — continue as guest to stay local.'; renderOnboard(state.onboardPhase); return; }
  const g = id => { const el = document.getElementById(id); return el ? (el.value||'').trim() : ''; };
  const name = g('obName'), email = g('obEmail'), password = (document.getElementById('obPassword')||{}).value || '';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ state.ob_err='enter a valid email.'; renderOnboard(state.onboardPhase); return; }
  if(password.length < 6){ state.ob_err='password must be at least 6 characters.'; renderOnboard(state.onboardPhase); return; }
  state.ob_authBusy=true; state.ob_err=null; state.ob_authMsg=null; renderOnboard(state.onboardPhase);
  try{
    let { data, error } = await sb.auth.signInWithPassword({ email, password });
    if(error && /invalid login credentials/i.test(error.message)){
      const res = await sb.auth.signUp({ email, password, options:{ data:{ full_name:name } } });
      data = res.data; error = res.error;
      if(!error && !(data && data.session)){ state.ob_authBusy=false; state.ob_authMsg='almost there — check your email to confirm, then sign in.'; renderOnboard(state.onboardPhase); return; }
    }
    if(error){ state.ob_authBusy=false; state.ob_err=error.message; renderOnboard(state.onboardPhase); return; }
    state.ob_authBusy=false;
    await ob_syncSupabaseAccount(data && data.session);
  }catch(e){ state.ob_authBusy=false; state.ob_err='couldn’t sign you in — try again.'; renderOnboard(state.onboardPhase); }
}
// Bridge a Supabase session into the local account record so the shell shows
// "signed in as", then continue onboarding.
async function ob_syncSupabaseAccount(session){
  const sb = sbClient(); if(!sb) return;
  let user = session && session.user;
  if(!user){ try{ const { data } = await sb.auth.getUser(); user = data && data.user; }catch(e){} }
  if(!user) return;
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (user.email||'').split('@')[0] || 'you';
  try{ const r = await post('/api/signup', { provider:(user.app_metadata && user.app_metadata.provider) || 'email', name, email:user.email }); if(r && r.account) state.account = r.account; }catch(e){}
  state.ob_err=null; state.ob_authMsg=null;
  if(hasBrain()) enterApp(); else ob_nav('choice');
}
// Complete an OAuth redirect + pick up an existing session, once per load.
// The Supabase library is lazy-loaded, so first check whether THIS load could
// even have a session: an OAuth/PKCE redirect (?code= / #access_token) or a
// persisted sb-* token. If neither, skip the fetch entirely (guest path).
async function ob_checkSupabaseSession(){
  if(state.ob_sbChecked) return false; state.ob_sbChecked = true;
  const urlHasAuth = /[?&](code|error)=/.test(location.search) || /access_token=/.test(location.hash);
  let hasStored = false;
  try{ for(let i=0;i<localStorage.length;i++){ if(/^sb-.*-auth-token/.test(localStorage.key(i)||'')){ hasStored=true; break; } } }catch(e){}
  if(!urlHasAuth && !hasStored) return false;
  const sb = await sbEnsure(); if(!sb) return false;
  try{ const { data } = await sb.auth.getSession(); if(data && data.session){ await ob_syncSupabaseAccount(data.session); return true; } }catch(e){}
  return false;
}
async function ob_doInit(){
  try{
    const r = await post('/api/init', { path: state.ob_selected });
    if(r.error){ state.ob_err=r.error; renderOnboard(state.onboardPhase); return; }
    await loadOverview();
    state.ob_pairConfig=null; state.ob_setupMode = state.ob_createIntent || 'raw'; ob_nav('connect');
  }catch(e){ state.ob_err='couldn’t create the brain here.'; renderOnboard(state.onboardPhase); }
}
async function ob_doPair(){
  if(state.ob_pairing) return; // auto-triggered on the connect view — don't double-mint
  state.ob_pairing = true;
  try{ const r = await post('/api/pair', { id:'my-assistant', displayName:'My Assistant' }); if(r.error){ state.ob_err=r.error; } else { state.ob_pairConfig = r.config; } }
  catch(e){ state.ob_err='couldn’t create the connection.'; }
  state.ob_pairing = false;
  renderOnboard(state.onboardPhase);
}

function ob_wire(){
  const el = $('#onboard');
  el.querySelectorAll('[data-ob-lang]').forEach(x=> x.onclick=()=>applyLang(x.dataset.obLang));
  el.querySelectorAll('[data-ob]').forEach(x=> x.onclick=()=>{
    const to = x.dataset.ob;
    if(to==='signup') ob_nav('signup');
    else if(to==='hero') ob_nav('hero');
    else if(to==='choice') ob_nav('choice');
    else if(to==='existing'){ ob_nav('existing'); ob_browse(null); }
    // raw + blank share the create-a-brain picker; the door chosen decides
    // which kickoff prompt the connect step hands the AI.
    else if(to==='raw' || to==='blank' || to==='create'){ state.ob_createIntent = (to==='create') ? 'raw' : to; ob_nav('create'); ob_browse(null); }
    else if(to==='enter') enterApp();
    else if(to==='cancelIngest') ob_ingestCancel();
    else if(to==='signout'){ try{ const sb=sbClient(); if(sb) sb.auth.signOut(); }catch(e){} post('/api/signout',{}).then(()=>{ state.account=null; state.ob_sbChecked=false; ob_nav('hero'); }); }
  });
  el.querySelectorAll('[data-ob-signup]').forEach(x=> x.onclick=()=> ob_doSignup(x.dataset.obSignup));
  el.querySelectorAll('[data-ob-oauth]').forEach(x=> x.onclick=()=> ob_oauth(x.dataset.obOauth));
  const obEmailBtn = el.querySelector('[data-ob-email]'); if(obEmailBtn) obEmailBtn.onclick = ob_emailAuth;
  el.querySelectorAll('[data-ob-dir]').forEach(x=> x.onclick=()=> ob_selectDir(x.dataset.obDir));
  // paste-a-path box: jump straight to a typed/pasted folder (reuses ob_selectDir
  // so it navigates + inspects + enables "use" exactly like clicking a row).
  { const gotoBtn = el.querySelector('[data-ob-goto]'); const pathInp = el.querySelector('#obPath');
    const gotoPath = ()=>{ const v = pathInp && pathInp.value ? pathInp.value.trim() : ''; if(v) ob_selectDir(v); };
    if(gotoBtn) gotoBtn.onclick = gotoPath;
    if(pathInp) pathInp.addEventListener('keydown', ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); gotoPath(); } }); }
  el.querySelectorAll('.ob-dir').forEach(x=>{ // hover via listeners (no path-in-handler XSS)
    x.addEventListener('mouseenter', ()=>{ if(x.dataset.obSel!=='1') x.style.background='var(--surface2)'; });
    x.addEventListener('mouseleave', ()=>{ if(x.dataset.obSel!=='1') x.style.background='transparent'; });
  });
  el.querySelectorAll('[data-ob-use]').forEach(x=> x.onclick=()=>{ if(x.hasAttribute('disabled'))return; if(x.dataset.obUse==='create') ob_doInit(); else ob_ingestStream(); });
  const pairBtn = el.querySelector('[data-ob-pair]'); if(pairBtn) pairBtn.onclick=ob_doPair;
  const doCopy = (btn, text)=>{ if(!text) return; const ok=()=>{ btn.textContent='✓'; }; if(navigator.clipboard){ navigator.clipboard.writeText(text).then(ok).catch(()=>{ try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); ok(); }catch(_){} }); } };
  const copyPrompt = el.querySelector('[data-ob-copyprompt]'); if(copyPrompt) copyPrompt.onclick=()=> doCopy(copyPrompt, ob_kickoffPrompt(state.ob_setupMode||'raw'));
  // the shared per-AI setup guide (client picker + MCP config + rules copy)
  if(el.querySelector('[data-guide-client]') && window.callosiumGuideWire) callosiumGuideWire(el, ob_serverSpec(), ()=>renderOnboard(state.onboardPhase));
}
