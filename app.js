// ═══════════════════════════════════════════════════════════════
// HACCP Pro Cloud — Client Supabase (multi-tenant)
// ═══════════════════════════════════════════════════════════════
// Sostituisce completamente il vecchio backend Google Apps Script.
// Usa Supabase per: autenticazione, database, RLS automatico per azienda.
// La coda offline (h_queue) viene mantenuta per quando manca connessione.
// ═══════════════════════════════════════════════════════════════

// ── CONFIG SUPABASE ─────────────────────────────────────────────
const SUPABASE_URL  = 'https://nmpbrjnmsybpzwhtsola.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tcGJyam5tc3licHp3aHRzb2xhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NjkyMjcsImV4cCI6MjA5MzQ0NTIyN30.yKsvu0lTns1GDF-Htzv8WUBlrjsIm1dkdxkMMCMX_Mc';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

// ── COSTANTI APP ────────────────────────────────────────────────
const AZIONI_PRESET = ["Prodotti spostati","Tecnico chiamato","Impostazioni corrette","Prodotti smaltiti","Porta controllata","Sbrinamento effettuato","In attesa verifica"];

// ── STATO RUNTIME ───────────────────────────────────────────────
let config        = [];
let operatori     = [];
let scheduleSlots = [];
let aziendaCfg    = {};
let cloudData     = [];
let cloudAzioni   = [];
let cloudFirme    = [];
let lastTemps     = JSON.parse(localStorage.getItem('h_lasttemps')) || {};
let offlineQueue  = JSON.parse(localStorage.getItem('h_queue'))     || [];
let corrective    = {};
let currentArea   = 'CUCINA';
let currentOperatore = null;
let currentUserId    = null;
let currentAziendaId = null;
let currentRole      = null;
let currentTermsAccepted = false;
let onlyErr       = false;
let isOnline      = navigator.onLine;
let modalEntry    = null;
let firmaCanvas, firmaCtx, drawing = false;

// ─── UTILITY ─────────────────────────────────────────────────────
function setLoadingMsg(m) {
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = m;
}
function hideLoading() {
  const el = document.getElementById('loading-screen');
  if (el) el.style.display = 'none';
}
function isAdmin() { return currentRole === 'admin' || currentRole === 'superadmin'; }

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
async function init() {
  setLoadingMsg('Verifica sessione...');
  const { data: { session } } = await sb.auth.getSession();

  if (session) {
    extractUserContext(session);
    setLoadingMsg('Caricamento dati...');
    await syncAll();
    hideLoading();
    setupMonthFilter();
    updateDate();
    applyConfig();
    document.getElementById('operatore-badge').textContent = '👤 ' + currentOperatore;
    renderAll();
    await checkTermsAndShow();
    setTimeout(checkStampaBanner, 2000);
  } else {
    hideLoading();
    setupMonthFilter();
    updateDate();
    showLoginScreen();
  }

  initFirmaCanvas();
  checkReminderDot();
  setInterval(checkReminderDot, 60000);
  setInterval(() => { if(isOnline && currentAziendaId) syncTemperature(); }, 120000);
  window.addEventListener('online',  onOnline);
  window.addEventListener('offline', onOffline);
}

function extractUserContext(session) {
  currentUserId    = session.user.id;
  const meta       = session.user.app_metadata || {};
  const userMeta   = session.user.user_metadata || {};
  currentAziendaId = meta.azienda_id || userMeta.azienda_id || null;
  currentRole      = meta.role || userMeta.role || null;
  currentOperatore = userMeta.full_name || userMeta.name || session.user.email;
  console.log('[Auth]', currentOperatore, '| role:', currentRole, '| azienda:', currentAziendaId);
}

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════
function showLoginScreen() {
  document.getElementById('login-pass').value = '';
  document.getElementById('login-err').textContent = '';
  const lastEmail = localStorage.getItem('h_last_email') || '';
  document.getElementById('login-email').value = lastEmail;
  setTimeout(() => {
    if (lastEmail) document.getElementById('login-pass').focus();
    else document.getElementById('login-email').focus();
  }, 100);
  document.getElementById('login-screen').style.display = 'flex';
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const err   = document.getElementById('login-err');
  const btn   = document.getElementById('login-btn');

  if (!email) { err.textContent = "Inserisci l'email"; return; }
  if (!pass)  { err.textContent = 'Inserisci la password'; return; }

  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Accesso in corso...';

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      err.textContent = error.message === 'Invalid login credentials'
        ? 'Email o password non corretti' : ('Errore: ' + error.message);
      btn.disabled = false; btn.textContent = 'Accedi →';
      return;
    }
    extractUserContext(data.session);
    if (!currentAziendaId) {
      err.textContent = "Account non associato a un'azienda. Contatta l'amministratore.";
      await sb.auth.signOut();
      btn.disabled = false; btn.textContent = 'Accedi →';
      return;
    }
    localStorage.setItem('h_last_email', email);
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('operatore-badge').textContent = '👤 ' + currentOperatore;
    setLoadingMsg('Caricamento dati...');
    document.getElementById('loading-screen').style.display = 'flex';
    await syncAll();
    hideLoading();
    applyConfig();
    renderAll();
    await checkTermsAndShow();
    setTimeout(checkStampaBanner, 2000);
    btn.disabled = false; btn.textContent = 'Accedi →';
  } catch(e) {
    err.textContent = 'Errore di rete: ' + e.message;
    btn.disabled = false; btn.textContent = 'Accedi →';
  }
}

async function doLogout() {
  if (!confirm('Vuoi uscire dalla sessione?')) return;
  await sb.auth.signOut();
  currentUserId = null; currentAziendaId = null;
  currentRole = null; currentOperatore = null;
  showLoginScreen();
}

async function doRecoverPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    document.getElementById('login-err').textContent = "Inserisci prima l'email";
    return;
  }
  if (!confirm(`Inviare email di recupero password a ${email}?`)) return;
  const { error } = await sb.auth.resetPasswordForEmail(email);
  if (error) showToast('Errore: ' + error.message, 'error');
  else showToast('Email di recupero inviata a ' + email, 'success');
}

// ═══════════════════════════════════════════════════════════════
// DISCLAIMER LEGALE — modale bloccante post-login
// ═══════════════════════════════════════════════════════════════
async function checkTermsAndShow() {
  // Il superadmin bypassa il disclaimer (è il fornitore del servizio)
  if (currentRole === 'superadmin') return;
  if (!currentUserId) return;

  try {
    const { data, error } = await sb
      .from('profiles')
      .select('accetta_termini, data_accettazione')
      .eq('user_id', currentUserId)
      .single();
    if (error) {
      console.error('[Terms] errore lettura profilo:', error);
      return;  // in caso di errore, non blocchiamo l'utente
    }
    currentTermsAccepted = data?.accetta_termini === true;
    if (!currentTermsAccepted) {
      // Mostra il modale bloccante
      document.getElementById('terms-screen').style.display = 'flex';
    }
  } catch(e) {
    console.error('[Terms]', e);
  }
}

