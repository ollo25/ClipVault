// ─── Application principale ───────────────────────────────────────────────────
import { isLoggedIn, getSession, signOut, handleTwitchCallback, startTwitchOAuth } from './auth.js';
import { getProfile, saveProfile, getFavoriteIds, addFavorite, removeFavorite } from './db.js';
import { setTwitchCredentials, getBroadcasterInfo, fetchAllClips, validateToken } from './api.js';
import { TWITCH_CLIENT_ID } from './config.js';

// ── État global ───────────────────────────────────────────────────────────────
const state = {
  allClips:      [],
  filteredClips: [],
  favoriteIds:   new Set(),
  currentSort:   'time',
  currentOrder:  'desc',
  searchMode:    'all',
  reversed:      false,
  cols:          1,
  renderedCards: new Map(),
  profile:       null,
};

// ── Constantes virtual scroll ─────────────────────────────────────────────────
const CARD_W   = 300;
const CARD_H   = 250; // thumb 169px + body
const CARD_GAP = 16;
const OVERSCAN = 3;

// ── Éléments DOM ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Pages
const pageAuth    = $('page-auth');
const pageSetup   = $('page-setup');
const pageApp     = $('page-app');

// Auth
const tabLogin    = $('tab-login');
const tabSignup   = $('tab-signup');
const formLogin   = $('form-login');
const formSignup  = $('form-signup');

// Setup (credentials Twitch)
const setupForm   = $('setup-form');

// App header
const userEmail   = $('user-email');
const btnLogout   = $('btn-logout');
const btnSetup    = $('btn-setup');
const btnFavs     = $('btn-favs');
const favCountEl  = $('fav-count');
const countBadge  = $('count-badge');

// Chaîne
const channelInput= $('channel-input');
const loadBtn     = $('btn-load');

// Filtres
const filterBar   = $('filter-bar');
const filterSearch= $('filter-search');
const filterFrom  = $('filter-date-from');
const filterTo    = $('filter-date-to');
const filterCount = $('filter-count');
const clearBtn    = $('btn-clear-filters');

// Grille
const stateEl     = $('state');
const gridWrap    = $('grid-wrap');
const gridContainer=$('grid-container');
const gridEl      = $('grid');

// Favoris
const favsView    = $('favs-view');
const favsGrid    = $('favs-grid');

// Logs
const logPanel    = $('log-panel');
const logBody     = $('log-body');
const logToggle   = $('log-toggle');

