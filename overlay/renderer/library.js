'use strict';
const $ = id => document.getElementById(id);
const api = window.libraryApi;

let tab = 'search';              // 'search' | 'playlists'
let rows = [];                   // [{ el, activate }] for keyboard navigation
let selected = -1;
let searchSeq = 0;               // ignore answers to searches that are no longer the latest
let playlists = null;            // loaded once per opening
let debounce = null;

const HINTS = {
  search: 'Enter plays the highlighted result · ↑ ↓ to choose · Tab switches · Esc closes',
  playlists: 'Click a playlist to play it · Tab switches · Esc closes',
};

function explain(r) {
  if (r.status === 0) return 'Could not reach the app. Is it still running?';
  const code = r.data?.code;
  if (code === 'NEEDS_SPOTIFY_LOGIN') return 'Search and playlists need a connected Spotify account. Open Settings and choose Connect.';
  if (r.status === 401) return 'Not logged in to Spotify. Use the menu bar icon.';
  if (code === 'INSUFFICIENT_SCOPE') return 'Spotify needs more permission: open Settings and choose Grant permissions.';
  if (r.status === 403) return 'Spotify Premium is required to play music from here.';
  if (r.status === 404) return 'No Spotify device found. Open Spotify on a device, then try again.';
  if (r.status === 429) return 'Spotify is busy. Try again in a moment.';
  return r.data?.error ? `Spotify: ${r.data.error}` : `Spotify error (${r.status})`;
}

let msgTimer;
function say(text, ok = false) {
  const m = $('msg');
  m.textContent = text;
  m.classList.toggle('ok', ok);
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { m.textContent = ''; }, 5000);
}

function select(i) {
  selected = rows.length ? Math.max(0, Math.min(rows.length - 1, i)) : -1;
  rows.forEach((r, n) => r.el.classList.toggle('sel', n === selected));
  rows[selected]?.el.scrollIntoView({ block: 'nearest' });
}

function empty(text, isErr = false) {
  const d = document.createElement('div');
  d.className = 'empty' + (isErr ? ' err' : '');
  d.textContent = text;
  $('list').replaceChildren(d);
  rows = []; selected = -1;
}

function makeRow({ title, sub, imageUrl, activate, round = false }) {
  const el = document.createElement('div');
  el.className = 'row';
  const art = document.createElement('div'); art.className = 'art' + (round ? ' round' : '');
  if (imageUrl) art.style.backgroundImage = `url("${imageUrl}")`;
  const text = document.createElement('div'); text.className = 'text';
  const t = document.createElement('div'); t.className = 'title'; t.textContent = title;
  const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub || '';
  text.append(t, s);
  const play = document.createElement('span'); play.className = 'play'; play.textContent = '▶ Play';
  el.append(art, text, play);
  el.addEventListener('click', activate);
  return { el, activate };
}

// items: rows, optionally preceded by { header: 'Songs' } section titles (which can't be selected)
function show(items) {
  const nodes = items.map(it => {
    if (!it.header) return it.el;
    const d = document.createElement('div');
    d.className = 'section';
    d.textContent = it.header;
    return d;
  });
  $('list').replaceChildren(...nodes);
  rows = items.filter(it => !it.header);
  select(rows.length ? 0 : -1);
}

// ---- actions --------------------------------------------------------------
async function playTrack(uri, name) {
  say(`Starting ${name}...`, true);
  const r = await api.playTrack(uri);
  if (!r.ok) say(explain(r));                       // on success the main process closes this window
}

// A playlist, album, artist, podcast or audiobook (anything Spotify can start as a "context")
async function playContext(uri, name, kind) {
  say(`Starting ${name}...`, true);
  const r = await api.playPlaylist(uri, kind);
  if (!r.ok) say(explain(r));
}

