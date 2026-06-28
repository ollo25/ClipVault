// ─── Base de données ──────────────────────────────────────────────────────────
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { getSession } from './auth.js';

async function supaFetch(method, path, body = null) {
  const session = getSession();
  const headers = {
    'apikey': SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
  if (session) headers['Authorization'] = `Bearer ${session.access_token}`;

  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.hint || `Erreur DB: ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Profil utilisateur ────────────────────────────────────────────────────────

export async function getProfile() {
  const session = getSession();
  if (!session) return null;
  const data = await supaFetch('GET', `/profiles?id=eq.${session.user.id}&select=*&limit=1`);
  return data?.[0] || null;
}

export async function saveProfile(updates) {
  const session = getSession();
  if (!session) throw new Error('Non connecté');
  // Upsert : crée la ligne si absente, met à jour si présente
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ id: session.user.id, ...updates }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || err.hint || `Erreur DB: ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Favoris ───────────────────────────────────────────────────────────────────

export async function getFavorites() {
  const data = await supaFetch('GET', '/favorites?select=clip_id,clip_data&order=created_at.desc');
  return data || [];
}

export async function addFavorite(clip) {
  const session = getSession();
  if (!session) throw new Error('Non connecté');
  return supaFetch('POST', '/favorites', {
    user_id: session.user.id,
    clip_id: clip.id,
    clip_data: clip,
  });
}

export async function removeFavorite(clipId) {
  return supaFetch('DELETE', `/favorites?clip_id=eq.${clipId}`);
}

export async function deleteAllFavorites() {
  const session = getSession();
  if (!session) return;
  return supaFetch('DELETE', `/favorites?user_id=eq.${session.user.id}`);
}

export async function isFavorite(clipId) {
  const data = await supaFetch('GET', `/favorites?clip_id=eq.${clipId}&select=clip_id&limit=1`);
  return data && data.length > 0;
}

// Récupérer tous les IDs favoris d'un coup (pour affichage initial)
export async function getFavoriteIds() {
  const data = await supaFetch('GET', '/favorites?select=clip_id');
  return new Set((data || []).map(f => f.clip_id));
}
