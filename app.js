// ─── Application principale ───────────────────────────────────────────────────
import { isLoggedIn, getSession, signOut, handleTwitchCallback, startTwitchOAuth, loginWithTwitchUser } from './auth.js';
import { getProfile, saveProfile, getFavoriteIds, addFavorite, removeFavorite } from './db.js';
import { setTwitchCredentials, getBroadcasterInfo, fetchAllClips, validateToken, getTwitchUser } from './api.js';
import { TWITCH_CLIENT_ID } from './config.js';

// ── État global ───────────────────────────────────────────────────────────────
const state = {
  allClips:      [],
  filteredClips: [],
  favoriteIds:   new Set(),
  currentSort:   'time',
  currentOrder:  'desc',
  searchMode:    'all',
  cols:          1,
  renderedCards: new Map(),
  profile:       null,
};

// ── Constantes virtual scroll ─────────────────────────────────────────────────
const CARD_W   = 300;
const CARD_H   = 250;
const CARD_GAP = 16;
const OVERSCAN = 3;

// ── Éléments DOM ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const pageAuth  = $('page-auth');
const pageApp   = $('page-app');

const btnLogout   = $('btn-logout');
const btnFavs     = $('btn-favs');
const favCountEl  = $('fav-count');
const countBadge  = $('count-badge');
const channelInput= $('channel-input');
const loadBtn     = $('btn-load');
const filterBar   = $('filter-bar');
const filterSearch= $('filter-search');
const filterFrom  = $('filter-date-from');
const filterTo    = $('filter-date-to');
const filterCount = $('filter-count');
const clearBtn    = $('btn-clear-filters');
const stateEl     = $('state');
const gridWrap    = $('grid-wrap');
const gridContainer=$('grid-container');
const gridEl      = $('grid');
const favsView    = $('favs-view');
const favsGrid    = $('favs-grid');

// ── Navigation entre pages ────────────────────────────────────────────────────
function showPage(page) {
  [pageAuth, pageApp].forEach(p => p.classList.remove('active'));
  page.classList.add('active');
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Retour OAuth Twitch
  const twitchToken = handleTwitchCallback();
  if (twitchToken) {
    setTwitchCredentials(TWITCH_CLIENT_ID, twitchToken);
    try {
      const user = await getTwitchUser();
      await loginWithTwitchUser(user.id);
      await saveProfile({ twitch_token: twitchToken });
      state.profile = await getProfile();
    } catch (e) {
      showToast('Erreur de connexion : ' + e.message, 'error');
      showPage(pageAuth);
      return;
    }
    state.favoriteIds = await getFavoriteIds().catch(() => new Set());
    updateFavBadge();
    showPage(pageApp);
    return;
  }

  if (!isLoggedIn()) {
    showPage(pageAuth);
    return;
  }

  try {
    state.profile = await getProfile();
  } catch {
    showPage(pageAuth);
    return;
  }

  const token = state.profile?.twitch_token;
  if (!token) {
    startTwitchOAuth();
    return;
  }

  setTwitchCredentials(TWITCH_CLIENT_ID, token);
  const valid = await validateToken();
  if (!valid) {
    showToast('Session Twitch expirée, reconnexion…', 'info');
    setTimeout(startTwitchOAuth, 1500);
    showPage(pageAuth);
    return;
  }

  state.favoriteIds = await getFavoriteIds().catch(() => new Set());
  updateFavBadge();
  showPage(pageApp);
}

// ── Auth handlers ─────────────────────────────────────────────────────────────
$('btn-twitch-login').addEventListener('click', startTwitchOAuth);

btnLogout.addEventListener('click', async () => {
  await signOut();
  state.allClips = [];
  state.filteredClips = [];
  state.profile = null;
  showPage(pageAuth);
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

  try {
    setState('loading', 'Recherche de la chaîne…');

    const info  = await getBroadcasterInfo(channel);
    const clips = await fetchAllClips(info.id, info.created_at, {
      onProgress: (msg, count) => setState('loading', msg, count),
      onLog: () => {},
    });

    if (clips.length === 0) {
      setState('error', `Aucun clip trouvé pour <strong>${escHtml(channel)}</strong>`);
      return;
    }

    const seen = new Set();
    state.allClips = clips.filter(c => seen.has(c.id) ? false : (seen.add(c.id), true));

    resetFilters();

    countBadge.textContent   = `${state.allClips.length} clips`;
    countBadge.style.display = 'block';
    stateEl.style.display    = 'none';
    gridWrap.style.display   = 'block';
    filterBar.classList.add('visible');
    document.title = `${info.display_name} — ClipVault`;

    applyFilters();

  } catch (e) {
    if (e.message === 'TOKEN_EXPIRED') {
      setState('error', 'Token Twitch expiré. <a href="#" id="reauth-link">Reconnecter Twitch</a>');
      document.getElementById('reauth-link')?.addEventListener('click', ev => {
        ev.preventDefault();
        startTwitchOAuth();
      });
    } else {
      setState('error', escHtml(e.message));
    }
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
      <button class="fav-btn${isFav ? ' active' : ''}" data-id="${clip.id}">${isFav ? '★' : '☆'}</button>
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
    if (btn) { btn.textContent = nowFav ? '★' : '☆'; btn.classList.toggle('active', nowFav); }
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
      favsGrid.innerHTML = `<div class="favs-empty"><p>Aucun favori.<br>Clique l'étoile sur un clip pour l'ajouter.</p></div>`;
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
    stateEl.innerHTML = `<p>Entre un nom de chaîne et clique <strong>Charger</strong></p>`;
  } else if (type === 'loading') {
    stateEl.innerHTML = `
      <p>${msg}</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
  } else if (type === 'error') {
    stateEl.innerHTML = `<p class="state-error">${msg}</p>`;
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
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
