'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { TwitchChat, normalizeChannel, parseLine, toChatter } = require('../src/twitch-chat');
const { RequestManager, parseCommand, extractRef, access } = require('../src/requests');
const { TwitchAuth } = require('../src/twitch-auth');

const SETTINGS = {
  twitchWho: 'followers', twitchCooldown: 30, twitchPerUser: 2, twitchMaxQueue: 15,
  twitchMaxMinutes: 8, twitchBlockExplicit: false, twitchBlocklist: '',
};
const viewer = (over = {}) => ({ login: 'vera', name: 'Vera', id: '11', text: '!sr hello', isBroadcaster: false, isMod: false, isVip: false, isSub: false, ...over });

// ---- chat parsing -----------------------------------------------------------
test('normalizeChannel accepts names, #names and links, rejects junk', () => {
  assert.strictEqual(normalizeChannel('  #RogueRadio '), 'rogueradio');
  assert.strictEqual(normalizeChannel('https://www.twitch.tv/RogueRadio/videos'), 'rogueradio');
  assert.strictEqual(normalizeChannel('bad name!'), null);
  assert.strictEqual(normalizeChannel(''), null);
});

test('parseLine reads tags, prefix and trailing text (with escapes)', () => {
  const m = parseLine('@badges=subscriber/12,vip/1;display-name=Vera\\sK;mod=0;user-id=11 :vera!vera@vera.tmi.twitch.tv PRIVMSG #chan :!sr a b : c');
  assert.strictEqual(m.command, 'PRIVMSG');
  assert.strictEqual(m.tags['display-name'], 'Vera K');
  assert.strictEqual(m.trailing, '!sr a b : c');
  const c = toChatter(m);
  assert.deepStrictEqual([c.login, c.name, c.id, c.isSub, c.isVip, c.isMod, c.isBroadcaster], ['vera', 'Vera K', '11', true, true, false, false]);
  assert.strictEqual(parseLine('PING :tmi.twitch.tv').trailing, 'tmi.twitch.tv');
});

test('toChatter ignores /me lines and non-chat commands; reads mod and broadcaster', () => {
  assert.strictEqual(toChatter(parseLine(':a!a@a PRIVMSG #c :\u0001ACTION !sr x\u0001')), null);
  assert.strictEqual(toChatter(parseLine(':tmi 001 nick :Welcome')), null);
  const c = toChatter(parseLine('@badges=broadcaster/1;mod=1 :me!me@me PRIVMSG #me :hi'));
  assert.ok(c.isBroadcaster && c.isMod);
  assert.ok(toChatter(parseLine('@badges=founder/0 :a!a@a PRIVMSG #c :hi')).isSub);
});

