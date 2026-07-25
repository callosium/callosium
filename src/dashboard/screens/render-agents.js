// ── agents + scoping (headline feature) ─────────────────────────────────────
// Faithful port of the Claude Design "one brain. many minds." screen, wired to
// the real local engine (GET /api/agents · POST /api/scope · /api/pair · /api/revoke).
// Renders into #screen only; uses the shared globals (state, $, $$, api, post,
// esc, px, nav, relTime). All screen-local state is namespaced state.ag_*.

// ── static metadata: known agents/apps get the design's glyph + accent ──
const AG_META = {
  'claude-desktop': { glyph:'C', accent:'var(--acid)'    },
  'claude-code':    { glyph:'⌘', accent:'var(--synapse)' },
  'cursor':         { glyph:'▹', accent:'var(--amber)'   },
  'chatgpt':        { glyph:'◇', accent:'var(--ember)'   },
  'gemini':         { glyph:'◈', accent:'var(--acid)'    },
  'perplexity':     { glyph:'✸', accent:'var(--ember)'   },
  'raycast':        { glyph:'◐', accent:'var(--amber)'   },
};
const AG_ACCENTS = ['var(--acid)','var(--synapse)','var(--amber)','var(--ember)'];
// modal quick-picks — prefill the pair form (no real auto-detection on this build)
const AG_PRESETS = [
  { id:'gemini',     name:'Gemini',         glyph:'◈', accent:'var(--acid)',   detail:'desktop app' },
  { id:'perplexity', name:'Perplexity',     glyph:'✸', accent:'var(--ember)',  detail:'desktop app' },
  { id:'raycast',    name:'Raycast',        glyph:'◐', accent:'var(--amber)',  detail:'installed' },
  { id:'other',      name:'something else', glyph:'+', accent:'var(--dust)',   detail:'any AI that speaks the open standard' },
];

function ag_meta(a){
  const m = AG_META[a && a.id]; if(m) return m;
  const name = (a && (a.displayName || a.id)) || '?';
  let h = 0; const id = (a && a.id) || ''; for(let i=0;i<id.length;i++) h = (h*31 + id.charCodeAt(i)) >>> 0;
  return { glyph:(String(name).trim()[0] || '?').toUpperCase(), accent: AG_ACCENTS[h % AG_ACCENTS.length] };
}

// ── scope math (EXACT engine mapping; scope arrays store paths WITH trailing slash) ──
// A write entry that matches no real partition path (no trailing slash, so it
// can never equal ag_trail(folder)). It lets `write` stay NON-empty when the
// user has revoked write on every folder — because an EMPTY write array is
// overloaded by the engine to mean "writable everywhere readable", which would
// silently flip the last look-downgrade back to edit.
const AG_WRITE_NONE = '(none)';
const ag_trail  = p => (p.endsWith('/') ? p : p + '/');
const ag_wo     = (arr,x) => (arr||[]).filter(v => v !== x);
const ag_union  = (arr,x) => (arr||[]).includes(x) ? [...arr] : [ ...(arr||[]), x ];
function ag_canRead(sc, p){ const pk = ag_trail(p), read = sc.read||[], deny = sc.denyRead||[];
  return (read.length === 0 || read.includes(pk)) && !deny.includes(pk); }
function ag_canWrite(sc, p){ const pk = ag_trail(p), write = sc.write||[];
  return ag_canRead(sc, p) && (write.length === 0 ? true : write.includes(pk)); }
function ag_perm(sc, p){ return !ag_canRead(sc, p) ? 'off' : ag_canWrite(sc, p) ? 'edit' : 'look'; }
function ag_currentReadable(sc, partitions){
  // System is the ONLY structurally owner-only folder now. Private is grantable
  // per-agent (default-denied via denyRead), so it must be materializable into
  // the write set when the owner grants it — otherwise granting edit elsewhere
  // would silently drop a previously-granted Private.
  return (partitions||[]).filter(p => p !== 'System'
    && ((sc.read||[]).length === 0 || (sc.read||[]).includes(ag_trail(p)))
    && !(sc.denyRead||[]).includes(ag_trail(p))); }
// return a NEW scopes object with folder P set to `perm`
function ag_setPerm(sc, partitions, p, perm){
  const pk = ag_trail(p);
  let read = [ ...(sc.read||[]) ], deny = [ ...(sc.denyRead||[]) ], write = [ ...(sc.write||[]) ];
  if(perm === 'off'){
    deny = ag_union(deny, pk); read = ag_wo(read, pk);
    const hadExplicitWrite = write.length !== 0;
    write = ag_wo(write, pk);
    // If removing this folder emptied a previously EXPLICIT write set, keep write
    // non-empty with the sentinel — an empty write means "writable everywhere
    // readable" (the engine's canWrite returns true), the exact opposite of what
    // turning a folder off should do. Same guard the look/edit branch uses.
    if(hadExplicitWrite && write.length === 0) write = [AG_WRITE_NONE];
  } else {
    deny = ag_wo(deny, pk);
    if(read.length !== 0 && !read.includes(pk)) read.push(pk);
    // Materialize write to the EXPLICIT set of currently-writable folders before
    // touching it: an empty write means "writable everywhere readable", which
    // can't be told apart from "nothing writable" once we add/remove one folder.
    // Remember the sentinel BEFORE stripping it. [AG_WRITE_NONE] means "nothing is
    // writable"; a genuinely empty write means "unset → writable everywhere readable".
    // Stripping first collapsed those two opposite states into one, so an agent the
    // owner had explicitly set to write-nothing was silently re-materialized as
    // write-everything-readable the next time ANY folder's read permission changed.
    const wroteNothing = write.includes(AG_WRITE_NONE);
    write = ag_wo(write, AG_WRITE_NONE);
    if(write.length === 0 && !wroteNothing) write = ag_currentReadable({ read, denyRead:deny, write:[] }, partitions).map(ag_trail);
    if(perm === 'look') write = ag_wo(write, pk);
    else                write = ag_union(write, pk);  // edit
    // If the look-downgrade removed the last writable folder, keep write
    // NON-empty with the sentinel so it means "nothing", not "everything".
    if(write.length === 0) write = [AG_WRITE_NONE];
  }
  return { read, denyRead:deny, write };
}

