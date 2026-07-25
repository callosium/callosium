// ── Callosium · first-run "quick tour" coach-marks ──
// Guided spotlight bubbles that introduce the dashboard shell in a logical order.
// Contract: exposes global startCoach() (called by the app after first login) and
// window.startCoach (so a Settings "replay tour" can re-run it). Renders into the
// existing #coach overlay. Reuses shared globals (state, esc, px, nav, t); every
// helper here is namespaced coach_* and never redefines those globals.

// Bilingual: prefer the app's global t(en,ar); fall back to state.lang if it's absent
// so the tour still speaks the right language before t() ships. This does NOT redefine t.
function coach_t(en, ar){
  try{ if(typeof t === 'function') return t(en, ar); }catch(_){}
  return (typeof state === 'object' && state && state.lang === 'ar') ? ar : en;
}

const coach_TOUR_KEY = 'callosium_tour_v1';
const coach_state = { steps:[], idx:0, active:false, bound:false };
let coach_rzT = null;

// ── overlay ── (use the existing #coach; create it if the app hasn't yet, so replay always works)
function coach_overlay(){
  let ov = document.getElementById('coach');
  if(!ov){
    ov = document.createElement('div');
    ov.id = 'coach';
    ov.style.cssText = 'position:fixed;inset:0;z-index:70;display:none';
    (document.getElementById('app') || document.body).appendChild(ov);
  }
  return ov;
}

// ── live target resolvers ── (DOM re-renders between screens, so resolve on demand)
// Walk up to the element that is a direct child of #screen (used to grab whole rows).
function coach_childOfScreen(el){
  const screen = document.getElementById('screen');
  if(!screen || !el) return null;
  let cur = el;
  while(cur && cur.parentElement && cur.parentElement !== screen) cur = cur.parentElement;
  return (cur && cur.parentElement === screen) ? cur : null;
}
function coach_navRail(){ return document.querySelector('#app aside') || document.getElementById('nav'); }
function coach_vitals(){ return coach_childOfScreen(document.getElementById('vnum0')); }
function coach_terminal(){ const b = document.getElementById('termBody'); return b ? b.parentElement : null; }
function coach_partitions(){
  const term = coach_terminal();
  const grid = term && term.parentElement;      // the 1.4fr / 1fr row
  return grid ? (grid.children[1] || null) : null; // partitions is the second panel
}
function coach_quickActions(){
  const btn = document.querySelector('#screen .qa-hot, #screen .qa');
  return btn ? btn.parentElement : null;         // the quick-action button row
}
function coach_search(){ return document.getElementById('search'); }
function coach_reindex(){ return document.getElementById('reindexBtn'); }

// ── step definitions ── (title/body are functions so t() re-evaluates per current lang)
function coach_buildSteps(){
  return [
    { target: coach_navRail,
      title: ()=>coach_t('your destinations','وجهاتك'),
      body:  ()=>coach_t('seven destinations — click any to move around.',
                         'سبع وجهات — انقر أيّها للتنقل.') },
    { target: coach_vitals,
      title: ()=>coach_t("your brain's vitals",'مؤشّرات دماغك'),
      body:  ()=>coach_t("your brain's vitals at a glance.",
                         'مؤشّرات دماغك الحيوية بلمحة واحدة.') },
    { target: coach_terminal,
      title: ()=>coach_t('live activity','النشاط الحيّ'),
      body:  ()=>coach_t('everything your AIs do, live — click any line to jump to that note.',
                         'كل ما تفعله أدواتك الذكية، مباشرةً — انقر أيّ سطر للانتقال إلى تلك الملاحظة.') },
    { target: coach_partitions,
      title: ()=>coach_t('your folders','مجلّداتك'),
      body:  ()=>coach_t('your folders — Private stays yours alone.',
                         'مجلّداتك — يبقى «الخاص» لك وحدك.') },
    { target: coach_quickActions,
      title: ()=>coach_t('quick actions','إجراءات سريعة'),
      body:  ()=>coach_t('one-tap shortcuts to get things done.',
                         'اختصارات بنقرة واحدة لإنجاز الأمور.') },
    { target: coach_search,
      title: ()=>coach_t('search your brain','ابحث في دماغك'),
      body:  ()=>coach_t('search, or press Enter to Ask your brain.',
                         'ابحث، أو اضغط Enter لتسأل دماغك.') },
    { target: coach_reindex,
      title: ()=>coach_t('re-index','إعادة الفهرسة'),
      body:  ()=>coach_t('rebuild the index after big changes.',
                         'أعد بناء الفهرس بعد التغييرات الكبيرة.') },
    { final: true,
      title: ()=>coach_t("that's the tour",'انتهت الجولة'),
      body:  ()=>coach_t('explore freely — everything stays on this device.',
                         'استكشف بحرية — كل شيء يبقى على هذا الجهاز.') },
  ];
}

