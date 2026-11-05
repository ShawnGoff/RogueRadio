'use strict';
const $ = id => document.getElementById(id);

// ---- state -----------------------------------------------------------------
// Last server state plus local "optimistic" values. After a click we hold the
// local value briefly so the UI doesn't flicker back before Spotify catches up.
let current = null;                 // { track, lyrics, receivedAt, needsReauth }
let drawer = null;                  // null | 'lyrics' | 'playlists' | 'queue' | 'devices'
let cfg = { autoHide: false, autoHideSeconds: 6 };
let locked = true;                  // position lock (Shift+drag still moves a locked window)
let renderedKey = '';               // avoids rebuilding the lyrics DOM when nothing changed
let userScrollUntil = 0;            // pause plain-lyrics auto-scroll after the user scrolls

const local = { isPlaying: false, shuffle: false, repeat: 'off', volume: 50, liked: null };
const holdUntil = { isPlaying: 0, shuffle: 0, repeat: 0, volume: 0, progress: 0, liked: 0 };
const HOLD_MS = 2500;
const BREAK_AFTER_MS = 10000;       // a lyric line on screen this long with nothing soon after = instrumental
const BREAK_GAP_MS = 16000;
const REPEAT_ORDER = ['off', 'context', 'track'];       // click cycle
const REPEAT_VALUE = { off: 0, track: 1, context: 2 };  // wire values (see commands.js)

const held = key => Date.now() < holdUntil[key];
const hold = key => { holdUntil[key] = Date.now() + HOLD_MS; };

const fmt = ms => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---- auto-hide ---------------------------------------------------------------
let hovering = false;
let dragging = false;
let hideTimer = null;

function wake() {
  document.body.classList.remove('faded');
  clearTimeout(hideTimer);
  if (!cfg.autoHide || hovering || dragging || drawer || document.body.classList.contains('move')) return;
  hideTimer = setTimeout(() => document.body.classList.add('faded'), cfg.autoHideSeconds * 1000);
}

// ---- messages ----------------------------------------------------------------
let toastTimer;
function toast(text, ok = false) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  wake();
}

// Turn a { ok, status, data } result into something a person can act on.
function explain(r) {
  if (r.status === 0) return 'Companion app not reachable';
  const code = r.data?.code;
  if (code === 'NEEDS_SPOTIFY_LOGIN') return 'Connect your Spotify account in Settings to use this.';
  if (code === 'SPOTIFY_NOT_RUNNING') return 'Open the Spotify app first.';
  if (code === 'LOCAL_PERMISSION') return 'Allow this app to control Spotify: System Settings → Privacy & Security → Automation.';
  if (code === 'INSUFFICIENT_SCOPE' || current?.needsReauth) return 'Log in again to enable this: menu bar ♪ → Log in to Spotify';
  if (r.status === 401) return 'Not logged in to Spotify - use the menu bar icon';
  if (r.status === 403) return r.data?.error ? `Spotify: ${r.data.error}` : 'Spotify refused this (Premium may be required)';
  if (r.status === 404) return 'No active Spotify device - start playing in Spotify';
  if (r.status === 429) return 'Spotify is busy - try again in a moment';
  return `Spotify error (${r.status})`;
}

async function send(name, value) {
  wake();
  const r = await window.radio.command(name, value);
  if (!r.ok) toast(explain(r));
  return r.ok;
}

// ---- progress and display ----------------------------------------------------
function progressNow() {
  if (!current?.track) return [0, 0];
  const { duration = 0, progress = 0 } = current.track;
  let p = progress + (local.isPlaying ? Date.now() - current.receivedAt : 0);
  if (duration > 0) p = Math.min(p, duration);
  return [p, duration];
}

function tickProgress() {
  const [p, d] = progressNow();
  $('fill').style.width = d > 0 ? `${(p / d) * 100}%` : '0%';
  $('time').textContent = `${fmt(p)} / ${fmt(d)}`;
  if (drawer === 'lyrics') { renderLyrics(p); autoScrollPlain(p, d); }
}

function renderControls() {
  $('play').innerHTML = local.isPlaying ? '&#9208;' : '&#9654;';
  $('shuffle').classList.toggle('on', local.shuffle);
  $('repeat').classList.toggle('on', local.repeat !== 'off');
  $('repeat').innerHTML = local.repeat === 'track' ? '&#8635;1' : '&#8635;';
  if (!dragVol) $('vol').value = local.volume;

  const like = $('like');
  like.classList.toggle('liked', local.liked === true);
  like.classList.toggle('unknown', local.liked === null);
}

