'use strict';
// Exercises SpotifyClient (like / playlists / devices / queue / scopes) and the routes
// against a mocked axios, so nothing touches a real Spotify account.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'azr-test-'));   // isolated; never the real data folder
process.env.SPOTIFY_CLIENT_ID = 'id'; process.env.SPOTIFY_CLIENT_SECRET = 'secret';
process.env.SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:3333/api/auth/callback';

const calls = [];
let handler = () => ({ status: 200, data: {} });
const fake = async (method, url, data) => {
  calls.push({ method, url, data });
  const r = handler(method, url, data);
  if (r.status >= 400) { const e = new Error('Request failed'); e.response = { status: r.status, data: r.data }; throw e; }
  return { status: r.status, data: r.data };
};
const axiosMock = {
  get: (u) => fake('GET', u), delete: (u) => fake('DELETE', u),
  put: (u, d) => fake('PUT', u, d), post: (u, d) => fake('POST', u, d),
};
const origLoad = Module._load;
Module._load = function (req, ...a) { return req === 'axios' ? axiosMock : origLoad.call(this, req, ...a); };

// Seed a stored login with every permission
const storage = require('../storage');
const ALL = 'user-read-playback-state user-library-read user-library-modify playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public';
storage.saveTokens({ accessToken: 'tok', refreshToken: 'ref', tokenExpiry: Date.now() + 3600e3, scope: ALL });
const spotify = require('../spotify');

const URI = 'spotify:track:4iV5W9uYEdYUVa79Axb7Rh';
const path_ = u => decodeURIComponent(u.replace('https://api.spotify.com/v1', ''));

test('getAuthUrl only forces Spotify\'s dialog when switching accounts', () => {
  const normal = new URL(spotify.getAuthUrl());
  const switching = new URL(spotify.getAuthUrl(true));
  assert.strictEqual(normal.searchParams.get('show_dialog'), null);
  assert.strictEqual(switching.searchParams.get('show_dialog'), 'true');
  assert.ok(switching.searchParams.get('scope').includes('user-library-modify'));
});

test('scopes: full login needs no reauth; old login does', () => {
  assert.strictEqual(spotify.needsReauth(), false);
  spotify.scope = 'user-read-playback-state';
  assert.strictEqual(spotify.needsReauth(), true);
  assert.strictEqual(spotify.canLike(), false);
  spotify.scope = ALL;
});

test('isLiked reads /me/library/contains with the URI and caches', async () => {
  calls.length = 0; handler = () => ({ status: 200, data: [true] });
  assert.strictEqual(await spotify.isLiked(URI), true);
  assert.strictEqual(await spotify.isLiked(URI), true);
  assert.strictEqual(calls.length, 1, 'second call should be cached');
  assert.strictEqual(path_(calls[0].url), `/me/library/contains?uris=${URI}`);
});

test('isLiked is null (not an error) without permission or on API failure', async () => {
  spotify.scope = 'user-read-playback-state';
  assert.strictEqual(await spotify.isLiked(URI), null);
  spotify.scope = ALL; spotify.likedCache.clear();
  handler = () => ({ status: 403, data: { error: { message: 'Insufficient client scope' } } });
  assert.strictEqual(await spotify.isLiked(URI), null);
});

test('setLiked uses PUT to like and DELETE to unlike, and updates the cache', async () => {
  calls.length = 0; handler = () => ({ status: 200, data: '' });
  await spotify.setLiked(URI, true);
  await spotify.setLiked(URI, false);
  assert.deepStrictEqual(calls.map(c => c.method), ['PUT', 'DELETE']);
  assert.ok(calls.every(c => path_(c.url) === `/me/library?uris=${URI}`));
  assert.strictEqual((await spotify.isLiked(URI)), false);
});