// ---- search tab ---------------------------------------------------------------
// Spotify returns at most 10 per type per request. The "All" view shows a few of each type; picking a
// type chip shows only that type. Either way, "Show more" reveals what is already fetched and then
// fetches the next 10 (offset paging).
const SECTIONS = [
  { type: 'track',     key: 'tracks',     title: 'Songs',      noun: 'songs',      show: 10 },
  { type: 'artist',    key: 'artists',    title: 'Artists',    noun: 'artists',    show: 4 },
  { type: 'album',     key: 'albums',     title: 'Albums',     noun: 'albums',     show: 5 },
  { type: 'playlist',  key: 'playlists',  title: 'Playlists',  noun: 'playlists',  show: 3 },
  { type: 'show',      key: 'shows',      title: 'Podcasts',   noun: 'podcasts',   show: 3 },
  { type: 'episode',   key: 'episodes',   title: 'Episodes',   noun: 'episodes',   show: 3 },
  { type: 'audiobook', key: 'audiobooks', title: 'Audiobooks', noun: 'audiobooks', show: 3 },
];
const PAGE = 10;
let results = null;              // { query, <type>: { items, shown, done } }
let view = 'all';                // 'all' or one type

const shownFor = (sec, st) => (view === 'all' ? st.shown : st.items.length);

function makeMoreRow(label, activate) {
  const el = document.createElement('div');
  el.className = 'row more';
  el.textContent = label;
  el.addEventListener('click', activate);
  return { el, activate };
}

