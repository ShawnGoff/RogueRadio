'use strict';
// Local mode: control the Spotify desktop app already running on this computer (macOS, via AppleScript).
// No Spotify account link, no developer app and no API quota: it only talks to the user's own app.
// It can play, pause, skip, seek, change volume, shuffle/repeat and read what is playing. Anything that
// needs Spotify's online catalogue (search, likes, playlists, queue, devices) needs a connected account.
const { execFile } = require('node:child_process');

const SEP = '|||';
const APP = 'Spotify';

// NOTE: running any `tell application "Spotify"` script LAUNCHES Spotify if it is closed, so every
// script is preceded by a check that it is running.
// NOTE: `st` is a reserved word in Spotify's scripting vocabulary, so use descriptive variable names.
const STATE_SCRIPT = `tell application "Spotify"
  try
    set stateText to player state as text
    if stateText is "stopped" then return "stopped"
    set t to current track
    set artText to ""
    try
      set artText to artwork url of t
    end try
    return stateText & "${SEP}" & (player position as text) & "${SEP}" & (sound volume as text) & "${SEP}" & (shuffling as text) & "${SEP}" & (repeating as text) & "${SEP}" & (id of t) & "${SEP}" & (name of t) & "${SEP}" & (artist of t) & "${SEP}" & (album of t) & "${SEP}" & (duration of t as text) & "${SEP}" & artText
  on error problem
    return "error: " & problem
  end try
end tell`;

const available = () => process.platform === 'darwin';

function isRunning() {
  return new Promise(resolve => {
    if (!available()) return resolve(false);
    execFile('pgrep', ['-x', APP], err => resolve(!err));
  });
}

// "1,5" in some locales
const num = x => Number(String(x).trim().replace(',', '.'));

// Output of STATE_SCRIPT -> a plain object, or null when nothing is playing
function parseState(out) {
  const s = String(out || '').trim();
  if (!s || s === 'stopped') return null;
  if (s.startsWith('error:')) throw { status: 500, code: 'LOCAL_ERROR', message: s.slice(6).trim().slice(0, 200) };
  const [state, pos, vol, shuffle, repeat, uri, name, artist, album, duration, art] = s.split(SEP);
  if (!uri && !name) return null;
  return {
    state,
    progress: Math.round(num(pos) * 1000),                 // AppleScript reports seconds
    volume: Math.round(num(vol)),
    shuffle: shuffle === 'true',
    repeat: repeat === 'true',
    uri, name, artist, album,
    duration: Math.round(num(duration)),                    // already milliseconds
    imageUrl: art || null,
  };
}

function toError(err, stderr) {
  const text = String(stderr || err.message || '');
  if (/-1743|not authorized/i.test(text)) {
    return { status: 403, code: 'LOCAL_PERMISSION', message: 'macOS has not allowed this app to control Spotify (System Settings > Privacy & Security > Automation).' };
  }
  return { status: 500, code: 'LOCAL_ERROR', message: text.trim().slice(0, 200) || 'Could not talk to the Spotify app' };
}

// Run one script; scripts are queued so they never overlap
let chain = Promise.resolve();
function run(script) {
  const job = chain.then(() => new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 6000 }, (err, stdout, stderr) => (err ? reject(toError(err, stderr)) : resolve(stdout)));
  }));
  chain = job.catch(() => {});
  return job;
}

// Run a control command only if Spotify is open (never launches it)
async function control(line) {
  if (!available()) throw { status: 501, code: 'LOCAL_UNSUPPORTED', message: 'Local control is only available on macOS so far' };
  if (!await isRunning()) throw { status: 404, code: 'SPOTIFY_NOT_RUNNING', message: 'Open the Spotify app first' };
  await run(`tell application "${APP}" to ${line}`);
}

let lastRead = { at: 0, value: null };

const local = {
  available,
  isRunning,
  parseState,                                              // exposed for tests
  STATE_SCRIPT,

  // Same shape as SpotifyClient.getCurrentTrack(), or null
  async getCurrentTrack() {
    if (!await isRunning()) return null;
    if (Date.now() - lastRead.at < 600) return lastRead.value;      // several callers in one second share a read
    const s = parseState(await run(STATE_SCRIPT));
    const value = s && {
      id: String(s.uri).split(':').pop(),
      name: s.name, artist: s.artist, artists: [s.artist], album: s.album,
      imageUrl: s.imageUrl, duration: s.duration, progress: s.progress,
      isPlaying: s.state === 'playing',
      uri: s.uri,
      shuffle: s.shuffle,
      repeat: s.repeat ? 'context' : 'off',                // the Spotify app only exposes repeat on/off to scripts
      volume: s.volume,
    };
    lastRead = { at: Date.now(), value };
    return value;
  },

  play: () => control('play'),
  pause: () => control('pause'),
  next: () => control('next track'),
  previous: () => control('previous track'),
  seek: ms => control(`set player position to ${(Math.max(0, Math.round(Number(ms) || 0)) / 1000).toFixed(3)}`),
  setVolume: pct => control(`set sound volume to ${Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))}`),
  setShuffle: on => control(`set shuffling to ${on ? 'true' : 'false'}`),
  setRepeat: mode => control(`set repeating to ${mode === 'off' ? 'false' : 'true'}`),
};

module.exports = local;