// ── counters ── (only spotlight steps are numbered; the final card is a summary)
function coach_spotlightCount(){ return coach_state.steps.filter(s=>!s.final).length; }
function coach_spotlightIndex(){
  let c = 0;
  for(let i=0;i<coach_state.idx;i++){ if(!coach_state.steps[i].final) c++; }
  return c;
}

// ── entry point ──
function startCoach(){
  // Overview must be the active, rendered screen before we can point at its panels.
  if(typeof state === 'object' && state && state.screen !== 'overview' && typeof nav === 'function'){
    nav('overview');
  }
  // Build the run, dropping spotlight steps whose target isn't on screen right now.
  const all = coach_buildSteps();
  const kept = all.filter(s => s.final || (typeof s.target === 'function' && s.target()));
  coach_state.steps = kept.length ? kept : all.filter(s=>s.final);
  coach_state.idx = 0;
  coach_state.active = true;

  const ov = coach_overlay();
  ov.innerHTML = '';
  ov.style.display = 'block';
  ov.style.pointerEvents = 'auto';   // capture clicks so the app is inert during the tour
  // a11y: the tour is a modal dialog: focus moves into the bubble, the app
  // behind leaves the tab order (inert), Escape dismisses, focus returns on close.
  coach_state.invoker = document.activeElement;
  const shell = document.getElementById('shellMain');
  if(shell){ try{ shell.inert = true; }catch(_){} shell.setAttribute('inert',''); }
  const skip = document.getElementById('skipLink');
  if(skip){ try{ skip.inert = true; }catch(_){} skip.setAttribute('inert',''); }
  ov.setAttribute('role','dialog');
  ov.setAttribute('aria-modal','true');
  ov.setAttribute('aria-label', coach_t('quick tour','جولة سريعة'));
  ov.setAttribute('tabindex','-1');

  if(!coach_state.bound){
    window.addEventListener('keydown', coach_onKey, true);
    window.addEventListener('resize', coach_onResize);
    coach_state.bound = true;
  }
  coach_render();
}
window.startCoach = startCoach;

// ── render the current step ──
function coach_render(){
  if(!coach_state.active) return;
  const ov = coach_overlay();
  const step = coach_state.steps[coach_state.idx];
  if(!step){ coach_finish(); return; }

  let scrim = ov.querySelector('.coach-scrim');
  if(!scrim){ scrim = document.createElement('div'); scrim.className = 'coach-scrim'; ov.appendChild(scrim); }

  if(step.final){ coach_renderFinal(ov, scrim, step); coach_focusStep(); return; }

  const el = step.target && step.target();
  if(!el){ coach_advance(1); return; }           // vanished since start — skip gracefully

  try{ el.scrollIntoView({ block:'nearest', inline:'nearest' }); }catch(_){}
  const rect = el.getBoundingClientRect();
  coach_paintScrim(scrim, rect);
  coach_paintBubble(ov, step, rect);
  coach_focusStep();
}

// move keyboard focus to the step's primary action so the dialog is operable
// the moment it appears (the window-level key handler keeps ←/→/Esc working).
function coach_focusStep(){
  const ov = document.getElementById('coach'); if(!ov) return;
  const btn = ov.querySelector('.coach-next') || ov.querySelector('.coach-done') || ov.querySelector('.coach-skip');
  if(btn){ try{ btn.focus({preventScroll:true}); }catch(_){ } }
}

