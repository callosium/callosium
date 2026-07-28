// ── brain map ───────────────────────────────────────────────────────────────
// Constellation map of the whole brain, wired to the real local engine
// (GET /api/graph · lazy GET /api/note?path=…). Renders into #screen only;
// uses the shared globals (state, $, $$, api, esc, px, nav, announce).
// All screen-local state is namespaced state.map_*.
//
// Screen layout: a vertical dock on the LEFT of the map screen (search, the
// partition list with counts and per-cluster fly-to, zoom controls) and the
// dark console canvas filling everything to its right. On small screens the
// dock collapses into a bottom strip (search + one swipeable legend row).
//
// Layout: a real force simulation (seeded, deterministic). Charge repulsion
// through a grid-bucket neighbour search, link springs, and degree-attenuated
// gravity toward each partition's cluster anchor so same-partition notes
// group visually. The sim cools d3-style and STOPS at settle: no perpetual
// rAF. First paint is fast: a time-boxed synchronous pre-roll (~350ms)
// presents an already-organized map, leftover cooling animates after.
//
// Rendering is two-layer. An offscreen static canvas holds the world-space
// scene (dust, edge hairlines, node glow+cores) and is re-stroked ONLY when
// the layout or filter changes or a camera gesture ENDS: pan/zoom/pinch/fly
// composite it with one delta-transformed drawImage per frame. The static
// layer is pixel-ratio capped (<=1.5) and viewport-culled. Labels live on the
// top layer in screen space with 8-anchor collision placement, so text stays
// crisp and dense without piling up.

// ── partition colours (brand palette; synapse pink reserved for hubs/selection) ──
const MAP_COLORS = {
  Memory:'#52F2B8', Work:'#FF6B3D', Reference:'#B44BFF', Initiatives:'#FFB454',
  Logs:'#7FA6FF', Knowledge:'#6FE0D0', Profile:'#FF9E64', Private:'#544E64',
};
const MAP_PALETTE = ['#52F2B8','#FF6B3D','#B44BFF','#FFB454','#7FA6FF','#6FE0D0','#A6E22E','#F47FFF','#5CC8FF','#FFD166','#8AFF80','#C49AFF','#FF8A5C','#64FFD9','#E8FF6B','#B8B8D0'];
const MAP_LOCKED_COL = '#544E64';
const MAP_SYNAPSE = '#FF2E88';
const MAP_MIN_NODES = 8;   // below this the brain is too small to draw a web
const MAP_HUB_COUNT = 26;  // top-degree notes marked as hubs (synapse ring + always-on label)
const MAP_LABEL_CAP = 460; // max node labels placed per frame (collision-managed)
const MAP_PREROLL_MS = 350; // synchronous organize budget before first paint

function map_isLocked(part){ return part === 'Private'; }
function map_hexA(hex, a){ const n = parseInt(String(hex).slice(1),16); return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'; }
function map_hide(id){ const el = document.getElementById(id); if(el) el.style.display = 'none'; }

// assign a stable colour per partition (known names keep their hue; others cycle
// the palette in deterministic partition order)
function map_colorAssign(parts){
  const out = {}; let cyc = 0;
  parts.forEach(p => {
    if(map_isLocked(p)) { out[p] = MAP_LOCKED_COL; return; }
    if(MAP_COLORS[p])   { out[p] = MAP_COLORS[p];   return; }
    out[p] = MAP_PALETTE[cyc % MAP_PALETTE.length]; cyc++;
  });
  return out;
}

// ── entry: tear down any prior loop, paint the shell, then load the graph ──
function renderMap(){
  map_teardown();
  state.map_sel = null; state.map_hover = null; state.map_filter = null;
  state.map_cam = null;                                     // fresh view each entry
  state.map_userCam = false;                                // user hasn't grabbed the camera yet
  state.map_snip = state.map_snip || {};
  state.map_searchMark = null; state.map_fly = null; state.map_gesture = false;
  state.map_perf = { nodes:0, edges:0, ticks:0, settleMs:null, presentMs:null, settled:false,
    drawN:0, drawMs:0, drawMax:0, strokeN:0, strokeMs:0, strokeMax:0, labels:0 };
  $('#screen').innerHTML = map_shell();
  map_load();
}

// ── stop the rAF loop + detach listeners (called on entry and nav exit) ──
function map_teardown(){
  if(state.map_raf){ cancelAnimationFrame(state.map_raf); state.map_raf = null; }
  state.map_running = false;
  if(state.map_dragNode) state.map_dragNode.dragging = false;   // nav away mid-drag never leaves a pin
  state.map_dragNode = null;
  state.map_return = null;
  state.map_pulses = [];
  state.map_fly = null; state.map_gesture = false;
  if(state.map_settleT){ clearTimeout(state.map_settleT); state.map_settleT = null; }
  if(state.map_resizeT){ clearTimeout(state.map_resizeT); state.map_resizeT = null; }
  if(state.map_gestureT){ clearTimeout(state.map_gestureT); state.map_gestureT = null; }
  if(state.map_resize){ removeEventListener('resize', state.map_resize); state.map_resize = null; }
  if(state.map_ro){ try{ state.map_ro.disconnect(); }catch(_){} state.map_ro = null; }
  if(state.map_winUp){ removeEventListener('mouseup', state.map_winUp); state.map_winUp = null; }
  if(state.map_vis){ document.removeEventListener('visibilitychange', state.map_vis); state.map_vis = null; }
  const cv = state.map_cv;
  if(cv){
    cv.onmouseleave = cv.onwheel = cv.ondblclick = null;
    cv.onpointerdown = cv.onpointermove = cv.onpointerup = cv.onpointercancel = null;
    state.map_cv = null;
  }
}

// ── camera helpers: screen = (world - cam) * z + viewportCentre ──
function map_cam(){ return state.map_cam || { x:0, y:0, z:1 }; }
function map_s2wX(sx, W){ const c = map_cam(); return (sx - W / 2) / c.z + c.x; }
function map_s2wY(sy, H){ const c = map_cam(); return (sy - H / 2) / c.z + c.y; }
function map_clampZ(z){ return Math.max(0.06, Math.min(9, z)); }

// fit the camera to world bounds (with margin)
function map_fitCamera(bounds, W, H){
  const bw = Math.max(1, bounds.maxX - bounds.minX), bh = Math.max(1, bounds.maxY - bounds.minY);
  const z = map_clampZ(Math.min(W / (bw * 1.06), H / (bh * 1.06)));
  state.map_cam = { x:(bounds.minX + bounds.maxX) / 2, y:(bounds.minY + bounds.maxY) / 2, z };
}

// ── camera flights: animated move to a target camera, expo.out, ~0.5s. ──
// Reduced motion jumps instantly. A flight is a camera gesture: composite-only
// frames, static layer re-stroked once at the end.
function map_flyTo(to, dur){
  dur = dur || 520;
  const from = map_cam();
  const target = { x:to.x, y:to.y, z:map_clampZ(to.z) };
  if(window.__reduceMotion || dur <= 0){
    state.map_cam = target;
    state.map_staticDirty = true;
    map_afterCamera();
    return;
  }
  state.map_fly = { x0:from.x, y0:from.y, z0:from.z, x1:target.x, y1:target.y, z1:target.z,
    t0:performance.now(), dur };
  state.map_gesture = true;
  map_wake();
}

function map_flyStep(){
  const f = state.map_fly; if(!f) return;
  let t = (performance.now() - f.t0) / f.dur; if(t > 1) t = 1;
  const e = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);       // expo.out
  state.map_cam = { x:f.x0 + (f.x1 - f.x0) * e, y:f.y0 + (f.y1 - f.y0) * e, z:f.z0 + (f.z1 - f.z0) * e };
  if(t >= 1){
    state.map_fly = null;
    map_endGesture();
  }
}

// release a dragged node: unpin it and glide it back to its pre-drag position
// in one bounded tween (400ms, expo.out). Post-release work is hard-capped:
// tween frames are composite-only, and the gesture ends with exactly one
// static-layer restroke. Reduced motion snaps back instantly.
function map_releaseDrag(){
  const n = state.map_dragNode; if(!n) return;
  n.dragging = false;
  state.map_dragNode = null;
  const hx = n.homeX != null ? n.homeX : n.x, hy = n.homeY != null ? n.homeY : n.y;
  if(window.__reduceMotion){
    n.x = hx; n.y = hy;
    map_endGesture();
    return;
  }
  state.map_return = { n, x0: n.x, y0: n.y, x1: hx, y1: hy, t0: performance.now(), dur: 400 };
  map_wake();
}

function map_returnStep(){
  const r = state.map_return; if(!r) return;
  let t = (performance.now() - r.t0) / r.dur; if(t > 1) t = 1;
  const e = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);       // expo.out
  r.n.x = r.x0 + (r.x1 - r.x0) * e;
  r.n.y = r.y0 + (r.y1 - r.y0) * e;
  if(t >= 1){
    r.n.x = r.x1; r.n.y = r.y1;
    state.map_return = null;
    map_endGesture();                      // exactly one restroke, then idle
  }
}

// fly the camera to a world-space bounds box (used for partition clusters)
function map_flyToBounds(bounds, zCap){
  const cv = state.map_cv; if(!cv) return;
  const dpr = state.map_dpr || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const bw = Math.max(1, bounds.maxX - bounds.minX), bh = Math.max(1, bounds.maxY - bounds.minY);
  const z = Math.min(zCap || 2.2, map_clampZ(Math.min(W / (bw * 1.2), H / (bh * 1.2))));
  map_flyTo({ x:(bounds.minX + bounds.maxX) / 2, y:(bounds.minY + bounds.maxY) / 2, z });
}

// bounds of one partition's settled nodes (with padding)
function map_partBounds(p){
  const G = state.map_graph; if(!G) return null;
  let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18, n = 0;
  for(const nd of G.nodes){
    if(nd.folder !== p) continue;
    if(nd.x < minX) minX = nd.x; if(nd.x > maxX) maxX = nd.x;
    if(nd.y < minY) minY = nd.y; if(nd.y > maxY) maxY = nd.y; n++;
  }
  if(!n) return null;
  const pad = 70;
  return { minX:minX - pad, minY:minY - pad, maxX:maxX + pad, maxY:maxY + pad };
}