// ── Logs ──────────────────────────────────────────────────────────────────────
const logEntries = [];
let logWarnCount = 0, logErrorCount = 0;

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  logEntries.push({ ts, level, msg });
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="log-ts">${ts}</span>${escHtml(msg)}`;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
  if (level === 'warn')  logWarnCount++;
  if (level === 'error') logErrorCount++;
  updateLogToggle();
}

function updateLogToggle() {
  logToggle.textContent = `📋 Logs (${logEntries.length})`;
  logToggle.className = logErrorCount > 0 ? 'has-error' : logWarnCount > 0 ? 'has-warn' : '';
}

// ── Navigation entre pages ────────────────────────────────────────────────────
function showPage(page) {
  [pageAuth, pageSetup, pageApp].forEach(p => p.classList.remove('active'));
  page.classList.add('active');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Vérifier si on revient d'un OAuth Twitch
  const twitchToken = handleTwitchCallback();
  if (twitchToken && isLoggedIn()) {
    try {
      await saveProfile({ twitch_client_id: TWITCH_CLIENT_ID, twitch_token: twitchToken });
      showToast('Compte Twitch lié avec succès !', 'success');
    } catch (e) {
      showToast('Erreur lors de la sauvegarde du token Twitch', 'error');
    }
  }

  if (!isLoggedIn()) {
    showPage(pageAuth);
    return;
  }

  // Charger le profil
  try {
    state.profile = await getProfile();
  } catch (e) {
    showPage(pageAuth);
    return;
  }

  // Vérifier si le profil a les credentials Twitch
  if (!state.profile?.twitch_token || !state.profile?.twitch_client_id) {
    setupCredentials();
    return;
  }

  // Valider le token Twitch
  setTwitchCredentials(state.profile.twitch_client_id, state.profile.twitch_token);
  const valid = await validateToken();
  if (!valid) {
    showPage(pageSetup);
    $('setup-msg').textContent = 'Ton token Twitch a expiré. Reconnecte-toi à Twitch.';
    return;
  }

  // Charger les favoris
  state.favoriteIds = await getFavoriteIds().catch(() => new Set());
  updateFavBadge();

  // Afficher l'app
  const session = getSession();
  userEmail.textContent = session.user.email;
  showPage(pageApp);
}

function setupCredentials() {
  showPage(pageSetup);
}

// ── Auth handlers ─────────────────────────────────────────────────────────────
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active'); tabSignup.classList.remove('active');
  formLogin.classList.remove('hidden'); formSignup.classList.add('hidden');
});
tabSignup.addEventListener('click', () => {
  tabSignup.classList.add('active'); tabLogin.classList.remove('active');
  formSignup.classList.remove('hidden'); formLogin.classList.add('hidden');
});

$('btn-login').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const pass  = $('login-pass').value;
  if (!email || !pass) return showFormError('login-error', 'Remplis tous les champs');
  try {
    $('btn-login').disabled = true;
    const { signIn } = await import('./auth.js');
    await signIn(email, pass);
    await init();
  } catch (e) {
    showFormError('login-error', e.message);
  } finally {
    $('btn-login').disabled = false;
  }
});

$('btn-signup').addEventListener('click', async () => {
  const email = $('signup-email').value.trim();
  const pass  = $('signup-pass').value;
  const pass2 = $('signup-pass2').value;
  if (!email || !pass) return showFormError('signup-error', 'Remplis tous les champs');
  if (pass !== pass2) return showFormError('signup-error', 'Les mots de passe ne correspondent pas');
  if (pass.length < 6) return showFormError('signup-error', 'Mot de passe trop court (6 caractères min)');
  try {
    $('btn-signup').disabled = true;
    const { signUp } = await import('./auth.js');
    await signUp(email, pass);
    showFormError('signup-error', '✓ Compte créé ! Vérifie ton email puis connecte-toi.', 'success');
  } catch (e) {
    showFormError('signup-error', e.message);
  } finally {
    $('btn-signup').disabled = false;
  }
});

btnLogout.addEventListener('click', async () => {
  await signOut();
  state.allClips = [];
  state.filteredClips = [];
  state.profile = null;
  showPage(pageAuth);
});

btnSetup.addEventListener('click', () => showPage(pageSetup));

// ── Setup Twitch ──────────────────────────────────────────────────────────────
setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const clientId = $('setup-client-id').value.trim();
  const token    = $('setup-token').value.trim();
  if (!clientId || !token) return;

  try {
    $('btn-setup-save').disabled = true;
    setTwitchCredentials(clientId, token);
    const valid = await validateToken();
    if (!valid) {
      showFormError('setup-error', 'Token invalide ou expiré — génère-en un nouveau');
      return;
    }
    await saveProfile({ twitch_client_id: clientId, twitch_token: token });
    state.profile = { ...state.profile, twitch_client_id: clientId, twitch_token: token };
    showToast('Credentials Twitch sauvegardés !', 'success');
    showPage(pageApp);
  } catch (e) {
    showFormError('setup-error', e.message);
  } finally {
    $('btn-setup-save').disabled = false;
  }
});

$('btn-oauth-twitch').addEventListener('click', startTwitchOAuth);

$('btn-cancel-setup').addEventListener('click', () => {
  if (state.profile?.twitch_token) showPage(pageApp);
});

// ── Chargement clips ──────────────────────────────────────────────────────────
async function load() {
  const channel = channelInput.value.trim();
  if (!channel) { channelInput.focus(); return; }

  loadBtn.disabled = true;
  state.allClips = [];
  state.filteredClips = [];
  state.renderedCards.clear();
  gridEl.innerHTML = '';
  logEntries.length = 0;
  logWarnCount = 0; logErrorCount = 0;
  logBody.innerHTML = '';
  updateLogToggle();

  try {
    setState('loading', 'Recherche de la chaîne…');
    log('info', `=== Chargement : ${channel} ===`);

    const info = await getBroadcasterInfo(channel);
    log('info', `Chaîne : ${info.display_name} (créée le ${info.created_at?.slice(0,10)})`);

    const clips = await fetchAllClips(info.id, info.created_at, {
      onProgress: (msg, count) => setState('loading', msg, count),
      onLog: log,
    });

    if (clips.length === 0) {
      setState('error', `Aucun clip trouvé pour <strong>${escHtml(channel)}</strong>`);
      return;
    }

    // Déduplication finale
    const seen = new Set();
    state.allClips = clips.filter(c => seen.has(c.id) ? false : (seen.add(c.id), true));
    log('success', `=== ${state.allClips.length} clips uniques ===`);

    // Reset filtres
    resetFilters();

    countBadge.textContent   = `${state.allClips.length} clips`;
    countBadge.style.display = 'block';
    stateEl.style.display    = 'none';
    gridWrap.style.display   = 'block';
    filterBar.classList.add('visible');
    document.title = `${info.display_name} — Clip Browser`;

    applyFilters();

  } catch (e) {
    if (e.message === 'TOKEN_EXPIRED') {
      setState('error', 'Token Twitch expiré. <a href="#" id="refresh-token-link">Mettre à jour les credentials</a>');
      document.getElementById('refresh-token-link')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        showPage(pageSetup);
      });
    } else {
      setState('error', escHtml(e.message));
    }
    log('error', e.message);
  } finally {
    loadBtn.disabled = false;
  }
}

loadBtn.addEventListener('click', load);
channelInput.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });

// ── Filtres ───────────────────────────────────────────────────────────────────
function applyFilters() {
  const q        = filterSearch.value.trim().toLowerCase();
  const dateFrom = filterFrom.value ? new Date(filterFrom.value) : null;
  const dateTo   = filterTo.value   ? new Date(filterTo.value + 'T23:59:59') : null;

  let result = state.allClips.filter(clip => {
    if (q) {
      if (state.searchMode === 'title'   && !clip.title.toLowerCase().includes(q))        return false;
      if (state.searchMode === 'creator' && !clip.creator_name.toLowerCase().includes(q)) return false;
      if (state.searchMode === 'all'     && !clip.title.toLowerCase().includes(q)
                                         && !clip.creator_name.toLowerCase().includes(q)) return false;
    }
    const created = new Date(clip.created_at);
    if (dateFrom && created < dateFrom) return false;
    if (dateTo   && created > dateTo)   return false;
    return true;
  });

  switch (state.currentSort) {
    case 'views':   result.sort((a, b) => b.view_count - a.view_count); break;
    case 'title':   result.sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' })); break;
    case 'creator': result.sort((a, b) => a.creator_name.localeCompare(b.creator_name, 'fr', { sensitivity: 'base' })); break;
    default:        result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); break;
  }
  if (state.currentOrder === 'asc') result.reverse();

  state.filteredClips = result;

  const active = q || dateFrom || dateTo;
  filterCount.textContent = active ? `${result.length} / ${state.allClips.length}` : `${state.allClips.length} clips`;
  filterCount.style.color = active && result.length === 0 ? '#ff4444' : active ? 'var(--muted)' : 'var(--dim)';

  state.renderedCards.clear();
  gridEl.innerHTML = '';
  computeCols();
  setGridHeight();
  window.scrollTo(0, 0);
  renderVisible();
}

function resetFilters() {
  filterSearch.value = '';
  filterFrom.value   = '';
  filterTo.value     = '';
  state.currentSort  = 'time';
  state.currentOrder = 'desc';
  state.searchMode   = 'all';
  filterSearch.placeholder = 'Rechercher…';
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-mode="all"]')?.classList.add('active');
  document.querySelectorAll('.sort-btn[data-sort]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-sort="time"]')?.classList.add('active');
  document.querySelectorAll('.sort-btn[data-order]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-order="desc"]')?.classList.add('active');
}

let filterTimer = null;
filterSearch.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilters, 180);
});
filterFrom.addEventListener('change', applyFilters);
filterTo.addEventListener('change', applyFilters);

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.searchMode = btn.dataset.mode;
    filterSearch.placeholder = state.searchMode === 'title'   ? 'Rechercher un titre…'
                             : state.searchMode === 'creator' ? 'Rechercher un créateur…'
                             : 'Rechercher…';
    if (filterSearch.value.trim()) applyFilters();
  });
});

document.querySelectorAll('.sort-btn[data-sort]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn[data-sort]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentSort = btn.dataset.sort;
    applyFilters();
  });
});

document.querySelectorAll('.sort-btn[data-order]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sort-btn[data-order]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentOrder = btn.dataset.order;
    applyFilters();
  });
});

clearBtn.addEventListener('click', () => { resetFilters(); applyFilters(); });

// ── Virtual scroll ────────────────────────────────────────────────────────────
function computeCols() {
  state.cols = Math.max(1, Math.floor((gridWrap.clientWidth - 40 + CARD_GAP) / (CARD_W + CARD_GAP)));
}

function totalRows() { return Math.ceil(state.filteredClips.length / state.cols); }
function rowH()      { return CARD_H + CARD_GAP; }

function setGridHeight() {
  const h = (totalRows() * rowH() + CARD_GAP) + 'px';
  gridContainer.style.height = h;
  gridEl.style.height        = h;
}

function renderVisible() {
  const scrollY  = window.scrollY;
  const vpH      = window.innerHeight;
  const firstRow = Math.max(0, Math.floor(scrollY / rowH()) - OVERSCAN);
  const lastRow  = Math.min(totalRows() - 1, Math.ceil((scrollY + vpH) / rowH()) + OVERSCAN);
  const firstIdx = firstRow * state.cols;
  const lastIdx  = Math.min(state.filteredClips.length - 1, (lastRow + 1) * state.cols - 1);

  for (const [idx, el] of state.renderedCards) {
    if (idx < firstIdx || idx > lastIdx) { el.remove(); state.renderedCards.delete(idx); }
  }
  for (let i = firstIdx; i <= lastIdx; i++) {
    if (state.renderedCards.has(i)) continue;
    const clip = state.filteredClips[i];
    if (!clip) continue;
    const card = createCard(clip, i);
    card.style.left = ((i % state.cols) * (CARD_W + CARD_GAP)) + 'px';
    card.style.top  = (Math.floor(i / state.cols) * rowH() + CARD_GAP) + 'px';
    gridEl.appendChild(card);
    state.renderedCards.set(i, card);
  }
}

let scrollRaf = null;
window.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = null; renderVisible(); });
}, { passive: true });

window.addEventListener('resize', () => {
  if (!state.filteredClips.length) return;
  computeCols(); setGridHeight();
  state.renderedCards.clear(); gridEl.innerHTML = '';
  renderVisible();
});

// ── Cartes ────────────────────────────────────────────────────────────────────
function createCard(clip, index) {
  const q      = filterSearch.value.trim();
  const isFav  = state.favoriteIds.has(clip.id);
  const card   = document.createElement('div');
  card.className = `card${isFav ? ' is-fav' : ''}`;

  const title   = q ? highlight(escHtml(clip.title), q)        : escHtml(clip.title);
  const creator = q ? highlight(escHtml(clip.creator_name), q) : escHtml(clip.creator_name);

  card.innerHTML = `
    <div class="thumb-wrap">
      <img class="thumb" src="${clip.thumbnail_url || ''}" alt="" loading="lazy" />
      <span class="duration">${formatDuration(clip.duration)}</span>
      ${index < 3 ? `<span class="rank">#${index + 1}</span>` : ''}
      <button class="fav-btn${isFav ? ' active' : ''}" data-id="${clip.id}">${isFav ? '⭐' : '☆'}</button>
    </div>
    <div class="card-body">
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span class="views">▶ ${formatViews(clip.view_count)}</span>
        <span>par ${creator}</span>
        <span>${timeAgo(clip.created_at)}</span>
      </div>
    </div>`;

  card.addEventListener('click', e => {
    if (e.target.closest('.fav-btn')) return;
    window.open(`https://www.twitch.tv/${clip.broadcaster_name}/clip/${clip.id}`, '_blank');
  });

  card.querySelector('.fav-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleFav(clip, card);
  });

  return card;
}