// Spotlight = a padded rect over the target; the massive box-shadow dims everything
// outside it (the "hole"), and the synapse ring + glow frames it. Transitions animate
// the box gliding from one target to the next for a calm feel.
function coach_paintScrim(scrim, rect){
  const pad = 6;
  const sx = Math.max(0, rect.left - pad), sy = Math.max(0, rect.top - pad);
  const sw = Math.min(window.innerWidth, rect.right + pad) - sx;
  const sh = Math.min(window.innerHeight, rect.bottom + pad) - sy;
  scrim.style.cssText =
    'position:fixed;left:'+sx+'px;top:'+sy+'px;width:'+sw+'px;height:'+sh+'px;'
    + 'border-radius:0;pointer-events:none;z-index:1;'
    + 'box-shadow:0 0 0 9999px rgba(4,3,8,.72),0 0 0 2px var(--synapse),0 0 26px -2px var(--synapse);'
    + 'transition:left .3s cubic-bezier(.4,0,.2,1),top .3s cubic-bezier(.4,0,.2,1),'
    + 'width .3s cubic-bezier(.4,0,.2,1),height .3s cubic-bezier(.4,0,.2,1)';
}

function coach_btnStyle(primary){
  const base = 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;'
    + 'padding:7px 13px;border-radius:0;cursor:pointer;transition:.14s;';
  return base + (primary
    ? 'border:1px solid var(--synapse);background:var(--synapse);color:var(--on-accent);font-weight:600;'
    : 'border:1px solid var(--edge2);background:transparent;color:var(--dust);');
}

function coach_bubbleHTML(step){
  const isRTL = typeof state === 'object' && state && state.lang === 'ar';
  const counter = (coach_spotlightIndex()+1) + ' / ' + coach_spotlightCount();
  const showBack = coach_state.idx > 0;
  return '<div class="coach-bubble" dir="'+(isRTL?'rtl':'ltr')+'" style="position:fixed;z-index:2;'
    + 'max-width:300px;width:max-content;background:var(--surface);border:1px solid var(--edge2);'
    + 'border-radius:0;box-shadow:0 24px 60px -24px rgba(0,0,0,.85);padding:15px 16px 13px;'
    + 'opacity:0;animation:rise .32s ease forwards;font-family:var(--sans)">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
        + '<span style="width:7px;height:7px;border-radius:50%;background:var(--synapse);box-shadow:0 0 9px var(--synapse)"></span>'
        + '<span style="font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)">'+esc(counter)+'</span>'
      + '</div>'
      + '<div style="font-family:var(--pixel);font-weight:700;font-size:18px;letter-spacing:.01em;line-height:1.15;color:var(--starlight);margin-bottom:6px">'+esc(step.title())+'</div>'
      + '<div style="font-family:var(--mono);font-size:12px;line-height:1.55;color:var(--dust)">'+esc(step.body())+'</div>'
      + '<div style="display:flex;align-items:center;gap:8px;margin-top:14px">'
        + '<button class="coach-skip" style="'+coach_btnStyle(false)+'">'+esc(coach_t('skip tour','تخطّي الجولة'))+'</button>'
        + '<span style="flex:1"></span>'
        + (showBack ? '<button class="coach-back" style="'+coach_btnStyle(false)+'">'+esc(coach_t('back','رجوع'))+'</button>' : '')
        + '<button class="coach-next" style="'+coach_btnStyle(true)+'">'+esc(coach_t('next','التالي'))+'</button>'
      + '</div>'
    + '</div>';
}

function coach_paintBubble(ov, step, rect){
  const old = ov.querySelector('.coach-bubble'); if(old) old.remove();
  const holder = document.createElement('div');
  holder.innerHTML = coach_bubbleHTML(step);
  const bubble = holder.firstElementChild;
  ov.appendChild(bubble);
  coach_bindButtons(bubble);
  coach_positionBubble(bubble, rect);
}