// ---- lyrics -------------------------------------------------------------------
// Index of the last synced line whose time has passed (-1 before the first line).
function currentLine(synced, ms) {
  let lo = 0, hi = synced.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (synced[mid].time <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

function setLines(el, lines) {
  el.replaceChildren(...lines.map(([text, cls]) => {
    const d = document.createElement('div');
    d.textContent = text || ' ';
    if (cls) d.className = cls;
    return d;
  }));
}

function renderLyrics(progressMs) {
  const el = $('lyrics');
  const lyrics = current?.lyrics;

  if (!current?.track) {
    if (renderedKey !== 'none') { renderedKey = 'none'; el.className = ''; setLines(el, [['Nothing playing', 'cur']]); $('hint').textContent = ''; }
    return;
  }
  if (lyrics?.synced) {
    const synced = lyrics.synced;
    const i = currentLine(synced, progressMs);
    // Instrumental break: a blank marker line, or a line that has been on screen a
    // long time with nothing following soon (or nothing following at all).
    const text = i >= 0 ? synced[i].text : '';
    const next = synced[i + 1];
    const elapsed = i >= 0 ? progressMs - synced[i].time : 0;
    const gap = next ? next.time - synced[Math.max(i, 0)].time : Infinity;
    const isBreak = i >= 0 && (!text || (elapsed > BREAK_AFTER_MS && gap > BREAK_GAP_MS));
    const key = `${current.track.id}:s:${i}:${isBreak ? 'b' : ''}`;
    if (key === renderedKey) return;
    renderedKey = key;
    $('hint').textContent = '';
    const line = j => synced[j]?.text || '';
    el.className = '';
    if (isBreak) {
      // Context = nearest real lyrics either side (skip blank marker lines)
      let a = i; while (a >= 0 && !synced[a].text) a--;
      let b = i + 1; while (b < synced.length && !synced[b].text) b++;
      setLines(el, [[line(a), 'near'], ['♪  ♪  ♪', 'cur'], [line(b), 'near']]);
    } else {
      setLines(el, [[line(i - 1), 'near'], [line(i), 'cur'], [line(i + 1), 'near']]);
    }
    return;
  }

  const kind = lyrics?.loading ? 'loading' : lyrics?.instrumental ? 'instr' : lyrics?.plain ? 'plain' : 'none';
  const key = `${current.track.id}:${kind}`;
  if (key === renderedKey) return;
  renderedKey = key;
  $('hint').textContent = kind === 'plain' ? 'Not timed - scrolling approximately' : '';
  if (kind === 'plain') { el.className = 'plain'; el.textContent = lyrics.plain; el.scrollTop = 0; return; }
  el.className = '';
  setLines(el, [[{ loading: 'Searching for lyrics...', instr: 'Instrumental', none: 'No lyrics found' }[kind], 'cur']]);
}

// Lyrics without timestamps can't sync, so follow the song's progress roughly
// (skipping a little intro/outro). Scrolling by hand pauses this for a while.
function autoScrollPlain(p, d) {
  const el = $('lyrics');
  if (!el.classList.contains('plain') || Date.now() < userScrollUntil || d <= 0) return;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  const f = Math.max(0, Math.min(1, (p - 0.06 * d) / (0.86 * d)));
  el.scrollTop = f * max;
}
$('lyrics').addEventListener('wheel', () => { userScrollUntil = Date.now() + 10000; }, { passive: true });

// ---- panels (playlists / queue / devices) --------------------------------------
let queueTimer = null;

function showList(rows, emptyText) {
  const list = $('list');
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = emptyText;
    list.replaceChildren(d);
    return;
  }
  list.replaceChildren(...rows);
}

function makeRow(name, sub, { onClick, active = false } = {}) {
  const row = document.createElement('div');
  row.className = 'row' + (onClick ? ' click' : '') + (active ? ' active' : '');
  const n = document.createElement('span'); n.className = 'name'; n.textContent = name;
  const s = document.createElement('span'); s.className = 'sub'; s.textContent = sub || '';
  row.append(n, s);
  if (onClick) row.addEventListener('click', () => onClick(row, s));
  return row;
}

async function loadPlaylists() {
  showList([], 'Loading playlists...');
  const r = await window.radio.playlists();
  if (drawer !== 'playlists') return;
  if (!r.ok) return showList([], explain(r));
  showList((r.data.playlists || []).map(p => makeRow(p.name, p.collaborative ? 'collab' : '', {
    onClick: async (row, sub) => {
      if (!current?.track) return toast('Nothing is playing');
      const res = await window.radio.addToPlaylist(p.id);
      if (res.ok) { row.classList.add('done'); sub.textContent = '✓ added'; toast(`Added to ${p.name}`, true); }
      else toast(explain(res));
    },
  })), 'No playlists you can add to');
}

async function loadQueue() {
  const r = await window.radio.queue();
  if (drawer !== 'queue') return;
  if (!r.ok) return showList([], explain(r));
  showList((r.data.queue || []).map((t, i) => makeRow(t.name, t.requestedBy ? `${t.artist} · ${t.requestedBy}` : t.artist, {
    onClick: async () => {
      toast(`Skipping to ${t.name}...`, true);
      const res = await window.radio.skipToQueue(i + 1);          // queue[0] is the next song, so it is 1 skip away
      if (!res.ok) return toast(explain(res));
      setTimeout(loadQueue, 1500);                                 // the queue has moved on
    },
  })), 'Nothing queued');
}

async function loadDevices() {
  const r = await window.radio.devices();
  if (drawer !== 'devices') return;
  if (!r.ok) return showList([], explain(r));
  showList((r.data.devices || []).map(d => makeRow(d.name, d.isActive ? '● playing here' : d.type, {
    active: d.isActive,
    onClick: async () => {
      const res = await window.radio.transfer(d.id);
      if (res.ok) { toast(`Playing on ${d.name}`, true); setTimeout(loadDevices, 1200); } else toast(explain(res));
    },
  })), 'No devices found - open Spotify on a device');
}

const HINTS = {
  playlists: 'Click a playlist to add this song',
  queue: 'Click a song to skip to it',
  devices: 'Click a device to play there',
  lyrics: '',
};
const DRAWER_BUTTONS = { lyrics: 'lyricsBtn', playlists: 'addBtn', queue: 'queueBtn', devices: 'devBtn' };

function setDrawerUI(mode) {
  drawer = mode || null;
  document.body.dataset.drawer = drawer || '';
  document.body.classList.toggle('drawer-open', !!drawer);
  for (const [m, id] of Object.entries(DRAWER_BUTTONS)) $(id).classList.toggle('on', m === drawer);

  clearInterval(queueTimer);
  renderedKey = '';
  $('credit').style.visibility = drawer === 'lyrics' ? 'visible' : 'hidden';
  $('hint').textContent = HINTS[drawer] || '';

  if (drawer === 'playlists') loadPlaylists();
  if (drawer === 'queue') { loadQueue(); queueTimer = setInterval(loadQueue, 5000); }
  if (drawer === 'devices') loadDevices();
  wake();
  tickProgress();
}

// ---- server state -> UI -------------------------------------------------------
function render(state) {
  document.body.classList.toggle('offline', state.status === 'offline' || state.status === 'error');
  document.body.classList.toggle('auth', state.status === 'auth' || state.status === 'permission');
  if (!$('msg').classList.contains('show')) {
    $('msg').textContent = {
      offline: 'Companion app offline',
      error:   state.message ? `Error: ${String(state.message).slice(0, 110)}` : 'Companion app error',
      auth:    'Not logged in to Spotify - use the menu bar icon',
      permission: 'Allow this app to control Spotify: System Settings → Privacy & Security → Automation',
    }[state.status] || '';
  }
  if (state.status !== 'ok') return;

  const { track, lyrics, needsReauth, mode, spotifyRunning } = state.data;
  const prev = current?.track;
  current = { track, lyrics, needsReauth, mode, receivedAt: state.receivedAt };
  document.body.classList.toggle('local', mode === 'local');      // no account connected: some buttons need one
  const spotifyClosed = mode === 'local' && spotifyRunning === false;
  $('name').textContent = track?.name || (spotifyClosed ? 'Spotify is not running' : 'Nothing playing');
  const requester = state.data.requestedBy;                     // a Twitch viewer asked for this song
  $('artist').textContent = track ? track.artist + (requester ? ` · requested by ${requester}` : '')
    : (spotifyClosed ? 'Open the Spotify app to get started' : '');
  $('art').style.backgroundImage = track?.imageUrl ? `url("${track.imageUrl}")` : 'none';

  if (track) {
    if (!held('isPlaying')) local.isPlaying = !!track.isPlaying;
    if (!held('shuffle'))   local.shuffle = !!track.shuffle;
    if (!held('repeat'))    local.repeat = track.repeat || 'off';
    if (!held('volume') && track.volume != null) local.volume = track.volume;
    if (!held('liked'))     local.liked = track.liked ?? null;
    if (held('progress')) { current.track.progress = local.seekTo; current.receivedAt = local.seekAt; }
  }
  if (track?.id !== prev?.id || !!track?.isPlaying !== !!prev?.isPlaying) wake();   // track change = brief reappearance
  renderControls();
  tickProgress();
}

// ---- controls --------------------------------------------------------------
$('play').addEventListener('click', async () => {
  const wantPlay = !local.isPlaying;
  local.isPlaying = wantPlay; hold('isPlaying'); renderControls();
  if (current?.track) { current.track.progress = progressNow()[0]; current.receivedAt = Date.now(); }
  if (!await send(wantPlay ? 'play' : 'pause')) { local.isPlaying = !wantPlay; renderControls(); }
});
$('next').addEventListener('click', () => send('next'));
$('prev').addEventListener('click', () => send('prev'));

$('shuffle').addEventListener('click', async () => {
  const on = !local.shuffle;
  local.shuffle = on; hold('shuffle'); renderControls();
  if (!await send('shuffle', on ? 1 : 0)) { local.shuffle = !on; renderControls(); }
});

$('repeat').addEventListener('click', async () => {
  const prev = local.repeat;
  const next = REPEAT_ORDER[(REPEAT_ORDER.indexOf(prev) + 1) % REPEAT_ORDER.length];
  local.repeat = next; hold('repeat'); renderControls();
  if (!await send('repeat', REPEAT_VALUE[next])) { local.repeat = prev; renderControls(); }
});

$('like').addEventListener('click', async () => {
  if (!current?.track) return toast('Nothing is playing');
  const on = local.liked !== true;
  const before = local.liked;
  local.liked = on; hold('liked'); renderControls(); wake();
  const r = await window.radio.like(on);
  if (!r.ok) { local.liked = before; holdUntil.liked = 0; renderControls(); toast(explain(r)); }
  else toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs', true);
});

$('addBtn').addEventListener('click', () => window.radio.toggleDrawer('playlists'));
$('lyricsBtn').addEventListener('click', () => window.radio.toggleDrawer('lyrics'));
$('queueBtn').addEventListener('click', () => window.radio.toggleDrawer('queue'));
$('devBtn').addEventListener('click', () => window.radio.toggleDrawer('devices'));
$('libBtn').addEventListener('click', () => window.radio.openLibrary());
$('miniBtn').addEventListener('click', () => window.radio.toggleMini());
$('expandBtn').addEventListener('click', () => window.radio.toggleMini());
// In mini mode the controls are hidden, so double-clicking anywhere also expands
document.addEventListener('dblclick', () => { if (document.body.classList.contains('mini')) window.radio.toggleMini(); });
$('gearBtn').addEventListener('click', () => window.radio.openSettings());

$('barWrap').addEventListener('click', e => {
  const [, duration] = progressNow();
  if (duration <= 0) return;
  const rect = $('bar').getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const pos = Math.round(frac * duration);
  local.seekTo = pos; local.seekAt = Date.now(); hold('progress');
  current.track.progress = pos; current.receivedAt = local.seekAt;
  tickProgress();
  send('seek', pos);
});

// Volume: send while dragging (rate-limited) and once more on release.
let dragVol = false;
let lastVolSend = 0;
$('vol').addEventListener('pointerdown', () => { dragVol = true; });
window.addEventListener('pointerup', () => { dragVol = false; });
$('vol').addEventListener('input', e => {
  local.volume = Number(e.target.value); hold('volume');
  if (Date.now() - lastVolSend > 150) { lastVolSend = Date.now(); send('volume', local.volume); }
});
$('vol').addEventListener('change', e => send('volume', Number(e.target.value)));

// ---- tooltips ---------------------------------------------------------------------
// Custom (native `title` tooltips don't reliably appear on a non-focusable overlay window).
// Each tip also shows the button's keyboard shortcut, as configured in Settings
// (main sends ready-made display strings such as 'Ctrl+Num 6').
let hotkeys = {};
let tipTimer = null;
const NEEDS_ACCOUNT = ['like', 'addBtn', 'queueBtn', 'devBtn', 'libBtn'];   // need Spotify's online catalogue

function tipFor(el) {
  if (el.id === 'like') return { text: local.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', hk: hotkeys.like };
  if (el.id === 'play') return { text: local.isPlaying ? 'Pause' : 'Play', hk: hotkeys.playPause };
  if (current?.mode === 'local' && NEEDS_ACCOUNT.includes(el.id)) {
    return { text: `${el.dataset.tip} (needs a connected account)`, hk: el.dataset.hk && hotkeys[el.dataset.hk] };
  }
  if (el.id === 'lockBtn') return { text: locked ? 'Position locked · click to unlock, or Shift+drag' : 'Unlocked · drag to move · click to lock' };
  return { text: el.dataset.tip, hk: el.dataset.hk && hotkeys[el.dataset.hk] };
}

function showTip(el) {
  const tip = $('tip');
  const { text, hk } = tipFor(el);
  tip.replaceChildren(text);
  if (hk) {
    const s = document.createElement('span');
    s.className = 'hk';
    s.textContent = hk;
    tip.append(s);
  }
  tip.classList.add('show');
  const card = $('card').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let x, y;
  if (document.body.classList.contains('mini')) {         // mini window is short: show beside the button
    x = r.left - t.width - 8;
    y = r.top + (r.height - t.height) / 2;
  } else {
    x = r.left + (r.width - t.width) / 2;
    y = r.top - t.height - 6;                              // above, or below if there is no room
    if (y < 4) y = r.bottom + 6;
  }
  tip.style.left = Math.max(6, Math.min(x, card.width - t.width - 6)) + 'px';
  tip.style.top = Math.max(4, Math.min(y, card.height - t.height - 4)) + 'px';
}

function hideTip() {
  clearTimeout(tipTimer);
  $('tip').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  hideTip();
  tipTimer = setTimeout(() => showTip(el), 350);
});
document.addEventListener('mouseout', e => { if (e.target.closest('[data-tip]')) hideTip(); });
document.addEventListener('mousedown', hideTip);

// ---- window behaviour -----------------------------------------------------------
// The window is click-through until the cursor is over it (mousemove is still
// forwarded to us), then it becomes interactive so the buttons work. Shift +
// drag moves it.
let interactive = false;

function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  window.radio.setInteractive(on);
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  window.radio.dragEnd();
  wake();
}