// ── data ──
async function agentsLoad(){
  try{
    const d = await api('/api/agents');
    const parts = d.partitions || [];
    // Fail CLOSED: an agent record missing scopes must read as "reaches nothing",
    // never as "edit everything" (which an all-empty scope object would mean).
    (d.agents||[]).forEach(a=>{ if(!a.scopes || typeof a.scopes!=='object') a.scopes = { read: [], denyRead: parts.map(ag_trail), write: [] }; });
    state.ag_data = { agents: (d.agents||[]), partitions: parts };
    state.ag_err = null;
    if(!state.ag_data.agents.find(a => a.id === state.ag_selected))
      state.ag_selected = state.ag_data.agents[0] ? state.ag_data.agents[0].id : null;
  }catch(e){
    state.ag_err = e;
    if(!state.ag_data) state.ag_data = { agents:[], partitions:[] };
  }
}

// toggleable folders (everything but System, the one structurally owner-only
// folder). Private is included: it's off for every agent by default and only the
// owner can grant it — so it renders as a scope row, styled to read as sensitive.
function ag_toggleable(){ return (state.ag_data.partitions||[]).filter(p => p !== 'System'); }
function ag_count(name){ const o = state.overview; const c = o && o.partitions && o.partitions[name];
  return (c == null) ? '' : (c.toLocaleString('en-US') + ' notes'); }
function ag_reach(a){ const sc = a.scopes || {}; let n = 0; ag_toggleable().forEach(p => { if(ag_perm(sc, p) !== 'off') n++; }); return n; }

// ── panel chrome (matches the README "OS window" pattern) ──
const AG_PANEL      = 'border:1px solid var(--edge2);border-radius:0;background:var(--surface);overflow:hidden';
const AG_PANELBAR   = 'padding:9px 14px;border-bottom:1px solid var(--edge);background:var(--surface2);display:flex;align-items:center';
const AG_PANELTITLE = 'font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)';

// ── entry: fetch, paint, run the scramble title once ──
async function renderAgents(){
  if(!state.ag_data) $('#screen').innerHTML =
    '<div style="font-family:var(--mono);color:var(--faint);padding:20px">connecting to your brain…</div>';
  await agentsLoad();
  if(state.screen !== 'agents') return; // user navigated away during the fetch — don't paint over the new screen
  agentsPaint();
  agentsScramble();
}

// ── the scramble/decode title effect (ports scrambleField) ──
function agentsScramble(){
  const text = 'one brain. many minds.';
  clearInterval(state.ag_scrIv);
  // reduced motion: the settled title at once, no decode cycle
  if(window.__reduceMotion){ const el0 = document.getElementById('agTitleText'); if(el0) el0.textContent = text; return; }
  const SCR = '!<>-_\\/[]{}=+*^?#01', F = 18, SP = 34; let f = 0;
  state.ag_scrIv = setInterval(() => {
    const el = document.getElementById('agTitleText');
    if(!el){ clearInterval(state.ag_scrIv); return; }
    f++;
    const resolved = Math.floor(text.length * f / F);
    let out = '';
    for(let i=0;i<text.length;i++) out += (i < resolved) ? text[i] : (text[i] === ' ' ? ' ' : SCR[(Math.random()*SCR.length)|0]);
    el.textContent = out;
    if(f >= F){ clearInterval(state.ag_scrIv); el.textContent = text; }
  }, SP);
}

