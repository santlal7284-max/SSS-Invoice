/* ===================== Storage helpers ===================== */
const CLOUD_KEYS = ['sss_settings','sss_price_overrides','sss_custom_parts','sss_invoices','sss_deleted'];

// Declared here (near the very top) on purpose: settings/migration code
// below can trigger a save (LS.set -> pushToCloud) during the very first
// synchronous pass through this script, before the Firebase section (much
// further down) would normally run. If these weren't declared yet at that
// point, referencing them would throw and silently abort the rest of the
// script — including the PIN-lock keypad wiring at the bottom, which is
// exactly the "PIN does nothing on first try" bug this fixes.
let cloudDb = null;
let cloudSyncTimer = null;
let cloudSyncing = false;
let lastCloudUpdatedAt = null;
let firstLoadDone = false;
let toastTimer;
const DEVICE_ID = (function(){
  let id = localStorage.getItem('sss_device_id');
  if(!id){ id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); localStorage.setItem('sss_device_id', id); }
  return id;
})();

const LS = {
  get(key, fallback){ try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }catch(e){ return fallback; } },
  set(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ try{ if(typeof toast==='function') toast('⚠ Phone storage full — export a backup'); }catch(_){} }
    if(CLOUD_KEYS.indexOf(key) !== -1) pushToCloud();
  }
};


const DEFAULT_SETTINGS = {
  companyName: 'M/S SANT SALES & SERVICE',
  address: 'SHOP NO-2, O-GALI NO-2 GAADA COLONY NEAR KHUSHI GARDEN FARIDABAD HARYANA 121002',
  contact: '9250044138',
  email: 'santlal7284@gmail.com',
  gstin: '06AWEPR6592C1ZC',
  stateCode: '06',
  pan: 'AWEPR6592C',
  gstRate: 18,
  prefix: 'SSS/MM/TM/',
  nextNum: 31,
  gstPrefix: 'SSS/MM/VNS/',
  gstNextNum: 1,
  appPin: '5253',
  lastKnownFY: null,
  prefixFormatV2Applied: false,
  pinForceUpdated: false,
  prefixCleanupV1Applied: false,
  prefixCleanupV2Applied: false,
  signatureImage: DEFAULT_SIGNATURE
};

function getSignature(){
  return settings.signatureImage === undefined ? DEFAULT_SIGNATURE : settings.signatureImage;
}

let settings = LS.get('sss_settings', DEFAULT_SETTINGS);

/* ---- Monthly & yearly-rolling invoice prefix ----
   "MM" in a prefix always resolves to the CURRENT month (08 in August, 09
   in September, ...) and "FY" resolves to the current GST financial year
   (e.g. "26-27"), so a prefix like "SSS/FY/MM/TM/" needs zero manual
   editing all year round. */
function currentMonthMM(){
  return String(new Date().getMonth() + 1).padStart(2, '0');
}
function padSeq(n){
  // 3-digit (001, 002...) once the new post-1-April-2027 format is active;
  // 2-digit for the current format, unchanged.
  return settings.prefixFormatV2Applied ? String(n).padStart(3, '0') : String(n).padStart(2, '0');
}
function currentFY(){
  const now = new Date();
  const y = now.getFullYear();
  const startYear = (now.getMonth() + 1 >= 4) ? y : y - 1; // FY starts 1 April
  const last2 = n => String(n % 100).padStart(2, '0');
  return last2(startYear) + '-' + last2(startYear + 1);
}
function resolvePrefix(template, dateISO){
  // MM / FY follow the BILL DATE (so a back-dated bill automatically gets its
  // own month in the number); with no date they follow today.
  let d = new Date();
  if(dateISO && /^\d{4}-\d{2}-\d{2}/.test(dateISO)){
    const t = new Date(dateISO.slice(0,10) + 'T00:00:00');
    if(!isNaN(t)) d = t;
  }
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  const sy = (d.getMonth() + 1 >= 4) ? y : y - 1;
  const l2 = n => String(n % 100).padStart(2, '0');
  return (template || '').replace(/MM/g, mm).replace(/FY/g, l2(sy) + '-' + l2(sy + 1));
}
// Local (device-timezone) "today" as YYYY-MM-DD. Never use toISOString() for
// invoice dates — that returns the UTC date, which in India (UTC+5:30) is
// the PREVIOUS day until 5:30 AM, so bills made late night / early morning
// got saved with yesterday's date. toLocaleDateString('en-CA') reliably
// yields the ISO format in the device's own timezone.
function localTodayISO(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
// Same idea for a "YYYY-MM" month key, used by the History month filter.
function localCurrentYm(){
  return localTodayISO().slice(0, 7);
}
function prefixToRegex(template){
  if(!template) return null;
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/MM/g, '\\d{2}').replace(/FY/g, '\\d{2}-\\d{2}');
  return new RegExp('^' + pattern);
}
// One-time migration: older saved prefixes had the month baked in as plain
// digits (e.g. "SSS/07/TM/"). Convert the 2-digit segment to "MM" so it
// starts auto-rolling from now on, without losing the rest of the format.
function migratePrefixToMonthly(str){
  if(!str || str.indexOf('MM') !== -1) return str;
  const parts = str.split('/');
  let replaced = false;
  for(let i = 0; i < parts.length; i++){
    if(!replaced && /^\d{2}$/.test(parts[i])){ parts[i] = 'MM'; replaced = true; }
  }
  return replaced ? parts.join('/') : str;
}
// One-time migration: older prefixes had no financial-year segment at all.
// Insert an "FY" token right after the company code so it starts
// auto-rolling every 1st April, without you needing to retype anything.
function migrateAddFY(str){
  if(!str || str.indexOf('FY') !== -1) return str;
  const parts = str.split('/');
  parts.splice(1, 0, 'FY');
  return parts.join('/');
}
let overrides = LS.get('sss_price_overrides', {});     // {code: {fbasic, cbasic}}
let customParts = LS.get('sss_custom_parts', []);       // [[code,hsn,cat,desc,fbasic,cbasic], ...]
let invoices = LS.get('sss_invoices', []);

/* ---- Bill-number helpers (sequence part = the number after the last "/") ----
   The sequence number is what must never repeat, whatever the month/FY text in
   front of it says. Normal bills count across all years; GST bills only inside
   the current financial year (they restart every 1 April). */
function seqOf(no){
  if(!no) return 0;
  const n = parseInt(String(no).split('/').pop(), 10);
  return isNaN(n) ? 0 : n;
}
function fyOfDateStr(dateStr){
  const d = dateStr ? new Date(dateStr) : null;
  if(!d || isNaN(d)) return currentFY();
  const y = d.getFullYear();
  const sy = (d.getMonth() + 1 >= 4) ? y : y - 1;
  const l2 = n => String(n % 100).padStart(2, '0');
  return l2(sy) + '-' + l2(sy + 1);
}
function seqInScope(inv, type){
  if(!inv) return false;
  if(((inv.type === 'gst') ? 'gst' : 'normal') !== type) return false;
  if(type === 'gst' && fyOfDateStr(inv.date) !== currentFY()) return false;
  return true;
}
function histMaxSeq(type){
  let m = 0;
  (Array.isArray(invoices) ? invoices : []).forEach(inv=>{
    if(!seqInScope(inv, type)) return;
    const n = seqOf(inv.invoiceNo); if(n > m) m = n;
  });
  return m;
}
function seqUsed(type, seq, ignoreIdx){
  if(!seq) return false;
  return invoices.some((inv, i)=> i !== ignoreIdx && seqInScope(inv, type) && seqOf(inv.invoiceNo) === seq);
}
// Moves the local "next number" forward to continue after every bill in History.
// Never moves it backwards.
function reconcileNextNumbers(){
  let changed = false;
  const hn = histMaxSeq('normal') + 1, hg = histMaxSeq('gst') + 1;
  if(hn > (parseInt(settings.nextNum)||1)){ settings.nextNum = hn; changed = true; }
  if(hg > (parseInt(settings.gstNextNum)||1)){ settings.gstNextNum = hg; changed = true; }
  if(changed) LS.set('sss_settings', settings);
  return changed;
}

/* ---- Sync fixes ----
   1) stripInvSnapshot: old bills carried a full copy of settings (signature
      image + app PIN) inside every invoice. That bloated storage and cloud
      sync. Nothing reads it, so it is removed everywhere.
   2) deletedInvoices: "tombstones" so a deleted bill stays deleted on every
      device instead of being re-added by the cloud merge. */
let deletedInvoices = LS.get('sss_deleted', {});
if(!deletedInvoices || typeof deletedInvoices !== 'object' || Array.isArray(deletedInvoices)) deletedInvoices = {};
function stripInvSnapshot(inv){
  if(inv && inv.settingsSnapshot){
    if(inv.settingsSnapshot.signatureImage !== undefined || inv.settingsSnapshot.appPin !== undefined){
      delete inv.settingsSnapshot.signatureImage;
      delete inv.settingsSnapshot.appPin;
      return true;
    }
  }
  return false;
}
function mergeDeletedFrom(remoteDeleted){
  let changed = false;
  if(remoteDeleted && typeof remoteDeleted === 'object'){
    Object.keys(remoteDeleted).forEach(k=>{
      if(!deletedInvoices[k]){ deletedInvoices[k] = remoteDeleted[k] || Date.now(); changed = true; }
    });
  }
  if(changed){ try{ localStorage.setItem('sss_deleted', JSON.stringify(deletedInvoices)); }catch(e){} }
  return changed;
}
(function cleanupOldSnapshots(){
  let changed = false;
  (Array.isArray(invoices) ? invoices : []).forEach(inv=>{ if(stripInvSnapshot(inv)) changed = true; });
  if(changed){
    try{ localStorage.setItem('sss_invoices', JSON.stringify(invoices)); }catch(e){}
    try{ localStorage.setItem('sss_snap_push_pending', '1'); }catch(e){}
  }
})();
// Older invoices use their creation id as a stable fallback sync timestamp.
invoices.forEach(inv=>{ if(inv && !inv.updatedAt) inv.updatedAt = Number(inv.id) || Date.now(); });

// One-time backfill: older saved invoices don't carry an explicit "type"
// field — they were told apart from their invoiceNo prefix. Freeze that
// classification onto each invoice NOW, using the prefix pattern as it
// stood at the START of this session — BEFORE the migrations below change
// it — so old bills never get misclassified after any format switch.
// Deferred by one tick: these one-time checks (a couple scan the whole
// invoice history) used to run synchronously before the PIN pad's own
// click handler was wired up, which could make the very first PIN digit
// feel laggy right when the app opens. Deferring them lets the browser
// paint and become responsive first.
/* App-lock PIN is stored as a salted SHA-256 hash (never plain, never in the cloud). */
function hashPin(pin){
  const data = new TextEncoder().encode('sss-lock|' + String(pin));
  if(!(window.crypto && crypto.subtle)) return Promise.resolve('plain:' + pin);
  return crypto.subtle.digest('SHA-256', data).then(b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join(''));
}
function checkPin(entered){
  if(settings.appPinHash) return hashPin(entered).then(h=>h === settings.appPinHash);
  return Promise.resolve(String(entered) === String(settings.appPin || '1234'));
}
function setPin(pin){
  return hashPin(pin).then(h=>{ settings.appPinHash = h; delete settings.appPin; LS.set('sss_settings', settings); });
}

setTimeout(function(){
(function backfillInvoiceTypes(){
  let changed = false;
  const gstRegexNow = prefixToRegex(settings.gstPrefix);
  invoices.forEach(inv=>{
    if(inv.type !== 'gst' && inv.type !== 'normal'){
      inv.type = (gstRegexNow && gstRegexNow.test(inv.invoiceNo||'')) ? 'gst' : 'normal';
      changed = true;
    }
  });
  if(changed) LS.set('sss_invoices', invoices);
})();

// Safety net: the "next number" shown/used always continues from whatever
// is already in History — never lower than that, no matter what the saved
// counter currently says. Runs every load; only ever moves the number
// forward, never backward, so a manually-advanced counter is respected.
// GST numbering is scoped to the CURRENT financial year only (it resets
// each 1 April), so old high numbers from a previous year never override
// a fresh reset. Normal Invoice numbering is NOT FY-scoped — it counts
// continuously across every financial year, so ALL history counts there.
reconcileNextNumbers();

(function migrateSettingsPrefixes(){
  let changed = false;
  let p = migratePrefixToMonthly(settings.prefix);
  let g = migratePrefixToMonthly(settings.gstPrefix);
  if(p !== settings.prefix){ settings.prefix = p; changed = true; }
  if(g !== settings.gstPrefix){ settings.gstPrefix = g; changed = true; }
  if(changed) LS.set('sss_settings', settings);
})();

// One-time cleanup: an earlier version of this app incorrectly inserted an
// "FY" segment into the prefix immediately instead of waiting for 1 April
// 2027, leaving some devices with a mangled prefix (e.g. "SSS/FY/MM/TM/").
// Reset both prefixes back to the correct current format exactly once.
(function cleanupPrematureFY(){
  if(!settings.prefixCleanupV2Applied && !settings.prefixFormatV2Applied){
    settings.prefix = 'SSS/MM/TM/';
    settings.gstPrefix = 'SSS/MM/VNS/';
    settings.prefixCleanupV1Applied = true;
    settings.prefixCleanupV2Applied = true;
    LS.set('sss_settings', settings);
  }
})();

// One-time forced update: app-lock PIN default changed to 5253 permanently.
(function forcePinUpdate(){
  if(!settings.pinForceUpdated){
    settings.appPin = '5253';
    settings.pinForceUpdated = true;
    LS.set('sss_settings', settings);
  }
})();

if(!settings.appPinHash){ setPin(settings.appPin || '5253'); }


/* ---- One-time scheduled prefix format upgrade ----
   From 1 April 2027 (the next financial-year start), both invoice series
   permanently switch to this fixed format — no more "VNS", and both
   series share the same MM/FY/number structure:
     Normal Invoice : SS/MM/FY/01
     GST Invoice    : SSS/MM/FY/01
   This runs exactly once (guarded by settings.prefixFormatV2Applied) and
   never changes the prefix again after that. */
(function scheduledPrefixFormatUpgrade(){
  const upgradeDate = new Date(2027, 3, 1); // 1 April 2027
  if(!settings.prefixFormatV2Applied && new Date() >= upgradeDate){
    settings.prefix = 'SS/FY/';
    settings.gstPrefix = 'SSS/FY/';
    settings.prefixFormatV2Applied = true;
    LS.set('sss_settings', settings);
  }
})();
}, 0);


/* ---- Financial-year rollover: auto-reset bill numbers to 1 on 1 April ----
   Guarded by a Firebase transaction so that if several devices open the
   app around the FY change, only ONE of them actually performs the reset
   — the others just adopt the result. This prevents two phones from both
   resetting to 1 and re-issuing the same invoice number twice. */
