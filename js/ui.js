/* ===================== v2 additions ===================== */
(function(){
  const PK='sss_ui_prefs';
  const DEF={theme:'light',accent:'gemini',discount:true,billtype:true,warranty:true,taxincl:true,venus:true,excel:true,pinLock:true,font:'normal',dashboard:true,autofill:true,filters:true,lastBackup:0};
  let prefs=Object.assign({},DEF);
  try{ prefs=Object.assign({},DEF,JSON.parse(localStorage.getItem(PK)||'{}')); }catch(e){}
  if(prefs.uiv!==2){ prefs.accent='gemini'; prefs.uiv=2; try{ localStorage.setItem(PK,JSON.stringify(prefs)); }catch(e){} }
  function savePrefs(){ try{ localStorage.setItem(PK,JSON.stringify(prefs)); }catch(e){} }
  window.prefOn=function(k){ return !!prefs[k]; };
  const $=id=>document.getElementById(id);
  const mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;

  function applyPrefs(){
    const dark=prefs.theme==='dark'||(prefs.theme==='auto'&&mq&&mq.matches);
    document.documentElement.classList.toggle('dark',!!dark);
    document.documentElement.classList.toggle('fs-lg',prefs.font==='large');
    document.documentElement.setAttribute('data-accent',prefs.accent||'gemini');
    ['discount','billtype','warranty','taxincl','venus','excel'].forEach(k=>document.documentElement.classList.toggle('off-'+k,prefs[k]===false));
    document.documentElement.classList.toggle('nopin',prefs.pinLock===false);
    $('dashCard').style.display=prefs.dashboard?'':'none';
    $('histAdv').style.display=prefs.filters?'':'none';
    if(prefs.autofill) $('buyerMobile').setAttribute('list','custList'); else $('buyerMobile').removeAttribute('list');
  }
  if(mq&&mq.addEventListener) mq.addEventListener('change',applyPrefs);

  /* ---- Settings controls ---- */
  function bindPrefs(){
    $('prefTheme').value=prefs.theme; $('prefFont').value=prefs.font;
    [['prefDashboard','dashboard'],['prefAutofill','autofill'],['prefFilters','filters'],['prefBilltype','billtype'],['prefDiscount','discount'],['prefWarranty','warranty'],['prefTaxincl','taxincl'],['prefVenus','venus'],['prefExcel','excel']]
      .forEach(([id,k])=>{ $(id).checked=!!prefs[k]; $(id).addEventListener('change',()=>{ prefs[k]=$(id).checked; savePrefs(); applyPrefs(); renderHistory(); }); });
    $('prefAccent').value=prefs.accent||'gemini';
    $('prefAccent').addEventListener('change',()=>{ prefs.accent=$('prefAccent').value; savePrefs(); applyPrefs(); });
    $('prefPinLock').checked=prefs.pinLock!==false;
    $('prefPinLock').addEventListener('change',()=>{
      if(!$('prefPinLock').checked){
        const entered=prompt('Enter the current 4-digit App Lock code to turn the lock off');
        if(entered===null){ $('prefPinLock').checked=true; return; }
        checkPin(entered.trim()).then(ok=>{ if(!ok){ $('prefPinLock').checked=true; toast('Wrong code — App Lock stays on'); return; } prefs.pinLock=false; savePrefs(); applyPrefs(); });
        return;
      }
      prefs.pinLock=$('prefPinLock').checked; savePrefs(); applyPrefs();
    });
    $('prefTheme').addEventListener('change',()=>{ prefs.theme=$('prefTheme').value; savePrefs(); applyPrefs(); });
    $('prefFont').addEventListener('change',()=>{ prefs.font=$('prefFont').value; savePrefs(); applyPrefs(); });
  }

  /* ---- Customer auto-fill (by mobile number, built from saved bills) ---- */
  const dl=document.createElement('datalist'); dl.id='custList'; document.body.appendChild(dl);
  const last10=v=>String(v||'').replace(/\D/g,'').slice(-10);
  function customerMap(){
    const m=new Map();
    invoices.forEach(inv=>{
      const b=inv&&inv.buyer; if(!b) return;
      if(String(b.mobile||'').replace(/\D/g,'').length<10) return;
      const k=last10(b.mobile), t=Number(inv.id)||0, cur=m.get(k);
      if(!cur||t>cur.t) m.set(k,{t,b});
    });
    return m;
  }
  function refreshCustList(){
    dl.innerHTML=Array.from(customerMap().entries()).sort((a,b)=>b[1].t-a[1].t).slice(0,300)
      .map(([k,c])=>'<option value="'+esc(k)+'" label="'+esc(c.b.name||'')+'"></option>').join('');
  }
  let lastAuto={};
  function fillCustomer(){
    if(!prefs.autofill) return;
    if($('buyerMobile').value.replace(/\D/g,'').length<10) return;
    const c=customerMap().get(last10($('buyerMobile').value)); if(!c) return;
    let n=0;
    [['buyerName','name'],['buyerAddress','address'],['buyerGstin','gstin'],['buyerState','stateCode']].forEach(([id,key])=>{
      const el=$(id), v=c.b[key]; if(!el||!v) return;
      const cur=el.value.trim();
      if(!cur||cur===lastAuto[id]||(id==='buyerState'&&cur==='06')){ if(cur!==v){ el.value=v; n++; } lastAuto[id]=v; }
    });
    if(n) toast('Customer details filled');
  }
  $('buyerMobile').addEventListener('focus',refreshCustList);
  ['input','change','blur'].forEach(ev=>$('buyerMobile').addEventListener(ev,fillCustomer));

  /* ---- One search box: tap many parts, each is added to the bill ---- */
  const isearch=$('itemSearch'), ires=$('itemSearchResults');
  function renderItemResults(){
    const q=isearch.value.trim();
    if(!q){ ires.innerHTML=''; return; }
    const matches=PARTS_CACHE.filter(p=>matchesQuery(p.code+' '+p.desc,q)).slice(0,30);
    const added={}; let n=0;
    currentItems.forEach(it=>{ if(it.code){ added[it.code]=(added[it.code]||0)+(+it.qty||0); n++; } });
    ires.innerHTML='<div class="ms-list"><div class="ms-head"><span>'+matches.length+' found · tap to add</span><button type="button" class="ms-done" id="itemSearchDone">Done'+(n?' ('+n+' added)':'')+'</button></div>'+
      (matches.length?matches.map(m=>'<div class="ms-item'+(added[m.code]?' on':'')+'" data-code="'+esc(m.code)+'"><div><span class="mono ms-code">'+esc(m.code)+'</span> '+esc(m.desc)+'<div class="ms-price">₹'+fmt(customerLandingPrice(m.cbasic))+'</div></div><span class="ms-tick">'+(added[m.code]?'✓ ×'+added[m.code]:'＋')+'</span></div>').join(''):'<div class="ms-empty">No parts match</div>')+'</div>';
  }
  function addPartToInvoice(code){
    const p=findPart(code); if(!p) return;
    const ex=currentItems.find(it=>it.code===p.code);
    if(ex){ ex.qty=(+ex.qty||0)+1; }
    else{
      const item={code:p.code,desc:p.desc,hsn:p.hsn,qty:1,rate:round2(customerLandingPrice(p.cbasic)),manual:false,taxIncl:false};
      const blank=currentItems.findIndex(it=>!it.code&&!it.desc);
      if(blank>-1) currentItems[blank]=item; else currentItems.push(item);
    }
    renderItems(); renderItemResults();
  }
  isearch.addEventListener('input',renderItemResults);
  ires.addEventListener('click',e=>{
    if(e.target.closest('#itemSearchDone')){ ires.innerHTML=''; isearch.value=''; return; }
    const row=e.target.closest('.ms-item'); if(row) addPartToInvoice(row.dataset.code);
  });
  document.addEventListener('click',e=>{ if(e.target.isConnected && !e.target.closest('.multi-search')) ires.innerHTML=''; });

  /* ---- History advanced filters ---- */
  window.getHistFilters=function(){
    if(!prefs.filters) return null;
    const from=$('hfFrom').value, to=$('hfTo').value, mn=parseFloat($('hfMin').value), mx=parseFloat($('hfMax').value);
    if(!from&&!to&&isNaN(mn)&&isNaN(mx)) return null;
    return {from,to,test:function(inv){
      const d=inv.date||''; if(from&&d<from) return false; if(to&&d>to) return false;
      const a=(inv.totals&&inv.totals.rounded)||0; if(!isNaN(mn)&&a<mn) return false; if(!isNaN(mx)&&a>mx) return false; return true; }};
  };
  ['hfFrom','hfTo','hfMin','hfMax'].forEach(id=>$(id).addEventListener('input',()=>renderHistory()));
  $('hfClear').addEventListener('click',()=>{ ['hfFrom','hfTo','hfMin','hfMax'].forEach(id=>$(id).value=''); renderHistory(); });

  /* ---- Dashboard ---- */
  function fyStart(dateStr){ const y=+dateStr.slice(0,4), m=+dateStr.slice(5,7); return m>=4?y:y-1; }
  function renderDash(){
    const box=$('dashCard'); if(!box||!prefs.dashboard) return;
    const today=localTodayISO(), ym=localCurrentYm(), fy=fyStart(today);
    const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-1);
    const lastYm=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    let t={a:0,n:0}, m={a:0,n:0}, f={a:0,n:0}, lm=0; const cust={};
    invoices.forEach(inv=>{
      const dt=inv.date||''; if(dt.length<10) return; const a=(inv.totals&&inv.totals.rounded)||0;
      if(dt===today){ t.a+=a; t.n++; }
      if(dt.slice(0,7)===ym){ m.a+=a; m.n++; }
      if(dt.slice(0,7)===lastYm) lm+=a;
      if(fyStart(dt)===fy){ f.a+=a; f.n++; const k=((inv.buyer&&inv.buyer.name)||'—').trim(); cust[k]=(cust[k]||0)+a; }
    });
    const top=Object.entries(cust).sort((x,y)=>y[1]-x[1]).slice(0,3);
    let trend='';
    if(lm>0){ const p=Math.round((m.a-lm)/lm*100); trend='<div class="dash-top">This month vs last month: <b>'+(p>=0?'▲ ':'▼ ')+Math.abs(p)+'%</b></div>'; }
    const bx=(l,o)=>'<div class="dash-box"><b>₹'+fmt(o.a)+'</b><span>'+l+' · '+o.n+' bills</span></div>';
    box.innerHTML='<h3 style="margin-top:0;">Dashboard</h3><div class="dash-grid">'+bx('Today',t)+bx('This month',m)+bx('This FY',f)+'</div>'+trend+
      (top.length?'<div class="dash-top"><b>Top customers (FY):</b><br>'+top.map((c,i)=>(i+1)+'. '+esc(c[0])+' — ₹'+fmt(c[1])).join('<br>')+'</div>':'');
  }
  const _rh=window.renderHistory;
  window.renderHistory=function(){ _rh.apply(this,arguments); try{ renderDash(); }catch(e){ console.warn(e); } };

  /* ---- WhatsApp ---- */
  function whatsappInvoice(inv){
    if(!inv) return;
    let mobile=((inv.buyer&&inv.buyer.mobile)||'').replace(/\D/g,'');
    while(mobile.length>10&&mobile.charAt(0)==='0') mobile=mobile.slice(1);
    if(!mobile){ toast('⚠ No mobile number saved for this bill'); return; }
    if(mobile.length===10) mobile='91'+mobile;
    const msg='Hello '+((inv.buyer&&inv.buyer.name)||'')+',\nYour invoice '+(inv.invoiceNo||'')+' dated '+(inv.date||'')+' for ₹'+fmt((inv.totals&&inv.totals.rounded)||0)+' is ready.\nThank you,\n'+settings.companyName;
    window.open('https://wa.me/'+mobile+'?text='+encodeURIComponent(msg),'_blank','noopener');
  }
  (function(){ const b=$('pdfViewChatBtn'); const nb=b.cloneNode(true); b.replaceWith(nb);
    nb.addEventListener('click',()=>whatsappInvoice(currentlyViewedInvoice)); })();
  $('historyList').addEventListener('click',e=>{
    const w=e.target.closest('[data-wa]'); if(!w) return;
    const inv=invoices.find(x=>String(x.id)===String(w.dataset.wa)); whatsappInvoice(inv);
  });

  /* ---- Backup: share file + reminder ---- */
  function backupText(){ const t=prefs.lastBackup; $('lastBackupTxt').textContent=t?('Last backup: '+new Date(t).toLocaleString()):'No backup taken from this device yet.'; }
  $('exportBtn').addEventListener('click',()=>{ prefs.lastBackup=Date.now(); savePrefs(); backupText(); });
  $('shareBackupBtn').addEventListener('click',async()=>{
    const text=JSON.stringify({settings,overrides,customParts,invoices,exportedAt:new Date().toISOString()});
    const base='sss-invoice-backup-'+new Date().toISOString().slice(0,10);
    const done=()=>{ prefs.lastBackup=Date.now(); savePrefs(); backupText(); };
    // Android only lets apps share certain file types (.json is refused), so the backup is shared as a plain .txt file.
    try{
      const file=new File([text],base+'.txt',{type:'text/plain'});
      if(navigator.canShare&&navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:'Invoice backup'}); done(); return; }
    }catch(e){ if(e&&e.name==='AbortError') return; }
    try{
      const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type:'text/plain'})); a.download=base+'.txt';
      document.body.appendChild(a); a.click(); a.remove(); done(); toast('Backup file saved to Downloads');
    }catch(e){ toast('⚠ Could not share or save the backup file'); }
  });

  /* ---- Sync status, manual retry, auto retry ---- */
  let lastState='syncing', lastSync=0;
  const _scs=window.setCloudStatus;
  window.setCloudStatus=function(state){
    _scs.apply(this,arguments);
    lastState=state; if(state==='connected') lastSync=Date.now();
    const bt=$('syncBadgeText'); if(bt&&state==='offline') bt.textContent='Offline · tap to retry';
    const l=$('cloudLast'); if(l) l.textContent=lastSync?('Last synced: '+new Date(lastSync).toLocaleTimeString()):'';
  };
  function syncNow(silent){
    if(typeof cloudDb==='undefined'||!cloudDb){ if(!silent) toast('Cloud not connected yet — check internet'); return; }
    if(!silent) toast('Syncing…');
    pushToCloud(); pullFromCloudOnce(!silent);
  }
  $('syncBadge').addEventListener('click',()=>syncNow(false));
  $('syncNowBtn').addEventListener('click',()=>syncNow(false));
  window.addEventListener('online',()=>syncNow(true));
  setInterval(()=>{ if(lastState==='offline') syncNow(true); },60000);


  /* ---- Keep the box you are typing in visible above the keyboard ---- */
  function bringIntoView(el){
    if(!el||!el.closest||!el.closest('#view-invoice, #view-settings')) return;
    if(!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    el.scrollIntoView({block: el.id==='itemSearch' ? 'start' : 'center', behavior:'smooth'});
  }
  document.addEventListener('focusin',e=>{ const el=e.target; setTimeout(()=>bringIntoView(el),320); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize',()=>{ setTimeout(()=>bringIntoView(document.activeElement),120); });

  /* ---- Unsaved bill protection ---- */
  const LEAVE_MSG='This bill is not saved yet.\n\nLeave and discard it?';
  function formSig(){
    return JSON.stringify([invoiceMode,$('buyerMobile').value,$('buyerName').value,$('buyerAddress').value,$('buyerGstin').value,$('buyerState').value,
      $('invoiceDiscount').value,$('invoiceDiscountAmt').value,$('svcDesc').value,$('svcAmt').value,$('gstToggle').value,
      currentItems.map(i=>[i.code,i.desc,i.hsn,i.qty,i.rate,i.taxIncl])]);
  }
  let formBaseline='';
  function isDirty(){ try{ return formSig()!==formBaseline; }catch(e){ return false; } }
  ['resetInvoiceForm','loadInvoiceForEdit'].forEach(n=>{
    const orig=window[n];
    window[n]=function(){ const r=orig.apply(this,arguments); formBaseline=formSig(); return r; };
  });
  const _switch=window.switchToView;
  window.switchToView=function(v,btn,push){
    if(currentViewName==='invoice' && v!=='invoice' && push!==false && isDirty()){
      if(!confirm(LEAVE_MSG)) return;
      resetInvoiceForm();
    }
    return _switch.apply(this,arguments);
  };
  window.guardLeaveOnBack=function(){
    if(currentViewName!=='invoice' || !isDirty()) return false;
    if(confirm(LEAVE_MSG)){ resetInvoiceForm(); return false; }
    history.pushState({view:'invoice'},'',location.pathname+location.search+'#invoice');
    return true;
  };
  // Tapping the Invoice / GST Invoice tab starts a brand-new bill, so ask first when one is half-done.
  document.addEventListener('click',e=>{
    const b=e.target.closest&&e.target.closest('#newInvoiceBtn,#venusBillBtn');
    if(b && currentViewName==='invoice' && isDirty() && !confirm('Start a new bill?\n\nThe unsaved bill on screen will be cleared.')){
      e.stopPropagation(); e.preventDefault();
    }
  },true);
  window.addEventListener('beforeunload',e=>{ if(currentViewName==='invoice' && isDirty()){ e.preventDefault(); e.returnValue=''; } });
  formBaseline=formSig();

  bindPrefs(); applyPrefs(); backupText(); refreshCustList(); try{ renderHistory(); }catch(e){ console.warn(e); }
})();
