'use strict';
// Song-request rules for Twitch chat: who may ask, how often, and what gets through.

const WHO = ['everyone', 'followers', 'subscribers', 'mods'];
const COMMANDS = { sr: 'request', request: 'request', songrequest: 'request', skip: 'skip' };
const TRACK_LINK = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?track\/|spotify:track:)([A-Za-z0-9]{10,30})/;
const PENDING_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// "!sr some song" -> { name: 'request', arg: 'some song' }
function parseCommand(text) {
  const m = /^!([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const name = COMMANDS[m[1].toLowerCase()];
  return name ? { name, arg: (m[2] || '').trim() } : null;
}

// A pasted Spotify song link / URI gives the id directly; anything else is a search.
function extractRef(arg) {
  const text = String(arg || '').trim();
  if (!text) return null;
  const link = TRACK_LINK.exec(text);
  if (link) return { id: link[1] };
  if (/spotify\.com|spotify:/i.test(text)) return { unsupported: true };      // an album/playlist link etc.
  return { query: text.slice(0, 100) };
}

const isTrusted = c => c.isBroadcaster || c.isMod;

// Can this chatter request? `follows` is true / false / null (unknown). Returns { ok, needFollowCheck }.
function access(who, c, follows) {
  if (isTrusted(c)) return { ok: true };
  if (who === 'everyone') return { ok: true };
  if (who === 'mods') return { ok: false, reason: 'only mods can request songs right now' };
  if (c.isSub || c.isVip) return { ok: true };
  if (who === 'subscribers') return { ok: false, reason: 'only subscribers can request songs right now' };
  if (follows === undefined) return { ok: false, needFollowCheck: true };
  if (follows === true) return { ok: true };
  return { ok: false, reason: follows === false ? 'only followers and subscribers can request songs' : 'follower check unavailable (connect Twitch in Settings)' };
}

class RequestManager {
  // api: { search(q) -> tracks[], track(id) -> track, add(uri) -> {ok, code}, skip() -> {ok} }
  constructor({ getSettings, api, followCheck = async () => null, notify = () => {}, log = () => {}, now = Date.now }) {
    this.getSettings = getSettings;
    this.api = api;
    this.followCheck = followCheck;
    this.notify = notify;
    this.log = log;
    this.now = now;
    this.pending = [];             // requested songs waiting in Spotify's queue, oldest first
    this.current = null;           // the requested song that is playing now
    this.lastAsk = new Map();      // login -> time of their last request attempt
  }

  // ---- who asked for what ----
  prune() {
    const cutoff = this.now() - PENDING_MAX_AGE_MS;
    this.pending = this.pending.filter(r => r.at > cutoff);
  }

  noteNowPlaying(trackId) {
    if (this.current && this.current.id !== trackId) this.current = null;
    if (!trackId) return;
    const i = this.pending.findIndex(r => r.id === trackId);
    if (i < 0) return;
    this.current = this.pending[i];
    this.pending = this.pending.slice(i + 1);                       // earlier ones were skipped past or already played
  }

  requestedBy(trackId) {
    if (!trackId) return null;
    const hit = (this.current?.id === trackId && this.current) || this.pending.find(r => r.id === trackId);
    return hit ? hit.user : null;
  }

  clear() { this.pending = []; this.current = null; this.lastAsk.clear(); }

  // ---- a chat message ----
  async handle(chatter) {
    const cmd = parseCommand(chatter.text);
    if (!cmd) return null;
    const s = this.getSettings();
    if (cmd.name === 'skip') return this.skip(chatter);
    if (!cmd.arg) return null;                                          // bare "!sr": stay quiet
    return this.request(chatter, cmd.arg, s);
  }

  async skip(chatter) {
    if (!isTrusted(chatter)) return this.reject(chatter, 'only mods can skip');
    const r = await this.api.skip();
    return r.ok ? { ok: true, action: 'skip' } : this.reject(chatter, 'could not skip');
  }

  reject(chatter, reason, extra = {}) {
    this.log(`request from ${chatter.name} refused: ${reason}`);
    this.notify({ type: 'rejected', user: chatter.name, reason, ...extra });
    return { ok: false, reason };
  }

  async request(chatter, arg, s) {
    // 1. may they?
    let verdict = access(s.twitchWho, chatter);
    if (verdict.needFollowCheck) verdict = access(s.twitchWho, chatter, await this.followCheck(chatter));
    if (!verdict.ok) return this.reject(chatter, verdict.reason);

    // 2. not too often, not too many
    const trusted = isTrusted(chatter);
    const t = this.now();
    this.prune();
    if (!trusted) {
      const wait = s.twitchCooldown * 1000 - (t - (this.lastAsk.get(chatter.login) || 0));
      if (wait > 0) return this.reject(chatter, `slow down, ${Math.ceil(wait / 1000)}s left on their cooldown`);
      const mine = this.pending.filter(r => r.login === chatter.login).length;
      if (mine >= s.twitchPerUser) return this.reject(chatter, `already has ${mine} song(s) in the queue`);
    }
    if (this.pending.length >= s.twitchMaxQueue) return this.reject(chatter, 'the request queue is full');
    this.lastAsk.set(chatter.login, t);

    // 3. which song?
    const ref = extractRef(arg);
    if (!ref) return null;
    if (ref.unsupported) return this.reject(chatter, 'only song links work, not albums or playlists');
    let track;
    if (ref.id) {
      const r = await this.api.track(ref.id);
      if (!r.ok) return this.failed(chatter, r, 'could not find that song');
      track = r.track;
    } else {
      const r = await this.api.search(ref.query);
      if (!r.ok) return this.failed(chatter, r, 'search failed');
      track = r.tracks[0];
      if (!track) return this.reject(chatter, `nothing found for "${ref.query}"`);
    }

    // 4. is it allowed on stream?
    if (s.twitchBlockExplicit && track.explicit) return this.reject(chatter, `"${track.name}" is explicit`);
    if (track.durationMs && track.durationMs > s.twitchMaxMinutes * 60000) return this.reject(chatter, `"${track.name}" is longer than ${s.twitchMaxMinutes} minutes`);
    const haystack = `${track.name} ${track.artist}`.toLowerCase();
    const blocked = String(s.twitchBlocklist || '').split(/[,\n]/).map(w => w.trim().toLowerCase()).filter(Boolean).find(w => haystack.includes(w));
    if (blocked) return this.reject(chatter, `"${track.name}" is on the blocklist`);
    if (this.current?.id === track.id || this.pending.some(r => r.id === track.id)) return this.reject(chatter, `"${track.name}" is already queued`);

    // 5. queue it
    const added = await this.api.add(track.uri);
    if (!added.ok) return this.failed(chatter, added, 'could not add it to the queue');
    this.pending.push({ id: track.id, uri: track.uri, name: track.name, artist: track.artist, user: chatter.name, login: chatter.login, at: t });
    this.notify({ type: 'added', user: chatter.name, name: track.name, artist: track.artist });
    return { ok: true, action: 'added', track };
  }

  failed(chatter, r, fallback) {
    const reason = r.code === 'NEEDS_SPOTIFY_LOGIN' ? 'connect your Spotify account first (Settings)'
      : r.status === 404 ? 'no Spotify player is open to queue on'
      : r.code === 'RATE_LIMITED' ? 'Spotify is rate limiting, try again shortly'
      : fallback;
    return this.reject(chatter, reason, { problem: true });
  }
}

module.exports = { RequestManager, parseCommand, extractRef, access, WHO };
