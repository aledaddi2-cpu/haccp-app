// ════════════════════════════════════════════════════════════════
// HACCP Pro · Admin Dashboard
// ────────────────────────────────────────────────────────────────
// Tutte le operazioni privilegiate passano dalla Edge Function
// `admin-api`, che valida il ruolo superadmin e usa SERVICE_ROLE.
// ════════════════════════════════════════════════════════════════

// ── CONFIG SUPABASE (le stesse dell'app principale) ─────────────
const SUPABASE_URL  = 'https://nmpbrjnmsybpzwhtsola.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tcGJyam5tc3licHp3aHRzb2xhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NjkyMjcsImV4cCI6MjA5MzQ0NTIyN30.yKsvu0lTns1GDF-Htzv8WUBlrjsIm1dkdxkMMCMX_Mc';

const ADMIN_API = SUPABASE_URL + '/functions/v1/admin-api';

// La console admin NON persiste la sessione: ogni volta che si apre
// la pagina, l'utente deve riautenticarsi. Questo impedisce che chi
// accede al PC trovi una sessione admin già pronta.
// Inoltre usa una storageKey separata per non interferire con la
// sessione dell'app cliente sullo stesso dominio.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: false,       // ← chiave: niente storage tra pagine/reload
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'haccp-console-session'  // ← namespace separato
  }
});

// ── STATO ────────────────────────────────────────────────────────
let allClients = [];      // cache della lista completa
let editingUserId = null; // user_id correntemente in modifica/rinnovo
let currentQRPayload = null;

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
async function init() {
  // Con persistSession: false la sessione non viene mai memorizzata
  // tra reload, quindi all'apertura della console mostriamo sempre
  // il form di login. La sessione dell'app cliente (su un altro
  // storageKey) NON viene toccata.
  showLogin();
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dash').classList.add('hidden');
  setTimeout(() => document.getElementById('login-email').focus(), 100);
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const err   = document.getElementById('login-err');
  const btn   = document.getElementById('login-btn');

  if (!email || !pass) { err.textContent = 'Email e password obbligatorie'; return; }

  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Accesso…';

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      err.textContent = error.message === 'Invalid login credentials'
        ? 'Credenziali non valide'
        : 'Errore: ' + error.message;
      btn.disabled = false; btn.textContent = 'Accedi →';
      return;
    }
    const role = data.session.user.app_metadata?.role
              || data.session.user.user_metadata?.role;
    if (role !== 'superadmin') {
      err.textContent = 'Account senza permessi superadmin';
      await sb.auth.signOut();
      btn.disabled = false; btn.textContent = 'Accedi →';
      return;
    }
    enterDashboard(data.session);
  } catch(e) {
    err.textContent = 'Errore rete: ' + e.message;
    btn.disabled = false; btn.textContent = 'Accedi →';
  }
}

async function doLogout() {
  if (!confirm('Uscire dalla dashboard admin?')) return;
  await sb.auth.signOut();
  showLogin();
}

function enterDashboard(session) {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dash').classList.remove('hidden');
  document.getElementById('user-info').textContent =
    session.user.email + ' · superadmin';
  loadClients();
}

// ════════════════════════════════════════════════════════════════
// API HELPER
// ════════════════════════════════════════════════════════════════
async function callAdminApi(action, body = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Sessione scaduta');

  const r = await fetch(ADMIN_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + session.access_token,
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON
    },
    body: JSON.stringify({ action, ...body })
  });
  const json = await r.json();
  if (!r.ok || json.error) throw new Error(json.error || ('HTTP ' + r.status));
  return json;
}

// ════════════════════════════════════════════════════════════════
// LIST CLIENTS
// ════════════════════════════════════════════════════════════════
async function loadClients() {
  document.getElementById('clienti-body').innerHTML =
    '<tr><td colspan="7" class="p-8 text-center text-slate-400 text-sm">Caricamento…</td></tr>';
  try {
    const { clients } = await callAdminApi('list_clients');
    allClients = clients || [];
    renderTable();
    updateStats();
    document.getElementById('footer-info').textContent =
      `Aggiornato: ${new Date().toLocaleTimeString('it-IT')}`;
  } catch(e) {
    console.error(e);
    showToast('Errore: ' + e.message, 'error');
    document.getElementById('clienti-body').innerHTML =
      `<tr><td colspan="7" class="p-8 text-center text-red-500 text-sm">${e.message}</td></tr>`;
  }
}