// First-ever run under this app version: settings.lastKnownFY was never
// tracked before, so it starts as null. That is NOT a real financial-year
// rollover — just establish the baseline quietly, without touching bill
// numbers. Only a later run where lastKnownFY was already set to a real
// FY string, and now differs, means an actual 1 April rollover happened.
if(settings.lastKnownFY === null || settings.lastKnownFY === undefined){
  settings.lastKnownFY = currentFY();
  LS.set('sss_settings', settings);
}
let pendingFYReset = (settings.lastKnownFY !== currentFY());
function applyLocalFYReset(){
  settings.lastKnownFY = currentFY();
  settings.gstNextNum = 1; // GST invoice series resets every financial year
  // settings.nextNum (Normal Invoice) is deliberately NOT reset — it keeps
  // counting continuously across financial years; only the FY text in its
  // prefix changes.
  LS.set('sss_settings', settings);
  toast('📅 New financial year (' + currentFY() + ') — GST bill numbers reset to 1');
}
function tryCloudGuardedFYReset(){
  if(!cloudDb || !pendingFYReset) return;
  const newFY = currentFY();
  cloudDb.ref('counters/fyLabel').transaction(current=>{
    if(current === newFY) return; // someone already reset for this FY — abort, do nothing
    return newFY;
  }).then(result=>{
    pendingFYReset = false;
    if(result.committed){
      // This device won the race — it performs the real reset for everyone.
      // Only the GST counter resets; the Normal Invoice counter is left
      // untouched so it keeps counting continuously across financial years.
      cloudDb.ref('counters/gst').set(1);
    }
    applyLocalFYReset();
  }).catch(()=>{ /* stay pending, will retry once cloud is reachable */ });
}
if(pendingFYReset && !cloudDb){
  // Offline at launch: reset locally now; nextInvoiceNumber() will still
  // reconcile with the cloud counter (and the guarded reset above) once
  // any device comes back online.
  applyLocalFYReset();
} else if(pendingFYReset && cloudDb){
  // Cloud reachable at launch: DON'T locally reset the counter before the
  // guarded cloud transaction runs — the winner of that transaction owns
  // the reset. Resetting locally first would clobber a manually-advanced
  // counter on the losing device. applyLocalFYReset() runs from
  // tryCloudGuardedFYReset()'s .then() for every device (winner or not).
  tryCloudGuardedFYReset();
}

/* ===================== Combined part list ===================== */
// Customer Landing Price = Customer Basic + GST at the current rate — the
// actual tax-inclusive price the customer pays. Data/overrides always
// store the plain BASIC price; this is a display/use-time conversion so
// changing settings.gstRate later updates landing prices everywhere.
function customerLandingPrice(basic){
  const gstPct = parseFloat(settings.gstRate) || 18;
  return basic * (1 + gstPct/100);
}
function round2(n){ return Math.round(n*100)/100; }
function basicFromLandingPrice(landing){
  const gstPct = parseFloat(settings.gstRate) || 18;
  return landing / (1 + gstPct/100);
}
function allParts(){
  // returns array of {code,hsn,cat,desc,fbasic,cbasic}
  const base = PRICE_DATA.map(r => {
    const ov = overrides[r[0]];
    return { code:r[0], hsn:r[1], cat:r[2], desc:r[3], fbasic: ov?ov.fbasic:r[4], cbasic: ov?ov.cbasic:r[5], custom:false, _orig:r };
  });
  const custom = customParts.map(r => ({ code:r[0], hsn:r[1], cat:r[2], desc:r[3], fbasic:r[4], cbasic:r[5], custom:true }));
  return custom.concat(base);
}
let PARTS_CACHE = []; // populated just below, deferred so it doesn't block the PIN pad
function refreshParts(){ PARTS_CACHE = allParts(); }

function findPart(code){
  if(!code) return null;
  return PARTS_CACHE.find(p => p.code.toLowerCase() === code.toLowerCase()) || null;
}

function esc(str){
  return String(str==null?'':str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ===================== Toast ===================== */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 1800);
}

/* ===================== Tab navigation ===================== */
const titles = { master:['SPARE PARTS & BILLING','Price Master'], invoice:['SPARE PARTS & BILLING','Invoice'], history:['SPARE PARTS & BILLING','Invoice History'], settings:['SPARE PARTS & BILLING','Settings'] };
let currentViewName = 'master';
let backPressArmed = false;
let backPressTimer = null;
history.replaceState({view:'master', floor:true}, '', location.pathname + location.search);
history.pushState({view:'master'}, '', location.pathname + location.search);

function switchToView(v, activeBtn, pushState){
  const modal = document.getElementById('pdfViewModal');
  if(modal.style.display === 'flex'){ closePdfViewModal(); }
  if(pushState !== false && v !== currentViewName){
    history.pushState({view:v}, '', location.pathname + location.search + '#' + v);
  }
  currentViewName = v;
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  const btn = activeBtn || document.querySelector('.tab[data-view="'+v+'"]');
  if(btn) btn.classList.add('active');
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.getElementById('topEyebrow').textContent = titles[v][0];
  document.getElementById('topTitle').textContent = titles[v][1];
  if(v==='history'){ renderHistory(); pullFromCloudOnce(); }
  if(v==='settings') loadSettingsForm();
}

window.addEventListener('popstate', (e)=>{
  if(window.guardLeaveOnBack && window.guardLeaveOnBack()) return;
  const modal = document.getElementById('pdfViewModal');
  if(modal.style.display === 'flex'){
    closePdfViewModal();
    return;
  }
  if(e.state && e.state.floor){
    if(!backPressArmed){
      backPressArmed = true;
      toast('Press back again to exit');
      history.pushState({view:'master'}, '', location.pathname + location.search);
      switchToView('master', document.querySelector('.tab[data-view="master"]'), false);
      clearTimeout(backPressTimer);
      backPressTimer = setTimeout(()=>{ backPressArmed = false; }, 2000);
    }
    // if backPressArmed is already true, do nothing here -> lets the back navigation exit the app
    return;
  }
  const v = (e.state && e.state.view) || 'master';
  const btn = document.querySelector('.tab[data-view="'+v+'"]');
  switchToView(v, btn, false);
});

document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    switchToView(btn.dataset.view, btn);
  });
});

/* ===================== Price Master view ===================== */
const catFilter = document.getElementById('categoryFilter');
const cats = [...new Set(PARTS_CACHE.map(p=>p.cat))].sort();
cats.forEach(c=>{ const o=document.createElement('option'); o.value=c; o.textContent=c; catFilter.appendChild(o); });

let visibleCount = 40;
function normWords(str){
  return String(str||'').toLowerCase().replace(/[\-_.\/,()]+/g,' ').replace(/\s+/g,' ').trim();
}
function matchesQuery(text, query){
  const hay = normWords(text);
  const tokens = normWords(query).split(' ').filter(Boolean);
  if(tokens.length===0) return true;
  return tokens.every(tok => hay.includes(tok));
}
function matchesSearch(p, q, cat){
  if(cat && p.cat !== cat) return false;
  if(!q) return true;
  return matchesQuery(p.code + ' ' + p.desc, q);
}

function renderPartList(){
  const q = document.getElementById('searchInput').value.trim();
  const cat = catFilter.value;
  const filtered = PARTS_CACHE.filter(p=>matchesSearch(p,q,cat));
  const CHIP_PALETTE = [
    ['#5B4FE0','#ECEAFC'], ['#0E9488','#DFF5F1'], ['#D6486B','#FBE7EC'],
    ['#C2760F','#FBF0DA'], ['#2F6FED','#E7EFFE'], ['#2E9E5B','#E3F6EA'], ['#8B5CF6','#F1ECFE']
  ];
  function chipColor(str){
    let h = 0;
    for(let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) | 0; }
    return CHIP_PALETTE[Math.abs(h) % CHIP_PALETTE.length];
  }
  const list = document.getElementById('partList');
  list.innerHTML = '';
  const show = filtered.slice(0, visibleCount);
  document.getElementById('resultCount').textContent = filtered.length + ' parts found' + (filtered.length>show.length ? ' (showing ' + show.length + ')':'');
  show.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'part-row';
    const isOv = !!overrides[p.code];
    div.innerHTML = `
      <div class="top">
        <span class="part-code mono">${esc(p.code)}${p.custom?' <span class=\"badge\">NEW</span>':''}</span>
        <span class="part-cat" style="background:${chipColor(p.cat)[1]}; color:${chipColor(p.cat)[0]};">${esc(p.cat)}</span>
      </div>
      <div class="part-desc">${esc(p.desc)} <span class="mono" style="color:var(--text-dim); font-weight:400; font-size:11px;">HSN ${esc(p.hsn)}</span></div>
      <div class="part-prices">
        <label class="ptile pf"><span class="lbl">Franchisee</span><span class="pin"><b>₹</b><input type="number" step="0.01" class="price-input ${isOv?'overridden':''}" data-code="${esc(p.code)}" data-field="fbasic" value="${p.fbasic}"></span></label>
        <label class="ptile pc"><span class="lbl">Customer landing</span><span class="pin"><b>₹</b><input type="number" step="0.01" class="price-input ${isOv?'overridden':''}" data-code="${esc(p.code)}" data-field="cbasic" value="${fmt(customerLandingPrice(p.cbasic))}"></span></label>
        ${(!p.custom && isOv) ? '<button class="revert-btn" data-revert="'+esc(p.code)+'" title="Original rate par wapas jayein">↺ Reset price</button>' : ''}
        ${p.custom ? '<button class="revert-btn" data-delete="'+esc(p.code)+'" title="Is part ko list se hataayein" style="color:var(--red);">🗑 Remove part</button>' : ''}
      </div>`;
    list.appendChild(div);
  });
  document.getElementById('loadMoreBtn').style.display = filtered.length>show.length ? 'block':'none';
}

document.getElementById('searchInput').addEventListener('input', ()=>{ visibleCount=40; renderPartList(); });
catFilter.addEventListener('change', ()=>{ visibleCount=40; renderPartList(); });
document.getElementById('loadMoreBtn').addEventListener('click', ()=>{ visibleCount+=60; renderPartList(); });

document.getElementById('partList').addEventListener('change', (e)=>{
  const inp = e.target.closest('.price-input');
  if(!inp) return;
  const code = inp.dataset.code, field = inp.dataset.field;
  const enteredVal = parseFloat(inp.value)||0;
  const val = field==='cbasic' ? basicFromLandingPrice(enteredVal) : enteredVal;
  const custom = customParts.find(r=>r[0]===code);
  if(custom){
    custom[field==='fbasic'?4:5] = val;
    LS.set('sss_custom_parts', customParts);
  } else {
    if(!overrides[code]) overrides[code] = {};
    const orig = PRICE_DATA.find(r=>r[0]===code);
    overrides[code].fbasic = field==='fbasic' ? val : (overrides[code].fbasic ?? orig[4]);
    overrides[code].cbasic = field==='cbasic' ? val : (overrides[code].cbasic ?? orig[5]);
    LS.set('sss_price_overrides', overrides);
  }
  refreshParts();
  renderPartList();
  toast('Rate updated');
});

document.getElementById('partList').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-revert]');
  if(btn){
    delete overrides[btn.dataset.revert];
    LS.set('sss_price_overrides', overrides);
    refreshParts();
    renderPartList();
    toast('Original rate restored');
    return;
  }
  const delBtn = e.target.closest('[data-delete]');
  if(delBtn){
    const code = delBtn.dataset.delete;
    const customIdx = customParts.findIndex(r=>r[0]===code);
    if(customIdx === -1) return; // safety: only custom parts can be deleted
    const p = findPart(code);
    if(!confirm('Delete "' + (p ? p.desc : code) + '" from the price list?\n\nThis cannot be undone.')) return;
    customParts.splice(customIdx, 1);
    LS.set('sss_custom_parts', customParts);
    refreshParts();
    renderPartList();
    toast('🗑 Part deleted');
  }
});

function openAddPartModal(){
  document.getElementById('npCode').value = '';
  document.getElementById('npDesc').value = '';
  document.getElementById('npCat').value = '';
  document.getElementById('npHsn').value = '998396';
  document.getElementById('npFbasic').value = '';
  document.getElementById('npCbasic').value = '';
  document.getElementById('addPartModal').style.display = 'flex';
  setTimeout(()=>document.getElementById('npCode').focus(), 80);
}
function closeAddPartModal(){
  document.getElementById('addPartModal').style.display = 'none';
}
document.getElementById('addPartBtn').addEventListener('click', openAddPartModal);
document.getElementById('npCancelBtn').addEventListener('click', closeAddPartModal);
document.getElementById('addPartModal').addEventListener('click', (e)=>{
  if(e.target.id === 'addPartModal') closeAddPartModal();
});
document.getElementById('npSaveBtn').addEventListener('click', ()=>{
  const code = document.getElementById('npCode').value.trim();
  const desc = document.getElementById('npDesc').value.trim();
  if(!code){ toast('⚠ Please enter a part code'); document.getElementById('npCode').focus(); return; }
  if(!desc){ toast('⚠ Please enter a description'); document.getElementById('npDesc').focus(); return; }
  if(findPart(code)){ toast('⚠ This code already exists'); document.getElementById('npCode').focus(); return; }
  const cat = document.getElementById('npCat').value.trim() || 'General Item';
  const hsn = document.getElementById('npHsn').value.trim() || '998396';
  const fbasic = parseFloat(document.getElementById('npFbasic').value) || 0;
  const cbasicLanding = parseFloat(document.getElementById('npCbasic').value) || 0;
  const cbasic = basicFromLandingPrice(cbasicLanding);
  customParts.push([code, hsn, cat, desc, fbasic, cbasic]);
  LS.set('sss_custom_parts', customParts);
  refreshParts();
  if(!cats.includes(cat)){ cats.push(cat); cats.sort(); const o=document.createElement('option'); o.value=cat;o.textContent=cat; catFilter.appendChild(o); }
  document.getElementById('searchInput').value = code;
  renderPartList();
  closeAddPartModal();
  toast('✅ New part added');
});

/* ===================== Invoice view ===================== */
let currentItems = []; // {code, desc, hsn, qty, rate, manual}
let editingIndex = null;

function newItem(){ return {code:'', desc:'', hsn:'', qty:1, rate:0, manual:false, taxIncl:false}; }

function itemTaxable(it){
  const gstPct = parseFloat(settings.gstRate)||18;
  const amt = (it.qty||0)*(it.rate||0);
  return it.taxIncl ? amt/(1+gstPct/100) : amt;
}

function addItemRow(item){
  currentItems.push(item || newItem());
  renderItems();
}

function computeGst(){
  const gstOn = document.getElementById('gstToggle').value !== 'without';
  if(!gstOn){ return { intra:false, cgst:0, sgst:0, igst:0, gstOn:false }; }
  const seller = (settings.stateCode||'').trim();
  const buyer = (document.getElementById('buyerState').value||'').trim();
  const gstRate = parseFloat(settings.gstRate)||18;
  const intra = seller && buyer && seller === buyer;
  return { intra, cgst: intra?gstRate/2:0, sgst: intra?gstRate/2:0, igst: intra?0:gstRate, gstOn:true };
}

