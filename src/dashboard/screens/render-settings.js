// ── Settings screen (faithful port of prototype lines 624-759, now real + bilingual) ──
// Renders into #screen. Uses shared globals: state, $, $$, esc, api, post, nav,
// relTime, loadOverview, loadActivity, render. Namespaced with st_ prefix.
//
// Every control here is wired to the real local server where a real endpoint
// exists (open-folder, export, re-index, sign-out, account, update-check).
// The few preference toggles with no persistence backend yet stay honest: they
// work as live UI state and each group carries ONE subtle "UI-only for now" line.
// Never fakes a server success.

// ── i18n contract ──
// t(en, ar) returns Arabic when state.lang==='ar', else English.
// applyLang(lang) sets state.lang, flips #app dir, and re-renders the whole app.
// These are meant to be shared globals; if the host hasn't defined them yet we
// install a guarded fallback (|| never overrides a real host definition).
if (typeof window.t !== 'function') {
  window.t = function (en, ar) { return (window.state && state.lang === 'ar' && ar != null) ? ar : en; };
}
if (typeof window.applyLang !== 'function') {
  window.applyLang = function (lang) {
    state.lang = (lang === 'ar') ? 'ar' : 'en';
    var app = document.getElementById('app');
    if (app) app.setAttribute('dir', state.lang === 'ar' ? 'rtl' : 'ltr');
    if (typeof render === 'function') render();
    else if (typeof renderSettings === 'function') renderSettings();
  };
}

// settings UI state (lives on this device only for now — no persistence endpoint yet)
function st_ensureState(){
  if(!state.st_settings){
    // Only REAL controls remain. deviceOnly / privateLock / attribution / citeSources
    // / notInBrain are locked-on guarantees the engine actually enforces (rendered
    // locked, never read as mutable state). reduceMotion is the one genuinely
    // mutable, persisted preference. The old UI-only stubs (audit-log, ask-before-
    // write, prefer-recent, auto-backup schedule) were removed rather than faked.
    state.st_settings = {
      reduceMotion:(()=>{ try{ return localStorage.getItem('callosium_reduce_motion')==='1'; }catch(e){ return false; } })(), // seed from the boot-applied value
    };
  }
  if(state.lang==null) state.lang='en';
  if(state.theme==null) state.theme='dark';
  // reflect motion flag + language direction; keep the window flag, the CSS
  // data-attribute, and the persisted value all in sync with the toggle so the
  // switch matches what's actually applied — and survives a reload.
  window.__reduceMotion = !!state.st_settings.reduceMotion || st_osReduceMotion();
  const app = document.getElementById('app');
  if(app){
    app.setAttribute('dir', state.lang==='ar' ? 'rtl' : 'ltr');
    if(window.__reduceMotion) app.setAttribute('data-reduce-motion','1'); else app.removeAttribute('data-reduce-motion');
  }
  try{ localStorage.setItem('callosium_reduce_motion', state.st_settings.reduceMotion ? '1' : '0'); }catch(e){}
}

// ── shared style builders (match prototype mkT / seg exactly) ──
function st_trackStyle(on, locked){
  return 'width:40px;height:23px;border-radius:0;flex-shrink:0;position:relative;transition:.15s;background:'
    +(on?'var(--synapse)':'var(--surface2)')+';border:1px solid '+(on?'var(--synapse)':'var(--edge2)')
    +';cursor:'+(locked?'default':'pointer')+';opacity:'+(locked?'.75':'1');
}
function st_knobStyle(on){
  return 'position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;transition:.15s;background:'
    +(on?'var(--void)':'var(--faint)')+';transform:translateX('+(on?'17px':'0')+')';
}
function st_seg(active){
  return 'font-family:var(--mono);font-size:12px;padding:7px 15px;border-radius:0;cursor:pointer;transition:.12s;color:'
    +(active?'var(--on-accent)':'var(--dust)')+';background:'+(active?'var(--synapse)':'transparent');
}
// secondary (ghost) button, hover to synapse. accent: 'synapse' | 'amber' for warm actions.
function st_btnStyle(accent){
  const edge = accent==='synapse' ? 'var(--synapse)' : 'var(--edge2)';
  const col  = accent==='synapse' ? 'var(--synapse-ink)' : 'var(--dust)';
  return 'font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid '
    +edge+';color:'+col+';background:transparent;padding:8px 14px;border-radius:0;cursor:pointer;flex-shrink:0';
}

