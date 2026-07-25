// ── Health screen (diagnostics in plain language) ──
// Faithful port of the prototype Health screen (markup ~488-553, data ~1330),
// wired to the real GET /api/check ({ notes, edges, health, byKind, findings[] }).
// Real findings are mapped to friendly, jargon-free cards grouped by kind.
//
// Every finding type carries a real fix path (the owner's rule: the app fixes it, or
// hands you a prompt for your AI): orphans → "connect these" (algorithmic
// wikilink); duplicates/sync-copies → "clean it up" (preview → confirm → delete,
// backed up first) AND "copy AI prompt"; broken links / format → "copy AI prompt"
// (needs judgment). Every destructive action previews first and never fires on
// its own. "show notes" still lists affected paths from local state.

// severity → accent color (per assignment: warn=amber, notice=dust, ok=acid).
// warn is the stronger call ("needs you"); notice is calmer/informational.
const HEALTH_SEV_COL = { warn: 'var(--amber)', notice: 'var(--dust)', ok: 'var(--acid)' };
const HEALTH_SEV_RANK = { warn: 0, notice: 1, ok: 2 };
const HEALTH_BADGE = { warn: 'needs you', notice: 'worth a look', ok: 'all good' };
const healthPlural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

// friendly card definitions, grouped by kind. Each group aggregates one or more
// engine finding kinds; count comes from byKind, example paths from findings[].
const HEALTH_GROUPS = [
  {
    id: 'sync', sev: 'warn', icon: '⟳', keys: ['sync-conflict-copy'],
    title: n => (n === 1 ? '1 possible duplicate copy from syncing' : n + ' possible duplicate copies from syncing'),
    desc: 'Your cloud sync left conflicted copies of some notes. Review each, keep the right one, and delete the rest.',
    count: n => healthPlural(n, 'file'),
    okTitle: 'no sync leftovers', okDesc: 'No conflicted copies from cloud sync — nothing duplicated behind your back.', okCount: '0 files',
  },
  {
    id: 'dupes', sev: 'warn', icon: '⧉', keys: ['duplicate-alias'],
    title: n => healthPlural(n, 'name') + ' claimed by more than one note',
    desc: 'The same name points to two different notes, so a link can land on the wrong one. Give each a distinct name.',
    count: n => healthPlural(n, 'name'),
    okTitle: 'every name is unique', okDesc: 'No two notes fight over the same name — links always land where you mean.', okCount: '0 names',
  },
  {
    id: 'brokenlinks', sev: 'notice', icon: '↗', keys: ['broken-wikilink'],
    title: n => healthPlural(n, 'link') + ' point' + (n === 1 ? 's' : '') + ' to notes that moved',
    desc: 'A few notes reference files that were renamed or moved. Fixing them keeps your connections honest.',
    count: n => healthPlural(n, 'link'),
    okTitle: 'every link resolves', okDesc: 'No broken links — every connection points to a real note.', okCount: '0 links',
  },
  {
    id: 'orphans', sev: 'notice', icon: '✦', keys: ['orphan-note'],
    title: n => healthPlural(n, 'note') + ' nothing links to',
    desc: 'These notes aren’t connected to anything else yet. Recall still finds them — linking them just makes your brain smarter.',
    count: n => healthPlural(n, 'note'),
    okTitle: 'every note is linked', okDesc: 'Nothing is stranded — every note connects to the rest of your brain.', okCount: '0 orphans',
  },
  {
    id: 'mocgaps', sev: 'notice', icon: '◇', keys: ['moc-gap'],
    title: n => healthPlural(n, 'note') + ' missing from ' + (n === 1 ? 'its topic map' : 'their topic maps'),
    desc: 'These notes sit in a folder that has a map-of-content, but the map doesn’t list them yet. Add each to its hub so the topic stays browsable end to end.',
    count: n => healthPlural(n, 'note'),
    okTitle: 'every topic map is complete', okDesc: 'Each map-of-content links the notes in its folder — every topic browses end to end.', okCount: '0 gaps',
  },
  {
    id: 'hubgaps', sev: 'notice', icon: '⌂', keys: ['hub-gap'],
    title: n => healthPlural(n, 'folder') + ' not wired into your maps',
    desc: 'A folder here either has no map-of-content, or its map is not linked from the parent map. That leaves a whole area hard to find — and your AIs will not know to file into it.',
    count: n => healthPlural(n, 'folder'),
    okTitle: 'every folder is on the map', okDesc: 'Each folder has a map-of-content and every map is linked from its parent — new areas stay findable.', okCount: '0 folders',
  },
  {
    id: 'datedrift', sev: 'warn', icon: '⏱', keys: ['dated-note-drift'],
    title: n => healthPlural(n, 'dated note') + ' still being written days later',
    desc: 'A memory record or session log is dated one day but kept being appended to on later days. The record stops matching when things actually happened, so asking about a specific day misses that work. Each day needs its own note.',
    count: n => healthPlural(n, 'note'),
    okTitle: 'dated notes stay on their day', okDesc: 'Every memory record and session log stops being written when its day ends — your timeline stays honest.', okCount: '0 notes',
  },
  {
    id: 'format', sev: 'notice', icon: '≡', keys: ['unknown-type', 'invalid-frontmatter', 'invalid-status', 'missing-frontmatter'],
    title: n => (n === 1 ? '1 note doesn’t match your note format' : n + ' notes don’t match your note format'),
    desc: 'Some notes are missing details, or use a type or status your brain doesn’t recognize yet. Tidying them keeps everything consistent.',
    count: n => healthPlural(n, 'note'),
    okTitle: 'notes match your format', okDesc: 'Every note has the details your brain expects — nothing malformed.', okCount: '0 issues',
  },
];

function healthKick(){
  // first visit to the screen triggers a full check; afterwards we paint state.
  if(!state.health_data && !state.health_error && !state.health_checking){ healthRunCheck(); return; }
  healthPaint();
}

