// ─── Auth ─────────────────────────────────────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY, TWITCH_CLIENT_ID, TWITCH_REDIRECT_URI, TWITCH_SCOPES } from './config.js';

// Client Supabase léger (pas de SDK, appels REST directs)
const supa = {
  async request(method, path, body = null, token = null) {
    const headers = {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    else {
      const session = getSession();
      if (session) headers['Authorization'] = `Bearer ${session.access_token}`;
    }
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || err.error_description || res.statusText);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
};

// ── Session locale ────────────────────────────────────────────────────────────
const SESSION_KEY = 'clipbrowser_session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function isLoggedIn() {
  const s = getSession();
  if (!s) return false;
  // Vérifier expiration
  if (s.expires_at && Date.now() / 1000 > s.expires_at) {
    clearSession();
    return false;
  }
  return true;
}

// ── Email / Password ──────────────────────────────────────────────────────────
export async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || 'Erreur inscription');
  if (data.session) saveSession(data.session);
  return data;
}

export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || 'Email ou mot de passe incorrect');
  saveSession(data);
  return data;
}

export async function signOut() {
  const session = getSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${session.access_token}` },
      });
    } catch (_) {}
  }
  clearSession();
}

// ── Twitch OAuth (Implicit Flow) ──────────────────────────────────────────────
// On utilise le flow implicite Twitch pour récupérer le token Twitch de l'user,
// SÉPARÉ du login Supabase. L'user se connecte d'abord à Clipbrowser (Supabase),
// puis lie son compte Twitch pour que l'app puisse appeler l'API Twitch en son nom.

export function startTwitchOAuth() {
  const state = Math.random().toString(36).slice(2);
  sessionStorage.setItem('twitch_oauth_state', state);
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.searchParams.set('client_id', TWITCH_CLIENT_ID);
  url.searchParams.set('redirect_uri', TWITCH_REDIRECT_URI);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', TWITCH_SCOPES);
  url.searchParams.set('state', state);
  window.location.href = url.toString();
}

// Appelé au chargement si on revient du redirect Twitch
export function handleTwitchCallback() {
  const hash = window.location.hash;
  if (!hash.includes('access_token')) return null;

  const params     = new URLSearchParams(hash.slice(1));
  const token      = params.get('access_token');
  const returnedState = params.get('state');
  const savedState = sessionStorage.getItem('twitch_oauth_state');
  sessionStorage.removeItem('twitch_oauth_state');

  // Nettoyer l'URL
  window.history.replaceState({}, document.title, window.location.pathname);

  if (!token || !returnedState || returnedState !== savedState) return null;
  return token;
}

// ── Refresh session ───────────────────────────────────────────────────────────
export async function refreshSession() {
  const session = getSession();
  if (!session?.refresh_token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) { clearSession(); return null; }
    const data = await res.json();
    saveSession(data);
    return data;
  } catch { return null; }
}