function minutes(ms) {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`;
}

function niceDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return d || '';
  return new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function resultRow(type, it) {
  const base = { title: it.name, imageUrl: it.imageUrl };
  switch (type) {
    case 'track':
      return makeRow({ ...base, sub: [it.artist, it.album].filter(Boolean).join(' · '), activate: () => playTrack(it.uri, it.name) });
    case 'artist':
      return makeRow({ ...base, sub: 'Artist · plays their music', round: true, activate: () => playContext(it.uri, it.name) });
    case 'album':
      return makeRow({ ...base, sub: ['Album', it.artist, it.year].filter(Boolean).join(' · '), activate: () => playContext(it.uri, it.name) });
    case 'playlist':
      return makeRow({ ...base, sub: it.owner ? `Playlist · by ${it.owner}` : 'Playlist', activate: () => playContext(it.uri, it.name) });
    case 'show':
      return makeRow({ ...base, sub: ['Podcast', it.episodes ? `${it.episodes} episodes` : '', it.publisher].filter(Boolean).join(' · '), activate: () => playContext(it.uri, it.name, 'show') });
    case 'episode':
      return makeRow({ ...base,
        sub: it.playable ? ['Episode', niceDate(it.releaseDate), minutes(it.durationMs)].filter(Boolean).join(' · ') : 'Episode · not available to play',
        activate: () => (it.playable ? playTrack(it.uri, it.name) : say('That episode is not available to play.')) });
    default:   // audiobook
      return makeRow({ ...base,
        sub: ['Audiobook', it.authors?.length ? `by ${it.authors.join(', ')}` : '', it.narrators?.length ? `read by ${it.narrators.join(', ')}` : ''].filter(Boolean).join(' · '),
        activate: () => playContext(it.uri, it.name, 'audiobook') });
  }
}

function renderResults(keepSelection = -1) {
  const items = [];
  for (const sec of SECTIONS) {
    if (view !== 'all' && sec.type !== view) continue;
    const st = results[sec.type];
    if (!st.items.length) continue;
    const shown = shownFor(sec, st);
    if (view === 'all') items.push({ header: sec.title });
    items.push(...st.items.slice(0, shown).map(it => resultRow(sec.type, it)));
    if (st.items.length > shown || !st.done) items.push(makeMoreRow(`Show more ${sec.noun}`, () => showMore(sec)));
  }
  if (!items.length) {
    const sec = SECTIONS.find(x => x.type === view);
    return empty(view === 'audiobook'
      ? 'No audiobooks found. Audiobooks are only available in the US, UK, Canada, Ireland, New Zealand and Australia.'
      : `No ${sec ? sec.noun : 'results'} found for "${results.query}".`);
  }
  show(items);
  if (keepSelection >= 0) select(keepSelection);
}

async function showMore(sec) {
  const st = results[sec.type];
  const at = selected;
  if (st.items.length > shownFor(sec, st)) {              // already fetched, just reveal
    st.shown = Math.min(st.items.length, st.shown + PAGE);
    return renderResults(at);
  }
  say(`Loading more ${sec.noun}...`, true);
  const mine = searchSeq;
  const r = await api.search(results.query, sec.type, st.items.length);
  if (mine !== searchSeq || tab !== 'search') return;
  say('');
  if (!r.ok) return say(explain(r));
  const more = r.data[sec.key] || [];
  st.items.push(...more);
  st.shown = st.items.length;
  if (more.length < PAGE) st.done = true;                 // fewer than a full page: nothing further
  renderResults(at);
  if (!more.length) say(`No more ${sec.noun} found.`);
}

async function runSearch() {
  const q = $('q').value.trim();
  const mine = ++searchSeq;
  if (q.length < 2) return empty('Type at least two letters to search.');
  empty('Searching...');
  const r = await api.search(q);
  if (mine !== searchSeq || tab !== 'search') return;
  if (!r.ok) return empty(explain(r), true);

  results = { query: q };
  for (const sec of SECTIONS) {
    const items = r.data[sec.key] || [];
    results[sec.type] = { items, shown: Math.min(items.length, sec.show), done: items.length < PAGE };
  }
  if (SECTIONS.every(sec => !results[sec.type].items.length)) return empty(`Nothing found for "${q}".`);
  renderResults();
}

function setView(next) {
  view = next;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.view === view));
  if (results && tab === 'search') renderResults();
  $('q').focus();
}
document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => setView(c.dataset.view)));

// ---- playlists tab -----------------------------------------------------------------
async function loadPlaylists() {
  if (!playlists) {
    empty('Loading your playlists...');
    const r = await api.playlists();
    if (tab !== 'playlists') return;
    if (!r.ok) return empty(explain(r), true);
    playlists = r.data.playlists || [];
  }
  renderPlaylists();
}

function renderPlaylists() {
  const f = $('q').value.trim().toLowerCase();
  const list = (playlists || []).filter(p => !f || p.name.toLowerCase().includes(f));
  if (!list.length) return empty(playlists?.length ? `No playlists match "${$('q').value.trim()}".` : 'You have no playlists yet.');
  show(list.map(p => makeRow({
    title: p.name,
    sub: p.owner === 'You' ? 'Made by you' : (p.owner ? `By ${p.owner}` : 'Playlist'),
    imageUrl: p.imageUrl,
    activate: () => playContext(p.uri, p.name),
  })));
}

// ---- tabs -----------------------------------------------------------------------------
function setTab(next, { keepText = false } = {}) {
  tab = next;
  $('tabSearch').classList.toggle('on', tab === 'search');
  $('tabPlaylists').classList.toggle('on', tab === 'playlists');
  $('q').placeholder = tab === 'search' ? 'Search songs, podcasts, audiobooks and more' : 'Filter your playlists';
  document.body.classList.toggle('playlists-tab', tab === 'playlists');
  $('hint').textContent = HINTS[tab];
  if (!keepText) $('q').value = '';
  say('');
  if (tab === 'search') { searchSeq++; $('q').value ? runSearch() : empty('Search for a song, artist, album, podcast, audiobook or playlist, then press Enter to play the top result.'); }
  else loadPlaylists();
  $('q').focus();
}

$('tabSearch').addEventListener('click', () => setTab('search'));
$('tabPlaylists').addEventListener('click', () => setTab('playlists'));
$('closeBtn').addEventListener('click', () => api.close());

$('q').addEventListener('input', () => {
  if (tab === 'playlists') return renderPlaylists();
  clearTimeout(debounce);
  debounce = setTimeout(runSearch, 280);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  else if (e.key === 'Tab') { e.preventDefault(); setTab(tab === 'search' ? 'playlists' : 'search'); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (tab === 'search') { clearTimeout(debounce); if (!rows.length && $('q').value.trim().length >= 2) return runSearch(); }
    rows[selected]?.activate();
  }
});

// Fresh start every time the window is opened
function reset() {
  playlists = null;
  results = null;
  view = 'all';
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.view === 'all'));
  setTab('search');
}
api.onShow(reset);
reset();