// Place the bubble adjacent to the target; auto-flip to whichever side has room.
function coach_positionBubble(bubble, rect){
  const gap = 14, vw = window.innerWidth, vh = window.innerHeight;
  const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
  const below = vh - rect.bottom, above = rect.top, right = vw - rect.right, left = rect.left;
  let side;
  if(below >= bh + gap) side = 'bottom';
  else if(above >= bh + gap) side = 'top';
  else if(right >= bw + gap) side = 'right';
  else if(left  >= bw + gap) side = 'left';
  else { const m = Math.max(below, above, right, left);
    side = m===below?'bottom':m===above?'top':m===right?'right':'left'; }

  let x, y;
  if(side==='bottom' || side==='top'){
    x = rect.left + rect.width/2 - bw/2;
    y = side==='bottom' ? rect.bottom + gap : rect.top - bh - gap;
  } else {
    x = side==='right' ? rect.right + gap : rect.left - bw - gap;
    y = rect.top + rect.height/2 - bh/2;
  }
  x = Math.max(gap, Math.min(x, vw - bw - gap));
  y = Math.max(gap, Math.min(y, vh - bh - gap));
  bubble.style.left = x + 'px';
  bubble.style.top  = y + 'px';
  coach_placeArrow(bubble, side, rect, x, y, bw, bh);
}

// A small rotated square that points from the bubble back to the target.
function coach_placeArrow(bubble, side, rect, x, y, bw, bh){
  const S = 10, half = S/2;
  const a = document.createElement('div');
  a.style.cssText = 'position:absolute;width:'+S+'px;height:'+S+'px;background:var(--surface);transform:rotate(45deg)';
  const clamp = (v, max) => Math.max(10, Math.min(v, max - 20));
  if(side==='bottom'){
    a.style.top = (-half)+'px'; a.style.borderLeft='1px solid var(--edge)'; a.style.borderTop='1px solid var(--edge)';
    a.style.left = clamp(rect.left + rect.width/2 - x - half, bw)+'px';
  } else if(side==='top'){
    a.style.bottom = (-half)+'px'; a.style.borderRight='1px solid var(--edge)'; a.style.borderBottom='1px solid var(--edge)';
    a.style.left = clamp(rect.left + rect.width/2 - x - half, bw)+'px';
  } else if(side==='right'){
    a.style.left = (-half)+'px'; a.style.borderLeft='1px solid var(--edge)'; a.style.borderBottom='1px solid var(--edge)';
    a.style.top = clamp(rect.top + rect.height/2 - y - half, bh)+'px';
  } else {
    a.style.right = (-half)+'px'; a.style.borderRight='1px solid var(--edge)'; a.style.borderTop='1px solid var(--edge)';
    a.style.top = clamp(rect.top + rect.height/2 - y - half, bh)+'px';
  }
  bubble.appendChild(a);
}

// ── final centered card ──
function coach_renderFinal(ov, scrim, step){
  const isRTL = typeof state === 'object' && state && state.lang === 'ar';
  scrim.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;'
    + 'background:rgba(4,3,8,.72);z-index:1;pointer-events:none;box-shadow:none';
  const old = ov.querySelector('.coach-bubble'); if(old) old.remove();
  const holder = document.createElement('div');
  const icon = (typeof px === 'function') ? px('overview', 20) : '';
  holder.innerHTML =
    '<div class="coach-bubble" dir="'+(isRTL?'rtl':'ltr')+'" style="position:fixed;left:50%;top:50%;'
    + 'transform:translate(-50%,-50%);z-index:2;width:min(90vw,380px);text-align:center;'
    + 'background:var(--surface);border:1px solid var(--edge2);border-radius:0;'
    + 'box-shadow:0 40px 90px -30px rgba(0,0,0,.9);padding:28px 26px 24px;opacity:0;animation:rise .34s ease forwards">'
      + '<div style="width:44px;height:44px;border:1px solid var(--edge2);border-radius:0;display:flex;'
        + 'align-items:center;justify-content:center;margin:0 auto 16px;background:var(--surface2);--icon:var(--synapse)">'+icon+'</div>'
      + '<div style="font-family:var(--pixel);font-weight:700;font-size:24px;line-height:1.1;color:var(--starlight);margin-bottom:8px">'+esc(step.title())+'</div>'
      + '<div style="font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--dust);margin-bottom:20px">'+esc(step.body())+'</div>'
      + '<button class="coach-done" style="'+coach_btnStyle(true)+'width:100%;padding:11px">'+esc(coach_t('done','تم'))+'</button>'
    + '</div>';
  const bubble = holder.firstElementChild;
  ov.appendChild(bubble);
  const done = bubble.querySelector('.coach-done'); if(done) done.onclick = coach_finish;
}