function renderItems(){
  const box = document.getElementById('itemsContainer');
  box.innerHTML = '';
  currentItems.forEach((it, idx)=>{
    const taxable = itemTaxable(it);
    const div = document.createElement('div');
    div.className = 'item-card';
    div.innerHTML = `
      <span class="idx">#${idx+1}</span>
      <button class="remove" type="button" data-remove="${idx}" title="Remove">✕</button>
      ${it.code ? '<div class="it-code mono">'+esc(it.code)+'</div>' : '<div class="it-code" style="color:var(--text-dim)">Manual item</div>'}
      <div class="field" style="margin-bottom:0;">
        <label>Description</label>
        <input type="text" class="it-desc" data-idx="${idx}" value="${esc(it.desc || '')}" placeholder="Item description">
      </div>
      <div class="item-grid">
        <div class="field" style="margin-bottom:0;"><label>HSN/SAC</label><input type="text" class="it-hsn" data-idx="${idx}" value="${esc(it.hsn || '')}"></div>
        <div class="field" style="margin-bottom:0;"><label>Qty</label><input type="number" step="1" min="0" class="it-qty" data-idx="${idx}" value="${it.qty}"></div>
        <div class="field" style="margin-bottom:0;"><label>${it.taxIncl?'Amount (with tax) ₹':'Rate ₹'}</label><input type="number" step="0.01" class="it-rate" data-idx="${idx}" value="${it.rate}"></div>
      </div>
      <label style="display:flex; align-items:center; gap:6px; font-size:12.5px; color:var(--text-dim); margin-top:8px;">
        <input type="checkbox" class="it-taxincl" data-idx="${idx}" ${it.taxIncl?'checked':''}>
        This amount includes tax (tax-exclusive amount will be calculated automatically)
      </label>
      <div class="item-line-total">Taxable Value (excl. tax): <b>₹${taxable.toFixed(2)}</b></div>
    `;
    box.appendChild(div);
  });
  renderTotals();
}

document.getElementById('addItemBtn').addEventListener('click', ()=>addItemRow());

document.getElementById('itemsContainer').addEventListener('click', (e)=>{
  const rm = e.target.closest('[data-remove]');
  if(rm){ currentItems.splice(+rm.dataset.remove,1); renderItems(); return; }
  const acr = e.target.closest('.ac-item');
  if(acr){
    const idx = +acr.dataset.idx, code = acr.dataset.code;
    const p = findPart(code);
    if(p){
      currentItems[idx] = { code:p.code, desc:p.desc, hsn:p.hsn, qty: currentItems[idx].qty||1, rate: round2(customerLandingPrice(p.cbasic)), manual:false, taxIncl:false };
      renderItems();
    }
  }
});

document.getElementById('itemsContainer').addEventListener('input', (e)=>{
  const t = e.target;
  const idx = t.dataset.idx;
  if(idx===undefined) return;
  const i = +idx;
  if(t.classList.contains('ac-input')){
    currentItems[i].code = t.value;
    const q = t.value.trim();
    const resBox = document.querySelector(`.ac-results[data-idx="${i}"]`);
    if(q.length < 2){ resBox.innerHTML=''; return; }
    const matches = PARTS_CACHE.filter(p=>matchesQuery(p.code + ' ' + p.desc, q)).slice(0,15);
    if(matches.length===0){ resBox.innerHTML=''; return; }
    resBox.innerHTML = '<div class="ac-list">' + matches.map(m=>
      `<div class="ac-item" data-idx="${i}" data-code="${esc(m.code)}"><span class="c mono">${esc(m.code)}</span> — ${esc(m.desc)} <span style="color:var(--text-dim)">(₹${fmt(customerLandingPrice(m.cbasic))})</span></div>`
    ).join('') + '</div>';
  } else if(t.classList.contains('it-desc')){
    currentItems[i].desc = t.value; currentItems[i].manual = true;
  } else if(t.classList.contains('it-hsn')){
    currentItems[i].hsn = t.value;
  } else if(t.classList.contains('it-qty')){
    currentItems[i].qty = parseFloat(t.value)||0;
    renderTotals();
    updateLineTotal(i);
  } else if(t.classList.contains('it-rate')){
    currentItems[i].rate = parseFloat(t.value)||0;
    renderTotals();
    updateLineTotal(i);
  }
});

document.getElementById('itemsContainer').addEventListener('change', (e)=>{
  const t = e.target;
  if(t.classList.contains('it-taxincl')){
    const i = +t.dataset.idx;
    currentItems[i].taxIncl = t.checked;
    renderItems();
  }
});

function updateLineTotal(i){
  const el = document.querySelectorAll('.item-line-total b')[i];
  if(el) el.textContent = '₹' + itemTaxable(currentItems[i]).toFixed(2);
}

// close autocomplete list on outside click
document.addEventListener('click', (e)=>{
  if(!e.target.closest('.autocomplete')){
    document.querySelectorAll('.ac-results').forEach(r=>r.innerHTML='');
  }
});

function setSvcDesc(text){
  const sel = document.getElementById('svcType'), inp = document.getElementById('svcDesc');
  const known = ['Service Charges','Delivery Charge','Installation Charge'];
  inp.value = text;
  if(known.includes(text)){ sel.value = text; inp.style.display = 'none'; }
  else { sel.value = '__other'; inp.style.display = ''; }
}
document.getElementById('svcType').addEventListener('change', ()=>{
  const sel = document.getElementById('svcType'), inp = document.getElementById('svcDesc');
  if(sel.value === '__other'){ inp.value = ''; inp.style.display = ''; inp.focus(); }
  else { inp.value = sel.value; inp.style.display = 'none'; }
  renderTotals();
});
let discountSource = 'pct'; // which discount box the user typed in: 'pct' or 'amt'
function renderTotals(){
  const gst = computeGst();
  let rawTaxable = 0;
  currentItems.forEach(it=>{ rawTaxable += itemTaxable(it); });
  const pctEl = document.getElementById('invoiceDiscount'), amtEl = document.getElementById('invoiceDiscountAmt');
  let discountPct, discountAmt;
  if(discountSource === 'amt'){
    discountAmt = Math.min(Math.max(parseFloat(amtEl.value)||0, 0), rawTaxable);
    discountPct = rawTaxable > 0 ? discountAmt / rawTaxable * 100 : 0;
    pctEl.value = discountAmt > 0 ? String(Math.round(discountPct*100)/100) : '';
  } else {
    discountPct = Math.min(Math.max(parseFloat(pctEl.value)||0, 0), 100);
    discountAmt = rawTaxable * discountPct / 100;
    amtEl.value = discountAmt > 0 ? discountAmt.toFixed(2) : '';
  }
  const serviceAmt = Math.max(parseFloat((document.getElementById('svcAmt')||{}).value)||0, 0);
  const serviceDesc = (((document.getElementById('svcDesc')||{}).value)||'').trim() || 'Service Charges';
  const itemsAfter = rawTaxable - discountAmt;
  const taxable = itemsAfter + serviceAmt;   // GST base; GST is 0 on Without-GST bills
  const cgstAmt = taxable*gst.cgst/100, sgstAmt = taxable*gst.sgst/100, igstAmt = taxable*gst.igst/100;
  const grand = taxable + cgstAmt + sgstAmt + igstAmt;
  const rounded = Math.round(grand);
  const roundOff = rounded - grand;
  const dShow = Math.round(discountPct*100)/100;
  const box = document.getElementById('invoiceTotals');
  box.innerHTML = `
    <div class="r"><span>Taxable Value${discountAmt>0?' (before discount)':''}</span><span>₹${rawTaxable.toFixed(2)}</span></div>
    ${discountAmt>0 ? `<div class="r"><span>Discount @ ${dShow}%</span><span>−₹${discountAmt.toFixed(2)}</span></div>
    <div class="r"><span>Taxable Value (after discount)</span><span>₹${itemsAfter.toFixed(2)}</span></div>` : ''}
    ${serviceAmt>0 ? `<div class="r"><span>${esc(serviceDesc)}</span><span>+₹${serviceAmt.toFixed(2)}</span></div>` : ''}
    ${gst.gstOn ? (gst.intra ? `<div class="r"><span>CGST @ ${gst.cgst}%</span><span>₹${cgstAmt.toFixed(2)}</span></div>
    <div class="r"><span>SGST @ ${gst.sgst}%</span><span>₹${sgstAmt.toFixed(2)}</span></div>`
    : `<div class="r"><span>IGST @ ${gst.igst}%</span><span>₹${igstAmt.toFixed(2)}</span></div>`) : ''}
    <div class="r"><span>Round off</span><span>₹${roundOff.toFixed(2)}</span></div>
    <div class="r grand"><span>Total Invoice Value</span><span>₹${rounded.toFixed(2)}</span></div>
  `;
  return { rawTaxable, discountPct, discountAmt, discountMode: discountSource, serviceAmt, serviceDesc, taxable, cgstAmt, sgstAmt, igstAmt, rounded, gst };
}

document.getElementById('buyerState').addEventListener('input', renderTotals);
document.getElementById('invoiceDiscount').addEventListener('input', ()=>{ discountSource = 'pct'; renderTotals(); });
document.getElementById('invoiceDiscountAmt').addEventListener('input', ()=>{ discountSource = 'amt'; renderTotals(); });
['svcAmt','svcDesc'].forEach(id=>document.getElementById(id).addEventListener('input', renderTotals));
document.getElementById('gstToggle').addEventListener('change', renderTotals);

let invoiceMode = 'normal'; // 'normal' | 'gst'

function setInvoiceMode(mode){
  invoiceMode = mode;
  const isGst = mode === 'gst';
  document.getElementById('gstToggleField').style.display = isGst ? 'none' : '';
  document.getElementById('discountField').style.display = isGst ? 'none' : '';
  document.getElementById('venusFillBtn').style.display = isGst ? '' : 'none';
  if(isGst){
    document.getElementById('gstToggle').value = 'with';
    document.getElementById('invoiceDiscount').value = '';
    document.getElementById('invoiceDiscountAmt').value = '';
    discountSource = 'pct';
  }
}

let autoInvoiceNo = '';
function autoNoFor(mode, dateISO){
  const seq = parseInt(mode === 'gst' ? settings.gstNextNum : settings.nextNum) || 1;
  const tpl = mode === 'gst' ? settings.gstPrefix : settings.prefix;
  return resolvePrefix(tpl || '', dateISO) + padSeq(seq);
}
// Keeps the number shown in the form fresh (after a sync, or when the bill date
// changes) — but only while the person has NOT typed their own number.
function refreshAutoInvoiceNumber(){
  const f = document.getElementById('invoiceNo');
  const d = document.getElementById('invoiceDate');
  if(!f || !d || editingIndex !== null) return;
  if(f.value.trim() !== autoInvoiceNo) return;
  autoInvoiceNo = autoNoFor(invoiceMode, d.value);
  f.value = autoInvoiceNo;
}
document.getElementById('invoiceDate').addEventListener('change', refreshAutoInvoiceNumber);
document.getElementById('invoiceDate').addEventListener('input', refreshAutoInvoiceNumber);
function resetInvoiceForm(){
  document.getElementById('buyerName').value='';
  document.getElementById('buyerMobile').value='';
  document.getElementById('buyerAddress').value='';
  document.getElementById('buyerGstin').value='';
  document.getElementById('buyerState').value='06';
  document.getElementById('invoiceDate').value = localTodayISO();
  autoInvoiceNo = autoNoFor(invoiceMode, localTodayISO());
  document.getElementById('invoiceNo').value = autoInvoiceNo;
  document.getElementById('invoiceDiscount').value = '';
  document.getElementById('invoiceDiscountAmt').value = '';
  discountSource = 'pct';
  setSvcDesc('Service Charges');
  document.getElementById('svcAmt').value = '';
  document.getElementById('gstToggle').value = invoiceMode === 'gst' ? 'with' : 'without';
  document.getElementById('showTermsToggle').checked = true;
  document.getElementById('warrantyMonths').value = '3';
  currentItems = [];
  editingIndex = null;
  document.getElementById('saveInvoiceBtn').textContent = 'Save Invoice';
  renderItems();
}

document.getElementById('newInvoiceBtn').addEventListener('click', ()=>{
  setInvoiceMode('normal');
  resetInvoiceForm();
});

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
document.getElementById('venusBillBtn').addEventListener('click', ()=>{
  setInvoiceMode('gst');
  resetInvoiceForm();
  document.getElementById('topTitle').textContent = 'GST Invoice';
});

document.getElementById('venusFillBtn').addEventListener('click', ()=>{
  document.getElementById('buyerName').value = 'Venus Home Appliances Pvt. Ltd.';
  document.getElementById('buyerAddress').value = '1st Floor AB-8, Community Center, New Delhi-110029';
  document.getElementById('buyerGstin').value = '07AABCV6878P1ZD';
  document.getElementById('buyerState').value = '07';
  const now = new Date();
  const monthLabel = MONTH_NAMES[now.getMonth()] + ' ' + now.getFullYear();
  currentItems = [{ code:'', desc:'Monthly Remuneration For '+monthLabel, hsn:'998396', qty:1, rate:0, manual:true, taxIncl:false }];
  renderItems();
  renderTotals();
  setTimeout(()=>{
    const rateInput = document.querySelector('.it-rate[data-idx="0"]');
    if(rateInput){ rateInput.focus(); rateInput.select(); }
  }, 50);
});