async function toggleFav(clip, card) {
  const isFav = state.favoriteIds.has(clip.id);
  try {
    if (isFav) {
      await removeFavorite(clip.id);
      state.favoriteIds.delete(clip.id);
    } else {
      await addFavorite(clip);
      state.favoriteIds.add(clip.id);
    }
    const nowFav = state.favoriteIds.has(clip.id);
    card?.classList.toggle('is-fav', nowFav);
    const btn = card?.querySelector('.fav-btn');
    if (btn) { btn.textContent = nowFav ? '⭐' : '☆'; btn.classList.toggle('active', nowFav); }
    updateFavBadge();
    if (favsView.classList.contains('visible')) renderFavsGrid();
  } catch (e) {
    showToast('Erreur favori : ' + e.message, 'error');
  }
}

function updateFavBadge() {
  favCountEl.textContent     = state.favoriteIds.size;
  favCountEl.style.display   = state.favoriteIds.size > 0 ? 'inline' : 'none';
}

// ── Vue Favoris ───────────────────────────────────────────────────────────────
btnFavs.addEventListener('click', () => {
  const open = favsView.classList.toggle('visible');
  gridWrap.style.display  = open ? 'none' : 'block';
  filterBar.classList.toggle('visible', !open && state.allClips.length > 0);
  if (open) renderFavsGrid();
});