// ── render everything from state.ag_data (no fetch) ──
function agentsPaint(){
  const d = state.ag_data || { agents:[], partitions:[] };
  const agents = d.agents || [];
  const toggle = ag_toggleable();
  const M = toggle.length;

  // header (always present) — scramble title + subtitle
  const header = `
    <div style="margin-bottom:20px;animation:rise .4s ease both">
      <h1 id="agTitle" style="font-family:var(--pixel);font-weight:700;font-size:42px;letter-spacing:.01em;line-height:1.02;cursor:pointer;user-select:none"><span id="agTitleText">one brain. many minds.</span><span style="color:var(--synapse)">_</span></h1>
      <div style="font-family:var(--mono);font-size:15px;color:var(--dust);margin-top:12px">every AI you connect shares the same memory · <span style="color:var(--acid)">you choose what each one can reach</span></div>
    </div>`;

  let body = '';

  if(state.ag_err){
    // honest fetch-failure state (guardrail-style red panel)
    body = `
      <div style="border:1px solid var(--danger);border-radius:0;background:rgba(255,51,85,.06);padding:14px 16px;display:flex;gap:13px;align-items:center">
        <span style="font-size:16px;color:var(--danger)">⚠</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--pixel);font-size:16px;margin-bottom:3px">couldn't reach your brain.</div>
          <div style="font-size:12.5px;color:var(--dust)">the local engine didn't answer. nothing changed — your scopes are exactly as you left them.</div>
        </div>
        <button data-ag-act="retry" style="font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;border:1px solid var(--danger);color:var(--danger);background:transparent;padding:8px 13px;border-radius:0;cursor:pointer;white-space:nowrap">retry</button>
      </div>`;
  } else if(agents.length === 0){
    // empty: "give your first AI a memory" hero
    body = `
      <div style="${AG_PANEL}">
        <div style="${AG_PANELBAR}"><span style="${AG_PANELTITLE}">no AIs linked yet</span></div>
        <div style="padding:44px 30px;text-align:center;display:flex;flex-direction:column;align-items:center">
          <div style="width:48px;height:48px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:20px;background:var(--surface2);--icon:var(--synapse)">${px('plus',22)}</div>
          <h2 style="font-family:var(--pixel);font-weight:600;font-size:24px;margin-bottom:10px">give your first AI a memory.</h2>
          <p style="color:var(--dust);font-size:14px;max-width:50ch;margin-bottom:24px">connect Claude, ChatGPT, Cursor — whatever you use. it reads the same brain you do, and only touches the folders you allow. Private is off for every AI unless you grant it.</p>
          <button data-ag-act="openLink" style="font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:12px 20px;border-radius:0;cursor:pointer;display:inline-flex;align-items:center;gap:9px;--icon:var(--synapse)">${px('plus',14)}<span>link your first AI</span></button>
        </div>
      </div>`;
  } else {
    // populated: 312px list + 1fr detail
    body = `
      <div class="ag-layout" style="display:grid;grid-template-columns:312px 1fr;gap:16px;align-items:start">
        ${agentsListPanel(agents, M)}
        ${agentsDetailPanel(agents, toggle)}
      </div>`;
  }

  const modal = agentsLinkModal() + agentsUnlinkModal(agents);

  $('#screen').innerHTML = header + body + modal;
  agentsWire();
}

// ── LEFT: connected-AI list ──
function agentsListPanel(agents, M){
  const cards = agents.map(a => {
    const m = ag_meta(a), sel = a.id === state.ag_selected;
    const glyphStyle = 'width:34px;height:34px;flex-shrink:0;border-radius:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:15px;background:var(--surface2);border:1px solid var(--edge2);color:'+m.accent;
    const cardStyle = 'display:flex;align-items:center;gap:11px;padding:10px;border-radius:0;cursor:pointer;transition:.14s;margin-bottom:6px;border:1px solid '+(sel?'var(--synapse)':'transparent')+';background:'+(sel?'rgba(255,46,136,.06)':'transparent')+';width:100%;text-align:left;font-family:inherit';
    const dot = 'width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--acid);box-shadow:0 0 6px var(--acid);animation:dotpulse 1.4s infinite';
    return `<button type="button" data-ag-select="${esc(a.id)}" data-ag-selected="${sel?'1':'0'}"${sel?' aria-current="true"':''} style="${cardStyle}">
        <span style="${glyphStyle}">${esc(m.glyph)}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px"><span style="font-family:var(--grot);font-weight:600;font-size:13.5px;color:var(--starlight);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.displayName || a.id)}</span></div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;font-family:var(--mono);font-size:10.5px;color:var(--faint)"><span style="${dot}"></span>linked · reaches ${ag_reach(a)} of ${M}</div>
        </div>
      </button>`;
  }).join('');

  return `
    <div style="${AG_PANEL}">
      <div style="${AG_PANELBAR}"><span style="${AG_PANELTITLE}">connected</span><span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--faint)">${agents.length} linked</span></div>
      <div style="padding:10px">
        ${cards}
        <button data-ag-act="openLink" style="width:100%;margin-top:6px;display:flex;align-items:center;justify-content:center;gap:9px;font-family:var(--pixel);font-weight:500;font-size:14px;letter-spacing:.03em;color:var(--synapse-ink);background:transparent;border:1px dashed var(--edge2);border-radius:0;padding:13px;cursor:pointer;transition:.14s;--icon:var(--synapse)">${px('plus',14)}<span>link an AI</span></button>
      </div>
    </div>`;
}