/* Save invoice */
document.getElementById('saveInvoiceBtn').addEventListener('click', async ()=>{
  const buyerName = document.getElementById('buyerName').value.trim();
  if(!buyerName){ alert('Please enter the customer name.'); return; }
  const validItems = currentItems.filter(it => (it.desc && it.desc.trim()) && (it.qty>0));
  if(validItems.length===0){ alert('Please add at least one item.'); return; }

  // GST validation: with GST on, an empty buyer state silently falls back to
  // IGST (inter-state) — possibly wrong tax on a real bill. Stop and ask.
  if(invoiceMode === 'gst'){
    if(!document.getElementById('buyerState').value.trim()){
      alert('With GST billing, the buyer\'s State Code is required (it decides CGST+SGST vs IGST). Please fill it before saving.');
      document.getElementById('buyerState').focus();
      return;
    }
  }

  const saveBtn = document.getElementById('saveInvoiceBtn');
  const saveBtnLabel = saveBtn.textContent;
  saveBtn.disabled = true;

  const invoiceNoField = document.getElementById('invoiceNo');
  let finalInvoiceNo = invoiceNoField.value.trim();
  let numberWasAutoAllocated = false;

  // Duplicate-number guard: warn if the number about to be saved already
  // exists in history (ignoring the invoice being edited itself). Manually
  // typed numbers especially can collide with an earlier bill — which would
  // silently create two bills with the same number.
  if(finalInvoiceNo){
    const dupIdx = invoices.findIndex((inv, i) =>
      inv.invoiceNo === finalInvoiceNo && (editingIndex === null || i !== editingIndex));
    if(dupIdx !== -1){
      const existing = invoices[dupIdx];
      const ok = confirm('⚠ Invoice number "' + finalInvoiceNo + '" is ALREADY used by a bill dated ' + (existing.date||'?') + ' for ' + (existing.buyer && existing.buyer.name ? existing.buyer.name : 'an earlier customer') + '.\n\nSave anyway?');
      if(!ok){ saveBtn.disabled = false; return; }
    }
  }

  // Sequential & multi-device protection.
  // - Number on screen is still the auto one -> reserve it from the cloud counter
  //   (atomic, two phones can never get the same number).
  // - Person typed / edited the number -> keep it, but warn if the same
  //   sequence number is already used by another bill (even with another month).
  const seqType = invoiceMode === 'gst' ? 'gst' : 'normal';
  const billDate = document.getElementById('invoiceDate').value;
  const isAutoNumber = (editingIndex === null && finalInvoiceNo === autoInvoiceNo);
  const origNo = (editingIndex !== null && invoices[editingIndex]) ? invoices[editingIndex].invoiceNo : null;
  const stopSave = ()=>{ saveBtn.disabled = false; saveBtn.textContent = saveBtnLabel; };

  if(!isAutoNumber && finalInvoiceNo && finalInvoiceNo !== origNo){
    const s = seqOf(finalInvoiceNo);
    if(s && seqUsed(seqType, s, editingIndex)){
      const other = invoices.find((inv, i)=> i !== editingIndex && seqInScope(inv, seqType) && seqOf(inv.invoiceNo) === s);
      if(!confirm('⚠ Sequence number ' + s + ' is already used by bill ' + (other && other.invoiceNo ? other.invoiceNo : '?') + '.\n\nTwo bills with the same number will exist. Save anyway?')){ stopSave(); return; }
    }
  }

  if(isAutoNumber){
    const prefix = resolvePrefix(invoiceMode === 'gst' ? (settings.gstPrefix||'') : (settings.prefix||''), billDate);
    const cloudReady = !!(cloudDb && cloudOnline);
    let allocated = null;
    if(!cloudReady){
      if(!confirm('Cloud is not connected. The other phone may issue the same bill number.\n\nSave with this phone\'s number anyway?')){ stopSave(); return; }
    } else {
      saveBtn.textContent = 'Reserving number…';
      try{
        allocated = await nextInvoiceNumber(invoiceMode);
        let guard = 0;
        while(seqUsed(seqType, allocated, -1) && guard++ < 50){ allocated = await nextInvoiceNumber(invoiceMode); }
      }catch(e){
        console.warn('Cloud number reservation failed', e);
        allocated = null;
        if(!confirm('Could not reserve a bill number from the cloud (' + ((e && (e.code || e.message)) || 'error') + ').\nThe other phone may issue the same number.\n\nSave with this phone\'s number anyway?')){ stopSave(); return; }
      }
    }
    if(allocated === null){
      allocated = Math.max(parseInt(seqType === 'gst' ? settings.gstNextNum : settings.nextNum) || 1, histMaxSeq(seqType) + 1);
      while(seqUsed(seqType, allocated, -1)) allocated++;
    }
    finalInvoiceNo = prefix + padSeq(allocated);
    invoiceNoField.value = finalInvoiceNo;
    if(invoiceMode === 'gst') settings.gstNextNum = Math.max(parseInt(settings.gstNextNum)||1, allocated + 1);
    else settings.nextNum = Math.max(parseInt(settings.nextNum)||1, allocated + 1);
    numberWasAutoAllocated = true;
  }

  saveBtn.textContent = 'Saving…';
  const totals = renderTotals();
  const inv = {
    id: Date.now(),
    invoiceNo: finalInvoiceNo,
    type: invoiceMode,
    date: document.getElementById('invoiceDate').value,
    buyer: {
      name: buyerName,
      mobile: document.getElementById('buyerMobile').value,
      address: document.getElementById('buyerAddress').value,
      gstin: document.getElementById('buyerGstin').value,
      stateCode: document.getElementById('buyerState').value
    },
    items: validItems,
    totals,
    showTerms: document.getElementById('showTermsToggle').checked,
    warrantyMonths: parseInt(document.getElementById('warrantyMonths').value) || 0,
    settingsSnapshot: (function(){ const o = {}; ['companyName','address','contact','email','gstin','stateCode','pan'].forEach(k=>{ o[k] = settings[k]; }); return o; })(),
    updatedAt: nowTs()
  };
  if(editingIndex !== null){
    inv.id = invoices[editingIndex].id;
    inv.updatedAt = nowTs();
    invoices[editingIndex] = inv;
    LS.set('sss_invoices', invoices);
    toast('✅ Invoice updated: ' + inv.invoiceNo);
  } else {
    invoices.unshift(inv);
    LS.set('sss_invoices', invoices);
    if(!numberWasAutoAllocated){
      // Custom / back-dated number: only move the counter if it is ahead of it
      // (a back-dated, lower number must NOT push the counter up).
      const s = seqOf(inv.invoiceNo);
      const key = invoiceMode === 'gst' ? 'gstNextNum' : 'nextNum';
      if(s + 1 > (parseInt(settings[key])||1)) settings[key] = s + 1;
    }
    LS.set('sss_settings', settings);
    try{ syncCounters(); }catch(e){}
    toast('✅ Invoice saved: ' + inv.invoiceNo);
  }
  saveBtn.disabled = false;
  try{
    historySummaryYm = (inv.date||'').slice(0,7) || localCurrentYm();
    historyFilter = invoiceTypeOf(inv);
    document.querySelectorAll('.hist-filter-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.filter === historyFilter);
    });
  }catch(e){}
  resetInvoiceForm();
});

function buildInvoiceFromForm(){
  const totals = renderTotals();
  return {
    invoiceNo: document.getElementById('invoiceNo').value,
    type: invoiceMode,
    date: document.getElementById('invoiceDate').value,
    buyer: {
      name: document.getElementById('buyerName').value,
      mobile: document.getElementById('buyerMobile').value,
      address: document.getElementById('buyerAddress').value,
      gstin: document.getElementById('buyerGstin').value,
      stateCode: document.getElementById('buyerState').value
    },
    items: currentItems.filter(it=>it.desc && it.qty>0),
    showTerms: document.getElementById('showTermsToggle').checked,
    warrantyMonths: parseInt(document.getElementById('warrantyMonths').value) || 0,
    totals
  };
}

let pendingInvoice = null;
let pendingAction = null;

function openReviewModal(action){
  pendingInvoice = buildInvoiceFromForm();
  pendingAction = action;
  const list = document.getElementById('reviewItemList');
  list.innerHTML = pendingInvoice.items.map(it => {
    const amt = (it.qty||0)*(it.rate||0);
    return `<div class="review-row">
      <div class="review-desc">${esc(it.desc)}${it.code?' <span class="mono" style="color:var(--text-dim); font-weight:400;">('+esc(it.code)+')</span>':''}</div>
      <div class="review-calc">Qty ${it.qty} &times; <span class="review-rate">₹${fmt(it.rate)}</span>${it.taxIncl?' (tax incl.)':''} = <b>₹${fmt(amt)}</b></div>
    </div>`;
  }).join('') + (pendingInvoice.totals.serviceAmt > 0 ? `<div class="review-row"><div class="review-desc">${esc(pendingInvoice.totals.serviceDesc)}</div><div class="review-calc">Service charge = <b>₹${fmt(pendingInvoice.totals.serviceAmt)}</b>${pendingInvoice.totals.gst.gstOn ? ' (+ GST)' : ''}</div></div>` : '');
  document.getElementById('reviewTotal').textContent = '₹' + fmt(pendingInvoice.totals.rounded);
  document.getElementById('reviewModal').style.display = 'flex';
}

document.getElementById('reviewCancelBtn').addEventListener('click', ()=>{
  document.getElementById('reviewModal').style.display = 'none';
  pendingInvoice = null; pendingAction = null;
});

document.getElementById('reviewConfirmBtn').addEventListener('click', ()=>{
  document.getElementById('reviewModal').style.display = 'none';
  if(pendingAction === 'print') printInvoice(pendingInvoice);
  if(pendingAction === 'share') shareInvoice(pendingInvoice);
  pendingInvoice = null; pendingAction = null;
});

/* PDF download / share now happen from History only. */



function fmt(n){ return (Math.round(n*100)/100).toFixed(2); }
function numberToWordsIndian(num){
  num = Math.round(num);
  if(num === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function twoDigits(n){
    if(n < 20) return ones[n];
    return tens[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '');
  }
  function threeDigits(n){
    if(n < 100) return twoDigits(n);
    return ones[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' ' + twoDigits(n%100) : '');
  }
  let crore = Math.floor(num / 10000000); num %= 10000000;
  let lakh = Math.floor(num / 100000); num %= 100000;
  let thousand = Math.floor(num / 1000); num %= 1000;
  let hundred = num;
  const parts = [];
  if(crore) parts.push(threeDigits(crore) + ' Crore');
  if(lakh) parts.push(threeDigits(lakh) + ' Lakh');
  if(thousand) parts.push(threeDigits(thousand) + ' Thousand');
  if(hundred) parts.push(threeDigits(hundred));
  return (parts.join(' ') || 'Zero') + ' Rupees Only';
}

function SS(inv){ return Object.assign({}, settings, (inv && inv.settingsSnapshot) || {}); }
function invoiceHtml(inv){
  const st = SS(inv);
  const gst = inv.totals.gst;
  const gstOn = gst.gstOn !== false;
  const gstPctUsed = gstOn ? (gst.intra ? (gst.cgst + gst.sgst) : gst.igst) : 0;
  let rows = '';
  inv.items.forEach((it,i)=>{
    const amt = (it.qty||0)*(it.rate||0);
    const tax = it.taxIncl ? amt/(1+gstPctUsed/100) : amt;
    rows += `<tr><td>${i+1}</td><td>${esc(it.desc)}${it.code?' <span style=\"color:#777\">('+esc(it.code)+')</span>':''}</td><td>${esc(it.hsn||'')}</td><td class="num">${it.qty}</td><td class="num">${fmt(it.rate)}</td><td class="num">${fmt(tax)}</td></tr>`;
  });
  return `
  <div class="paper">
    <div class="paper-watermark">Sant Sales &amp; Service</div>
    <div class="paper-content">
    <div class="ph"><img class="ph-logo" src="${LOGO_INALSA}" alt="Inalsa"><span class="ph-title">${gstOn ? 'TAX INVOICE' : 'INVOICE'}</span><img class="ph-logo" src="${LOGO_VENUS}" alt="Venus"></div>
    <div style="text-align:center; font-weight:700; font-size:16px;">${esc(st.companyName)}</div>
    <div style="text-align:center; font-size:11px;">${esc(st.address)}</div>
    <div style="text-align:center; font-size:11px;">Contact: ${esc(st.contact)} &nbsp; Email: ${esc(st.email)}</div>
    <div style="text-align:center; font-size:11.5px; font-weight:700; color:#C8862A; margin-top:3px; letter-spacing:0.03em;">INALSA/VENUS Authorised Service Center</div>
    <div style="display:flex; justify-content:space-between; font-size:11.5px; margin-top:6px; border-top:1px solid #999; padding-top:6px;">
      <span><b>GSTIN:</b> ${esc(st.gstin)} &nbsp; <b>State Code:</b> ${esc(st.stateCode)}</span>
      <span><b>PAN:</b> ${esc(st.pan)}</span>
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:8px;">
      <div>
        <b>Billing To:</b><br>
        ${esc(inv.buyer.name)}<br>
        ${esc(inv.buyer.address)}<br>
        ${inv.buyer.mobile ? 'Mobile: '+esc(inv.buyer.mobile)+'<br>' : ''}
        GSTIN: ${esc(inv.buyer.gstin)} &nbsp; State Code: ${esc(inv.buyer.stateCode)}
      </div>
      <div style="text-align:right;">
        <b>Invoice No:</b> ${esc(inv.invoiceNo)}<br>
        <b>Date:</b> ${esc(inv.date)}
      </div>
    </div>
    <table>
      <thead><tr><th>Sr</th><th>Description</th><th>HSN</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="totalrow"><td colspan="5" class="num">Taxable Value${(inv.totals.discountPct>0) ? ' (before discount)' : ''}</td><td class="num">${fmt(inv.totals.rawTaxable ?? inv.totals.taxable)}</td></tr>
        ${(inv.totals.discountPct>0) ? `<tr><td colspan="5" class="num">Discount @ ${Math.round(inv.totals.discountPct*100)/100}%</td><td class="num">−${fmt(inv.totals.discountAmt)}</td></tr>
        <tr class="totalrow"><td colspan="5" class="num">Taxable Value (after discount)</td><td class="num">${fmt(inv.totals.taxable - (inv.totals.serviceAmt||0))}</td></tr>` : ''}
        ${(inv.totals.serviceAmt>0) ? `<tr><td colspan="5" class="num">${esc(inv.totals.serviceDesc||'Service Charges')}</td><td class="num">${fmt(inv.totals.serviceAmt)}</td></tr>` : ''}
        ${gstOn ? (gst.intra ? `<tr><td colspan="5" class="num">CGST @ ${gst.cgst}%</td><td class="num">${fmt(inv.totals.cgstAmt)}</td></tr>
        <tr><td colspan="5" class="num">SGST @ ${gst.sgst}%</td><td class="num">${fmt(inv.totals.sgstAmt)}</td></tr>`
        : `<tr><td colspan="5" class="num">IGST @ ${gst.igst}%</td><td class="num">${fmt(inv.totals.igstAmt)}</td></tr>`) : ''}
        <tr class="totalrow"><td colspan="5" class="num">TOTAL INVOICE VALUE</td><td class="num">₹${fmt(inv.totals.rounded)}</td></tr>
      </tfoot>
    </table>
    <div style="font-size:10.5px; font-style:italic; color:#444; margin-top:4px;"><b>Amount in Words:</b> ${esc(numberToWordsIndian(inv.totals.rounded))}</div>
    ${inv.showTerms !== false ? `<div style="margin-top:14px; font-size:10px; color:#555; border-top:1px dashed #bbb; padding-top:6px; line-height:1.5;">
      <b>Terms &amp; Conditions:</b> Spare parts carry a warranty of ${(inv.warrantyMonths !== undefined && inv.warrantyMonths !== null) ? inv.warrantyMonths : 3} months from the date of this invoice. Service charges are valid for a period of 1 month from the date of service. Warranty is applicable only against manufacturing defects and does not cover physical damage, misuse, or issues arising from unauthorised repairs.
    </div>` : ''}
    <div style="margin-top:14px; display:flex; justify-content:${inv.type==='normal' ? 'flex-end' : 'space-between'}; align-items:flex-end; gap:12px;">
      ${inv.type==='normal' ? '' : `<div style="font-size:10.5px; border:1px solid #999; border-radius:4px; padding:8px 10px; line-height:1.55;">
        <div style="font-weight:700; font-size:11.5px; margin-bottom:3px; letter-spacing:0.03em;">BANK DETAILS</div>
        <div><b>Bank Name:</b> Indian Overseas Bank</div>
        <div><b>Branch:</b> Sector 28 Faridabad</div>
        <div><b>Account Number:</b> 183402000001164</div>
        <div><b>Account Name:</b> M/S SANT SALES & SERVICE</div>
        <div><b>Account Type:</b> CAA - GOLD</div>
        <div><b>IFSC Code:</b> IOBA0001834</div>
      </div>`}
      <div style="text-align:center;">For ${esc(st.companyName)}<br>${getSignature() ? '<img src="'+getSignature()+'" style="max-height:55px; max-width:160px; display:block; margin:4px auto;">' : '<br><br><br>'}Authorised Signatory</div>
    </div>
    </div>
  </div>`;
}

let _libsPromise = null;
function ensurePdfLibs(){
  if(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
  if(_libsPromise) return _libsPromise;
  function loadScript(src){
    return new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = ()=>reject(new Error('Failed to load '+src));
      document.head.appendChild(s);
    });
  }
  _libsPromise = loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
    .then(()=>loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    .catch((err)=>{ _libsPromise = null; throw err; });
  return _libsPromise;
}

let _xlsxLibPromise = null;
function ensureXlsxLib(){
  if(window.XLSX) return Promise.resolve();
  if(_xlsxLibPromise) return _xlsxLibPromise;
  _xlsxLibPromise = new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = ()=>reject(new Error('Failed to load XLSX library'));
    document.head.appendChild(s);
  }).catch((err)=>{ _xlsxLibPromise = null; throw err; });
  return _xlsxLibPromise;
}

