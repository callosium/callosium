// ── Ask · natural-language questions answered ONLY from the notes ──
// Faithful port of the prototype Ask screen (conversation scroll + composer),
// wired to the real local engine at GET /api/recall. No canned answers: every
// brain reply is built from the engine's own results/context, and unmatched
// questions return the honest "not in your brain" message — never an invention.
//
// State (namespaced ak_*):
//   state.ak_thread  : [{role:'you',text} | {role:'brain', ...}]
//   state.ak_asking  : bool (searching indicator)

// Fallback only — real suggestions come from /api/suggestions, built from the
// user's actual most-connected entities + most-recent notes (see akLoadSuggestions).
const AK_SUGG_DEFAULT = [
  'what are my goals right now?',
  'what did I decide this week?',
  'what should I follow up on?',
];
const akSugg = () => (Array.isArray(state.ak_sugg) && state.ak_sugg.length ? state.ak_sugg : AK_SUGG_DEFAULT);
async function akLoadSuggestions(){
  if(state.ak_suggLoading) return;
  state.ak_suggLoading = true;
  try{ const r = await api('/api/suggestions'); if(r && Array.isArray(r.suggestions) && r.suggestions.length){ state.ak_sugg = r.suggestions; if(state.screen==='ask') renderAsk(); } }
  catch(e){}
}
const AK_HONESTY = "that's not in your brain yet. I only answer from what you've saved — I never make things up. try adding a note, or ask me something else.";

// path → "Partition / basename" (no .md), the design's source-chip label
function akPartLabel(p){
  const parts = String(p||'').split(/[\\/]/).filter(Boolean);
  const base = (parts[parts.length-1]||String(p||'')).replace(/\.md$/i,'');
  const partition = parts.length>1 ? parts[0] : '';
  return partition ? partition+' / '+base : base;
}

// JS-driven hover/focus so fidelity holds regardless of inline-vs-stylesheet
// specificity (the composer/chips/button all carry inline base styles).
function akHover(el, hb, hc, rb, rc){
  el.addEventListener('mouseenter', ()=>{ el.style.borderColor=hb; el.style.color=hc; });
  el.addEventListener('mouseleave', ()=>{ el.style.borderColor=rb; el.style.color=rc; });
}

function akScrollToEnd(){
  const c = document.getElementById('akScroll');
  if(c) requestAnimationFrame(()=>{ c.scrollTop = c.scrollHeight; });
}