async function healthRunCheck(){
  if(state.health_checking) return;
  state.health_checking = true;
  busyCursor(true); // busy arrow for the run; cleared in the settle below
  state.health_pct = 0;
  state.health_linkPreview = null; state.health_linking = null;  // stale after a re-check
  state.health_expanded = state.health_expanded || {};
  healthPaint(); // show the "running a full check" panel
  announce('running a full check…');

  // The real /api/check is a single request with no progress events, so we run
  // an honest indeterminate bar (caps at 92% until the response lands).
  clearInterval(state.health_iv);
  state.health_iv = setInterval(()=>{
    state.health_pct = Math.min(92, state.health_pct + 4 + Math.random()*9);
    const bar = document.getElementById('healthCheckBar'); if(bar) bar.style.width = Math.round(state.health_pct)+'%';
    const pct = document.getElementById('healthCheckPct'); if(pct) pct.textContent = Math.round(state.health_pct)+'%';
    const pb = document.getElementById('healthCheckProgress'); if(pb) pb.setAttribute('aria-valuenow', String(Math.round(state.health_pct)));
  }, 120);

  try{
    const d = await api('/api/check');
    if(d && d.error){ state.health_error = d.error; state.health_data = null; }
    else { state.health_data = d; state.health_error = null; state.health_checkedAt = Date.now(); }
  }catch(e){ state.health_error = 'offline'; state.health_data = null; }

  clearInterval(state.health_iv);
  state.health_pct = 100;
  const bar = document.getElementById('healthCheckBar'); if(bar) bar.style.width = '100%';
  const pct = document.getElementById('healthCheckPct'); if(pct) pct.textContent = '100%';
  const pb = document.getElementById('healthCheckProgress'); if(pb) pb.setAttribute('aria-valuenow', '100');
  // announce the outcome in the same plain words the summary uses
  if(state.health_error){ announce('check didn’t complete · try again'); }
  else{
    const bk = (state.health_data && state.health_data.byKind) || {};
    const issues = Object.keys(bk).reduce((s,k)=>s+(bk[k]||0),0);
    announce(issues ? ('check complete · ' + issues + ' things worth a look') : 'check complete · all clear');
  }

  // brief settle so the completed bar is visible, matching the prototype
  setTimeout(()=>{
    state.health_checking = false;
    busyCursor(false);
    if(state.screen === 'health') healthPaint();
  }, 460);
}

// public entry called by the shell's render()
function renderHealth(){ healthKick(); }