/* ===================== Export GST Invoices to Excel =====================
   Builds a real .xlsx file (genuine cells/columns, not a screenshot) with
   one row per GST invoice for the currently-selected History month —
   ready to be read by a VBA macro or linked into another workbook. */
function exportGstInvoicesToExcel(){
  const monthInvoices = invoices.filter(inv =>
    invoiceTypeOf(inv) === 'gst' && (inv.date||'').slice(0,7) === historySummaryYm
  );
  if(monthInvoices.length === 0){
    toast('⚠ No GST invoices found for ' + formatYm(historySummaryYm));
    return;
  }
  toast('Preparing Excel file…');
  ensureXlsxLib().then(()=>{
    const header = ['Invoice No','Date','Customer Name','GSTIN','Taxable Value','CGST %','CGST Amount','SGST %','SGST Amount','IGST %','IGST Amount','Total'];
    const rows = monthInvoices
      .slice()
      .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (a.invoiceNo||'').localeCompare(b.invoiceNo||''))
      .map(inv=>{
        const t = inv.totals || {};
        const g = t.gst || {};
        return [
          inv.invoiceNo || '',
          inv.date || '',
          (inv.buyer && inv.buyer.name) || '',
          (inv.buyer && inv.buyer.gstin) || '',
          round2(t.taxable || 0),
          g.cgst || 0,
          round2(t.cgstAmt || 0),
          g.sgst || 0,
          round2(t.sgstAmt || 0),
          g.igst || 0,
          round2(t.igstAmt || 0),
          round2(t.rounded || 0)
        ];
      });
    const totalsRow = ['', '', 'TOTAL', '',
      round2(rows.reduce((s,r)=>s+r[4],0)), '',
      round2(rows.reduce((s,r)=>s+r[6],0)), '',
      round2(rows.reduce((s,r)=>s+r[8],0)), '',
      round2(rows.reduce((s,r)=>s+r[10],0)),
      round2(rows.reduce((s,r)=>s+r[11],0))
    ];
    const sheetData = [header, ...rows, totalsRow];
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = [
      {wch:16},{wch:12},{wch:26},{wch:17},{wch:13},
      {wch:8},{wch:13},{wch:8},{wch:13},{wch:8},{wch:13},{wch:13}
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'GST Invoices');
    const fname = 'GST-Invoices-' + historySummaryYm + '.xlsx';
    XLSX.writeFile(wb, fname);
    toast('✅ Excel file downloaded: ' + fname);
  }).catch(()=>{
    toast('⚠ Could not load Excel export library — check your internet connection');
  });
}

document.getElementById('exportGstExcelBtn').addEventListener('click', exportGstInvoicesToExcel);

/* ===================== Vector (real-text) PDF engine =====================
   Every visible character is drawn as genuine selectable/searchable PDF
   text (via jsPDF's own text API + AutoTable), never a screenshot — so
   tools like Excel VBA can reliably open the PDF and extract fields.
   Field labels are kept exact ("Invoice No:", "Billing To:", "GSTIN:",
   "TOTAL INVOICE VALUE") so a VBA macro can search for the label text and
   read whatever follows it. The visual layout (logos, watermark, signature,
   colours, bank box) mirrors the original design as closely as jsPDF's
   drawing primitives allow. */
function buildInvoicePdf(inv){
  return ensurePdfLibs().then(() => {
    const { jsPDF } = window.jspdf;

    // Pass 1 (silent measurement): render once on a throwaway document just
    // to find out how tall the content actually is and how many pages it
    // needs. Nothing from this pass is shown to the user.
    const measureDoc = new jsPDF('p', 'mm', 'a4');
    const measured = renderInvoicePdfContent(measureDoc, inv, { measureOnly: true });

    // Pass 2 (real): draw the watermark centred on the item table + totals
    // block measured above (matching the app's design) — it naturally
    // shifts as the table has more or fewer rows.
    const pdf = new jsPDF({ orientation:'p', unit:'mm', format:'a4', compress:true });
    renderInvoicePdfContent(pdf, inv, { measureOnly: false, tableCenterY: measured.pages === 1 ? measured.tableCenterY : null });
    return pdf;
  });
}

function renderInvoicePdfContent(pdf, inv, opts){
  const st = SS(inv);
    const pageW = 210, pageH = 297;
    const margin = 12;
    const contentW = pageW - margin * 2;
    const NAVY = [18,37,63];
    const AMBER = [200,134,42];
    const NAVY_PALE = [237,241,246];
    const GRAY_BORDER = [153,153,153];

    const gst = inv.totals.gst;
    const gstOn = gst.gstOn !== false;
    const gstPctUsed = gstOn ? (gst.intra ? (gst.cgst + gst.sgst) : gst.igst) : 0;

    // Watermark centring: for a single-page invoice (the common case), use
    // the vertical mid-point of the item TABLE + TOTALS block specifically
    // (measured in pass 1) — this is where the reference design keeps it,
    // and it naturally shifts up/down as the table grows or shrinks. For
    // multi-page invoices, each page is densely filled with table rows
    // top-to-bottom anyway, so the page's geometric centre works well.
    function drawWatermark(){
      if(opts.measureOnly) return;
      let centerY = pageH / 2;
      if(opts.tableCenterY){
        centerY = opts.tableCenterY;
      }
      centerY += pageH * 0.10; // shift down 10% of the page
      pdf.saveGraphicsState();
      pdf.setGState(new pdf.GState({ opacity: 0.13 }));
      pdf.setFont('helvetica','bold');
      pdf.setFontSize(30);
      pdf.setTextColor(AMBER[0], AMBER[1], AMBER[2]);
      pdf.text('SANT SALES & SERVICE', pageW/2, centerY, { align:'center', angle: 18 }); // 10° more clockwise than before
      pdf.restoreGraphicsState();
      pdf.setTextColor(0,0,0);
    }

    let y = margin;
    drawWatermark();

    // ---- Header: logos either side, title centred ----
    const logoW = 24, logoH = 13;
    try{ pdf.addImage(LOGO_INALSA, 'JPEG', margin, y, logoW, logoH, undefined, 'MEDIUM'); }catch(e){}
    try{ pdf.addImage(LOGO_VENUS, 'JPEG', pageW - margin - logoW, y, logoW, logoH, undefined, 'MEDIUM'); }catch(e){}
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(15);
    pdf.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    pdf.text(gstOn ? 'TAX INVOICE' : 'INVOICE', pageW/2, y + logoH/2 + 2, { align:'center' });
    y += logoH + 3;
    pdf.setDrawColor(NAVY[0],NAVY[1],NAVY[2]);
    pdf.setLineWidth(0.6);
    pdf.line(margin, y, pageW-margin, y);
    y += 5.5;

    pdf.setFont('helvetica','bold');
    pdf.setFontSize(13);
    pdf.setTextColor(0,0,0);
    pdf.text(st.companyName || '', pageW/2, y, {align:'center'});
    y += 5;
    pdf.setFont('helvetica','normal');
    pdf.setFontSize(9);
    pdf.text(st.address || '', pageW/2, y, {align:'center'});
    y += 4.3;
    pdf.text('Contact: '+(st.contact||'')+'   Email: '+(st.email||''), pageW/2, y, {align:'center'});
    y += 5;
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(9.5);
    pdf.setTextColor(AMBER[0],AMBER[1],AMBER[2]);
    pdf.text('INALSA/VENUS Authorised Service Center', pageW/2, y, {align:'center'});
    y += 4;
    pdf.setTextColor(0,0,0);
    pdf.setDrawColor(GRAY_BORDER[0],GRAY_BORDER[1],GRAY_BORDER[2]);
    pdf.setLineWidth(0.2);
    pdf.line(margin, y, pageW-margin, y);
    y += 5.5;

    pdf.setFont('helvetica','normal');
    pdf.setFontSize(9);
    pdf.text('GSTIN: '+(st.gstin||'')+'   State Code: '+(st.stateCode||''), margin, y);
    pdf.text('PAN: '+(st.pan||''), pageW-margin, y, {align:'right'});
    y += 7;

    // ---- Billing To (left) / Invoice No + Date (right) ----
    const leftX = margin, rightX = pageW-margin;
    let leftY = y, rightY = y;
    pdf.setFont('helvetica','bold'); pdf.setFontSize(9);
    pdf.text('Billing To:', leftX, leftY); leftY += 4.3;
    pdf.setFont('helvetica','normal');
    pdf.text(inv.buyer.name||'', leftX, leftY); leftY += 4.3;
    if(inv.buyer.address){
      pdf.splitTextToSize(inv.buyer.address, contentW*0.55).forEach(line=>{ pdf.text(line, leftX, leftY); leftY += 4.3; });
    }
    if(inv.buyer.mobile){ pdf.text('Mobile: '+inv.buyer.mobile, leftX, leftY); leftY += 4.3; }
    pdf.text('GSTIN: '+(inv.buyer.gstin||'')+'   State Code: '+(inv.buyer.stateCode||''), leftX, leftY); leftY += 4.3;

    pdf.setFont('helvetica','bold');
    pdf.text('Invoice No: ' + (inv.invoiceNo||''), rightX, rightY, {align:'right'}); rightY += 4.3;
    pdf.text('Date: ' + (inv.date||''), rightX, rightY, {align:'right'}); rightY += 4.3;

    y = Math.max(leftY, rightY) + 3;
    const tableStartY = y;

    // ---- Items table (real text cells, auto-paginates with repeating header) ----
    const head = [['Sr','Description','HSN','Qty','Rate','Taxable']];
    const body = inv.items.map((it,i) => {
      const amt = (it.qty||0)*(it.rate||0);
      const tax = it.taxIncl ? amt/(1+gstPctUsed/100) : amt;
      const descText = it.desc + (it.code ? ' ('+it.code+')' : '');
      return [String(i+1), descText, it.hsn||'', String(it.qty), fmt(it.rate), fmt(tax)];
    });

    pdf.autoTable({
      head, body,
      startY: y,
      margin: { left: margin, right: margin, bottom: margin },
      styles: { font:'helvetica', fontSize: 8.5, cellPadding: 1.5, lineColor: GRAY_BORDER, lineWidth: 0.15, textColor: [0,0,0] },
      headStyles: { fillColor: NAVY_PALE, textColor: [0,0,0], fontStyle:'bold' },
      columnStyles: {
        0: { cellWidth: 8, halign:'center' },
        2: { cellWidth: 20 },
        3: { cellWidth: 14, halign:'right' },
        4: { cellWidth: 22, halign:'right' },
        5: { cellWidth: 24, halign:'right' }
      },
      didDrawPage: function(){ drawWatermark(); }
    });

    y = pdf.lastAutoTable.finalY + 4;

    function ensureSpace(neededMM){
      if(y + neededMM > pageH - margin){
        pdf.addPage();
        drawWatermark();
        y = margin;
      }
    }

    // ---- Totals (all in one bordered table) ----
    ensureSpace(65);
    const boxRows = [];
    const svcAmt = inv.totals.serviceAmt || 0;
    const plainTaxable = !(inv.totals.discountPct > 0);
    if(svcAmt > 0 && plainTaxable) boxRows.push(['Taxable Value', fmt(inv.totals.taxable - svcAmt), false]);
    if(inv.totals.discountPct > 0){
      boxRows.push(['Taxable Value (before discount)', fmt(inv.totals.rawTaxable ?? inv.totals.taxable), false]);
      boxRows.push(['Discount @ '+(Math.round(inv.totals.discountPct*100)/100)+'%', '-'+fmt(inv.totals.discountAmt), false]);
    }
    if(svcAmt > 0) boxRows.push([String(inv.totals.serviceDesc || 'Service Charges').slice(0,24), fmt(svcAmt), false]);
    if(gstOn){
      if(gst.intra){
        boxRows.push(['CGST @ '+gst.cgst+'%', fmt(inv.totals.cgstAmt), false]);
        boxRows.push(['SGST @ '+gst.sgst+'%', fmt(inv.totals.sgstAmt), false]);
      } else {
        boxRows.push(['IGST @ '+gst.igst+'%', fmt(inv.totals.igstAmt), false]);
      }
    }
    if(plainTaxable && !(svcAmt > 0)) boxRows.push(['Taxable Value', fmt(inv.totals.taxable), false]);
    boxRows.push(['TOTAL INVOICE VALUE', 'Rs. ' + fmt(inv.totals.rounded), true]);

    const boxW = 78, rowH = 7.2;
    const boxX = pageW - margin - boxW, boxY = y;
    pdf.setDrawColor(GRAY_BORDER[0],GRAY_BORDER[1],GRAY_BORDER[2]);
    pdf.setLineWidth(0.25);
    pdf.rect(boxX, boxY, boxW, rowH*boxRows.length);
    for(let i=1;i<boxRows.length;i++){ pdf.line(boxX, boxY+rowH*i, boxX+boxW, boxY+rowH*i); }
    pdf.line(boxX+boxW*0.5, boxY, boxX+boxW*0.5, boxY+rowH*boxRows.length);
    boxRows.forEach((row, i)=>{
      pdf.setFont('helvetica', row[2] ? 'bold' : 'normal');
      pdf.setFontSize(row[2] ? 9.5 : 8.7);
      const rowMidY = boxY + rowH*i + rowH/2 + 1.5; // vertically centred within the row, clear of both divider lines
      pdf.text(row[0], boxX+2.5, rowMidY);
      pdf.text(row[1], boxX+boxW-2.5, rowMidY, {align:'right'});
    });
    y = boxY + rowH*boxRows.length;
    const totalsEndY = y;
    y += 6;

    // Amount in Words — left-aligned, full width, clearly above Terms & Conditions
    pdf.setFont('helvetica','bold');
    pdf.setFontSize(8.5);
    pdf.setTextColor(40,40,40);
    const wordsLabel = 'Amount in Words: ';
    const wordsLabelW = pdf.getTextWidth(wordsLabel);
    pdf.text(wordsLabel, margin, y);
    pdf.setFont('helvetica','italic');
    const wordsLines = pdf.splitTextToSize(numberToWordsIndian(inv.totals.rounded), contentW - wordsLabelW);
    pdf.text(wordsLines, margin + wordsLabelW, y);
    pdf.setTextColor(0,0,0);
    y += wordsLines.length * 3.6 + 3;

    // ---- Terms & Conditions ----
    if(inv.showTerms !== false){
      ensureSpace(15);
      pdf.setDrawColor(180,180,180);
      pdf.setLineDashPattern([1,1], 0);
      pdf.line(margin, y, pageW-margin, y);
      pdf.setLineDashPattern([], 0);
      y += 3.6;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(7.5);
      pdf.setTextColor(80,80,80);
      pdf.text('Terms & Conditions:', margin, y);
      const labelW = pdf.getTextWidth('Terms & Conditions: ');
      pdf.setFont('helvetica','normal');
      const warrantyMonths = (inv.warrantyMonths !== undefined && inv.warrantyMonths !== null) ? inv.warrantyMonths : 3;
      const termsText = 'Spare parts carry a warranty of ' + warrantyMonths + ' months from the date of this invoice. Service charges are valid for a period of 1 month from the date of service. Warranty is applicable only against manufacturing defects and does not cover physical damage, misuse, or issues arising from unauthorised repairs.';
      const termsLines = pdf.splitTextToSize(termsText, contentW - labelW - 1);
      pdf.text(termsLines, margin + labelW + 1, y);
      y += termsLines.length * 3.2 + 4;
      pdf.setTextColor(0,0,0);
    }

    // ---- Bank Details (GST invoices only) + Signature ----
    ensureSpace(42);
    const showBank = inv.type !== 'normal';
    if(showBank){
      const boxX = margin, boxW = 88, boxY = y;
      let by = boxY + 4.5;
      pdf.setFont('helvetica','bold'); pdf.setFontSize(8.5);
      pdf.text('BANK DETAILS', boxX+3, by); by += 4.2;
      pdf.setFontSize(8);
      [['Bank Name:','Indian Overseas Bank'],['Branch:','Sector 28 Faridabad'],
       ['Account Number:','183402000001164'],['Account Name:','M/S SANT SALES & SERVICE'],
       ['Account Type:','CAA - GOLD'],['IFSC Code:','IOBA0001834']].forEach(([label,val])=>{
        pdf.setFont('helvetica','bold'); pdf.text(label, boxX+3, by);
        const lw = pdf.getTextWidth(label+' ');
        pdf.setFont('helvetica','normal'); pdf.text(val, boxX+3+lw, by);
        by += 3.9;
      });
      pdf.setDrawColor(GRAY_BORDER[0],GRAY_BORDER[1],GRAY_BORDER[2]);
      pdf.setLineWidth(0.2);
      pdf.rect(boxX, boxY, boxW, by-boxY+2);
    }

    let sigY = y + 4;
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9);
    pdf.text('For ' + (st.companyName||''), pageW-margin, sigY, {align:'right'});
    const sig = getSignature();
    if(sig){
      try{
        const sigFmt = sig.indexOf('image/png') !== -1 ? 'PNG' : 'JPEG';
        pdf.addImage(sig, sigFmt, pageW-margin-40, sigY+2, 32, 16, undefined, 'MEDIUM');
      }catch(e){}
      sigY += 20;
    } else {
      sigY += 16;
    }
    pdf.setFont('helvetica','normal'); pdf.setFontSize(9);
    pdf.text('Authorised Signatory', pageW-margin, sigY, {align:'right'});

    return { pages: pdf.internal.getNumberOfPages(), finalY: sigY, tableCenterY: (tableStartY + totalsEndY) / 2 };
}

