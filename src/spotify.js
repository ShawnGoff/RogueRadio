const axios = require('axios');
const storage = require('./storage');

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH_BASE = 'https://accounts.spotify.com/api/token';
const SPOTIFY_AUTHORIZE = 'https://accounts.spotify.com/authorize';

const BASE_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-private'
];
// Needed for like (library) and add-to-playlist. Existing logins predate these and must re-authorize.
const LIBRARY_SCOPES = ['user-library-read', 'user-library-modify'];
const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-private', 'playlist-modify-public'];
const SCOPES = [...BASE_SCOPES, ...LIBRARY_SCOPES, ...PLAYLIST_SCOPES];

const SEARCH_TYPES = ['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook'];
const LIKE_TTL_MS = 60 * 1000;
const PLAYLIST_TTL_MS = 60 * 1000;

class SpotifyClient {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.scope = '';
    this.likedCache = new Map();       // uri -> { value: true|false|null, at }
    this.playlistCache = null;         // { items, at }
    this.meId = null;
    this.loadStoredTokens();
  }

  grantedScopes() {
    return new Set(this.scope.split(/\s+/).filter(Boolean));
  }

  hasScopes(list) {
    const have = this.grantedScopes();
    return list.every(s => have.has(s));
  }

  canLike() { return this.hasScopes(LIBRARY_SCOPES); }
  canUsePlaylists() { return this.hasScopes(PLAYLIST_SCOPES); }
  needsReauth() { return this.isAuthenticated() && !(this.canLike() && this.canUsePlaylists()); }

  loadStoredTokens() {
    const stored = storage.getTokens();
    if (stored) {
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.tokenExpiry = stored.tokenExpiry;
      this.scope = stored.scope || '';
    }
  }

  // Forget the saved login and everything cached from the account
  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.scope = '';
    this.meId = null;
    this.likedCache.clear();
    this.playlistCache = null;
    storage.clearTokens();
  }

  isAuthenticated() {
    return !!this.accessToken;
  }

  // forceDialog: make Spotify show its approval screen even if already approved, which is
  // what lets someone pick a different account ("Not you?")
  getAuthUrl(forceDialog = false) {
    const scopes = SCOPES;

    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
      scope: scopes.join(' '),
      ...(forceDialog && { show_dialog: 'true' })
    });

    return `${SPOTIFY_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCodeForToken(code) {
    try {
      // Credentials go in the form body, not the query string
      const response = await axios.post(SPOTIFY_AUTH_BASE, new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET
      }));

      this.setTokens(response.data);
      return true;
    } catch (error) {
      console.error('Failed to exchange code for token:', error.message);
      throw error;
    }
  }

  setTokens(data) {
    this.accessToken = data.access_token;
    // Refresh responses usually omit refresh_token; keep the existing one
    this.refreshToken = data.refresh_token || this.refreshToken;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    this.scope = data.scope || this.scope;      // refresh responses may omit it; keep what we had
    storage.saveTokens({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      tokenExpiry: this.tokenExpiry,
      scope: this.scope
    });
    this.likedCache.clear();
    this.playlistCache = null;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post(SPOTIFY_AUTH_BASE, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: process.env.SPOTIFY_CLIENT_ID,
        client_secret: process.env.SPOTIFY_CLIENT_SECRET
      }));

      this.setTokens(response.data);
      return true;
    } catch (error) {
      console.error('Failed to refresh token:', error.message);
      // Only a rejection from Spotify (revoked/invalid refresh token) means the login
      // is dead; network errors and 5xx are transient, so keep the saved tokens.
      const status = error.response?.status;
      if (status === 400 || status === 401) {
        this.accessToken = null;
        this.refreshToken = null;
        storage.clearTokens();
      }
      throw error;
    }
  }

  async ensureValidToken() {
    // Refresh if token is expiring within 5 minutes
    if (this.tokenExpiry && Date.now() > this.tokenExpiry - 5 * 60 * 1000) {
      await this.refreshAccessToken();
    }
  }

  async apiCall(method, endpoint, data = null, retried = false) {
    await this.ensureValidToken();

    if (!this.accessToken) {
      throw { status: 401, code: 'NOT_AUTHENTICATED', message: 'Not authenticated with Spotify' };
    }

    try {
      const config = {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        }
      };

      const url = `${SPOTIFY_API_BASE}${endpoint}`;
      let response;

      if (method === 'GET') {
        response = await axios.get(url, config);
      } else if (method === 'POST') {
        response = await axios.post(url, data, config);
      } else if (method === 'PUT') {
        response = await axios.put(url, data, config);
      } else if (method === 'DELETE') {
        response = await axios.delete(url, config);
      }

      return response.data;
    } catch (error) {
      // Token rejected despite looking valid (revoked/expired early): refresh once and retry
      if (error.response?.status === 401 && !retried && this.refreshToken) {
        await this.refreshAccessToken();
        return this.apiCall(method, endpoint, data, true);
      }
      const status = error.response?.status || 500;
      const message = error.response?.data?.error?.message || error.message;
      console.error(`Spotify API error (${method} ${endpoint}):`, status, message);
      throw {
        status,
        code: status === 403 && /scope/i.test(message) ? 'INSUFFICIENT_SCOPE'
            : status === 429 ? 'RATE_LIMITED'
            : 'SPOTIFY_ERROR',
        message
      };
    }
  }

  async getCurrentTrack() {
    // /me/player (not /currently-playing) also reports shuffle, repeat and volume
    const data = await this.apiCall('GET', '/me/player');
    if (!data || !data.item) { // 204 No Content when there is no active device
      return null;
    }
    const item = data.item;
    // Podcast episodes have a show instead of artists/album
    const artists = (item.artists || [{ name: item.show?.name || '' }]).map(a => a.name);
    const images = item.album?.images || item.images || [];
    return {
      id: item.id,
      name: item.name,
      artist: artists[0],
      artists,
      album: item.album?.name || item.show?.name || '',
      imageUrl: images[0]?.url || null,
      duration: item.duration_ms,
      progress: data.progress_ms,
      isPlaying: data.is_playing,
      uri: item.uri,
      shuffle: !!data.shuffle_state,
      repeat: data.repeat_state || 'off',           // off | track | context
      volume: data.device?.volume_percent ?? null
    };
  }

  async play(contextUri = null, offset = null) {
    const payload = {};
    if (contextUri) payload.context_uri = contextUri;
    if (offset !== null) payload.offset = { position: offset };

    return await this.apiCall('PUT', '/me/player/play', payload);
  }

  // Start specific songs, or a playlist/album as a context
  async playUris(uris) {
    return await this.startPlayback({ uris });
  }

  async playContext(contextUri) {
    return await this.startPlayback({ context_uri: contextUri });
  }

  // If Spotify has no *active* device (its app is open but idle), pick one it knows about and retry
  async startPlayback(body) {
    try {
      return await this.apiCall('PUT', '/me/player/play', body);
    } catch (error) {
      if (error.status !== 404) throw error;
      const devices = await this.getDevices();
      const device = devices.find(d => d.type === 'Computer') || devices[0];
      if (!device) throw error;                          // no Spotify app is open anywhere
      return await this.apiCall('PUT', `/me/player/play?${new URLSearchParams({ device_id: device.id })}`, body);
    }
  }

  // Search everything Spotify offers: songs, artists, albums, playlists, podcasts (shows), episodes and
  // audiobooks. Spotify caps `limit` (per type, per request) at 10 for apps like this one, so more
  // results come from paging with `offset`. (Audiobooks only exist in a handful of countries; where
  // they're unavailable that list simply comes back empty.)
  async search(query, { types = SEARCH_TYPES, offset = 0 } = {}) {
    const params = new URLSearchParams({
      q: query, type: types.join(','), limit: '10', offset: String(offset),
      include_external: 'audio'                        // let externally hosted podcasts play too
    });
    const data = await this.apiCall('GET', `/search?${params}`);
    const smallest = images => (images || []).slice(-1)[0]?.url || null;
    const items = key => (data?.[key]?.items || []).filter(Boolean);
    return {
      tracks: items('tracks').map(t => ({
        id: t.id, uri: t.uri, name: t.name,
        artist: (t.artists || [])[0]?.name || '',
        album: t.album?.name || '',
        explicit: !!t.explicit,
        durationMs: t.duration_ms ?? null,
        imageUrl: smallest(t.album?.images)
      })),
      artists: items('artists').map(a => ({
        id: a.id, uri: a.uri, name: a.name, imageUrl: smallest(a.images)
      })),
      albums: items('albums').map(al => ({
        id: al.id, uri: al.uri, name: al.name,
        artist: (al.artists || [])[0]?.name || '',
        year: String(al.release_date || '').slice(0, 4),
        imageUrl: smallest(al.images)
      })),
      playlists: items('playlists').map(pl => ({
        id: pl.id, uri: pl.uri, name: pl.name,
        owner: pl.owner?.display_name || '',
        imageUrl: smallest(pl.images)
      })),
      shows: items('shows').map(sh => ({
        id: sh.id, uri: sh.uri, name: sh.name,
        episodes: sh.total_episodes ?? null,
        publisher: sh.publisher || '',                   // Spotify has been removing this field
        imageUrl: smallest(sh.images)
      })),
      episodes: items('episodes').map(ep => ({
        id: ep.id, uri: ep.uri, name: ep.name,
        releaseDate: ep.release_date || '',
        durationMs: ep.duration_ms ?? null,
        playable: ep.is_playable !== false,
        imageUrl: smallest(ep.images)
      })),
      audiobooks: items('audiobooks').map(bk => ({
        id: bk.id, uri: bk.uri, name: bk.name,
        authors: (bk.authors || []).map(a => a.name).filter(Boolean),
        narrators: (bk.narrators || []).map(n => n.name).filter(Boolean),
        imageUrl: smallest(bk.images)
      }))
    };
  }

  // Play a podcast show or an audiobook. Spotify's docs only describe albums, artists and playlists as
  // playable "contexts", so try the show/audiobook itself first and, if Spotify refuses that, start the
  // newest episode (shows) or the first chapter (audiobooks) instead.
  async playShowOrBook(uri, kind = 'show') {
    try {
      return await this.startPlayback({ context_uri: uri });
    } catch (error) {
      const noDevice = /device/i.test(String(error.message));
      if (noDevice || ![400, 404].includes(error.status)) throw error;
      const id = uri.split(':')[2];
      const path = kind === 'audiobook' ? `/audiobooks/${id}/chapters?limit=1` : `/shows/${id}/episodes?limit=1`;
      const first = (await this.apiCall('GET', path))?.items?.[0];
      if (!first?.uri) throw error;
      return await this.startPlayback({ uris: [first.uri] });
    }
  }

  async pause() {
    return await this.apiCall('PUT', '/me/player/pause');
  }

  async next() {
    return await this.apiCall('POST', '/me/player/next');
  }

  // Spotify's API has no "play this item from the queue" call, so jump by skipping forward, which is
  // also what its own app does when you pick a later song in the queue.
  async skipForward(count) {
    for (let i = 0; i < count; i++) {
      await this.next();
      if (i < count - 1) await new Promise(r => setTimeout(r, 120));      // don't hammer the API
    }
    return true;
  }

  async previous() {
    return await this.apiCall('POST', '/me/player/previous');
  }

  async seek(positionMs) {
    return await this.apiCall('PUT', `/me/player/seek?position_ms=${positionMs}`);
  }

  async setVolume(percent) {
    return await this.apiCall('PUT', `/me/player/volume?volume_percent=${percent}`);
  }

  async setShuffle(state) {
    return await this.apiCall('PUT', `/me/player/shuffle?state=${state}`);
  }

  async setRepeat(mode) {
    // mode: 'off', 'track', 'context'
    return await this.apiCall('PUT', `/me/player/repeat?state=${mode}`);
  }

  // ---- like (saved tracks), via the generic /me/library endpoints (Feb 2026 API) ----
  // Returns true/false, or null when unknown (missing permission, error). Cached briefly so the
  // 1-second poll doesn't hit Spotify every time.
  async isLiked(uri) {
    if (!uri || !this.canLike()) return null;
    const hit = this.likedCache.get(uri);
    if (hit && Date.now() - hit.at < (hit.value === null ? LIKE_TTL_MS / 2 : LIKE_TTL_MS)) return hit.value;

    let value = null;
    try {
      const res = await this.apiCall('GET', `/me/library/contains?${new URLSearchParams({ uris: uri })}`);
      value = Array.isArray(res) ? !!res[0] : null;
    } catch (e) { /* leave null; retried after the short TTL */ }
    this.likedCache.set(uri, { value, at: Date.now() });
    return value;
  }

  async setLiked(uri, on) {
    const endpoint = `/me/library?${new URLSearchParams({ uris: uri })}`;
    await this.apiCall(on ? 'PUT' : 'DELETE', endpoint);
    this.likedCache.set(uri, { value: !!on, at: Date.now() });
    return !!on;
  }

  // ---- playlists ----
  async getMeId() {
    if (!this.meId) this.meId = (await this.apiCall('GET', '/me')).id;
    return this.meId;
  }

  // Every playlist in your library (ones you made and ones you follow), cached for a minute.
  // `writable` marks the ones a song can be added to: yours, or collaborative.
  async getAllPlaylists() {
    if (this.playlistCache && Date.now() - this.playlistCache.at < PLAYLIST_TTL_MS) return this.playlistCache.items;

    const me = await this.getMeId();
    const items = [];
    let next = '/me/playlists?limit=50';
    for (let page = 0; next && page < 4; page++) {       // up to 200 playlists
      const data = await this.apiCall('GET', next);
      for (const p of data?.items || []) {
        if (!p) continue;
        const mine = p.owner?.id === me;
        items.push({
          id: p.id,
          uri: p.uri || `spotify:playlist:${p.id}`,
          name: p.name,
          owner: mine ? 'You' : (p.owner?.display_name || ''),
          collaborative: !!p.collaborative,
          writable: mine || !!p.collaborative,
          imageUrl: p.images?.[0]?.url || null
        });
      }
      next = data?.next ? data.next.replace(SPOTIFY_API_BASE, '') : null;
    }
    this.playlistCache = { items, at: Date.now() };
    return items;
  }

  // Playlists you can add songs to
  async getPlaylists() {
    return (await this.getAllPlaylists()).filter(p => p.writable);
  }

  async addToPlaylist(playlistId, uri) {
    await this.apiCall('POST', `/playlists/${playlistId}/items`, { uris: [uri] });
    return true;
  }

  // ---- devices and queue ----
  async getDevices() {
    const data = await this.apiCall('GET', '/me/player/devices');
    return (data?.devices || []).map(d => ({
      id: d.id, name: d.name, type: d.type, isActive: !!d.is_active, volume: d.volume_percent ?? null
    }));
  }

  async transferPlayback(deviceId) {
    await this.apiCall('PUT', '/me/player', { device_ids: [deviceId], play: true });
    return true;
  }

  // Put one song at the end of the queue (what Twitch requests use). Like starting playback, it
  // retries on an available device when nothing is active.
  async addToQueue(uri) {
    const endpoint = `/me/player/queue?${new URLSearchParams({ uri })}`;
    try {
      return await this.apiCall('POST', endpoint);
    } catch (error) {
      if (error.status !== 404) throw error;
      const devices = await this.getDevices();
      const device = devices.find(d => d.type === 'Computer') || devices[0];
      if (!device) throw error;
      return await this.apiCall('POST', `${endpoint}&${new URLSearchParams({ device_id: device.id })}`);
    }
  }

  async getTrack(id) {
    const t = await this.apiCall('GET', `/tracks/${encodeURIComponent(id)}`);
    return {
      id: t.id, uri: t.uri, name: t.name,
      artist: (t.artists || [])[0]?.name || '',
      explicit: !!t.explicit,
      durationMs: t.duration_ms ?? null
    };
  }

  async getQueue() {
    const data = await this.apiCall('GET', '/me/player/queue');
    return (data?.queue || []).slice(0, 25).map(t => ({
      id: t.id,
      name: t.name,
      artist: (t.artists || [{ name: t.show?.name || '' }])[0].name
    }));
  }

  async getMe() {
    return await this.apiCall('GET', '/me');
  }
}

module.exports = new SpotifyClient();
