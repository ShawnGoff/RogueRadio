'use strict';
// "Also close Spotify when I quit": detection, closing, and the decision logic.
// Arguments are fixed strings and run without a shell.
const { execFile } = require('node:child_process');

const MODES = ['ask', 'close', 'keep'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Is the Spotify desktop app running? (macOS only for now)
function spotifyRunning() {
  return new Promise(resolve => {
    if (process.platform !== 'darwin') return resolve(false);
    execFile('pgrep', ['-x', 'Spotify'], err => resolve(!err));      // pgrep exits non-zero when nothing matches
  });
}

async function waitUntilClosed(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!await spotifyRunning()) return true;
    await sleep(250);
  }
  return !await spotifyRunning();
}

// Polite quit via AppleScript. macOS asks the user to allow it the first time, and may refuse
// outright for an unsigned app, so this can fail or hang: callers must not rely on it.
function askSpotifyToQuit() {
  return new Promise(resolve => {
    execFile('osascript', ['-e', 'tell application "Spotify" to quit'], { timeout: 4000 }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true });
      if (/-1743|not authorized/i.test(String(stderr))) return resolve({ ok: false, reason: 'permission' });
      resolve({ ok: false, reason: err.killed ? 'timeout' : 'error', detail: String(stderr || err.message).trim().slice(0, 200) });
    });
  });
}

// Ordinary terminate signal (what Activity Monitor's "Quit" sends). Needs no special permission.
function terminateSpotify() {
  return new Promise(resolve => {
    execFile('pkill', ['-TERM', '-x', 'Spotify'], () => resolve());
  }).then(() => waitUntilClosed(3000));
}

// Close Spotify and confirm it is gone. Resolves { ok, method, reason?, detail? }.
//  - tries the polite AppleScript quit first;
//  - if macOS explicitly refuses permission, stops and reports 'permission' (the caller can offer force);
//  - on any other failure (hang, error, or it says OK but Spotify stays open) falls back to terminate.
async function closeSpotify() {
  if (process.platform !== 'darwin') return { ok: false, reason: 'unsupported' };
  const polite = await askSpotifyToQuit();
  if (polite.ok && await waitUntilClosed(4000)) return { ok: true, method: 'applescript' };
  if (polite.reason === 'permission') return { ok: false, reason: 'permission' };

  const closed = await terminateSpotify();
  return closed
    ? { ok: true, method: 'terminate', detail: polite.ok ? 'quit request was ignored' : `${polite.reason}: ${polite.detail || ''}`.trim() }
    : { ok: false, reason: 'still-running', detail: polite.detail };
}

// Used after the user agrees to close it without macOS's permission
async function forceCloseSpotify() {
  const closed = await terminateSpotify();
  return closed ? { ok: true, method: 'terminate' } : { ok: false, reason: 'still-running' };
}

// What to do when the app is quitting. Returns 'quit' | 'close' | 'ask'.
function decide(mode, spotifyIsRunning) {
  if (!spotifyIsRunning) return 'quit';
  if (mode === 'close') return 'close';
  if (mode === 'keep') return 'quit';
  return 'ask';
}

module.exports = { MODES, spotifyRunning, closeSpotify, forceCloseSpotify, decide };