document.addEventListener('mousemove', e => {
  hovering = true;
  if (!dragging) setInteractive(true);
  document.body.classList.toggle('grab', e.shiftKey);
  wake();
});
document.addEventListener('mouseleave', () => {
  hovering = false;
  if (dragging || resizing) return;
  setInteractive(false);
  document.body.classList.remove('grab');
  wake();
});
window.radio.onUnhover(() => {
  interactive = false;
  hovering = false;
  document.body.classList.remove('grab');
  wake();
});
document.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  // Unlocked: drag from any empty part of the card. Shift: drag from anywhere, even when locked.
  const onControl = e.target.closest('button, input, #barWrap, .row, #lyrics.plain, #grip');
  if (!e.shiftKey && (locked || onControl)) return;
  e.preventDefault();
  dragging = true;
  document.body.classList.add('dragging');
  window.radio.dragStart(e.shiftKey);
});

// Resize handle (bottom-right, shown when unlocked). The main process follows the cursor.
let resizing = false;
$('grip').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  resizing = true;
  window.radio.resizeStart();
});
$('grip').addEventListener('dblclick', e => { e.stopPropagation(); window.radio.resetSize(); });
function endResize() {
  if (!resizing) return;
  resizing = false;
  window.radio.resizeEnd();
}
window.addEventListener('mouseup', endResize);
window.addEventListener('blur', endResize);