// ── button wiring ──
function coach_bindButtons(bubble){
  const n = bubble.querySelector('.coach-next'); if(n) n.onclick = coach_next;
  const b = bubble.querySelector('.coach-back'); if(b) b.onclick = coach_back;
  const s = bubble.querySelector('.coach-skip'); if(s) s.onclick = coach_skip;
}

// ── navigation ──
function coach_next(){ coach_advance(1); }
function coach_back(){ coach_advance(-1); }
function coach_advance(dir){
  let i = coach_state.idx + dir;
  while(i >= 0 && i < coach_state.steps.length){
    const s = coach_state.steps[i];
    if(s.final || (s.target && s.target())) break;   // skip steps whose target is gone
    i += dir;
  }
  if(i < 0) i = 0;
  if(i >= coach_state.steps.length){ coach_finish(); return; }
  coach_state.idx = i;
  coach_render();
}

function coach_skip(){ coach_end(); }
function coach_finish(){ coach_end(); }
function coach_end(){
  coach_state.active = false;
  const ov = document.getElementById('coach');
  if(ov){ ov.style.display = 'none'; ov.style.pointerEvents = ''; ov.innerHTML = ''; ov.removeAttribute('role'); ov.removeAttribute('aria-modal'); ov.removeAttribute('aria-label'); }
  if(coach_state.bound){
    window.removeEventListener('keydown', coach_onKey, true);
    window.removeEventListener('resize', coach_onResize);
    coach_state.bound = false;
  }
  try{ localStorage.setItem(coach_TOUR_KEY, '1'); }catch(_){}  // never auto-show again
  // lift the app out of inert, then put focus back where the tour found it
  // (auto-launch had no invoker, so the search box is the sensible home).
  const shell = document.getElementById('shellMain');
  if(shell){ try{ shell.inert = false; }catch(_){} shell.removeAttribute('inert'); }
  const skip = document.getElementById('skipLink');
  if(skip){ try{ skip.inert = false; }catch(_){} skip.removeAttribute('inert'); }
  const inv = coach_state.invoker; coach_state.invoker = null;
  const fallback = document.getElementById('search');
  const tgt = (inv && inv !== document.body && document.contains(inv)) ? inv : fallback;
  if(tgt && document.contains(tgt)){ try{ tgt.focus({preventScroll:true}); }catch(_){ } }
}

// ── keyboard: Esc = skip · → = next · ← = back · Tab trapped in the bubble ·
// Enter on a bubble button activates that button natively (Enter elsewhere
// still advances) ──
function coach_onKey(e){
  if(!coach_state.active) return;
  const onBtn = e.target && e.target.closest && e.target.closest('#coach button');
  if(e.key === 'Escape'){ e.preventDefault(); coach_skip(); }
  else if(e.key === 'Tab'){
    // inert strips the app from the tab order, but Chrome still wraps through
    // BODY between cycles, so trap Tab inside the bubble's own buttons instead.
    const ov = document.getElementById('coach'); if(!ov) return;
    const f = [...ov.querySelectorAll('button:not([disabled])')].filter(el=>el.getClientRects().length);
    if(!f.length) return;
    const first = f[0], last = f[f.length-1], active = document.activeElement;
    if(e.shiftKey && (active===first || !ov.contains(active))){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && (active===last || !ov.contains(active))){ e.preventDefault(); first.focus(); }
  }
  else if(e.key === 'ArrowRight'){
    e.preventDefault();
    const step = coach_state.steps[coach_state.idx];
    if(step && step.final) coach_finish(); else coach_next();
  }
  else if(e.key === 'ArrowLeft'){ e.preventDefault(); coach_back(); }
  else if(e.key === 'Enter' && !onBtn){
    e.preventDefault();
    const step = coach_state.steps[coach_state.idx];
    if(step && step.final) coach_finish(); else coach_next();
  }
}

// ── re-measure on resize (debounced) ──
function coach_onResize(){
  if(!coach_state.active) return;
  clearTimeout(coach_rzT);
  coach_rzT = setTimeout(coach_render, 120);
}