// the OS-level reduce-motion preference: combined with the in-app toggle so a
// Settings visit never clears a flag the OS asked for.
function st_osReduceMotion(){ try{ return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(e){ return false; } }

// a toggle row (locked rows show an ALWAYS ON badge and are non-interactive)
function st_toggleRow(key, label, desc, locked){
  const on = locked ? true : !!state.st_settings[key];
  const badge = locked
    ? `<span style="font-family:var(--mono);font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--acid);border:1px solid var(--edge2);border-radius:0;padding:2px 7px">${esc(t('always on','دائمًا'))}</span>`
    : '';
  const track = locked
    ? `<div style="${st_trackStyle(on,locked)}"><span style="${st_knobStyle(on)}"></span></div>`
    : `<button type="button" role="switch" aria-checked="${on?'true':'false'}" aria-label="${esc(label)}" data-st-toggle="${key}" style="${st_trackStyle(on,false)}"><span style="${st_knobStyle(on)}"></span></button>`;
  return `<div style="display:flex;align-items:center;gap:16px;padding:14px 18px;border-top:1px solid var(--surface2)">
      <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight);display:flex;align-items:center;gap:8px">${esc(label)}${badge}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px;max-width:64ch">${esc(desc)}</div></div>
      ${track}
    </div>`;
}

// a subtle "this preference is UI-only / on this device" footnote for a group
function st_uiOnlyNote(text){
  return `<div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);padding:10px 18px 12px;border-top:1px solid var(--surface2);line-height:1.6">${esc(text)}</div>`;
}

function renderSettings(){
  st_ensureState();
  const s = state.st_settings;
  const L = (en,ar)=>esc(t(en,ar));                 // escaped, translated text
  const o = state.overview || state.st_overview || {};
  const v = o.vitals || {};
  const brainName = state.st_name != null ? state.st_name : (o.brainName || t('your brain','دماغك'));
  const brainPath = o.brainPath || '~';
  const notes = (v.notes||0);
  const meaning = (v.meaningPoints||0);
  const nfmt = n => (n||0).toLocaleString('en-US');

  const panelStyle = 'background:var(--surface);border:1px solid var(--edge2);border-radius:0;overflow:hidden';
  const panelBarStyle = 'display:flex;align-items:center;gap:9px;padding:9px 14px;border-bottom:1px solid var(--edge);background:var(--surface2)';
  const panelTitleStyle = 'font-family:var(--mono);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dust)';
  const bar = (title)=>`<div style="${panelBarStyle}"><span style="${panelTitleStyle}">${title}</span></div>`;
  const rowTop = 'display:flex;align-items:center;gap:16px;padding:14px 18px;border-top:1px solid var(--surface2)';
  const rowTopN = 'display:flex;align-items:center;gap:16px;padding:14px 18px';
  const segWrap = 'display:inline-flex;gap:3px;background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:3px;flex-shrink:0';

  const reindexing = !!state.st_reindexing;
  const reindexLabel = reindexing ? (state.st_reindexPhase || t('re-indexing…','...جارٍ إعادة الفهرسة')) : t('re-index now','أعد الفهرسة الآن');
  const rebuildLabel = reindexing ? (state.st_reindexPhase || t('rebuilding…','...جارٍ إعادة البناء')) : t('rebuild','إعادة البناء');

  const langNote = state.lang==='ar'
    ? 'العربية مُختارة · تنقلب الواجهة بالكامل من اليمين إلى اليسار.'
    : 'english selected · switch to العربية for a full right-to-left interface.';

  // ── open-folder button label/state (real POST /api/open-folder) ──
  const opening = !!state.st_openingFolder;
  const openLabel = opening ? t('opening…','...جارٍ الفتح') : t('open folder','افتح المجلد');
  const openErr = state.st_openFolderErr
    ? `<div style="font-family:var(--mono);font-size:11px;color:var(--danger);padding:0 18px 12px;line-height:1.6">${esc(state.st_openFolderErr)}</div>`
    : '';

  // ── re-index failure line (rendered under BOTH the re-index and the rebuild
  // row — one run, two buttons). Without it a failed run just put the button
  // back to "re-index now", which looks identical to a run that finished.
  const reindexErr = state.st_reindexErr
    ? `<div style="font-family:var(--mono);font-size:11px;color:var(--danger);padding:0 18px 12px;line-height:1.6">${esc(state.st_reindexErr)}</div>`
    : '';

  // ── account panel (real GET /api/account + POST /api/signout) ──
  // FOUR states, not three. "the request failed" is NOT "signed out": treating
  // them as one told a signed-in user "you're not signed in" whenever the engine
  // blipped (a restarting sidecar, a wake-from-sleep, any 500) — and because the
  // panel only re-fetches while st_account is undefined, that false claim stuck
  // for the rest of the session. Same distinction the shell's loadAccount makes.
  const acct = state.st_account;   // undefined = loading · null = signed out · object = signed in
  let acctInner;
  if(state.st_accountFailed){
    acctInner = `<div style="display:flex;align-items:center;gap:14px;padding:16px 18px">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;color:var(--starlight)">${L("couldn't check your account",'تعذّر التحقق من حسابك')}</div>
          <div style="font-size:13.5px;color:var(--dust);margin-top:4px;max-width:64ch">${L('the local engine didn’t answer just now — your account and your notes are safe on disk. this says nothing about whether you’re signed in.','لم يستجب المحرّك المحلي الآن — حسابك وملاحظاتك آمنة على القرص. هذا لا يعني شيئًا عن كونك مسجّل الدخول أم لا.')}</div>
        </div>
        <button id="stAcctRetry" style="${st_btnStyle()}" onmouseenter="this.style.borderColor='var(--synapse)';this.style.color='var(--synapse)'" onmouseleave="this.style.borderColor='var(--edge2)';this.style.color='var(--dust)'">${L('try again','أعد المحاولة')}</button>
      </div>${state.st_accountErr?`<div style="font-family:var(--mono);font-size:11px;color:var(--danger);padding:0 18px 12px;line-height:1.6">${esc(state.st_accountErr)}</div>`:''}`;
  } else if(acct===undefined){
    acctInner = `<div style="padding:16px 18px;font-family:var(--mono);font-size:12px;color:var(--faint)">${L('checking your account…','...جارٍ التحقق من حسابك')}</div>`;
  } else if(!acct){
    acctInner = `<div style="padding:16px 18px">
        <div style="font-size:14px;color:var(--starlight)">${L("you're not signed in",'لم تسجّل الدخول')}</div>
        <div style="font-size:13.5px;color:var(--dust);margin-top:4px;max-width:64ch">${L('sign in from the welcome screen to link a free account — it lives only on this device.','سجّل الدخول من شاشة الترحيب لربط حساب مجاني — يعيش على هذا الجهاز فقط.')}</div>
      </div>`;
  } else {
    const nm = String(acct.name||'You');
    const initial = esc((nm.trim()[0]||'Y').toUpperCase());
    const signingOut = !!state.st_signingOut;
    const outLabel = signingOut ? t('signing out…','...جارٍ تسجيل الخروج') : t('sign out','تسجيل الخروج');
    const when = acct.createdAt ? relTime(Date.parse(acct.createdAt)) : '';
    const sub = acct.email ? esc(acct.email) : L('via ','عبر ')+esc(acct.provider||'guest');
    acctInner = `<div style="display:flex;align-items:center;gap:14px;padding:16px 18px">
        <div style="width:40px;height:40px;border-radius:0;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-family:var(--pixel);font-weight:700;font-size:18px;color:var(--on-accent);background:var(--synapse)">${initial}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--grot);font-weight:600;font-size:15px;color:var(--starlight);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nm)}</div>
          <div style="font-family:var(--mono);font-size:11.5px;color:var(--dust);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sub}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
          <span style="font-family:var(--mono);font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:var(--acid);border:1px solid var(--edge2);border-radius:0;padding:2px 8px">${L('free plan','الخطة المجانية')}</span>
          <button id="stSignOut"${signingOut?' disabled':''} style="${st_btnStyle()};opacity:${signingOut?'.6':'1'};cursor:${signingOut?'default':'pointer'}">${esc(outLabel)}</button>
        </div>
      </div>
      <div style="font-family:var(--mono);font-size:11.5px;color:var(--faint);padding:0 18px 12px;line-height:1.6">${when?L('signed in ','سجّلت الدخول ')+esc(when)+' · ':''}${L('this account lives on this device only.','هذا الحساب يعيش على هذا الجهاز فقط.')}</div>${state.st_signOutErr?`<div style="font-family:var(--mono);font-size:11px;color:var(--danger);padding:0 18px 12px;line-height:1.6">${esc(state.st_signOutErr)}</div>`:''}`;
  }

  // ── update / version (real GET /api/update/check, cached in state.st_update) ──
  const upd = state.st_update;
  const checking = !!state.st_updChecking;
  const verNum = upd && upd.current ? upd.current : '';
  const checkLabel = checking ? t('checking…','...جارٍ التحقق') : t('check for updates','تحقّق من التحديثات');
  let updStatus = '', showUpdateBtn = false;
  if(checking){ updStatus = t('checking for updates…','...جارٍ التحقق من التحديثات'); }
  else if(!upd){ updStatus = ''; }
  else if(upd.offline){ updStatus = t("couldn't reach updates · you're offline",'تعذّر الوصول إلى التحديثات · أنت دون اتصال'); }
  else if(upd.updateAvailable){ updStatus = t('update available: v'+(upd.latest||'?'),'يتوفّر تحديث: v'+(upd.latest||'؟')); showUpdateBtn = true; }
  else if(upd.current){ updStatus = t("you're up to date (v"+upd.current+')','أنت على أحدث إصدار (v'+upd.current+')'); }
  const updStatusColor = showUpdateBtn ? 'var(--amber)' : (upd && upd.offline ? 'var(--faint)' : 'var(--acid)');

  $('#screen').innerHTML = `
    <div style="max-width:760px;margin:0 auto;animation:rise .4s ease both">
      <div style="margin-bottom:20px">
        <h1 style="font-family:var(--pixel);font-weight:700;font-size:42px;letter-spacing:.01em;line-height:1.02">${L('settings','الإعدادات')}</h1>
        <div style="font-family:var(--mono);font-size:13px;color:var(--faint);margin-top:10px">${L('every preference here is stored on this device','كل تفضيل هنا محفوظ على هذا الجهاز')}</div>
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('your brain','دماغك'))}
        <div class="st-row" style="${rowTopN}">
          <div style="flex:1;min-width:0"><label for="stBrainName" style="display:block;font-size:14px;color:var(--starlight)">${L('brain name','اسم الدماغ')}</label><div style="font-size:13.5px;color:var(--dust);margin-top:3px">${L('shows in the top bar and when an AI refers to your memory.','يظهر في الشريط العلوي وعندما يشير أي ذكاء اصطناعي إلى ذاكرتك.')}</div></div>
          <input id="stBrainName" value="${esc(brainName)}" style="background:var(--void);border:1px solid var(--edge2);border-radius:0;padding:9px 12px;font-family:var(--mono);font-size:13px;color:var(--starlight);width:240px;flex-shrink:0" onfocus="this.style.borderColor='var(--synapse)';this.style.outline='none'" onblur="this.style.borderColor='var(--edge2)'">
        </div>
        <div class="st-row" style="${rowTop}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('location on disk','الموقع على القرص')}</div><div style="font-family:var(--mono);font-size:12px;color:var(--dust);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" dir="ltr">${esc(brainPath)}</div></div>
          <button id="stOpenFolder"${opening?' disabled':''} style="${st_btnStyle()};opacity:${opening?'.6':'1'};cursor:${opening?'default':'pointer'}" ${opening?'':`onmouseenter="this.style.borderColor='var(--synapse)';this.style.color='var(--synapse)'" onmouseleave="this.style.borderColor='var(--edge2)';this.style.color='var(--dust)'"`}>${esc(openLabel)}</button>
        </div>
        ${openErr}
        <div class="st-row" style="${rowTop}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('storage','التخزين')}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px">${meaning?esc(nfmt(meaning))+' '+L('meaning points · on this device','نقطة معنى · على هذا الجهاز'):L('on this device','على هذا الجهاز')}</div></div>
          <span style="font-family:var(--grot);font-weight:700;font-size:15px;color:var(--starlight);flex-shrink:0">${esc(nfmt(notes))} ${L('notes','ملاحظة')}</span>
        </div>
        <div class="st-row" style="${rowTop}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('re-index','إعادة الفهرسة')}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px">${L('re-read your files and refresh connections.','إعادة قراءة ملفاتك وتحديث الروابط.')}</div></div>
          <button id="stReindexBtn"${reindexing?' disabled':''} style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--synapse);color:var(--synapse-ink);background:transparent;padding:8px 14px;border-radius:0;cursor:${reindexing?'default':'pointer'};opacity:${reindexing?'.6':'1'};flex-shrink:0" ${reindexing?'':`onmouseenter="this.style.background='var(--synapse)';this.style.color='var(--on-accent)'" onmouseleave="this.style.background='transparent';this.style.color='var(--synapse-ink)'"`}>${esc(reindexLabel)}</button>
        </div>
        ${reindexErr}
        ${st_uiOnlyNote(t('editing the name updates the top bar live, but there is no name-save endpoint yet — so it resets on reload.','تعديل الاسم يحدّث الشريط العلوي مباشرةً، لكن لا يوجد بعد مسار لحفظ الاسم — لذا يعود كما كان عند إعادة التحميل.'))}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('your account','حسابك'))}
        ${acctInner}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('privacy & safety','الخصوصية والأمان'))}
        ${st_toggleRow('deviceOnly',t('everything stays on this device','كل شيء يبقى على هذا الجهاز'),t('your notes never touch the cloud — no account, no sync, no upload.','ملاحظاتك لا تلمس السحابة أبدًا — بلا حساب، بلا مزامنة، بلا رفع.'),true)}
        ${st_toggleRow('privateLock',t('Private is off for every AI by default','الخاص مُطفأ لكل ذكاء اصطناعي افتراضيًا'),t('no AI can open your Private folder unless you grant it to that specific AI in Agents.','لا يمكن لأي ذكاء اصطناعي فتح مجلد الخاص إلا إذا منحته لذلك الذكاء تحديدًا في «الوكلاء».'),true)}
        ${st_toggleRow('attribution',t('every AI edit is signed','كل تعديل من ذكاء اصطناعي موقّع'),t('each note an AI writes is stamped with its name — you always see human vs. AI, and no AI can forge your signature.','كل ملاحظة يكتبها ذكاء اصطناعي تُختم باسمه — ترى دائمًا الإنسان مقابل الذكاء الاصطناعي، ولا يمكن لأي ذكاء تزوير توقيعك.'),true)}
        ${st_uiOnlyNote(t('what each AI may read or write is set per-agent in Agents — permission is structural, not a global switch. Private stays off there until you grant it.','ما يمكن لكل ذكاء اصطناعي قراءته أو كتابته يُضبط لكل وكيل في «الوكلاء» — الإذن بنيوي وليس مفتاحًا عامًا. ويبقى الخاص مُطفأً هناك حتى تمنحه.'))}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('how it answers','كيف يجيب'))}
        ${st_toggleRow('citeSources',t('always show sources','أظهر المصادر دائمًا'),t('every answer carries the exact notes it came from — the engine tags them on every recall, for any AI.','كل إجابة تحمل الملاحظات التي جاءت منها بالضبط — يوسمها المحرّك في كل استرجاع، لأي ذكاء اصطناعي.'),true)}
        ${st_toggleRow('notInBrain',t('never invent an answer','لا يختلق إجابة أبدًا'),t('if it isn’t in your notes, the engine says so — honesty is built in, not a setting.','إن لم تكن في ملاحظاتك، يقولها المحرّك — الصدق مبني في النظام وليس إعدادًا.'),true)}
        ${st_uiOnlyNote(t('sources + honesty are guaranteed by the engine on every recall — not switches you can turn off.','المصادر والصدق مضمونان من المحرّك في كل استرجاع — وليسا مفتاحين يمكن إطفاؤهما.'))}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('appearance','المظهر'))}
        <div class="st-row" style="${rowTopN}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('theme','السمة')}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px">${L('dark is primary; light is a bright, calmer courtesy mode.','الداكنة هي الأساس؛ الفاتحة وضع مضيء وأهدأ للمجاملة.')}</div></div>
          <div style="${segWrap}" role="group" aria-label="${L('theme','السمة')}"><button type="button" data-st-theme="dark" aria-pressed="${state.theme==='dark'}" style="${st_seg(state.theme==='dark')};border:0">${L('dark','داكنة')}</button><button type="button" data-st-theme="light" aria-pressed="${state.theme==='light'}" style="${st_seg(state.theme==='light')};border:0">${L('light','فاتحة')}</button></div>
        </div>
        ${st_toggleRow('reduceMotion',t('reduce motion','تقليل الحركة'),t('calm the living background and animations across the app.','هدّئ الخلفية الحيّة والحركات في كل أنحاء التطبيق.'),false)}
        ${st_uiOnlyNote(t('theme applies instantly everywhere · reduce-motion is remembered on this device.','السمة تُطبَّق فورًا في كل مكان · وتقليل الحركة محفوظ على هذا الجهاز.'))}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('language','اللغة'))}
        <div class="st-row" style="${rowTopN}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('interface language','لغة الواجهة')}</div><div id="stLangNote" style="font-size:13.5px;color:var(--dust);margin-top:3px;max-width:60ch">${esc(langNote)}</div></div>
          <div style="${segWrap}" role="group" aria-label="${L('interface language','لغة الواجهة')}"><button type="button" data-st-lang="en" aria-pressed="${state.lang==='en'}" style="${st_seg(state.lang==='en')};border:0">English</button><button type="button" data-st-lang="ar" aria-pressed="${state.lang==='ar'}" style="${st_seg(state.lang==='ar')};border:0">العربية</button></div>
        </div>
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('backups','النسخ الاحتياطية'))}
        <div class="st-row" style="${rowTopN}">
          <div style="flex:1;min-width:0"><div style="font-size:14.5px;color:var(--starlight)">${L('export my brain','صدّر دماغك')}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px;max-width:60ch">${state.st_exporting?L('zipping your whole brain — a large brain can take a minute. your download will start on its own.','نضغط دماغك بالكامل — قد يستغرق دقيقة للدماغ الكبير. سيبدأ التنزيل تلقائيًا.'):L('download a full copy — every note, zipped, straight to your computer.','نزّل نسخة كاملة — كل ملاحظة، مضغوطة، مباشرةً إلى حاسوبك.')}</div></div>
          <button id="stExport"${state.st_exporting?' disabled':''} style="${st_btnStyle()};opacity:${state.st_exporting?'.6':'1'};cursor:${state.st_exporting?'default':'pointer'}" ${state.st_exporting?'':`onmouseenter="this.style.borderColor='var(--synapse)';this.style.color='var(--synapse)'" onmouseleave="this.style.borderColor='var(--edge2)';this.style.color='var(--dust)'"`}>${state.st_exporting?L('preparing…','...جارٍ التحضير'):L('export','تصدير')}</button>
        </div>
        ${state.st_exportErr?`<div style="font-family:var(--mono);font-size:11.5px;color:var(--danger);padding:0 18px 12px;line-height:1.6">${esc(state.st_exportErr)}</div>`:''}
        ${st_uiOnlyNote(t('your notes are plain files on disk — export downloads a full zip of every one, straight to your computer, anytime.','ملاحظاتك ملفات عادية على القرص — يُنزّل التصدير نسخة مضغوطة كاملة من كلٍّ منها إلى حاسوبك في أي وقت.'))}
      </div>

      <div style="${panelStyle};margin-bottom:14px">
        ${bar(L('about','حول'))}
        <div class="st-row" style="${rowTopN}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('version','الإصدار')}</div><div style="font-family:var(--mono);font-size:12px;color:var(--dust);margin-top:3px">Callosium ${verNum?'v'+esc(verNum):''} · ${L('local-first','محلي أولًا')}</div>${updStatus?`<div style="font-family:var(--mono);font-size:11px;color:${updStatusColor};margin-top:5px">${esc(updStatus)}</div>`:''}</div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            ${showUpdateBtn?`<button id="stUpdateBtn" style="font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;border:1px solid var(--amber);color:var(--amber);background:transparent;padding:8px 14px;border-radius:0;cursor:pointer" onmouseenter="this.style.background='var(--amber)';this.style.color='var(--on-accent)'" onmouseleave="this.style.background='transparent';this.style.color='var(--amber)'">${L('update','تحديث')}</button>`:''}
            <button id="stCheckUpdates"${checking?' disabled':''} style="${st_btnStyle()};opacity:${checking?'.6':'1'};cursor:${checking?'default':'pointer'}" ${checking?'':`onmouseenter="this.style.borderColor='var(--synapse)';this.style.color='var(--synapse)'" onmouseleave="this.style.borderColor='var(--edge2)';this.style.color='var(--dust)'"`}>${esc(checkLabel)}</button>
          </div>
        </div>
        <div class="st-row" style="${rowTop}">
          <div style="flex:1;min-width:0"><div style="font-size:14px;color:var(--starlight)">${L('rebuild index from scratch','أعد بناء الفهرس من الصفر')}</div><div style="font-size:13.5px;color:var(--dust);margin-top:3px">${L('fixes rare glitches. never touches your notes.','يعالج أعطالًا نادرة. لا يمسّ ملاحظاتك أبدًا.')}</div></div>
          <button id="stRebuildBtn"${reindexing?' disabled':''} style="${st_btnStyle()};opacity:${reindexing?'.6':'1'};cursor:${reindexing?'default':'pointer'}" ${reindexing?'':`onmouseenter="this.style.borderColor='var(--amber)';this.style.color='var(--amber)'" onmouseleave="this.style.borderColor='var(--edge2)';this.style.color='var(--dust)'"`}>${esc(rebuildLabel)}</button>
        </div>
        ${reindexErr}
        ${st_uiOnlyNote(t('the desktop app updates itself automatically (via Tauri) — this just checks GitHub for the latest version.','يحدّث تطبيق سطح المكتب نفسه تلقائيًا (عبر Tauri) — هذا يتحقق فقط من GitHub لأحدث إصدار.'))}
      </div>

      <div style="font-family:var(--mono);font-size:11px;color:var(--faint);text-align:center;padding:8px 0 12px;line-height:1.7">${L('Callosium is local-first. your notes are just files —','كالوسيوم محلي أولًا. ملاحظاتك مجرد ملفات —')}<br>${L('delete the app anytime and keep everything.','احذف التطبيق في أي وقت واحتفظ بكل شيء.')}</div>
    </div>`;

  st_wire();

  // ── non-blocking data fetches (once each) ──
  // st_accountFailed keeps st_account undefined without re-firing the fetch on
  // every repaint — the retry button is the way back out.
  if(state.st_account===undefined && !state.st_accountLoading && !state.st_accountFailed) st_loadAccount();
  if(state.st_update===undefined && !state.st_updChecking) st_checkUpdates();
}

function st_wire(){
  // brain name — live-updates top bar (#brainName); no persistence endpoint yet
  const nameInput = $('#stBrainName');
  if(nameInput) nameInput.addEventListener('input', e=>{
    const val = e.target.value;
    state.st_name = val;
    const top = $('#brainName');
    if(top) top.textContent = val.trim() || t('your brain','دماغك');
  });

  // toggles (locked rows have no data-st-toggle, so they're inert)
  $$('[data-st-toggle]').forEach(el=>el.addEventListener('click',()=>{
    const key = el.getAttribute('data-st-toggle');
    state.st_settings[key] = !state.st_settings[key];
    if(key==='reduceMotion'){
      const on = !!state.st_settings[key] || st_osReduceMotion();
      window.__reduceMotion = on;
      // persist (the copy promises "remembered on this device") + drive the CSS
      try{ localStorage.setItem('callosium_reduce_motion', state.st_settings[key]?'1':'0'); }catch(e){}
      const app = document.getElementById('app');
      if(on) app.setAttribute('data-reduce-motion','1'); else app.removeAttribute('data-reduce-motion');
      announce(state.st_settings[key] ? 'reduce motion on' : 'reduce motion off');
    }
    renderSettings();
  }));

  // theme segmented — drives the whole app (matches top-bar theme toggle), persisted
  $$('[data-st-theme]').forEach(el=>el.addEventListener('click',()=>{
    state.theme = el.getAttribute('data-st-theme');
    $('#app').setAttribute('data-theme', state.theme);
    try{ localStorage.setItem('callosium_theme', state.theme); }catch(e){}
    announce('theme: '+state.theme);
    renderSettings();
  }));

  // language segmented — shared applyLang: sets state.lang, flips #app dir, re-renders
  $$('[data-st-lang]').forEach(el=>el.addEventListener('click',()=>{
    applyLang(el.getAttribute('data-st-lang'));
  }));

  // re-index now + rebuild — real SSE on /api/ingest (same engine as top-bar re-index)
  const rb = $('#stReindexBtn'); if(rb) rb.addEventListener('click', ()=>st_reindex(false));
  const rbld = $('#stRebuildBtn'); if(rbld) rbld.addEventListener('click', ()=>st_reindex(true));

  // open folder — real POST /api/open-folder (opens the brain in the OS file explorer)
  const of = $('#stOpenFolder'); if(of) of.addEventListener('click', st_openFolder);

  // export — real download of the .zip. The old hidden-iframe form POST had no
  // reliable "download started" signal (the iframe 'load' never fires for an
  // attachment response), so the button hung on "preparing…" and errors were
  // swallowed. We fetch the archive as a blob and save it via a temp <a download>:
  // the promise resolves exactly when the zip is in hand, so completion, failure,
  // and the JSON "no files"/error cases are all handled honestly. A personal brain
  // zips to a few MB–tens of MB; the server still streams so it's not the memory
  // hazard a huge multi-GB vault would be — that edge falls back to "open folder".
  const ex = $('#stExport'); if(ex) ex.addEventListener('click', async ()=>{
    if(state.st_exporting) return;
    state.st_exporting = true; state.st_exportErr = null;
    if(state.screen==='settings') renderSettings();          // button → "preparing…"
    try{
      const r = await fetch('/api/export', { method:'POST', headers:{'x-callosium-token':CCT} });
      const ct = r.headers.get('content-type') || '';
      if(!r.ok || ct.indexOf('application/json') !== -1){
        // server sent a friendly JSON error (empty brain, zip failure, …)
        let msg = t('export failed — try “open folder” and copy your brain yourself.','فشل التصدير — جرّب «افتح المجلد» وانسخ دماغك بنفسك.');
        try{ const j = await r.json(); if(j && j.error) msg = j.error; }catch(_){}
        state.st_exportErr = msg;
      } else {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'callosium-brain.zip';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch(_){} }, 8000);
      }
    }catch(e){
      state.st_exportErr = t('export failed — the local engine didn’t respond. try “open folder” and copy your brain yourself.','فشل التصدير — لم يستجب المحرّك المحلي. جرّب «افتح المجلد» وانسخ دماغك بنفسك.');
    }finally{
      state.st_exporting = false;
      if(state.screen==='settings') renderSettings();
    }
  });

  // sign out — real POST /api/signout, then reload so onboarding shows again
  const so = $('#stSignOut'); if(so) so.addEventListener('click', st_signOut);

  // retry the account fetch after an engine blip (clears the failed flag so the
  // auto-fetch guard in renderSettings lets it through again)
  const ar = $('#stAcctRetry'); if(ar) ar.addEventListener('click', ()=>{ state.st_accountFailed = false; state.st_accountErr = null; renderSettings(); });

  // check for updates — real GET /api/update/check
  const cu = $('#stCheckUpdates'); if(cu) cu.addEventListener('click', st_checkUpdates);

  // update — the packaged app self-updates via Tauri; for now open GitHub releases
  const up = $('#stUpdateBtn'); if(up) up.addEventListener('click', ()=>{ window.open('https://github.com/callosium/callosium/releases','_blank','noopener'); });
}

