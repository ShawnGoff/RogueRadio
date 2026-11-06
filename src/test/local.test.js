'use strict';
// Local mode (controlling the Spotify desktop app): everything runs against a pretend operating
// system, so these tests can never touch or launch a real Spotify.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'azr-local-'));
Object.defineProperty(process, 'platform', { value: 'darwin' });

let spotifyRunning, osaOutput, osaError, scripts;
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'node:child_process' || req === 'child_process') {
    return { execFile: (cmd, args, opts, cb) => {
      cb = typeof opts === 'function' ? opts : cb;
      setImmediate(() => {
        if (cmd === 'pgrep') return cb(spotifyRunning ? null : new Error('none'));
        if (cmd === 'osascript') { scripts.push(args[1]); return osaError ? cb(new Error('x'), '', osaError) : cb(null, osaOutput, ''); }
        cb(new Error('unexpected ' + cmd));
      });
    } };
  }
  if (req === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ data: {} }), put: async () => ({ data: {} }), delete: async () => ({ data: {} }) };
  return origLoad.call(this, req, ...a);
};

const realCP = origLoad.call(Module, 'node:child_process', module, false);
const local = require('../local');
const spotify = require('../spotify');
const SEP = '|||';
const SAMPLE = ['playing', '42.5', '55', 'true', 'false', 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh', 'Orphan Soul', 'Infected Rain', 'Ecdysis', '288000', 'https://i.scdn.co/image/abc'].join(SEP);
const setup = (o = {}) => { spotifyRunning = o.running ?? true; osaOutput = o.out ?? SAMPLE; osaError = o.err ?? null; scripts = []; };
const fresh = () => new Promise(r => setTimeout(r, 650));        // let the 600 ms read cache expire

test('parseState reads every field, including a comma decimal and an empty/stopped answer', () => {
  const s = local.parseState(SAMPLE);
  assert.deepStrictEqual([s.state, s.progress, s.volume, s.shuffle, s.repeat, s.name, s.artist, s.album, s.duration, s.imageUrl],
    ['playing', 42500, 55, true, false, 'Orphan Soul', 'Infected Rain', 'Ecdysis', 288000, 'https://i.scdn.co/image/abc']);
  assert.strictEqual(local.parseState(SAMPLE.replace('42.5', '42,5')).progress, 42500);
  assert.strictEqual(local.parseState('stopped'), null);
  assert.strictEqual(local.parseState(''), null);
  assert.throws(() => local.parseState('error: Can\u2019t get track 1. (-1728)'), e => e.code === 'LOCAL_ERROR' && /track 1/.test(e.message));    // surfaced, not mistaken for "nothing playing"
});

test('getCurrentTrack maps to the same shape the API mode returns', async () => {
  setup();
  const t = await local.getCurrentTrack();
  assert.deepStrictEqual([t.id, t.uri, t.name, t.isPlaying, t.progress, t.duration, t.shuffle, t.repeat, t.volume],
    ['4iV5W9uYEdYUVa79Axb7Rh', 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh', 'Orphan Soul', true, 42500, 288000, true, 'off', 55]);
  assert.deepStrictEqual(t.artists, ['Infected Rain']);
});

test('NEVER launches Spotify: nothing is run when it is not open', async () => {
  await fresh(); setup({ running: false });
  assert.strictEqual(await local.getCurrentTrack(), null);
  await assert.rejects(() => local.pause(), e => e.code === 'SPOTIFY_NOT_RUNNING');
  await assert.rejects(() => local.next(), e => e.code === 'SPOTIFY_NOT_RUNNING');
  assert.deepStrictEqual(scripts, [], 'no AppleScript may run while Spotify is closed (it would launch it)');
});

test('controls send the right AppleScript, with values cleaned', async () => {
  setup();
  await local.play(); await local.pause(); await local.next(); await local.previous();
  await local.seek(154000); await local.seek(-5); await local.setVolume(250); await local.setVolume('abc');
  await local.setShuffle(true); await local.setShuffle(false); await local.setRepeat('off'); await local.setRepeat('track');
  assert.deepStrictEqual(scripts.map(s => s.replace('tell application "Spotify" to ', '')), [
    'play', 'pause', 'next track', 'previous track',
    'set player position to 154.000', 'set player position to 0.000',
    'set sound volume to 100', 'set sound volume to 0',
    'set shuffling to true', 'set shuffling to false', 'set repeating to false', 'set repeating to true',
  ]);
});

// The pretend operating system above can't notice a script with a syntax error (that is how a reserved
// word slipped through once), so compile every script we can send with the real compiler. Compiling
// never runs anything, so Spotify is not touched. Skipped where Spotify/osacompile are unavailable.
const probeOut = path.join(process.env.DATA_DIR, 'probe.scpt');
// Probe with a term only Spotify's dictionary defines ("sound volume"); a bare `play` compiles even when Spotify is missing.
const canCompile = realCP.spawnSync('osacompile', ['-e', 'tell application "Spotify" to set sound volume to 0', '-o', probeOut], { encoding: 'utf8' }).status === 0;   // compile only
test('every AppleScript the app sends compiles against the real Spotify dictionary', { skip: !canCompile && 'needs macOS with Spotify installed' }, async () => {
  setup();
  await local.play(); await local.pause(); await local.next(); await local.previous();
  await local.seek(154000); await local.setVolume(40); await local.setShuffle(true); await local.setShuffle(false); await local.setRepeat('off'); await local.setRepeat('track');
  const all = [local.STATE_SCRIPT, ...scripts];
  const out = path.join(process.env.DATA_DIR, 'compile-check.scpt');
  for (const script of all) {
    const r = realCP.spawnSync('osacompile', ['-e', script, '-o', out], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `does not compile: ${script.split('\n')[0]} ... ${r.stderr}`);
  }
  assert.ok(all.length >= 11);
});

test('a macOS permission refusal becomes a clear LOCAL_PERMISSION error', async () => {
  await fresh(); setup({ err: 'execution error: Not authorized to send Apple events to Spotify. (-1743)' });
  await assert.rejects(() => local.getCurrentTrack(), e => e.code === 'LOCAL_PERMISSION' && e.status === 403);
});

test('routes: with no login the overlay still works through the Spotify app', async () => {
  spotify.logout();                                                       // no account connected
  assert.strictEqual(spotify.isAuthenticated(), false);
  const express = require('express');
  const app = express(); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async p => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  const post = async p => { const r = await fetch(base + p, { method: 'POST' }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  await fresh(); setup();
  const cur = await get('/current-track');
  assert.deepStrictEqual([cur.status, cur.body.mode, cur.body.spotifyRunning, cur.body.track.name, cur.body.track.liked], [200, 'local', true, 'Orphan Soul', null]);

  setup();
  assert.strictEqual((await post('/pause')).status, 200);
  assert.strictEqual((await post('/volume?level=30')).status, 200);
  assert.strictEqual((await post('/seek?position=60000')).status, 200);
  assert.deepStrictEqual(scripts.map(s => s.replace('tell application "Spotify" to ', '')), ['pause', 'set sound volume to 30', 'set player position to 60.000']);

  // everything that needs the online catalogue is refused with a code the overlay understands
  for (const [method, p] of [['POST', '/like?uri=spotify:track:4iV5W9uYEdYUVa79Axb7Rh&state=true'], ['GET', '/playlists'], ['GET', '/queue'], ['GET', '/devices'], ['GET', '/search?q=abc'], ['POST', '/play-uri?uri=spotify:track:4iV5W9uYEdYUVa79Axb7Rh'], ['POST', '/queue/skip-to?count=2']]) {
    const r = method === 'GET' ? await get(p) : await post(p);
    assert.deepStrictEqual([r.status, r.body.code], [403, 'NEEDS_SPOTIFY_LOGIN'], p);
  }

  await fresh(); setup({ running: false });
  const closed = await get('/current-track');
  assert.deepStrictEqual([closed.status, closed.body.track, closed.body.spotifyRunning], [200, null, false]);
  assert.deepStrictEqual(scripts, [], 'checking state while Spotify is closed must not run any script');
  server.close();
});

test('logout forgets the saved login', () => {
  const storage = require('../storage');
  storage.saveTokens({ accessToken: 'a', refreshToken: 'r', tokenExpiry: Date.now() + 1e6, scope: 'x' });
  spotify.loadStoredTokens();
  assert.strictEqual(spotify.isAuthenticated(), true);
  spotify.logout();
  assert.strictEqual(spotify.isAuthenticated(), false);
  assert.strictEqual(storage.getTokens(), null);
});