// ── RIGHT: selected-agent detail + scope grid ──
function agentsDetailPanel(agents, toggle){
  const a = agents.find(x => x.id === state.ag_selected) || agents[0];
  const m = ag_meta(a), sc = a.scopes || { read:[], denyRead:[], write:[] };

  // trust summary — read live from the scope
  let lookN = 0, editN = 0;
  toggle.forEach(p => { const pm = ag_perm(sc, p); if(pm === 'look') lookN++; else if(pm === 'edit') editN++; });
  const bits = [];
  if(lookN) bits.push('look at ' + lookN + ' folder' + (lookN>1?'s':''));
  if(editN) bits.push('edit ' + editN);
  const name = a.displayName || a.id;
  const privGranted = ag_perm(sc, 'Private') !== 'off';
  const privLine = privGranted ? ' Private is granted — you can turn it off anytime.' : ' Private stays off until you grant it.';
  const trust = name + ' ' + (bits.length ? 'can ' + bits.join(' and ') : 'has no folders switched on yet') + '.' + privLine;
  const reach = ag_reach(a), M = toggle.length;
  const pairedLine = a.pairedAt ? ('linked ' + relTime(a.pairedAt)) : 'linked';

  const selGlyphStyle = 'width:44px;height:44px;flex-shrink:0;border-radius:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:20px;background:var(--surface2);border:1px solid var(--edge2);color:'+m.accent;
  const selDot = 'width:6px;height:6px;border-radius:50%;background:var(--acid);box-shadow:0 0 6px var(--acid);animation:dotpulse 1.4s infinite';

  // scope rows — one segmented control per toggleable folder
  const seg = (part, val, label, cur) => {
    const on = cur === val, col = val==='look' ? 'var(--acid)' : val==='edit' ? 'var(--synapse)' : 'var(--faint)';
    const color = on ? (val==='off' ? 'var(--void)' : 'var(--on-accent)') : 'var(--faint)';
    const bg    = on ? (val==='off' ? 'var(--faint)' : col) : 'transparent';
    const style = 'font-family:var(--mono);font-size:11px;letter-spacing:.03em;padding:5px 12px;border-radius:0;cursor:pointer;transition:.12s;color:'+color+';background:'+bg+';border:0';
    return `<button type="button" data-ag-scope="${esc(part)}" data-ag-perm="${val}" aria-pressed="${on?'true':'false'}" aria-label="${esc(part)}: ${label}" style="${style}">${label}</button>`;
  };
  const normalRow = (part) => {
    const cur = ag_perm(sc, part), cnt = ag_count(part);
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:0;background:var(--surface2)">
        <div style="flex:1;min-width:0;display:flex;align-items:center;gap:9px">
          <span style="font-family:var(--mono);font-size:13px;color:var(--starlight)">${esc(part)}</span>
          ${cnt ? `<span style="font-family:var(--mono);font-size:10px;color:var(--faint)">${cnt}</span>` : ''}
        </div>
        <div style="display:flex;gap:3px;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:3px">
          ${seg(part,'off','off',cur)}${seg(part,'look','look',cur)}${seg(part,'edit','edit',cur)}
        </div>
      </div>`;
  };
  // Private renders as a scope row too — but styled to read as sensitive. It's
  // off for every agent by default; granting it is a deliberate, visible act.
  const privateRow = () => {
    const cur = ag_perm(sc, 'Private'), cnt = ag_count('Private'), granted = cur !== 'off';
    const tint = granted ? 'rgba(255,51,85,.09)' : 'rgba(255,51,85,.045)';
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:0;background:${tint};border:1px solid rgba(255,51,85,.22)">
        <div style="flex:1;min-width:0;display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <span style="font-family:var(--mono);font-size:13px;color:var(--starlight)">${granted?'🔓':'🔒'} Private</span>
          ${cnt ? `<span style="font-family:var(--mono);font-size:10px;color:var(--faint)">${cnt}</span>` : ''}
          <span style="font-family:var(--mono);font-size:10px;color:${granted?'var(--danger)':'var(--faint)'}">${granted?'granted to '+esc((name||'').split(' ')[0]):'yours alone — off by default'}</span>
        </div>
        <div style="display:flex;gap:3px;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:3px">
          ${seg('Private','off','off',cur)}${seg('Private','look','look',cur)}${seg('Private','edit','edit',cur)}
        </div>
      </div>`;
  };
  // normal folders first, Private last (visually separated); System stays locked.
  const rows = toggle.filter(p => p !== 'Private').map(normalRow).join('')
    + (toggle.includes('Private') ? privateRow() : '');

  // System is the one folder no scope edit can ever grant — the 🔒 that stays.
  const parts = state.ag_data.partitions || [];
  const locked = parts.includes('System') ? `
      <div style="display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:0;background:rgba(255,51,85,.05);border:1px solid rgba(255,51,85,.22)">
        <div style="flex:1;min-width:0;display:flex;align-items:center;gap:9px">
          <span style="font-family:var(--mono);font-size:13px;color:var(--starlight)">System</span>
          ${ag_count('System') ? `<span style="font-family:var(--mono);font-size:10px;color:var(--faint)">${ag_count('System')}</span>` : ''}
          <span style="font-family:var(--mono);font-size:10px;color:var(--danger);display:flex;align-items:center;gap:4px">🔒 managed</span>
        </div>
        <div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);border:1px solid var(--edge2);border-radius:0;padding:6px 12px;opacity:.6">off · locked</div>
      </div>` : '';

  return `
    <div style="${AG_PANEL}">
      <div class="ag-detail-head" style="padding:16px 18px;border-bottom:1px solid var(--edge);display:flex;align-items:center;gap:12px">
        <span style="${selGlyphStyle}">${esc(m.glyph)}</span>
        ${state.ag_renaming === a.id ? `
        <input id="agRename" data-ag-stop="1" value="${esc(name)}" maxlength="64" placeholder="display name" aria-label="display name" style="flex:1;min-width:0;background:var(--void);border:1px solid var(--synapse);border-radius:0;padding:9px 12px;font-family:var(--grot);font-weight:600;font-size:16px;color:var(--starlight);box-sizing:border-box">
        <button data-ag-act="renameSave" style="font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:7px 12px;border-radius:0;cursor:pointer;flex-shrink:0" ${state.ag_renameBusy?'disabled':''}>${state.ag_renameBusy?'saving…':'save'}</button>
        <button data-ag-act="renameCancel" title="cancel" aria-label="cancel rename" style="font-family:var(--mono);font-size:14px;color:var(--faint);background:transparent;border:0;cursor:pointer;flex-shrink:0">✕</button>
        ` : `
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--grot);font-weight:600;font-size:17px;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
          <div style="display:flex;align-items:center;gap:7px;margin-top:4px;font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="${selDot}"></span>${esc(pairedLine)} · reaches ${reach}/${M} folders</div>
        </div>
        <button data-ag-act="rename" title="rename this AI" style="font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;border:1px solid var(--edge2);color:var(--faint);background:transparent;padding:7px 10px;border-radius:0;cursor:pointer;flex-shrink:0">rename</button>
        <button data-ag-act="rotate" title="issue a new token, the old one stops working" style="font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;border:1px solid var(--edge2);color:var(--faint);background:transparent;padding:7px 10px;border-radius:0;cursor:pointer;flex-shrink:0" ${state.ag_rotating?'disabled':''}>${state.ag_rotating?'rotating…':'rotate token'}</button>
        <button data-ag-act="openUnlink" title="unlink" style="font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;border:1px solid var(--edge2);color:var(--faint);background:transparent;padding:7px 10px;border-radius:0;cursor:pointer;flex-shrink:0">unlink</button>
        `}
      </div>

      <div style="padding:15px 20px;border-bottom:1px solid var(--edge);background:var(--surface2);display:flex;align-items:center;gap:11px">
        <span style="width:26px;height:26px;flex-shrink:0;border-radius:0;border:1px solid var(--edge2);display:flex;align-items:center;justify-content:center;color:var(--acid);font-size:13px">✓</span>
        <div style="font-size:12.5px;color:var(--dust);line-height:1.5">${esc(trust)}</div>
      </div>

      <div style="padding:16px 20px 20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:13px">
          <span style="font-family:var(--pixel);font-weight:600;font-size:14px;letter-spacing:.04em;text-transform:uppercase;color:var(--dust)">what it can reach</span>
          <div style="display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)">
            <span style="display:flex;align-items:center;gap:5px"><i style="width:7px;height:7px;border-radius:0;background:var(--faint)"></i>off</span>
            <span style="display:flex;align-items:center;gap:5px"><i style="width:7px;height:7px;border-radius:0;background:var(--acid)"></i>can look</span>
            <span style="display:flex;align-items:center;gap:5px"><i style="width:7px;height:7px;border-radius:0;background:var(--synapse)"></i>can edit</span>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:2px">${rows}${locked}</div>

        <div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:14px;padding-top:13px;border-top:1px solid var(--surface2);line-height:1.6">changes apply the moment you tap — no save button. <span style="color:var(--dust)">${esc((name||'').split(' ')[0])} only ever sees folders you switch on.</span></div>
      </div>
    </div>`;
}