function renderAsk(){
  if(!Array.isArray(state.ak_thread)) state.ak_thread = [];
  if(state.ak_sugg===undefined) akLoadSuggestions(); // personalize from the real brain, once
  const thread = state.ak_thread;
  const asking = !!state.ak_asking;
  const hasThread = thread.length > 0;
  const empty = !hasThread && !asking;

  // ── suggestion chip (two variants: big empty-state, small composer) ──
  const suggBig = q => `<button type="button" class="ak-sugg" data-q="${esc(q)}" data-v="big" style="cursor:pointer;font-family:var(--mono);font-size:15px;color:var(--dust);border:1px solid var(--edge2);border-radius:0;padding:11px 18px;transition:.12s;background:none">${esc(q)}</button>`;
  const suggSm  = q => `<button type="button" class="ak-sugg" data-q="${esc(q)}" data-v="sm" style="cursor:pointer;font-family:var(--mono);font-size:13px;color:var(--dust);border:1px solid var(--edge2);border-radius:0;padding:7px 13px;transition:.12s;background:none">${esc(q)}</button>`;

  // ── one message ──
  const youBubble = m => `<div style="display:flex;justify-content:flex-end;margin-bottom:18px"><div style="max-width:74%;background:var(--surface2);border:1px solid var(--edge2);border-radius:0;padding:12px 16px;font-size:15.5px;color:var(--starlight)">${esc(m.text)}</div></div>`;

  const brainMsg = m => {
    const textStyle = 'font-size:16px;line-height:1.72;color:'+(m.notFound?'var(--amber)':'var(--starlight)')+';white-space:pre-wrap';
    let body = `<div style="${textStyle}">${esc(m.text)}</div>`;
    if(m.extra){
      body += `<div style="font-size:15px;line-height:1.7;color:var(--dust);white-space:pre-wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--edge)">${esc(m.extra)}</div>`;
    }
    // honest disclosures, in amber (loosening / clarify) — the brain never
    // hides that a match was looser than the words asked.
    if(m.notFound && m.reason){
      body += `<div style="font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:10px;line-height:1.6">${esc(m.reason)}</div>`;
    }
    if(m.loosened){
      body += `<div style="font-family:var(--mono);font-size:11px;color:var(--amber);margin-top:10px;line-height:1.6">answered after loosening — set aside <span style="color:var(--starlight)">${esc(m.loosened)}</span> to find this.</div>`;
    }
    if(m.clarifyReason){
      body += `<div style="font-family:var(--sans);font-size:12.5px;color:var(--amber);margin-top:10px;line-height:1.6">${esc(m.clarifyReason)}</div>`;
    }
    if(m.corrections && m.corrections.length){
      body += `<div style="font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:8px">read that as ${m.corrections.map(c=>esc(c.from)+' → '+esc(c.to)).join(' · ')}</div>`;
    }
    if(m.sources && m.sources.length){
      const chips = m.sources.map((s,i)=>`<button type="button" class="ak-src" data-path="${esc(s.path)}" style="cursor:pointer;font-family:var(--mono);font-size:12.5px;color:var(--dust);border:1px solid var(--edge2);border-radius:0;padding:6px 11px;display:inline-flex;align-items:center;gap:6px;transition:.12s;background:none"><span style="color:var(--synapse-ink)">↳</span>${esc(s.label)}</button>`).join('');
      body += `<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:12px">${chips}</div>`;
    }
    if(m.meta){
      body += `<div style="font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:10px">${esc(m.meta)}</div>`;
    }
    return `<div style="display:flex;gap:12px;margin-bottom:22px">
        <span style="width:30px;height:30px;flex-shrink:0;border-radius:0;border:1px solid var(--edge2);background:var(--surface2);display:flex;align-items:center;justify-content:center"><span style="width:8px;height:8px;background:var(--synapse);box-shadow:0 0 9px var(--synapse)"></span></span>
        <div style="flex:1;min-width:0">${body}</div>
      </div>`;
  };

  const searchingBlock = `<div style="display:flex;gap:12px;margin-bottom:22px;align-items:center">
      <span style="width:30px;height:30px;flex-shrink:0;border-radius:0;border:1px solid var(--edge2);background:var(--surface2);display:flex;align-items:center;justify-content:center"><span style="width:8px;height:8px;background:var(--synapse);box-shadow:0 0 9px var(--synapse);animation:dotpulse 1s infinite"></span></span>
      <span style="font-family:var(--mono);font-size:13px;color:var(--dust)">searching your brain…</span>
    </div>`;

  // ── scroll-area contents ──
  let scrollInner;
  if(empty){
    scrollInner = `<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px 20px">
        <div style="width:46px;height:46px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:20px;background:var(--surface2)"><span style="width:11px;height:11px;background:var(--synapse);border-radius:0;box-shadow:0 0 16px var(--synapse);animation:seampulse 2.6s ease-in-out infinite"></span></div>
        <h1 style="font-family:var(--pixel);font-weight:700;font-size:42px;letter-spacing:.01em;line-height:1.02;margin-bottom:14px">ask your brain anything.</h1>
        <p style="color:var(--dust);font-size:15px;max-width:50ch;margin-bottom:24px">answers come only from your own notes — with the sources, every time. nothing invented. if it's not in your brain, it says so.</p>
        <div style="display:flex;flex-wrap:wrap;gap:9px;justify-content:center;max-width:580px">${akSugg().map(suggBig).join('')}</div>
      </div>`;
  } else {
    scrollInner = `<div style="max-width:764px;margin:0 auto;padding:12px 4px 6px">${thread.map(m=>m.role==='you'?youBubble(m):brainMsg(m)).join('')}${asking?searchingBlock:''}</div>`;
  }

  $('#screen').innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;min-height:520px">
      <div id="akScroll" style="flex:1;overflow:auto;padding:2px 4px 10px">${scrollInner}</div>

      <div style="border-top:1px solid var(--edge);padding:14px 4px 2px">
        <div style="max-width:764px;margin:0 auto">
          ${hasThread?`<div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:11px">${akSugg().map(suggSm).join('')}</div>`:''}
          <div style="display:flex;gap:10px;align-items:center">
            <input id="akInput" placeholder="ask your brain…" aria-label="ask your brain" autocomplete="off" style="flex:1;background:var(--surface);border:1px solid var(--edge2);border-radius:0;padding:13px 16px;font-family:var(--sans);font-size:15px;color:var(--starlight)">
            <button id="akSend" style="font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:12px 22px;border-radius:0;cursor:pointer;transition:.14s">ask</button>
          </div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:9px;text-align:center">answers only from your brain · says <span style="color:var(--dust)">"not in the brain"</span> when it doesn't know · nothing leaves this device</div>
        </div>
      </div>
    </div>`;

  // ── wire ──
  const input = document.getElementById('akInput');
  const sendBtn = document.getElementById('akSend');
  // a query handed over from the shell search (Enter up there lands here)
  const prefilled = state.ak_prefill != null;
  if(input && prefilled){ input.value = state.ak_prefill; state.ak_prefill = null; }
  if(input){
    input.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); akSend(); } });
    input.addEventListener('focus', ()=>{ input.style.borderColor='var(--synapse)'; input.style.outline='none'; });
    input.addEventListener('blur',  ()=>{ input.style.borderColor='var(--edge2)'; });
  }
  if(sendBtn){
    sendBtn.addEventListener('click', ()=>akSend());
    sendBtn.addEventListener('mouseenter', ()=>{ if(state.ak_asking) return; sendBtn.style.background='var(--synapse)'; sendBtn.style.color='var(--on-accent)'; });
    sendBtn.addEventListener('mouseleave', ()=>{ sendBtn.style.background='transparent'; sendBtn.style.color='var(--synapse-ink)'; });
  }
  $$('#screen .ak-sugg').forEach(el=>{
    el.addEventListener('click', ()=>akSend(el.dataset.q));
    if(el.dataset.v==='big') akHover(el, 'var(--synapse)', 'var(--synapse-ink)', 'var(--edge2)', 'var(--dust)');
    else akHover(el, 'var(--dust)', 'var(--dust)', 'var(--edge2)', 'var(--faint)');
  });
  $$('#screen .ak-src').forEach(el=>{
    el.addEventListener('click', ()=>{ if(el.dataset.path) state.notes_open = el.dataset.path; nav('notes'); });
    akHover(el, 'var(--synapse)', 'var(--synapse-ink)', 'var(--edge2)', 'var(--dust)');
  });

  if(hasThread || asking) akScrollToEnd();
  if(input && (hasThread || asking || prefilled)) input.focus();
}

// ── ask the real engine; build the reply from ITS evidence only ──
async function akSend(q){
  if(!Array.isArray(state.ak_thread)) state.ak_thread = [];
  if(state.ak_asking) return;
  const query = (q==null ? (document.getElementById('akInput')?.value||'') : q).trim();
  if(!query) return;

  state.ak_thread.push({ role:'you', text:query });
  state.ak_asking = true;
  renderAsk();
  announce('searching your brain…');

  const t0 = performance.now();
  let data;
  try{
    data = await api('/api/recall?q='+encodeURIComponent(query));
  }catch(e){
    data = { __error:true };
  }
  const ms = Math.max(1, Math.round(performance.now()-t0));
  state.ak_asking = false;

  if(!data || data.__error){
    // transport failure — honest, never a fabricated answer
    state.ak_thread.push({ role:'brain', notFound:true, text:"I couldn't reach your brain just now. it stays on this device — check that the engine is running and ask again." });
    announce("couldn't reach your brain");
  } else if(data.error){
    // engine said no (e.g. no brain connected / empty query)
    state.ak_thread.push({ role:'brain', notFound:true, text: String(data.error).toLowerCase() });
    announce('not in your brain');
  } else if(data.found && (data.results||[]).length){
    const results = data.results || [];
    // source chips = result paths + interlinked context paths (deduped, capped)
    const paths = [];
    results.forEach(r=>{ if(r.path && !paths.includes(r.path)) paths.push(r.path); });
    (data.context||[]).forEach(c=>{ if(c.path && !paths.includes(c.path)) paths.push(c.path); });
    const sources = paths.slice(0,8).map(p=>({ path:p, label:akPartLabel(p) }));
    const rel = data.relaxation && Array.isArray(data.relaxation.droppedTerms) ? data.relaxation.droppedTerms.filter(Boolean) : [];
    state.ak_thread.push({
      role:'brain', notFound:false,
      text: (results[0].excerpt||'').trim(),
      extra: results[1] ? (results[1].excerpt||'').trim() : null,
      sources,
      loosened: rel.length ? rel.join(', ') : null,
      clarifyReason: (data.clarify && data.clarify.reason) ? data.clarify.reason : null,
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
      meta: 'recalled '+results.length+' note'+(results.length===1?'':'s')+' · '+ms+'ms',
    });
    announce('answer ready · recalled '+results.length+' note'+(results.length===1?'':'s'));
  } else {
    // not found — the amber honesty message, with the engine's reason if any
    state.ak_thread.push({
      role:'brain', notFound:true,
      text: AK_HONESTY,
      reason: data.notInBrainReason || null,
      corrections: Array.isArray(data.corrections) ? data.corrections : [],
    });
    announce('not in your brain');
  }
  // A slow recall must not paint Ask over whatever screen the user has since
  // navigated to — recall can take seconds, and leaving for Notes/Brain Map mid-
  // search used to have the Ask thread drop on top of it out of nowhere. The
  // answer is already in state.ak_thread, so it's all there when they come back
  // (akLoadSuggestions guards its own late render the same way).
  if(state.screen==='ask') renderAsk();
}
