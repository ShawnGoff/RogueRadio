'use strict';
// Talks to the companion server's REST API on behalf of the overlay UI and shortcuts.

const BASE = process.env.AZR_COMPANION_URL || 'http://127.0.0.1:3333';
const REPEAT_MODES = ['off', 'track', 'context'];

const ACTION = {
  NONE: 0, PLAY: 1, PAUSE: 2, NEXT: 3, PREV: 4,
  SEEK: 5, SHUFFLE: 6, REPEAT: 7, VOLUME: 8,
};

function toPath({ action, value }) {
  switch (action) {
    case ACTION.PLAY:    return '/api/play';
    case ACTION.PAUSE:   return '/api/pause';
    case ACTION.NEXT:    return '/api/next';
    case ACTION.PREV:    return '/api/prev';
    case ACTION.SEEK:    return `/api/seek?position=${value}`;
    case ACTION.SHUFFLE: return `/api/shuffle?state=${value ? 'true' : 'false'}`;
    case ACTION.REPEAT:  return REPEAT_MODES[value] ? `/api/repeat?mode=${REPEAT_MODES[value]}` : null;
    case ACTION.VOLUME:  return `/api/volume?level=${Math.min(100, value)}`;
    default:             return null;
  }
}

// Generic call. Resolves to { ok, status, data } and never throws.
async function request(method, path, log = console.log) {
  try {
    const res = await fetch(BASE + path, { method, signal: AbortSignal.timeout(6000) });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    log(`${method} ${path.split('?')[0]} -> ${res.status}`);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    log(`${method} ${path.split('?')[0]} failed: ${err.message}`);
    return { ok: false, status: 0, data: null };
  }
}

async function execute(packet, log) {
  const path = toPath(packet);
  if (!path) return { ok: false, status: 0, data: null };
  return request('POST', path, log);
}

module.exports = { BASE, ACTION, REPEAT_MODES, toPath, request, execute };