function printInvoice(inv){
  toast('Preparing PDF…');
  buildInvoicePdf(inv).then((pdf) => {
    pdf.save('Invoice-' + (inv.invoiceNo || 'draft') + '.pdf');
  }).catch(() => {
    alert('There was a problem creating the PDF. Please check your internet connection and try again.');
  });
}

let currentlyViewedInvoice = null;

function viewInvoicePdf(inv){
  currentlyViewedInvoice = inv;
  document.getElementById('pdfViewFrame').innerHTML = invoiceHtml(inv);
  document.getElementById('pdfViewTitle').textContent = 'Invoice ' + (inv.invoiceNo || '');
  document.getElementById('pdfViewModal').style.display = 'flex';
  history.pushState({view: currentViewName, modal:true}, '', location.pathname + location.search);
}

function closePdfViewModal(){
  document.getElementById('pdfViewModal').style.display = 'none';
  document.getElementById('pdfViewFrame').innerHTML = '';
  currentlyViewedInvoice = null;
}

document.getElementById('pdfViewCloseBtn').addEventListener('click', ()=>{
  if(history.state && history.state.modal){ history.back(); } else { closePdfViewModal(); }
});

document.getElementById('pdfViewShareBtn').addEventListener('click', ()=>{
  if(currentlyViewedInvoice) shareInvoice(currentlyViewedInvoice);
});

document.getElementById('pdfViewChatBtn').addEventListener('click', ()=>{
  const inv = currentlyViewedInvoice;
  if(!inv) return;
  let mobile = (inv.buyer && inv.buyer.mobile ? inv.buyer.mobile : '').replace(/\D/g, '');
  // Strip a leading trunk-access 0 (e.g. "09876543210") before adding the
  // country code, otherwise wa.me gets a 12-digit number it can't route.
  while(mobile.length > 10 && mobile.charAt(0) === '0') mobile = mobile.slice(1);
  if(!mobile){ toast('⚠ No mobile number saved for this bill'); return; }
  if(mobile.length === 10) mobile = '91' + mobile; // add India country code if not already present
  const msg = 'Hello, your invoice ' + (inv.invoiceNo||'') + ' is ready. Sharing the PDF shortly.';
  window.open('https://wa.me/' + mobile + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
});

function shareInvoice(inv){
  toast('Preparing PDF…');
  buildInvoicePdf(inv).then((pdf) => {
    const blob = pdf.output('blob');
    const fileName = 'Invoice-' + (inv.invoiceNo || 'draft') + '.pdf';
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if(navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({
        files: [file],
        title: 'Invoice ' + (inv.invoiceNo || ''),
        text: 'Invoice ' + (inv.invoiceNo || '') + ' - ' + SS(inv).companyName
      }).catch(() => {});
    } else {
      alert('Direct share is not supported on this device. Use "Download PDF" and attach it manually via WhatsApp.');
      pdf.save(fileName);
    }
  }).catch(() => {
    alert('There was a problem creating the PDF. Please check your internet connection and try again.');
  });
}

/* ===================== History view ===================== */
let historyFilter = 'normal';
let historySearchQuery = '';

function invoiceTypeOf(inv){
  if(inv.type === 'gst' || inv.type === 'normal') return inv.type;
  const gstRegex = prefixToRegex(settings.gstPrefix);
  return (gstRegex && gstRegex.test(inv.invoiceNo||'')) ? 'gst' : 'normal';
}

function invoiceMatchesSearch(inv, q){
  if(!q) return true;
  const haystackParts = [inv.buyer.name, inv.buyer.mobile, inv.invoiceNo]
    .concat((inv.items||[]).map(it=>it.desc));
  return matchesQuery(haystackParts.join(' '), q);
}

let historySummaryYm = localCurrentYm();
function formatYm(ym){
  const [y,m] = ym.split('-').map(Number);
  return MONTH_NAMES[m-1] + ' ' + y;
}
function populateHistMonthOptions(){
  const sel = document.getElementById('histMonthSelect');
  const currentYm = localCurrentYm();
  const yms = new Set([currentYm, historySummaryYm]);
  invoices.forEach(inv=>{
    const ym = (inv.date||'').slice(0,7);
    if(ym && ym <= currentYm) yms.add(ym);
  });
  const sorted = Array.from(yms).sort().reverse();
  const optionsHtml = sorted.map(ym=>'<option value="'+ym+'">'+esc(formatYm(ym))+'</option>').join('');
  if(sel.innerHTML !== optionsHtml) sel.innerHTML = optionsHtml;
  if(sel.value !== historySummaryYm) sel.value = historySummaryYm;
}
document.getElementById('histMonthSelect').addEventListener('change', (e)=>{
  historySummaryYm = e.target.value;
  renderHistory();
});

function renderHistorySummary(filtered){
  const monthInvoices = filtered.filter(({inv}) => (inv.date||'').slice(0,7) === historySummaryYm);
  const total = monthInvoices.reduce((s,{inv}) => s + (inv.totals.rounded||0), 0);
  document.getElementById('histSummaryAmt').textContent = '₹' + fmt(total);
  document.getElementById('histSummaryCount').textContent = monthInvoices.length + ' invoice' + (monthInvoices.length===1?'':'s');
  populateHistMonthOptions();
}

function sortHistoryInvoices(list){
  // Always show the most recently CREATED bill first.
  // New bills are inserted with unshift(), while id is the creation timestamp.
  // Editing keeps the original id, so an edited old bill never jumps to the top.
  return list.slice().sort((a,b)=> (Number(b.inv.id)||0) - (Number(a.inv.id)||0));
}

function renderHistory(){
  const box = document.getElementById('historyList');
  const q = historySearchQuery.trim();
  const searching = q.length > 0;
  const filtered = [];
  invoices.forEach((inv, idx)=>{
    const typeOk = invoiceTypeOf(inv)===historyFilter;
    const hf = (typeof getHistFilters==='function') ? getHistFilters() : null;
    const skipMonth = searching || (hf && (hf.from || hf.to));
    const monthOk = skipMonth || (inv.date||'').slice(0,7) === historySummaryYm;
    if(typeOk && monthOk && invoiceMatchesSearch(inv, q) && (!hf || hf.test(inv))) filtered.push({inv, idx});
  });
  renderHistorySummary(invoices.map((inv,idx)=>({inv,idx})));
  if(invoices.length===0){
    box.innerHTML = '<div class="empty"><div class="ic">🧾</div>No invoices saved yet.</div>';
    return;
  }
  if(filtered.length===0){
    box.innerHTML = '<div class="empty"><div class="ic">🔍</div>'+(searching ? 'No invoices match your search.' : 'No invoices for '+formatYm(historySummaryYm)+'.')+'</div>';
    return;
  }
  box.innerHTML = '';
  const sortedFiltered = sortHistoryInvoices(filtered);
  sortedFiltered.forEach(({inv, idx})=>{
    const type = invoiceTypeOf(inv);
    const badge = type==='gst' ? '<span class="hist-badge gst">GST Invoice</span>' : '<span class="hist-badge normal">Invoice</span>';
    const div = document.createElement('div');
    div.className = 'hist-row';
    div.innerHTML = `
      <div class="top"><span>${esc(inv.invoiceNo)}${badge}</span><span>${esc(inv.date)}</span></div>
      <div class="sub">${esc(inv.buyer.name)}${inv.buyer.mobile ? ' · '+esc(inv.buyer.mobile) : ''}</div>
      <div class="amt">₹${fmt(inv.totals.rounded)}</div>
      <div class="hist-actions">
        <button class="btn btn-outline" data-view="${inv.id}">👁 View</button>
        <button class="btn btn-outline" data-edit="${inv.id}">✏️ Edit</button>
        <button class="btn btn-outline" data-wa="${inv.id}" title="WhatsApp">💬</button>
        <button class="btn btn-danger" data-del="${inv.id}">Delete</button>
      </div>`;
    box.appendChild(div);
  });
}

document.getElementById('historySearch').addEventListener('input', (e)=>{
  historySearchQuery = e.target.value;
  renderHistory();
});

document.getElementById('historyFilter').addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-filter]');
  if(!btn) return;
  historyFilter = btn.dataset.filter;
  document.querySelectorAll('.hist-filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderHistory();
});

document.getElementById('historyList').addEventListener('click', (e)=>{
  // Buttons carry the invoice's stable `id` (its creation timestamp), NOT a
  // positional index. A cloud sync that adds/removes invoices between the
  // list being rendered and a button being tapped used to shift array
  // indexes — which could delete or edit the WRONG invoice. Looking the
  // invoice up by id is immune to that.
  function findIdxById(id){
    return invoices.findIndex(inv => String(inv.id) === String(id));
  }
  const vb = e.target.closest('[data-view]');
  if(vb){ const i = findIdxById(vb.dataset.view); if(i !== -1) viewInvoicePdf(invoices[i]); return; }
  const eb = e.target.closest('[data-edit]');
  if(eb){ const i = findIdxById(eb.dataset.edit); if(i !== -1) loadInvoiceForEdit(i); return; }
  const pb = e.target.closest('[data-print]');
  if(pb){ const i = findIdxById(pb.dataset.print); if(i !== -1) printInvoice(invoices[i]); return; }
  const sb = e.target.closest('[data-share]');
  if(sb){ const i = findIdxById(sb.dataset.share); if(i !== -1) shareInvoice(invoices[i]); return; }
  const db = e.target.closest('[data-del]');
  if(db){
    const i = findIdxById(db.dataset.del);
    if(i === -1) return;
    if(confirm('Delete this invoice?')){
      deletedInvoices[String(invoices[i].id)] = Date.now();
      LS.set('sss_deleted', deletedInvoices);
      invoices.splice(i,1);
      LS.set('sss_invoices', invoices);
      renderHistory();
    }
  }
});

function loadInvoiceForEdit(idx){
  const inv = invoices[idx];
  if(!inv) return;
  editingIndex = idx;
  const looksLikeGst = invoiceTypeOf(inv) === 'gst';
  setInvoiceMode(looksLikeGst ? 'gst' : 'normal');
  document.getElementById('buyerName').value = inv.buyer.name || '';
  document.getElementById('buyerMobile').value = inv.buyer.mobile || '';
  document.getElementById('buyerAddress').value = inv.buyer.address || '';
  document.getElementById('buyerGstin').value = inv.buyer.gstin || '';
  document.getElementById('buyerState').value = inv.buyer.stateCode || '06';
  document.getElementById('invoiceNo').value = inv.invoiceNo || '';
  document.getElementById('invoiceDate').value = inv.date || '';
  if(inv.totals.discountMode === 'amt'){
    discountSource = 'amt';
    document.getElementById('invoiceDiscountAmt').value = inv.totals.discountAmt || '';
    document.getElementById('invoiceDiscount').value = '';
  } else {
    discountSource = 'pct';
    document.getElementById('invoiceDiscount').value = inv.totals.discountPct ? String(Math.round(inv.totals.discountPct*10000)/10000) : '';
    document.getElementById('invoiceDiscountAmt').value = '';
  }
  setSvcDesc((inv.totals.serviceAmt > 0 && inv.totals.serviceDesc) ? inv.totals.serviceDesc : 'Service Charges');
  document.getElementById('svcAmt').value = (inv.totals.serviceAmt > 0) ? inv.totals.serviceAmt : '';
  document.getElementById('gstToggle').value = (inv.totals.gst && inv.totals.gst.gstOn===false) ? 'without' : 'with';
  document.getElementById('showTermsToggle').checked = inv.showTerms !== false;
  document.getElementById('warrantyMonths').value = (inv.warrantyMonths !== undefined && inv.warrantyMonths !== null) ? inv.warrantyMonths : 3;
  currentItems = inv.items.map(it => ({...it}));
  renderItems();
  document.getElementById('saveInvoiceBtn').textContent = 'Update Invoice';
  switchToView('invoice', document.querySelector('.tab[data-view="invoice"]'));
  toast('Editing invoice ' + inv.invoiceNo);
}