function updateStats() {
  const tot = allClients.length;
  const att = allClients.filter(c => c.stato === 'attivo').length;
  const sca = allClients.filter(c => c.stato === 'in_scadenza').length;
  const exp = allClients.filter(c => c.stato === 'scaduto').length;
  document.getElementById('stat-totale').textContent   = tot;
  document.getElementById('stat-attivi').textContent   = att;
  document.getElementById('stat-scadenza').textContent = sca;
  document.getElementById('stat-scaduti').textContent  = exp;
}

function renderTable() {
  const q       = (document.getElementById('search').value || '').toLowerCase().trim();
  const stato   = document.getElementById('filter-stato').value;
  const body    = document.getElementById('clienti-body');

  const filtered = allClients.filter(c => {
    if (stato !== 'all' && c.stato !== stato) return false;
    if (q && !(
      (c.nome_ristorante || '').toLowerCase().includes(q) ||
      (c.email           || '').toLowerCase().includes(q) ||
      (c.telefono_whatsapp || '').toLowerCase().includes(q)
    )) return false;
    return true;
  });

  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="p-8 text-center text-slate-400 text-sm">Nessun cliente trovato</td></tr>';
    return;
  }

  body.innerHTML = filtered.map(c => {
    const piano    = pianoBadge(c.piano_abbonamento);
    const stBadge  = c.stato === 'attivo'      ? '<span class="bg-green-100 text-green-800 px-2 py-0.5 rounded-full text-[11px] font-bold">attivo</span>'
                   : c.stato === 'in_scadenza' ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[11px] font-bold">in scadenza</span>'
                                               : '<span class="bg-red-100 text-red-800 px-2 py-0.5 rounded-full text-[11px] font-bold">scaduto</span>';
    const dataIT   = new Date(c.data_scadenza).toLocaleDateString('it-IT');
    const giorniLbl = c.giorni_mancanti < 0
      ? `scaduto da ${-c.giorni_mancanti} g`
      : c.giorni_mancanti > 36500 ? '∞ per sempre'
      : `tra ${c.giorni_mancanti} giorni`;

    // Badge pausa: mostra info sull'eventuale pausa attiva o sul contatore
    const pauseN   = c.pause_utilizzate || 0;
    const inPausa  = !!c.abbonamento_in_pausa;
    let pauseBadge = '';
    if (inPausa) {
      const fineP = c.pausa_fine_prevista ? new Date(c.pausa_fine_prevista).toLocaleDateString('it-IT') : '—';
      pauseBadge = `<span class="bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full text-[11px] font-bold" title="In pausa fino al ${fineP}">⏸ in pausa</span>
                    <div class="text-[10px] text-slate-500 mt-1">fino al ${fineP}</div>`;
    } else {
      const tone = pauseN >= 2 ? 'bg-red-50 text-red-700' : pauseN === 1 ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600';
      pauseBadge = `<span class="${tone} px-2 py-0.5 rounded-full text-[11px] font-bold">${pauseN}/2</span>`;
    }

    return `
      <tr class="border-b border-slate-100 hover:bg-slate-50">
        <td class="py-2.5 px-3">
          <div class="font-semibold text-slate-900">${escapeHtml(c.nome_ristorante || '—')}</div>
          <div class="text-[11px] text-slate-500 md:hidden">${escapeHtml(c.email || '')}</div>
          ${c.telefono_whatsapp ? `<div class="text-[11px] text-slate-400">📱 ${escapeHtml(c.telefono_whatsapp)}</div>` : ''}
        </td>
        <td class="py-2.5 px-3 text-slate-600 hidden md:table-cell">${escapeHtml(c.email || '—')}</td>
        <td class="py-2.5 px-3">${piano}</td>
        <td class="py-2.5 px-3">${pauseBadge}</td>
        <td class="py-2.5 px-3">
          <div class="text-slate-700">${dataIT}</div>
          <div class="text-[11px] text-slate-500">${giorniLbl}</div>
        </td>
        <td class="py-2.5 px-3">${stBadge}</td>
        <td class="py-2.5 px-3">
          <div class="flex gap-1 justify-end">
            <button onclick="openRenewModal('${c.user_id}')" title="Rinnova"
                    class="p-1.5 rounded border border-slate-300 hover:bg-blue-50 hover:border-blue-400 text-sm">↻</button>
            <button onclick="openQRModal('${c.user_id}')" title="QR Setup"
                    class="p-1.5 rounded border border-slate-300 hover:bg-purple-50 hover:border-purple-400 text-sm">▦</button>
            <button onclick="openEditModal('${c.user_id}')" title="Modifica"
                    class="p-1.5 rounded border border-slate-300 hover:bg-slate-100 text-sm">✎</button>
            <button onclick="doResetPassword('${c.user_id}')" title="Reset password"
                    class="p-1.5 rounded border border-slate-300 hover:bg-amber-50 hover:border-amber-400 text-sm">⚿</button>
            <button onclick="doDeleteClient('${c.user_id}')" title="Elimina"
                    class="p-1.5 rounded border border-slate-300 hover:bg-red-50 hover:border-red-400 text-red-700 text-sm">✕</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ════════════════════════════════════════════════════════════════
// CREATE
// ════════════════════════════════════════════════════════════════
function openCreateModal() {
  ['cf-email','cf-pass','cf-nome','cf-tel','cf-cmb','cf-indirizzo','cf-piva']
    .forEach(id => document.getElementById(id).value = '');
  document.getElementById('cf-piano').value = '14.99_manuale';
  document.getElementById('cf-mesi').value  = '1';
  document.getElementById('cf-err').textContent = '';
  // Suggerisci una password decente
  document.getElementById('cf-pass').value = generatePassword();
  document.getElementById('modal-create').classList.remove('hidden');
  setTimeout(() => document.getElementById('cf-email').focus(), 100);
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 10; i++) p += chars[Math.floor(Math.random()*chars.length)];
  return p;
}

async function doCreateClient() {
  const err = document.getElementById('cf-err');
  const btn = document.getElementById('cf-submit');
  err.textContent = '';

  const payload = {
    email:             document.getElementById('cf-email').value.trim(),
    password:          document.getElementById('cf-pass').value,
    nome_ristorante:   document.getElementById('cf-nome').value.trim(),
    telefono_whatsapp: document.getElementById('cf-tel').value.trim(),
    callmebot_apikey:  document.getElementById('cf-cmb').value.trim(),
    piano_abbonamento: document.getElementById('cf-piano').value,
    mesi_iniziali:     parseInt(document.getElementById('cf-mesi').value),
    indirizzo:         document.getElementById('cf-indirizzo').value.trim(),
    piva:              document.getElementById('cf-piva').value.trim(),
  };

  if (!payload.email || !payload.password || !payload.nome_ristorante) {
    err.textContent = 'Compila i campi obbligatori (*)'; return;
  }
  if (payload.password.length < 8) {
    err.textContent = 'Password troppo corta (min 8 caratteri)'; return;
  }

  btn.disabled = true; btn.textContent = 'Creazione…';
  try {
    const r = await callAdminApi('create_client', payload);
    closeModal('modal-create');
    showToast(`✓ Cliente creato: ${payload.email}`, 'success');
    // Mostra alert con credenziali da comunicare al cliente
    alert(
      `Cliente creato!\n\n` +
      `Email: ${payload.email}\n` +
      `Password: ${payload.password}\n\n` +
      `⚠️ COMUNICA QUESTE CREDENZIALI AL CLIENTE.\n` +
      `Non potrai più rivederle in chiaro.`
    );
    await loadClients();
  } catch(e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = '✓ Crea cliente';
  }
}

// ════════════════════════════════════════════════════════════════
// RENEW
// ════════════════════════════════════════════════════════════════
function openRenewModal(userId) {
  const c = allClients.find(x => x.user_id === userId);
  if (!c) return;
  editingUserId = userId;
  document.getElementById('renew-nome').textContent = c.nome_ristorante || c.email;
  document.getElementById('renew-scadenza-attuale').textContent =
    new Date(c.data_scadenza).toLocaleDateString('it-IT') +
    (c.giorni_mancanti < 0 ? ` (scaduto da ${-c.giorni_mancanti}g)` : ` (tra ${c.giorni_mancanti}g)`);
  document.getElementById('modal-renew').classList.remove('hidden');
}

async function doRenew(mesi) {
  if (!editingUserId) return;
  try {
    const r = await callAdminApi('extend_subscription', { user_id: editingUserId, mesi });
    const newDate = new Date(r.new_data_scadenza).toLocaleDateString('it-IT');
    closeModal('modal-renew');
    showToast(`✓ Rinnovato. Nuova scadenza: ${newDate}`, 'success');
    await loadClients();
  } catch(e) { showToast('Errore: ' + e.message, 'error'); }
}

async function doRenewForever() {
  if (!editingUserId) return;
  if (!confirm('Impostare scadenza al 31/12/2099 (di fatto "per sempre")?')) return;
  try {
    const r = await callAdminApi('extend_subscription', { user_id: editingUserId, forever: true });
    closeModal('modal-renew');
    showToast(`✓ Scadenza impostata al 2099`, 'success');
    await loadClients();
  } catch(e) { showToast('Errore: ' + e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════
// EDIT
// ════════════════════════════════════════════════════════════════
function openEditModal(userId) {
  const c = allClients.find(x => x.user_id === userId);
  if (!c) return;
  editingUserId = userId;
  document.getElementById('ef-nome').value  = c.nome_ristorante || '';
  document.getElementById('ef-tel').value   = c.telefono_whatsapp || '';
  document.getElementById('ef-cmb').value   = c.callmebot_apikey || '';
  document.getElementById('ef-piano').value = c.piano_abbonamento || '14.99_manuale';
  document.getElementById('ef-wa-notif-tipo').value = c.wa_notif_tipo || 'entrambi';
  toggleWaNotifTipo();
  document.getElementById('ef-note').value  = c.note_admin || '';
  // Data scadenza in formato YYYY-MM-DD per <input type="date">
  if (c.data_scadenza) {
    const d = new Date(c.data_scadenza);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    document.getElementById('ef-scadenza').value = `${y}-${m}-${day}`;
  } else {
    document.getElementById('ef-scadenza').value = '';
  }
  document.getElementById('modal-edit').classList.remove('hidden');
}

async function doSaveEdit() {
  if (!editingUserId) return;
  const payload = {
    user_id:           editingUserId,
    nome_ristorante:   document.getElementById('ef-nome').value.trim(),
    telefono_whatsapp: document.getElementById('ef-tel').value.trim(),
    callmebot_apikey:  document.getElementById('ef-cmb').value.trim(),
    piano_abbonamento: document.getElementById('ef-piano').value,
    wa_notif_tipo:     pianoHasWA(document.getElementById('ef-piano').value)
                         ? document.getElementById('ef-wa-notif-tipo').value
                         : 'entrambi',
    note_admin:        document.getElementById('ef-note').value,
  };
  // Data scadenza opzionale: includila solo se valorizzata
  const scadStr = document.getElementById('ef-scadenza').value;
  if (scadStr) {
    // Imposto fine giornata 23:59:59 per coerenza con i rinnovi
    payload.data_scadenza = new Date(scadStr + 'T23:59:59').toISOString();
  }
  try {
    await callAdminApi('update_client', payload);
    closeModal('modal-edit');
    showToast('✓ Modifiche salvate', 'success');
    await loadClients();
  } catch(e) { showToast('Errore: ' + e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════
// QR SETUP
// ════════════════════════════════════════════════════════════════
async function openQRModal(userId) {
  const c = allClients.find(x => x.user_id === userId);
  if (!c) return;
  const payload = {
    tenant_id: c.azienda_id,
    piano: c.piano_abbonamento,
    nome: c.nome_ristorante
  };
  currentQRPayload = JSON.stringify(payload);
  document.getElementById('qr-nome').textContent = c.nome_ristorante;
  document.getElementById('qr-payload').textContent = JSON.stringify(payload, null, 2);
  const target = document.getElementById('qr-target');
  target.innerHTML = '<div class="text-sm text-slate-400 p-4">Generazione QR…</div>';

  document.getElementById('modal-qr').classList.remove('hidden');

  // Strategia 1: libreria già caricata
  if (typeof QRCode !== 'undefined') {
    try {
      target.innerHTML = '';
      new QRCode(target, {
        text: currentQRPayload,
        width: 240, height: 240,
        correctLevel: QRCode.CorrectLevel.M
      });
      return;
    } catch(e) { console.warn('[QR] strategia 1 fallita:', e); }
  }

  // Strategia 2: carica al volo qrcodejs da jsdelivr (CDN diverso)
  try {
    await loadScript('https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs@gh-pages/qrcode.min.js');
    if (typeof QRCode !== 'undefined') {
      target.innerHTML = '';
      new QRCode(target, {
        text: currentQRPayload,
        width: 240, height: 240,
        correctLevel: QRCode.CorrectLevel.M
      });
      return;
    }
  } catch(e) { console.warn('[QR] strategia 2 fallita:', e); }

  // Strategia 3: fallback definitivo — usa un servizio web che restituisce
  // direttamente il PNG (nessun JS richiesto, funziona sempre)
  target.innerHTML = '';
  const img = document.createElement('img');
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=' +
            encodeURIComponent(currentQRPayload);
  img.alt = 'QR Code';
  img.style.cssText = 'width:240px;height:240px;display:block;margin:0 auto;';
  img.onerror = () => { target.innerHTML = '<div class="text-red-500 text-sm p-4">Impossibile generare il QR. Verifica connessione.</div>'; };
  target.appendChild(img);
}

// Helper: carica uno script esterno e attende che sia pronto
function loadScript(url) {
  return new Promise((resolve, reject) => {
    // Se è già stato caricato, resolve subito
    if ([...document.scripts].some(s => s.src === url)) return resolve();
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + url));
    document.head.appendChild(s);
  });
}

function downloadQR() {
  const canvas = document.querySelector('#qr-target canvas');
  if (canvas) {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `qr-haccp-${Date.now()}.png`;
    a.click();
    return;
  }
  const img = document.querySelector('#qr-target img');
  if (img) {
    // Apre l'immagine in una nuova tab → l'utente fa "salva come"
    window.open(img.src, '_blank');
    showToast('Immagine aperta — usa "Salva con nome"', 'info');
    return;
  }
  showToast('QR non disponibile per il download', 'error');
}

// ════════════════════════════════════════════════════════════════
// RESET PASSWORD
// ════════════════════════════════════════════════════════════════
async function doResetPassword(userId) {
  const c = allClients.find(x => x.user_id === userId);
  if (!c) return;
  if (!confirm(`Inviare email di recupero password a ${c.email}?`)) return;
  try {
    await callAdminApi('reset_password', { email: c.email });
    showToast(`✓ Email inviata a ${c.email}`, 'success');
  } catch(e) { showToast('Errore: ' + e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════════════════════════
async function doDeleteClient(userId) {
  const c = allClients.find(x => x.user_id === userId);
  if (!c) return;
  if (!confirm(`⚠️ ATTENZIONE — ELIMINAZIONE PERMANENTE\n\nStai per cancellare:\n• ${c.nome_ristorante}\n• ${c.email}\n• Tutti i dati HACCP (temperature, firme, apparecchi)\n\nL'operazione è IRREVERSIBILE. Continuare?`)) return;
  if (!confirm(`Ultima conferma: digita OK nella prossima finestra per confermare l'eliminazione di ${c.email}.`)) return;
  const conferma = prompt(`Per confermare, digita esattamente: ELIMINA`);
  if (conferma !== 'ELIMINA') { showToast('Eliminazione annullata', 'warning'); return; }
  try {
    await callAdminApi('delete_client', { user_id: userId });
    showToast(`✓ ${c.email} eliminato`, 'success');
    await loadClients();
  } catch(e) { showToast('Errore: ' + e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════
// MODAL UTILS + TOAST
// ════════════════════════════════════════════════════════════════
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (id !== 'modal-qr') editingUserId = null;
}
function closeModalBg(e, id) {
  if (e.target.id === id) closeModal(id);
}

function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  const colors = {
    success: 'bg-green-600',
    error:   'bg-red-600',
    warning: 'bg-amber-600',
    info:    'bg-slate-700'
  };
  t.className = 'fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-md text-white text-sm font-medium shadow-lg z-50 ' + (colors[type] || colors.info);
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// VIEW NAVIGATION (Clienti / Audit / Cestino)
// ════════════════════════════════════════════════════════════════
function setView(name, btn) {
  // Reset pillole
  document.querySelectorAll('.nav-pill').forEach(p => {
    p.classList.remove('bg-slate-800','text-white','nav-pill-active');
    p.classList.add('bg-white','border','border-slate-300','text-slate-700');
  });
  // Attiva pillola corrente
  btn.classList.add('bg-slate-800','text-white','nav-pill-active');
  btn.classList.remove('bg-white','border','border-slate-300','text-slate-700');

  // Mostra view
  document.getElementById('view-clients').classList.add('hidden');
  document.getElementById('view-audit').classList.add('hidden');
  document.getElementById('view-trash').classList.add('hidden');
  document.getElementById('view-' + name).classList.remove('hidden');

  // Quando entri in audit/trash, popola le select dei clienti
  if (name === 'audit')  populateClientSelect('audit-client');
  if (name === 'trash')  populateClientSelect('trash-client');
}

function populateClientSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  // Mantieni eventuale selezione corrente
  const current = sel.value;
  // Pulisci e ripopola
  sel.innerHTML = (selectId === 'trash-client'
    ? '<option value="">Seleziona cliente</option>'
    : '<option value="">Tutti i clienti</option>');
  allClients.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.azienda_id;
    opt.textContent = c.nome_ristorante + ' (' + c.email + ')';
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

// ════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════
let lastAuditResults = [];

async function loadAudit() {
  const body = document.getElementById('audit-body');
  body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 text-sm">Caricamento…</td></tr>';

  const days = parseInt(document.getElementById('audit-period').value);
  const from = new Date(Date.now() - days*86400*1000).toISOString();

  const params = {
    from,
    azienda_id: document.getElementById('audit-client').value || undefined,
    table_name: document.getElementById('audit-table').value || undefined,
    operation:  document.getElementById('audit-op').value     || undefined,
    limit: 500
  };
  // Rimuovi chiavi undefined
  Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

  try {
    const r = await callAdminApi('list_audit', params);
    lastAuditResults = r.logs || [];
    renderAuditTable();
    document.getElementById('audit-count').textContent =
      `${lastAuditResults.length} record (limite ${r.limit})`;
  } catch(e) {
    body.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-red-500 text-sm">${e.message}</td></tr>`;
  }
}

function renderAuditTable() {
  const body = document.getElementById('audit-body');
  if (!lastAuditResults.length) {
    body.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400 text-sm">Nessun log trovato per i filtri selezionati</td></tr>';
    return;
  }
  const opColors = {
    INSERT:      'bg-green-100 text-green-800',
    UPDATE:      'bg-blue-100 text-blue-800',
    DELETE:      'bg-red-100 text-red-800',
    SOFT_DELETE: 'bg-orange-100 text-orange-800',
    RESTORE:     'bg-purple-100 text-purple-800'
  };
  body.innerHTML = lastAuditResults.map(l => {
    const dt = new Date(l.performed_at).toLocaleString('it-IT');
    const opCls = opColors[l.operation] || 'bg-slate-100 text-slate-700';
    let dettagli = '';
    if (l.operation === 'UPDATE' && l.changed && l.changed.length > 0) {
      dettagli = '<details class="cursor-pointer"><summary class="text-xs text-slate-600 hover:text-slate-900">' +
        escapeHtml(l.changed.join(', ')) + '</summary>' +
        '<pre class="text-[10px] mt-1 p-2 bg-slate-50 rounded overflow-auto max-w-md">' +
        escapeHtml(JSON.stringify({ old: l.old_data, new: l.new_data }, null, 1)) +
        '</pre></details>';
    } else if (l.operation === 'DELETE' || l.operation === 'SOFT_DELETE') {
      dettagli = '<details class="cursor-pointer"><summary class="text-xs text-slate-600 hover:text-slate-900">vedi dati cancellati</summary>' +
        '<pre class="text-[10px] mt-1 p-2 bg-slate-50 rounded overflow-auto max-w-md">' +
        escapeHtml(JSON.stringify(l.old_data, null, 1)) +
        '</pre></details>';
    } else if (l.operation === 'INSERT') {
      dettagli = '<details class="cursor-pointer"><summary class="text-xs text-slate-600 hover:text-slate-900">vedi dati creati</summary>' +
        '<pre class="text-[10px] mt-1 p-2 bg-slate-50 rounded overflow-auto max-w-md">' +
        escapeHtml(JSON.stringify(l.new_data, null, 1)) +
        '</pre></details>';
    }
    return `<tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="py-2.5 px-3 text-xs text-slate-600 whitespace-nowrap">${dt}</td>
      <td class="py-2.5 px-3 text-xs">${escapeHtml(l.user_email || '—')}<br><span class="text-slate-400">${escapeHtml(l.user_role || '')}</span></td>
      <td class="py-2.5 px-3"><code class="text-xs bg-slate-100 px-1.5 py-0.5 rounded">${escapeHtml(l.table_name)}</code></td>
      <td class="py-2.5 px-3"><span class="${opCls} px-2 py-0.5 rounded-full text-[11px] font-bold">${l.operation}</span></td>
      <td class="py-2.5 px-3">${dettagli}</td>
    </tr>`;
  }).join('');
}

function exportAuditCSV() {
  if (!lastAuditResults.length) {
    showToast('Nessun dato da esportare. Esegui prima una ricerca.', 'warning');
    return;
  }
  const headers = ['Data/Ora','Utente','Ruolo','Azienda','Tabella','Operazione','Record ID','Campi modificati'];
  const rows = lastAuditResults.map(l => [
    new Date(l.performed_at).toLocaleString('it-IT'),
    l.user_email || '',
    l.user_role || '',
    l.azienda_id || '',
    l.table_name,
    l.operation,
    l.record_id || '',
    (l.changed || []).join('; ')
  ]);
  const csv = [headers, ...rows].map(r => r.map(c =>
    `"${String(c).replace(/"/g,'""')}"`
  ).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit_log_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV scaricato', 'success');
}

// ════════════════════════════════════════════════════════════════
// CESTINO (soft-deleted)
// ════════════════════════════════════════════════════════════════
let lastTrashResults = [];
let lastTrashTable = null;

async function loadTrash() {
  const azienda_id = document.getElementById('trash-client').value;
  const table_name = document.getElementById('trash-table').value;
  if (!azienda_id) { showToast('Seleziona un cliente', 'warning'); return; }

  const body = document.getElementById('trash-body');
  body.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-slate-400 text-sm">Caricamento…</td></tr>';

  try {
    const r = await callAdminApi('list_trash', { azienda_id, table_name });
    lastTrashResults = r.records || [];
    lastTrashTable   = r.table_name;
    renderTrashTable();
    document.getElementById('trash-count').textContent = `${lastTrashResults.length} record nel cestino`;
  } catch(e) {
    body.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-red-500 text-sm">${e.message}</td></tr>`;
  }
}

function renderTrashTable() {
  const body = document.getElementById('trash-body');
  if (!lastTrashResults.length) {
    body.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-slate-400 text-sm">Cestino vuoto per questo cliente</td></tr>';
    return;
  }
  body.innerHTML = lastTrashResults.map(r => {
    const dl = r.deleted_at ? new Date(r.deleted_at).toLocaleString('it-IT') : '—';
    // Riassunto dati basato sulla tabella
    let summary = '';
    if (lastTrashTable === 'temperature') {
      summary = `<b>${escapeHtml(r.apparecchio || '')}</b> · ${r.temp}°C · ${escapeHtml(r.data || '')} ${escapeHtml(r.ora || '')} <span class="text-slate-400">(${escapeHtml(r.stato || '')})</span>`;
    } else if (lastTrashTable === 'azioni_correttive') {
      summary = `<b>${escapeHtml(r.apparecchio || '')}</b> · ${escapeHtml(r.data_anomalia || '')} ${escapeHtml(r.ora_anomalia || '')} · ${escapeHtml((r.azioni || '').substring(0,50))}`;
    } else if (lastTrashTable === 'firme') {
      summary = `<b>${escapeHtml(r.operatore || '')}</b> · ${escapeHtml(r.data || '')} ${escapeHtml(r.ora || '')}`;
    }
    return `<tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="py-2.5 px-3 text-xs text-slate-600 whitespace-nowrap">${dl}</td>
      <td class="py-2.5 px-3 text-sm">${summary}</td>
      <td class="py-2.5 px-3 text-right">
        <button onclick="doRestore('${r.id}')"
                class="px-3 py-1.5 rounded-md bg-green-600 hover:bg-green-700 text-white text-xs font-bold">
          ↩ Ripristina
        </button>
      </td>
    </tr>`;
  }).join('');
}

async function doRestore(id) {
  if (!confirm('Ripristinare questo record? Tornerà visibile al cliente.')) return;
  try {
    await callAdminApi('restore_record', { table_name: lastTrashTable, id });
    showToast('✓ Record ripristinato', 'success');
    await loadTrash();   // refresh cestino
  } catch(e) {
    showToast('Errore: ' + e.message, 'error');
  }
}


// ════════════════════════════════════════════════════════════════
init();

// ── Toggle visibilità blocco tipo notifica WA ────────────────────────────────
// ── Helper: quali piani includono WhatsApp ────────────────────────────────────
const PIANI_WA = ['19.99_esp32', '24.99_esp32_plus'];
function pianoHasWA(val) { return PIANI_WA.includes(val); }

function pianoBadge(val) {
  const map = {
    '14.99_manuale':    ['bg-blue-100 text-blue-800',   '14.99 manuale'],
    '19.99_esp32':      ['bg-green-100 text-green-800',  '19.99 ESP32'],
    '24.99_esp32_plus': ['bg-purple-100 text-purple-800','24.99 ESP32+'],
  };
  const [cls, label] = map[val] || ['bg-slate-100 text-slate-600', val || '—'];
  return `<span class="${cls} px-2 py-0.5 rounded-full text-[11px] font-bold">${label}</span>`;
}

// ── Toggle visibilità blocco tipo notifica WA ─────────────────────────────────
function toggleWaNotifTipo() {
  const piano = document.getElementById('ef-piano');
  const block = document.getElementById('ef-wa-tipo-block');
  if (!piano || !block) return;
  block.style.display = pianoHasWA(piano.value) ? '' : 'none';
  // Se 24.99 forza entrambi come default, se 19.99 forza solo_messaggio come default
  const sel = document.getElementById('ef-wa-notif-tipo');
  if (sel && piano.value === '19.99_esp32' && sel.value === 'entrambi') {
    sel.value = 'solo_messaggio';
  }
  if (sel && piano.value === '24.99_esp32_plus' && sel.value === 'solo_messaggio') {
    sel.value = 'entrambi';
  }
}