// ── gesture bookkeeping. Camera gestures (pan, pinch, wheel, fly) composite
// the static layer every frame and re-stroke it once when the gesture ENDS. ──
function map_beginGesture(){ state.map_gesture = true; }
function map_endGesture(){
  state.map_gesture = false;
  if(state.map_gestureT){ clearTimeout(state.map_gestureT); state.map_gestureT = null; }
  state.map_staticDirty = true;
  map_updateCount();
  map_draw();
}
// wheel gestures are event bursts: the gesture ends after a quiet gap
function map_wheelGesture(){
  state.map_gesture = true;
  if(state.map_gestureT) clearTimeout(state.map_gestureT);
  state.map_gestureT = setTimeout(() => { state.map_gestureT = null; map_endGesture(); }, 180);
}

// camera changed during a gesture: composite now, nothing else
function map_afterCamera(){
  map_updateCount();
  if(!state.map_gesture){ state.map_staticDirty = true; }
  map_draw();
}

// ── zoom controls (buttons zoom around the canvas centre; wheel zooms to cursor) ──
function map_zoomBy(factor){
  const c = map_cam(); if(!state.map_cv) return;
  state.map_cam = { x:c.x, y:c.y, z:map_clampZ(c.z * factor) };
  map_beginGesture();
  map_afterCamera();
  map_wheelGesture();             // button taps reuse the idle-gap gesture end
}
function map_zoomReset(){
  const cv = state.map_cv; if(!cv || !state.map_graph) return;
  const dpr = state.map_dpr || 1;
  const b = state.map_graph.bounds;
  const W = cv.width / dpr, H = cv.height / dpr;
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const z = map_clampZ(Math.min(W / (bw * 1.06), H / (bh * 1.06)));
  map_flyTo({ x:(b.minX + b.maxX) / 2, y:(b.minY + b.maxY) / 2, z });
}

// ── static shell: title row, then LEFT DOCK + canvas stage ──
function map_shell(){
  return `
    <div class="map-shell" style="height:100%;min-height:520px;display:flex;flex-direction:column;animation:rise .4s ease both">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <h1 style="font-family:var(--pixel);font-weight:700;font-size:42px;letter-spacing:.01em;line-height:1.02">your brain, mapped.</h1>
          <div style="font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:8px">a constellation of everything you know · <span style="color:var(--dust)">search it, filter it, fly to it</span></div>
        </div>
        <div id="mapBadge" style="display:none;align-items:center;gap:9px;font-family:var(--mono);font-size:11px;color:var(--acid);border:1px solid var(--edge2);border-radius:0;padding:7px 13px;white-space:nowrap"><span style="width:6px;height:6px;border-radius:50%;background:var(--acid);box-shadow:0 0 7px var(--acid)"></span><span id="mapBadgeText"></span></div>
      </div>

      <div class="map-stage" style="flex:1;position:relative;border:1px solid var(--edge2);border-radius:0;overflow:hidden;min-height:420px;display:flex;background:#07060B">

        <aside class="map-side" aria-label="map controls" style="width:204px;flex-shrink:0;position:relative;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--edge);z-index:3">
          <div class="map-side-search" style="position:relative;padding:10px 10px 8px;border-bottom:1px solid var(--edge)">
            <input id="mapSearch" type="text" autocomplete="off" spellcheck="false" placeholder="find a note" aria-label="find a note on the map"
              style="width:100%;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:8px 10px;font-family:var(--mono);font-size:11.5px;color:var(--starlight)">
            <div id="mapSearchResults" role="listbox" aria-label="matching notes" style="display:none;position:absolute;left:10px;right:10px;top:44px;z-index:6;background:var(--surface);border:1px solid var(--edge2);box-shadow:0 18px 44px -18px rgba(0,0,0,.7);max-height:264px;overflow:auto"></div>
          </div>

          <div id="mapLegend" style="flex:1;min-height:0;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px"></div>

          <div class="map-side-foot" style="border-top:1px solid var(--edge);padding:8px 10px;display:flex;flex-direction:column;gap:6px">
            <div id="mapCount" style="font-family:var(--mono);font-size:10px;color:var(--faint);display:none">zoom 100%</div>
            <div id="mapZoom" style="display:flex;gap:4px">
              <button data-map-zoom="out" title="zoom out (scroll ↓)" aria-label="zoom out" style="flex:1;height:30px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:18px;line-height:1;border:1px solid var(--edge2);border-radius:0;background:transparent;color:var(--dust);cursor:pointer">−</button>
              <button data-map-zoom="reset" title="fit the whole map (f)" aria-label="fit the whole map" style="flex:1;height:30px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;line-height:1;border:1px solid var(--edge2);border-radius:0;background:transparent;color:var(--dust);cursor:pointer">⌂</button>
              <button data-map-zoom="in" title="zoom in (scroll ↑)" aria-label="zoom in" style="flex:1;height:30px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:18px;line-height:1;border:1px solid var(--edge2);border-radius:0;background:transparent;color:var(--dust);cursor:pointer">+</button>
            </div>
          </div>
        </aside>

        <div class="map-canvas-wrap" style="flex:1;position:relative;min-width:0">
          <canvas id="mapCanvas" class="on-console" style="position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none"></canvas>

          <div class="map-chrome" style="position:absolute;inset:0;pointer-events:none;z-index:2">
            <div class="map-hint" style="position:absolute;bottom:12px;left:12px;font-family:var(--mono);font-size:10px;color:var(--faint);background:var(--hud-bg);border:1px solid var(--edge);border-radius:0;padding:6px 10px;line-height:1.6;pointer-events:auto">hover to trace · drag to pan · scroll to zoom · double-click opens · f fits<br><span style="color:var(--danger)">🔒</span> Private is on the map but never opens to an AI</div>

            <div id="mapPanel" style="position:absolute;top:12px;right:12px;width:290px;max-width:calc(100% - 24px);background:var(--surface);border:1px solid var(--edge2);border-radius:0;overflow:hidden;box-shadow:0 24px 60px -22px rgba(0,0,0,.55);animation:rise .18s ease both;display:none;pointer-events:auto"></div>
          </div>

          <div id="mapOverlay" class="on-console" style="position:absolute;inset:0;z-index:4;display:none;background:radial-gradient(ellipse 80% 70% at 50% 45%, #0F0C11, #07060B)"></div>
        </div>
      </div>
    </div>`;
}