test('TwitchChat joins anonymously, answers PING and emits chat messages', async () => {
  const received = [];
  const server = net.createServer(sock => {
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', d => {
      buf += d;
      received.push(...buf.split('\r\n').filter(Boolean)); buf = '';
      if (received.some(l => l.startsWith('JOIN'))) {
        sock.write(':tmi 001 justinfan1 :Welcome\r\n:justinfan1!j@j JOIN #chan\r\nPING :tmi.twitch.tv\r\n');
        sock.write('@badges=subscriber/1;display-name=Vera;user-id=11 :vera!vera@vera PRIVMSG #chan :!sr hello\r\n');
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const chat = new TwitchChat({ channel: 'chan', host: '127.0.0.1', port: server.address().port, secure: false });
  const statuses = [];
  chat.on('status', s => statuses.push(s));
  const msg = new Promise(r => chat.on('message', r));
  chat.start();
  const c = await msg;
  await new Promise(r => setTimeout(r, 50));
  chat.stop(); server.close();
  assert.strictEqual(c.text, '!sr hello');
  assert.ok(c.isSub);
  assert.ok(received.some(l => /^NICK justinfan\d+$/.test(l)));
  assert.ok(received.includes('PASS SCHMOOZE') && received.includes('JOIN #chan'));
  assert.ok(received.some(l => l.startsWith('CAP REQ') && l.includes('tags')));
  assert.ok(received.includes('PONG :tmi.twitch.tv'));
  assert.ok(statuses.includes('listening'));
});

// ---- command parsing and access ----------------------------------------------
test('parseCommand and extractRef', () => {
  assert.deepStrictEqual(parseCommand('!SR  Never Gonna Give You Up '), { name: 'request', arg: 'Never Gonna Give You Up' });
  assert.deepStrictEqual(parseCommand('!skip'), { name: 'skip', arg: '' });
  assert.strictEqual(parseCommand('hello !sr x'), null);
  assert.strictEqual(parseCommand('!dance'), null);
  assert.deepStrictEqual(extractRef('https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh?si=abc'), { id: '4iV5W9uYEdYUVa79Axb7Rh' });
  assert.deepStrictEqual(extractRef('https://open.spotify.com/intl-de/track/4iV5W9uYEdYUVa79Axb7Rh'), { id: '4iV5W9uYEdYUVa79Axb7Rh' });
  assert.deepStrictEqual(extractRef('spotify:track:4iV5W9uYEdYUVa79Axb7Rh'), { id: '4iV5W9uYEdYUVa79Axb7Rh' });
  assert.deepStrictEqual(extractRef('https://open.spotify.com/album/4iV5W9uYEdYUVa79Axb7Rh'), { unsupported: true });
  assert.deepStrictEqual(extractRef('x'.repeat(300)), { query: 'x'.repeat(100) });
  assert.strictEqual(extractRef('  '), null);
});

test('access: each audience setting', () => {
  const nobody = viewer(), sub = viewer({ isSub: true }), mod = viewer({ isMod: true }), vip = viewer({ isVip: true });
  assert.ok(access('everyone', nobody).ok);
  assert.ok(access('mods', mod).ok && !access('mods', sub).ok && !access('mods', nobody).ok);
  assert.ok(access('subscribers', sub).ok && access('subscribers', vip).ok && !access('subscribers', nobody).ok);
  assert.ok(access('followers', sub).ok);                                   // a subscriber needs no follower lookup
  assert.strictEqual(access('followers', nobody).needFollowCheck, true);
  assert.ok(access('followers', nobody, true).ok);
  assert.ok(!access('followers', nobody, false).ok);
  assert.match(access('followers', nobody, null).reason, /unavailable/);
  assert.ok(access('followers', viewer({ isBroadcaster: true })).ok);
});

// ---- the request flow ---------------------------------------------------------
function harness({ settings = {}, follows = true, tracks = {}, now = { t: 1e9 } } = {}) {
  const song = (id, over = {}) => ({ id, uri: `spotify:track:${id}`, name: `Song ${id}`, artist: 'Band', explicit: false, durationMs: 180000, ...over });
  const log = { added: [], skipped: 0, followChecks: 0, events: [] };
  const api = {
    search: async q => ({ ok: true, tracks: tracks[q] ? [tracks[q]] : [] }),
    track: async id => (tracks[id] ? { ok: true, track: tracks[id] } : { ok: false, status: 404 }),
    add: async uri => { log.added.push(uri); return api.addResult || { ok: true }; },
    skip: async () => { log.skipped++; return { ok: true }; },
  };
  const mgr = new RequestManager({
    getSettings: () => ({ ...SETTINGS, ...settings }), api, now: () => now.t,
    followCheck: async () => { log.followChecks++; return follows; },
    notify: ev => log.events.push(ev),
  });
  return { mgr, api, log, song, now, tracks };
}

test('a follower request searches, queues and tells the overlay', async () => {
  const h = harness();
  h.tracks['hello'] = h.song('aaaaaaaaaa');
  const r = await h.mgr.handle(viewer());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(h.log.added, ['spotify:track:aaaaaaaaaa']);
  assert.deepStrictEqual(h.log.events, [{ type: 'added', user: 'Vera', name: 'Song aaaaaaaaaa', artist: 'Band' }]);
  assert.strictEqual(h.mgr.requestedBy('aaaaaaaaaa'), 'Vera');
});

test('non-followers are refused and nothing is queued; subs skip the follower lookup', async () => {
  const h = harness({ follows: false });
  h.tracks['hello'] = h.song('aaaaaaaaaa');
  assert.strictEqual((await h.mgr.handle(viewer())).ok, false);
  assert.strictEqual(h.log.added.length, 0);
  assert.strictEqual((await h.mgr.handle(viewer({ login: 'sam', isSub: true }))).ok, true);
  assert.strictEqual(h.log.followChecks, 1);
});

test('a pasted song link queues that exact song; an album link is refused', async () => {
  const h = harness({ settings: { twitchWho: 'everyone' } });
  h.tracks['4iV5W9uYEdYUVa79Axb7Rh'] = h.song('4iV5W9uYEdYUVa79Axb7Rh');
  assert.ok((await h.mgr.handle(viewer({ text: '!sr https://open.spotify.com/track/4iV5W9uYEdYUVa79Axb7Rh' }))).ok);
  const bad = await h.mgr.handle(viewer({ login: 'b', text: '!sr https://open.spotify.com/album/4iV5W9uYEdYUVa79Axb7Rh' }));
  assert.match(bad.reason, /song links/);
});

test('cooldown, per-viewer limit, duplicates and queue size', async () => {
  const h = harness({ settings: { twitchWho: 'everyone', twitchPerUser: 2, twitchMaxQueue: 3, twitchCooldown: 30 } });
  for (const n of ['a', 'b', 'c', 'd']) h.tracks[n] = h.song(n.repeat(10));
  assert.ok((await h.mgr.handle(viewer({ text: '!sr a' }))).ok);
  assert.match((await h.mgr.handle(viewer({ text: '!sr b' }))).reason, /cooldown/);
  h.now.t += 31000;
  assert.ok((await h.mgr.handle(viewer({ text: '!sr b' }))).ok);
  h.now.t += 31000;
  assert.match((await h.mgr.handle(viewer({ text: '!sr c' }))).reason, /already has 2/);
  assert.match((await h.mgr.handle(viewer({ login: 'o', text: '!sr a' }))).reason, /already queued/);
  h.now.t += 31000;                                                         // the refused attempt above started their cooldown too
  assert.ok((await h.mgr.handle(viewer({ login: 'o', text: '!sr c' }))).ok);
  assert.match((await h.mgr.handle(viewer({ login: 'p', text: '!sr d' }))).reason, /full/);
});

test('mods skip the cooldown and the per-viewer limit', async () => {
  const h = harness({ settings: { twitchPerUser: 1 } });
  for (const n of ['a', 'b']) h.tracks[n] = h.song(n.repeat(10));
  const mod = { isMod: true };
  assert.ok((await h.mgr.handle(viewer({ ...mod, text: '!sr a' }))).ok);
  assert.ok((await h.mgr.handle(viewer({ ...mod, text: '!sr b' }))).ok);
});

test('length, explicit and blocklist rules', async () => {
  const h = harness({ settings: { twitchWho: 'everyone', twitchCooldown: 0, twitchMaxMinutes: 5, twitchBlockExplicit: true, twitchBlocklist: 'Nickelback, live' } });
  h.tracks['long'] = h.song('lllllllllll', { durationMs: 6 * 60000 });
  h.tracks['rude'] = h.song('rrrrrrrrrr', { explicit: true });
  h.tracks['nb'] = h.song('nnnnnnnnnn', { artist: 'Nickelback' });
  h.tracks['live'] = h.song('vvvvvvvvvv', { name: 'Hello (Live at Wembley)' });
  for (const [q, re] of [['long', /longer than 5/], ['rude', /explicit/], ['nb', /blocklist/], ['live', /blocklist/], ['nothing', /nothing found/]]) {
    assert.match((await h.mgr.handle(viewer({ login: q, text: `!sr ${q}` }))).reason, re);
  }
  assert.strictEqual(h.log.added.length, 0);
});

test('Spotify trouble gives a useful reason and is flagged as a setup problem', async () => {
  const h = harness({ settings: { twitchWho: 'everyone' } });
  h.tracks['hello'] = h.song('aaaaaaaaaa');
  h.api.addResult = { ok: false, status: 403, code: 'NEEDS_SPOTIFY_LOGIN' };
  const r = await h.mgr.handle(viewer());
  assert.match(r.reason, /connect your Spotify/);
  assert.ok(h.log.events.at(-1).problem);
  assert.strictEqual(h.mgr.requestedBy('aaaaaaaaaa'), null);               // a failed add is not remembered
});

test('!skip is for mods; a bare !sr and normal chat are ignored', async () => {
  const h = harness({ settings: { twitchWho: 'everyone' } });
  assert.strictEqual((await h.mgr.handle(viewer({ text: '!skip' }))).ok, false);
  assert.strictEqual(h.log.skipped, 0);
  assert.ok((await h.mgr.handle(viewer({ isMod: true, text: '!skip' }))).ok);
  assert.strictEqual(h.log.skipped, 1);
  assert.strictEqual(await h.mgr.handle(viewer({ text: '!sr' })), null);
  assert.strictEqual(await h.mgr.handle(viewer({ text: 'nice song' })), null);
});

test('now-playing tracking: the requester shows while the song plays, then clears', async () => {
  const h = harness({ settings: { twitchWho: 'everyone', twitchCooldown: 0 } });
  h.tracks['a'] = h.song('aaaaaaaaaa'); h.tracks['b'] = h.song('bbbbbbbbbb');
  await h.mgr.handle(viewer({ login: 'x', name: 'X', text: '!sr a' }));
  await h.mgr.handle(viewer({ login: 'y', name: 'Y', text: '!sr b' }));
  h.mgr.noteNowPlaying('zzzzzzzzzz');                                       // something else is playing
  assert.strictEqual(h.mgr.requestedBy('bbbbbbbbbb'), 'Y');
  h.mgr.noteNowPlaying('aaaaaaaaaa');
  assert.strictEqual(h.mgr.requestedBy('aaaaaaaaaa'), 'X');
  assert.strictEqual(h.mgr.pending.length, 1);
  h.mgr.noteNowPlaying('bbbbbbbbbb');
  assert.strictEqual(h.mgr.requestedBy('aaaaaaaaaa'), null);
  h.mgr.noteNowPlaying('cccccccccc');
  assert.strictEqual(h.mgr.requestedBy('bbbbbbbbbb'), null);
});

// ---- Twitch account ------------------------------------------------------------
function authHarness(responder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twitch-test-'));
  const calls = [];
  const clock = { t: 1e9 };
  const fetchFn = async (url, opts = {}) => {
    const body = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null;
    calls.push({ url, body, headers: opts.headers });
    const r = responder(url, body, opts) || { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const auth = new TwitchAuth({ dataDir: dir, fetchFn, sleep: async () => { clock.t += 5000; }, now: () => clock.t });
  return { auth, calls, dir, clock };
}
const CLIENT = 'abcdefghijklmnopqrstuvwxyz1234';

test('sign-in: waits while pending, then saves the login privately', async () => {
  let polls = 0;
  const h = authHarness((url, body) => {
    if (url.endsWith('/device')) return { status: 200, json: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://www.twitch.tv/activate', expires_in: 1800, interval: 5 } };
    if (url.endsWith('/token')) return ++polls < 3 ? { status: 400, json: { message: 'authorization_pending' } } : { status: 200, json: { access_token: 'at', refresh_token: 'rt', expires_in: 14000 } };
    if (url.endsWith('/validate')) return { status: 200, json: { login: 'streamer', user_id: '99' } };
  });
  const flow = await h.auth.connect(CLIENT, () => {});
  assert.strictEqual(flow.userCode, 'ABCD-1234');
  const tokenCall = () => h.calls.find(c => c.url.endsWith('/token'));
  await new Promise(r => { const t = setInterval(() => { if (h.auth.connected) { clearInterval(t); r(); } }, 5); });
  assert.deepStrictEqual([h.auth.login, h.auth.userId], ['streamer', '99']);
  assert.strictEqual(tokenCall().body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.strictEqual(tokenCall().body.scopes, 'moderator:read:followers');
  const file = path.join(h.dir, 'twitch.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  h.auth.disconnect();
  assert.ok(!fs.existsSync(file));
});

test('sign-in rejects a bad Client ID up front and reports a Twitch refusal', async () => {
  const h = authHarness(() => ({ status: 400, json: { message: 'invalid client' } }));
  await assert.rejects(h.auth.connect('nope'), /Client ID/);
  await assert.rejects(h.auth.connect(CLIENT), /invalid client/);
});

test('an expired access token is refreshed and the new single-use refresh token is stored', async () => {
  const h = authHarness(url => (url.endsWith('/token') ? { status: 200, json: { access_token: 'at2', refresh_token: 'rt2', expires_in: 14000 } } : null));
  h.auth.tokens = { clientId: CLIENT, accessToken: 'at1', refreshToken: 'rt1', expiresAt: h.clock.t + 1000, login: 's', userId: '99' };
  assert.strictEqual(await h.auth.accessToken(), 'at2');
  assert.strictEqual(h.calls[0].body.grant_type, 'refresh_token');
  assert.strictEqual(h.calls[0].body.client_secret, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h.dir, 'twitch.json'), 'utf8')).refreshToken, 'rt2');
});

test('a revoked login signs out instead of retrying forever', async () => {
  const h = authHarness(() => ({ status: 400, json: { message: 'Invalid refresh token' } }));
  h.auth.tokens = { clientId: CLIENT, accessToken: 'a', refreshToken: 'r', expiresAt: 0, login: 's', userId: '99' };
  assert.strictEqual(await h.auth.accessToken(), null);
  assert.strictEqual(h.auth.connected, false);
});

test('follower check: asks Twitch with the right query, caches, and only for the signed-in channel', async () => {
  const h = authHarness((url, _b, opts) => {
    if (!url.includes('/channels/followers')) return null;
    return { status: 200, json: { data: new URL(url).searchParams.get('user_id') === '11' ? [{ user_id: '11' }] : [] } };
  });
  h.auth.tokens = { clientId: CLIENT, accessToken: 'at', refreshToken: 'rt', expiresAt: h.clock.t + 1e7, login: 'streamer', userId: '99' };
  assert.strictEqual(await h.auth.isFollower('11', 'streamer'), true);
  assert.strictEqual(await h.auth.isFollower('11', 'streamer'), true);
  assert.strictEqual(h.calls.length, 1);                                    // second answer came from the cache
  const q = new URL(h.calls[0].url).searchParams;
  assert.deepStrictEqual([q.get('broadcaster_id'), q.get('user_id')], ['99', '11']);
  assert.strictEqual(h.calls[0].headers.Authorization, 'Bearer at');
  assert.strictEqual(h.calls[0].headers['Client-Id'], CLIENT);
  assert.strictEqual(await h.auth.isFollower('12', 'streamer'), false);
  assert.strictEqual(await h.auth.isFollower('11', 'someoneelse'), null);   // not this account's channel
});

test('follower check is unknown (null) when signed out or Twitch errors', async () => {
  const h = authHarness(() => ({ status: 500, json: {} }));
  assert.strictEqual(await h.auth.isFollower('11', 'streamer'), null);
  h.auth.tokens = { clientId: CLIENT, accessToken: 'at', refreshToken: 'rt', expiresAt: h.clock.t + 1e7, login: 'streamer', userId: '99' };
  assert.strictEqual(await h.auth.isFollower('11', 'streamer'), null);
});
