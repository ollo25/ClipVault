// ─── API Twitch ───────────────────────────────────────────────────────────────
import { TWITCH_CLIENT_ID, FETCH_LIMIT_THRESHOLD, FETCH_WINDOW_MONTHS } from './config.js';

let _clientId = TWITCH_CLIENT_ID;
let _token    = null;

export function setTwitchCredentials(clientId, token) {
  _clientId = clientId;
  _token    = token;
}

export function getTwitchToken() { return _token; }
export function getTwitchClientId() { return _clientId; }

async function twitchFetch(url) {
  const res = await fetch(url, {
    headers: {
      'Client-Id': _clientId,
      'Authorization': `Bearer ${_token}`,
    },
  });

  if (res.status === 401) throw new Error('TOKEN_EXPIRED');
  if (res.status === 429) {
    const reset  = res.headers.get('Ratelimit-Reset');
    const waitMs = reset ? (parseInt(reset) * 1000 - Date.now() + 500) : 1500;
    await new Promise(r => setTimeout(r, waitMs));
    return twitchFetch(url); // retry
  }
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

export async function getBroadcasterInfo(login) {
  const d = await twitchFetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`
  );
  if (!d.data || d.data.length === 0) throw new Error(`Chaîne introuvable : ${login}`);
  return d.data[0];
}

export async function getTwitchUser() {
  const d = await twitchFetch('https://api.twitch.tv/helix/users');
  return d.data?.[0] || null;
}

export async function validateToken() {
  if (!_token) return false;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { 'Authorization': `OAuth ${_token}` },
    });
    return res.ok;
  } catch { return false; }
}

// ── Fetch de tous les clips avec fenêtres + subdivision ──────────────────────

export async function fetchAllClips(broadcasterId, channelCreatedAt, { onProgress, onLog } = {}) {
  const log = (level, msg) => onLog?.(level, msg);
  const progress = (msg, count) => onProgress?.(msg, count);

  const oldest = channelCreatedAt ? new Date(channelCreatedAt) : new Date('2016-01-01T00:00:00Z');
  const seen   = new Set();
  const clips  = [];

  async function fetchWindow(winStart, winEnd, label) {
    let cursor = null, pageNum = 0, paginationExhausted = false;
    const windowClips = [];

    while (true) {
      pageNum++;
      progress(
        `[${label}] page ${pageNum} · ${clips.length + windowClips.length} clips`,
        clips.length + windowClips.length
      );

      let url = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=100`
              + `&started_at=${winStart.toISOString()}&ended_at=${winEnd.toISOString()}`;
      if (cursor) url += `&after=${cursor}`;

      const d = await twitchFetch(url);
      windowClips.push(...d.data);
      log('info', `  [${label}] page ${pageNum} → ${d.data.length} clips (cursor: ${d.pagination?.cursor ? 'oui' : 'non'}) · fenêtre: ${windowClips.length}`);

      if (!d.pagination?.cursor || d.data.length === 0) {
        paginationExhausted = !d.pagination?.cursor;
        break;
      }
      cursor = d.pagination.cursor;
      await new Promise(r => setTimeout(r, 60));
    }

    // Détection token expiré silencieux
    if (windowClips.length === 0 && pageNum === 1) {
      const valid = await validateToken();
      if (!valid) throw new Error('TOKEN_EXPIRED');
    }

    const hitLimit = windowClips.length >= FETCH_LIMIT_THRESHOLD && paginationExhausted;
    return { windowClips, hitLimit };
  }

  async function processWindow(winStart, winEnd, depth = 0) {
    const label  = `${winStart.toISOString().slice(0,10)} → ${winEnd.toISOString().slice(0,10)}`;
    const indent = '  '.repeat(depth);
    log('info', `${indent}Fenêtre [${label}]`);

    const { windowClips, hitLimit } = await fetchWindow(winStart, winEnd, label);

    if (hitLimit && depth < 5) {
      log('warn', `${indent}⚠ Limite détectée [${label}] : ${windowClips.length} clips → subdivision`);
      const mid = new Date((winStart.getTime() + winEnd.getTime()) / 2);
      await processWindow(mid, winEnd, depth + 1);
      await processWindow(winStart, mid, depth + 1);
    } else {
      if (hitLimit) log('warn', `${indent}⚠ Profondeur max atteinte sur [${label}]`);
      let added = 0, dupes = 0;
      for (const clip of windowClips) {
        if (!seen.has(clip.id)) { seen.add(clip.id); clips.push(clip); added++; }
        else dupes++;
      }
      if (dupes > 0) log('dedup', `${indent}${dupes} doublons supprimés sur [${label}]`);
      log('success', `${indent}+${added} clips [${label}] · total: ${clips.length}`);
    }
    await new Promise(r => setTimeout(r, 60));
  }

  // Construire les fenêtres initiales
  const windows = [];
  let winEnd = new Date();
  while (winEnd > oldest) {
    const winStart = new Date(winEnd);
    winStart.setMonth(winStart.getMonth() - FETCH_WINDOW_MONTHS);
    if (winStart < oldest) winStart.setTime(oldest.getTime());
    windows.push({ start: new Date(winStart), end: new Date(winEnd) });
    winEnd = new Date(winStart);
  }

  log('info', `── ${windows.length} fenêtres · période : ${oldest.toISOString().slice(0,10)} → ${new Date().toISOString().slice(0,10)}`);

  let consecutiveEmpty = 0;
  for (const win of windows) {
    const before = clips.length;
    await processWindow(win.start, win.end);
    if (clips.length === before) {
      if (++consecutiveEmpty === 3 && clips.length > 0)
        log('warn', '3 fenêtres vides consécutives — token peut-être expiré');
    } else {
      consecutiveEmpty = 0;
    }
  }

  log('success', `── Fetch terminé : ${clips.length} clips uniques`);
  return clips;
}