test('getPlaylists keeps owned + collaborative only, follows pages, caches', async () => {
  calls.length = 0; spotify.playlistCache = null; spotify.meId = null;
  handler = (m, url) => {
    const p = path_(url);
    if (p === '/me') return { status: 200, data: { id: 'me123' } };
    if (p.startsWith('/me/playlists?limit=50') && !p.includes('offset'))
      return { status: 200, data: { items: [
        { id: 'aaaaaaaaaaaa', name: 'Mine', owner: { id: 'me123' }, images: [] },
        { id: 'bbbbbbbbbbbb', name: 'Followed', owner: { id: 'other' }, collaborative: false },
        null,
      ], next: 'https://api.spotify.com/v1/me/playlists?limit=50&offset=50' } };
    return { status: 200, data: { items: [{ id: 'cccccccccccc', name: 'Shared', owner: { id: 'other' }, collaborative: true }], next: null } };
  };
  const list = await spotify.getPlaylists();
  assert.deepStrictEqual(list.map(p => p.name), ['Mine', 'Shared']);
  const before = calls.length;
  await spotify.getPlaylists();
  assert.strictEqual(calls.length, before, 'cached');
});

test('getAllPlaylists includes followed playlists, flagged by whether you can add to them', async () => {
  spotify.playlistCache = null; spotify.meId = 'me123';
  handler = () => ({ status: 200, data: { items: [
    { id: 'aaaaaaaaaaaa', name: 'Mine', owner: { id: 'me123' }, uri: 'spotify:playlist:aaaaaaaaaaaa' },
    { id: 'bbbbbbbbbbbb', name: 'Followed', owner: { id: 'other', display_name: 'Someone' }, collaborative: false },
    { id: 'cccccccccccc', name: 'Shared', owner: { id: 'other', display_name: 'Pal' }, collaborative: true },
  ], next: null } });
  const all = await spotify.getAllPlaylists();
  assert.deepStrictEqual(all.map(p => [p.name, p.writable, p.owner]), [['Mine', true, 'You'], ['Followed', false, 'Someone'], ['Shared', true, 'Pal']]);
  assert.strictEqual(all[1].uri, 'spotify:playlist:bbbbbbbbbbbb');      // uri is derived when Spotify omits it
  assert.deepStrictEqual((await spotify.getPlaylists()).map(p => p.name), ['Mine', 'Shared']);
});

test('search asks for songs, artists and albums together and maps each', async () => {
  calls.length = 0;
  handler = () => ({ status: 200, data: {
    tracks: { items: [
      { id: 't1', uri: 'spotify:track:t1', name: 'Song', artists: [{ name: 'Band' }], album: { name: 'LP', images: [{ url: 'big' }, { url: 'small' }] } },
      null,
      { id: 't2', uri: 'spotify:track:t2', name: 'Other', artists: [], album: {} },
    ] },
    artists: { items: [{ id: 'a1', uri: 'spotify:artist:a1', name: 'Band', images: [{ url: 'x' }, { url: 'y' }] }, null] },
    albums: { items: [{ id: 'l1', uri: 'spotify:album:l1', name: 'LP', artists: [{ name: 'Band' }], release_date: '2019-05-03', images: [] }] },
  } });
  const out = await spotify.search('hello world & more');
  const u = new URL(calls[0].url);
  assert.deepStrictEqual([u.pathname, u.searchParams.get('q'), u.searchParams.get('type'), u.searchParams.get('limit')], ['/v1/search', 'hello world & more', 'track,artist,album,playlist,show,episode,audiobook', '10']);
  assert.strictEqual(u.searchParams.get('include_external'), 'audio');
  assert.strictEqual(u.searchParams.get('offset'), '0');
  assert.deepStrictEqual(out.tracks, [
    { id: 't1', uri: 'spotify:track:t1', name: 'Song', artist: 'Band', album: 'LP', explicit: false, durationMs: null, imageUrl: 'small' },
    { id: 't2', uri: 'spotify:track:t2', name: 'Other', artist: '', album: '', explicit: false, durationMs: null, imageUrl: null },
  ]);
  assert.deepStrictEqual(out.artists, [{ id: 'a1', uri: 'spotify:artist:a1', name: 'Band', imageUrl: 'y' }]);
  assert.deepStrictEqual(out.albums, [{ id: 'l1', uri: 'spotify:album:l1', name: 'LP', artist: 'Band', year: '2019', imageUrl: null }]);
});