// Called from nav() when Settings unmounts. It used to close a live re-index
// stream — but closing the EventSource trips the server's req.on('close') abort,
// and the next `if (aborted) return` bails out BEFORE setBrain() and writeMap().
// So clicking any nav item mid-rebuild threw the whole run away: every second of
// scan/graph/embed work spent, the in-memory caches never reset, System/Map.md
// never regenerated — and nothing said so, because "aborted" and "finished" both
// just put the button back. The top-bar re-index (the SAME run) has always
// survived navigation; there is no reason the Settings copy should not.
// Leave a live run alone: every handler below is unmount-safe already (each DOM
// write is `if(el)`-guarded and the repaint is screen-gated), so the stream can
// finish with Settings off-screen and be found still running on return.
window.st_teardown = function(){
  if(state.st_reindexES) return;
  state.st_reindexing = false;
  state.st_reindexPhase = null;
};

// ── real re-index via EventSource('/api/ingest'); reflects progress, reloads on done ──
function st_reindex(full){
  if(state.st_reindexing) return;
  state.st_reindexing = true;
  state.st_reindexPhase = t('starting…','...جارٍ البدء');
  state.st_reindexErr = null;             // a new run clears the previous failure
  renderSettings();
  // 'rebuild from scratch' passes full=1 so the request is distinct from a plain
  // re-index — today the engine does a full re-scan either way (both honestly
  // rebuild), but the flag is here for when an incremental mode is added.
  const es = new EventSource(CCT_Q('/api/ingest' + (full ? '?full=1' : '')));
  state.st_reindexES = es; // so nav-away can close it (see st_teardown)
  const setPhase = label=>{
    state.st_reindexPhase = label;
    const a = $('#stReindexBtn'); if(a) a.textContent = label;
    const b = $('#stRebuildBtn'); if(b) b.textContent = label;
    announce(label);
  };
  const done = async (reload, err)=>{
    es.close();
    state.st_reindexES = null;
    state.st_reindexing = false;
    state.st_reindexPhase = null;
    state.st_reindexErr = reload ? null : (err || t("re-index didn’t finish — the local engine stopped the run.",'لم تكتمل إعادة الفهرسة — أوقف المحرّك المحلي العملية.'));
    announce(reload ? 'index updated' : 're-index failed');
    if(reload){
      try{ await loadOverview(); await loadActivity(); }catch(_){}
      state.st_overview = state.overview;   // refresh cached name/path/storage for this screen
    }
    if(state.screen==='settings') renderSettings();
  };
  es.addEventListener('phase', e=>{ try{ const d=JSON.parse(e.data); if(d&&d.label) setPhase(d.label+'…'); }catch(_){} });
  es.addEventListener('done', ()=>done(true));
  // The stream reports failure two ways and both were being thrown away: a
  // server-sent `event: error` carries the real reason in e.data (the single-
  // ingest guard's "an import is already running", a permitted-folder refusal, a
  // scan throw), and a transport drop carries nothing. announce() alone put it in
  // the hidden live region only — on screen the button just went back to
  // "re-index now", which is exactly what SUCCESS looks like. Surface it inline,
  // the way every other action on this screen already does.
  es.addEventListener('error', e=>{
    let msg = null;
    try{ const d = JSON.parse(e && e.data); if(d && d.message) msg = String(d.message); }catch(_){}
    done(false, msg);
  });
}