// ── link modal (backend gap #1: pair form → config to copy, keeps the visual design) ──
// the just-paired agent's server spec ({command,args,env}) regardless of key name
function ag_serverSpec(){
  const c = state.ag_pairConfig;
  if(c && c.mcpServers){ const v = Object.values(c.mcpServers)[0]; if(v) return v; }
  if(c && c.command) return c;
  return null;
}
function agentsLinkModal(){
  if(!state.ag_linkOpen) return '';
  const step = state.ag_linkStep || 0;
  let inner = '';

  if(step === 0){
    const presets = AG_PRESETS.map((app, pi) => `
        <button type="button" data-ag-preset="${esc(app.id)}"${pi===0?' data-autofocus':''} style="display:flex;align-items:center;gap:13px;border:1px solid var(--edge2);border-radius:0;padding:13px 15px;cursor:pointer;transition:.14s;background:none;text-align:left;font-family:inherit">
          <span style="width:36px;height:36px;flex-shrink:0;border-radius:0;background:var(--surface2);border:1px solid var(--edge2);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:16px;color:${app.accent}">${esc(app.glyph)}</span>
          <div style="flex:1"><div style="font-family:var(--grot);font-weight:600;font-size:14px;color:var(--starlight)">${esc(app.name)}</div><div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:2px">${esc(app.detail)}</div></div>
          <span style="font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--synapse-ink)">prefill →</span>
        </button>`).join('');
    const inputStyle = 'width:100%;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:9px 11px;font-family:var(--mono);font-size:12.5px;color:var(--starlight);box-sizing:border-box';
    const err = state.ag_linkErr ? `<div role="alert" style="font-family:var(--mono);font-size:11px;color:var(--danger);margin-top:10px">${esc(state.ag_linkErr)}</div>` : '';
    inner = `
      <div style="padding:22px">
        <div style="font-family:var(--pixel);font-weight:600;font-size:19px;margin-bottom:6px">which AI are we connecting?</div>
        <div style="font-size:13px;color:var(--dust);margin-bottom:18px">pick one to prefill, or name any AI. Callosium hands it a scoped connection you paste into its settings — no keys leave this device.</div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">${presets}</div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <input id="agLinkName" placeholder="display name — e.g. Gemini" aria-label="display name" value="${esc(state.ag_linkName||'')}" style="${inputStyle}">
          <input id="agLinkId" placeholder="short id — e.g. gemini" aria-label="short id" value="${esc(state.ag_linkId||'')}" style="${inputStyle}">
        </div>
        ${err}
        <button data-ag-act="pair" style="width:100%;margin-top:16px;font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:12px;border-radius:0;cursor:pointer">connect</button>
        <div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:14px;text-align:center">every link stays on this device · nothing is sent anywhere</div>
      </div>`;
  } else if(step === 1){
    const gl = state.ag_linkGlyph || '+', acc = state.ag_linkAccent || 'var(--synapse)';
    inner = `
      <div style="padding:44px 22px;text-align:center;display:flex;flex-direction:column;align-items:center">
        <div style="position:relative;width:64px;height:64px;margin-bottom:22px">
          <span style="position:absolute;inset:0;border:2px solid var(--edge);border-top-color:var(--synapse);border-radius:50%;animation:orbit .8s linear infinite"></span>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:22px;color:${acc}">${esc(gl)}</span>
        </div>
        <div style="font-family:var(--pixel);font-weight:600;font-size:19px;margin-bottom:7px">saying hello to ${esc(state.ag_linkName||'your AI')}…</div>
        <div style="font-size:13px;color:var(--dust);max-width:40ch">giving it a safe, scoped handshake. you'll choose what it can reach in a moment.</div>
      </div>`;
  } else {
    const spec = ag_serverSpec();
    const rotated = !!state.ag_rotated;
    const headline = rotated ? `${esc(state.ag_linkName||'your AI')} has a new token.` : `${esc(state.ag_linkName||'your AI')} is connected.`;
    const subline = rotated ? 'the old one no longer works — re-paste this new connection into it below:' : 'now set it up so it uses your brain automatically — pick it below:';
    inner = `
      <div style="padding:22px 22px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <span style="width:40px;height:40px;flex-shrink:0;border-radius:0;background:rgba(82,242,184,.1);border:1px solid var(--acid);display:flex;align-items:center;justify-content:center;color:var(--acid);font-size:18px">${rotated?'↻':'✓'}</span>
          <div><div style="font-family:var(--pixel);font-weight:600;font-size:19px">${headline}</div><div style="font-size:12.5px;color:var(--dust);margin-top:2px">${subline}</div></div>
        </div>
        ${callosiumGuideHTML(spec)}
        <div style="display:flex;gap:10px;margin-top:6px">
          <button data-ag-act="finishLink" data-autofocus style="flex:1;font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:12px;border-radius:0;cursor:pointer">${rotated?'done':'done — set its folders'}</button>
        </div>
      </div>`;
  }

  return `
    <div data-ag-act="closeLink" style="position:fixed;inset:0;z-index:60;background:rgba(4,3,8,.68);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;animation:rise .2s ease both">
      <div data-ag-stop="1" role="dialog" aria-modal="true" aria-label="link an AI" tabindex="-1" style="width:${(state.ag_linkStep||0)>1?'640px':'520px'};max-width:100%;max-height:88vh;overflow:auto;background:var(--surface);border:1px solid var(--edge2);border-radius:0;box-shadow:0 40px 90px -30px rgba(0,0,0,.9);outline:none">
        <div style="display:flex;align-items:center;padding:13px 18px;border-bottom:1px solid var(--edge);background:var(--surface2)">
          <span style="font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)">link an AI</span>
          <button data-ag-act="closeLink" aria-label="close" style="margin-left:auto;font-family:var(--mono);font-size:14px;color:var(--faint);background:transparent;border:0;cursor:pointer">✕</button>
        </div>
        ${inner}
      </div>
    </div>`;
}