// ── loading / empty / error overlays (on-console: they cover the dark canvas) ──
function map_showOverlay(kind){
  const ov = document.getElementById('mapOverlay'); if(!ov) return;
  if(kind === 'none'){ ov.style.display = 'none'; ov.innerHTML = ''; return; }
  ov.style.display = 'block';
  if(kind === 'loading'){
    ov.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px">
        <div style="width:44px;height:44px;border:2px solid var(--edge);border-top-color:var(--synapse);border-radius:50%;animation:orbit .8s linear infinite;margin-bottom:20px"></div>
        <div style="font-family:var(--pixel);font-weight:600;font-size:20px;margin-bottom:8px">drawing the connections…</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--faint)">settling the constellation · runs offline on this device</div>
      </div>`;
  } else if(kind === 'empty'){
    ov.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px">
        <div style="width:46px;height:46px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:20px;background:var(--surface2)"><span style="width:11px;height:11px;background:var(--synapse);border-radius:0;box-shadow:0 0 16px var(--synapse);animation:seampulse 2.6s ease-in-out infinite"></span></div>
        <h2 style="font-family:var(--pixel);font-weight:600;font-size:22px;margin-bottom:9px">your map grows as you write.</h2>
        <p style="color:var(--dust);font-size:14px;max-width:46ch">right now there are only a few notes. as you add more, Callosium draws the connections between them here, a living picture of everything you know.</p>
      </div>`;
  } else if(kind === 'error'){
    ov.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px">
        <div style="width:46px;height:46px;border:1px solid var(--danger);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:20px;background:rgba(255,51,85,.06);color:var(--danger);font-size:20px">⚠</div>
        <h2 style="font-family:var(--pixel);font-weight:600;font-size:22px;margin-bottom:9px">couldn't map your brain.</h2>
        <p style="color:var(--dust);font-size:14px;max-width:46ch;margin-bottom:18px">the local engine didn't answer. nothing changed, your notes are exactly where you left them.</p>
        <button id="mapRetry" style="font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--danger);color:var(--danger);background:transparent;padding:9px 15px;border-radius:0;cursor:pointer">retry</button>
      </div>`;
    const rb = document.getElementById('mapRetry'); if(rb) rb.onclick = () => renderMap();
  }
}

// ── fetch the real graph, then lay out + start (or show empty/error) ──
async function map_load(){
  // monotonic token: a second visit supersedes an earlier in-flight load so it
  // can't install listeners or a rAF chain that map_teardown can no longer reach.
  const gen = (state.map_gen = (state.map_gen || 0) + 1);
  state.map_err = null;
  map_hide('mapBadge'); map_hide('mapPanel');
  map_showOverlay('loading');
  let raw = null;
  try{ raw = await api('/api/graph'); }
  catch(e){ state.map_err = e; }
  if(state.screen !== 'map' || gen !== state.map_gen) return;  // navigated away or superseded
  if(state.map_err || !raw || !Array.isArray(raw.nodes)){ map_showOverlay('error'); return; }
  state.map_raw = { nodes: raw.nodes || [], edges: raw.edges || [] };
  if(state.map_raw.nodes.length < MAP_MIN_NODES){ map_showOverlay('empty'); return; }
  map_showOverlay('none');

  const cv = document.getElementById('mapCanvas'); if(!cv) return;
  map_sizeCanvas(cv);
  const t0 = performance.now();
  state.map_perf.t0 = t0;
  map_layout();
  map_paintLegend();
  map_updateBadge();
  map_wireCanvas(cv);
  map_wireSide();

  // resize: the layout lives in world space, so a viewport change only means a
  // re-fit + re-stroke, never a relayout. Debounced against drag-resize storms.
  state.map_resize = () => {
    clearTimeout(state.map_resizeT);
    state.map_resizeT = setTimeout(() => {
      if(state.screen !== 'map') return;
      const c = document.getElementById('mapCanvas'); if(!c) return;
      map_sizeCanvas(c);
      if(state.map_graph) map_fitCamera(state.map_graph.bounds, c.width / (state.map_dpr || 1), c.height / (state.map_dpr || 1));
      state.map_staticDirty = true;
      map_afterCamera();
    }, 160);
  };
  addEventListener('resize', state.map_resize);

  // Canvas-level ResizeObserver — NOT just window 'resize'. The map often mounts
  // before the flex layout has given the canvas its final width (the side panel lays
  // out a beat later), so map_sizeCanvas read a too-wide box and the initial fit framed
  // for the wrong width — shoving the whole constellation to one side at ~50%. This
  // re-sizes + re-fits the instant the real box settles, and leaves the camera alone
  // once the user has grabbed it. Guarded so the no-op initial observe fire (box already
  // the right size) never clears the canvas.
  if(state.map_ro){ try{ state.map_ro.disconnect(); }catch(_){} state.map_ro = null; }
  if(window.ResizeObserver){
    state.map_ro = new ResizeObserver(() => {
      if(state.screen !== 'map') return;
      const c = document.getElementById('mapCanvas'); if(!c) return;
      const dpr = state.map_dpr || 1;
      const tw = Math.max(1, Math.round(c.offsetWidth * dpr)), th = Math.max(1, Math.round(c.offsetHeight * dpr));
      if(c.width === tw && c.height === th) return;               // box unchanged — don't clear/redraw
      map_sizeCanvas(c);
      if(state.map_graph && !state.map_userCam) map_fitCamera(state.map_graph.bounds, c.width / (state.map_dpr || 1), c.height / (state.map_dpr || 1));
      state.map_staticDirty = true;
      map_afterCamera();
    });
    try{ state.map_ro.observe(cv); }catch(_){ state.map_ro = null; }
  }

  // idle gate: freeze the loop while the tab is hidden, resume if work remains
  if(state.map_vis) document.removeEventListener('visibilitychange', state.map_vis);
  state.map_vis = () => {
    if(document.hidden){ if(state.map_raf){ cancelAnimationFrame(state.map_raf); state.map_raf = null; } state.map_running = false; }
    else map_wake();
  };
  document.addEventListener('visibilitychange', state.map_vis);

  // first frame: reduced motion settles in yielding slices and draws once.
  // Otherwise a time-boxed synchronous pre-roll organizes the map before first
  // paint (~350ms budget), and any leftover cooling animates after.
  if(window.__reduceMotion){
    map_settleQuiet(gen);
  } else {
    const deadline = t0 + MAP_PREROLL_MS;
    while(state.map_alpha > 0 && performance.now() < deadline){ map_simulate(false, 8); }
    if(state.map_alpha <= 0){
      // the whole settle fit inside the pre-roll budget: present settled
      map_afterSettle(false);
      state.map_perf.presentMs = state.map_perf.settleMs;
      return;
    }
    map_fitInitial(cv);
    state.map_staticDirty = true;
    map_draw();
    state.map_perf.presentMs = Math.round(performance.now() - t0);
    map_wake();
  }
}

// Reduced motion still wants ONE settled frame and no animation — but running the
// whole cooling schedule (~180 ticks) in a single synchronous call blocked the main
// thread for as long as the layout took: measured 1.7s at 1,500 notes and 7.0s at
// 4,000, during which the tab was frozen — no scrolling, no nav, no Escape. Reduce
// motion is an accessibility setting, so it was handing its users the worst
// experience on the screen. Same ticks, same deterministic result, run in ~24ms
// slices that yield to the event loop between them. The loading overlay is held up
// until it's done, so a half-settled layout is never shown: still zero motion.
const MAP_SLICE_MS = 24;
function map_settleQuiet(gen){
  map_showOverlay('loading');
  const step = ()=>{
    state.map_settleT = null;
    if(state.screen !== 'map' || gen !== state.map_gen) return;   // navigated away or superseded
    const until = performance.now() + MAP_SLICE_MS;
    // ONE tick per deadline check: a tick is the granularity floor, and on a big
    // brain a single tick already costs tens of ms, so batching them (the pre-roll
    // uses 8) blew straight past the budget — measured 496ms slices at 4k notes.
    // map_simulate zeroes the alpha once the sim is cold, so this always terminates.
    while(state.map_alpha > 0 && performance.now() < until) map_simulate(false, 1);
    if(state.map_alpha > 0){ state.map_settleT = setTimeout(step, 0); return; }
    map_showOverlay('none');
    map_afterSettle(true);
    state.map_perf.presentMs = state.map_perf.settleMs;
  };
  state.map_settleT = setTimeout(step, 0);
}

function map_sizeCanvas(cv){
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  state.map_dpr = dpr;                                   // main canvas (text crispness)
  state.map_sdpr = Math.min(1.5, dpr);                   // static layer (cheap restrokes)
  cv.width = Math.max(1, Math.round(cv.offsetWidth * dpr));
  cv.height = Math.max(1, Math.round(cv.offsetHeight * dpr));
}

// initial camera: the layout bounds are known approximately before settle
// (cluster anchors + radii), so frame that; the exact fit happens at settle.
function map_fitInitial(cv){
  if(!state.map_graph) return;
  const W = cv.width / (state.map_dpr || 1), H = cv.height / (state.map_dpr || 1);
  map_fitCamera(state.map_graph.bounds, W, H);
  map_updateCount();
}

// ── build the world-space graph: nodes, edges, cluster anchors, starfield ──
function map_layout(){
  const raw = state.map_raw;
  const rawNodes = raw.nodes, rawEdges = raw.edges;
  const M = rawNodes.length;

  // group note indices by partition; partition order deterministic (size desc, name)
  const byPart = new Map();
  rawNodes.forEach((n, i) => { const p = n.partition || '(root)'; if(!byPart.has(p)) byPart.set(p, []); byPart.get(p).push(i); });
  const parts = [...byPart.keys()].sort((a, b) => (byPart.get(b).length - byPart.get(a).length) || (a < b ? -1 : 1));
  const colorOf = map_colorAssign(parts);

  // seeded PRNG: same brain, same constellation on every visit
  let seed = 20260714; const rnd = () => (seed = (seed * 1664525 + 1013904223) & 0x7fffffff) / 0x7fffffff;

  // ── cluster anchors: each partition owns an arc of a large circle, arc sized
  // by the room its notes need, big/small interleaved so large clusters are not
  // neighbours. Cluster gravity then keeps each partition grouped around its anchor.
  const GAP = 48;
  const radOf = new Map(parts.map(p => [p, 30 + Math.sqrt(byPart.get(p).length) * 21]));
  const order = [];
  { let lo = 0, hi = parts.length - 1; while(lo <= hi){ order.push(parts[lo++]); if(lo <= hi) order.push(parts[hi--]); } }
  const Rc = Math.max(320, order.reduce((s, p) => s + radOf.get(p) + GAP, 0) / Math.PI);
  let acc = -Math.PI / 2;
  const anchors = {};
  order.forEach(p => {
    const arc = (radOf.get(p) + GAP) / Rc;
    const mid = acc + arc / 2; acc += arc;
    anchors[p] = { x: Math.cos(mid) * Rc, y: Math.sin(mid) * Rc, r: radOf.get(p) };
  });

  // hubs: the top-degree notes, marked with the synapse ring + always-on labels
  const degreeOrder = rawNodes.map((n, i) => i).sort((a, b) => (rawNodes[b].links - rawNodes[a].links) || (rawNodes[a].id < rawNodes[b].id ? -1 : 1));
  const hubSet = new Set(degreeOrder.filter(i => rawNodes[i].links >= 10).slice(0, MAP_HUB_COUNT));

  // keyboard cycle order: partition by partition, highest degree first
  const cycleOrder = [];
  parts.forEach(p => { byPart.get(p).slice().sort((a, b) => (rawNodes[b].links - rawNodes[a].links) || (rawNodes[a].id < rawNodes[b].id ? -1 : 1)).forEach(i => cycleOrder.push(i)); });

  const nodes = new Array(M), nodeByRaw = new Map();
  rawNodes.forEach((rn, i) => {
    const p = rn.partition || '(root)';
    const an = anchors[p], col = colorOf[p], locked = map_isLocked(p);
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * an.r * 0.85;
    const r = Math.max(1.7, Math.min(6.5, 1.7 + Math.sqrt(Math.max(0, rn.links)) * 0.42));
    const nd = {
      id: rn.id, title: rn.name, folder: p, col, locked,
      x: an.x + Math.cos(a) * rr, y: an.y + Math.sin(a) * rr, vx: 0, vy: 0,
      r, links: rn.links, hub: hubSet.has(i), orphan: !rn.links,
      noteId: locked ? null : rn.id, anchor: an, dragging: false,
    };
    nodes[i] = nd; nodeByRaw.set(i, nd);
  });

  const edges = [];
  rawEdges.forEach(pair => {
    const a = nodeByRaw.get(pair[0]), b = nodeByRaw.get(pair[1]);
    if(!a || !b || a === b) return;
    edges.push({ a, b, bridge: a.folder !== b.folder, rest: 40 + Math.min(26, (a.links + b.links) * 0.3) });
  });
  // adjacency for hover traces (avoid scanning all edges per frame)
  const adj = new Map(nodes.map(nd => [nd, []]));
  edges.forEach(e => { adj.get(e.a).push(e); adj.get(e.b).push(e); });

  // starfield dust across the world extent (static layer, drawn once per layout)
  const dustR = Rc + 520;
  const dust = [];
  for(let i = 0; i < 300; i++){
    dust.push({ x:(rnd() * 2 - 1) * dustR, y:(rnd() * 2 - 1) * dustR,
      s: 0.5 + rnd() * 1.3, a: 0.03 + rnd() * 0.13, c: rnd() < 0.12 ? '#B9C6FF' : '#EFEDF2' });
  }

  const estR = Rc + Math.max(...order.map(p => radOf.get(p))) + 60;
  state.map_graph = {
    nodes, edges, adj, parts, colorOf, anchors, hubSet, cycleOrder, dust,
    bounds: { minX:-estR, minY:-estR, maxX:estR, maxY:estR },
  };
  state.map_pulses = [];
  state.map_parts = parts;
  state.map_colorOf = colorOf;
  state.map_total = M;
  state.map_edgeTotal = edges.length;
  state.map_alpha = 1;
  state.map_staticDirty = true;
  state.map_perf.nodes = M; state.map_perf.edges = edges.length;
  window.__mapPerf = state.map_perf;
}

// ── force simulation ────────────────────────────────────────────────────────
// One tick: grid-bucket charge repulsion (short range, O(n)), link springs,
// degree-attenuated gravity toward each partition's anchor + a whisper toward
// the origin. Velocities damped, forces scaled by the cooling alpha.
const MAP_REP_R = 88, MAP_REP = 0.72, MAP_SPRING = 0.045, MAP_GRAV = 0.011, MAP_CENTER = 0.0032, MAP_DAMP = 0.82;

function map_tick(alpha){
  const G = state.map_graph, nodes = G.nodes, edges = G.edges;
  const cell = MAP_REP_R, OFF = 32768;
  const buckets = new Map();
  for(let i = 0; i < nodes.length; i++){
    const n = nodes[i];
    const k = (((n.y + OFF) / cell) | 0) * 65536 + (((n.x + OFF) / cell) | 0);
    const arr = buckets.get(k); if(arr) arr.push(i); else buckets.set(k, [i]);
  }
  const rep = MAP_REP * alpha;
  for(let i = 0; i < nodes.length; i++){
    const n = nodes[i];
    const cx = ((n.x + OFF) / cell) | 0, cy = ((n.y + OFF) / cell) | 0;
    for(let gy = cy - 1; gy <= cy + 1; gy++) for(let gx = cx - 1; gx <= cx + 1; gx++){
      const arr = buckets.get(gy * 65536 + gx); if(!arr) continue;
      for(let t = 0; t < arr.length; t++){
        const j = arr[t]; if(j <= i) continue;
        const m = nodes[j];
        let dx = m.x - n.x, dy = m.y - n.y;
        let d2 = dx * dx + dy * dy;
        if(d2 > MAP_REP_R * MAP_REP_R) continue;
        // coincident nodes: deterministic nudge, distance floored so the 1/d
        // force can never blow up into NaN velocities.
        if(d2 < 16){
          if(d2 < 0.001){ dx = ((i % 7) - 3) * 0.31 || 0.23; dy = ((j % 5) - 2) * 0.29 || -0.17; }
          d2 = 16;
        }
        const d = Math.sqrt(d2);
        const f = rep * (1 - d / MAP_REP_R) / d;
        const fx = dx * f, fy = dy * f;
        if(!n.dragging){ n.vx -= fx; n.vy -= fy; }
        if(!m.dragging){ m.vx += fx; m.vy += fy; }
      }
    }
  }
  const spr = MAP_SPRING * alpha;
  for(const e of edges){
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = spr * (d - e.rest) / d;
    const fx = dx * f, fy = dy * f;
    if(!e.a.dragging){ e.a.vx += fx; e.a.vy += fy; }
    if(!e.b.dragging){ e.b.vx -= fx; e.b.vy -= fy; }
  }
  const grav = MAP_GRAV * alpha, cent = MAP_CENTER * alpha;
  let maxV = 0;
  for(const n of nodes){
    if(!n.dragging){
      const g = grav / (1 + n.links * 0.12);
      n.vx = (n.vx + (n.anchor.x - n.x) * g - n.x * cent) * MAP_DAMP;
      n.vy = (n.vy + (n.anchor.y - n.y) * g - n.y * cent) * MAP_DAMP;
      if(n.vx > 30) n.vx = 30; else if(n.vx < -30) n.vx = -30;
      if(n.vy > 30) n.vy = 30; else if(n.vy < -30) n.vy = -30;
      n.x += n.vx; n.y += n.vy;
      const v = Math.abs(n.vx) + Math.abs(n.vy); if(v > maxV) maxV = v;
    }
  }
  return maxV;
}

// run the sim. full=true: cool all the way to rest in one synchronous call (kept
// for a caller that can afford to block; the reduced-motion path no longer can —
// see map_settleQuiet). Otherwise run `ticks` ticks with the live alpha (pre-roll
// chunk, settle slice, or one frame step).
function map_simulate(full, ticks){
  const G = state.map_graph; if(!G) return 0;
  let maxV = 0, n = 0;
  if(full){
    for(let i = 0; i < 400 && state.map_alpha > 0; i++){
      maxV = map_tick(state.map_alpha);
      state.map_alpha *= 0.976; n++;
      if(state.map_alpha < 0.015 && maxV < 0.1){ state.map_alpha = 0; break; }
      if(state.map_alpha < 0.012){ state.map_alpha = 0; break; }
    }
    state.map_alpha = 0;
  } else {
    for(let i = 0; i < (ticks || 1); i++){
      maxV = map_tick(state.map_alpha);
      state.map_alpha *= 0.976; n++;
      if(state.map_alpha < 0.015 && maxV < 0.1){ state.map_alpha = 0; break; }
      if(state.map_alpha < 0.012){ state.map_alpha = 0; break; }
    }
  }
  state.map_perf.ticks += n;
  return maxV;
}

// exact bounds from settled positions (percentile crop so a few far-flung
// leaves don't zoom the fit out), then fit + final crisp draw
function map_afterSettle(instant){
  const G = state.map_graph; if(!G) return;
  const xs = G.nodes.map(nd => nd.x).sort((a, b) => a - b);
  const ys = G.nodes.map(nd => nd.y).sort((a, b) => a - b);
  const lo = Math.floor(xs.length * 0.02), hi = Math.min(xs.length - 1, Math.floor(xs.length * 0.98));
  const pad = 60;
  G.bounds = { minX: xs[lo] - pad, minY: ys[lo] - pad, maxX: xs[hi] + pad, maxY: ys[hi] + pad };
  const cv = state.map_cv;
  // don't snap the camera back to fit-all if the user panned/zoomed during the
  // post-present cooling window — that would discard their navigation
  if(cv && !state.map_userCam) map_fitCamera(G.bounds, cv.width / (state.map_dpr || 1), cv.height / (state.map_dpr || 1));
  if(state.map_perf.settleMs == null && state.map_perf.t0){
    state.map_perf.settleMs = Math.round(performance.now() - state.map_perf.t0);
  }
  state.map_perf.settled = true;
  state.map_staticDirty = true;
  map_updateCount();
  map_draw();
}

// ── the rAF loop: only ever runs while there is physics or pulse work ──
// map_draw() paints synchronously; map_wake() starts the loop only when work
// remains (cooling sim, a lit hover trace, a camera flight, an active drag).
function map_animWork(){
  if(state.map_alpha > 0 || (state.map_pulses && state.map_pulses.length) || state.map_return || state.map_fly) return true;
  return !!state.map_hover && !window.__reduceMotion;   // a lit trace keeps pulsing
}
function map_wake(){
  if(state.screen !== 'map' || state.map_running || document.hidden) return;
  if(window.__reduceMotion) return;                   // never loops under reduced motion
  if(!map_animWork()) return;
  state.map_running = true;
  state.map_raf = requestAnimationFrame(map_frame);
}
function map_refresh(){ map_draw(); map_wake(); }

// seed a staggered volley of pulses along a node's edges (on hover start)
function map_seedPulses(focus){
  if(window.__reduceMotion || !focus) return;
  const list = (state.map_graph && state.map_graph.adj.get(focus)) || [];
  if(!list.length) return;
  const pulses = state.map_pulses = state.map_pulses || [];
  const n = Math.min(7, list.length);
  for(let k = 0; k < n; k++){
    const e = list[(Math.random() * list.length) | 0];
    pulses.push({ e, t: -0.12 * k, c: MAP_SYNAPSE });
  }
}

function map_frame(){
  state.map_raf = null;
  if(state.screen !== 'map'){ state.map_running = false; return; }
  const G = state.map_graph; if(!G){ state.map_running = false; return; }

  let physics = false;
  if(state.map_alpha > 0){
    map_simulate(false, 1);
    state.map_staticDirty = true;
    physics = true;
    if(state.map_alpha <= 0){ map_afterSettle(false); }
  }
  if(state.map_fly) map_flyStep();
  if(state.map_return) map_returnStep();
  // pulses advance while a trace is lit
  let pulses = state.map_pulses || [];
  if(pulses.length){
    for(const p of pulses) p.t += 0.016;
    pulses = state.map_pulses = pulses.filter(p => p.t < 1);
  }
  map_draw();

  const more = map_animWork();
  if(more && !document.hidden){ state.map_raf = requestAnimationFrame(map_frame); }
  else {
    state.map_running = false;
    if(physics || state.map_staticDirty){ state.map_staticDirty = true; map_draw(); }
  }
}

// ── static layer: dust + edges + node glow/cores, re-stroked only when dirty ──
// Pixel-ratio capped (<=1.5), viewport-culled, alpha-class batched, sub-pixel
// edges skipped. Timed: cumulative counters in state.map_perf (stroke*).
function map_staticCanvas(W, H){
  const sdpr = state.map_sdpr || 1;
  let sc = state.map_static;
  if(!sc){ sc = document.createElement('canvas'); state.map_static = sc; }
  const w = Math.max(1, Math.round(W * sdpr)), h = Math.max(1, Math.round(H * sdpr));
  if(sc.width !== w || sc.height !== h){ sc.width = w; sc.height = h; }
  return sc;
}

function map_renderStatic(W, H){
  const G = state.map_graph; if(!G) return;
  const t0 = performance.now();
  const sdpr = state.map_sdpr || 1;
  const sc = map_staticCanvas(W, H);
  const ctx = sc.getContext('2d');
  const cam = map_cam();
  state.map_staticCam = { x: cam.x, y: cam.y, z: cam.z };
  ctx.setTransform(sdpr, 0, 0, sdpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // console-dark backdrop with a faint central bloom (both themes, by design)
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, Math.max(W, H) * 0.75);
  bg.addColorStop(0, '#0F0C11'); bg.addColorStop(1, '#07060B');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);

  // visible world rect (generous margin): everything outside is skipped
  const m = 60 / cam.z;
  const vX0 = cam.x - W / 2 / cam.z - m, vX1 = cam.x + W / 2 / cam.z + m;
  const vY0 = cam.y - H / 2 / cam.z - m, vY1 = cam.y + H / 2 / cam.z + m;

  // starfield dust
  for(const d of G.dust){
    if(d.x < vX0 || d.x > vX1 || d.y < vY0 || d.y > vY1) continue;
    ctx.fillStyle = map_hexA(d.c, d.a);
    ctx.fillRect(d.x - d.s / 2, d.y - d.s / 2, d.s, d.s);
  }

  const filt = state.map_filter;
  const minLen = 2 / cam.z, minLen2 = minLen * minLen;   // sub-pixel edges add nothing
  // edges, batched into a few paths by alpha class: hairline traces at rest,
  // the filtered partition's internal web lit in its own colour.
  const pass = (test, col, alpha) => {
    ctx.strokeStyle = col; ctx.globalAlpha = alpha; ctx.lineWidth = 1 / cam.z;
    ctx.beginPath();
    let any = false;
    for(const e of G.edges){
      if(!test(e)) continue;
      const ax = e.a.x, ay = e.a.y, bx = e.b.x, by = e.b.y;
      if((ax < vX0 && bx < vX0) || (ax > vX1 && bx > vX1) || (ay < vY0 && by < vY0) || (ay > vY1 && by > vY1)) continue;
      const dx = bx - ax, dy = by - ay;
      if(dx * dx + dy * dy < minLen2) continue;
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); any = true;
    }
    if(any) ctx.stroke();
    ctx.globalAlpha = 1;
  };
  if(filt){
    pass(e => e.a.folder !== filt && e.b.folder !== filt, '#8F86A8', 0.018);
    pass(e => e.a.folder === filt && e.b.folder === filt, G.colorOf[filt] || '#8F86A8', 0.20);
    pass(e => (e.a.folder === filt) !== (e.b.folder === filt), '#8F86A8', 0.05);
  } else {
    pass(e => !e.bridge, '#8F86A8', 0.055);
    pass(e => e.bridge, '#8F86A8', 0.085);
  }

  // nodes: halo + crisp core, batched per partition colour. Orphans dim.
  const byPart = new Map();
  for(const n of G.nodes){
    if(n.x < vX0 || n.x > vX1 || n.y < vY0 || n.y > vY1) continue;
    const arr = byPart.get(n.folder) || []; arr.push(n); byPart.set(n.folder, arr);
  }
  const minCore = 1.15 / cam.z; // keep the tiniest stars visible when zoomed out
  for(const [part, arr] of byPart){
    const col = G.colorOf[part] || '#8F86A8';
    const dimPart = filt && filt !== part;
    // halo pass
    ctx.fillStyle = col;
    for(const n of arr){
      const r = Math.max(n.r, minCore);
      let a = n.orphan ? 0.05 : (n.hub ? 0.15 : 0.09);
      if(dimPart) a *= 0.25;
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(n.x, n.y, r * 1.85, 0, 6.29); ctx.fill();
    }
    // core pass
    for(const n of arr){
      const r = Math.max(n.r, minCore);
      let a = n.orphan ? 0.34 : 0.96;
      if(dimPart) a *= 0.22;
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.29); ctx.fill();
      // crisp pixel heart on the bigger stars
      if(r * cam.z >= 2.6){
        ctx.globalAlpha = Math.min(1, a + 0.04);
        ctx.fillStyle = '#F4F1FA';
        const pxr = Math.max(0.7 / cam.z, r * 0.34);
        ctx.fillRect(n.x - pxr / 2, n.y - pxr / 2, pxr, pxr);
        ctx.fillStyle = col;
      }
    }
    ctx.globalAlpha = 1;
  }
  // hub marker: the synapse ring, the one pink thing at rest
  ctx.strokeStyle = MAP_SYNAPSE; ctx.lineWidth = 1.4 / cam.z;
  for(const n of G.nodes){
    if(!n.hub) continue;
    if(n.x < vX0 || n.x > vX1 || n.y < vY0 || n.y > vY1) continue;
    let a = filt && filt !== n.folder ? 0.15 : 0.85;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(n.x, n.y, Math.max(n.r, minCore) + 3.2 / cam.z, 0, 6.29); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  state.map_staticDirty = false;
  const dt = performance.now() - t0;
  const P = state.map_perf;
  P.strokeN++; P.strokeMs += dt; if(dt > P.strokeMax) P.strokeMax = dt;
}

// ── top layer: composite the static scene, then traces, pulses, labels ──
// Timed: cumulative counters in state.map_perf (draw*).
function map_draw(){
  const t0 = performance.now();
  const cv = state.map_cv; if(!cv || state.screen !== 'map') return;
  const G = state.map_graph; if(!G) return;
  const dpr = state.map_dpr || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // camera gestures composite the offscreen scene as-is; the re-stroke waits
  // for the gesture to end (see map_endGesture).
  if(state.map_staticDirty && !state.map_gesture) map_renderStatic(W, H);
  const sc = state.map_static, scCam = state.map_staticCam || map_cam();
  const cam = map_cam();
  const k = cam.z / scCam.z;
  const ox = (W / 2) * (1 - k) + (scCam.x - cam.x) * cam.z;
  const oy = (H / 2) * (1 - k) + (scCam.y - cam.y) * cam.z;
  ctx.drawImage(sc, 0, 0, sc.width, sc.height, ox, oy, W * k, H * k);

  const filt = state.map_filter, sel = state.map_sel, focus = state.map_hover || null;
  const motionOff = !!window.__reduceMotion;

  // hover trace: dim the whole scene, then light the focus neighbourhood
  let neigh = null;
  if(focus){
    neigh = new Set([focus]);
    for(const e of (G.adj.get(focus) || [])){ neigh.add(e.a); neigh.add(e.b); }
    ctx.fillStyle = 'rgba(7,6,11,0.52)';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    // the traced links, alpha scaled by degree so a 200-link hub reads as a
    // fan of hairlines instead of a white ball
    const fEdges = G.adj.get(focus) || [];
    const aN = Math.min(0.62, Math.max(0.12, 26 / Math.max(1, fEdges.length)));
    const aB = Math.min(0.9, aN * 1.6);
    for(const e of fEdges){
      ctx.strokeStyle = map_hexA('#F3EEFF', e.bridge ? aB : aN);
      ctx.lineWidth = (e.bridge ? 1.7 : 1.2) / cam.z;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    // the neighbourhood stars, lit back up
    for(const n of neigh){
      const r = Math.max(n.r, 1.15 / cam.z) * (n === focus ? 1.35 : 1.12);
      ctx.fillStyle = map_hexA(n.col, 0.22);
      ctx.beginPath(); ctx.arc(n.x, n.y, r * 2.1, 0, 6.29); ctx.fill();
      ctx.fillStyle = map_hexA(n.col, 1);
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.29); ctx.fill();
      ctx.fillStyle = 'rgba(244,241,250,0.95)';
      const pxr = Math.max(0.8 / cam.z, r * 0.36);
      ctx.fillRect(n.x - pxr / 2, n.y - pxr / 2, pxr, pxr);
      if(n.hub){
        ctx.strokeStyle = map_hexA(MAP_SYNAPSE, 0.95); ctx.lineWidth = 1.4 / cam.z;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.2 / cam.z, 0, 6.29); ctx.stroke();
      }
    }
    // synapse pulses travel the traced links (gated by reduced motion)
    if(!motionOff){
      let pulses = state.map_pulses || [];
      if(pulses.length < 46 && Math.random() < 0.5){
        const list = G.adj.get(focus) || [];
        const e = list[(Math.random() * list.length) | 0];
        if(e) pulses.push({ e, t: 0, c: MAP_SYNAPSE });
        state.map_pulses = pulses;
      }
    }
    ctx.restore();
  }

  // pulses in flight (drawn after the focus block so they stay on top)
  const pulses = state.map_pulses || [];
  if(pulses.length){
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    for(const p of pulses){
      if(p.t < 0) continue;   // staggered volley: not yet launched
      const x = p.e.a.x + (p.e.b.x - p.e.a.x) * p.t, y = p.e.a.y + (p.e.b.y - p.e.a.y) * p.t;
      const s = 2.6 / cam.z;
      ctx.fillStyle = map_hexA(MAP_SYNAPSE, 0.28);
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
      ctx.fillStyle = map_hexA('#FFD7E9', 0.95);
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    ctx.restore();
  }

  // live drag / return render: the pinned node and its incident edges follow
  // the pointer on the top layer while the static scene stays untouched (no
  // physics, no restrokes). The static copy at the pre-drag spot is masked
  // with a backdrop disc so it does not read as a ghost.
  const dragN = state.map_dragNode || (state.map_return ? state.map_return.n : null);
  if(dragN){
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    const rr = Math.max(dragN.r, 1.15 / cam.z);
    const hx = dragN.homeX != null ? dragN.homeX : dragN.x, hy = dragN.homeY != null ? dragN.homeY : dragN.y;
    ctx.fillStyle = '#0A0910';
    ctx.beginPath(); ctx.arc(hx, hy, rr * 2.1 + 5 / cam.z, 0, 6.29); ctx.fill();
    for(const e of (G.adj.get(dragN) || [])){
      const o = e.a === dragN ? e.b : e.a;
      ctx.strokeStyle = map_hexA('#F3EEFF', e.bridge ? 0.75 : 0.55);
      ctx.lineWidth = (e.bridge ? 1.6 : 1.2) / cam.z;
      ctx.beginPath(); ctx.moveTo(dragN.x, dragN.y); ctx.lineTo(o.x, o.y); ctx.stroke();
    }
    ctx.fillStyle = map_hexA(dragN.col, 0.26);
    ctx.beginPath(); ctx.arc(dragN.x, dragN.y, rr * 2.1, 0, 6.29); ctx.fill();
    ctx.fillStyle = map_hexA(dragN.col, 1);
    ctx.beginPath(); ctx.arc(dragN.x, dragN.y, rr * 1.15, 0, 6.29); ctx.fill();
    ctx.fillStyle = 'rgba(244,241,250,0.95)';
    const pxr = Math.max(0.8 / cam.z, rr * 0.4);
    ctx.fillRect(dragN.x - pxr / 2, dragN.y - pxr / 2, pxr, pxr);
    ctx.strokeStyle = map_hexA(MAP_SYNAPSE, 0.95); ctx.lineWidth = 1.4 / cam.z;
    ctx.beginPath(); ctx.arc(dragN.x, dragN.y, rr * 1.15 + 3.2 / cam.z, 0, 6.29); ctx.stroke();
    ctx.restore();
  }

  // ring markers: the selection (you are here) and the last search hit
  const ringFor = (id, wide) => {
    const n = G.nodes.find(nd => nd.id === id);
    if(!n) return;
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
    const r = Math.max(n.r, 1.15 / cam.z);
    ctx.strokeStyle = map_hexA(MAP_SYNAPSE, 0.95); ctx.lineWidth = 1.6 / cam.z;
    ctx.beginPath(); ctx.arc(n.x, n.y, r + 5.5 / cam.z, 0, 6.29); ctx.stroke();
    if(wide){ ctx.strokeStyle = map_hexA(MAP_SYNAPSE, 0.3); ctx.lineWidth = 1 / cam.z;
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 10 / cam.z, 0, 6.29); ctx.stroke(); }
    ctx.restore();
  };
  if(sel) ringFor(sel.id, true);
  if(state.map_searchMark && (!sel || sel.id !== state.map_searchMark)) ringFor(state.map_searchMark, true);

  map_drawLabels(ctx, W, H, cam, focus, neigh, sel, filt);

  const dt = performance.now() - t0;
  const P = state.map_perf;
  P.drawN++; P.drawMs += dt; if(dt > P.drawMax) P.drawMax = dt;
}

// ── labels: screen-space, collision-managed, dense but never a pileup ──
// Priority: the traced neighbourhood and hubs always label; other notes label
// once their on-screen star is big enough (deeper zoom = more labels). Each
// label tries 8 anchors around its star and takes the first slot that does not
// hit an already-placed label (spatial-hash lookup). The fit view shows the
// maximum non-colliding set: hubs, region titles, and as many mid-degree
// notes as the space allows.
function map_drawLabels(ctx, W, H, cam, focus, neigh, sel, filt){
  const G = state.map_graph;
  const FONT = '10px "JetBrains Mono",monospace';
  const HUBFONT = '600 11px "JetBrains Mono",monospace';
  state.map_textW = state.map_textW || new Map();
  const wCache = state.map_textW;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';

  const sx = n => (n.x - cam.x) * cam.z + W / 2;
  const sy = n => (n.y - cam.y) * cam.z + H / 2;

  // spatial hash of placed label rects (26px cells)
  const CELL = 26;
  const grid = new Map();
  const gk = (x, y) => ((y / CELL) | 0) * 4096 + ((x / CELL) | 0);
  const placed = [];
  const blockRect = (x, y, w, h) => {
    placed.push({ x, y, w, h });
    const x0 = ((x / CELL) | 0) - 1, x1 = (((x + w) / CELL) | 0) + 1;
    const y0 = ((y / CELL) | 0) - 1, y1 = (((y + h) / CELL) | 0) + 1;
    for(let gy = y0; gy <= y1; gy++) for(let gx = x0; gx <= x1; gx++){
      const k = gy * 4096 + gx;
      const arr = grid.get(k); if(arr) arr.push(placed.length - 1); else grid.set(k, [placed.length - 1]);
    }
  };
  const hits = (x, y, w, h) => {
    const x0 = ((x / CELL) | 0) - 1, x1 = (((x + w) / CELL) | 0) + 1;
    const y0 = ((y / CELL) | 0) - 1, y1 = (((y + h) / CELL) | 0) + 1;
    for(let gy = y0; gy <= y1; gy++) for(let gx = x0; gx <= x1; gx++){
      const arr = grid.get(gy * 4096 + gx); if(!arr) continue;
      for(const ix of arr){
        const r = placed[ix];
        if(x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
      }
    }
    return false;
  };

  // partition region titles first (under the node labels): settled clusters of
  // 4+ notes, titled at their top edge, registered into the collision grid.
  ctx.font = '600 10px "JetBrains Mono",monospace';
  for(const p of G.parts){
    if(filt && filt !== p) continue;
    let cx = 0, top = 1e18, n = 0;
    for(const nd of G.nodes){ if(nd.folder === p){ cx += nd.x; if(nd.y < top) top = nd.y; n++; } }
    if(n < 4) continue;
    cx /= n;
    const X = (cx - cam.x) * cam.z + W / 2, Y = (top - cam.y) * cam.z + H / 2 - 14;
    if(X < -80 || X > W + 80 || Y < -30 || Y > H + 30) continue;
    const label = p.toUpperCase();
    let w = wCache.get('P' + label);
    if(w == null){ w = ctx.measureText(label).width; wCache.set('P' + label, w); }
    if(hits(X - w / 2 - 5, Y - 8, w + 10, 16)) continue;
    blockRect(X - w / 2 - 5, Y - 8, w + 10, 16);
    const col = G.colorOf[p] || '#8F86A8';
    const a = focus ? 0.16 : 0.55;
    ctx.fillStyle = map_hexA('#07060B', Math.min(1, 0.55 * a * 2));
    ctx.fillRect(X - w / 2 - 5, Y - 8, w + 10, 16);
    ctx.fillStyle = map_hexA(col, a);
    ctx.fillText(label, X - w / 2, Y);
  }

  // gather candidates in priority order
  const cands = [];
  const dragNL = state.map_dragNode || (state.map_return ? state.map_return.n : null);
  if(focus && neigh){
    for(const n of neigh){ if(!n.orphan || n === focus) cands.push({ n, pri: 0 }); }
  }
  if(dragNL && !(focus && neigh && neigh.has(dragNL))) cands.push({ n: dragNL, pri: 0 });
  for(const n of G.nodes){
    if(n === dragNL) continue;
    if(focus && neigh && neigh.has(n)) continue;
    if(n.hub) cands.push({ n, pri: 1 });
    else if(n.r * cam.z >= 1.55) cands.push({ n, pri: 2 });
  }
  cands.sort((a, b) => (a.pri - b.pri) || (b.n.links - a.n.links));

  let count = 0;
  for(const c of cands){
    if(count >= MAP_LABEL_CAP) break;
    const n = c.n;
    if(filt && filt !== n.folder && c.pri > 0) continue;
    const X = sx(n), Y = sy(n);
    if(X < -60 || X > W + 60 || Y < -20 || Y > H + 20) continue;
    const sr = Math.max(n.r * cam.z, 1.15);
    const inTrace = focus && neigh && neigh.has(n);
    let txt;
    if(n.locked){ txt = '🔒'; }
    else { txt = n.title.length > 34 ? n.title.slice(0, 33) + '…' : n.title; }
    const key = (n.hub ? 'H' : 'N') + txt;
    let w = wCache.get(key);
    if(w == null){ ctx.font = n.hub ? HUBFONT : FONT; w = ctx.measureText(txt).width; wCache.set(key, w); }
    ctx.font = n.hub ? HUBFONT : FONT;
    const h = n.hub ? 13 : 12, pad = 2, off = sr + 3;
    // 8 anchor candidates around the star
    const spots = [
      [X - w / 2, Y + off],                 // below
      [X - w / 2, Y - off - h],             // above
      [X + off + 1, Y - h / 2],             // right
      [X - off - 1 - w, Y - h / 2],         // left
      [X + off * 0.72, Y + off * 0.72],     // below right
      [X - off * 0.72 - w, Y + off * 0.72], // below left
      [X + off * 0.72, Y - off * 0.72 - h], // above right
      [X - off * 0.72 - w, Y - off * 0.72 - h], // above left
    ];
    let at = null;
    for(const s of spots){
      const rx = s[0] - pad, ry = s[1] - 0.5, rw = w + pad * 2, rh = h + 1;
      if(rx < 2 || ry < 2 || rx + rw > W - 2 || ry + rh > H - 2) continue;
      if(!hits(rx, ry, rw, rh)){ at = [s[0], s[1], rx, ry, rw, rh]; break; }
    }
    if(!at) continue; // no room: this star stays unlabeled rather than piling up
    blockRect(at[2], at[3], at[4], at[5]);
    count++;
    // halo behind the text so it reads over edges
    ctx.fillStyle = 'rgba(7,6,11,0.72)';
    ctx.fillRect(at[0] - 2, at[1] - 1, w + 4, h + 2);
    let col, alpha;
    if(n.hub){ col = MAP_SYNAPSE; alpha = 1; }
    else if(inTrace){ col = '#F3EEFF'; alpha = 0.96; }
    else { col = '#D8D3E4'; alpha = 0.86; }
    if(filt && filt !== n.folder) alpha *= 0.3;
    ctx.fillStyle = map_hexA(col, alpha);
    ctx.fillText(txt, at[0], at[1] + h / 2);
  }
  state.map_perf.labels = count;
}

// ── canvas interaction: hover-trace, node drag, pan, pinch, dblclick, keys ──
function map_wireCanvas(cv){
  state.map_cv = cv;
  cv.tabIndex = 0;
  cv.setAttribute('role', 'img');
  const tot = state.map_total || 0, links = state.map_edgeTotal || 0;
  cv.setAttribute('aria-label', 'brain map · ' + tot + ' notes, ' + links + ' links. arrow keys move between notes, enter opens one, f fits the map.');

  cv.addEventListener('keydown', e => {
    const G = state.map_graph; if(!G) return;
    const order = G.cycleOrder.map(i => G.nodes[i]).filter(Boolean);
    if(e.key === 'f' || e.key === 'F'){ e.preventDefault(); map_zoomReset(); return; }
    if(!order.length) return;
    let ix = order.indexOf(state.map_hover);
    if(e.key === 'ArrowRight' || e.key === 'ArrowDown'){ e.preventDefault(); ix = (ix + 1) % order.length; state.map_hover = order[ix]; announce(order[ix].title); map_seedPulses(order[ix]); map_refresh(); }
    else if(e.key === 'ArrowLeft' || e.key === 'ArrowUp'){ e.preventDefault(); ix = (ix - 1 + order.length) % order.length; state.map_hover = order[ix]; announce(order[ix].title); map_seedPulses(order[ix]); map_refresh(); }
    else if((e.key === 'Enter' || e.key === ' ') && state.map_hover){ e.preventDefault(); map_select(state.map_hover); }
    else if(e.key === 'Escape'){ if(dragNode) releaseDrag(false); state.map_hover = null; state.map_sel = null; map_clearSearch(); map_paintPanel(); map_refresh(); }
  });

  const cssW = () => cv.width / (state.map_dpr || 1), cssH = () => cv.height / (state.map_dpr || 1);
  const screenPt = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const worldPt = s => ({ x: map_s2wX(s.x, cssW()), y: map_s2wY(s.y, cssH()) });
  const hit = (wx, wy) => {
    const G = state.map_graph; if(!G) return null;
    const cam = map_cam();
    const tol = Math.max(10 / cam.z, 4);
    let best = null, bd = 1e9;
    for(const n of G.nodes){
      const d = Math.hypot(n.x - wx, n.y - wy);
      const reach = Math.max(n.r + 3 / cam.z, tol);
      if(d < reach && d < bd){ bd = d; best = n; }
    }
    return best;
  };

  // unified pointers: one finger/mouse drags a node, empty space pans, two
  // fingers pinch. A drag pins the node OUT of the physics: no sim work, no
  // static-layer restrokes; the node and its incident edges render live on
  // the top layer. Release always restores the pre-drag position.
  const ptrs = new Map();
  let pinch = null, dragNode = null, panSt = null, downAt = 0, downS = null, moved = false;

  const startDrag = (n) => {
    if(state.map_return) state.map_return = null;   // grabbing mid-return: cancel the glide
    dragNode = n; n.dragging = true; state.map_dragNode = n;
    n.homeX = n.x; n.homeY = n.y;                   // restore point, always recorded
    state.map_hover = null; state.map_pulses = [];
    map_beginGesture();                             // composite-only frames from here
  };
  const releaseDrag = (wasTap) => {
    const n = dragNode; if(!n) return;
    dragNode = null;
    if(wasTap){
      n.dragging = false; state.map_dragNode = null;
      n.x = n.homeX; n.y = n.homeY;                 // a tap never displaced it
      map_endGesture();
      map_select(n);
      return;
    }
    map_releaseDrag();                              // unpin + animated return + one restroke
  };
  const endPanPinch = () => {
    const had = panSt || pinch;
    panSt = null; pinch = null;
    if(had) map_endGesture();
  };

  cv.onpointerdown = e => {
    try{ if(cv.setPointerCapture) cv.setPointerCapture(e.pointerId); }catch(_){}
    const s = screenPt(e); ptrs.set(e.pointerId, s);
    moved = false; downS = s; downAt = Date.now();
    if(ptrs.size === 2){
      releaseDrag(false);                     // a second finger converts a drag into a pinch
      const pts = [...ptrs.values()];
      const c = map_cam();
      pinch = { d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, z0: c.z,
        mid0: { x:(pts[0].x + pts[1].x) / 2, y:(pts[0].y + pts[1].y) / 2 }, cam0: { x:c.x, y:c.y } };
      panSt = null;
      map_beginGesture();
      return;
    }
    const w = worldPt(s);
    const n = hit(w.x, w.y);
    if(n){
      startDrag(n);                           // mouse AND touch drag nodes
    } else {
      panSt = { sx: s.x, sy: s.y, cam0: { x: map_cam().x, y: map_cam().y } };
      map_beginGesture();
    }
    cv.style.cursor = 'grabbing';
  };

  cv.onpointermove = e => {
    const s = screenPt(e);
    if(ptrs.has(e.pointerId)) ptrs.set(e.pointerId, s);
    if(pinch && ptrs.size >= 2){
      const pts = [...ptrs.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x:(pts[0].x + pts[1].x) / 2, y:(pts[0].y + pts[1].y) / 2 };
      const z1 = map_clampZ(pinch.z0 * d / pinch.d0);
      // keep the pinch midpoint's world point under the fingers
      const W = cssW(), H = cssH();
      const wx = (pinch.mid0.x - W / 2) / pinch.z0 + pinch.cam0.x;
      const wy = (pinch.mid0.y - H / 2) / pinch.z0 + pinch.cam0.y;
      state.map_cam = { x: wx - (mid.x - W / 2) / z1, y: wy - (mid.y - H / 2) / z1, z: z1 };
      state.map_userCam = true;
      map_afterCamera();
      return;
    }
    if(dragNode){
      const w = worldPt(s);
      dragNode.x = w.x; dragNode.y = w.y;     // top-layer live position, no physics
      if(downS && Math.hypot(s.x - downS.x, s.y - downS.y) > 3) moved = true;
      map_draw();                             // composite + live drag render, cheap
      return;
    }
    if(panSt){
      const cam = map_cam();
      state.map_cam = { x: panSt.cam0.x - (s.x - panSt.sx) / cam.z, y: panSt.cam0.y - (s.y - panSt.sy) / cam.z, z: cam.z };
      state.map_userCam = true;
      if(downS && Math.hypot(s.x - downS.x, s.y - downS.y) > 3) moved = true;
      cv.style.cursor = 'grabbing';
      map_afterCamera();
      return;
    }
    const w = worldPt(s);
    const n = hit(w.x, w.y);
    if(n !== state.map_hover){
      state.map_hover = n;
      if(n) map_seedPulses(n);          // pulses animate while a trace is lit
      map_refresh();                    // same-frame instant: top layer only
    }
    cv.style.cursor = n ? 'pointer' : 'grab';
  };

  const upHandler = e => {
    if(ptrs.has(e.pointerId)) ptrs.delete(e.pointerId);
    if(pinch && ptrs.size < 2){ endPanPinch(); cv.style.cursor = 'grab'; return; }
    const wasTap = !moved && (Date.now() - downAt) < 400;
    if(dragNode){ releaseDrag(wasTap); cv.style.cursor = 'grab'; return; }
    if(panSt){
      if(wasTap){
        const s = screenPt(e), w = worldPt(s), n = hit(w.x, w.y);
        if(n){ state.map_hover = n; map_select(n); }
        else { state.map_sel = null; map_paintPanel(); }
      }
      endPanPinch();
      cv.style.cursor = 'grab';
    }
  };
  cv.onpointerup = upHandler;
  cv.onpointercancel = e => { if(ptrs.has(e.pointerId)) ptrs.delete(e.pointerId); releaseDrag(false); endPanPinch(); };

  cv.onmouseleave = () => {
    if(!dragNode && !panSt){ state.map_hover = null; state.map_pulses = []; map_draw(); }
    cv.style.cursor = 'default';
  };

  // wheel: zoom toward the cursor (the world point under it stays put)
  cv.onwheel = e => {
    e.preventDefault();
    const s = screenPt(e), W = cssW(), H = cssH();
    const c = map_cam();
    const z1 = map_clampZ(c.z * Math.exp(-e.deltaY * 0.0013));
    const wx = (s.x - W / 2) / c.z + c.x, wy = (s.y - H / 2) / c.z + c.y;
    state.map_cam = { x: wx - (s.x - W / 2) / z1, y: wy - (s.y - H / 2) / z1, z: z1 };
    state.map_userCam = true;
    map_wheelGesture();
    map_afterCamera();
  };

  // double-click opens the note in Notes (locked notes open the panel instead)
  cv.ondblclick = e => {
    const s = screenPt(e), w = worldPt(s), n = hit(w.x, w.y);
    if(!n) return;
    if(n.noteId && !n.locked){ state.notes_open = n.noteId; nav('notes'); }
    else map_select(n);
  };

  // a mouseup landing on an overlay never reaches the canvas: clear gestures
  // at the window level too (stored for teardown).
  if(state.map_winUp) removeEventListener('mouseup', state.map_winUp);
  state.map_winUp = () => {
    if(dragNode){ ptrs.clear(); releaseDrag(false); }
    else if(panSt || pinch){ ptrs.clear(); endPanPinch(); }
  };
  addEventListener('mouseup', state.map_winUp);

  cv.style.cursor = 'grab';
  map_updateCount();
}

// ── the LEFT DOCK: search (live results + fly-to), legend rows, zoom buttons ──
function map_wireSide(){
  const inp = document.getElementById('mapSearch');
  const res = document.getElementById('mapSearchResults');
  if(inp && res){
    let active = -1, matches = [];
    const hide = () => { res.style.display = 'none'; res.innerHTML = ''; active = -1; matches = []; };
    state.map_searchHide = hide;
    const paintActive = () => {
      res.querySelectorAll('[data-map-hit]').forEach((el, i) => {
        const on = i === active;
        el.style.background = on ? 'var(--surface2)' : 'transparent';
        el.style.borderColor = on ? 'var(--synapse)' : 'transparent';
      });
    };
    const pick = (i) => {
      if(i < 0 || i >= matches.length) return;
      const n = matches[i];
      inp.value = n.title;
      hide();
      map_goToNote(n);
    };
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toLowerCase();
      active = -1;
      if(!q){ hide(); return; }
      const G = state.map_graph; if(!G) return;
      matches = G.nodes
        .map(n => {
          const t = n.title.toLowerCase();
          let score = -1;
          if(t === q) score = 0;
          else if(t.startsWith(q)) score = 1;
          else if(t.indexOf(' ' + q) !== -1 || t.indexOf('-' + q) !== -1 || t.indexOf('_' + q) !== -1) score = 2;
          else if(t.includes(q)) score = 3;
          return { n, score };
        })
        .filter(x => x.score >= 0)
        .sort((a, b) => (a.score - b.score) || (b.n.links - a.n.links) || (a.n.title < b.n.title ? -1 : 1))
        .slice(0, 8)
        .map(x => x.n);
      if(!matches.length){ hide(); return; }
      res.innerHTML = matches.map((n, i) => {
        const col = n.locked ? MAP_LOCKED_COL : n.col;
        return `<div role="option" data-map-hit="${i}" aria-selected="false" style="display:flex;align-items:center;gap:8px;padding:7px 9px;cursor:pointer;border:1px solid transparent;font-family:var(--mono);font-size:11px;color:var(--starlight)">
          <span style="width:8px;height:8px;flex-shrink:0;background:${col};box-shadow:0 0 6px ${col}"></span>
          <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n.title)}</span>
          <span style="font-size:9.5px;color:var(--faint);flex-shrink:0">${n.locked ? '🔒' : esc(n.folder)}</span>
        </div>`;
      }).join('');
      res.style.display = 'block';
      res.querySelectorAll('[data-map-hit]').forEach(el => {
        el.onclick = () => pick(+el.dataset.mapHit);
        el.onmouseenter = () => { active = +el.dataset.mapHit; paintActive(); };
      });
    });
    inp.addEventListener('keydown', e => {
      if(e.key === 'ArrowDown'){ e.preventDefault(); if(matches.length){ active = (active + 1) % matches.length; paintActive(); } }
      else if(e.key === 'ArrowUp'){ e.preventDefault(); if(matches.length){ active = (active - 1 + matches.length) % matches.length; paintActive(); } }
      else if(e.key === 'Enter'){ e.preventDefault(); pick(active >= 0 ? active : 0); }
      else if(e.key === 'Escape'){ e.preventDefault(); inp.value = ''; hide(); map_clearSearch(); map_refresh(); inp.blur(); }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if(document.activeElement !== inp) hide(); }, 140));
  }

  const zc = document.getElementById('mapZoom');
  if(zc) zc.querySelectorAll('[data-map-zoom]').forEach(b => {
    b.onclick = () => { const k = b.dataset.mapZoom; if(k === 'in') map_zoomBy(1.3); else if(k === 'out') map_zoomBy(1 / 1.3); else map_zoomReset(); };
    b.onmouseenter = () => { b.style.borderColor = 'var(--synapse)'; b.style.color = 'var(--synapse)'; };
    b.onmouseleave = () => { b.style.borderColor = 'var(--edge2)'; b.style.color = 'var(--dust)'; };
  });
}

// fly to a note: centre it at ~150%, synapse ring + traced neighbourhood
function map_goToNote(n){
  state.map_searchMark = n.id;
  state.map_hover = n;
  map_seedPulses(n);
  announce(n.title + ' · ' + n.folder);
  map_flyTo({ x: n.x, y: n.y, z: 1.5 });
  map_refresh();
}

function map_clearSearch(){
  state.map_searchMark = null;
  const inp = document.getElementById('mapSearch'); if(inp) inp.value = '';
  if(state.map_searchHide) state.map_searchHide();
}

// ── selection → detail panel (+ lazy note snippet) ──
function map_select(n){
  state.map_sel = { id:n.id, title:n.title, folder:n.folder, col:n.col, noteId:n.noteId, locked:!!n.locked, isHub:!!n.hub, links:n.links, count:n.links };
  announce(n.title + ' · ' + n.folder);
  map_paintPanel();
  if(state.map_sel.noteId && !state.map_sel.locked) map_fetchSnippet(state.map_sel.noteId);
  map_refresh();
}

async function map_fetchSnippet(path){
  state.map_snip = state.map_snip || {};
  if(state.map_snip[path] !== undefined) return;      // cached (incl. in-flight)
  state.map_snip[path] = null;                        // mark loading
  map_paintPanel();
  try{
    const d = await api('/api/note?path=' + encodeURIComponent(path));
    state.map_snip[path] = map_snippet(d && d.content || '');
  }catch(e){ state.map_snip[path] = ''; }
  if(state.map_sel && state.map_sel.noteId === path && state.screen === 'map') map_paintPanel();
}

// strip YAML frontmatter + light markdown, take ~200 chars
function map_snippet(raw){
  let s = String(raw);
  if(s.startsWith('---')){ const end = s.indexOf('\n---', 3); if(end !== -1) s = s.slice(end + 4); }
  s = s.replace(/^#+\s*/gm, '').replace(/[`*_>#\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200) + (s.length > 200 ? '…' : '');
}

