const axios = require('axios');
const storage = require('./storage');

const LRCLIB_BASE = 'https://lrclib.net/api';
const HEADERS = { 'User-Agent': 'RogueRadioOverlay/1.0 (Spotify overlay)' };
const MISS_RETRY_MS = 30 * 60 * 1000;     // don't re-ask about a miss for 30 min
const DURATION_TOLERANCE_S = 6;
const CACHE_VERSION = 2;                 // bump to re-fetch everything cached by older logic

const cache = storage.getLrcCache();      // persistent hits: trackId -> lyrics
const misses = new Map();                 // trackId -> time of last miss
const inflight = new Map();               // trackId -> Promise

// "[01:23.45] text" (also [mm:ss] and several stamps per line) -> [{ time (ms), text }]
function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      out.push({ time: (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + frac, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

function shape(r) {
  if (!r) return null;
  if (r.instrumental) return { v: CACHE_VERSION, source: 'lrclib', instrumental: true, synced: null, plain: null };
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : null;
  const plain = r.plainLyrics || (synced ? synced.map(l => l.text).join('\n') : null);
  if (!synced?.length && !plain) return null;
  return { v: CACHE_VERSION, source: 'lrclib', instrumental: false, synced: synced?.length ? synced : null, plain };
}

// How complete a result looks. Timed beats plain; among timed, more text lines wins,
// and a smaller largest-gap breaks ties (a skipped chorus leaves a big hole).
function completeness(l) {
  if (!l) return -1;
  if (l.instrumental) return 0;
  if (l.synced) {
    const lines = l.synced.filter(x => x.text);
    let maxGap = 0;
    for (let i = 1; i < l.synced.length; i++) maxGap = Math.max(maxGap, l.synced[i].time - l.synced[i - 1].time);
    return 1_000_000 + lines.length * 1000 - Math.min(maxGap / 1000, 999);
  }
  return (l.plain || '').split('\n').filter(x => x.trim()).length;
}

const closeInLength = (r, track) => Math.abs((r.duration || 0) - track.duration / 1000) <= DURATION_TOLERANCE_S;

// Collect the exact match plus every close entry from a search, then keep the most complete.
// Returns lyrics, null (nothing found) or undefined (transient error: retry later).
async function fetchLyrics(track) {
  const raw = [];
  let transient = false;

  try {
    const res = await axios.get(`${LRCLIB_BASE}/get`, {
      params: {
        track_name: track.name,
        artist_name: track.artist,
        album_name: track.album,
        duration: Math.round(track.duration / 1000)
      },
      headers: HEADERS, timeout: 6000
    });
    raw.push(res.data);
  } catch (err) {
    if (err.response?.status !== 404) { console.error('LRCLIB get error:', err.message); transient = true; }
  }

  try {
    const res = await axios.get(`${LRCLIB_BASE}/search`, {
      params: { track_name: track.name, artist_name: track.artist },
      headers: HEADERS, timeout: 6000
    });
    raw.push(...(res.data || []).filter(r => closeInLength(r, track)));
  } catch (err) {
    console.error('LRCLIB search error:', err.message);
    transient = true;
  }

  const best = raw.map(shape).filter(Boolean).sort((a, b) => completeness(b) - completeness(a))[0];
  if (best) return best;
  return transient ? undefined : null;
}

const refreshed = new Set();               // stale (old-version) entries already re-checked this run

async function getLyrics(track) {
  const id = track.id;
  if (cache[id]?.v === CACHE_VERSION) return cache[id];
  if (Date.now() - (misses.get(id) || 0) < MISS_RETRY_MS) return null;
  if (inflight.has(id)) return inflight.get(id);

  const p = fetchLyrics(track).then(result => {
    if (result === undefined && cache[id]) return cache[id];   // keep the old entry through an outage
    if (result) {
      cache[id] = result;
      storage.saveLrcCache(cache);
    } else if (result === null) {
      misses.set(id, Date.now());
    }
    return result || null;
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// Non-blocking, for the 1-second poll: cached lyrics immediately; { loading: true }
// while a lookup runs in the background; null when nothing was found.
function lookup(track) {
  const hit = cache[track.id];
  if (hit && hit.v === CACHE_VERSION) return hit;
  if (hit) {                                  // older entry: show it now, upgrade in the background once
    if (!refreshed.has(track.id)) { refreshed.add(track.id); getLyrics(track).catch(() => {}); }
    return hit;
  }
  if (Date.now() - (misses.get(track.id) || 0) < MISS_RETRY_MS) return null;
  getLyrics(track).catch(() => {});
  return { loading: true };
}

module.exports = { getLyrics, lookup, parseLrc, fetchLyrics, completeness };