function setLockedUI(on) {
  locked = !!on;
  document.body.classList.toggle('unlocked', !locked);
}
$('lockBtn').addEventListener('click', () => { window.radio.setLocked(!locked); hideTip(); });
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);

// ---- messages from the main process ----------------------------------------------
window.radio.onInit(({ drawer: d, mini, settings, hotkeys: hk }) => {
  cfg = { ...cfg, ...settings };
  setLockedUI(settings.locked !== false);
  hotkeys = hk || hotkeys;
  document.body.classList.toggle('mini', !!mini);
  setDrawerUI(d);
  wake();
});
window.radio.onHotkeys(hk => { hotkeys = hk || {}; });
window.radio.onDrawer(setDrawerUI);
window.radio.onMini(mini => { document.body.classList.toggle('mini', !!mini); wake(); });
window.radio.onSettings(s => { cfg = { ...cfg, ...s }; if ('locked' in s) setLockedUI(s.locked); wake(); });
window.radio.onWake(wake);
window.radio.onState(render);
window.radio.onRequest(ev => {
  if (ev.type === 'added') toast(`${ev.user} requested ${ev.name}`, true);
  else toast(`Twitch request: ${ev.reason}`);                    // only problems with the setup reach here, not viewer mistakes
});
window.radio.onMoveMode(on => { document.body.classList.toggle('move', on); wake(); });

setInterval(tickProgress, 250);
renderControls();
wake();