test('search maps playlists, podcasts, episodes and audiobooks', async () => {
  handler = () => ({ status: 200, data: {
    playlists: { items: [null, { id: 'p1', uri: 'spotify:playlist:p1', name: 'Mix', owner: { display_name: 'Pat' }, images: [{ url: 'a' }, { url: 'b' }] }] },
    shows: { items: [{ id: 'sh1', uri: 'spotify:show:sh1', name: 'The Pod', total_episodes: 120, images: [{ url: 'img' }] }] },
    episodes: { items: [
      { id: 'e1', uri: 'spotify:episode:e1', name: 'Ep One', release_date: '2026-03-03', duration_ms: 2700000, images: [{ url: 'x' }] },
      { id: 'e2', uri: 'spotify:episode:e2', name: 'Locked', release_date: '2026', is_playable: false, images: [] },
    ] },
    audiobooks: { items: [{ id: 'b1', uri: 'spotify:show:b1', name: 'The Book', authors: [{ name: 'Ann' }, { name: 'Bo' }], narrators: [{ name: 'Cy' }], images: [] }] },
  } });
  const out = await spotify.search('x');
  assert.deepStrictEqual(out.playlists, [{ id: 'p1', uri: 'spotify:playlist:p1', name: 'Mix', owner: 'Pat', imageUrl: 'b' }]);
  assert.deepStrictEqual(out.shows, [{ id: 'sh1', uri: 'spotify:show:sh1', name: 'The Pod', episodes: 120, publisher: '', imageUrl: 'img' }]);
  assert.deepStrictEqual(out.episodes.map(e => [e.name, e.durationMs, e.playable]), [['Ep One', 2700000, true], ['Locked', null, false]]);
  assert.deepStrictEqual(out.audiobooks, [{ id: 'b1', uri: 'spotify:show:b1', name: 'The Book', authors: ['Ann', 'Bo'], narrators: ['Cy'], imageUrl: null }]);
});

test('playing a podcast or audiobook: direct first, then newest episode / first chapter', async () => {
  const show = 'spotify:show:showid12345678';
  // 1) Spotify accepts the show as a context: no fallback
  calls.length = 0; handler = () => ({ status: 204, data: '' });
  await spotify.playShowOrBook(show);
  assert.deepStrictEqual(calls.map(c => c.method), ['PUT']);
  assert.deepStrictEqual(calls[0].data, { context_uri: show });

  // 2) Spotify refuses (400): play the newest episode instead
  calls.length = 0;
  handler = (m, url, body) => {
    const p = path_(url);
    if (m === 'PUT' && body?.context_uri) return { status: 400, data: { error: { message: 'Invalid context uri' } } };
    if (p === '/shows/showid12345678/episodes?limit=1') return { status: 200, data: { items: [{ uri: 'spotify:episode:newest' }] } };
    return { status: 204, data: '' };
  };
  await spotify.playShowOrBook(show, 'show');
  assert.deepStrictEqual(calls.filter(c => c.method === 'PUT').pop().data, { uris: ['spotify:episode:newest'] });

  // 3) audiobook uses the chapters list
  calls.length = 0;
  handler = (m, url, body) => {
    const p = path_(url);
    if (m === 'PUT' && body?.context_uri) return { status: 404, data: { error: { message: 'Resource not found' } } };
    if (p === '/audiobooks/showid12345678/chapters?limit=1') return { status: 200, data: { items: [{ uri: 'spotify:episode:chapter1' }] } };
    return { status: 204, data: '' };
  };
  await spotify.playShowOrBook(show, 'audiobook');
  assert.deepStrictEqual(calls.filter(c => c.method === 'PUT').pop().data, { uris: ['spotify:episode:chapter1'] });

  // 4) a 'no device' 404 is not a bad-context problem: no episode lookup, error is passed on
  calls.length = 0;
  handler = (m, url) => path_(url) === '/me/player/devices'
    ? { status: 200, data: { devices: [] } }
    : { status: 404, data: { error: { message: 'Player command failed: No active device found' } } };
  await assert.rejects(() => spotify.playShowOrBook(show), e => e.status === 404);
  assert.ok(!calls.some(c => /episodes/.test(c.url)));

  // 5) Premium / auth problems pass straight through
  handler = () => ({ status: 403, data: { error: { message: 'Premium required' } } });
  await assert.rejects(() => spotify.playShowOrBook(show), e => e.status === 403);
});

