'use strict';
// Runs the Twitch song-request feature: chat reader + rules + Spotify, driven by the settings.
const { TwitchChat, normalizeChannel } = require('./twitch-chat');
const { TwitchAuth } = require('./twitch-auth');
const { RequestManager } = require('./requests');

// The companion server's API, shaped for RequestManager. `request` is commands.request.
function companionApi(request, log) {
  const wrap = r => ({ ok: r.ok, status: r.status, code: r.data?.code });
  return {
    async search(q) {
      const r = await request('GET', `/api/search?${new URLSearchParams({ q, types: 'track' })}`, log);
      return { ...wrap(r), tracks: r.data?.tracks || [] };
    },
    async track(id) {
      const r = await request('GET', `/api/track?${new URLSearchParams({ id })}`, log);
      return { ...wrap(r), track: r.data };
    },
    async add(uri) { return wrap(await request('POST', `/api/queue/add?${new URLSearchParams({ uri })}`, log)); },
    async skip() { return wrap(await request('POST', '/api/next', log)); },
  };
}

function createTwitchService({ dataDir, getSettings, request, log, onEvent = () => {}, onChange = () => {}, openExternal = () => {}, auth, makeChat = o => new TwitchChat(o) }) {
  auth = auth || new TwitchAuth({ dataDir, log });
  const manager = new RequestManager({
    getSettings,
    api: companionApi(request, log),
    followCheck: c => auth.isFollower(c.id, normalizeChannel(getSettings().twitchChannel)),
    notify: onEvent,
    log,
  });

  let chat = null;
  let chatState = 'off';                // off | connecting | listening | reconnecting
  let signIn = null;                    // { userCode, verificationUri } while waiting for approval
  let signInError = '';
  let activeChannel = null;

  function setChatState(s) { chatState = s; onChange(); }

  function stopChat() {
    if (chat) { chat.removeAllListeners(); chat.stop(); chat = null; }
    activeChannel = null;
    chatState = 'off';
  }

  // Start, stop or re-point the chat reader to match the settings.
  function apply() {
    const s = getSettings();
    const channel = normalizeChannel(s.twitchChannel);
    const want = s.twitchEnabled && channel;
    if (!want) { if (chat) { stopChat(); manager.clear(); onChange(); } return; }
    if (chat && activeChannel === channel) return;
    stopChat();
    manager.clear();
    activeChannel = channel;
    chat = makeChat({ channel });
    chat.on('status', st => { if (st !== 'stopped') setChatState(st); });
    chat.on('error-message', m => log('Twitch chat: ' + m));
    chat.on('message', c => { manager.handle(c).catch(err => log('song request failed: ' + err.message)); });
    chat.start();
    log(`listening to Twitch chat for #${channel}`);
  }

  async function connect(clientId) {
    signInError = '';
    signIn = await auth.connect(clientId, err => {
      signIn = null;
      if (err) { signInError = err.message; log('Twitch sign-in failed: ' + err.message); }
      else log(`Twitch connected as ${auth.login}`);
      onChange();
    });
    openExternal(signIn.verificationUri);
    onChange();
    return signIn;
  }

  function disconnect() { auth.disconnect(); signIn = null; signInError = ''; onChange(); }

  function status() {
    const s = getSettings();
    const channel = normalizeChannel(s.twitchChannel);
    return {
      enabled: !!s.twitchEnabled,
      chat: chatState,
      channel,
      connected: auth.connected,
      login: auth.login,
      signIn,
      signInError,
      // follower checks only work for the signed-in account's own channel
      followerCheck: auth.connected && !!channel && auth.login?.toLowerCase() === channel,
      waiting: manager.pending.length,
    };
  }

  return {
    apply, connect, disconnect, status,
    cancelSignIn: () => { auth.cancel(); signIn = null; onChange(); },
    noteNowPlaying: id => manager.noteNowPlaying(id),
    requestedBy: id => manager.requestedBy(id),
    stop: () => { stopChat(); auth.cancel(); },
  };
}

module.exports = { createTwitchService, companionApi };