async function renderFavsGrid() {
  favsGrid.innerHTML = '<p style="color:var(--dim);font-size:13px">Chargement…</p>';
  try {
    const favs = await import('./db.js').then(m => m.getFavorites());
    favsGrid.innerHTML = '';
    if (favs.length === 0) {
      favsGrid.innerHTML = `<div class="favs-empty"><div class="icon">☆</div><p>Aucun favori.<br>Clique l'étoile sur un clip pour l'ajouter.</p></div>`;
      return;
    }
    favs.forEach(({ clip_data }) => {
      const card = createCard(clip_data, -1);
      card.style.position = 'relative';
      favsGrid.appendChild(card);
    });
  } catch (e) {
    favsGrid.innerHTML = `<p style="color:#ff4444">${escHtml(e.message)}</p>`;
  }
}

$('btn-export-favs').addEventListener('click', async () => {
  const { getFavorites } = await import('./db.js');
  const favs = await getFavorites();
  const blob = new Blob([JSON.stringify(favs.map(f => f.clip_data), null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `favoris-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(url);
});

// ── État (loading / erreur / idle) ────────────────────────────────────────────
function setState(type, msg = '', count = 0) {
  gridWrap.style.display   = 'none';
  favsView.classList.remove('visible');
  filterBar.classList.remove('visible');
  stateEl.style.display    = 'flex';
  countBadge.style.display = 'none';
  const pct = count > 0 ? Math.min((count / 2000) * 100, 95) : 0;
  if (type === 'idle') {
    stateEl.innerHTML = `<div class="state-icon">🎮</div><p>Entre un nom de chaîne et clique <strong>Charger</strong></p>`;
  } else if (type === 'loading') {
    stateEl.innerHTML = `
      <div class="state-icon">⏳</div><p>${msg}</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } else if (type === 'error') {
    stateEl.innerHTML = `<div class="state-icon">⚠️</div><p>${msg}</p>`;
  }
}

// ── Logs UI ───────────────────────────────────────────────────────────────────
logToggle.addEventListener('click', () => {
  logPanel.classList.toggle('open');
  if (logPanel.classList.contains('open')) logBody.scrollTop = logBody.scrollHeight;
});
$('log-close').addEventListener('click',  () => logPanel.classList.remove('open'));
$('log-clear').addEventListener('click',  () => {
  logEntries.length = 0; logWarnCount = 0; logErrorCount = 0;
  logBody.innerHTML = ''; updateLogToggle();
});
$('log-export-btn').addEventListener('click', () => {
  const txt  = logEntries.map(e => `[${e.ts}] [${e.level.toUpperCase()}] ${e.msg}`).join('\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `logs-${new Date().toISOString().slice(0,19).replace(/[:.]/g,'-')}.txt`;
  a.click(); URL.revokeObjectURL(url);
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}

function showFormError(id, msg, type = 'error') {
  const el = $(id);
  if (!el) return;
  el.textContent = msg;
  el.className   = `form-msg ${type}`;
}

function formatDuration(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + ' M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + ' k';
  return n.toString();
}
function timeAgo(dateStr) {
  const d = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (d < 1)   return "aujourd'hui";
  if (d < 7)   return `il y a ${d}j`;
  if (d < 30)  return `il y a ${Math.floor(d/7)}sem`;
  if (d < 365) return `il y a ${Math.floor(d/30)}m`;
  return `il y a ${Math.floor(d/365)}an${Math.floor(d/365) > 1 ? 's' : ''}`;
}
function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function highlight(text, q) {
  if (!q) return text;
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>');
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