test('search can page: asks for one type at a given offset', async () => {
  calls.length = 0; handler = () => ({ status: 200, data: { tracks: { items: [] } } });
  await spotify.search('hello', { types: ['track'], offset: 20 });
  const u = new URL(calls[0].url);
  assert.deepStrictEqual([u.searchParams.get('type'), u.searchParams.get('offset'), u.searchParams.get('limit')], ['track', '20', '10']);
});

test('search copes with a response that is missing a whole category', async () => {
  handler = () => ({ status: 200, data: { tracks: { items: [] } } });
  assert.deepStrictEqual(await spotify.search('x'), { tracks: [], artists: [], albums: [], playlists: [], shows: [], episodes: [], audiobooks: [] });
});

test('play a song / play a playlist send the right bodies', async () => {
  calls.length = 0; handler = () => ({ status: 204, data: '' });
  await spotify.playUris(['spotify:track:t1']);
  await spotify.playContext('spotify:playlist:aaaaaaaaaaaa');
  assert.deepStrictEqual(calls.map(c => [c.method, path_(c.url), c.data]), [
    ['PUT', '/me/player/play', { uris: ['spotify:track:t1'] }],
    ['PUT', '/me/player/play', { context_uri: 'spotify:playlist:aaaaaaaaaaaa' }],
  ]);
});

test('playing with no active device retries on an available one; with none it reports the 404', async () => {
  calls.length = 0;
  handler = (m, url, body) => {
    const p = path_(url);
    if (p === '/me/player/devices') return { status: 200, data: { devices: [{ id: 'phone1', name: 'Phone', type: 'Smartphone' }, { id: 'mac1', name: 'Mac', type: 'Computer' }] } };
    if (p === '/me/player/play') return { status: 404, data: { error: { message: 'Player command failed: No active device found' } } };
    return { status: 204, data: '' };
  };
  await spotify.playUris(['spotify:track:t1']);
  const retry = calls.filter(c => c.method === 'PUT').pop();
  assert.strictEqual(path_(retry.url), '/me/player/play?device_id=mac1');             // prefers the computer
  assert.deepStrictEqual(retry.data, { uris: ['spotify:track:t1'] });

  handler = (m, url) => path_(url) === '/me/player/devices'
    ? { status: 200, data: { devices: [] } }
    : { status: 404, data: { error: { message: 'No active device found' } } };
  await assert.rejects(() => spotify.playUris(['spotify:track:t1']), e => e.status === 404);
});

test('skipForward calls next the requested number of times', async () => {
  calls.length = 0; handler = () => ({ status: 204, data: '' });
  await spotify.skipForward(3);
  assert.deepStrictEqual(calls.map(c => [c.method, path_(c.url)]), Array(3).fill(['POST', '/me/player/next']));
});

test('addToPlaylist POSTs to /playlists/{id}/items with a uris body', async () => {
  calls.length = 0; handler = () => ({ status: 201, data: { snapshot_id: 'x' } });
  await spotify.addToPlaylist('aaaaaaaaaaaa', URI);
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(path_(calls[0].url), '/playlists/aaaaaaaaaaaa/items');
  assert.deepStrictEqual(calls[0].data, { uris: [URI] });
});

test('devices, transfer and queue map Spotify shapes', async () => {
  handler = (m, url) => {
    const p = path_(url);
    if (p === '/me/player/devices') return { status: 200, data: { devices: [{ id: 'd1', name: 'Mac', type: 'Computer', is_active: true, volume_percent: 40 }] } };
    if (p === '/me/player/queue') return { status: 200, data: { queue: [{ id: 't1', name: 'Song', artists: [{ name: 'Band' }] }] } };
    return { status: 204, data: '' };
  };
  assert.deepStrictEqual(await spotify.getDevices(), [{ id: 'd1', name: 'Mac', type: 'Computer', isActive: true, volume: 40 }]);
  assert.deepStrictEqual(await spotify.getQueue(), [{ id: 't1', name: 'Song', artist: 'Band' }]);
  calls.length = 0; await spotify.transferPlayback('d1');
  assert.deepStrictEqual(calls[0].data, { device_ids: ['d1'], play: true });
});