// ── unlink confirm dialog ──
function agentsUnlinkModal(agents){
  if(!state.ag_unlinkOpen) return '';
  const a = agents.find(x => x.id === state.ag_selected);
  const name = a ? (a.displayName || a.id) : 'this AI';
  return `
    <div data-ag-act="closeUnlink" style="position:fixed;inset:0;z-index:61;background:rgba(4,3,8,.68);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px;animation:rise .2s ease both">
      <div data-ag-stop="1" role="dialog" aria-modal="true" aria-label="unlink ${esc(name)}?" tabindex="-1" style="width:420px;max-width:100%;background:var(--surface);border:1px solid var(--edge2);border-radius:0;padding:24px;box-shadow:0 40px 90px -30px rgba(0,0,0,.9);outline:none">
        <div style="font-family:var(--pixel);font-weight:600;font-size:19px;margin-bottom:9px">unlink ${esc(name)}?</div>
        <p style="font-size:13px;color:var(--dust);margin-bottom:20px;line-height:1.55">it loses its memory of your brain immediately. your notes don't change — only this AI's access ends. you can reconnect anytime.</p>
        ${state.ag_unlinkErr ? `<div role="alert" style="font-family:var(--mono);font-size:12px;color:var(--danger);background:rgba(255,60,80,.08);border:1px solid var(--danger);border-radius:0;padding:9px 12px;margin-bottom:16px">${esc(state.ag_unlinkErr)}</div>` : ''}
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button data-ag-act="closeUnlink" data-autofocus style="font-family:var(--pixel);font-weight:500;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:10px 16px;border-radius:0;cursor:pointer">keep it</button>
          <button data-ag-act="confirmUnlink" style="font-family:var(--pixel);font-weight:500;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--danger);color:var(--danger);background:transparent;padding:10px 16px;border-radius:0;cursor:pointer">unlink</button>
        </div>
      </div>
    </div>`;
}