// ── real open-folder (POST /api/open-folder → opens the OS file explorer) ──
async function st_openFolder(){
  if(state.st_openingFolder) return;
  state.st_openingFolder = true;
  state.st_openFolderErr = null;
  renderSettings();                       // shows "opening…"
  try{
    const r = await post('/api/open-folder', {});
    if(r && r.error) state.st_openFolderErr = r.error;   // never fake success — surface the real error
  }catch(_){
    state.st_openFolderErr = t("couldn't reach the local app to open the folder.",'تعذّر الوصول إلى التطبيق المحلي لفتح المجلد.');
  }
  state.st_openingFolder = false;
  if(state.screen==='settings') renderSettings();         // revert + show any inline error
}

// ── real sign-out (POST /api/signout → clears the local account, then reload) ──
async function st_signOut(){
  if(state.st_signingOut) return;
  state.st_signingOut = true;
  state.st_signOutErr = null;
  renderSettings();                       // shows "signing out…"
  try{
    const r = await post('/api/signout', {});
    // only reload on CONFIRMED success — mirror st_openFolder: never fake it. A
    // silent reload on failure would drop the user back on the signed-in screen
    // with no explanation.
    if(r && r.error){ state.st_signOutErr = r.error; state.st_signingOut = false; if(state.screen==='settings') renderSettings(); return; }
  }catch(_){
    state.st_signOutErr = t("couldn't reach the local app to sign out.", 'تعذّر الوصول إلى التطبيق المحلي لتسجيل الخروج.');
    state.st_signingOut = false;
    if(state.screen==='settings') renderSettings();
    return;
  }
  location.reload();                       // onboarding reappears on next boot
}