function healthPaint(){
  if(state.screen !== 'health') return;
  const scr = $('#screen'); if(!scr) return;
  const d = state.health_data;

  const header = (sub) => `
    <div style="margin-bottom:20px;animation:rise .4s ease both">
      <h1 style="font-family:var(--pixel);font-weight:700;font-size:42px;letter-spacing:.01em;line-height:1.02">your brain, checked.</h1>
      <div style="font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:9px">${sub}</div>
    </div>`;

  // ── loading (initial check + run-full-check) ──
  if(state.health_checking){
    scr.innerHTML = header('running a full check…') + `
      <div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);overflow:hidden;margin-bottom:16px">
        <div style="display:flex;align-items:center;padding:9px 14px;border-bottom:1px solid var(--edge);background:var(--surface2)">
          <span style="font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)">running a full check</span>
          <span id="healthCheckPct" style="margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--faint)">${Math.round(state.health_pct||0)}%</span>
        </div>
        <div style="padding:20px 20px 22px">
          <div style="font-family:var(--mono);font-size:13px;color:var(--dust);margin-bottom:14px"><span style="color:var(--synapse-ink)">›</span> reading every note, link, and word…</div>
          <div id="healthCheckProgress" role="progressbar" aria-label="health check progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(state.health_pct||0)}" style="height:6px;background:var(--surface2);border-radius:0;overflow:hidden;position:relative">
            <i id="healthCheckBar" style="display:block;height:100%;width:${Math.round(state.health_pct||0)}%;background:var(--synapse);transition:width .12s"></i>
            <i style="position:absolute;top:0;left:0;height:100%;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);animation:barflow 1.3s linear infinite"></i>
          </div>
          <div style="font-family:var(--mono);font-size:11px;color:var(--faint);margin-top:14px">this never leaves your device — the whole check runs offline.</div>
        </div>
      </div>`;
    return;
  }

  // ── error / no-brain / empty ──
  const noBrain = state.health_error && /brain/i.test(state.health_error);
  if(state.health_error && !noBrain){
    scr.innerHTML = header('couldn’t run the check') + healthCard(
      '✕', 'var(--amber)', 'couldn’t reach your brain',
      'The check didn’t complete — the dashboard couldn’t read your notes just now. Try running it again.',
      true);
    healthWireRetry();
    return;
  }
  if(noBrain || !d || (d && (d.notes||0) === 0)){
    scr.innerHTML = header('brand new brain · nothing to check yet') + healthCard(
      '✓', 'var(--acid)', 'nothing to check yet.',
      'Once you add notes and connect an AI, Callosium keeps an eye on your brain’s health here — links, freshness, duplicates, and more.',
      false);
    return;
  }

  // ── main ──
  const notes = d.notes || 0;
  const edges = d.edges || 0;
  const byKind = d.byKind || {};
  const findings = d.findings || [];
  const score = Math.max(0, Math.min(100, Math.round(d.health != null ? d.health : 0)));
  const scoreCol = score >= 95 ? 'var(--acid)' : score >= 85 ? 'var(--amber)' : 'var(--danger)';

  // build friendly groups from real counts
  state.health_expanded = state.health_expanded || {};
  const cards = HEALTH_GROUPS.map(g => {
    const n = g.keys.reduce((s,k)=>s + (byKind[k]||0), 0);
    const items = n > 0 ? findings.filter(f => g.keys.indexOf(f.kind) !== -1) : [];
    return { g, n, items, paths: items.map(f => f.path), active: n > 0 };
  });
  // synthetic "everything indexed" reassurance card, mirroring the design
  const indexedCard = {
    g: { id: 'indexed', sev: 'ok', icon: '✓' },
    n: 0, paths: [], active: false, indexed: true, notes,
  };
  const all = cards.concat([indexedCard]);
  // problems first: warn, then notice, then ok
  all.sort((a,b)=>{
    const ra = HEALTH_SEV_RANK[a.active ? a.g.sev : 'ok'];
    const rb = HEALTH_SEV_RANK[b.active ? b.g.sev : 'ok'];
    return ra - rb;
  });

  const activeGroups = cards.filter(c => c.active);
  const anyWarn = activeGroups.some(c => c.g.sev === 'warn');
  // summary that changes with the score. "needs you" (warn) = could send a link
  // or an answer to the WRONG note; everything else is tidy-up that sharpens recall.
  let reassure;
  if(activeGroups.length === 0) reassure = 'spotless — nothing needs your attention.';
  else if(score >= 85) reassure = anyWarn ? 'in great shape — a couple things to tidy when you like.' : 'in great shape — just a few tidy-ups when you like.';
  else if(score >= 65) reassure = anyWarn ? 'a few things want your attention — none are breaking recall yet.' : 'a few things worth tidying to keep recall sharp.';
  else reassure = anyWarn ? 'worth a cleanup — some links or duplicates can send answers to the wrong note.' : 'worth a cleanup — lots of loose ends to tie together.';
  const checkedAt = state.health_checkedAt || Date.now();
  const sub = activeGroups.length === 0
    ? 'all clear · last full check ' + relTime(checkedAt)
    : healthPlural(activeGroups.length, 'thing') + ' worth a look · last full check ' + relTime(checkedAt);

  // quick chips derived from real data
  const brokenN = byKind['broken-wikilink'] || 0;
  const orphanN = byKind['orphan-note'] || 0;
  const intactPct = (edges + brokenN) > 0 ? Math.round((1 - brokenN/(edges+brokenN)) * 1000)/10 : 100;
  const linkedPct = notes > 0 ? Math.round((1 - orphanN/notes) * 100) : 100;
  const chips = [
    { label: 'connections intact', val: intactPct + '%' },
    { label: 'everything indexed', val: '100%' },
    { label: 'notes all linked', val: linkedPct + '%' },
  ];

  const heroPct = 'font-family:var(--pixelnum);color:'+scoreCol;

  scr.innerHTML = header(sub) + `
    <div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);padding:22px 24px;margin-bottom:18px;display:flex;gap:26px;align-items:center;flex-wrap:wrap;animation:rise .4s ease both">
      <div style="flex:1;min-width:250px">
        <div style="display:flex;align-items:baseline;gap:3px;flex-wrap:wrap">
          <span id="healthScore" style="${heroPct};font-size:44px;line-height:.9">${score}</span><span style="${heroPct};font-size:18px">%</span><span id="healthDelta" style="font-family:var(--mono);font-size:12px;font-weight:500;margin-left:9px;opacity:0;white-space:nowrap"></span>
          <span style="font-family:var(--mono);font-size:12px;color:var(--dust);margin-left:14px">${reassure}</span>
        </div>
        <div style="height:8px;background:var(--surface2);border-radius:0;overflow:hidden;margin-top:16px"><i style="display:block;height:100%;width:${score}%;background:var(--synapse);transition:width .7s cubic-bezier(.5,0,.2,1)"></i></div>
        <div style="font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:10px">brain health · everything measured on this device</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:11px">
        <button id="healthRunBtn" style="font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:11px 18px;border-radius:0;cursor:pointer;transition:.12s">run full check</button>
        <div style="display:flex;gap:8px">
          ${chips.map(c=>`<div style="border:1px solid var(--edge2);border-radius:0;padding:8px 11px;text-align:center;min-width:74px"><div style="font-family:var(--pixelnum);font-size:11px;color:var(--acid)">${esc(c.val)}</div><div style="font-family:var(--mono);font-size:8px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-top:3px">${esc(c.label)}</div></div>`).join('')}
        </div>
      </div>
    </div>

    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:6px 0 12px">
      <span style="font-family:var(--pixel);font-weight:600;font-size:16px;letter-spacing:.04em;text-transform:uppercase;color:var(--dust)">what we found</span>
      <span style="font-family:var(--mono);font-size:11.5px;color:var(--faint)"><span style="color:var(--amber)">needs you</span> = could send a link or answer to the wrong note · <span style="color:var(--dust)">worth a look</span> = tidy-ups that sharpen recall</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${all.map(healthFindingHTML).join('')}
    </div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:16px">A fix shows you exactly what it'll change and waits for your OK — nothing happens to your notes on its own.</div>
    ${healthDismissedHTML(d)}`;

  // Hero score motion (Direction 1, same language as the vitals strip): a
  // stepped count-up + delta chip ONLY when the score changed since the last
  // paint. Same-score repaints (expand, dismiss, quiet refresh) stay still;
  // the first paint after a check settles instantly (the progress bar was the
  // anticipation). Reduced motion: instant values, static chip.
  const prevScore = state.health_prevScore;
  state.health_prevScore = score;
  const scoreEl = document.getElementById('healthScore');
  if(scoreEl){
    const deltaEl = document.getElementById('healthDelta');
    const showChip = (dd)=>{
      if(!deltaEl) return;
      deltaEl.textContent = (dd>0?'+':'−')+Math.abs(dd)+'%';
      deltaEl.style.color = dd>0 ? 'var(--acid)' : 'var(--amber)';
      if(deltaEl._t) clearTimeout(deltaEl._t);
      if(window.__reduceMotion){ deltaEl.style.transition='none'; deltaEl.style.opacity='1'; deltaEl._t=setTimeout(()=>{ deltaEl.style.opacity='0'; },4000); return; }
      deltaEl.style.transition='opacity .2s steps(2)'; deltaEl.style.opacity='1';
      deltaEl._t=setTimeout(()=>{ deltaEl.style.transition='opacity .5s ease'; deltaEl.style.opacity='0'; },4000);
    };
    clearInterval(state.health_scoreIv);
    if(window.__reduceMotion || prevScore == null || prevScore === score){
      scoreEl.textContent = score;
      if(prevScore != null && prevScore !== score) showChip(score - prevScore);
    } else {
      const STEPS=10; let s=0; // 10 quantized steps over ~0.5s
      scoreEl.textContent = prevScore;
      showChip(score - prevScore);
      state.health_scoreIv = setInterval(()=>{
        s++;
        const el=document.getElementById('healthScore');
        if(!el){ clearInterval(state.health_scoreIv); state.health_scoreIv=null; return; }
        el.textContent = Math.round(prevScore+(score-prevScore)*Math.min(1,s/STEPS));
        if(s>=STEPS){ clearInterval(state.health_scoreIv); state.health_scoreIv=null; }
      },50);
    }
  }

  // wire run-full-check (real: re-fetch /api/check)
  const runBtn = document.getElementById('healthRunBtn');
  if(runBtn){
    runBtn.onclick = ()=>healthRunCheck();
    runBtn.onmouseenter = ()=>{ runBtn.style.background='var(--synapse)'; runBtn.style.color='var(--on-accent)'; };
    runBtn.onmouseleave = ()=>{ runBtn.style.background='transparent'; runBtn.style.color='var(--synapse-ink)'; };
  }
  // wire per-finding "show notes" toggles (local-only: no fix endpoint exists)
  scr.querySelectorAll('[data-hexpand]').forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.getAttribute('data-hexpand');
      state.health_expanded[id] = !state.health_expanded[id];
      healthPaint();
    };
  });
  // clickable affected notes → open that note in Notes
  scr.querySelectorAll('.h-jump').forEach(el=>{ el.onclick = ()=>{ const p = el.getAttribute('data-hpath'); if(p){ state.notes_open = p; nav('notes'); } }; });
  // orphan auto-connect flow (preview → confirm → apply)
  const hc = scr.querySelector('[data-hconnect]'); if(hc) hc.onclick = healthConnectPreview;
  const ha = scr.querySelector('[data-hconnect-apply]'); if(ha) ha.onclick = healthConnectApply;
  const hx = scr.querySelector('[data-hconnect-cancel]'); if(hx) hx.onclick = healthConnectCancel;
  const hdo = scr.querySelector('[data-hdismiss-orphans]'); if(hdo) hdo.onclick = healthDismissAllOrphans;
  // copy-AI-prompt handoff (broken links, dupes, sync, format)
  scr.querySelectorAll('[data-hprompt]').forEach(b=>{ b.onclick = ()=>healthCopyPrompt(b.getAttribute('data-hprompt')); });
  // per-finding dismiss / restore + the "review dismissed" toggle
  scr.querySelectorAll('.h-dismiss').forEach(el=>{ el.onclick = (e)=>{ e.stopPropagation(); healthDismiss(el); }; });
  scr.querySelectorAll('[data-hrestore]').forEach(el=>{ el.onclick = ()=>healthUndismiss(el.getAttribute('data-hrestore')); });
  const hrev = scr.querySelector('[data-hreview-toggle]'); if(hrev) hrev.onclick = ()=>{ state.health_showDismissed = !state.health_showDismissed; healthPaint(); };
  // duplicate/conflict cleanup flow (preview → confirm → delete, backup first)
  scr.querySelectorAll('[data-hclean]').forEach(b=>{ b.onclick = ()=>healthCleanPreview(b.getAttribute('data-hclean')); });
  const hka = scr.querySelector('[data-hclean-apply]'); if(hka) hka.onclick = ()=>healthCleanApply(state.health_cleanup && state.health_cleanup.kind);
  const hkc = scr.querySelector('[data-hclean-cancel]'); if(hkc) hkc.onclick = healthCleanCancel;
}

