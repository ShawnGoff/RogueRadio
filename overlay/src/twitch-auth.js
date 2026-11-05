'use strict';
// Connects the streamer's Twitch account (device code flow, so no redirect page or client secret is
// needed: register the app as a "Public" client) and answers "does this viewer follow the channel?".
// Subscriber / VIP / mod status comes free with chat messages; only follower status needs this.
const fs = require('node:fs');
const path = require('node:path');

const ID_BASE = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const SCOPE = 'moderator:read:followers';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const FOLLOW_TTL_MS = 10 * 60 * 1000;      // a follower stays a follower for a while
const NOT_FOLLOW_TTL_MS = 60 * 1000;       // but someone who just followed shouldn't wait long

const form = body => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  signal: AbortSignal.timeout(10000),
});

class TwitchAuth {
  constructor({ dataDir, fetchFn = fetch, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
    this.file = path.join(dataDir, 'twitch.json');
    this.dir = dataDir;
    this.fetch = fetchFn;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.tokens = this.read();
    this.flow = null;                       // the sign-in in progress, if any
    this.followCache = new Map();           // userId -> { follows, at }
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (this.tokens) fs.writeFileSync(this.file, JSON.stringify(this.tokens), { mode: 0o600 });
      else fs.rmSync(this.file, { force: true });
    } catch (err) { this.log('could not save Twitch login: ' + err.message); }
  }

  get connected() { return !!this.tokens?.refreshToken; }
  get login() { return this.tokens?.login || null; }
  get userId() { return this.tokens?.userId || null; }
  get clientId() { return this.tokens?.clientId || null; }

  // Starts sign-in. Resolves with the code to show; `onDone(error|null)` fires when it finishes.
  async connect(clientId, onDone = () => {}) {
    clientId = String(clientId || '').trim();
    if (!/^[a-z0-9]{20,40}$/i.test(clientId)) throw new Error('Enter the Client ID from your Twitch developer app first.');
    this.cancel();
    const res = await this.fetch(`${ID_BASE}/device`, form({ client_id: clientId, scopes: SCOPE }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.device_code) throw new Error(body.message || `Twitch refused the sign-in (${res.status}). Check the Client ID.`);
    const flow = { cancelled: false };
    this.flow = flow;
    this.poll(flow, clientId, body, onDone);
    return { userCode: body.user_code, verificationUri: body.verification_uri, expiresIn: body.expires_in };
  }

  cancel() {
    if (this.flow) this.flow.cancelled = true;
    this.flow = null;
  }

  async poll(flow, clientId, device, onDone) {
    let interval = Math.max(1, Number(device.interval) || 5) * 1000;
    const deadline = this.now() + (Number(device.expires_in) || 600) * 1000;
    try {
      while (!flow.cancelled && this.now() < deadline) {
        await this.sleep(interval);
        if (flow.cancelled) return;
        const res = await this.fetch(`${ID_BASE}/token`, form({
          client_id: clientId, scopes: SCOPE, device_code: device.device_code, grant_type: DEVICE_GRANT,
        }));
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.access_token) {
          await this.finishSignIn(clientId, body);
          if (this.flow === flow) this.flow = null;
          return onDone(null);
        }
        const why = String(body.message || '');
        if (why === 'authorization_pending') continue;
        if (why === 'slow_down') { interval += 5000; continue; }
        throw new Error(why === 'invalid device code' ? 'That sign-in code expired. Try again.' : (why || `Twitch said ${res.status}`));
      }
      if (!flow.cancelled) throw new Error('The sign-in code expired before it was approved. Try again.');
    } catch (err) {
      if (this.flow === flow) this.flow = null;
      if (!flow.cancelled) onDone(err);
    }
  }

  async finishSignIn(clientId, body) {
    const check = await this.fetch(`${ID_BASE}/validate`, { headers: { Authorization: `OAuth ${body.access_token}` }, signal: AbortSignal.timeout(10000) });
    const who = await check.json().catch(() => ({}));
    if (!check.ok || !who.user_id) throw new Error('Twitch did not confirm the sign-in.');
    this.tokens = {
      clientId, accessToken: body.access_token, refreshToken: body.refresh_token,
      expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000,
      login: who.login, userId: who.user_id,
    };
    this.followCache.clear();
    this.save();
  }

  disconnect() {
    this.cancel();
    this.tokens = null;
    this.followCache.clear();
    this.save();
  }

  // A usable access token, refreshed when it is about to lapse. Refresh tokens are single-use, so the
  // new one is saved straight away. null when signed out or the login was revoked.
  async accessToken() {
    const t = this.tokens;
    if (!t) return null;
    if (t.expiresAt - this.now() > 60 * 1000) return t.accessToken;
    return this.refresh();
  }

  async refresh() {
    const t = this.tokens;
    if (!t?.refreshToken) return null;
    try {
      const res = await this.fetch(`${ID_BASE}/token`, form({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId }));
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.access_token) {
        this.tokens = { ...t, accessToken: body.access_token, refreshToken: body.refresh_token || t.refreshToken, expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000 };
        this.save();
        return this.tokens.accessToken;
      }
      if (res.status === 400 || res.status === 401) {                // revoked or expired: sign in again
        this.log('Twitch login expired; reconnect it in Settings');
        this.tokens = null;
        this.save();
      }
    } catch (err) { this.log('Twitch refresh failed: ' + err.message); }
    return null;
  }

  // true / false, or null when it can't be told (not connected, offline, no permission).
  // Only works for the connected account's own channel.
  async isFollower(userId, channelLogin) {
    if (!this.connected || !userId) return null;
    if (channelLogin && this.login && channelLogin.toLowerCase() !== this.login.toLowerCase()) return null;
    const hit = this.followCache.get(userId);
    if (hit && this.now() - hit.at < (hit.follows ? FOLLOW_TTL_MS : NOT_FOLLOW_TTL_MS)) return hit.follows;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      if (!token) return null;
      try {
        const url = `${HELIX}/channels/followers?${new URLSearchParams({ broadcaster_id: this.userId, user_id: userId })}`;
        const res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': this.clientId }, signal: AbortSignal.timeout(8000) });
        if (res.status === 401 && attempt === 0) { this.tokens.expiresAt = 0; continue; }     // token rejected early: refresh and retry once
        if (!res.ok) { this.log(`follower check failed: HTTP ${res.status}`); return null; }
        const body = await res.json();
        const follows = Array.isArray(body.data) && body.data.some(f => f.user_id === userId);
        this.followCache.set(userId, { follows, at: this.now() });
        return follows;
      } catch (err) { this.log('follower check failed: ' + err.message); return null; }
    }
    return null;
  }
}

module.exports = { TwitchAuth, SCOPE };
