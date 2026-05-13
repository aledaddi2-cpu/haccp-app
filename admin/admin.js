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

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
});

// ── STATO ────────────────────────────────────────────────────────
let allClients = [];      // cache della lista completa
let editingUserId = null; // user_id correntemente in modifica/rinnovo
let currentQRPayload = null;

// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const role = session.user.app_metadata?.role || session.user.user_metadata?.role;
    if (role === 'superadmin') {
      enterDashboard(session);
      return;
    }
    // logato ma non superadmin → forza logout silenzioso
    await sb.auth.signOut();
  }
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
    '<tr><td colspan="6" class="p-8 text-center text-slate-400 text-sm">Caricamento…</td></tr>';
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
      `<tr><td colspan="6" class="p-8 text-center text-red-500 text-sm">${e.message}</td></tr>`;
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
    body.innerHTML = '<tr><td colspan="6" class="p-8 text-center text-slate-400 text-sm">Nessun cliente trovato</td></tr>';
    return;
  }

  body.innerHTML = filtered.map(c => {
    const piano    = c.piano_abbonamento === '24.99_automatico'
      ? '<span class="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full text-[11px] font-bold">24.99 auto</span>'
      : '<span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full text-[11px] font-bold">14.99 manuale</span>';
    const stBadge  = c.stato === 'attivo'      ? '<span class="bg-green-100 text-green-800 px-2 py-0.5 rounded-full text-[11px] font-bold">attivo</span>'
                   : c.stato === 'in_scadenza' ? '<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full text-[11px] font-bold">in scadenza</span>'
                                               : '<span class="bg-red-100 text-red-800 px-2 py-0.5 rounded-full text-[11px] font-bold">scaduto</span>';
    const dataIT   = new Date(c.data_scadenza).toLocaleDateString('it-IT');
    const giorniLbl = c.giorni_mancanti < 0
      ? `scaduto da ${-c.giorni_mancanti} g`
      : c.giorni_mancanti > 36500 ? '∞ per sempre'
      : `tra ${c.giorni_mancanti} giorni`;

    return `
      <tr class="border-b border-slate-100 hover:bg-slate-50">
        <td class="py-2.5 px-3">
          <div class="font-semibold text-slate-900">${escapeHtml(c.nome_ristorante || '—')}</div>
          <div class="text-[11px] text-slate-500 md:hidden">${escapeHtml(c.email || '')}</div>
          ${c.telefono_whatsapp ? `<div class="text-[11px] text-slate-400">📱 ${escapeHtml(c.telefono_whatsapp)}</div>` : ''}
        </td>
        <td class="py-2.5 px-3 text-slate-600 hidden md:table-cell">${escapeHtml(c.email || '—')}</td>
        <td class="py-2.5 px-3">${piano}</td>
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
  document.getElementById('ef-note').value  = c.note_admin || '';
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
    note_admin:        document.getElementById('ef-note').value,
  };
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
function openQRModal(userId) {
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
  // Genera il QR
  const target = document.getElementById('qr-target');
  target.innerHTML = '';
  QRCode.toCanvas(currentQRPayload, { width: 240, margin: 1, errorCorrectionLevel: 'M' }, (err, canvas) => {
    if (err) { target.textContent = 'Errore: ' + err.message; return; }
    canvas.id = 'qr-canvas';
    target.appendChild(canvas);
  });
  document.getElementById('modal-qr').classList.remove('hidden');
}

function downloadQR() {
  const canvas = document.getElementById('qr-canvas');
  if (!canvas) return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `qr-haccp-${Date.now()}.png`;
  a.click();
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
// START
// ════════════════════════════════════════════════════════════════
init();
