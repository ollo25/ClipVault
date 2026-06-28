// ─── Configuration ────────────────────────────────────────────────────────────
// Ce fichier est le seul endroit où les clés sont définies.

export const SUPABASE_URL  = 'https://vyossytrycrcsnwdvubm.supabase.co';
export const SUPABASE_KEY  = 'sb_publishable_PKD0krNGlMHdHcMPtVjQ9g_4YulLxvF';

// Client ID Twitch de l'application (pour le flux OAuth)
// C'est le Client ID de TON app dev.twitch.tv — tous les users s'authentifient via cette app
export const TWITCH_CLIENT_ID = '2nkkk76ijpegbhse8o646b00qwuo5p';

// URL de redirection après le login Twitch (doit correspondre à ta console Twitch)
// En local : http://localhost (ou file://) → à changer quand hébergé
export const TWITCH_REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');

// Scopes Twitch nécessaires (aucun scope privé requis, juste lecture publique)
export const TWITCH_SCOPES = '';

// Seuil de subdivision des fenêtres de fetch
export const FETCH_LIMIT_THRESHOLD = 950;
export const FETCH_WINDOW_MONTHS   = 6;