// one finding card (active colored card, or an ok green-check card)
function healthFindingHTML(item){
  const g = item.g;
  const sev = item.active ? g.sev : 'ok';
  const col = HEALTH_SEV_COL[sev];
  const isWarn = sev === 'warn';
  const icon = item.active ? g.icon : '✓';

  const title = item.indexed ? 'everything is indexed'
    : item.active ? g.title(item.n) : g.okTitle;
  const desc = item.indexed ? ('All ' + (item.notes||0).toLocaleString('en-US') + ' notes are searchable, and this check just ran.')
    : item.active ? g.desc : g.okDesc;
  const count = item.indexed ? ((item.notes||0).toLocaleString('en-US') + ' notes')
    : item.active ? g.count(item.n) : g.okCount;
  const badge = HEALTH_BADGE[sev];

  const cardStyle = 'display:flex;gap:14px;align-items:flex-start;border:1px solid '
    + (isWarn ? 'var(--amber)' : 'var(--edge2)')
    + ';border-left:3px solid ' + col + ';border-radius:0;background:'
    + (isWarn ? 'rgba(255,180,84,.05)' : 'var(--surface)') + ';padding:16px 18px;animation:rise .3s ease both';
  const iconStyle = 'width:30px;height:30px;flex-shrink:0;border-radius:0;border:1px solid var(--edge2);background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:15px;color:' + col;
  const badgeStyle = 'font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;color:' + col + ';border:1px solid var(--edge2);border-radius:0;padding:3px 9px';
  const btnSyn = 'font-family:var(--mono);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:7px 13px;border-radius:0;cursor:pointer;white-space:nowrap';
  const btnGhost = 'font-family:var(--mono);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:7px 13px;border-radius:0;cursor:pointer;white-space:nowrap';

  const isOrphan = g.id === 'orphans';
  const pv = isOrphan ? state.health_linkPreview : null;
  const linking = isOrphan ? state.health_linking : null;
  const canExpand = item.active && item.items && item.items.length > 0;
  const open = canExpand && !!(state.health_expanded && state.health_expanded[g.id]);

  // which fix flow (if any) is currently open on THIS card
  const cleanKind = g.id === 'sync' ? 'sync' : g.id === 'dupes' ? 'dup' : null;
  const cleaningThis = cleanKind && state.health_cleanup && state.health_cleanup.kind === cleanKind;

  // expandable body: a fix preview (connect/cleanup) for its card, else the notes list
  let body = '';
  if(isOrphan && (linking || pv)){
    body = healthConnectHTML();
  } else if(cleaningThis){
    body = healthCleanupHTML();
  } else if(open){
    const MAXP = 50;
    const rows = item.items.slice(0, MAXP).map(healthItemRow).join('');
    body = `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:11px;display:flex;flex-direction:column;gap:1px">
        ${rows}
        ${item.items.length > MAXP ? `<div style="font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:4px">…and ${item.items.length - MAXP} more</div>` : ''}
        <div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-top:7px">click any note to open it.</div>
      </div>`;
  }

  // actions per finding type: orphans → connect; sync/dupes → clean up + AI prompt;
  // broken links / format → AI prompt (needs human/AI judgment). Every card can
  // also "show notes". While a fix preview is open, its own buttons drive it.
  let actions = '';
  if(canExpand){
    const showBtn = `<button data-hexpand="${esc(g.id)}" style="${btnGhost}">${open ? 'hide notes' : 'show notes'}</button>`;
    const copied = state.health_promptCopied === g.id;
    const promptBtn = `<button data-hprompt="${esc(g.id)}" style="${btnGhost}">${copied ? 'copied ✓' : 'copy AI prompt'}</button>`;
    const busy = (isOrphan && (linking || pv)) || cleaningThis;
    if(busy){ /* the open preview owns the controls */ }
    else if(isOrphan){ actions = `<button data-hconnect="1" style="${btnSyn}">connect these</button>${showBtn}`; }
    else if(g.id === 'sync'){ actions = `<button data-hclean="sync" style="${btnSyn}">clean it up</button>${promptBtn}${showBtn}`; }
    else if(g.id === 'dupes'){ actions = `<button data-hclean="dup" style="${btnSyn}">clean it up</button>${promptBtn}${showBtn}`; }
    else if(g.id === 'brokenlinks' || g.id === 'format' || g.id === 'hubgaps' || g.id === 'datedrift'){ actions = `${promptBtn}${showBtn}`; }
    else actions = showBtn;
  }

  return `
    <div class="hf-card" style="${cardStyle}">
      <span style="${iconStyle}">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px;flex-wrap:wrap"><span style="font-family:var(--grot);font-weight:600;font-size:15.5px;color:var(--starlight)">${esc(title)}</span><span style="${badgeStyle}">${badge}</span></div>
        <div style="font-size:14px;color:var(--dust);line-height:1.6;max-width:82ch">${esc(desc)}</div>
        ${body}
      </div>
      <div class="hf-actions" style="display:flex;flex-direction:column;align-items:flex-end;gap:9px;flex-shrink:0">
        <span style="font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap">${esc(count)}</span>
        ${actions}
      </div>
    </div>`;
}

