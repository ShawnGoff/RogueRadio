const express = require('express');
const router = express.Router();
const spotifyClient = require('./spotify');
const lrclib = require('./lrclib');
const local = require('./local');
const { execFile } = require('child_process');
const os = require('os');

// Playback calls go to the connected Spotify account when there is one; otherwise to the Spotify app on
// this computer ("local mode"), which needs no login at all.
const playback = () => (spotifyClient.isAuthenticated() ? spotifyClient : local);
const mode = () => (spotifyClient.isAuthenticated() ? 'api' : 'local');

// Features that need Spotify's online catalogue and so need a connected account
const needsAccount = (req, res, next) => {
  if (spotifyClient.isAuthenticated()) return next();
  res.status(403).json({ error: 'This needs a connected Spotify account (Settings > Connect).', code: 'NEEDS_SPOTIFY_LOGIN' });
};
router.use(['/like', '/playlists', '/devices', '/queue', '/search', '/play-uri', '/play-context'], needsAccount);

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

router.get('/auth/status', (req, res) => {
  try {
    if (!spotifyClient.isAuthenticated()) {
      return res.json({
        authenticated: false,
        mode: mode(),                              // 'local': controlling the Spotify app on this computer
        username: null
      });
    }

    res.json({
      authenticated: true,
      mode: mode(),
      needsReauth: spotifyClient.needsReauth(),   // true until the user re-authorizes for like/playlists
      username: 'Spotify User' // Could fetch real username if needed
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'AUTH_STATUS_ERROR' });
  }
});

// Disconnect the Spotify account: forget the saved login (Spotify's terms require an easy way to do
// this) and fall back to local mode
router.post('/auth/logout', (req, res) => {
  spotifyClient.logout();
  res.json({ success: true, mode: mode() });
});

router.get('/auth/login', (req, res) => {
  try {
    const authUrl = spotifyClient.getAuthUrl(req.query.switch === '1');
    
    // Open browser automatically
    // execFile (no shell): the URL contains '&', which a shell would treat as a command separator
    const platform = os.platform();
    const [cmd, args] = platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', authUrl]]
      : platform === 'darwin' ? ['open', [authUrl]]
      : ['xdg-open', [authUrl]];
    execFile(cmd, args, err => {
      if (err) console.log('Could not auto-open browser');
    });

    res.json({
      success: true,
      authUrl,
      message: 'Browser opened. Click "Authorize" to complete login.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message, code: 'LOGIN_ERROR' });
  }
});

router.get('/auth/callback', async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.send('<h1>Authorization Failed</h1><p>' + escapeHtml(error) + '</p><p>You can close this window.</p>');
    }

    if (!code) {
      return res.send('<h1>Missing Authorization Code</h1><p>Please try again.</p>');
    }

    await spotifyClient.exchangeCodeForToken(code);
    res.send(`
      <h1>Success!</h1>
      <p>Spotify has been authorized.</p>
      <p>You can close this window. The overlay will pick up your login within a second.</p>
    `);
  } catch (error) {
    console.error('Auth callback error:', error);
    res.status(500).send(`
      <h1>Authorization Error</h1>
      <p>${escapeHtml(error.message)}</p>
      <p>Please try again.</p>
    `);
  }
});

// ============================================
// PLAYBACK DATA ENDPOINTS
// ============================================

router.get('/current-track', async (req, res) => {
  try {
    const track = await playback().getCurrentTrack();
    // Only look lyrics up when the client asks (overlay's lyrics panel is open)
    const lyrics = track && req.query.lyrics === '1' ? lrclib.lookup(track) : null;
    const liked = track && mode() === 'api' ? await spotifyClient.isLiked(track.uri) : null;   // null = unknown / not available

    res.json({
      track: track ? {
        id: track.id,
        name: track.name,
        artist: track.artist,
        artists: track.artists,
        album: track.album,
        duration: track.duration,
        progress: track.progress,
        isPlaying: track.isPlaying,
        imageUrl: track.imageUrl,
        uri: track.uri,
        liked,
        shuffle: track.shuffle,
        repeat: track.repeat,
        volume: track.volume
      } : null,
      lyrics,
      mode: mode(),
      spotifyRunning: mode() === 'local' ? await local.isRunning() : true,
      needsReauth: spotifyClient.needsReauth(),
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'TRACK_ERROR'
    });
  }
});

// ============================================
// PLAYBACK CONTROL ENDPOINTS
// ============================================

router.post('/play', async (req, res) => {
  try {
    await playback().play();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'PLAY_ERROR'
    });
  }
});

router.post('/pause', async (req, res) => {
  try {
    await playback().pause();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'PAUSE_ERROR'
    });
  }
});

router.post('/next', async (req, res) => {
  try {
    await playback().next();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'NEXT_ERROR'
    });
  }
});

router.post('/prev', async (req, res) => {
  try {
    await playback().previous();
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'PREV_ERROR'
    });
  }
});

router.post('/seek', async (req, res) => {
  try {
    const { position } = req.query;
    if (position === undefined) {
      return res.status(400).json({
        error: 'Missing position parameter',
        code: 'INVALID_PARAM'
      });
    }
    await playback().seek(parseInt(position));
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'SEEK_ERROR'
    });
  }
});

router.post('/shuffle', async (req, res) => {
  try {
    const { state } = req.query;
    if (state === undefined) {
      return res.status(400).json({
        error: 'Missing state parameter',
        code: 'INVALID_PARAM'
      });
    }
    const shuffle = state === 'true' || state === '1';
    await playback().setShuffle(shuffle);
    res.json({ success: true, state: shuffle });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'SHUFFLE_ERROR'
    });
  }
});