// ── real account fetch (GET /api/account) ──
// api() resolves on every status, so a 500 body used to read as "no account" and
// this wrote null — the sentinel for signed OUT. Check .httpStatus first (same
// test the shell's loadAccount uses) and record the failure separately: a
// request that didn't land tells us nothing about whether the user is signed in,
// and the panel must not assert either way.
async function st_loadAccount(){
  if(state.st_accountLoading) return;
  state.st_accountLoading = true;
  state.st_accountFailed = false;
  state.st_accountErr = null;
  try{
    const r = await api('/api/account');
    if(r && r.httpStatus){ state.st_accountFailed = true; state.st_accountErr = r.error; }
    else state.st_account = (r && 'account' in r) ? r.account : null;
  }catch(_){
    state.st_accountFailed = true;
    state.st_accountErr = t("couldn't reach the local app.",'تعذّر الوصول إلى التطبيق المحلي.');
  }
  state.st_accountLoading = false;
  if(state.screen==='settings') renderSettings();
}

// ── real update check (GET /api/update/check), cached in state.st_update.
// Runs once automatically on open (non-blocking) and on every manual click. ──
async function st_checkUpdates(){
  if(state.st_updChecking) return;
  state.st_updChecking = true;
  renderSettings();                       // shows "checking…"
  try{
    state.st_update = await api('/api/update/check');
    try{ localStorage.setItem('callosium_last_update_check', String(Date.now())); }catch(_){}
    // keep the nav badge in sync with the freshest result
    state.updateBadge = !!(state.st_update && state.st_update.updateAvailable);
    if(typeof renderNav==='function') renderNav();
  }catch(_){
    state.st_update = { current:(state.st_update&&state.st_update.current)||null, offline:true };
  }
  state.st_updChecking = false;
  if(state.screen==='settings') renderSettings();
}