// ── wire all interactions after innerHTML ──
function agentsWire(){
  const scr = $('#screen');

  // title scramble replay
  const title = document.getElementById('agTitle');
  if(title) title.onclick = agentsScramble;

  // agent selection
  scr.querySelectorAll('[data-ag-select]').forEach(el => {
    el.onclick = () => { state.ag_selected = el.dataset.agSelect; agentsPaint(); };
    const sel = el.dataset.agSelected === '1';
    el.addEventListener('mouseenter', () => { if(el.dataset.agSelected !== '1') el.style.borderColor = 'var(--faint)'; });
    el.addEventListener('mouseleave', () => { el.style.borderColor = sel ? 'var(--synapse)' : 'transparent'; });
  });

  // scope segments → apply live
  scr.querySelectorAll('[data-ag-scope]').forEach(el => {
    el.onclick = () => ag_apply(state.ag_selected, el.dataset.agScope, el.dataset.agPerm);
  });

  // preset prefill in link modal
  scr.querySelectorAll('[data-ag-preset]').forEach(el => {
    el.onclick = () => {
      const p = AG_PRESETS.find(x => x.id === el.dataset.agPreset);
      if(!p) return;
      if(p.id === 'other'){ state.ag_linkName = ''; state.ag_linkId = ''; }
      else { state.ag_linkName = p.name; state.ag_linkId = p.id; }
      agentsPaint();
      const nm = document.getElementById(p.id === 'other' ? 'agLinkName' : 'agLinkId'); if(nm) nm.focus();
    };
    el.addEventListener('mouseenter', () => { el.style.borderColor = 'var(--synapse)'; el.style.background = 'rgba(255,46,136,.04)'; });
    el.addEventListener('mouseleave', () => { el.style.borderColor = 'var(--edge2)'; el.style.background = 'transparent'; });
  });

  // keep modal input values in state as the user types (survive repaints)
  const nameEl = document.getElementById('agLinkName');
  const idEl = document.getElementById('agLinkId');
  if(nameEl) nameEl.oninput = e => { state.ag_linkName = e.target.value; };
  if(idEl)   idEl.oninput   = e => { state.ag_linkId = e.target.value; };

  // per-AI setup guide inside the "connected" step (client picker + config/rules copy)
  if(scr.querySelector('[data-guide-client]') && window.callosiumGuideWire) callosiumGuideWire(scr, ag_serverSpec(), agentsPaint);

  // action buttons + overlay backdrops
  scr.querySelectorAll('[data-ag-act]').forEach(el => {
    const act = el.dataset.agAct;
    el.onclick = () => {
      // backdrop overlays carry the same close action; inner boxes stopPropagation
      if(act === 'retry'){ renderAgents(); return; }
      if(act === 'openLink'){ ag_openLink(); return; }
      if(act === 'closeLink'){ ag_closeLink(); return; }
      if(act === 'pair'){ ag_pair(); return; }
      if(act === 'copyConfig'){ ag_copyConfig(el); return; }
      if(act === 'finishLink'){ ag_finishLink(); return; }
      if(act === 'rotate'){ ag_rotate(); return; }
      if(act === 'openUnlink'){ state.ag_unlinkOpen = true; state.ag_unlinkErr = null; agentsPaint(); return; }
      if(act === 'closeUnlink'){ ag_closeUnlink(); return; }
      if(act === 'confirmUnlink'){ ag_confirmUnlink(); return; }
      if(act === 'rename'){ state.ag_renaming = state.ag_selected; state.ag_renameErr = null; agentsPaint(); setTimeout(() => { const i = document.querySelector('#agRename'); if(i){ i.focus(); i.select(); } }, 0); return; }
      if(act === 'renameCancel'){ state.ag_renaming = null; state.ag_renameErr = null; agentsPaint(); return; }
      if(act === 'renameSave'){ ag_renameSave(); return; }
    };
  });
  // stop clicks inside modal boxes from bubbling to the backdrop
  scr.querySelectorAll('[data-ag-stop]').forEach(el => el.addEventListener('click', e => e.stopPropagation()));
  // rename input: Enter saves, Escape cancels
  const agRen = scr.querySelector('#agRename');
  if(agRen){ agRen.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); ag_renameSave(); } else if(e.key === 'Escape'){ state.ag_renaming = null; agentsPaint(); } }); }

  // a11y: the link/unlink overlays are real dialogs: focus moved in on open,
  // Tab trapped inside, Escape closes, focus returns to the opener on close.
  // Every repaint re-binds (the panel node is recreated); a11yModalOpen detaches
  // the stale binding first and never steals focus from inside the panel.
  const linkPanel = scr.querySelector('[role="dialog"][aria-label="link an AI"]');
  if(linkPanel) a11yModalOpen(linkPanel, { invokerSel:'[data-ag-act="'+(state.ag_modalFrom||'openLink')+'"]', onClose:ag_closeLink });
  const unlinkPanel = scr.querySelector('[role="dialog"][aria-label^="unlink "]');
  if(unlinkPanel) a11yModalOpen(unlinkPanel, { invokerSel:'[data-ag-act="openUnlink"]', onClose:ag_closeUnlink });
}

// ── actions ──
function ag_openLink(){
  state.ag_linkOpen = true; state.ag_linkStep = 0; state.ag_linkErr = null;
  state.ag_linkName = ''; state.ag_linkId = ''; state.ag_pairConfig = null; state.ag_rotated = false;
  state.ag_modalFrom = 'openLink';
  agentsPaint();
}
function ag_closeLink(){
  // detach the dialog binding BEFORE the repaint drops the panel node, then put
  // focus back on the control that opened it (Escape/backdrop/✕ all land here).
  a11yModalDetach();
  state.ag_linkOpen = false; state.ag_rotated = false;
  agentsPaint();
  const inv = document.querySelector('[data-ag-act="'+(state.ag_modalFrom||'openLink')+'"]'); if(inv) inv.focus();
}
function ag_closeUnlink(){
  a11yModalDetach();
  state.ag_unlinkOpen = false; state.ag_unlinkErr = null;
  agentsPaint();
  const inv = document.querySelector('[data-ag-act="openUnlink"]'); if(inv) inv.focus();
}

async function ag_apply(id, part, perm){
  const ag = (state.ag_data.agents || []).find(a => a.id === id);
  if(!ag) return;
  const prev = ag.scopes || { read:[], denyRead:[], write:[] };
  const next = ag_setPerm(prev, state.ag_data.partitions, part, perm);
  // per-agent request token: if a newer tap lands first, an older response must
  // not clobber the newer (already-applied) scope with stale data.
  state.ag_inflight = state.ag_inflight || {};
  const tok = (state.ag_inflight[id] = (state.ag_inflight[id] || 0) + 1);
  ag.scopes = next; agentsPaint();                    // optimistic — "applies the moment you tap"
  try{
    const res = await post('/api/scope', { id, scopes: next });
    if(tok !== state.ag_inflight[id]) return;         // superseded by a newer tap — ignore
    if(res && res.scopes){ ag.scopes = res.scopes; agentsPaint(); }  // trust persisted truth
  }catch(e){
    if(tok !== state.ag_inflight[id]) return;
    ag.scopes = prev; agentsPaint();                  // revert; never fake success
    announce("couldn't update permissions · reverted");
  }
}

