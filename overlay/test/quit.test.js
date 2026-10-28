'use strict';
// Exercises src/quit.js against a pretend operating system (fake pgrep / osascript / pkill),
// so nothing here can touch a real Spotify.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

let spotifyUp, osascript, pkillWorks, calls;
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req !== 'node:child_process') return origLoad.call(this, req, ...a);
  return { execFile: (cmd, args, opts, cb) => {
    cb = typeof opts === 'function' ? opts : cb;
    calls.push(cmd);
    setImmediate(() => {
      if (cmd === 'pgrep') return cb(spotifyUp ? null : new Error('none'));
      if (cmd === 'osascript') {
        const r = osascript();
        if (r.closes) spotifyUp = false;
        return cb(r.err || null, '', r.stderr || '');
      }
      if (cmd === 'pkill') { if (pkillWorks) spotifyUp = false; return cb(null); }
      cb(new Error('unexpected ' + cmd));
    });
  } };
};
Object.defineProperty(process, 'platform', { value: 'darwin' });     // the helper is macOS-only
const q = require('../src/quit');

const setup = (o) => { spotifyUp = true; pkillWorks = true; calls = []; osascript = o; };

test('polite quit works: AppleScript only, no terminate', async () => {
  setup(() => ({ closes: true }));
  const r = await q.closeSpotify();
  assert.deepStrictEqual([r.ok, r.method], [true, 'applescript']);
  assert.ok(!calls.includes('pkill'));
});

test('macOS denies permission: reports it and does NOT terminate on its own', async () => {
  setup(() => ({ err: new Error('x'), stderr: 'Not authorized to send Apple events to Spotify. (-1743)' }));
  const r = await q.closeSpotify();
  assert.deepStrictEqual([r.ok, r.reason], [false, 'permission']);
  assert.ok(!calls.includes('pkill'));
  assert.strictEqual(spotifyUp, true);
});

test('after the user agrees, forceClose terminates it', async () => {
  setup(() => ({}));
  const r = await q.forceCloseSpotify();
  assert.strictEqual(r.ok, true);
  assert.ok(calls.includes('pkill'));
});

test('AppleScript hangs/times out: falls back to terminate and Spotify closes', async () => {
  setup(() => { const e = new Error('timed out'); e.killed = true; return { err: e }; });
  const r = await q.closeSpotify();
  assert.deepStrictEqual([r.ok, r.method], [true, 'terminate']);
});

test('AppleScript says OK but Spotify stays open: falls back to terminate', async () => {
  setup(() => ({ closes: false }));
  const r = await q.closeSpotify();
  assert.deepStrictEqual([r.ok, r.method], [true, 'terminate']);
});

test('nothing works: reports it honestly instead of claiming success', async () => {
  setup(() => ({ err: new Error('boom'), stderr: 'something else' }));
  pkillWorks = false;
  const r = await q.closeSpotify();
  assert.deepStrictEqual([r.ok, r.reason], [false, 'still-running']);
});

test('decide(): only asks or closes when Spotify is actually running', () => {
  for (const [mode, running, want] of [['ask', false, 'quit'], ['close', false, 'quit'], ['keep', true, 'quit'], ['ask', true, 'ask'], ['close', true, 'close'], ['bogus', true, 'ask']]) {
    assert.strictEqual(q.decide(mode, running), want, `${mode}/${running}`);
  }
});
