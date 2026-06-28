// ─── Auth ─────────────────────────────────────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY, TWITCH_CLIENT_ID, TWITCH_REDIRECT_URI, TWITCH_SCOPES } from './config.js';

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
  if (s.expires_at && Date.now() / 1000 > s.expires_at) {
    clearSession();
    return false;
  }
  return true;
}

// ── Auto-login Supabase via Twitch user ID ────────────────────────────────────
// On dérive un email/mot de passe Supabase depuis le Twitch user ID.
// L'utilisateur ne voit jamais ces credentials — la seule auth visible est Twitch.
export async function loginWithTwitchUser(twitchUserId) {
  const email = `twitch_${twitchUserId}@clipvault.app`;
  const buf   = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(`cv2025-${twitchUserId}-clipvault`));
  const pass  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 24);

  // Essai de connexion
  try {
    const data = await _supaPost('token?grant_type=password', { email, password: pass });
    saveSession(data);
    return data;
  } catch {}

  // Première fois : création de compte
  const data = await _supaPost('signup', { email, password: pass });
  if (data.session) saveSession(data.session);
  return data;
}

async function _supaPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || 'Auth error');
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
    } catch {}
  }
  clearSession();
}

// ── Twitch OAuth (Implicit Flow) ──────────────────────────────────────────────
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

export function handleTwitchCallback() {
  const hash = window.location.hash;
  if (!hash.includes('access_token')) return null;

  const params       = new URLSearchParams(hash.slice(1));
  const token        = params.get('access_token');
  const returnedState = params.get('state');
  const savedState   = sessionStorage.getItem('twitch_oauth_state');
  sessionStorage.removeItem('twitch_oauth_state');

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