async function ag_renameSave(){
  const inp = document.querySelector('#agRename');
  const id = state.ag_renaming;
  const name = inp ? String(inp.value || '').trim() : '';
  if(!id) return;
  if(!name){ if(inp) inp.focus(); return; }
  state.ag_renameBusy = true; agentsPaint();
  try{
    const res = await post('/api/rename', { id, displayName: name });
    const ag = (state.ag_data.agents || []).find(a => a.id === id);
    if(ag && res && res.agent) ag.displayName = res.agent.displayName;
    state.ag_renaming = null; state.ag_renameErr = null;
  }catch(e){
    state.ag_renameErr = (e && e.message) || 'rename failed';
  }
  state.ag_renameBusy = false; agentsPaint();
}

async function ag_pair(){
  const name = (state.ag_linkName || '').trim();
  let id = (state.ag_linkId || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if(!name){ state.ag_linkErr = 'give it a display name.'; agentsPaint(); return; }
  if(!id){ state.ag_linkErr = 'give it a short id (letters, numbers, dashes).'; agentsPaint(); return; }
  const m = ag_meta({ id, displayName:name });
  state.ag_linkErr = null; state.ag_linkStep = 1; state.ag_linkId = id;
  state.ag_linkGlyph = m.glyph; state.ag_linkAccent = m.accent;
  agentsPaint();
  try{
    const res = await post('/api/pair', { id, displayName: name });
    state.ag_pairConfig = (res && res.config) || null;
    state.ag_linkStep = 2;
    agentsPaint();
    announce(name + ' connected · copy its config');
  }catch(e){
    state.ag_linkStep = 0; state.ag_linkErr = "couldn't connect it — the engine didn't answer.";
    agentsPaint();
    announce(state.ag_linkErr);
  }
}

// Rotate the selected agent's token, then reuse the link modal (step 2) to show
// the fresh connection to re-paste. The old token is already dead server-side.
async function ag_rotate(){
  const id = state.ag_selected; if(!id || state.ag_rotating) return;
  const ag = (state.ag_data.agents || []).find(a => a.id === id);
  const name = ag ? (ag.displayName || ag.id) : id;
  state.ag_rotating = true; agentsPaint();
  try{
    const res = await post('/api/rotate', { id });
    if(res && res.config){
      const m = ag_meta({ id, displayName:name });
      state.ag_pairConfig = res.config;
      state.ag_linkId = id; state.ag_linkName = name;
      state.ag_linkGlyph = m.glyph; state.ag_linkAccent = m.accent;
      state.ag_linkOpen = true; state.ag_linkStep = 2; state.ag_rotated = true; state.ag_linkErr = null;
      state.ag_modalFrom = 'rotate';
      announce('new token ready for ' + name + ' · the old one is dead');
    } else {
      state.ag_rotateErr = (res && res.error) || 'could not rotate the token.';
      announce(state.ag_rotateErr);
    }
  }catch(e){ state.ag_rotateErr = "couldn't rotate — the engine didn't answer."; announce(state.ag_rotateErr); }
  finally{ state.ag_rotating = false; agentsPaint(); }
}

function ag_copyConfig(btn){
  const t = state.ag_pairConfig ? JSON.stringify(state.ag_pairConfig, null, 2) : '';
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(() => {
      if(btn){ const o = btn.textContent; btn.textContent = 'copied ✓'; btn.style.color = 'var(--acid)'; btn.style.borderColor = 'var(--acid)';
        setTimeout(() => { btn.textContent = o; btn.style.color = 'var(--dust)'; btn.style.borderColor = 'var(--edge2)'; }, 1400); }
    }).catch(() => {});
  }
}

async function ag_finishLink(){
  const newId = state.ag_linkId;
  a11yModalDetach();
  state.ag_linkOpen = false;
  await agentsLoad();                                 // re-fetch: the new agent is now real
  if(newId && state.ag_data.agents.find(a => a.id === newId)) state.ag_selected = newId;
  agentsPaint();
}

async function ag_confirmUnlink(){
  const id = state.ag_selected;
  if(!id){ state.ag_unlinkOpen = false; agentsPaint(); return; }
  const ag = (state.ag_data.agents || []).find(a => a.id === id);
  const name = ag ? (ag.displayName || ag.id) : id;
  state.ag_unlinkErr = null;
  try{
    const res = await post('/api/revoke', { id });
    if(res && res.ok !== false){
      a11yModalDetach();
      state.ag_unlinkOpen = false;
      await agentsLoad();                             // truth after revoke
      agentsPaint();
      announce(name + ' unlinked');
      return;
    }
    // explicit server failure — keep the dialog open and tell the truth, never
    // close as if the unlink succeeded.
    state.ag_unlinkErr = (res && res.error) || t("couldn't unlink — try again.", 'تعذّر إلغاء الربط — حاول مجددًا.');
  }catch(e){
    state.ag_unlinkErr = t("couldn't reach the local app to unlink.", 'تعذّر الوصول إلى التطبيق المحلي لإلغاء الربط.');
  }
  announce(state.ag_unlinkErr);
  agentsPaint();  // dialog stays open, showing ag_unlinkErr
}