test('addToQueue POSTs the uri; with no active device it retries on an available one', async () => {
  calls.length = 0;
  handler = () => ({ status: 204, data: '' });
  await spotify.addToQueue(URI);
  assert.deepStrictEqual([calls[0].method, path_(calls[0].url)], ['POST', `/me/player/queue?uri=${URI}`]);

  calls.length = 0;
  handler = (m, url) => {
    const p = path_(url);
    if (p === '/me/player/devices') return { status: 200, data: { devices: [{ id: 'd1', name: 'Mac', type: 'Computer' }] } };
    return p.includes('device_id') ? { status: 204, data: '' } : { status: 404, data: { error: { message: 'No active device' } } };
  };
  await spotify.addToQueue(URI);
  assert.strictEqual(path_(calls.at(-1).url), `/me/player/queue?uri=${URI}&device_id=d1`);

  handler = () => ({ status: 404, data: { error: { message: 'none' } } });
  await assert.rejects(spotify.addToQueue(URI), e => e.status === 404);          // no device anywhere
});

test('getTrack maps a song for the request rules', async () => {
  handler = () => ({ status: 200, data: { id: 'abc', uri: 'spotify:track:abc', name: 'S', artists: [{ name: 'B' }], explicit: true, duration_ms: 123000 } });
  assert.deepStrictEqual(await spotify.getTrack('abc'), { id: 'abc', uri: 'spotify:track:abc', name: 'S', artist: 'B', explicit: true, durationMs: 123000 });
});

test('403 about scope becomes INSUFFICIENT_SCOPE', async () => {
  handler = () => ({ status: 403, data: { error: { message: 'Insufficient client scope' } } });
  await assert.rejects(() => spotify.setLiked(URI, true), e => e.code === 'INSUFFICIENT_SCOPE' && e.status === 403);
});

test('routes validate input before calling Spotify', async () => {
  const express = require('express');
  const app = express(); app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  calls.length = 0;
  const post = async p => (await fetch(base + p, { method: 'POST' })).status;
  assert.strictEqual(await post('/like?uri=spotify:track:x&state=true'), 400);            // bad uri
  assert.strictEqual(await post(`/like?uri=${URI}&state=maybe`), 400);                    // bad state
  assert.strictEqual(await post(`/playlists/add?playlist=../../me&uri=${URI}`), 400);     // bad playlist id
  assert.strictEqual(await post('/devices/transfer?id=x'), 400);                          // bad device id
  assert.strictEqual(await post('/play-uri?uri=spotify:album:aaaaaaaaaaaa'), 400);       // not a song
  assert.strictEqual(await post('/play-context?uri=spotify:track:aaaaaaaaaaaa'), 400);    // not a playlist/album/artist
  assert.strictEqual(await post('/queue/add?uri=spotify:album:aaaaaaaaaaaa'), 400);     // only songs go in the queue
  assert.strictEqual(await post('/queue/add'), 400);
  assert.strictEqual((await fetch(base + '/track?id=../me')).status, 400);                // bad track id
  assert.strictEqual(await post('/queue/skip-to?count=0'), 400);                          // can't skip zero
  assert.strictEqual(await post('/queue/skip-to?count=26'), 400);                         // or an absurd amount
  assert.strictEqual(await post('/queue/skip-to?count=abc'), 400);
  assert.strictEqual((await fetch(base + '/search?q=')).status, 400);                     // empty search
  assert.strictEqual((await fetch(base + '/search?q=' + 'x'.repeat(101))).status, 400);   // absurdly long
  assert.strictEqual((await fetch(base + '/search?q=a&types=podcast')).status, 400);      // unsupported type
  assert.strictEqual((await post('/play-context?uri=spotify:show:showid12345678&kind=song')), 400);   // bad kind
  assert.strictEqual((await fetch(base + '/search?q=a&offset=-1')).status, 400);           // bad offset
  assert.strictEqual((await fetch(base + '/search?q=a&offset=5000')).status, 400);
  assert.strictEqual((await fetch(base + '/search?q=a&offset=abc')).status, 400);
  assert.strictEqual(calls.length, 0, 'nothing should have reached Spotify');
  handler = () => ({ status: 200, data: '' });
  assert.strictEqual(await post(`/like?uri=${URI}&state=true`), 200);
  server.close();
});