async function acceptTerms() {
  if (!currentUserId) return;
  const btn = document.getElementById('terms-btn');
  btn.disabled = true;
  btn.textContent = 'Salvataggio...';
  try {
    // 1. Aggiorna profilo: accetta_termini=true + timestamp
    const now = new Date().toISOString();
    const { error: errProf } = await sb
      .from('profiles')
      .update({ accetta_termini: true, data_accettazione: now })
      .eq('user_id', currentUserId);
    if (errProf) throw errProf;

    // 2. Audit log
    await sb.from('terms_acceptance_log').insert({
      user_id: currentUserId,
      accepted_at: now,
      user_agent: navigator.userAgent.substring(0, 500),
      terms_version: 'v1.0'
    });

    currentTermsAccepted = true;
    document.getElementById('terms-screen').style.display = 'none';
    showToast('✓ Termini accettati. Buon lavoro!', 'success');
  } catch(e) {
    console.error('[acceptTerms]', e);
    showToast('Errore: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Accetto e attivo il servizio →';
  }
}

// ═══════════════════════════════════════════════════════════════
// SYNC ALL
// ═══════════════════════════════════════════════════════════════
async function syncAll() {
  if (navigator.onLine) {
    try {
      setLoadingMsg('Scarico anagrafica...');  await pullAzienda();
      setLoadingMsg('Scarico apparecchi...');  await pullApparecchi();
      setLoadingMsg('Scarico operatori...');   await pullOperatori();
      setLoadingMsg('Scarico orari...');       await pullSlot();
      setLoadingMsg('Scarico temperature...'); await pullTemperature();
      setLoadingMsg('Scarico azioni...');      await pullAzioni();
      setLoadingMsg('Scarico firme...');       await pullFirme();
      saveAllLocal();
    } catch(e) { console.error('[Sync]', e); loadFromLocal(); }
  } else loadFromLocal();
}

function loadFromLocal() {
  function sg(k, fb) {
    try { const v=JSON.parse(localStorage.getItem(k)); return (v!==null&&v!==undefined)?v:fb; }
    catch(e){return fb;}
  }
  config        = sg('h_config',    []); if(!Array.isArray(config))    config=[];
  operatori     = sg('h_operatori', []); if(!Array.isArray(operatori)) operatori=[];
  scheduleSlots = sg('h_schedule',  [{time:"09:00",label:"Apertura"},{time:"15:00",label:"Pomeriggio"},{time:"21:00",label:"Chiusura"}]);
  aziendaCfg    = sg('h_azienda',   {});
  cloudData     = sg('h_clouddata', []); if(!Array.isArray(cloudData))   cloudData=[];
  cloudAzioni   = sg('h_azioni',    []); if(!Array.isArray(cloudAzioni)) cloudAzioni=[];
  cloudFirme    = sg('h_firme',     []); if(!Array.isArray(cloudFirme))  cloudFirme=[];
  buildCorrective();
}

function saveAllLocal() {
  localStorage.setItem('h_config',    JSON.stringify(config));
  localStorage.setItem('h_operatori', JSON.stringify(operatori));
  localStorage.setItem('h_schedule',  JSON.stringify(scheduleSlots));
  localStorage.setItem('h_azienda',   JSON.stringify(aziendaCfg));
  localStorage.setItem('h_clouddata', JSON.stringify(cloudData));
  localStorage.setItem('h_azioni',    JSON.stringify(cloudAzioni));
  localStorage.setItem('h_firme',     JSON.stringify(cloudFirme));
}

// ═══════════════════════════════════════════════════════════════
// PULL DAL CLOUD (Supabase)
// ═══════════════════════════════════════════════════════════════
async function pullAzienda() {
  const { data, error } = await sb.from('aziende').select('*').eq('id', currentAziendaId).single();
  if (error) throw error;
  aziendaCfg = data || {};
  if (aziendaCfg.dataverifica === null) aziendaCfg.dataverifica = '';
}

async function pullApparecchi() {
  const { data, error } = await sb.from('apparecchi')
    .select('id, name, type, area')
    .eq('azienda_id', currentAziendaId)
    .order('area').order('name');
  if (error) throw error;
  config = (data || []).map(r => ({ id:r.id, name:r.name, type:r.type, area:r.area }));
}

async function pullOperatori() {
  const { data, error } = await sb.from('operatori')
    .select('id, name')
    .eq('azienda_id', currentAziendaId)
    .order('name');
  if (error) throw error;
  operatori = (data || []).map(r => r.name);
}

async function pullSlot() {
  const { data, error } = await sb.from('slot_orari')
    .select('id, time, label')
    .eq('azienda_id', currentAziendaId)
    .order('time');
  if (error) throw error;
  scheduleSlots = data || [];
  if (!scheduleSlots.length) {
    scheduleSlots = [
      {time:"09:00",label:"Apertura"},
      {time:"15:00",label:"Pomeriggio"},
      {time:"21:00",label:"Chiusura"}
    ];
  }
}

async function pullTemperature() {
  const { data, error } = await sb.from('temperature')
    .select('data, ora, apparecchio, tipo, temp, stato, area, operatore')
    .eq('azienda_id', currentAziendaId)
    .order('data', { ascending: true })
    .order('ora',  { ascending: true });
  if (error) throw error;
  cloudData = (data || []).map(r => [
    formatDateIT(r.data), r.ora, r.apparecchio, r.tipo,
    String(r.temp), r.stato, r.area || '', r.operatore || ''
  ]);
  localStorage.setItem('h_clouddata', JSON.stringify(cloudData));
}

async function pullAzioni() {
  const { data, error } = await sb.from('azioni_correttive')
    .select('data_anomalia, ora_anomalia, apparecchio, zona, temp_rilevata, azioni, note, responsabile, salvato_il')
    .eq('azienda_id', currentAziendaId)
    .order('data_anomalia', { ascending: true })
    .order('ora_anomalia',  { ascending: true });
  if (error) throw error;
  cloudAzioni = [['Data Anomalia','Ora Anomalia','Apparecchio','Zona','Temp Rilevata','Azioni Eseguite','Note','Responsabile','Salvato Il']];
  (data || []).forEach(r => {
    cloudAzioni.push([
      formatDateIT(r.data_anomalia), r.ora_anomalia, r.apparecchio, r.zona || '',
      String(r.temp_rilevata||''), r.azioni||'', r.note||'',
      r.responsabile||'', r.salvato_il || ''
    ]);
  });
  buildCorrective();
}

async function pullFirme() {
  const { data, error } = await sb.from('firme')
    .select('data, ora, operatore, firma_b64')
    .eq('azienda_id', currentAziendaId)
    .order('data', { ascending: true })
    .order('ora',  { ascending: true });
  if (error) throw error;
  cloudFirme = (data || []).map(r => [formatDateIT(r.data), r.ora, r.operatore, r.firma_b64 || '']);
}

async function syncTemperature() {
  try {
    await pullTemperature();
    buildDash(); updateDashBadge(); checkReminderDot();
    document.getElementById('last-sync-label').textContent =
      'Ultimo aggiornamento: ' + new Date().toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
  } catch(e) { console.error('[syncTemperature]', e); }
}

function buildCorrective() {
  corrective = {};
  cloudAzioni.slice(1).forEach(r => {
    if (!r[0]||r[0]==='Data Anomalia') return;
    const key = `${r[2]}_${r[0]}_${r[1]}`;
    corrective[key] = {
      azioni: (r[5]||'').split(', ').filter(Boolean),
      note: r[6]||'', responsabile: r[7]||'', salvato: r[8]||''
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// HELPERS DATA
// ═══════════════════════════════════════════════════════════════
function formatDateIT(isoDate) {
  if (!isoDate) return '';
  if (typeof isoDate !== 'string') return String(isoDate);
  if (isoDate.includes('/')) return isoDate;
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : isoDate;
}
function dateITtoISO(itDate) {
  if (!itDate) return null;
  if (itDate.match(/^\d{4}-\d{2}-\d{2}$/)) return itDate;
  const m = itDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ═══════════════════════════════════════════════════════════════
// APPLY CONFIG
// ═══════════════════════════════════════════════════════════════
function applyConfig() {
  const fields = {
    'cfg-azienda':      aziendaCfg.azienda,
    'cfg-indirizzo':    aziendaCfg.indirizzo,
    'cfg-piva':         aziendaCfg.piva,
    'cfg-telefono':     aziendaCfg.telefono,
    'cfg-email':        aziendaCfg.email,
    'cfg-responsabile': aziendaCfg.responsabile,
    'cfg-regsanitaria': aziendaCfg.regsanitaria,
    'cfg-dataverifica': aziendaCfg.dataverifica
  };
  for (let id in fields) {
    const el = document.getElementById(id);
    if (el) el.value = fields[id] || '';
  }
}

function renderAll() {
  renderSetup();
  renderOperatoriSetup();
  renderDevices();
  renderScheduleConfig();
  renderScheduleSlotsSetup();
  renderFirmaScreen();
  buildDash();
  updateDashBadge();
}

// ═══════════════════════════════════════════════════════════════
// ONLINE/OFFLINE
// ═══════════════════════════════════════════════════════════════
function onOnline() {
  isOnline = true;
  document.getElementById('offline-bar').classList.remove('on');
  flushQueue();
  if (currentAziendaId) syncTemperature();
  showToast('Connessione ripristinata','success');
}
function onOffline() {
  isOnline = false;
  document.getElementById('offline-bar').classList.add('on');
  showToast('Modalità offline','warning');
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════
function switchTab(id, el) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('screen-'+id).classList.add('active');
  el.classList.add('active');
  if (id==='history')  { updateDeviceFilter(); renderHistory(); }
  if (id==='dash')     { buildDash(); }
  if (id==='log')      { renderDevices(); }
  if (id==='schedule') { renderScheduleToday(); }
  if (id==='firma')    { updateDate(); renderFirmaScreen(); }
}

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
function showToast(msg, type='success') {
  const c = document.getElementById('toast-wrap');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${{success:'✓',error:'✕',warning:'⚠'}[type]||'ℹ'}</span> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3700);
}

// ═══════════════════════════════════════════════════════════════
// DEVICES UI
// ═══════════════════════════════════════════════════════════════
function setArea(area, el) {
  currentArea = area;
  document.querySelectorAll('.area-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  renderDevices();
}

function renderDevices() {
  const list = document.getElementById('device-list');
  if (!list) return;
  list.innerHTML = '';
  if(!Array.isArray(cloudData)) cloudData = [];
  if(!Array.isArray(config))    config = [];
  function normArea(s) { return (s||'').replace(/[^A-Za-z]/g,'').toUpperCase(); }
  const filtered = config.filter(c => normArea(c.area) === normArea(currentArea));
  if (!filtered.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = '<div class="ic">&#128295;</div><p>Nessun apparecchio in questa zona.<br>Aggiungilo dal tab Setup.</p>';
    list.appendChild(es);
    updateQueueInfo(); return;
  }
  const today = new Date().toLocaleDateString('it-IT');
  const todayRows = cloudData.filter(r => r[0] === today);
  filtered.forEach(function(item) {
    const cloudLast = todayRows.filter(r => r[2] === item.name).pop();
    const last = cloudLast
      ? { temp: parseFloat(cloudLast[4]), ok: cloudLast[5] === 'OK' }
      : lastTemps[item.name];
    const soglia = item.type === 'frigo' ? '+4°C' : '-18°C';
    const lastTxt = last ? ('Ult: ' + last.temp + '° ' + (last.ok ? '✓' : '⚠')) : 'Nessuna ril.';
    const id = item.name.replace(/[^a-z0-9]/gi, '_');
    const row = document.createElement('div');
    row.className = 'device-row' + (last && !last.ok ? ' has-err' : '');
    const icon = document.createElement('div');
    icon.className = 'device-icon' + (item.type !== 'frigo' ? ' gelo' : '');
    icon.textContent = item.type === 'frigo' ? '❄️' : '🧊';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    const nameEl = document.createElement('div'); nameEl.className = 'device-name'; nameEl.textContent = item.name;
    const metaEl = document.createElement('div'); metaEl.className = 'device-meta'; metaEl.textContent = 'Soglia ' + soglia + ' · ' + lastTxt;
    const warnEl = document.createElement('div'); warnEl.className = 'temp-warn'; warnEl.id = 'tw-' + id; warnEl.textContent = '⚠ Fuori soglia!';
    info.appendChild(nameEl); info.appendChild(metaEl); info.appendChild(warnEl);
    const right = document.createElement('div'); right.className = 'device-right';
    const inp = document.createElement('input'); inp.className = 'temp-input'; inp.id = 'inp-' + id;
    inp.type = 'number'; inp.step = '0.1'; inp.placeholder = '°C';
    (function(n, t) { inp.addEventListener('input', function() { checkWarn(n, t, this); }); })(item.name, item.type);
    const btn = document.createElement('button'); btn.className = 'send-btn'; btn.id = 'sbtn-' + id;
    btn.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 8l12-6-6 12V9L2 8z"/></svg>';
    (function(n, t, a) { btn.addEventListener('click', function() { sendData(n, t, a); }); })(item.name, item.type, item.area || currentArea);
    right.appendChild(inp); right.appendChild(btn);
    row.appendChild(icon); row.appendChild(info); row.appendChild(right);
    list.appendChild(row);
  });
  updateQueueInfo();
}

function checkWarn(name, type, el) {
  const v = parseFloat(el.value);
  const id = name.replace(/[^a-z0-9]/gi,'_');
  const w  = document.getElementById('tw-'+id);
  if (!w) return;
  if (isNaN(v)) { w.classList.remove('on'); el.classList.remove('warn'); return; }
  const out = (type==='frigo'&&v>4)||(type==='gelo'&&v>-18);
  w.classList.toggle('on',out); el.classList.toggle('warn',out);
}

// ═══════════════════════════════════════════════════════════════
// SEND TEMPERATURA
// ═══════════════════════════════════════════════════════════════
async function sendData(name, type, area) {
  const id  = name.replace(/[^a-z0-9]/gi,'_');
  const el  = document.getElementById('inp-'+id);
  const btn = document.getElementById('sbtn-'+id);
  if (!el || el.value==='') { showToast('Inserisci una temperatura','warning'); return; }
  const val = parseFloat(el.value);
  if (isNaN(val)) { showToast('Valore non valido','error'); return; }
  const now = new Date();
  const status = (type==='frigo'&&val<=4)||(type==='gelo'&&val<=-18) ? 'OK' : 'ERR';
  const dataIT = now.toLocaleDateString('it-IT');
  const oraIT  = now.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});

  const entry = {
    azienda_id:  currentAziendaId,
    data:        dateITtoISO(dataIT),
    ora:         oraIT,
    apparecchio: name,
    tipo:        type,
    temp:        val,
    stato:       status,
    area:        area,
    operatore:   currentOperatore || 'N/D'
  };

  lastTemps[name] = { temp:val, ok:status==='OK' };
  localStorage.setItem('h_lasttemps', JSON.stringify(lastTemps));
  cloudData.push([dataIT, oraIT, name, type, String(val), status, area, currentOperatore || 'N/D']);

  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div>';

  if (isOnline) {
    try {
      const { error } = await sb.from('temperature').insert(entry);
      if (error) throw error;
      showToast(`✓ ${name} · ${val}° salvato`,'success');
      el.value=''; el.classList.remove('warn');
      const w = document.getElementById('tw-'+id); if(w) w.classList.remove('on');
      if (status==='ERR') setTimeout(()=>openModal({
        name, temp: String(val), date: dataIT, time: oraIT, area, type
      }), 600);
    } catch(e) {
      console.error('[sendData]', e);
      queueEntry({ kind:'temperature', payload: entry });
      showToast('Errore cloud — salvato in coda','warning');
    }
  } else {
    queueEntry({ kind:'temperature', payload: entry });
    showToast('Offline — salvato in coda','warning');
    el.value='';
  }

  btn.disabled=false;
  btn.innerHTML='<svg viewBox="0 0 16 16"><path d="M2 8l12-6-6 12V9L2 8z"/></svg>';
  renderDevices(); buildDash(); updateDashBadge();
}

// ═══════════════════════════════════════════════════════════════
// OFFLINE QUEUE
// ═══════════════════════════════════════════════════════════════
function queueEntry(e) {
  offlineQueue.push(e);
  localStorage.setItem('h_queue', JSON.stringify(offlineQueue));
  updateQueueInfo();
}

async function flushQueue() {
  if (!isOnline || !offlineQueue.length) return;
  const q = [...offlineQueue]; offlineQueue = [];
  localStorage.setItem('h_queue','[]');
  let ok = 0;
  for (const e of q) {
    try {
      const table = e.kind === 'temperature' ? 'temperature'
                  : e.kind === 'azione'      ? 'azioni_correttive'
                  : e.kind === 'firma'       ? 'firme' : null;
      if (!table) { continue; }
      const { error } = await sb.from(table).insert(e.payload);
      if (error) { offlineQueue.push(e); }
      else ok++;
    } catch(err) { offlineQueue.push(e); }
  }
  localStorage.setItem('h_queue', JSON.stringify(offlineQueue));
  if (ok>0) showToast(`${ok} record sincronizzat${ok>1?'i':'o'}`, 'success');
  updateQueueInfo();
  if (ok > 0) { await syncAll(); renderAll(); }
}

function updateQueueInfo() {
  const el = document.getElementById('queue-info'); if(!el) return;
  if (offlineQueue.length>0) {
    el.innerHTML = `⏳ ${offlineQueue.length} in coda per sync <span style="text-decoration:underline;margin-left:6px;">tocca per gestire</span>`;
    el.classList.add('on');
    el.style.cursor = 'pointer';
    el.onclick = handleQueueClick;
  } else {
    el.classList.remove('on');
    el.onclick = null;
  }
}

async function handleQueueClick() {
  if (!offlineQueue.length) return;
  const n = offlineQueue.length;
  const choice = confirm(
    `Ci sono ${n} record in coda offline.\n\n` +
    `OK = riprova a sincronizzarli ora\n` +
    `Annulla = scartali (eliminali dalla coda)`
  );
  if (choice) {
    await flushQueue();
    if (offlineQueue.length === 0) showToast('Coda svuotata', 'success');
    else if (offlineQueue.length < n) showToast(`${n-offlineQueue.length} sincronizzati, ${offlineQueue.length} ancora in coda`, 'warning');
    else showToast('Sync ancora non riuscita', 'error');
  } else {
    if (confirm(`Eliminare definitivamente i ${n} record in coda?`)) {
      offlineQueue = [];
      localStorage.setItem('h_queue', '[]');
      updateQueueInfo();
      showToast('Coda cancellata', 'success');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// AZIONE CORRETTIVA MODAL
// ═══════════════════════════════════════════════════════════════
function openModal(entry) {
  modalEntry = entry;
  document.getElementById('modal-sub').textContent = `${entry.name} — ${entry.temp}°C · ${entry.date} ${entry.time}`;
  document.getElementById('action-note').value = '';
  document.getElementById('action-resp').value = aziendaCfg.responsabile||'';
  const chips=document.getElementById('action-chips'); chips.innerHTML='';
  AZIONI_PRESET.forEach(a=>{
    const s=document.createElement('span'); s.className='action-chip'; s.textContent=a;
    s.onclick=()=>s.classList.toggle('sel'); chips.appendChild(s);
  });
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModalBg(e) { if(e.target.id==='modal-overlay') closeModal(); }
function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); modalEntry=null; }

async function saveAction() {
  if (!modalEntry) return;
  const sel  = [...document.querySelectorAll('.action-chip.sel')].map(c=>c.textContent);
  const note = document.getElementById('action-note').value.trim();
  const resp = document.getElementById('action-resp').value.trim();
  if (!sel.length && !note) { showToast("Seleziona almeno un'azione",'warning'); return; }
  const now = new Date();
  const key = `${modalEntry.name}_${modalEntry.date}_${modalEntry.time}`;
  corrective[key] = { azioni:sel, note, responsabile:resp, salvato:now.toLocaleString('it-IT') };
  const payload = {
    azienda_id:    currentAziendaId,
    data_anomalia: dateITtoISO(modalEntry.date),
    ora_anomalia:  modalEntry.time,
    apparecchio:   modalEntry.name,
    zona:          modalEntry.area || '',
    temp_rilevata: parseFloat(modalEntry.temp),
    azioni:        sel.join(', '),
    note:          note,
    responsabile:  resp
  };
  if (isOnline) {
    try {
      const { error } = await sb.from('azioni_correttive').insert(payload);
      if (error) throw error;
    } catch(e) {
      console.error('[saveAction]', e);
      queueEntry({ kind:'azione', payload });
    }
  } else {
    queueEntry({ kind:'azione', payload });
  }
  closeModal();
  showToast('Azione correttiva registrata','success');
  buildDash();
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
function buildDash() {
  if(!Array.isArray(cloudData))cloudData=[];
  const today = new Date().toLocaleDateString('it-IT');
  const rows  = cloudData.filter(r=>Array.isArray(r)&&r[0]===today&&r[5]&&r[0]!=='Data');
  const errs  = rows.filter(r=>r[5]==='ERR');
  const okDev = config.filter(c=>{
    const l = [...rows].filter(r=>r[2]===c.name).pop();
    return l && l[5]==='OK';
  }).length;
  document.getElementById('stat-count').textContent = rows.length;
  document.getElementById('stat-err').textContent   = errs.length;
  document.getElementById('stat-ok').textContent    = config.length>0 ? `${okDev}/${config.length}` : '—';
  const times = rows.map(r=>r[1]).filter(Boolean);
  document.getElementById('stat-last').textContent  = times.length ? times[times.length-1] : '—';

  const ac = document.getElementById('dash-alerts'); ac.innerHTML='';
  errs.slice(-5).reverse().forEach(r=>{
    const key=`${r[2]}_${r[0]}_${r[1]}`; const hasFix=!!corrective[key];
    ac.innerHTML+=`<div class="alert-banner">
      <div class="alert-dot"></div>
      <div class="alert-text"><strong>${r[2]}</strong> (${r[6]||''}) — ${r[4]}°C alle ${r[1]}
        ${hasFix?'<br><span style="color:var(--green);font-size:11px;">✓ Azione correttiva registrata</span>':''}
      </div>
      ${!hasFix?`<button class="fix-btn" onclick='openModal({name:"${r[2]}",temp:"${r[4]}",date:"${r[0]}",time:"${r[1]}",area:"${r[6]||""}"})'>+ Azione</button>`:''}
    </div>`;
  });

  const rec = document.getElementById('dash-recent');
  const sorted = [...rows].reverse().slice(0,6);
  if (!sorted.length) { rec.innerHTML='<div class="empty-state"><div class="ic">📋</div><p>Nessuna rilevazione oggi.</p></div>'; return; }
  rec.innerHTML = sorted.map(r=>`<div class="hist-item">
    <div><div class="hist-name">${r[2]||''}</div><div class="hist-meta">${r[6]||''} · ${r[1]||''}</div></div>
    <div class="hist-right">
      <div class="hist-temp" style="color:${r[5]==='OK'?'var(--green)':'var(--red)'}">${r[4]||''}°</div>
      <span class="badge ${r[5]==='OK'?'badge-ok':'badge-err'}">${r[5]||''}</span>
    </div>
  </div>`).join('');
}

function updateDashBadge() {
  const today = new Date().toLocaleDateString('it-IT');
  const rows  = cloudData.filter(r=>Array.isArray(r)&&r[0]===today&&r[5]&&r[0]!=='Data');
  const errs  = rows.filter(r=>r[5]==='ERR').length;
  const badge = document.getElementById('top-badge');
  badge.textContent = rows.length ? `${rows.length-errs} OK · ${errs} ERR` : 'Nessuna ril.';
  badge.classList.toggle('has-err', errs>0);
}

// ═══════════════════════════════════════════════════════════════
// SCHEDULE
// ═══════════════════════════════════════════════════════════════
function renderScheduleConfig() {
  const el = document.getElementById('schedule-slots'); if(!el) return;
  el.innerHTML='';
  scheduleSlots.forEach((s,i)=>{
    const d=document.createElement('div'); d.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    d.innerHTML=`<span style="font-size:14px;font-weight:700;color:var(--navy);min-width:50px;">${s.time}</span>
      <span style="font-size:13px;flex:1;">${s.label}</span>
      <button onclick="deleteSlot(${i})" style="background:none;border:none;color:var(--text-muted);font-size:17px;cursor:pointer;font-family:inherit;">✕</button>`;
    el.appendChild(d);
  });
  renderScheduleToday();
}

function renderScheduleSlotsSetup() {
  const el = document.getElementById('schedule-slots-setup'); if(!el) return;
  el.innerHTML='';
  scheduleSlots.forEach((s,i)=>{
    const d=document.createElement('div'); d.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:8px;';
    d.innerHTML=`<span style="font-size:13px;font-weight:700;color:var(--navy);min-width:50px;">${s.time}</span>
      <span style="font-size:13px;flex:1;">${s.label}</span>
      <button onclick="deleteSlotSetup(${i})" style="background:none;border:none;color:var(--text-muted);font-size:17px;cursor:pointer;font-family:inherit;">✕</button>`;
    el.appendChild(d);
  });
}

async function addSlot() {
  if (!isAdmin()) { showToast('Solo Admin può modificare gli orari','error'); return; }
  const t=document.getElementById('new-slot-time').value;
  const l=document.getElementById('new-slot-label').value.trim();
  if(!t){showToast('Inserisci un orario','warning');return;}
  try {
    const { error } = await sb.from('slot_orari').insert({
      azienda_id: currentAziendaId, time: t, label: l || t
    });
    if (error) throw error;
    await pullSlot();
    document.getElementById('new-slot-time').value='';
    document.getElementById('new-slot-label').value='';
    renderScheduleConfig(); renderScheduleSlotsSetup(); checkReminderDot();
    showToast('Orario aggiunto','success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function addSlotSetup() {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  const t=document.getElementById('new-slot-time2').value;
  const l=document.getElementById('new-slot-label2').value.trim();
  if(!t){showToast('Inserisci un orario','warning');return;}
  try {
    const { error } = await sb.from('slot_orari').insert({
      azienda_id: currentAziendaId, time: t, label: l || t
    });
    if (error) throw error;
    await pullSlot();
    document.getElementById('new-slot-time2').value='';
    document.getElementById('new-slot-label2').value='';
    renderScheduleSlotsSetup(); renderScheduleConfig(); checkReminderDot();
    showToast('Orario aggiunto','success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function deleteSlot(i) {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  const slot = scheduleSlots[i];
  if (!slot || !slot.id) return;
  if (!confirm(`Rimuovere lo slot ${slot.time} - ${slot.label}?`)) return;
  try {
    const { error } = await sb.from('slot_orari').delete().eq('id', slot.id);
    if (error) throw error;
    await pullSlot();
    renderScheduleConfig(); renderScheduleSlotsSetup(); checkReminderDot();
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function deleteSlotSetup(i) { return deleteSlot(i); }

function renderScheduleToday() {
  if(!Array.isArray(cloudData))cloudData=[];
  const now=new Date(); const nowMin=now.getHours()*60+now.getMinutes();
  const today=now.toLocaleDateString('it-IT');
  const rows=cloudData.filter(r=>Array.isArray(r)&&r[0]===today);
  const el=document.getElementById('schedule-today'); if(!el) return;
  el.innerHTML='';
  if (!scheduleSlots.length){el.innerHTML='<div class="empty-state"><p>Nessuna sessione configurata.</p></div>';return;}
  scheduleSlots.forEach(s=>{
    const [hh,mm]=s.time.split(':').map(Number); const slotMin=hh*60+mm;
    const done=rows.some(r=>{if(!r[1])return false;const[rh,rm]=r[1].split(':').map(Number);return Math.abs((rh*60+rm)-slotMin)<=45;});
    const isPast=slotMin<nowMin; const isClose=Math.abs(slotMin-nowMin)<=30;
    let cls='',badge='';
    if(done){cls='done';badge='<span class="badge badge-ok">Completata</span>';}
    else if(isPast){cls='overdue';badge='<span class="badge badge-err">In ritardo</span>';}
    else if(isClose){badge='<span class="badge badge-fix">Prossima</span>';}
    else{badge='<span class="badge badge-gray">Pianificata</span>';}
    el.innerHTML+=`<div class="schedule-row ${cls}">
      <div class="schedule-time">${s.time}</div>
      <div><div style="font-size:13px;font-weight:500;">${s.label}</div>
        <div style="font-size:11px;color:var(--text-muted);">${done?'✓ Rilevazioni registrate':'Tutte le zone'}</div></div>
      <div style="margin-left:auto;">${badge}</div>
    </div>`;
  });
}

function checkReminderDot() {
  if(!Array.isArray(cloudData))cloudData=[];
  const now=new Date(); const nowMin=now.getHours()*60+now.getMinutes();
  const today=now.toLocaleDateString('it-IT');
  const rows=cloudData.filter(r=>Array.isArray(r)&&r[0]===today);
  const late=scheduleSlots.some(s=>{
    const[hh,mm]=s.time.split(':').map(Number); const slotMin=hh*60+mm;
    if(slotMin>=nowMin) return false;
    return !rows.some(r=>{if(!r[1])return false;const[rh,rm]=r[1].split(':').map(Number);return Math.abs((rh*60+rm)-slotMin)<=45;});
  });
  const dot=document.getElementById('rdot'); if(dot) dot.classList.toggle('on',late);
}

// ═══════════════════════════════════════════════════════════════
// FIRMA
// ═══════════════════════════════════════════════════════════════
function initFirmaCanvas() {
  firmaCanvas=document.getElementById('firma-canvas');
  if(!firmaCanvas) return;
  firmaCtx=firmaCanvas.getContext('2d');
  firmaCtx.strokeStyle='#1A3A5C'; firmaCtx.lineWidth=2.5; firmaCtx.lineCap='round'; firmaCtx.lineJoin='round';
  const pos=(e,c)=>{const r=c.getBoundingClientRect();const s=e.touches?e.touches[0]:e;return{x:(s.clientX-r.left)*(c.width/r.width),y:(s.clientY-r.top)*(c.height/r.height)};};
  firmaCanvas.addEventListener('mousedown',e=>{drawing=true;const p=pos(e,firmaCanvas);firmaCtx.beginPath();firmaCtx.moveTo(p.x,p.y);});
  firmaCanvas.addEventListener('mousemove',e=>{if(!drawing)return;const p=pos(e,firmaCanvas);firmaCtx.lineTo(p.x,p.y);firmaCtx.stroke();});
  firmaCanvas.addEventListener('mouseup',()=>{drawing=false;});
  firmaCanvas.addEventListener('touchstart',e=>{e.preventDefault();drawing=true;const p=pos(e,firmaCanvas);firmaCtx.beginPath();firmaCtx.moveTo(p.x,p.y);},{passive:false});
  firmaCanvas.addEventListener('touchmove',e=>{e.preventDefault();if(!drawing)return;const p=pos(e,firmaCanvas);firmaCtx.lineTo(p.x,p.y);firmaCtx.stroke();},{passive:false});
  firmaCanvas.addEventListener('touchend',()=>{drawing=false;});
}

function clearFirma() {
  if(firmaCtx) firmaCtx.clearRect(0,0,firmaCanvas.width,firmaCanvas.height);
  document.getElementById('firma-saved-msg').classList.remove('on');
}

async function saveFirma() {
  const nome = document.getElementById('firma-nome-input').value.trim();
  if (!nome) { showToast("Inserisci il nome dell'operatore",'warning'); return; }
  const now = new Date();
  const dataIT = now.toLocaleDateString('it-IT');
  const oraIT  = now.toLocaleTimeString('it-IT',{hour:'2-digit',minute:'2-digit'});
  const dataUrl = firmaCanvas.toDataURL();
  const payload = {
    azienda_id: currentAziendaId,
    data:       dateITtoISO(dataIT),
    ora:        oraIT,
    operatore:  nome,
    firma_b64:  dataUrl
  };
  cloudFirme.push([dataIT, oraIT, nome, dataUrl]);
  localStorage.setItem('h_firme', JSON.stringify(cloudFirme));
  if (isOnline) {
    try {
      const { error } = await sb.from('firme').insert(payload);
      if (error) throw error;
    } catch(e) {
      console.error('[saveFirma]', e);
      queueEntry({ kind:'firma', payload });
    }
  } else {
    queueEntry({ kind:'firma', payload });
  }
  document.getElementById('firma-saved-msg').classList.add('on');
  showToast(`Firma di ${nome} salvata`,'success');
  clearFirma(); renderFirmaScreen();
}

function renderFirmaScreen() {
  if(!Array.isArray(cloudFirme)) cloudFirme = [];
  const chips=document.getElementById('operatori-chips'); if(!chips)return;
  chips.innerHTML='';
  operatori.forEach(op=>{
    const s=document.createElement('span'); s.className='operatore-chip'; s.textContent=op;
    s.onclick=()=>{document.querySelectorAll('.operatore-chip').forEach(c=>c.classList.remove('sel'));s.classList.add('sel');document.getElementById('firma-nome-input').value=op;};
    chips.appendChild(s);
  });
  const inp = document.getElementById('firma-nome-input');
  if (inp && !inp.value && currentOperatore) inp.value = currentOperatore;
  const list=document.getElementById('firme-list'); if(!list)return;
  const today=new Date().toLocaleDateString('it-IT');
  const firmeOggi = cloudFirme.filter(r=>Array.isArray(r)&&r[0]===today&&r[2]);
  if(!firmeOggi.length){list.innerHTML='<div class="empty-state"><div class="ic">✍️</div><p>Nessuna firma oggi.</p></div>';return;}
  list.innerHTML=firmeOggi.map(f=>`<div class="card" style="padding:11px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;">
      <div><div style="font-size:13px;font-weight:700;">${f[2]}</div><div style="font-size:11px;color:var(--text-muted);">${f[0]} ${f[1]||''}</div></div>
      <span class="badge badge-ok">Firmato</span>
    </div>
    ${f[3]?`<img src="${f[3]}" style="width:100%;height:55px;object-fit:contain;border:1px solid var(--border);border-radius:6px;background:#fff;">`:''}
  </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// SETUP — APPARECCHI
// ═══════════════════════════════════════════════════════════════
function renderSetup() {
  const list=document.getElementById('setup-list'); if(!list)return; list.innerHTML='';
  if(!config.length){list.innerHTML='<div class="empty-state" style="padding:10px 0;"><p>Nessun apparecchio.</p></div>';return;}
  const icons={frigo:'❄️',gelo:'🧊'};
  const areaNames={CUCINA:'Cucina',BAR:'Bar',RISTORANTE:'Ristorante'};
  config.forEach((c,i)=>{
    const d=document.createElement('div'); d.className='setup-item';
    d.innerHTML=`<div class="device-icon ${c.type}">${icons[c.type]||'❄️'}</div>
      <div class="setup-info"><div class="name">${c.name}</div>
        <div class="sub">${c.type==='frigo'?'Frigo (+4°C)':'Gelo (-18°C)'} · ${areaNames[c.area]||c.area}</div></div>
      <button class="del-btn" onclick="deleteDevice(${i})">✕</button>`;
    list.appendChild(d);
  });
}

async function addDevice() {
  if (!isAdmin()) { showToast('Solo Admin può aggiungere apparecchi','error'); return; }
  const name = document.getElementById('new-name').value.trim();
  if(!name){showToast('Inserisci un nome','warning');return;}
  if(config.find(c=>c.name===name)){showToast('Nome già usato','error');return;}
  try {
    const { error } = await sb.from('apparecchi').insert({
      azienda_id: currentAziendaId,
      name,
      type: document.getElementById('new-type').value,
      area: document.getElementById('new-area').value
    });
    if (error) throw error;
    await pullApparecchi();
    document.getElementById('new-name').value='';
    renderSetup(); renderDevices();
    showToast(`${name} aggiunto`,'success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function deleteDevice(i) {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  const dev = config[i];
  if (!dev || !dev.id) return;
  if (!confirm(`Rimuovere "${dev.name}"?`)) return;
  try {
    const { error } = await sb.from('apparecchi').delete().eq('id', dev.id);
    if (error) throw error;
    await pullApparecchi();
    renderSetup(); renderDevices();
    showToast(`${dev.name} rimosso`,'success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

// ═══════════════════════════════════════════════════════════════
// SETUP — OPERATORI
// ═══════════════════════════════════════════════════════════════
function renderOperatoriSetup() {
  const list=document.getElementById('operatori-setup-list'); if(!list)return; list.innerHTML='';
  if(!operatori.length){list.innerHTML='<div class="empty-state" style="padding:10px 0;"><p>Nessun operatore.</p></div>';return;}
  operatori.forEach((op,i)=>{
    const d=document.createElement('div'); d.className='setup-item';
    d.innerHTML=`<span style="font-size:16px;">👤</span>
      <div class="setup-info"><div class="name">${op}</div></div>
      <button class="del-btn" onclick="deleteOperatore(${i})">✕</button>`;
    list.appendChild(d);
  });
}

async function addOperatore() {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  const v=document.getElementById('new-operatore').value.trim(); if(!v)return;
  if (operatori.includes(v)) { showToast('Già presente','warning'); return; }
  try {
    const { error } = await sb.from('operatori').insert({
      azienda_id: currentAziendaId, name: v
    });
    if (error) throw error;
    await pullOperatori();
    document.getElementById('new-operatore').value='';
    renderOperatoriSetup(); renderFirmaScreen();
    showToast(`${v} aggiunto`,'success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function deleteOperatore(i) {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  const nome = operatori[i];
  if (!confirm(`Rimuovere ${nome}?`)) return;
  try {
    const { error } = await sb.from('operatori').delete()
      .eq('azienda_id', currentAziendaId).eq('name', nome);
    if (error) throw error;
    await pullOperatori();
    renderOperatoriSetup(); renderFirmaScreen();
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

// ═══════════════════════════════════════════════════════════════
// SETUP — DATI AZIENDA
// ═══════════════════════════════════════════════════════════════
function saveCfgLocal() {
  aziendaCfg.azienda      = document.getElementById('cfg-azienda').value;
  aziendaCfg.indirizzo    = document.getElementById('cfg-indirizzo').value;
  aziendaCfg.piva         = document.getElementById('cfg-piva').value;
  aziendaCfg.telefono     = document.getElementById('cfg-telefono').value;
  aziendaCfg.email        = document.getElementById('cfg-email').value;
  aziendaCfg.responsabile = document.getElementById('cfg-responsabile').value;
  aziendaCfg.regsanitaria = document.getElementById('cfg-regsanitaria').value;
  aziendaCfg.dataverifica = document.getElementById('cfg-dataverifica').value;
  localStorage.setItem('h_azienda', JSON.stringify(aziendaCfg));
}

async function saveCfgCloud() {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  saveCfgLocal();
  showToast('Salvataggio in corso...', 'warning');
  try {
    const payload = {
      azienda:      aziendaCfg.azienda      || '',
      indirizzo:    aziendaCfg.indirizzo    || '',
      piva:         aziendaCfg.piva         || '',
      telefono:     aziendaCfg.telefono     || '',
      email:        aziendaCfg.email        || '',
      responsabile: aziendaCfg.responsabile || '',
      regsanitaria: aziendaCfg.regsanitaria || '',
      dataverifica: aziendaCfg.dataverifica || null
    };
    const { error } = await sb.from('aziende').update(payload).eq('id', currentAziendaId);
    if (error) throw error;
    await pullAzienda();
    applyConfig();
    showToast('✓ Dati azienda salvati', 'success');
  } catch(e) {
    console.error('[saveCfgCloud]', e);
    showToast('Errore: ' + (e.message || 'rete non raggiungibile'), 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════
function setupMonthFilter() {
  const sel=document.getElementById('filter-month'); if(!sel)return;
  sel.innerHTML='';
  const months=['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
  const now=new Date();
  for(let i=0;i<12;i++){const o=document.createElement('option');o.value=(i+1).toString().padStart(2,'0');o.text=months[i];if(i===now.getMonth())o.selected=true;sel.appendChild(o);}
}

function updateDeviceFilter() {
  const area=document.getElementById('filter-area').value;
  const ds=document.getElementById('filter-device');
  ds.innerHTML='<option value="ALL">Tutti i dispositivi</option>';
  [...new Set(config.filter(c=>area==='ALL'||c.area===area).map(c=>c.name))].forEach(d=>{
    const o=document.createElement('option');o.value=d;o.text=d;ds.appendChild(o);
  });
  renderHistory();
}

function toggleErrFilter() {
  onlyErr=!onlyErr;
  const btn=document.getElementById('btn-only-err');
  btn.style.background=onlyErr?'var(--red-light)':'';
  btn.style.borderColor=onlyErr?'#f09595':'';
  btn.style.color=onlyErr?'var(--red)':'';
  renderHistory();
}

function getFiltered() {
  if(!Array.isArray(cloudData))cloudData=[];
  const mF=document.getElementById('filter-month').value;
  const aF=document.getElementById('filter-area').value;
  const dF=document.getElementById('filter-device').value;
  return cloudData.filter(r=>{
    if(!Array.isArray(r)||!r[0]||r[0]==='Data'||r[0].includes('Data'))return false;
    const p=r[0].split('/'); if(p.length<2)return false;
    return p[1]===mF&&(aF==='ALL'||r[6]===aF)&&(dF==='ALL'||r[2]===dF)&&(!onlyErr||r[5]==='ERR');
  });
}

function renderHistory() {
  const data=getFiltered().reverse();
  const body=document.getElementById('history-body');
  const count=document.getElementById('history-count');
  if(!body)return;
  count.textContent=`${data.length} righe`;
  body.innerHTML='';
  if(!data.length){body.innerHTML='<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">Nessun dato trovato</td></tr>';return;}
  data.forEach(r=>{
    const ok=r[5]==='OK'; const key=`${r[2]}_${r[0]}_${r[1]}`; const hasFix=!!corrective[key];
    body.innerHTML+=`<tr class="${ok?'':'err-row'}">
      <td>${r[0]||''}<br><span style="color:var(--text-muted);font-size:10px;">${r[1]||''}</span></td>
      <td>${r[2]||''}<br><span style="color:var(--text-muted);font-size:10px;">${r[6]||''}</span></td>
      <td style="font-weight:700;color:${ok?'var(--green)':'var(--red)'};">${r[4]||''}°</td>
      <td><span class="badge ${ok?'badge-ok':'badge-err'}">${r[5]||''}</span>
        ${!ok&&hasFix?'<br><span class="badge badge-fix" style="margin-top:3px;display:inline-block;">Fix ✓</span>':''}
      </td>
    </tr>`;
  });
}

// ═══════════════════════════════════════════════════════════════
// EXPORT EXCEL
// ═══════════════════════════════════════════════════════════════
function exportExcel() {
  const data=getFiltered(); if(!data.length){showToast('Nessun dato','warning');return;}
  const mName=document.getElementById('filter-month').options[document.getElementById('filter-month').selectedIndex].text;
  const ws=XLSX.utils.json_to_sheet(data.map(r=>{
    const fix=corrective[`${r[2]}_${r[0]}_${r[1]}`];
    return {Data:r[0],Ora:r[1],Apparecchio:r[2],Tipo:r[3],'Temp (°C)':r[4],Stato:r[5],Zona:r[6],Operatore:r[7]||'',
      'Azione Correttiva':fix?fix.azioni.join(', ')+(fix.note?' — '+fix.note:''):'',
      'Responsabile Fix':fix?fix.responsabile:''};
  }));
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Report HACCP');
  XLSX.writeFile(wb,`HACCP_${mName.replace(/\s/g,'_')}.xlsx`);
}

// ═══════════════════════════════════════════════════════════════
// EXPORT PDF
// ═══════════════════════════════════════════════════════════════
function exportPDF() {
  const data = getFiltered();
  if (!data.length) { showToast('Nessun dato per il periodo selezionato', 'warning'); return; }
  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({orientation:'portrait', unit:'mm', format:'a4'});
  const mSel = document.getElementById('filter-month');
  const aSel = document.getElementById('filter-area');
  const mName = mSel.options[mSel.selectedIndex].text;
  const aName = aSel.options[aSel.selectedIndex].text;
  const W = 210, M = 14;
  const oggi = new Date().toLocaleString('it-IT');

  doc.setFillColor(26,58,92); doc.rect(0,0,W,50,'F');
  doc.setTextColor(255,255,255);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text('SISTEMA DI AUTOCONTROLLO ALIMENTARE', M, 14);
  doc.text('Reg. CE 852/2004 — Allegato II', M, 19);
  doc.setFontSize(16); doc.setFont('helvetica','bold');
  doc.text('REGISTRO CONTROLLO TEMPERATURE', M, 31);
  doc.setFontSize(10); doc.setFont('helvetica','normal');
  doc.text('HACCP Pro Cloud — Documento Ufficiale', M, 39);
  doc.text('Generato il: ' + oggi, W-M, 39, {align:'right'});

  let y = 58;
  doc.setTextColor(26,58,92); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('DATI AZIENDA', M, y); y += 6;
  doc.setDrawColor(26,58,92); doc.setLineWidth(0.5); doc.line(M, y, W-M, y); y += 5;
  const campiAzienda = [
    ['Ragione sociale', aziendaCfg.azienda || '________________'],
    ['Indirizzo', aziendaCfg.indirizzo || '________________'],
    ['P.IVA / C.F.', aziendaCfg.piva || '________________'],
    ['Telefono', aziendaCfg.telefono || '________________'],
    ['Email', aziendaCfg.email || '________________'],
    ['Responsabile HACCP', aziendaCfg.responsabile || '________________'],
    ['N. Registrazione Sanitaria', aziendaCfg.regsanitaria || '________________'],
    ['Data ultima verifica HACCP', aziendaCfg.dataverifica ? formatDateIT(aziendaCfg.dataverifica) : '________________']
  ];
  doc.setFontSize(9);
  campiAzienda.forEach(function(campo) {
    doc.setFont('helvetica','bold'); doc.setTextColor(60,60,60);
    doc.text(campo[0] + ':', M, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(30,30,30);
    doc.text(campo[1], 75, y);
    y += 7;
  });

  y += 4;
  doc.setTextColor(26,58,92); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('DATI DEL REGISTRO', M, y); y += 6;
  doc.setDrawColor(26,58,92); doc.line(M, y, W-M, y); y += 5;
  const errs = data.filter(r => r[5]==='ERR').length;
  const ok   = data.length - errs;
  const campiPeriodo = [
    ['Periodo di riferimento', mName],
    ['Zona / Area', aName],
    ['Totale rilevazioni', String(data.length)],
    ['Rilevazioni conformi', String(ok)],
    ['Rilevazioni non conformi', String(errs)],
    ['Soglia frigo', '+4°C (Reg. CE 852/2004)'],
    ['Soglia congelatore', '-18°C (Reg. CE 852/2004)']
  ];
  doc.setFontSize(9);
  campiPeriodo.forEach(function(campo) {
    doc.setFont('helvetica','bold'); doc.setTextColor(60,60,60);
    doc.text(campo[0] + ':', M, y);
    doc.setFont('helvetica','normal');
    doc.setTextColor(campo[0].includes('non conformi') && parseInt(campo[1])>0 ? 192 : 30, campo[0].includes('non conformi') && parseInt(campo[1])>0 ? 57 : 30, 30);
    doc.text(campo[1], 75, y);
    y += 7;
  });

  y += 8;
  doc.setTextColor(26,58,92); doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('DICHIARAZIONE DEL RESPONSABILE', M, y); y += 6;
  doc.setDrawColor(26,58,92); doc.line(M, y, W-M, y); y += 6;
  doc.setFontSize(8.5); doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50);
  doc.text('Il sottoscritto, in qualità di Responsabile HACCP, dichiara che le rilevazioni contenute nel presente', M, y); y+=5;
  doc.text('registro sono state effettuate secondo le procedure del piano di autocontrollo aziendale.', M, y); y+=10;
  doc.setFontSize(9); doc.setFont('helvetica','bold'); doc.setTextColor(60,60,60);
  doc.text('Data: ___________________', M, y);
  doc.text('Firma: ___________________________', 100, y); y+=14;
  doc.setDrawColor(150,150,150); doc.setLineWidth(0.3);
  doc.line(M, y, 70, y); doc.line(100, y, 190, y);

  doc.addPage();
  doc.setFillColor(26,58,92); doc.rect(0,0,W,18,'F');
  doc.setTextColor(255,255,255);
  doc.setFontSize(11); doc.setFont('helvetica','bold');
  doc.text('REGISTRO TEMPERATURE — ' + mName.toUpperCase() + ' — ' + aName.toUpperCase(), M, 8);
  doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.text((aziendaCfg.azienda||'') + '  ·  P.IVA: ' + (aziendaCfg.piva||'N/D'), M, 14);
  doc.text('Resp.: ' + (aziendaCfg.responsabile||'N/D'), W-M, 14, {align:'right'});

  [{label:'Totale', val:data.length, c:[26,58,92]},
   {label:'Conformi', val:ok, c:[26,122,74]},
   {label:'Non conformi', val:errs, c:[192,57,43]},
   {label:'Con azione', val:data.filter(r=>!!corrective[r[2]+'_'+r[0]+'_'+r[1]]).length, c:[133,79,11]}
  ].forEach(function(b,i) {
    const x = M + i*46;
    doc.setFillColor(b.c[0],b.c[1],b.c[2]); doc.roundedRect(x,22,43,14,2,2,'F');
    doc.setTextColor(255,255,255);
    doc.setFontSize(14); doc.setFont('helvetica','bold');
    doc.text(String(b.val), x+21.5, 31, {align:'center'});
    doc.setFontSize(6); doc.setFont('helvetica','normal');
    doc.text(b.label, x+21.5, 34, {align:'center'});
  });

  doc.autoTable({
    startY: 40,
    head: [['Data','Ora','Apparecchio','Zona','Tipo','Temp.','Stato','Operatore','Azione correttiva']],
    body: data.map(function(r) {
      const fix = corrective[r[2]+'_'+r[0]+'_'+r[1]];
      return [
        r[0]||'', r[1]||'', r[2]||'', r[6]||'', r[3]||'',
        (r[4]||'')+'°C', r[5]||'', r[7]||'N/D',
        fix ? (fix.azioni.join(', ')+(fix.note?' — '+fix.note:'')).substring(0,40) : '—'
      ];
    }),
    styles: {fontSize:6.5, cellPadding:2, lineColor:[220,227,234], lineWidth:0.3},
    headStyles: {fillColor:[26,58,92], textColor:255, fontStyle:'bold', fontSize:7},
    alternateRowStyles: {fillColor:[245,248,250]},
    columnStyles: {
      0:{cellWidth:17}, 1:{cellWidth:11}, 2:{cellWidth:28}, 3:{cellWidth:18},
      4:{cellWidth:13}, 5:{cellWidth:13,halign:'center'}, 6:{cellWidth:14,halign:'center'},
      7:{cellWidth:22}, 8:{cellWidth:46}
    },
    didParseCell: function(d) {
      if (d.section==='body' && d.column.index===6) {
        d.cell.styles.textColor = d.cell.raw==='ERR' ? [192,57,43] : [26,122,74];
        d.cell.styles.fontStyle = 'bold';
      }
    }
  });

  let yf = doc.lastAutoTable.finalY + 10;
  if (yf > 245) { doc.addPage(); yf = 20; }
  doc.setFillColor(26,58,92); doc.rect(M,yf,W-M*2,7,'F');
  doc.setTextColor(255,255,255); doc.setFontSize(8); doc.setFont('helvetica','bold');
  doc.text('FIRME OPERATORI', M+2, yf+5); yf += 12;
  const allFirme = Array.isArray(cloudFirme) ? cloudFirme.filter(r=>Array.isArray(r)&&r[2]) : [];
  if (!allFirme.length) {
    doc.setTextColor(120,120,120); doc.setFontSize(8); doc.setFont('helvetica','italic');
    doc.text('Nessuna firma digitale registrata per questo periodo.', M, yf+5); yf += 14;
  } else {
    allFirme.forEach(function(f) {
      if (yf > 262) { doc.addPage(); yf = 20; }
      doc.setTextColor(30,30,30); doc.setFontSize(8.5); doc.setFont('helvetica','bold');
      doc.text(f[2], M, yf+5);
      doc.setFont('helvetica','normal'); doc.setTextColor(110,110,110); doc.setFontSize(7.5);
      doc.text(f[0]+' '+( f[1]||''), M, yf+10);
      if (f[3]) { try { doc.addImage(f[3],'PNG',W-M-58,yf,58,18); } catch(e){} }
      doc.setDrawColor(210,210,210); doc.line(M,yf+24,W-M,yf+24); yf += 28;
    });
  }
  if (yf > 255) { doc.addPage(); yf = 20; }
  yf += 5;
  doc.setDrawColor(26,58,92); doc.setLineWidth(0.5); doc.line(M,yf,W-M,yf); yf+=6;
  doc.setFontSize(8); doc.setFont('helvetica','bold'); doc.setTextColor(26,58,92);
  doc.text('VALIDAZIONE RESPONSABILE HACCP', M, yf); yf+=7;
  doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50); doc.setFontSize(8);
  doc.text('Il Responsabile HACCP attesta la correttezza e completezza del presente registro.', M, yf); yf+=8;
  doc.text('Data: ___________________', M, yf);
  doc.text('Timbro e Firma: ___________________________', 100, yf); yf+=10;
  doc.setDrawColor(150,150,150); doc.setLineWidth(0.3);
  doc.line(M,yf,70,yf); doc.line(100,yf,190,yf);

  const pages = doc.internal.getNumberOfPages();
  for (let p=1; p<=pages; p++) {
    doc.setPage(p);
    doc.setFillColor(240,244,248); doc.rect(0,286,210,11,'F');
    doc.setTextColor(130,130,130); doc.setFontSize(7); doc.setFont('helvetica','normal');
    doc.text('HACCP Pro Cloud  ·  ' + (aziendaCfg.azienda||'') + '  ·  P.IVA: ' + (aziendaCfg.piva||'N/D') + '  ·  Reg. CE 852/2004', M, 291.5);
    doc.text('Pag. '+p+'/'+pages, W-M, 291.5, {align:'right'});
  }

  const nomefile = 'HACCP_' + (aziendaCfg.azienda||'registro').replace(/[^a-zA-Z0-9]/g,'_') + '_' + mName.replace(/\s/g,'_') + '.pdf';
  doc.save(nomefile);
  showToast('PDF ufficiale generato', 'success');
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════
function updateDate() {
  const now=new Date();
  const el=document.getElementById('today-date');
  if(el) el.textContent=now.toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'});
  const fd=document.getElementById('firma-data-display');
  if(fd) fd.value=now.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

// ═══════════════════════════════════════════════════════════════
// STAMPA SETTIMANALE
// ═══════════════════════════════════════════════════════════════
function checkStampaBanner() {
  const ultima = parseInt(localStorage.getItem('h_ultima_stampa') || '0');
  const ora    = Date.now();
  const sette  = 7 * 24 * 3600 * 1000;
  const banner = document.getElementById('stampa-banner');
  if (!banner) return;
  if (ora - ultima > sette) banner.style.display = 'block';
}

function posticipaBanner() {
  localStorage.setItem('h_ultima_stampa', String(Date.now() - 6 * 24 * 3600 * 1000));
  document.getElementById('stampa-banner').style.display = 'none';
}

function stampaDiretto() {
  document.getElementById('stampa-banner').style.display = 'none';
  localStorage.setItem('h_ultima_stampa', String(Date.now()));
  const now = new Date();
  const mese = String(now.getMonth()+1).padStart(2,'0');
  const selMese = document.getElementById('filter-month');
  if (selMese) selMese.value = mese;
  const selArea = document.getElementById('filter-area');
  if (selArea) selArea.value = 'ALL';
  const tabReport = document.querySelector('[onclick*="history"]');
  if (tabReport) tabReport.click();
  setTimeout(function() {
    exportPDF();
    showToast('Ricordati di firmare il documento stampato!', 'success');
  }, 300);
}

// ═══════════════════════════════════════════════════════════════
// RESET (solo Admin)
// ═══════════════════════════════════════════════════════════════
async function resetRegistrazioni() {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  if (!confirm("Sei sicuro di voler eliminare TUTTE le registrazioni dell'azienda?\nQuesta operazione è irreversibile.")) return;
  if (!confirm('ULTIMA CONFERMA: eliminare tutte le registrazioni?')) return;
  try {
    await sb.from('temperature').delete().eq('azienda_id', currentAziendaId);
    await sb.from('azioni_correttive').delete().eq('azienda_id', currentAziendaId);
    await sb.from('firme').delete().eq('azienda_id', currentAziendaId);
    cloudData = [];
    cloudAzioni = [['Data Anomalia','Ora Anomalia','Apparecchio','Zona','Temp Rilevata','Azioni Eseguite','Note','Responsabile','Salvato Il']];
    cloudFirme = [];
    offlineQueue = []; lastTemps = {};
    localStorage.setItem('h_clouddata', JSON.stringify([]));
    localStorage.setItem('h_azioni',    JSON.stringify(cloudAzioni));
    localStorage.setItem('h_firme',     JSON.stringify([]));
    localStorage.setItem('h_queue',     JSON.stringify([]));
    localStorage.setItem('h_lasttemps', JSON.stringify({}));
    buildCorrective();
    showToast('Registrazioni eliminate', 'success');
    updateQueueInfo();
    buildDash();
    renderDevices();
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

async function resetTutto() {
  if (!isAdmin()) { showToast('Solo Admin','error'); return; }
  if (!confirm("Sei sicuro di voler eliminare TUTTO?\nApparecchi, operatori, registrazioni e configurazione di questa azienda.\nOperazione irreversibile.")) return;
  if (!confirm('ULTIMA CONFERMA: reset completo?')) return;
  try {
    await sb.from('temperature').delete().eq('azienda_id', currentAziendaId);
    await sb.from('azioni_correttive').delete().eq('azienda_id', currentAziendaId);
    await sb.from('firme').delete().eq('azienda_id', currentAziendaId);
    await sb.from('apparecchi').delete().eq('azienda_id', currentAziendaId);
    await sb.from('operatori').delete().eq('azienda_id', currentAziendaId);
    await sb.from('slot_orari').delete().eq('azienda_id', currentAziendaId);
    config = []; operatori = [];
    scheduleSlots = [{time:"09:00",label:"Apertura"},{time:"15:00",label:"Pomeriggio"},{time:"21:00",label:"Chiusura"}];
    cloudData = []; cloudAzioni = []; cloudFirme = [];
    offlineQueue = []; lastTemps = {};
    saveAllLocal();
    renderSetup(); renderDevices(); buildDash();
    updateQueueInfo();
    showToast('Reset completo effettuato', 'success');
  } catch(e) { showToast('Errore: '+e.message,'error'); }
}

// Le funzioni di gestione password locale non servono più con Supabase Auth
function renderPasswordMgmt() { /* deprecato */ }

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
init();