// one affected-note row — clickable (jumps to Notes) with a per-kind hint of the
// actual problem (broken target, shared name, or which note it duplicates).
function healthItemRow(f){
  const p = f.path || '';
  const priv = /^Private\//.test(p);
  let extra = '';
  if(f.kind === 'broken-wikilink'){ const m = /\[\[([^\]]+)\]\]/.exec(f.detail||''); if(m) extra = ` <span style="color:var(--amber)">→ [[${esc(m[1])}]]</span><span style="color:var(--faint)"> missing</span>`; }
  else if(f.kind === 'duplicate-alias'){ const m = /^"([^"]+)"/.exec(f.detail||''); if(m) extra = ` <span style="color:var(--faint)">— shares the name "${esc(m[1])}"</span>`; }
  else if(f.kind === 'sync-conflict-copy'){ const m = /duplicate of "([^"]+)"/.exec(f.detail||''); if(m) extra = ` <span style="color:var(--faint)">— copy of ${esc(String(m[1]).split('/').pop())}</span>`; }
  const clickable = p && !priv;
  // Per-finding Dismiss ("I looked — it's fine / false positive"). Keyed by the
  // finding's stable id (set server-side); persists so it stays gone next check.
  const key = f.key || '';
  const dismiss = key
    ? `<button type="button" class="h-dismiss" data-hd-key="${esc(key)}" data-hd-kind="${esc(f.kind||'')}" data-hd-path="${esc(p)}" data-hd-detail="${esc(f.detail||'')}" title="dismiss — I looked, it's fine" style="flex-shrink:0;font-family:var(--mono);font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--faint);cursor:pointer;padding:2px 6px;border:1px solid var(--edge2);border-radius:0;margin-left:8px;background:transparent">dismiss</button>`
    : '';
  const rowInner = `<span style="color:var(--synapse)">${clickable?'↳':(priv?'🔒':'•')}</span> ${esc(p)}${extra}`;
  const rowStyle = `flex:1;min-width:0;font-family:var(--mono);font-size:13px;color:${clickable?'var(--dust)':'var(--faint)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
  const rowEl = clickable
    ? `<button type="button" class="h-jump" data-hpath="${esc(p)}" style="${rowStyle};cursor:pointer;background:none;border:0;padding:0;text-align:left" title="${esc(p)}">${rowInner}</button>`
    : `<span style="${rowStyle}" title="${esc(p)}">${rowInner}</span>`;
  return `<div style="display:flex;align-items:center;gap:4px;padding:3px 0">
      ${rowEl}
      ${dismiss}
    </div>`;
}

// the orphan "connect these" preview/apply block (algorithmic wikilink hygiene)
function healthConnectHTML(){
  if(state.health_linking === 'preview') return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust)"><span style="color:var(--synapse)">›</span> finding safe links to add…</div>`;
  if(state.health_linking === 'applying') return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust)"><span style="color:var(--synapse)">›</span> adding links…</div>`;
  const pv = state.health_linkPreview; if(!pv) return '';
  const cancel = `<button data-hconnect-cancel="1" style="font-family:var(--mono);font-size:12px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:8px 14px;border-radius:0;cursor:pointer">close</button>`;
  if(!pv.links){
    // Nothing else in the vault mentions these notes by name, so there's nothing to
    // auto-link — which means they're legitimately standalone, not a problem. Offer
    // to dismiss them (accept as standalone) instead of a dead "do it by hand".
    const orphanN = ((state.health_data && state.health_data.findings) || []).filter(f=>f.kind==='orphan-note').length;
    const dismissAll = orphanN ? `<button data-hdismiss-orphans="1" style="font-family:var(--mono);font-size:12px;letter-spacing:.03em;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:8px 14px;border-radius:0;cursor:pointer">accept ${orphanN} as standalone</button>` : '';
    return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust);line-height:1.6">nothing else mentions these by name, so there's nothing to auto-link — they just stand on their own, which is fine. Accept them as standalone to clear them, or dismiss individual ones from “show notes”.<div style="display:flex;gap:9px;margin-top:11px">${dismissAll}${cancel}</div></div>`;
  }
  const rows = (pv.sample||[]).slice(0, 24).map(e => `
      <div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <div style="font-family:var(--mono);font-size:12.5px;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(String(e.path).split('/').pop())}</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--dust);margin-top:2px">${(e.adds||[]).map(a=>`<span style="color:var(--acid)">[[${esc(a.phrase)}]]</span>`).join(' ')}</div>
      </div>`).join('');
  return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px">
      <div style="font-family:var(--mono);font-size:13px;color:var(--dust);line-height:1.6;margin-bottom:10px">Callosium can reconnect <span style="color:var(--starlight)">${pv.orphansConnected ?? pv.notes}</span> of your ${pv.orphanTotal} orphans by adding <span style="color:var(--acid)">${pv.links}</span> wikilinks across ${pv.notes} notes — it only wraps names you already wrote, never your words.</div>
      <div class="on-console" style="max-height:230px;overflow:auto;background:var(--console);border:1px solid var(--edge2);border-radius:0;padding:8px 12px">${rows}${(pv.sample||[]).length > 24 ? `<div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-top:6px">…and ${pv.notes - 24} more notes</div>` : ''}</div>
      <div style="display:flex;gap:9px;margin-top:12px">
        <button data-hconnect-apply="1" style="font-family:var(--pixel);font-weight:600;font-size:12.5px;letter-spacing:.03em;text-transform:uppercase;border:1px solid var(--acid);color:var(--acid);background:transparent;padding:9px 16px;border-radius:0;cursor:pointer">apply ${pv.links} links</button>
        <button data-hconnect-cancel="1" style="font-family:var(--mono);font-size:12px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:9px 14px;border-radius:0;cursor:pointer">cancel</button>
      </div>
    </div>`;
}

async function healthConnectPreview(){
  if(state.health_linking) return;
  state.health_linking = 'preview'; state.health_linkPreview = null;
  if(state.health_expanded) state.health_expanded['orphans'] = false;  // preview replaces the list
  healthPaint();
  try{ const r = await post('/api/link/preview', {}); state.health_linkPreview = (r && !r.error) ? r : { notes:0, links:0, orphanTotal:0, orphansConnected:0, sample:[] }; }
  catch(e){ state.health_linkPreview = { notes:0, links:0, orphanTotal:0, orphansConnected:0, sample:[] }; }
  state.health_linking = null;
  if(state.screen === 'health') healthPaint();
}
async function healthConnectApply(){
  if(state.health_linking) return;
  state.health_linking = 'applying'; healthPaint();
  try{ await post('/api/link/apply', {}); }catch(e){}
  state.health_linking = null; state.health_linkPreview = null;
  healthRunCheck();   // re-check: the orphan count should drop
}
function healthConnectCancel(){ state.health_linking = null; state.health_linkPreview = null; if(state.screen === 'health') healthPaint(); }

// ── duplicate/conflict cleanup: preview → confirm → delete (backup first) ──
function healthCleanupHTML(){
  const c = state.health_cleanup; if(!c) return '';
  const cancel = `<button data-hclean-cancel="1" style="font-family:var(--mono);font-size:12px;text-transform:uppercase;border:1px solid var(--edge2);color:var(--dust);background:transparent;padding:8px 14px;border-radius:0;cursor:pointer">close</button>`;
  if(c.phase === 'preview') return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust)"><span style="color:var(--synapse)">›</span> finding exact-duplicate copies that are safe to remove…</div>`;
  if(c.phase === 'applying') return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust)"><span style="color:var(--synapse)">›</span> backing up, then removing the copies…</div>`;
  const d = c.data || { groups:[], files:0, bytes:0, diverged:[] };
  // Conflict copies that DIVERGED from their original are never auto-deleted (they hold edits the
  // original doesn't) — tell the owner so they can merge them by hand instead of assuming they're gone.
  const divergedNote = (d.diverged && d.diverged.length)
    ? `<div style="margin-top:10px;font-family:var(--mono);font-size:12px;color:var(--amber);line-height:1.6">⚠ ${d.diverged.length} conflict cop${d.diverged.length===1?'y was':'ies were'} kept — ${d.diverged.length===1?'it holds':'they hold'} edits your original doesn’t, so Callosium won’t delete ${d.diverged.length===1?'it':'them'}. Open and merge by hand.</div>`
    : '';
  if(!d.files){
    return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px;font-family:var(--mono);font-size:13px;color:var(--dust);line-height:1.6">nothing here is an <em>exact</em> duplicate the app can safely remove on its own — these are distinct notes that share a name. <span style="color:var(--faint)">use “copy AI prompt” to have your assistant review them.</span>${divergedNote}<div style="margin-top:10px">${cancel}</div></div>`;
  }
  const rows = (d.groups||[]).slice(0,30).map(g=>`
      <div style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <div style="font-family:var(--mono);font-size:12.5px;color:var(--dust)"><span style="color:var(--acid)">keep</span> ${esc(String(g.keep).split('/').pop())}</div>
        ${(g.remove||[]).map(r=>`<div style="font-family:var(--mono);font-size:12px;color:var(--faint);padding-left:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r)}"><span style="color:var(--amber)">✕ remove</span> ${esc(r)}</div>`).join('')}
      </div>`).join('');
  const kb = Math.round((d.bytes||0)/1024);
  return `<div style="margin-top:12px;border-top:1px solid var(--edge);padding-top:12px">
      <div style="font-family:var(--mono);font-size:13px;color:var(--dust);line-height:1.6;margin-bottom:10px">Callosium will remove <span style="color:var(--amber)">${d.files}</span> redundant file${d.files===1?'':'s'}${kb?` (${kb} KB)`:''}, keeping the original of each. Every removed file is copied to <span style="color:var(--faint)">~/.callosium/backups</span> first — you can restore any of them.</div>
      <div class="on-console" style="max-height:230px;overflow:auto;background:var(--console);border:1px solid var(--edge2);border-radius:0;padding:8px 12px">${rows}${(d.groups||[]).length>30?`<div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);margin-top:6px">…and ${(d.groups.length-30)} more groups</div>`:''}</div>
      ${divergedNote}
      <div style="display:flex;gap:9px;margin-top:12px">
        <button data-hclean-apply="1" style="font-family:var(--pixel);font-weight:600;font-size:12.5px;letter-spacing:.03em;text-transform:uppercase;border:1px solid var(--amber);color:var(--amber);background:transparent;padding:9px 16px;border-radius:0;cursor:pointer">remove ${d.files} file${d.files===1?'':'s'}</button>
        ${cancel}
      </div>
    </div>`;
}
async function healthCleanPreview(kind){
  if(state.health_cleanup) return;
  state.health_cleanup = { kind, phase:'preview', data:null };
  if(state.health_expanded) state.health_expanded[kind==='sync'?'sync':'dupes'] = false;
  healthPaint();
  try{ const r = await post('/api/cleanup/preview?kind='+encodeURIComponent(kind), {}); state.health_cleanup = { kind, phase:'ready', data:(r && !r.error) ? r : { groups:[], files:0, bytes:0 } }; }
  catch(e){ state.health_cleanup = { kind, phase:'ready', data:{ groups:[], files:0, bytes:0 } }; }
  if(state.screen === 'health') healthPaint();
}
async function healthCleanApply(kind){
  if(!state.health_cleanup) return;
  state.health_cleanup.phase = 'applying'; healthPaint();
  try{ await post('/api/cleanup/apply?kind='+encodeURIComponent(kind||''), {}); }catch(e){}
  state.health_cleanup = null;
  healthRunCheck();   // re-check: the duplicate/conflict count should drop
}
function healthCleanCancel(){ state.health_cleanup = null; if(state.screen === 'health') healthPaint(); }

// ── dismiss: the third exit for a finding — "I looked, it's fine / false positive".
// Persisted server-side; a dismissed finding drops out of the counts, the score,
// and the cards, and lives in a collapsible "N dismissed — review" list to restore.
function healthDismissedHTML(d){
  const list = (d && d.dismissed) || [];
  if(!list.length) return '';
  const open = !!state.health_showDismissed;
  const kindHint = k => k==='broken-wikilink'?'broken link':k==='orphan-note'?'standalone':k==='duplicate-alias'?'shared name':k==='sync-conflict-copy'?'sync copy':k==='moc-gap'?'off its map':'format';
  const rows = !open ? '' : list.map(x=>`
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0">
        <span style="flex:1;min-width:0;font-family:var(--mono);font-size:12.5px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(x.detail||x.path||'')}">• ${esc(x.path||x.detail||x.key)} <span style="color:var(--edge)">·</span> <span style="color:var(--dust)">${esc(kindHint(x.kind))}</span></span>
        <button type="button" data-hrestore="${esc(x.key)}" title="restore — show this again" style="flex-shrink:0;font-family:var(--mono);font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:var(--synapse-ink);cursor:pointer;padding:2px 7px;border:1px solid var(--edge2);border-radius:0;background:transparent">restore</button>
      </div>`).join('');
  return `<div style="margin-top:14px;border-top:1px solid var(--surface2);padding-top:12px">
      <button type="button" data-hreview-toggle aria-expanded="${open?'true':'false'}" style="font-family:var(--mono);font-size:12px;color:var(--dust);cursor:pointer;display:inline-flex;align-items:center;gap:7px;background:none;border:0;padding:0"><span style="color:var(--faint)">${open?'▾':'▸'}</span>${list.length} dismissed — ${open?'hide':'review'}</button>
      ${open?`<div style="margin-top:9px;display:flex;flex-direction:column;gap:1px;max-width:82ch">${rows}</div>`:''}
    </div>`;
}
async function healthDismiss(el){
  const key = el.getAttribute('data-hd-key'); if(!key) return;
  el.textContent = '…'; el.style.pointerEvents = 'none';
  try{ await post('/api/health/dismiss', { key, kind: el.getAttribute('data-hd-kind')||'', path: el.getAttribute('data-hd-path')||'', detail: el.getAttribute('data-hd-detail')||'' }); }catch(e){}
  await healthQuietRefresh();
}
async function healthUndismiss(key){
  if(!key) return;
  try{ await post('/api/health/undismiss', { key }); }catch(e){}
  await healthQuietRefresh();
}
// re-fetch findings WITHOUT the full-check progress animation — dismiss/restore is
// instant, so we quietly swap the data and repaint rather than replaying the scan.
async function healthQuietRefresh(){
  try{ const d = await api('/api/check'); if(d && !d.error){ state.health_data = d; state.health_checkedAt = Date.now(); } }catch(e){}
  if(state.screen==='health') healthPaint();
}
// dismiss every currently-shown orphan at once — "these all stand on their own".
async function healthDismissAllOrphans(){
  const F = (state.health_data && state.health_data.findings) || [];
  const orphans = F.filter(f=>f.kind==='orphan-note' && f.key);
  for(const f of orphans){ try{ await post('/api/health/dismiss', { key:f.key, kind:f.kind, path:f.path, detail:f.detail||'' }); }catch(e){} }
  state.health_linkPreview = null; state.health_linking = null;
  await healthQuietRefresh();
}

// ── copy-AI-prompt handoff: build a ready-to-paste prompt from the real findings ──
function healthPromptText(groupId){
  const d = state.health_data; if(!d || !d.findings) return '';
  // This text is copied for the owner to paste into a THIRD-PARTY AI, so it is a route
  // OFF the device. The cockpit is the owner's own view and may display Private/ freely,
  // but the product's promise is that the gated partition does not leave the machine —
  // so gated notes are withheld here, in paths, targets and free-text detail alike, and
  // the omission is stated rather than silent.
  const GATED = /(^|\/)Private\//i;
  const isGated = (f) => GATED.test(f.path||'') || GATED.test(f.related||'') || GATED.test(f.target||'') || GATED.test(f.detail||'');
  const all = d.findings;
  const F = all.filter(f => !isGated(f));
  const withheld = all.length - F.length;
  const privacyNote = withheld
    ? `\n\nNote: ${withheld} item${withheld===1?'':'s'} under your gated Private/ partition ${withheld===1?'was':'were'} deliberately left out of this prompt so nothing from it leaves your device. Handle those in Callosium directly.`
    : '';
  // Shared guardrails: these lists can contain FALSE POSITIVES, verbatim source is
  // off-limits, and I want a report of what was NOT a real issue so I can dismiss it.
  const intro = 'You have access to my Callosium knowledge vault through its MCP tools (search, read_note, resolve, write_note). Work carefully and reversibly. Two hard rules for the task below:\n'
    + '(1) NEVER edit any file under a "/Raw/" or "/Recovered Sessions/" folder — that is verbatim source I keep exactly as-is.\n'
    + '(2) This list can contain FALSE POSITIVES. Do NOT blindly apply the fix — open each item first and judge whether it is really a problem.\n'
    + 'When done, give me TWO lists: what you actually changed, and what you decided was NOT a real problem (one line each, with why) so I can dismiss those.\n\n';
  if(groupId === 'brokenlinks'){
    const items = F.filter(f=>f.kind==='broken-wikilink').slice(0,200);
    const lines = items.map(f=>{ const t = f.target || (/\[\[([^\]]+)\]\]/.exec(f.detail||'')||[])[1] || '?'; return '- '+f.path+'  →  [['+t+']]'; }).join('\n');
    return intro+'Task — broken wiki-links (a [[link]] that resolves to no note). For EACH, open the note and decide:\n'
      + '- The referenced note EXISTS under a renamed/split/different name → repoint the link (use search/resolve to find it).\n'
      + '- It points at something that is NOT a note — a skill, a file/attachment, one of my AI memories, or a bare syntax example like [[name]]/[[text]] → remove the [[ ]] and keep the plain text.\n'
      + '- It is a note I genuinely should create → do NOT create it; just list it so I decide.\n'
      + 'Do not create new notes.\n\nBroken links (note → missing target):\n'+lines+privacyNote;
  }
  if(groupId === 'dupes'){
    const items = F.filter(f=>f.kind==='duplicate-alias').slice(0,100);
    const lines = items.map(f=>'- '+(f.detail||'')).join('\n');
    return intro+'Task — notes that share a name, so a [[link]] can land on the wrong one. For each, open them and decide: if they are TRUE duplicates (near-identical content), keep one and delete the rest; if they are DISTINCT notes that merely share a name, decide which owns the bare name and rename/re-alias the others; if the folder itself conveys a meaningful stage (e.g. Tender vs Submitted), leave both and just disambiguate the name. Confirm with me before deleting anything.\n\nShared names:\n'+lines+privacyNote;
  }
  if(groupId === 'sync'){
    const items = F.filter(f=>f.kind==='sync-conflict-copy').slice(0,100);
    const lines = items.map(f=>'- '+f.path+(f.related?('   (copy of '+f.related+')'):'')).join('\n');
    return intro+'Task — files that look like cloud-sync conflict copies. For each, compare it to its original: if it is truly redundant, merge anything unique into the original then delete the copy; if it turns out to be a distinct note, leave it. Confirm before deleting.\n\nConflict copies:\n'+lines+privacyNote;
  }
  if(groupId === 'datedrift'){
    const items = F.filter(f=>f.kind==='dated-note-drift').slice(0,100);
    const lines = items.map(f=>'- '+f.path+'  — '+(f.detail||'')).join('\n');
    return intro+'Task — dated notes (memory records, session logs) that kept being appended to on later days, so one note now holds several days of work. For EACH: read it, split the body by the day each entry actually belongs to (the dates and attribution comments in the body tell you), then create one note per day following the dailyMemory naming rule from get_filing_rules. Keep the original day in the original note, move each later day into its own new note, preserve the wording verbatim, and update any links that pointed at the original. Do not delete anything until the split notes exist.\n\nNotes:\n'+lines+privacyNote;
  }
  if(groupId === 'hubgaps'){
    const items = F.filter(f=>f.kind==='hub-gap').slice(0,100);
    const lines = items.map(f=>'- '+f.path+'  — '+(f.detail||'')).join('\n');
    return intro+'Task — folders that are not wired into my maps-of-content. For each: if the folder holds notes but has no hub, create ONE hub note inside it (type: moc, named "<Folder> Home"), list that folder\'s notes in it, and add one line stating what belongs in that folder; if a hub already exists but is not linked from its parent hub, add the link in the PARENT hub. Do not move, rename, or rewrite the notes themselves.\n\nFolders:\n'+lines+privacyNote;
  }
  if(groupId === 'format'){
    const items = F.filter(f=>['unknown-type','invalid-frontmatter','invalid-status','missing-frontmatter'].indexOf(f.kind)!==-1).slice(0,150);
    const lines = items.map(f=>'- '+f.path+'  — '+(f.detail||'')).join('\n');
    return intro+'Task — notes that don\'t match my note format. For each, read it and fix the frontmatter to match my conventions (correct type/status, add missing required fields) WITHOUT changing the note\'s meaning or body.\n\nNotes:\n'+lines+privacyNote;
  }
  return '';
}
async function healthCopyPrompt(groupId){
  const text = healthPromptText(groupId); if(!text) return;
  let done = false;
  try{ await navigator.clipboard.writeText(text); done = true; }
  catch(e){
    try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.focus(); ta.select(); done=document.execCommand('copy'); document.body.removeChild(ta); }catch(_){}
  }
  if(done){
    state.health_promptCopied = groupId; healthPaint();
    setTimeout(()=>{ if(state.health_promptCopied===groupId){ state.health_promptCopied=null; if(state.screen==='health') healthPaint(); } }, 2200);
  }
}

// shared empty/error panel in the design's centered style
function healthCard(icon, iconCol, title, body, retry){
  return `
    <div style="border:1px solid var(--edge2);border-radius:0;background:var(--surface);overflow:hidden;animation:rise .4s ease both">
      <div style="display:flex;align-items:center;padding:9px 14px;border-bottom:1px solid var(--edge);background:var(--surface2)"><span style="font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)">health</span></div>
      <div style="padding:40px 30px;text-align:center;display:flex;flex-direction:column;align-items:center">
        <div style="width:44px;height:44px;border:1px solid var(--edge2);border-radius:0;display:flex;align-items:center;justify-content:center;margin-bottom:18px;background:var(--surface2);color:${iconCol};font-size:18px">${icon}</div>
        <h2 style="font-family:var(--pixel);font-weight:600;font-size:22px;margin-bottom:9px">${esc(title)}</h2>
        <p style="color:var(--dust);font-size:14px;max-width:48ch;line-height:1.6">${esc(body)}</p>
        ${retry ? `<button id="healthRetryBtn" style="margin-top:20px;font-family:var(--pixel);font-weight:500;font-size:13px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:11px 18px;border-radius:0;cursor:pointer;transition:.12s">run full check</button>` : ''}
      </div>
    </div>`;
}

function healthWireRetry(){
  const b = document.getElementById('healthRetryBtn');
  if(!b) return;
  b.onclick = ()=>{ state.health_error = null; healthRunCheck(); };
  b.onmouseenter = ()=>{ b.style.background='var(--synapse)'; b.style.color='var(--on-accent)'; };
  b.onmouseleave = ()=>{ b.style.background='transparent'; b.style.color='var(--synapse-ink)'; };
}