function map_paintPanel(){
  const host = document.getElementById('mapPanel'); if(!host) return;
  const s = state.map_sel;
  if(!s){ host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = 'block';

  const deg = s.links + ' connection' + (s.links === 1 ? '' : 's');
  const dotStyle = 'width:11px;height:11px;border-radius:0;flex-shrink:0;background:' + s.col + ';box-shadow:0 0 9px ' + s.col;
  const chipStyle = 'font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:' + s.col + ';border:1px solid var(--edge2);border-radius:0;padding:3px 9px';

  let body = '';
  if(s.locked){
    body = `<div style="font-family:var(--mono);font-size:12px;color:var(--danger);display:flex;align-items:center;gap:8px;margin-bottom:4px">🔒 yours alone</div>
      <p style="font-size:12.5px;color:var(--dust);line-height:1.6;margin:0">this note lives in Private. it's on your map, but no AI can open it, the contents stay with you.</p>`;
  } else {
    const snip = state.map_snip && state.map_snip[s.noteId];
    const snipHtml = (snip === null || snip === undefined)
      ? '<span style="color:var(--faint)">reading the note…</span>'
      : (snip ? esc(snip) : '<span style="color:var(--faint)">no preview available.</span>');
    body = `<p style="font-size:12.5px;color:var(--dust);line-height:1.65;margin:0 0 14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${snipHtml}</p>
      <div style="display:flex;gap:8px">
        <button data-map-act="open" style="flex:1;font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse);background:transparent;padding:9px;border-radius:0;cursor:pointer">open in notes</button>
        <button data-map-act="ask" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:9px 12px;border-radius:0;cursor:pointer">ask</button>
      </div>`;
  }

  host.innerHTML = `
    <div style="display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--edge)">
      <span style="${dotStyle}"></span>
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--grot);font-weight:600;font-size:15px;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title)}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:5px;flex-wrap:wrap"><span style="${chipStyle}">${esc(s.folder)}</span><span style="font-family:var(--mono);font-size:10px;color:var(--faint)">${deg}${s.isHub ? ' · hub' : ''}</span></div>
      </div>
      <button data-map-act="close" aria-label="close panel" style="font-family:var(--mono);font-size:13px;color:var(--faint);background:transparent;border:0;cursor:pointer;flex-shrink:0">✕</button>
    </div>
    <div style="padding:14px 16px">${body}</div>`;

  host.querySelectorAll('[data-map-act]').forEach(el => {
    const act = el.dataset.mapAct;
    el.onclick = () => {
      if(act === 'close'){ state.map_sel = null; map_paintPanel(); map_refresh(); return; }
      if(act === 'open'){ if(s && s.noteId) state.notes_open = s.noteId; nav('notes'); return; }  // deep-link into the specific note
      if(act === 'ask'){ nav('ask'); return; }        // hand off to Ask
    };
    if(act === 'open'){ el.onmouseenter = () => { el.style.background = 'var(--synapse)'; el.style.color = 'var(--on-accent)'; }; el.onmouseleave = () => { el.style.background = 'transparent'; el.style.color = 'var(--synapse)'; }; }
    if(act === 'ask'){ el.onmouseenter = () => { el.style.borderColor = 'var(--dust)'; el.style.color = 'var(--starlight)'; }; el.onmouseleave = () => { el.style.borderColor = 'var(--edge2)'; el.style.color = 'var(--dust)'; }; }
    if(act === 'close'){ el.onmouseenter = () => { el.style.color = 'var(--starlight)'; }; el.onmouseleave = () => { el.style.color = 'var(--faint)'; }; }
  });
}

// ── partition legend rows (click isolates; ⤢ or double-click flies there) ──
function map_paintLegend(){
  const host = document.getElementById('mapLegend'); if(!host) return;
  const G = state.map_graph;
  const parts = state.map_parts || [], colorOf = state.map_colorOf || {}, filt = state.map_filter;
  host.innerHTML = parts.map(p => {
    const col = colorOf[p], on = !filt || filt === p, activeRow = filt === p;
    const n = G ? G.nodes.filter(nd => nd.folder === p).length : 0;
    const dot = 'width:9px;height:9px;border-radius:0;flex-shrink:0;background:' + col + ';box-shadow:0 0 7px ' + col;
    const row = 'display:flex;align-items:center;gap:8px;width:100%;text-align:left;cursor:pointer;font-family:var(--mono);font-size:11px;padding:6px 7px;border-radius:0;transition:.12s;border:1px solid ' + (activeRow ? col : 'transparent') + ';color:' + (on ? 'var(--dust)' : 'var(--faint)') + ';opacity:' + (on ? 1 : 0.55) + ';background:' + (activeRow ? 'var(--surface2)' : 'transparent');
    return `<button type="button" data-map-legend="${esc(p)}" aria-pressed="${activeRow?'true':'false'}" title="${esc(p)} · click to isolate · double-click to fly there" style="${row}">
      <span style="${dot}"></span>
      <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p)}</span>
      <span class="map-lg-count" style="font-size:9.5px;color:var(--faint);flex-shrink:0">${n}</span>
      <span data-map-fly="${esc(p)}" role="button" aria-label="fly to ${esc(p)}" title="fly to ${esc(p)}" style="flex-shrink:0;font-size:12px;line-height:1;color:var(--faint);padding:2px">⤢</span>
    </button>`;
  }).join('') + `<div style="display:flex;align-items:center;gap:8px;padding:7px 8px 3px;font-family:var(--mono);font-size:9.5px;color:var(--faint)"><span style="width:9px;height:9px;border-radius:50%;border:1.5px solid ${MAP_SYNAPSE};flex-shrink:0"></span>hub · double-click a star to open it</div>`;

  host.querySelectorAll('[data-map-legend]').forEach(el => {
    el.onclick = (ev) => {
      const fly = ev.target && ev.target.closest && ev.target.closest('[data-map-fly]');
      if(fly){ ev.stopPropagation(); map_flyToPart(fly.dataset.mapFly); return; }
      map_setFilter(el.dataset.mapLegend);
    };
    el.ondblclick = () => map_flyToPart(el.dataset.mapLegend);
    el.onmouseenter = () => { el.style.opacity = '1'; el.style.color = 'var(--starlight)'; };
    el.onmouseleave = () => map_paintLegend();
  });
}

function map_flyToPart(p){
  const b = map_partBounds(p);
  if(!b) return;
  announce(p);
  map_flyToBounds(b, 2.2);
}

function map_setFilter(p){
  state.map_filter = (state.map_filter === p) ? null : p;
  state.map_sel = null; state.map_hover = null; state.map_pulses = [];
  state.map_staticDirty = true;
  map_paintPanel(); map_paintLegend();
  map_refresh();
}

// ── top-right live badge + zoom readout ──
function map_updateBadge(){
  const b = document.getElementById('mapBadge'), bt = document.getElementById('mapBadgeText');
  if(b && bt){ b.style.display = 'flex'; bt.textContent = state.map_total.toLocaleString('en-US') + ' cells · ' + state.map_edgeTotal.toLocaleString('en-US') + ' links'; }
}

function map_updateCount(){
  const c = document.getElementById('mapCount'); if(!c) return;
  const cam = map_cam();
  c.style.display = 'block';
  c.textContent = 'zoom ' + Math.round(cam.z * 100) + '%';
}
