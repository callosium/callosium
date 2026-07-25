// ── Notes / file viewer + editor ────────────────────────────────────────────
// Faithful port of the prototype Notes screen, wired to the real engine
// (GET /api/notes, GET /api/note, POST /api/note/save). All state under
// state.notes_*. The tree reflects the REAL nested folder hierarchy; the editor
// is a live formatter (toolbar + shortcuts + live preview) that keeps files as
// plain markdown — never a lossy WYSIWYG round-trip.

// author-chip colour map
const NOTES_AGENT_COLOR = {
  'you':'var(--synapse)', 'claude-desktop':'var(--acid)', 'claude desktop':'var(--acid)',
  'claude-code':'var(--synapse)', 'claude code':'var(--synapse)', 'cursor':'var(--amber)',
  'chatgpt':'var(--ember)', 'gpt':'var(--ember)',
};
function notesAuthorColor(name){
  const k = String(name||'').trim().toLowerCase();
  return NOTES_AGENT_COLOR[k] || 'var(--dust)';
}

// split leading YAML frontmatter off; keep the exact block to re-attach on save.
function notesParseFrontmatter(raw){
  raw = String(raw||'');
  const meta = {}; let body = raw, block = '';
  const m = raw.match(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
  if(m){
    block = m[0]; body = raw.slice(m[0].length);
    const inner = block.replace(/^﻿?---\r?\n/,'').replace(/\r?\n---[ \t]*\r?\n?$/,'');
    inner.split(/\r?\n/).forEach(line=>{
      const mm = line.match(/^([A-Za-z0-9_\-]+)\s*:\s*(.*)$/);
      if(mm){ meta[mm[1].toLowerCase()] = mm[2].trim().replace(/^["']|["']$/g,''); }
    });
  }
  return { meta, body, block };
}

// ── SMALL + SAFE markdown → HTML (esc FIRST, then format the escaped string) ──
function notesInline(s){
  // GENUINELY pull code spans out to placeholder tokens so the later bold/
  // italic/strike passes can't match a stray '*' INSIDE a code span and mis-nest
  // a tag across its boundary. The token can't collide with note text: the input
  // is already HTML-escaped, so a literal "<<CODE0>>" a user typed arrives as
  // "&lt;&lt;CODE0>>" and won't match the restore regex. Restored verbatim last.
  const spans = [];
  s = s.replace(/`([^`]+)`/g, (m,c)=>{ spans.push(c); return '<<CODE'+(spans.length-1)+'>>'; });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--starlight);font-weight:600">$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong style="color:var(--starlight);font-weight:600">$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em style="font-style:italic;color:var(--starlight)">$2</em>');
  s = s.replace(/(^|[^_])_([^_\s][^_]*?)_(?!_)/g, '$1<em style="font-style:italic;color:var(--starlight)">$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<span style="text-decoration:line-through;color:var(--faint)">$1</span>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m,t,u)=>{
    // Allowlist safe schemes only — blocking just javascript: still lets
    // data:text/html / vbscript: through, and notes can carry synced/agent text.
    const safe = (/^(https?:|mailto:)/i.test(u) || u.charAt(0)==='#') ? u : '#';
    return '<a href="'+safe+'" target="_blank" rel="noopener noreferrer" class="nt-link" style="color:var(--synapse);text-decoration:none;border-bottom:1px solid rgba(255,46,136,.35)">'+t+'</a>';
  });
  s = s.replace(/<<CODE(\d+)>>/g, (m,i)=>'<code style="font-family:var(--mono);font-size:.86em;background:var(--surface2);border:1px solid var(--edge2);border-radius:0;padding:1px 5px;color:var(--starlight)">'+(spans[+i]||'')+'</code>');
  return s;
}
function notesRenderMarkdown(body){
  const B = {
    h1:'font-family:var(--pixel);font-weight:700;font-size:25px;line-height:1.15;color:var(--starlight);margin:2px 0 12px',
    h2:'font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--synapse);margin:20px 0 9px',
    h3:'font-family:var(--grot);font-weight:600;font-size:15px;color:var(--starlight);margin:16px 0 7px',
    p:'font-size:14px;line-height:1.75;color:var(--dust);margin-bottom:9px',
    li:'font-size:14px;line-height:1.7;color:var(--dust);margin:0 0 5px 0;display:flex;gap:10px',
    quote:'font-size:14px;line-height:1.7;color:var(--dust);margin:0 0 9px 0;padding:4px 0 4px 14px;border-left:2px solid var(--synapse);opacity:.92',
  };
  const lines = String(body).replace(/^\n+/,'').split(/\r?\n/);
  let out = '', inFence = false, fence = '', inComment = false;
  lines.forEach(ln=>{
    const fm = ln.match(/^```(.*)$/);
    if(fm){ if(inFence){ out += '</pre>'; inFence=false; } else { inFence=true; out += '<pre class="on-console" style="font-family:var(--mono);font-size:12.5px;line-height:1.6;background:var(--console);border:1px solid var(--edge2);border-radius:0;padding:12px 14px;overflow:auto;color:var(--starlight);margin:0 0 10px">'; } return; }
    if(inFence){ out += esc(ln)+'\n'; return; }
    // per-block attribution marker → a subtle "✍ written by X" badge under the block
    const am = ln.match(/<!--\s*✍ written by (.+?) on (\d{4}-\d{2}-\d{2})\s*-->/);
    if(am){ out += '<div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin:-3px 0 11px;display:flex;align-items:center;gap:6px"><span style="color:var(--synapse)">✍</span>'+t('written by','كتبها')+' <span style="color:var(--dust)">'+esc(am[1])+'</span><span style="color:var(--edge)">·</span>'+esc(am[2])+'</div>'; return; }
    // any other HTML comment → hidden (a real markdown renderer hides it too).
    // Strip the comment SPAN, never the whole line: this used to `return` on any
    // line that opened or closed a comment, so "<!-- draft --> ship on Friday"
    // and the prose after a multi-line comment's "-->" vanished from the reader
    // entirely — real note content gone with no hint it was ever there. A line
    // that is nothing BUT a comment still disappears (no stray blank), and an
    // unterminated comment still hides the lines that follow until its close.
    let hadComment = false;
    if(inComment){
      const end = ln.indexOf('-->');
      if(end === -1) return;                       // still wholly inside the comment
      ln = ln.slice(end+3); inComment = false; hadComment = true;
    }
    for(;;){
      const st = ln.indexOf('<!--');
      if(st === -1) break;
      hadComment = true;
      // search from st+2 so the degenerate empty comment "<!-->" closes itself
      // instead of swallowing the rest of the note.
      const en = ln.indexOf('-->', st+2);
      if(en === -1){ ln = ln.slice(0,st); inComment = true; break; }
      ln = ln.slice(0,st) + ln.slice(en+3);
    }
    if(hadComment && !ln.trim()) return;           // the line held nothing but the comment
    if(ln.trim()===''){ out += '<div style="height:8px"></div>'; return; }
    const e = esc(ln);
    if(/^###\s+/.test(ln)){ out += '<div style="'+B.h3+'">'+notesInline(e.replace(/^###\s+/,''))+'</div>'; return; }
    if(/^##\s+/.test(ln)){  out += '<div style="'+B.h2+'">'+notesInline(e.replace(/^##\s+/,''))+'</div>'; return; }
    if(/^#\s+/.test(ln)){   out += '<div style="'+B.h1+'">'+notesInline(e.replace(/^#\s+/,''))+'</div>'; return; }
    if(/^>\s?/.test(ln)){   out += '<div style="'+B.quote+'">'+notesInline(esc(ln.replace(/^>\s?/,'')))+'</div>'; return; }
    if(/^(\s*)[-*+]\s+/.test(ln)){ out += '<div style="'+B.li+'"><span style="color:var(--synapse);flex-shrink:0">—</span><span>'+notesInline(e.replace(/^\s*[-*+]\s+/,''))+'</span></div>'; return; }
    const om = ln.match(/^(\s*)(\d+)\.\s+/);
    if(om){ out += '<div style="'+B.li+'"><span style="color:var(--synapse);flex-shrink:0;font-family:var(--mono);font-size:12px">'+esc(om[2])+'.</span><span>'+notesInline(e.replace(/^\s*\d+\.\s+/,''))+'</span></div>'; return; }
    if(/^(---|\*\*\*|___)\s*$/.test(ln)){ out += '<div style="height:1px;background:var(--edge);margin:14px 0"></div>'; return; }
    out += '<div style="'+B.p+'">'+notesInline(e)+'</div>';
  });
  if(inFence) out += '</pre>';
  return out;
}
function notesWordCount(body){ const t = String(body||'').trim(); return t ? t.split(/\s+/).length : 0; }

// Separates the disk copy from the user's unsaved text when the save-conflict
// banner merges the two (see the reload handler in notesRenderAll). Deliberately
// a visible markdown heading rather than an HTML comment — comments are hidden
// from the live preview, and this line has to be impossible to miss.
const NOTES_MERGE_MARK = '\n\n## ⚠ your unsaved version — merge what you want into the text above, then delete from this line down\n\n';

// ── data ──
async function notesLoadNote(path){
  state.notes_selected = path; state.notes_editing = false;
  state.notes_historyOpen = false; state.notes_history = null; state.notes_histDiffOid = null; state.notes_histDiff = null;
  state.notes_noteError = false; state.notes_content = null;
  notesExpandTo(path);
  let content = null, failed = false, baseHash = null;
  try{ const r = await api('/api/note?path='+encodeURIComponent(path)); content = (r && r.content) || ''; baseHash = (r && r.baseHash) || null; }
  catch(e){ failed = true; }
  // A newer selection may have superseded us while the fetch was in flight —
  // applying our result now would show THIS note's body under THAT note's title.
  if(state.notes_selected !== path) return;
  state.notes_content = failed ? null : content;
  state.notes_baseHash = failed ? null : baseHash;
  state.notes_noteError = failed;
}
async function notesSelectNote(path){
  state.notes_selected = path; state.notes_editing = false; state.notes_saved = false;
  state.notes_historyOpen = false; state.notes_history = null; state.notes_histDiffOid = null; state.notes_histDiff = null; // close version history when switching notes so diff/restore can't act on the wrong note
  state.notes_noteError = false; state.notes_content = null; state.notes_loadingNote = true;
  notesExpandTo(path);
  notesRenderAll();
  let content = null, failed = false, baseHash = null;
  try{ const r = await api('/api/note?path='+encodeURIComponent(path)); content = (r && r.content) || ''; baseHash = (r && r.baseHash) || null; }
  catch(e){ failed = true; }
  if(state.notes_selected !== path) return; // stale — a newer selection owns state now
  state.notes_content = failed ? null : content;
  state.notes_baseHash = failed ? null : baseHash; // compare-and-swap baseline for save
  state.notes_noteError = failed;
  state.notes_loadingNote = false;
  notesRenderAll();
}
async function notesSave(){
  if(state.notes_saving) return;                 // ignore a double-fire
  const path = state.notes_selected;
  const content = (state.notes_draftBlock || '') + (state.notes_draftBody || '');
  state.notes_saving = true;                      // blocks tree/Cancel switching away mid-save
  state.notes_saveConflict = false;
  const btn = $('#notesSaveBtn'); if(btn){ btn.textContent = 'saving…'; btn.style.opacity = '.6'; }
  try{
    // baseHash = what we loaded from disk → the server refuses (409) if the note
    // changed on disk since, so we never silently clobber an external edit.
    const r = await post('/api/note/save', { path, content, baseHash: state.notes_baseHash });
    // Guard: never write this save's result onto a different note's view. The
    // selection can't change mid-save now (notes_saving blocks it), but a late
    // resolve after some other transition must still no-op.
    if(state.notes_selected !== path) return;
    if(r && r.ok){
      state.notes_content = content; state.notes_editing = false; state.notes_saved = true;
      state.notes_editedOverride = { path, edited:'just now' };
      if(state.map_snip){ delete state.map_snip[path]; }  // Brain Map re-fetches this note's preview
      notesRenderAll();
      announce('note saved');
      // refresh baseline (content + hash) so a second save from the same session
      // compares against what's now on disk, not the pre-save version.
      try{ const rr = await api('/api/note?path='+encodeURIComponent(path)); if(state.notes_selected===path && rr && typeof rr.content==='string'){ state.notes_content = rr.content; state.notes_baseHash = rr.baseHash || null; notesRenderAll(); } }catch(e){}
      clearTimeout(state.notes_savedTimer);
      state.notes_savedTimer = setTimeout(()=>{ state.notes_saved=false; if(state.screen==='notes') notesRenderAll(); }, 2600);
    } else if(r && r.conflict){
      // someone edited this note on disk while it was open — keep the draft, warn.
      state.notes_saveConflict = true; notesRenderAll();
      announce('this note changed on disk · your edits are safe');
    } else { state.notes_saveError = true; notesRenderAll(); announce('could not save the note'); }
  }catch(e){
    // post() throws on non-2xx; a 409 conflict arrives here — surface it distinctly.
    if(state.notes_selected===path){
      if(String(e && e.message || e).indexOf('409')!==-1 || /changed on disk/i.test(String(e && e.message || e))){ state.notes_saveConflict = true; announce('this note changed on disk · your edits are safe'); }
      else { state.notes_saveError = true; announce('could not save the note'); }
      notesRenderAll();
    }
  }
  finally{ state.notes_saving = false; }
}
function notesStartEdit(){
  // CRITICAL: never enter edit mode before the body has loaded — editing null
  // then saving would write '' over the real file on disk (permanent data loss).
  if(state.notes_loadingNote || state.notes_content===null) return;
  const p = notesParseFrontmatter(state.notes_content);
  state.notes_editing = true; state.notes_saveError = false; state.notes_saved = false;
  state.notes_draftBlock = p.block; state.notes_draftBody = p.body;
  notesRenderAll();
}
function notesCancelEdit(){ if(state.notes_saving) return; state.notes_editing = false; state.notes_saveError = false; notesRenderAll(); }

// ── nested folder tree (real subfolders) ──
function notesExpandTo(path){
  if(!state.notes_expanded) state.notes_expanded = {};
  const segs = String(path||'').split('/'); segs.pop(); // drop filename
  let acc = '';
  segs.forEach(s=>{ acc = acc ? acc+'/'+s : s; state.notes_expanded[acc] = true; });
}
function notesBuildTree(){
  const items = state.notes_items || [];
  const nq = (state.notes_query||'').trim().toLowerCase();
  const root = { name:'', path:'', folders:new Map(), notes:[], count:0 };
  items.forEach(it=>{
    if(nq && !String(it.path||'').toLowerCase().includes(nq)) return;
    const segs = String(it.path).split('/'); segs.pop();
    let node = root, acc = '';
    node.count++;
    segs.forEach(seg=>{
      acc = acc ? acc+'/'+seg : seg;
      if(!node.folders.has(seg)) node.folders.set(seg, { name:seg, path:acc, folders:new Map(), notes:[], count:0 });
      node = node.folders.get(seg); node.count++;
    });
    node.notes.push(it);
  });
  return root;
}
function notesNodeHTML(node, depth){
  const nq = (state.notes_query||'').trim();
  let html = '';
  // subfolders first (alphabetical), then notes
  const folders = [...node.folders.values()].sort((a,b)=>a.name.localeCompare(b.name));
  folders.forEach(f=>{
    const expanded = nq ? true : !!(state.notes_expanded && state.notes_expanded[f.path]);
    const top = depth===0;
    const pad = 8 + depth*13;
    const nameStyle = top
      ? 'flex:1;font-family:var(--pixel);font-weight:600;font-size:14px;letter-spacing:.05em;text-transform:uppercase;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      : 'flex:1;font-family:var(--mono);font-size:12px;letter-spacing:.02em;color:var(--dust);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    html += '<button type="button" data-folder="'+esc(f.path)+'" class="nt-folder" style="display:flex;align-items:center;gap:7px;padding:7px 8px;padding-left:'+pad+'px;margin-top:'+(top?'6px':'1px')+';border-radius:0;cursor:pointer;width:100%;background:none;border:0;font-family:inherit;text-align:left">'
      + '<span style="color:var(--synapse);width:9px;flex-shrink:0;font-family:var(--mono);font-size:10px">'+(expanded?'▾':'▸')+'</span>'
      + '<span style="'+nameStyle+'">'+esc(f.name)+'</span>'
      + '<span style="color:var(--faint);font-size:9.5px;font-family:var(--mono);flex-shrink:0">'+f.count+'</span></button>';
    if(expanded) html += notesNodeHTML(f, depth+1);
  });
  const notes = [...node.notes].sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  notes.forEach(n=>{
    const sel = n.path === state.notes_selected;
    const title = String(n.name||'').replace(/\.md$/i,'') || 'untitled';
    const pad = 8 + depth*13 + 16;
    const style = 'padding:6px 9px;padding-left:'+pad+'px;border-radius:0;cursor:pointer;font-family:var(--mono);font-size:12px;transition:.1s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
      + 'color:'+(sel?'var(--starlight)':'var(--dust)')+';background:'+(sel?'var(--surface2)':'transparent')+';box-shadow:'+(sel?'inset 2px 0 0 var(--synapse)':'none')
      + ';display:block;width:100%;border:0;text-align:left';
    html += '<button type="button" data-path="'+esc(n.path)+'" class="nt-note" style="'+style+'" title="'+esc(n.path)+'">'+esc(title)+'</button>';
  });
  return html;
}
function notesTreeHTML(){
  const root = notesBuildTree();
  if(!root.count){
    return '<div style="padding:20px 10px;font-family:var(--mono);font-size:11.5px;color:var(--faint);line-height:1.6">'
      + (state.notes_query ? 'no note matches “'+esc(state.notes_query)+'”.' : 'no notes here yet.') + '</div>';
  }
  return notesNodeHTML(root, 0);
}
function notesWireTree(){
  $$('#notesTree [data-folder]').forEach(el=> el.onclick = ()=>{
    const f = el.dataset.folder;
    if(!state.notes_expanded) state.notes_expanded = {};
    state.notes_expanded[f] = !state.notes_expanded[f];
    notesRenderTree();
  });
  $$('#notesTree [data-path]').forEach(el=> el.onclick = ()=>{
    // never switch away while a save is still writing to disk — the in-flight
    // save owns state.notes_content until it resolves (prevents the cross-note
    // clobber where A's save lands after B is selected).
    if(state.notes_saving) return;
    // don't silently discard an in-progress edit when the user clicks another note
    if(state.notes_editing && !confirm(t('Discard your unsaved changes to this note?','هل تريد تجاهل تغييراتك غير المحفوظة؟'))) return;
    notesSelectNote(el.dataset.path);
  });
}
function notesRenderTree(){ const wrap = $('#notesTree'); if(!wrap) return; wrap.innerHTML = notesTreeHTML(); notesWireTree(); }

// ── editor: toolbar formatting over the markdown source + live preview ──
function notesUpdatePreview(){
  const pv = $('#notesPreview'); if(pv) pv.innerHTML = notesRenderMarkdown(state.notes_draftBody || '');
}
function notesFmt(kind){
  const ta = $('#notesTextarea'); if(!ta) return;
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, sel = v.slice(s,e);
  let next = v, caret = e;
  const wrap = (pre, post) => {
    if(sel){ next = v.slice(0,s)+pre+sel+post+v.slice(e); caret = e + pre.length + post.length; }
    else { const ph = ''; next = v.slice(0,s)+pre+ph+post+v.slice(e); caret = s + pre.length; }
  };
  const linePfx = (pfx) => {
    const ls = v.lastIndexOf('\n', s-1) + 1;
    const seg = v.slice(ls, e || s);
    const rep = seg.length ? seg.replace(/^/gm, pfx) : pfx;
    next = v.slice(0, ls) + rep + v.slice(e || s);
    caret = (e||s) + (rep.length - seg.length);
  };
  switch(kind){
    case 'bold':   wrap('**','**'); break;
    case 'italic': wrap('*','*'); break;
    case 'code':   wrap('`','`'); break;
    case 'strike': wrap('~~','~~'); break;
    case 'h1': linePfx('# '); break;
    case 'h2': linePfx('## '); break;
    case 'h3': linePfx('### '); break;
    case 'ul': linePfx('- '); break;
    case 'ol': linePfx('1. '); break;
    case 'quote': linePfx('> '); break;
    case 'link': { const label = sel || 'text'; const ins = '['+label+'](url)'; next = v.slice(0,s)+ins+v.slice(e); caret = s + label.length + 3; break; }
  }
  ta.value = next; state.notes_draftBody = next;
  ta.focus(); try{ ta.setSelectionRange(caret, caret); }catch(_){}
  notesUpdatePreview();
}
const NOTES_TOOLBAR = [
  ['bold','B','bold  (⌘B)','font-weight:700'], ['italic','I','italic  (⌘I)','font-style:italic'],
  ['strike','S','strikethrough','text-decoration:line-through'], ['code','&lt;&gt;','inline code',''],
  ['SEP'],
  ['h1','H1','heading 1',''], ['h2','H2','heading 2',''], ['h3','H3','heading 3',''],
  ['SEP'],
  ['ul','•','bullet list',''], ['ol','1.','numbered list',''], ['quote','❝','quote',''], ['link','🔗','link',''],
];
function notesToolbarHTML(){
  const btn = (kind,label,title,extra)=> '<button data-fmt="'+kind+'" class="nt-tb" title="'+esc(title)+'" style="min-width:30px;height:30px;padding:0 8px;font-family:var(--mono);font-size:12px;color:var(--dust);background:transparent;border:1px solid var(--edge2);border-radius:0;cursor:pointer;transition:.1s;'+extra+'">'+label+'</button>';
  const sep = '<span style="width:1px;height:18px;background:var(--edge);margin:0 2px"></span>';
  return '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:10px 22px;border-bottom:1px solid var(--edge);background:var(--surface2)">'
    + NOTES_TOOLBAR.map(t=> t[0]==='SEP' ? sep : btn(t[0],t[1],t[2],t[3])).join('')
    + '<span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--faint)">markdown · live preview →</span>'
    + '</div>';
}

// ── viewer / editor panel ──
function notesViewerHTML(){
  const sel = state.notes_selected;
  const item = (state.notes_items||[]).find(i=>i.path===sel);
  if(!sel || !item){
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center">'
      + '<div style="width:44px;height:44px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:18px;background:var(--surface2);--icon:var(--synapse)">'+px('notes',18)+'</div>'
      + '<h2 style="font-family:var(--pixel);font-weight:600;font-size:20px;margin-bottom:8px">pick a note.</h2>'
      + '<p style="color:var(--dust);font-size:13.5px;max-width:40ch;font-family:var(--sans)">choose one from the tree to read or edit it — everything stays on this device.</p></div>';
  }

  const displayName = String(item.name||'').replace(/\.md$/i,'') || 'untitled';
  const editing = !!state.notes_editing;
  const parsed = notesParseFrontmatter(editing ? (state.notes_draftBlock+state.notes_draftBody) : state.notes_content);
  const editedOv = state.notes_editedOverride && state.notes_editedOverride.path===sel ? state.notes_editedOverride.edited : null;
  const createdBy = String(parsed.meta.created_by||'').trim();
  const updatedBy = String(parsed.meta.updated_by||'').trim();
  const author = (updatedBy || createdBy || (editedOv ? 'you' : '')).trim();
  const words = notesWordCount(editing ? state.notes_draftBody : parsed.body);
  const edited = editedOv || item.ago || 'recently';
  const sepr = '<span style="color:var(--edge)">|</span>';
  const authChip = (name)=>'<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:'+notesAuthorColor(name)+'"></span><span style="font-family:var(--mono);white-space:nowrap;color:'+notesAuthorColor(name)+'">'+esc(name)+'</span></span>';
  let meta = '<span>'+esc((item.partition?item.partition+'  /  ':'')+displayName+'.md')+'</span>'+sepr+'<span>edited '+esc(edited)+' · '+words+' words</span>';
  if(author){
    // created→last-edited when they differ (who started it, who last touched it);
    // per-BLOCK "✍ written by" badges live inside the body from append markers.
    meta += sepr + (createdBy && updatedBy && createdBy!==updatedBy
      ? '<span style="display:inline-flex;align-items:center;gap:6px;color:var(--faint)">✍ '+authChip(createdBy)+'<span style="color:var(--edge)">→</span>'+authChip(updatedBy)+'</span>'
      : authChip(author));
  }
  if(state.notes_saved) meta += sepr+'<span style="font-family:var(--mono);color:var(--acid)">saved ✓</span>';

  let actions;
  if(editing){
    actions = '<button id="notesSaveBtn" class="nt-btn-save" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:8px 15px;border-radius:0;cursor:pointer">save</button>'
      + '<button id="notesCancelBtn" class="nt-btn-cancel" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--faint);background:transparent;padding:8px 12px;border-radius:0;cursor:pointer">cancel</button>';
  } else if(state.notes_loadingNote || state.notes_content===null){
    actions = ''; // don't offer Edit until the note body has actually loaded
  } else {
    actions = '<button id="notesHistBtn" class="nt-btn-edit" title="'+t('version history','سجل النسخ')+'" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:8px 12px;border-radius:0;cursor:pointer">⟲ '+t('history','السجل')+'</button>'
      + '<button id="notesEditBtn" class="nt-btn-edit" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:8px 13px;border-radius:0;cursor:pointer">'+t('edit','تحرير')+'</button>';
  }

  const header = '<div style="padding:15px 22px;border-bottom:1px solid var(--edge);display:flex;align-items:flex-start;gap:14px;flex-shrink:0">'
    + '<div style="flex:1;min-width:0"><div style="font-family:var(--pixel);font-weight:700;font-size:19px;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc(displayName)+'</div>'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:5px;font-family:var(--mono);font-size:10.5px;color:var(--faint)">'+meta+'</div></div>'
    + '<div style="display:flex;gap:8px;flex-shrink:0">'+actions+'</div></div>';

  let body;
  if(editing){
    body = notesToolbarHTML()
      + '<div class="notes-edit-grid" style="flex:1;display:grid;grid-template-columns:1fr 1fr;min-height:0;overflow:hidden">'
      + '<textarea id="notesTextarea" class="nt-ta" spellcheck="false" aria-label="note editor (markdown)" style="height:100%;width:100%;background:var(--void);border:0;border-right:1px solid var(--edge);padding:18px 20px;font-family:var(--mono);font-size:13px;line-height:1.75;color:var(--starlight);resize:none">'+esc(state.notes_draftBody||'')+'</textarea>'
      + '<div id="notesPreview" style="height:100%;overflow:auto;padding:18px 22px 40px;background:var(--surface)"><div style="max-width:640px">'+notesRenderMarkdown(state.notes_draftBody||'')+'</div></div>'
      + '</div>'
      + (state.notes_saveConflict
          // Label says exactly what the button does now. The old copy ("reload the
          // disk version to merge") described a merge it never performed — it
          // replaced the draft with the disk copy, so the promise on the same line
          // that "your edits are safe here" was false the moment you clicked.
          ? '<div style="flex-shrink:0;font-family:var(--mono);font-size:11px;color:var(--amber);padding:9px 22px;border-top:1px solid var(--edge);line-height:1.5">this note changed on disk while you had it open — your edits are safe here. <button type="button" data-notes-reload style="color:var(--synapse);cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font:inherit">bring the disk version in</button> — it goes above your unsaved text so you can merge the two by hand. nothing is thrown away.</div>'
          : state.notes_saveError
          ? '<div style="flex-shrink:0;font-family:var(--mono);font-size:11px;color:var(--danger);padding:9px 22px;border-top:1px solid var(--edge)">could not save to disk — nothing was changed. try again.</div>'
          : '<div style="flex-shrink:0;font-family:var(--mono);font-size:10.5px;color:var(--faint);padding:9px 22px;border-top:1px solid var(--edge)">plain markdown, saved to your disk, signed as you · <span style="color:var(--dust)">⌘B bold · ⌘I italic</span></div>');
  } else if(state.notes_loadingNote || (state.notes_content===null && !state.notes_noteError)){
    body = '<div style="flex:1;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;color:var(--faint)"><span style="color:var(--synapse)">›</span>&nbsp;opening…</div>';
  } else if(state.notes_noteError){
    body = '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center">'
      + '<div style="width:40px;height:40px;border:1px solid var(--danger);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:14px;color:var(--danger);font-size:16px">!</div>'
      + '<p style="color:var(--dust);font-size:13.5px;font-family:var(--sans);max-width:40ch">couldn’t read this note right now. it stays safe on your disk — try selecting it again.</p></div>';
  } else {
    body = '<div id="notesScroll" style="flex:1;overflow:auto;padding:24px 30px 44px"><div style="max-width:720px">'+notesRenderMarkdown(parsed.body)+'</div></div>';
  }
  return header + body + notesHistoryOverlayHTML();
}

// ── version history overlay (M1 external-write safety net) ──
function notesHistoryOverlayHTML(){
  if(!state.notes_historyOpen) return '';
  const vs = state.notes_history;
  let inner;
  if(vs === null){ inner = '<div style="padding:30px;text-align:center;color:var(--faint);font-family:var(--mono);font-size:12px">'+t('loading history…','جارٍ التحميل…')+'</div>'; }
  else if(!vs.length){ inner = '<div style="padding:30px;text-align:center;color:var(--faint);font-family:var(--mono);font-size:12px">'+t('no earlier versions yet — changes are captured from here on.','لا توجد نسخ سابقة بعد.')+'</div>'; }
  else {
    inner = vs.map((v,i)=>{
      let when = ''; try{ when = new Date(v.ts).toLocaleString(); }catch(e){ when = ''; }
      const open = state.notes_histDiffOid === v.oid;
      const cur = i===0 ? ' <span style="color:var(--acid);font-family:var(--mono);font-size:9.5px">CURRENT</span>' : '';
      return '<div style="border:1px solid var(--edge2);border-radius:0;margin-bottom:8px">'
        + '<div style="display:flex;align-items:center;gap:10px;padding:10px 13px">'
        + '<div style="flex:1;min-width:0"><div style="font-family:var(--mono);font-size:12px;color:var(--starlight)">'+esc(v.source)+cur+'</div>'
        + '<div style="font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:2px">'+esc(when)+'</div></div>'
        + '<button data-hist-diff="'+esc(v.oid)+'" class="nt-tb" style="font-family:var(--mono);font-size:10px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:6px 10px;cursor:pointer">'+(open?t('hide','إخفاء'):t('diff','فرق'))+'</button>'
        + (i===0 ? '' : '<button data-hist-restore="'+esc(v.oid)+'" class="nt-btn-edit" style="font-family:var(--mono);font-size:10px;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse);background:transparent;padding:6px 10px;cursor:pointer">'+t('restore','استعادة')+'</button>')
        + '</div>'
        + (open ? '<div style="border-top:1px solid var(--edge);max-height:320px;overflow:auto;padding:10px 13px;font-family:var(--mono);font-size:11.5px;line-height:1.6">'+notesDiffHTML(state.notes_histDiff)+'</div>' : '')
        + '</div>';
    }).join('');
  }
  return '<div id="notesHistOverlay" style="position:absolute;inset:0;background:var(--void);display:flex;flex-direction:column;z-index:20">'
    + '<div style="display:flex;align-items:center;gap:12px;padding:15px 22px;border-bottom:1px solid var(--edge)">'
    + '<div style="flex:1;font-family:var(--pixel);font-size:14px;color:var(--starlight)">'+t('version history','سجل النسخ')+'</div>'
    + '<button id="notesHistClose" class="nt-btn-cancel" style="font-family:var(--mono);font-size:11px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--faint);background:transparent;padding:8px 12px;cursor:pointer">'+t('close','إغلاق')+'</button></div>'
    + '<div style="flex:1;overflow:auto;padding:16px 22px">'+inner+'</div></div>';
}
function notesDiffHTML(diff){
  if(diff === null) return '<span style="color:var(--faint)">'+t('loading…','…')+'</span>';
  if(!diff || !diff.length) return '<span style="color:var(--faint)">'+t('no line changes','لا تغييرات')+'</span>';
  return diff.slice(0, 400).map(d=>{
    const c = d.t==='+' ? 'var(--acid)' : d.t==='-' ? 'var(--danger)' : 'var(--faint)';
    const bg = d.t==='+' ? 'rgba(82,242,184,.08)' : d.t==='-' ? 'rgba(255,51,85,.08)' : 'transparent';
    return '<div style="color:'+c+';background:'+bg+';white-space:pre-wrap;word-break:break-word">'+esc((d.t==='+'?'+ ':d.t==='-'?'- ':'  ')+d.text)+'</div>';
  }).join('') + (diff.length>400 ? '<div style="color:var(--faint);margin-top:6px">…('+(diff.length-400)+' more lines)</div>' : '');
}
async function notesOpenHistory(){
  const p = state.notes_selected; if(!p) return;
  state.notes_historyOpen = true; state.notes_history = null; state.notes_histDiffOid = null; state.notes_histDiff = null;
  notesRenderAll();
  let versions = [];
  try{ const r = await api('/api/history?path='+encodeURIComponent(p)); versions = (r && r.versions) || []; }catch(e){ versions = []; }
  if(state.notes_historyOpen && state.notes_selected === p){ state.notes_history = versions; notesRenderAll(); }
}
function notesCloseHistory(){ state.notes_historyOpen = false; state.notes_histDiffOid = null; state.notes_histDiff = null; notesRenderAll(); }
async function notesHistDiff(oid){
  if(state.notes_histDiffOid === oid){ state.notes_histDiffOid = null; state.notes_histDiff = null; notesRenderAll(); return; }
  const p = state.notes_selected; if(!p) return;
  state.notes_histDiffOid = oid; state.notes_histDiff = null; notesRenderAll();
  let diff = [];
  try{ const r = await api('/api/history/diff?path='+encodeURIComponent(p)+'&oid='+encodeURIComponent(oid)); diff = (r && r.diff) || []; }catch(e){ diff = []; }
  if(state.notes_histDiffOid === oid && state.notes_selected === p){ state.notes_histDiff = diff; notesRenderAll(); }
}
async function notesRestore(oid){
  const p = state.notes_selected; if(!p) return;
  if(!confirm(t('Restore this version? Your current version is saved to history first, so this is undoable.','استعادة هذه النسخة؟ سيتم حفظ النسخة الحالية أولًا.'))) return;
  try{
    const r = await post('/api/history/restore', { path: p, oid });
    if(r && r.ok){
      state.notes_historyOpen = false;
      try{ const rr = await api('/api/note?path='+encodeURIComponent(p)); if(state.notes_selected===p && rr && typeof rr.content==='string'){ state.notes_content = rr.content; state.notes_baseHash = rr.baseHash || null; } }catch(e){}
      notesRenderAll();
    } else { alert((r && r.error) || t('restore failed','فشلت الاستعادة')); }
  }catch(e){ alert(t('restore failed','فشلت الاستعادة')); }
}

// ── full render + wiring ──
function notesRenderAll(){
  // A late-resolving fetch/save must not repaint the Notes UI over whatever
  // screen the user has since navigated to — guard centrally so every caller
  // (save success, select completion, saved-timer) is covered uniformly.
  if(state.screen!=='notes') return;
  const scr = $('#screen'); if(!scr) return;
  const styleBlock = '<style>'
    + '.nt-input:focus,.nt-ta:focus{border-color:var(--synapse)!important;outline:none}'
    + '.nt-folder:hover{background:var(--surface2)}'
    + '.nt-note:hover{color:var(--starlight)!important;background:var(--surface2)!important}'
    + '.nt-btn-edit:hover{border-color:var(--synapse)!important;color:var(--synapse)!important}'
    + '.nt-btn-save:hover{background:var(--synapse)!important;color:var(--on-accent)!important}'
    + '.nt-btn-cancel:hover{color:var(--starlight)!important;border-color:var(--dust)!important}'
    + '.nt-tb:hover{border-color:var(--synapse)!important;color:var(--synapse)!important}'
    + '.nt-link:hover{color:var(--starlight)!important}'
    + '</style>';
  const left = '<div class="notes-tree-panel" style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);display:flex;flex-direction:column;overflow:hidden">'
    + '<div style="padding:12px 12px 11px;border-bottom:1px solid var(--edge)">'
    + '<input id="notesQuery" class="nt-input" value="'+esc(state.notes_query||'')+'" placeholder="find a note…" aria-label="find a note" style="width:100%;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:8px 11px;font-family:var(--mono);font-size:12px;color:var(--starlight)"></div>'
    + '<div id="notesTree" style="flex:1;overflow:auto;padding:8px">'+notesTreeHTML()+'</div></div>';
  const right = '<div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);display:flex;flex-direction:column;overflow:hidden;min-width:0;position:relative">'+notesViewerHTML()+'</div>';
  scr.innerHTML = styleBlock
    + '<div class="notes-layout" style="display:grid;grid-template-columns:264px 1fr;gap:16px;height:100%;min-height:520px;animation:rise .4s ease both">'+left+right+'</div>';

  const q = $('#notesQuery'); if(q){ q.oninput = e => { state.notes_query = e.target.value; notesRenderTree(); }; }
  notesWireTree();
  const editBtn = $('#notesEditBtn'); if(editBtn) editBtn.onclick = notesStartEdit;
  const saveBtn = $('#notesSaveBtn'); if(saveBtn) saveBtn.onclick = notesSave;
  const cancelBtn = $('#notesCancelBtn'); if(cancelBtn) cancelBtn.onclick = notesCancelEdit;
  const histBtn = $('#notesHistBtn'); if(histBtn) histBtn.onclick = notesOpenHistory;
  const histClose = $('#notesHistClose'); if(histClose) histClose.onclick = notesCloseHistory;
  $$('#notesHistOverlay [data-hist-diff]').forEach(el=> el.onclick = ()=> notesHistDiff(el.dataset.histDiff));
  $$('#notesHistOverlay [data-hist-restore]').forEach(el=> el.onclick = ()=> notesRestore(el.dataset.histRestore));
  // conflict banner → pull the disk version into the editor (new baseHash), so the
  // user can re-apply their change on top of what actually landed on disk.
  // This used to assign the disk copy straight over state.notes_draftBody: the
  // banner said "your edits are safe here" and the very next click deleted them,
  // with no undo and no history entry (the draft was never on disk to restore).
  // It now does what the label promises — builds a merge buffer with the disk
  // version on top and the unsaved text kept below a visible marker, so the user
  // reconciles them by hand and nothing is destroyed. Fixed at this control
  // because it is the only place a draft is discarded without being asked.
  const reload = $('#screen [data-notes-reload]'); if(reload) reload.onclick = async ()=>{
    const path = state.notes_selected; if(!path) return;
    const draft = state.notes_draftBody || '';
    try{
      const rr = await api('/api/note?path='+encodeURIComponent(path));
      if(state.notes_selected===path && rr && typeof rr.content==='string'){
        state.notes_content = rr.content; state.notes_baseHash = rr.baseHash || null;
        const p = notesParseFrontmatter(rr.content);
        // an empty draft, or one that already matches disk, needs no merge markers
        const needsMerge = !!draft.trim() && draft.trim() !== p.body.trim();
        state.notes_draftBlock = p.block;
        state.notes_draftBody = needsMerge
          ? p.body.replace(/\s+$/,'') + NOTES_MERGE_MARK + draft.replace(/^\s+/,'')
          : p.body;
        state.notes_saveConflict = false; notesRenderAll();
        announce(needsMerge ? 'disk version added above your unsaved text' : 'disk version loaded');
      }
    }catch(e){}
  };
  $$('#screen [data-fmt]').forEach(el=> el.onclick = ()=> notesFmt(el.dataset.fmt));
  const ta = $('#notesTextarea');
  if(ta){
    ta.oninput = e => { state.notes_draftBody = e.target.value; notesUpdatePreview(); };
    ta.onkeydown = e => {
      if((e.metaKey||e.ctrlKey) && !e.shiftKey && !e.altKey){
        const k = e.key.toLowerCase();
        if(k==='b'){ e.preventDefault(); notesFmt('bold'); }
        else if(k==='i'){ e.preventDefault(); notesFmt('italic'); }
        else if(k==='s'){ e.preventDefault(); notesSave(); }
      }
    };
    ta.focus(); try{ const n = ta.value.length; ta.setSelectionRange(n,n); }catch(e){}
  }
  // deep-linked from Overview's recent activity → briefly flash the note pane
  if(state.notes_flash && state.notes_flash===state.notes_selected){
    const pane = document.getElementById('notesScroll');
    if(pane){ pane.classList.add('note-flash'); setTimeout(()=>{ try{ pane.classList.remove('note-flash'); }catch(_){} }, 1700); state.notes_flash=null; }
  }
}

// ── entry point ──
async function renderNotes(){
  const scr = $('#screen');
  if(state.notes_expanded === undefined) state.notes_expanded = {};
  if(state.notes_query === undefined) state.notes_query = '';
  if(state.notes_items === undefined){
    scr.innerHTML = '<div style="font-family:var(--mono);color:var(--faint);padding:20px">reading your notes…</div>';
    try{ const r = await api('/api/notes?limit=5000'); state.notes_items = (r && r.items) || []; state.notes_total = (r && r.total) || state.notes_items.length; }
    catch(e){ state.notes_items = []; state.notes_listError = true; }
    if(!state.notes_selected && state.notes_items.length) await notesLoadNote(state.notes_items[0].path);
  }
  // deep-link: another screen (Brain Map / Ask source chip) asked to open a note
  if(state.notes_open){
    const target = state.notes_open; state.notes_open = null;
    // Open the requested note directly — don't require it to be in the loaded list
    // (a deep-linked note can be beyond the 5000-item cap); notesLoadNote fetches
    // it by path and surfaces its own error if it truly can't be read.
    //
    // But ask first, exactly as a tree click does. Leaving Notes mid-edit keeps
    // notes_editing set, so coming back via an Ask source chip / Brain Map node /
    // Health jump ran notesLoadNote straight away — it clears notes_editing and
    // replaces the content, so the half-written draft was silently unreachable.
    // Same guard as notesWireTree, for the same reason, in the one other place a
    // note switch is initiated. A save in flight owns notes_content until it
    // resolves, so a deep link waits rather than racing it.
    const mayOpen = target && target !== state.notes_selected && !state.notes_saving
      && (!state.notes_editing || confirm(t('Discard your unsaved changes to this note?','هل تريد تجاهل تغييراتك غير المحفوظة؟')));
    if(mayOpen) await notesLoadNote(target);
    else if(state.notes_flash === target) state.notes_flash = null; // don't flash a note we didn't open
  }
  if(state.notes_listError && !(state.notes_items||[]).length){
    scr.innerHTML = '<div style="margin-bottom:20px;animation:rise .4s ease both"><h1 style="font-family:var(--pixel);font-weight:700;font-size:42px;line-height:1.02">notes.</h1>'
      + '<div style="font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:9px">couldn’t reach your brain just now.</div></div>'
      + '<div style="border:1px solid var(--danger);border-radius:0;background:rgba(255,51,85,.05);padding:34px 30px;text-align:center;color:var(--dust);font-size:14px;font-family:var(--sans)">the local engine didn’t answer. your notes are safe on disk — reopen Notes once it’s running.</div>';
    return;
  }
  if(!(state.notes_items||[]).length){
    scr.innerHTML = '<div class="notes-layout" style="display:grid;grid-template-columns:264px 1fr;gap:16px;height:100%;min-height:520px;animation:rise .4s ease both">'
      + '<div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);padding:20px 12px;font-family:var(--mono);font-size:11.5px;color:var(--faint)">no notes yet.</div>'
      + '<div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center">'
      + '<div style="width:44px;height:44px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:18px;background:var(--surface2);--icon:var(--synapse)">'+px('notes',18)+'</div>'
      + '<h2 style="font-family:var(--pixel);font-weight:600;font-size:22px;margin-bottom:9px">nothing to read yet.</h2>'
      + '<p style="color:var(--dust);font-size:14px;max-width:46ch;font-family:var(--sans)">drop Markdown notes into your brain folder and they’ll appear here — plain files, on your disk, yours alone.</p></div></div>';
    return;
  }
  notesRenderAll();
}