router.post('/repeat', async (req, res) => {
  try {
    const { mode } = req.query;
    if (!mode) {
      return res.status(400).json({
        error: 'Missing mode parameter (off/track/context)',
        code: 'INVALID_PARAM'
      });
    }
    if (!['off', 'track', 'context'].includes(mode)) {
      return res.status(400).json({
        error: 'Invalid mode. Must be off, track, or context',
        code: 'INVALID_PARAM'
      });
    }
    await playback().setRepeat(mode);
    res.json({ success: true, mode });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'REPEAT_ERROR'
    });
  }
});

router.post('/volume', async (req, res) => {
  try {
    const { level } = req.query;
    if (level === undefined) {
      return res.status(400).json({
        error: 'Missing level parameter (0-100)',
        code: 'INVALID_PARAM'
      });
    }
    const volume = parseInt(level);
    if (volume < 0 || volume > 100) {
      return res.status(400).json({
        error: 'Volume must be between 0 and 100',
        code: 'INVALID_PARAM'
      });
    }
    await playback().setVolume(volume);
    res.json({ success: true, level: volume });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || 'VOLUME_ERROR'
    });
  }
});

// ============================================
// LIKE, PLAYLISTS, DEVICES, QUEUE
// ============================================

const TRACK_URI = /^spotify:(track|episode):[A-Za-z0-9]{10,30}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;

const bad = (res, message) => res.status(400).json({ error: message, code: 'INVALID_PARAM' });
const fail = (res, error, fallback) => res.status(error.status || 500).json({
  error: error.message, code: error.code || fallback
});

router.post('/like', async (req, res) => {
  try {
    const { uri, state } = req.query;
    if (!TRACK_URI.test(uri || '')) return bad(res, 'Invalid or missing track uri');
    if (state !== 'true' && state !== 'false') return bad(res, 'state must be true or false');
    res.json({ success: true, liked: await spotifyClient.setLiked(uri, state === 'true') });
  } catch (error) { fail(res, error, 'LIKE_ERROR'); }
});

router.get('/playlists', async (req, res) => {
  try {
    // ?all=1: everything in your library (to play); default: only ones you can add songs to
    const playlists = req.query.all === '1' ? await spotifyClient.getAllPlaylists() : await spotifyClient.getPlaylists();
    res.json({ playlists });
  } catch (error) { fail(res, error, 'PLAYLISTS_ERROR'); }
});

router.post('/playlists/add', async (req, res) => {
  try {
    const { playlist, uri } = req.query;
    if (!SPOTIFY_ID.test(playlist || '')) return bad(res, 'Invalid or missing playlist id');
    if (!TRACK_URI.test(uri || '')) return bad(res, 'Invalid or missing track uri');
    await spotifyClient.addToPlaylist(playlist, uri);
    res.json({ success: true });
  } catch (error) { fail(res, error, 'PLAYLIST_ADD_ERROR'); }
});

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 1 || q.length > 100) return bad(res, 'Search text must be 1-100 characters');
    const ALLOWED = ['track', 'artist', 'album', 'playlist', 'show', 'episode', 'audiobook'];
    const types = String(req.query.types || ALLOWED.join(',')).split(',');
    if (!types.length || !types.every(t => ALLOWED.includes(t))) return bad(res, `types must be from: ${ALLOWED.join(', ')}`);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 990) return bad(res, 'offset must be a whole number from 0 to 990');
    res.json(await spotifyClient.search(q, { types, offset }));          // { tracks, artists, albums, playlists, shows, episodes, audiobooks }
  } catch (error) { fail(res, error, 'SEARCH_ERROR'); }
});

router.post('/play-uri', async (req, res) => {
  try {
    const { uri } = req.query;
    if (!TRACK_URI.test(uri || '')) return bad(res, 'Invalid or missing track uri');
    await spotifyClient.playUris([uri]);
    res.json({ success: true });
  } catch (error) { fail(res, error, 'PLAY_ERROR'); }
});

router.post('/play-context', async (req, res) => {
  try {
    const { uri } = req.query;
    if (!/^spotify:(playlist|album|artist|show|audiobook):[A-Za-z0-9]{10,40}$/.test(uri || '')) return bad(res, 'Invalid or missing playlist/album/artist/show/audiobook uri');
    const kind = req.query.kind === undefined ? 'show' : req.query.kind;
    if (!['show', 'audiobook'].includes(kind)) return bad(res, 'kind must be show or audiobook');
    if (/^spotify:(show|audiobook):/.test(uri)) await spotifyClient.playShowOrBook(uri, kind);
    else await spotifyClient.playContext(uri);
    res.json({ success: true });
  } catch (error) { fail(res, error, 'PLAY_ERROR'); }
});

router.get('/devices', async (req, res) => {
  try {
    res.json({ devices: await spotifyClient.getDevices() });
  } catch (error) { fail(res, error, 'DEVICES_ERROR'); }
});

router.post('/devices/transfer', async (req, res) => {
  try {
    const { id } = req.query;
    if (!SPOTIFY_ID.test(id || '')) return bad(res, 'Invalid or missing device id');
    await spotifyClient.transferPlayback(id);
    res.json({ success: true });
  } catch (error) { fail(res, error, 'TRANSFER_ERROR'); }
});

router.post('/queue/skip-to', async (req, res) => {
  try {
    const count = Number(req.query.count);
    if (!Number.isInteger(count) || count < 1 || count > 25) return bad(res, 'count must be a whole number from 1 to 25');
    await spotifyClient.skipForward(count);
    res.json({ success: true, skipped: count });
  } catch (error) { fail(res, error, 'QUEUE_SKIP_ERROR'); }
});

router.get('/queue', async (req, res) => {
  try {
    res.json({ queue: await spotifyClient.getQueue() });
  } catch (error) { fail(res, error, 'QUEUE_ERROR'); }
});

module.exports = router;