/* ===================== Settings view ===================== */
function loadSettingsForm(){
  document.getElementById('setCompanyName').value = settings.companyName;
  document.getElementById('setAddress').value = settings.address;
  document.getElementById('setContact').value = settings.contact;
  document.getElementById('setEmail').value = settings.email;
  document.getElementById('setGstin').value = settings.gstin;
  document.getElementById('setState').value = settings.stateCode;
  document.getElementById('setPan').value = settings.pan;
  document.getElementById('setGstRate').value = settings.gstRate;
  document.getElementById('setPrefix').value = settings.prefix;
  document.getElementById('setNextNum').value = settings.nextNum;
  document.getElementById('setGstPrefix').value = settings.gstPrefix;
  document.getElementById('setGstNextNum').value = settings.gstNextNum;
  updateSignaturePreview();
}

function updateSignaturePreview(){
  const box = document.getElementById('signaturePreviewBox');
  const img = document.getElementById('signaturePreviewImg');
  const sig = getSignature();
  if(sig){
    img.src = sig;
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
}

document.getElementById('uploadSignBtn').addEventListener('click', ()=>document.getElementById('signFile').click());
document.getElementById('signFile').addEventListener('change', (e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    settings.signatureImage = ev.target.result;
    LS.set('sss_settings', settings);
    updateSignaturePreview();
    toast('Signature saved');
  };
  reader.readAsDataURL(file);
});

document.getElementById('removeSignBtn').addEventListener('click', ()=>{
  settings.signatureImage = '';
  LS.set('sss_settings', settings);
  updateSignaturePreview();
  toast('Signature removed');
});

document.getElementById('saveSettingsBtn').addEventListener('click', ()=>{
  const prevSettings = settings;
  settings = Object.assign({}, prevSettings, {
    companyName: document.getElementById('setCompanyName').value,
    address: document.getElementById('setAddress').value,
    contact: document.getElementById('setContact').value,
    email: document.getElementById('setEmail').value,
    gstin: document.getElementById('setGstin').value,
    stateCode: document.getElementById('setState').value,
    pan: document.getElementById('setPan').value,
    gstRate: parseFloat(document.getElementById('setGstRate').value)||18,
    prefix: document.getElementById('setPrefix').value,
    nextNum: parseInt(document.getElementById('setNextNum').value)||1,
    gstPrefix: document.getElementById('setGstPrefix').value,
    gstNextNum: parseInt(document.getElementById('setGstNextNum').value)||1,
    signatureImage: prevSettings.signatureImage
  });
  LS.set('sss_settings', settings);
  // A number typed here on purpose is pushed to the shared cloud counter.
  try{
    if(cloudDb && cloudOnline){
      if(settings.nextNum !== (parseInt(prevSettings.nextNum)||1)) cloudDb.ref('counters/normal').set(settings.nextNum).catch(()=>{});
      if(settings.gstNextNum !== (parseInt(prevSettings.gstNextNum)||1)) cloudDb.ref('counters/gst').set(settings.gstNextNum).catch(()=>{});
    }
  }catch(e){}
  toast('Settings saved');
});

document.getElementById('exportBtn').addEventListener('click', ()=>{
  const data = { settings, overrides, customParts, invoices, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sss-invoice-backup-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
});

document.getElementById('importBtn').addEventListener('click', ()=>document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e)=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    try{
      const data = JSON.parse(ev.target.result);
      if(!confirm('Restore this backup?\n\nBills in the file: ' + (Array.isArray(data.invoices)?data.invoices.length:0) + '\nYour current bills: ' + invoices.length + '\n\nBills are merged (newest version of each bill wins); nothing is deleted.')){ e.target.value=''; return; }
      if(data.settings) settings = data.settings;
      if(data.overrides) overrides = data.overrides;
      if(data.customParts) customParts = data.customParts;
      if(data.invoices){ data.invoices.forEach(inv=>{ if(inv && inv.id!==undefined) delete deletedInvoices[String(inv.id)]; stripInvSnapshot(inv); }); invoices = mergeInvoicesByLatest(invoices, data.invoices); LS.set('sss_deleted', deletedInvoices); }
      LS.set('sss_settings', settings); LS.set('sss_price_overrides', overrides);
      LS.set('sss_custom_parts', customParts); LS.set('sss_invoices', invoices);
      refreshParts(); renderPartList(); loadSettingsForm();
      toast('Data restored');
    }catch(err){ alert('Error reading file.'); }
  };
  reader.readAsText(file);
});

/* ===================== Cloud Sync (Firebase) ===================== */
const firebaseConfig = {
  apiKey: "AIzaSyCtPNQJDccvbZvxNgWldb8Wqw_lu10DAAo",
  authDomain: "santsalesinvoice.firebaseapp.com",
  databaseURL: "https://santsalesinvoice-default-rtdb.firebaseio.com",
  projectId: "santsalesinvoice",
  storageBucket: "santsalesinvoice.firebasestorage.app",
  messagingSenderId: "1048466583399",
  appId: "1:1048466583399:web:75c27ac49bb4464b3d49c2"
};

// Fixed app account — locks Firebase access to only this app (via its
// rules checking auth.uid), instead of any random anonymous session.
const APP_CLOUD_EMAIL = 'sss-invoice-inalsa@santsalesservice.com';
let srvOff = 0;                       // server-time offset (ms), set once Firebase connects
function nowTs(){ return Date.now() + srvOff; }

// The cloud password is typed once per device and kept only on that device.
function askCloudPassword(msg){
  return new Promise(resolve=>{
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,20,35,.85);display:flex;align-items:center;justify-content:center;padding:20px;';
    o.innerHTML = '<div style="background:#fff;color:#16233A;border-radius:14px;padding:20px;max-width:340px;width:100%;font-family:Inter,sans-serif;">'
      + '<div style="font-weight:700;font-size:16px;margin-bottom:6px;">Cloud sync login</div>'
      + '<div id="cpMsg" style="font-size:13px;color:#5C6B7A;margin-bottom:10px;"></div>'
      + '<input id="cpPw" type="password" autocomplete="off" placeholder="Cloud password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DEE5EC;border-radius:8px;font-size:15px;">'
      + '<div style="display:flex;gap:8px;margin-top:12px;"><button id="cpSkip" style="flex:1;padding:10px;border:1px solid #DEE5EC;background:#fff;border-radius:8px;">Skip</button>'
      + '<button id="cpOk" style="flex:1;padding:10px;border:0;background:#12253F;color:#fff;border-radius:8px;font-weight:600;">Connect</button></div></div>';
    document.body.appendChild(o);
    o.querySelector('#cpMsg').textContent = msg || 'Enter the cloud password once on this device.';
    const done = v=>{ o.remove(); resolve(v); };
    o.querySelector('#cpOk').onclick = ()=>{ const v = o.querySelector('#cpPw').value; if(v) done(v); };
    o.querySelector('#cpSkip').onclick = ()=>done(null);
    o.querySelector('#cpPw').addEventListener('keydown', e=>{ if(e.key==='Enter') o.querySelector('#cpOk').click(); });
  });
}

function cloudSignIn(pw, msg){
  const go = p => firebase.auth().signInWithEmailAndPassword(APP_CLOUD_EMAIL, p).then(()=>{
    try{ localStorage.setItem('sss_cloud_pw', p); }catch(e){}
  });
  const ask = m => askCloudPassword(m).then(p=>{
    if(!p) return Promise.reject({code:'skipped'});
    return go(p).catch(err=>{
      const c = String(err && err.code || '');
      if(/wrong-password|invalid-credential|invalid-login|user-not-found/.test(c)) return ask('Wrong password, try again.');
      throw err;
    });
  });
  if(pw) return go(pw).catch(err=>{
    const c = String(err && err.code || '');
    if(/wrong-password|invalid-credential|invalid-login|user-not-found/.test(c)){
      try{ localStorage.removeItem('sss_cloud_pw'); }catch(e){}
      return ask('Saved password no longer works. Enter the new one.');
    }
    throw err;
  });
  return ask(msg);
}

function initCloudSync(){
  try{
    if(typeof firebase === 'undefined'){ console.warn('Firebase SDK not loaded, cloud sync disabled'); setCloudStatus('offline'); return; }
    firebase.initializeApp(firebaseConfig);
    setCloudStatus('syncing');
    let saved = null; try{ saved = localStorage.getItem('sss_cloud_pw'); }catch(e){}
    cloudSignIn(saved).then(()=>{
      cloudDb = firebase.database();
      listenToCloud();
      try{ if(localStorage.getItem('sss_snap_push_pending')){ localStorage.removeItem('sss_snap_push_pending'); pushToCloud(); } }catch(e){}
      tryCloudGuardedFYReset();
    }).catch(err=>{
      console.warn('App sign-in failed, cloud sync disabled', err);
      setCloudStatus('offline');
    });
  }catch(e){ console.warn('Cloud sync unavailable', e); setCloudStatus('offline'); }
}

function mergeInvoicesByLatest(localList, remoteList){
  const byId = new Map();
  (Array.isArray(remoteList) ? remoteList : []).forEach(inv=>{
    if(!inv || inv.id === undefined || inv.id === null) return;
    const key = String(inv.id);
    if(deletedInvoices[key]) return;
    stripInvSnapshot(inv);
    if(!inv.updatedAt) inv.updatedAt = Number(inv.id) || Date.now();
    byId.set(key, inv);
  });
  (Array.isArray(localList) ? localList : []).forEach(inv=>{
    if(!inv || inv.id === undefined || inv.id === null) return;
    const key = String(inv.id);
    if(deletedInvoices[key]) return;
    stripInvSnapshot(inv);
    if(!inv.updatedAt) inv.updatedAt = Number(inv.id) || Date.now();
    const remote = byId.get(key);
    const localTime = Number(inv.updatedAt) || Number(inv.id) || 0;
    const remoteTime = remote ? (Number(remote.updatedAt) || Number(remote.id) || 0) : -1;
    if(!remote || localTime >= remoteTime) byId.set(key, inv);
  });
  return Array.from(byId.values()).sort((a,b)=>
    (Number(b.id)||0) - (Number(a.id)||0)
  );
}

/* ===================== Cloud sync v2 =====================
   WHY THE OLD SYNC WAS SLOW: every bill, setting and price lived inside ONE
   cloud node ("backup"). Each save re-uploaded that whole node (all bills)
   and every device re-downloaded all of it again. Now each bill is its own
   small node, so a save sends only the bill that changed, and other devices
   receive only that bill. The old "backup" node is read once to migrate and
   is then left untouched. */
const V2 = 'backup/v2';
let cloudMeta = {};          // invoiceId -> updatedAt that is known to be in the cloud
let cloudDeletedKnown = {};  // invoiceId -> true when a delete marker exists in the cloud
let cloudSimple = {settings:null, overrides:null, customParts:null}; // last known cloud value (stable JSON)
let cloudOnline = false, initialLoaded = false, v2Ready = false;
let invApplyTimer = null, partsApplyTimer = null;

// Settings as sent to the cloud: the app-lock PIN never leaves the device.
function cloudSettings(v){ const c = Object.assign({}, v); delete c.appPin; delete c.appPinHash; delete c.nextNum; delete c.gstNextNum; return c; }
function stableStr(v){
  if(v === null || typeof v !== 'object') return JSON.stringify(v);
  if(Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableStr(v[k])).join(',') + '}';
}
function invTime(inv){ return Number(inv && inv.updatedAt) || Number(inv && inv.id) || 0; }
function toArr(x){ return Array.isArray(x) ? x : (x && typeof x === 'object' ? Object.keys(x).map(k=>x[k]) : []); }
function cloudClean(v){ return JSON.parse(JSON.stringify(v)); }
function viewActive(n){ const el = document.getElementById('view-'+n); return !!(el && el.classList.contains('active')); }

function scheduleInvApply(){
  clearTimeout(invApplyTimer);
  invApplyTimer = setTimeout(()=>{
    invoices.sort((a,b)=>(Number(b.id)||0)-(Number(a.id)||0));
    try{ const seen = {}; invoices.forEach(x=>{ const n = x && x.invoiceNo; if(!n) return; if(seen[n] && seen[n] !== String(x.id)){ toast('⚠ Duplicate invoice number: ' + n); } seen[n] = String(x.id); }); }catch(e){}
    try{ localStorage.setItem('sss_invoices', JSON.stringify(invoices)); }catch(e){}
    try{ reconcileNextNumbers(); refreshAutoInvoiceNumber(); syncCounters(); }catch(e){}
    if(viewActive('history')) renderHistory();
  }, 200);
}
function schedulePartsApply(){
  clearTimeout(partsApplyTimer);
  partsApplyTimer = setTimeout(()=>{ refreshParts(); renderPartList(); }, 200);
}

function onInvRemote(snap){
  const inv = snap.val(); if(!inv || typeof inv !== 'object') return;
  const id = String(snap.key), t = invTime(inv);
  cloudMeta[id] = t;
  if(deletedInvoices[id]) return;
  if(inv.id === undefined) inv.id = isNaN(Number(id)) ? id : Number(id);
  stripInvSnapshot(inv);
  const i = invoices.findIndex(x=>String(x.id)===id);
  if(i === -1) invoices.push(inv);
  else if(t > invTime(invoices[i])) invoices[i] = inv;
  else return;
  scheduleInvApply();
  if(v2Ready) toast('🔄 Updated from another device');
}
function onDelRemote(snap){
  const id = String(snap.key);
  cloudDeletedKnown[id] = true;
  if(!deletedInvoices[id]){
    deletedInvoices[id] = snap.val() || Date.now();
    try{ localStorage.setItem('sss_deleted', JSON.stringify(deletedInvoices)); }catch(e){}
  }
  const i = invoices.findIndex(x=>String(x.id)===id);
  if(i !== -1){ invoices.splice(i,1); scheduleInvApply(); }
}
function onDelRemoved(snap){
  const id = String(snap.key);
  delete cloudDeletedKnown[id];
  if(deletedInvoices[id]){
    delete deletedInvoices[id];
    try{ localStorage.setItem('sss_deleted', JSON.stringify(deletedInvoices)); }catch(e){}
  }
}
function onSimpleRemote(kind, val){
  if(val === null || val === undefined){ cloudSimple[kind] = null; return; }
  const str = stableStr(kind === 'settings' ? cloudSettings(val) : val);
  if(str === cloudSimple[kind]) return;
  cloudSimple[kind] = str;
  if(kind === 'settings'){
    val = cloudSettings(val);
    const merged = Object.assign({}, settings, val);
    if(stableStr(merged) !== stableStr(settings)){
      settings = merged;
      try{ localStorage.setItem('sss_settings', JSON.stringify(settings)); }catch(e){}
      if(viewActive('settings')) loadSettingsForm();
    }
  } else if(kind === 'overrides'){
    if(stableStr(overrides) !== str){
      overrides = val;
      try{ localStorage.setItem('sss_price_overrides', JSON.stringify(overrides)); }catch(e){}
      schedulePartsApply();
    }
  } else {
    const arr = Array.isArray(val) ? val : toArr(val);
    if(stableStr(customParts) !== stableStr(arr)){
      customParts = arr;
      try{ localStorage.setItem('sss_custom_parts', JSON.stringify(customParts)); }catch(e){}
      schedulePartsApply();
    }
  }
}

/* One-time move of the old single "backup" node into the new layout. */
function migrateLegacy(old){
  old = old || {};
  mergeDeletedFrom(old.deleted);
  invoices = mergeInvoicesByLatest(invoices, toArr(old.invoices));
  if(old.settings && typeof old.settings === 'object') settings = Object.assign({}, settings, cloudSettings(old.settings));
  if(old.overrides && typeof old.overrides === 'object') overrides = Object.assign({}, old.overrides, overrides);
  const parts = new Map();
  toArr(old.customParts).concat(Array.isArray(customParts) ? customParts : []).forEach(p=>{
    p = toArr(p); if(p.length && p[0]) parts.set(String(p[0]), p);
  });
  customParts = Array.from(parts.values());
  try{
    localStorage.setItem('sss_invoices', JSON.stringify(invoices));
    localStorage.setItem('sss_settings', JSON.stringify(settings));
    localStorage.setItem('sss_price_overrides', JSON.stringify(overrides));
    localStorage.setItem('sss_custom_parts', JSON.stringify(customParts));
  }catch(e){}
  refreshParts(); renderPartList();
  if(viewActive('history')) renderHistory();
  const P = V2 + '/', up = {};
  invoices.forEach(inv=>{
    if(inv && inv.id !== undefined && inv.id !== null && !deletedInvoices[String(inv.id)]){
      stripInvSnapshot(inv); up[P+'invoices/'+inv.id] = cloudClean(inv);
    }
  });
  Object.keys(deletedInvoices).forEach(id=>{ up[P+'deleted/'+id] = deletedInvoices[id] || Date.now(); });
  up[P+'settings'] = cloudClean(cloudSettings(settings));
  up[P+'overrides'] = cloudClean(overrides);
  up[P+'customParts'] = cloudClean(customParts);
  const keys = Object.keys(up), chunks = [];
  for(let i=0;i<keys.length;i+=60){ const c = {}; keys.slice(i,i+60).forEach(k=>c[k]=up[k]); chunks.push(c); }
  return chunks.reduce((pr,c)=>pr.then(()=>cloudDb.ref().update(c)), Promise.resolve())
    .then(()=>cloudDb.ref(P+'meta/migrated').set(true));
}

function listenToCloud(){
  if(!cloudDb) return;
  setCloudStatus('syncing');
  cloudDb.ref(V2 + '/meta/migrated').once('value')
    .then(s=> s.val() === true ? null : cloudDb.ref('backup').once('value').then(sn=>migrateLegacy(sn.val())))
    .catch(e=>console.warn('Cloud migration failed, will retry next launch', e))
    .then(startV2Listeners);
}
function startV2Listeners(){
  const base = cloudDb.ref(V2);
  const bad = err=>{ console.warn('Cloud listener failed', err); setCloudStatus('offline'); };
  cloudDb.ref('.info/serverTimeOffset').on('value', s=>{ srvOff = Number(s.val()) || 0; });
  const inv = base.child('invoices');
  inv.on('child_added', onInvRemote, bad);
  inv.on('child_changed', onInvRemote, bad);
  // A bill vanishing from the cloud is never treated as a delete (only delete markers are); just forget it so it is re-uploaded if we still have it.
  inv.on('child_removed', sn=>{ delete cloudMeta[String(sn.key)]; }, bad);
  base.child('deleted').on('child_added', onDelRemote, bad);
  base.child('deleted').on('child_removed', onDelRemoved, bad);
  ['settings','overrides','customParts'].forEach(k=>base.child(k).on('value', s=>onSimpleRemote(k, s.val()), bad));
  cloudDb.ref('.info/connected').on('value', s=>{
    cloudOnline = !!s.val();
    setCloudStatus(cloudOnline ? (cloudSyncing ? 'syncing' : 'connected') : 'offline');
    if(cloudOnline && initialLoaded){ pushToCloud(); syncCounters(); }
  });
  // Live bill-number counters: when the other phone takes a number, this phone's
  // "next number" moves forward immediately.
  ['normal','gst'].forEach(type=>{
    cloudDb.ref('counters/' + type).on('value', s=>{
      const v = parseInt(s.val()); if(!v) return;
      const key = type === 'gst' ? 'gstNextNum' : 'nextNum';
      if(v > (parseInt(settings[key])||1)){
        settings[key] = v;
        try{ localStorage.setItem('sss_settings', JSON.stringify(settings)); }catch(e){}
        refreshAutoInvoiceNumber();
      }
    }, bad);
  });
  // Pushing waits until everything already in the cloud has been received, so a
  // fresh launch never re-uploads bills the cloud already has.
  Promise.all(['invoices','deleted','settings','overrides','customParts'].map(k=>base.child(k).once('value'))).then(()=>{
    initialLoaded = true; firstLoadDone = true;
    setTimeout(()=>{ v2Ready = true; }, 1500);
    pushToCloud();
    try{ reconcileNextNumbers(); refreshAutoInvoiceNumber(); syncCounters(); }catch(e){}
  }).catch(bad);
}

function pushToCloud(){
  if(!cloudDb || !initialLoaded) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(()=>doPushToCloud(0), 250);
}

// Re-connect on demand. The live connection can go quiet in the background; this
// wakes it, and `force` fully resets it (used by the "Sync now" button).
function pullFromCloudOnce(force){
  if(!cloudDb) return;
  try{
    if(force){ cloudDb.goOffline(); setTimeout(()=>{ try{ cloudDb.goOnline(); }catch(e){} }, 400); }
    else cloudDb.goOnline();
  }catch(e){}
}
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible') pullFromCloudOnce(); });

function buildCloudUpdates(){
  const P = V2 + '/', up = {};
  const after = {meta:{}, gone:[], del:[], undel:[], simple:{}};
  Object.keys(deletedInvoices).forEach(id=>{
    if(!cloudDeletedKnown[id]){ up[P+'deleted/'+id] = deletedInvoices[id] || Date.now(); after.del.push(id); }
    if(cloudMeta[id] !== undefined){ up[P+'invoices/'+id] = null; after.gone.push(id); }
  });
  invoices.forEach(inv=>{
    if(!inv || inv.id === undefined || inv.id === null) return;
    const id = String(inv.id);
    if(deletedInvoices[id]) return;
    const t = invTime(inv);
    const restored = !!cloudDeletedKnown[id];
    if(restored){ up[P+'deleted/'+id] = null; after.undel.push(id); }
    if(restored || cloudMeta[id] === undefined || cloudMeta[id] < t){
      stripInvSnapshot(inv);
      up[P+'invoices/'+id] = cloudClean(inv); after.meta[id] = t;
    }
  });
  [['settings',cloudSettings(settings)],['overrides',overrides],['customParts',customParts]].forEach(([k,v])=>{
    const str = stableStr(v);
    const empty = (str === '[]' || str === '{}' || str === 'null' || str === undefined);
    if(empty && cloudSimple[k] === null) return;
    if(str !== cloudSimple[k]){ up[P+k] = cloudClean(v); after.simple[k] = str; }
  });
  return {up, after};
}

function doPushToCloud(attempt){
  if(!cloudDb || !initialLoaded) return;
  let built;
  try{ built = buildCloudUpdates(); }catch(e){ console.warn('Cloud push build failed', e); return; }
  const keys = Object.keys(built.up);
  if(!keys.length){ setCloudStatus(cloudOnline ? 'connected' : 'offline'); return; }
  cloudSyncing = true;
  if(cloudOnline) setCloudStatus('syncing');
  const chunks = [];
  for(let i=0;i<keys.length;i+=60){ const c = {}; keys.slice(i,i+60).forEach(k=>c[k]=built.up[k]); chunks.push(c); }
  Promise.all(chunks.map(c=>cloudDb.ref().update(c))).then(()=>{
    cloudSyncing = false;
    const a = built.after;
    Object.assign(cloudMeta, a.meta);
    a.gone.forEach(id=>{ delete cloudMeta[id]; });
    a.del.forEach(id=>{ cloudDeletedKnown[id] = true; });
    a.undel.forEach(id=>{ delete cloudDeletedKnown[id]; });
    Object.keys(a.simple).forEach(k=>{ cloudSimple[k] = a.simple[k]; });
    setCloudStatus(cloudOnline ? 'connected' : 'offline');
  }).catch(err=>{
    cloudSyncing = false;
    console.warn('Cloud save failed (attempt ' + (attempt+1) + ')', err);
    const next = attempt + 1;
    if(next <= 4){
      setCloudStatus('syncing');
      setTimeout(()=>doPushToCloud(next), Math.min(1500 * Math.pow(2, attempt), 15000));
    } else {
      setCloudStatus('offline');
      toast('⚠ Sync failed — saved on this device only, will retry later');
      setTimeout(()=>doPushToCloud(0), 30000);
    }
  });
}

function setCloudStatus(state){
  const el = document.getElementById('cloudStatus');
  const badge = document.getElementById('syncBadge');
  const badgeText = document.getElementById('syncBadgeText');
  if(el){
    if(state==='connected') el.textContent = '☁️ Synced to cloud';
    else if(state==='syncing') el.textContent = '☁️ Syncing…';
    else el.textContent = '⚠️ Offline (saved on this device only)';
  }
  if(badge && badgeText){
    badge.classList.remove('syncing','offline');
    if(state==='connected'){ badgeText.textContent = 'Synced'; }
    else if(state==='syncing'){ badge.classList.add('syncing'); badgeText.textContent = 'Syncing…'; }
    else { badge.classList.add('offline'); badgeText.textContent = 'Offline'; }
  }
}

/* ---- Sequential & multi-device safe invoice numbering ----
   Uses a Firebase Realtime Database transaction as an atomic "lock":
   the server retries the update until no other device raced it, so two
   phones saving a bill at the same second can never receive the same
   invoice number. Falls back to the local settings counter when offline. */
function nextInvoiceNumber(mode){
  const type = mode === 'gst' ? 'gst' : 'normal';
  const seed = Math.max(parseInt(type === 'gst' ? settings.gstNextNum : settings.nextNum) || 1, histMaxSeq(type) + 1);
  return new Promise((resolve, reject)=>{
    if(!cloudDb) return reject(new Error('cloud not ready'));
    const timer = setTimeout(()=>reject(new Error('timeout')), 12000);
    cloudDb.ref('counters/' + type).transaction(current=>{
      const c = parseInt(current);
      // The cloud counter is the single source of truth; it is never allowed to
      // sit below a bill that already exists in History.
      const base = (isNaN(c) || c < 1) ? seed : Math.max(c, histMaxSeq(type) + 1);
      return base + 1; // stored value = NEXT number to hand out
    }).then(result=>{
      clearTimeout(timer);
      if(!result.committed) return reject(new Error('not committed'));
      resolve(Number(result.snapshot.val()) - 1); // number given to this bill
    }).catch(e=>{ clearTimeout(timer); reject(e); });
  });
}

// Keeps the shared cloud counters at least one above the highest bill in History
// (covers bills made offline, typed numbers, restored backups).
function syncCounters(){
  if(!cloudDb || !cloudOnline) return;
  ['normal','gst'].forEach(type=>{
    const want = histMaxSeq(type) + 1;
    cloudDb.ref('counters/' + type).transaction(cur=>{
      const c = parseInt(cur);
      return (isNaN(c) || c < want) ? want : undefined;
    }).catch(()=>{});
  });
}

window.addEventListener('DOMContentLoaded', initCloudSync);

/* ===================== App Lock (PIN screen) =====================
   Unlocking is remembered for this browser/WebView SESSION (sessionStorage),
   not just in a JS variable — so a pull-to-refresh or any in-app reload,
   which keeps the same tab/session alive, will NOT ask for the PIN again.
   Actually quitting the app (closing the tab / removing it from recents)
   clears sessionStorage, so the PIN is required again on a real fresh
   launch, same as before. This adds no touch/scroll handling of any kind,
   so it can't cause the earlier scrolling problem. */
(function(){
  let entered = '';
  const dotsBox = document.getElementById('pinDots');
  const overlay = document.getElementById('lockOverlay');
  const errBox = document.getElementById('lockError');
  const UNLOCK_KEY = 'sss_unlocked';

  try{
    if(sessionStorage.getItem(UNLOCK_KEY) === '1'){
      overlay.style.display = 'none';
    }
  } catch(e){ /* sessionStorage unavailable — just show the PIN screen as before */ }

  function paintDots(){
    const dots = dotsBox.querySelectorAll('.pd');
    dots.forEach((d, i)=> d.classList.toggle('filled', i < entered.length));
  }

  let fails = 0;
  function tryUnlock(){
    let until = 0; try{ until = Number(localStorage.getItem('sss_lock_until')||0); }catch(e){}
    if(Date.now() < until){
      errBox.textContent = 'Too many wrong tries. Wait ' + Math.ceil((until-Date.now())/1000) + 's';
      entered = ''; paintDots(); return;
    }
    const tried = entered;
    checkPin(tried).then(ok=>{
      if(ok){
        fails = 0; overlay.style.display = 'none'; entered = '';
        try{ sessionStorage.setItem(UNLOCK_KEY, '1'); } catch(e){}
      } else {
        fails++;
        if(fails >= 5){ fails = 0; try{ localStorage.setItem('sss_lock_until', String(Date.now() + 30000)); }catch(e){} }
        errBox.textContent = 'Wrong code, try again';
        overlay.classList.add('lock-shake');
        setTimeout(()=>overlay.classList.remove('lock-shake'), 350);
        entered = ''; paintDots();
      }
    });
  }

  document.getElementById('pinPad').addEventListener('click', (e)=>{
    const btn = e.target.closest('button');
    if(!btn) return;
    const k = btn.dataset.k;
    errBox.textContent = '';
    if(k === 'clear'){ entered = ''; }
    else if(k === 'back'){ entered = entered.slice(0, -1); }
    else if(entered.length < 4){ entered += k; }
    paintDots();
    if(entered.length === 4){ setTimeout(tryUnlock, 120); }
  });

  // Also allow physical keyboard digits (handy for desktop testing)
  document.addEventListener('keydown', (e)=>{
    if(overlay.style.display === 'none') return;
    if(/^[0-9]$/.test(e.key) && entered.length < 4){ entered += e.key; errBox.textContent=''; paintDots(); if(entered.length===4) setTimeout(tryUnlock, 120); }
    else if(e.key === 'Backspace'){ entered = entered.slice(0, -1); paintDots(); }
  });
})();

document.getElementById('saveAppPinBtn').addEventListener('click', ()=>{
  const p1 = document.getElementById('setAppPin').value.trim();
  const p2 = document.getElementById('setAppPinConfirm').value.trim();
  if(!/^\d{4}$/.test(p1)){ alert('Please enter a 4-digit numeric code.'); return; }
  if(p1 !== p2){ alert('Codes do not match.'); return; }
  setPin(p1);
  document.getElementById('setAppPin').value = '';
  document.getElementById('setAppPinConfirm').value = '';
  toast('✅ App lock code updated');
});

/* ===================== Init ===================== */
// Building the full ~12,000-item price list and doing the first render
// is the single heaviest thing this app does at launch. Deferring it
// (same reasoning as above) keeps the PIN screen snappy; by the time a
// person finishes entering their code, this has long since finished.
setTimeout(function(){
  PARTS_CACHE = allParts();
  renderPartList();
  resetInvoiceForm();
}, 0);

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
