'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, dialog, powerMonitor, shell } = require('electron');
const APP_NAME = 'Rogue Radio Overlay';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BASE, ACTION, execute, request } = require('./commands');
const hotkeys = require('./hotkeys');
const quitHelper = require('./quit');
const { createTwitchService } = require('./twitch-service');
const { WHO } = require('./requests');

// Data folder. Earlier versions used ~/.azeroth-radio; move it over once so the saved login carries on.
const LEGACY_DIR = path.join(os.homedir(), '.azeroth-radio');
const DEFAULT_DIR = path.join(os.homedir(), '.rogue-radio-overlay');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DIR;
if (!process.env.DATA_DIR && !fs.existsSync(DEFAULT_DIR) && fs.existsSync(LEGACY_DIR)) {
  try { fs.renameSync(LEGACY_DIR, DEFAULT_DIR); console.log(`[overlay] moved data to ${DEFAULT_DIR}`); }
  catch (err) { console.error('[overlay] could not move legacy data folder:', err.message); }
}
const SETTINGS_FILE = path.join(DATA_DIR, 'overlay.json');
// Packaged app: the server is copied into Resources/server (see "build" in package.json)
const COMPANION_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'server')
  : path.join(__dirname, '..', '..', 'src');

const ASSETS = path.join(__dirname, '..', 'assets');
const POLL_MS = 1000;
const WIDTH = 380;
const MIN_SCALE = 0.8;
const MAX_SCALE = 2;
const HEIGHT = { full: 164, drawerExtra: 148, mini: 76 };
const DRAWERS = ['lyrics', 'playlists', 'queue', 'devices'];

const DEFAULT_SETTINGS = { opacity: 1, autoHide: false, autoHideSeconds: 6, mini: false, showInDock: true, locked: true, scale: 1, onQuit: 'ask',
  twitchEnabled: false, twitchChannel: '', twitchClientId: '', twitchWho: 'followers', twitchCooldown: 30,
  twitchPerUser: 2, twitchMaxQueue: 15, twitchMaxMinutes: 8, twitchBlockExplicit: false, twitchBlocklist: '' };

let win, tray, settingsWin, companion;
let status = 'connecting';      // connecting | ok | auth | permission | offline | error
let visible = true;
let moveMode = false;
let lastData = null;            // latest /api/current-track response (shortcuts read from it)
let drawer = null;              // null | 'lyrics' | 'playlists' | 'queue' | 'devices'
let mini = false;
let anchorBottom = false;       // window sits low on screen: resizes keep the bottom edge fixed
let anchorRight = false;        // ...and likewise the right edge when it sits on the right
let scale = 1;                  // overall size of the overlay (window size and page zoom move together)
let hotkeyList = [];

const LOG_FILE = path.join(DATA_DIR, 'overlay.log');
function log(msg) {
  console.log(`[overlay] ${msg}`);
  try {                                                  // keep a small log next to the settings (a packaged app has no console)
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 200 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never break the app */ }
}
const track = () => lastData?.track || null;

// ---- settings --------------------------------------------------------------
function readFile() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...readFile(), ...patch }, null, 2));
  } catch (err) { log('could not save settings: ' + err.message); }
}
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...pickKnown(readFile()) });
function pickKnown(raw) {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function sanitize(patch) {
  const out = {};
  if ('opacity' in patch) out.opacity = Math.min(1, Math.max(0.3, Number(patch.opacity) || 1));
  if ('autoHide' in patch) out.autoHide = !!patch.autoHide;
  if ('autoHideSeconds' in patch) out.autoHideSeconds = Math.min(60, Math.max(2, Math.round(Number(patch.autoHideSeconds) || 6)));
  if ('mini' in patch) out.mini = !!patch.mini;
  if ('showInDock' in patch) out.showInDock = !!patch.showInDock;
  if ('locked' in patch) out.locked = !!patch.locked;
  if ('onQuit' in patch && quitHelper.MODES.includes(patch.onQuit)) out.onQuit = patch.onQuit;
  if ('scale' in patch) out.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(patch.scale) || 1));
  if ('twitchEnabled' in patch) out.twitchEnabled = !!patch.twitchEnabled;
  if ('twitchChannel' in patch) out.twitchChannel = String(patch.twitchChannel || '').trim().slice(0, 100);
  if ('twitchClientId' in patch) out.twitchClientId = String(patch.twitchClientId || '').trim().slice(0, 60);
  if ('twitchWho' in patch && WHO.includes(patch.twitchWho)) out.twitchWho = patch.twitchWho;
  const whole = (key, lo, hi) => { if (key in patch) out[key] = Math.min(hi, Math.max(lo, Math.round(Number(patch[key]))) || lo); };
  whole('twitchCooldown', 0, 600); whole('twitchPerUser', 1, 20); whole('twitchMaxQueue', 1, 50); whole('twitchMaxMinutes', 1, 60);
  if ('twitchBlockExplicit' in patch) out.twitchBlockExplicit = !!patch.twitchBlockExplicit;
  if ('twitchBlocklist' in patch) out.twitchBlocklist = String(patch.twitchBlocklist || '').slice(0, 2000);
  return out;
}

// ---- Twitch song requests ---------------------------------------------------
const twitch = createTwitchService({
  dataDir: DATA_DIR,
  getSettings,
  request,
  log,
  openExternal: url => { if (/^https:\/\/(www\.)?twitch\.tv\//.test(url)) shell.openExternal(url); },
  onEvent: ev => { if (ev.type === 'added' || ev.problem) send('request', ev); notifySettings(); },
  onChange: () => notifySettings(),
});

// ---- companion server ------------------------------------------------------
async function companionUp() {
  try { return (await fetch(BASE + '/health', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

async function ensureCompanion() {
  if (process.env.AZR_NO_SPAWN || await companionUp()) return;
  const script = path.join(COMPANION_DIR, 'server.js');
  if (!fs.existsSync(script)) return log('companion server not found; start it manually');
  log('starting companion server');
  companion = spawn(process.execPath, [script], {
    cwd: COMPANION_DIR,                                  // dotenv reads .env from here
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Packaged: the server's dependencies live in the app's own node_modules (inside app.asar)
      ...(app.isPackaged && { NODE_PATH: path.join(process.resourcesPath, 'app.asar', 'node_modules') }),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  companion.on('exit', code => { log(`companion exited (${code})`); companion = null; });
}

// ---- track polling -> renderer --------------------------------------------
async function poll() {
  let state;
  try {
    const res = await fetch(BASE + '/api/current-track' + (drawer === 'lyrics' ? '?lyrics=1' : ''), { signal: AbortSignal.timeout(2500) });
    if (res.status === 401) state = { status: 'auth' };
    else if (res.status === 403 && (await res.json().catch(() => ({}))).code === 'LOCAL_PERMISSION') state = { status: 'permission' };
    else if (!res.ok) state = { status: 'error', code: res.status, message: (await res.json().catch(() => ({}))).error };
    else {
      state = { status: 'ok', data: await res.json(), receivedAt: Date.now() };
      lastData = state.data;
      twitch.noteNowPlaying(state.data.track?.id || null);
      state.data.requestedBy = twitch.requestedBy(state.data.track?.id);
    }
  } catch {
    state = { status: 'offline' };
  }
  if (state.status !== status) { status = state.status; refreshTray(); notifySettings(); }
  send('state', state);
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---- playback commands (UI buttons and shortcuts share this path) -----------
const NAMED_ACTIONS = {
  play: ACTION.PLAY, pause: ACTION.PAUSE, next: ACTION.NEXT, prev: ACTION.PREV,
  seek: ACTION.SEEK, shuffle: ACTION.SHUFFLE, repeat: ACTION.REPEAT, volume: ACTION.VOLUME,
};

async function runCommand(name, value) {
  const action = NAMED_ACTIONS[name];
  if (action === undefined) return { ok: false, status: 0 };
  const v = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const result = await execute({ action, value: v }, log);
  setTimeout(poll, 500);                      // refresh quickly so the UI reflects the change
  return result;
}

async function setLiked(on) {
  const uri = track()?.uri;
  if (!uri) return { ok: false, status: 0, data: null };
  const result = await request('POST', `/api/like?${new URLSearchParams({ uri, state: on ? 'true' : 'false' })}`, log);
  setTimeout(poll, 300);
  return result;
}

ipcMain.handle('command', (_e, name, value) => runCommand(name, value));
ipcMain.handle('api:like', (_e, on) => setLiked(on));
ipcMain.handle('api:playlists', () => request('GET', '/api/playlists', log));
ipcMain.handle('api:playlist-add', (_e, id) => {
  const uri = track()?.uri;
  if (!uri) return { ok: false, status: 0, data: null };
  return request('POST', `/api/playlists/add?${new URLSearchParams({ playlist: id, uri })}`, log);
});
ipcMain.handle('api:devices', () => request('GET', '/api/devices', log));
ipcMain.handle('api:transfer', async (_e, id) => {
  const r = await request('POST', `/api/devices/transfer?${new URLSearchParams({ id })}`, log);
  setTimeout(poll, 800);
  return r;
});
ipcMain.handle('api:queue', async () => {
  const r = await request('GET', '/api/queue', log);
  if (r.ok && Array.isArray(r.data?.queue)) r.data.queue = r.data.queue.map(t => ({ ...t, requestedBy: twitch.requestedBy(t.id) }));
  return r;
});
ipcMain.handle('api:queue-skip', async (_e, count) => {
  const n = Math.round(Number(count));
  if (!(n >= 1 && n <= 25)) return { ok: false, status: 0, data: null };
  const r = await request('POST', `/api/queue/skip-to?count=${n}`, log);
  setTimeout(poll, 600);
  return r;
});

// ---- window size: panel and mini mode change the height ----------------------
// Height in unscaled (CSS) pixels for the current mode; the window is this times `scale`
function baseHeight() {
  if (mini) return HEIGHT.mini;
  return HEIGHT.full + (drawer ? HEIGHT.drawerExtra : 0);
}

const windowSize = () => ({ width: Math.round(WIDTH * scale), height: Math.round(baseHeight() * scale) });

function workAreaForWindow() {
  return win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
}

// Keep the scale within limits and small enough that the overlay fits on the screen
function fitScale(s) {
  const wa = workAreaForWindow();
  const fit = Math.min(wa.width / WIDTH, wa.height / (HEIGHT.full + HEIGHT.drawerExtra));
  return Math.round(Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit, Number(s) || 1)) * 100) / 100;
}

function updateAnchor() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  anchorBottom = b.y + b.height / 2 > wa.y + wa.height / 2;
  anchorRight = b.x + b.width / 2 > wa.x + wa.width / 2;
}

// Resize the window to match the current mode and scale, keeping the edge it is anchored to fixed.
// topLeft: used while dragging the resize handle, where the top-left corner stays put.
function applySize({ topLeft = false, save = true } = {}) {
  if (!win || win.isDestroyed()) return;
  stopDrag();
  const b = win.getBounds();
  const { width, height } = windowSize();
  if (b.width === width && b.height === height) return;
  const wa = screen.getDisplayMatching(b).workArea;
  let x = anchorRight && !topLeft ? b.x + b.width - width : b.x;
  let y = anchorBottom && !topLeft ? b.y + b.height - height : b.y;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  win.setBounds({ x, y, width, height });
  if (save) saveSettings({ bounds: win.getBounds() });
}

function setScale(next, opts = {}) {
  scale = fitScale(next);
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(scale);
  applySize(opts);
}

function setDrawer(mode) {
  drawer = DRAWERS.includes(mode) ? mode : null;
  if (drawer) mini = false;                                // panels need the full window
  applySize();
  saveSettings({ drawer: drawer === 'lyrics' ? 'lyrics' : null, mini });  // only lyrics persists
  send('drawer', drawer);
  send('mini', mini);
  send('wake');
  if (drawer === 'lyrics') poll();
  refreshTray();
}

function toggleDrawer(mode) {
  if (!visible) setVisible(true);
  setDrawer(drawer === mode ? null : mode);
}

function setMini(on) {
  mini = !!on;
  if (mini) drawer = null;
  applySize();
  saveSettings({ mini, drawer: null });
  send('mini', mini);
  send('drawer', drawer);
  send('wake');
  refreshTray();
  notifySettings();
}

function applyOpacity() {
  if (win && !win.isDestroyed()) win.setOpacity(getSettings().opacity);
}

function pushSettingsToOverlay() {
  const s = getSettings();
  send('settings', { autoHide: s.autoHide, autoHideSeconds: s.autoHideSeconds, locked: s.locked });
}

ipcMain.on('drawer:toggle', (_e, mode) => toggleDrawer(mode));
ipcMain.on('mini:toggle', () => setMini(!mini));
ipcMain.on('settings:open', () => openSettings());
ipcMain.on('settings:close', e => { if (settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents) settingsWin.close(); });

// ---- overlay window --------------------------------------------------------
function createWindow() {
  const raw = readFile();
  const settings = getSettings();
  mini = settings.mini === true;
  drawer = !mini && raw.drawer === 'lyrics' ? 'lyrics' : null;
  scale = fitScale(settings.scale);

  const work = screen.getPrimaryDisplay().workArea;
  const { width, height } = windowSize();
  win = new BrowserWindow({
    width, height,
    x: raw.bounds?.x ?? work.x + work.width - width - 24,
    y: raw.bounds?.y ?? work.y + work.height - height - 24,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, show: false, acceptFirstMouse: true,
    // Own session: page zoom is remembered per session, so this keeps the overlay's zoom from
    // leaking into the Settings window (both load local files).
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, partition: 'overlay', zoomFactor: scale },
  });
  win.setAlwaysOnTop(true, 'screen-saver');                       // above fullscreen games
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });              // click-through by default
  applyOpacity();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(scale);
    send('init', { drawer, mini, hotkeys: hotkeyMap(), settings: { autoHide: settings.autoHide, autoHideSeconds: settings.autoHideSeconds, locked: settings.locked } });
  });

  updateAnchor();
  let timer;
  win.on('moved', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { updateAnchor(); saveSettings({ bounds: win.getBounds() }); }, 300);
  });
}

// Shift + drag: the renderer asks to become interactive while Shift is held, then
// the main process follows the cursor (more reliable than a CSS drag region on a
// non-focusable window).
let dragTimer = null;
let dragOffset = null;

function stopDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  updateAnchor();
  saveSettings({ bounds: win.getBounds() });
}

let solid = false;                 // the overlay is currently catching clicks instead of passing them through
ipcMain.on('interactive', (_e, on) => {
  solid = !!on;
  if (win && !win.isDestroyed() && !moveMode) win.setIgnoreMouseEvents(!on, { forward: true });
});

// Safety net: the page normally reports when the cursor leaves, but that report can be lost (a game
// grabbing the mouse for camera control, a fast exit). If the overlay is still solid while the cursor
// is nowhere near it, turn click-through back on so the game gets its clicks.
function cursorOver(point, b) {
  return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
}
setInterval(() => {
  if (!solid || !win || win.isDestroyed() || moveMode || dragTimer || resizeTimer) return;
  if (cursorOver(screen.getCursorScreenPoint(), win.getBounds())) return;
  solid = false;
  win.setIgnoreMouseEvents(true, { forward: true });
  send('unhover');
}, 150);

ipcMain.on('lock:set', (_e, on) => {
  saveSettings({ locked: !!on });
  pushSettingsToOverlay();
  notifySettings();
});

// `override` = Shift was held: moving is allowed even while the position is locked
ipcMain.on('drag-start', (_e, override) => {
  if (!win || win.isDestroyed()) return;
  if (getSettings().locked && !override) return;
  stopDrag();
  const cur = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragOffset = { x: cur.x - x, y: cur.y - y };
  const started = Date.now();
  dragTimer = setInterval(() => {
    if (Date.now() - started > 60000) return stopDrag();      // safety net if mouseup is lost
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragOffset.x, p.y - dragOffset.y);
  }, 16);
});

ipcMain.on('drag-end', stopDrag);

// Drag the corner handle to resize: the overlay scales so its width follows the cursor
let resizeTimer = null;
function endResize() {
  if (!resizeTimer) return;
  clearInterval(resizeTimer);
  resizeTimer = null;
  updateAnchor();
  saveSettings({ scale, bounds: win.getBounds() });
  notifySettings();
}

ipcMain.on('resize-start', () => {
  if (!win || win.isDestroyed()) return;                 // the lock guards position only, not size
  stopDrag();
  clearInterval(resizeTimer);
  const origin = win.getBounds();
  const started = Date.now();
  resizeTimer = setInterval(() => {
    if (Date.now() - started > 60000) return endResize();           // safety net if mouseup is lost
    const p = screen.getCursorScreenPoint();
    setScale((p.x - origin.x) / WIDTH, { topLeft: true, save: false });
  }, 33);
});

ipcMain.on('resize-end', endResize);

ipcMain.on('scale:reset', () => {
  setScale(1);
  saveSettings({ scale });
  notifySettings();
});

function setMoveMode(on) {
  moveMode = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
  win.setFocusable(on);
  send('move-mode', on);
  refreshTray();
}

function setVisible(on) {
  visible = on;
  if (on) { win.showInactive(); send('wake'); } else win.hide();
  refreshTray();
}

// ---- keyboard shortcuts ------------------------------------------------------
const volume = () => track()?.volume ?? 50;
const REPEAT_ORDER = ['off', 'context', 'track'];
const REPEAT_VALUE = { off: 0, track: 1, context: 2 };

const hotkeyActions = {
  playPause:  () => { runCommand(track()?.isPlaying ? 'pause' : 'play'); send('wake'); },
  next:       () => { runCommand('next'); send('wake'); },
  prev:       () => { runCommand('prev'); send('wake'); },
  volumeUp:   () => { runCommand('volume', Math.min(100, volume() + 5)); send('wake'); },
  volumeDown: () => { runCommand('volume', Math.max(0, volume() - 5)); send('wake'); },
  shuffle:    () => { runCommand('shuffle', track()?.shuffle ? 0 : 1); send('wake'); },
  repeat:     () => {
    const cur = track()?.repeat || 'off';
    runCommand('repeat', REPEAT_VALUE[REPEAT_ORDER[(REPEAT_ORDER.indexOf(cur) + 1) % REPEAT_ORDER.length]]);
    send('wake');
  },
  like:       () => { setLiked(!track()?.liked); send('wake'); },
  lyrics:     () => toggleDrawer('lyrics'),
  playlists:  () => toggleDrawer('playlists'),
  queue:      () => toggleDrawer('queue'),
  devices:    () => toggleDrawer('devices'),
  toggleVisible: () => setVisible(!visible),
  mini:       () => { if (!visible) setVisible(true); setMini(!mini); },
  library:    () => toggleLibrary(),
};

// Display strings for the overlay's tooltips, e.g. { next: 'Ctrl+Num 6' }
const hotkeyMap = () => Object.fromEntries(hotkeyList.map(h => [h.action, hotkeys.display(h.accelerator)]));

function registerAllHotkeys() {
  hotkeyList = hotkeys.registerHotkeys({ overrides: readFile().hotkeys, actions: hotkeyActions, log });
  send('hotkeys', hotkeyMap());                       // so the overlay's tooltips show the current keys
  refreshTray();
}

// ---- Search & Play window ----------------------------------------------------------------
// A separate small window, because typing needs keyboard focus and the overlay never takes it.
// On macOS it is a "panel", which can accept typing without making this app the active one.
let libraryWin = null;
let libraryShownAt = 0;

function closeLibrary() {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.close();
  libraryWin = null;
}

function toggleLibrary() {
  if (libraryWin && !libraryWin.isDestroyed()) return closeLibrary();

  const wa = workAreaForWindow();
  const width = 520, height = 560;
  libraryWin = new BrowserWindow({
    width, height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 3),
    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, show: false, backgroundColor: '#0f0c09',
    ...(process.platform === 'darwin' && { type: 'panel' }),
    webPreferences: { preload: path.join(__dirname, 'library-preload.js'), contextIsolation: true, sandbox: true },
  });
  libraryWin.setAlwaysOnTop(true, 'screen-saver');
  libraryWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  libraryWin.loadFile(path.join(__dirname, '..', 'renderer', 'library.html'));
  libraryWin.once('ready-to-show', () => {
    libraryShownAt = Date.now();
    libraryWin.show();
    libraryWin.focus();
    libraryWin.webContents.send('lib:show');
  });
  // Spotlight-style: clicking elsewhere dismisses it (ignore the focus churn while it is opening)
  libraryWin.on('blur', () => { if (Date.now() - libraryShownAt > 600) closeLibrary(); });
  libraryWin.on('closed', () => { libraryWin = null; });
}

const fromLibraryWindow = e => libraryWin && !libraryWin.isDestroyed() && e.sender === libraryWin.webContents;

ipcMain.on('library:open', () => toggleLibrary());
ipcMain.on('lib:close', e => { if (fromLibraryWindow(e)) closeLibrary(); });
ipcMain.handle('lib:search', (e, q, types, offset) => {
  if (!fromLibraryWindow(e)) return null;
  const params = new URLSearchParams({ q: String(q) });
  if (types) params.set('types', String(types));
  if (offset) params.set('offset', String(Math.max(0, Math.round(Number(offset) || 0))));
  return request('GET', `/api/search?${params}`, log);
});
ipcMain.handle('lib:playlists', e => fromLibraryWindow(e) ? request('GET', '/api/playlists?all=1', log) : null);

async function playFromLibrary(e, path_, uri, kind) {
  if (!fromLibraryWindow(e)) return { ok: false, status: 0 };
  const params = new URLSearchParams({ uri });
  if (kind === 'show' || kind === 'audiobook') params.set('kind', kind);      // lets the server pick the right fallback
  const result = await request('POST', `${path_}?${params}`, log);
  if (result.ok) {                                  // started: get out of the way and refresh the overlay
    closeLibrary();
    send('wake');
    setTimeout(poll, 700);
  }
  return result;
}
ipcMain.handle('lib:play-track', (e, uri) => playFromLibrary(e, '/api/play-uri', uri));
ipcMain.handle('lib:play-playlist', (e, uri, kind) => playFromLibrary(e, '/api/play-context', uri, kind));   // playlists, albums, artists, podcasts, audiobooks

// ---- settings window -----------------------------------------------------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  const room = screen.getPrimaryDisplay().workAreaSize.height;
  settingsWin = new BrowserWindow({
    width: 540, height: Math.min(680, room - 20), title: 'Rogue Radio Overlay Settings',
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    backgroundColor: '#0f0c09',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.setAlwaysOnTop(true, 'screen-saver', 1);   // the overlay floats at that level; keep Settings (and its close button) above it
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; registerAllHotkeys(); });   // in case it closed mid-recording
  app.focus({ steal: true });                       // menu bar apps have no Dock icon to bring it forward
}

function notifySettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed');
}

const fromSettingsWindow = e => settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;

// Which built-in set the current shortcuts match: 'numpad' | 'altShift' | 'custom'
function currentPreset() {
  const overrides = readFile().hotkeys || {};
  const effective = a => (a in overrides ? overrides[a] : hotkeys.DEFAULTS[a]);
  for (const [name, set] of Object.entries(hotkeys.PRESETS)) {
    if (Object.keys(hotkeys.DEFAULTS).every(a => (effective(a) || '').toLowerCase() === set[a].toLowerCase())) return name;
  }
  return 'custom';
}

function hotkeySnapshot() {
  const overrides = readFile().hotkeys || {};
  const out = {};
  for (const action of Object.keys(hotkeys.DEFAULTS)) {
    const accelerator = action in overrides ? overrides[action] : hotkeys.DEFAULTS[action];
    out[action] = {
      label: hotkeys.LABELS[action],
      accelerator,
      display: hotkeys.display(accelerator),
      default: hotkeys.DEFAULTS[action],
      registered: hotkeyList.some(h => h.action === action),
    };
  }
  return out;
}

ipcMain.handle('settings:get', e => {
  if (!fromSettingsWindow(e)) return null;
  return {
    settings: getSettings(),
    hotkeys: hotkeySnapshot(),
    preset: currentPreset(),
    startAtLogin: app.getLoginItemSettings().openAtLogin,
    canStartAtLogin: app.isPackaged,
    isMac: process.platform === 'darwin',
    status,
    mode: lastData?.mode || 'api',
    needsReauth: !!lastData?.needsReauth,
    twitch: twitch.status(),
  };
});

ipcMain.handle('settings:set', (e, patch) => {
  if (!fromSettingsWindow(e)) return { ok: false };
  if ('startAtLogin' in patch) {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.startAtLogin });
  }
  const clean = sanitize(patch || {});
  if (Object.keys(clean).length) saveSettings(clean);
  if ('mini' in clean) setMini(clean.mini);
  if ('scale' in clean) { setScale(clean.scale); saveSettings({ scale }); }
  applyOpacity();
  applyDockPreference();
  pushSettingsToOverlay();
  if (Object.keys(clean).some(k => k.startsWith('twitch'))) twitch.apply();
  return { ok: true };
});

ipcMain.handle('settings:hotkey', (e, action, accelerator) => {
  if (!fromSettingsWindow(e)) return { ok: false, reason: 'Not allowed' };
  if (!(action in hotkeys.DEFAULTS)) return { ok: false, reason: 'Unknown action' };

  const current = readFile().hotkeys || {};
  if (accelerator) {
    const v = hotkeys.validateAccelerator(accelerator);
    if (!v.ok) return v;
    const snap = hotkeySnapshot();
    const clash = Object.entries(snap).find(([a, h]) => a !== action && h.accelerator?.toLowerCase() === accelerator.toLowerCase());
    if (clash) return { ok: false, reason: `Already used by "${clash[1].label}"` };
  }

  saveSettings({ hotkeys: { ...current, [action]: accelerator || '' } });
  registerAllHotkeys();
  if (accelerator && !hotkeyList.some(h => h.action === action)) {         // another app owns it
    saveSettings({ hotkeys: current });
    registerAllHotkeys();
    return { ok: false, reason: 'That shortcut is already taken by another app' };
  }
  notifySettings();
  return { ok: true };
});

// While the settings window records a new shortcut, pause the global ones so the keypress
// reaches the window instead of triggering the old action.
ipcMain.handle('settings:capture', (e, on) => {
  if (!fromSettingsWindow(e)) return { ok: false };
  if (on) require('electron').globalShortcut.unregisterAll();
  else registerAllHotkeys();
  return { ok: true };
});

ipcMain.handle('settings:preset', (e, name) => {
  if (!fromSettingsWindow(e)) return { ok: false };
  const set = hotkeys.PRESETS[name];
  if (!set) return { ok: false, reason: 'Unknown shortcut set' };
  // Store only what differs from the defaults
  const overrides = {};
  for (const a of Object.keys(hotkeys.DEFAULTS)) if (set[a] !== hotkeys.DEFAULTS[a]) overrides[a] = set[a];
  saveSettings({ hotkeys: overrides });
  registerAllHotkeys();
  notifySettings();
  return { ok: true };
});

ipcMain.handle('settings:reset-hotkeys', e => {
  if (!fromSettingsWindow(e)) return { ok: false };
  saveSettings({ hotkeys: {} });
  registerAllHotkeys();
  notifySettings();
  return { ok: true };
});

const openAutomationSettings = () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation');

// Forget the saved Spotify login; the overlay carries on in local mode
async function disconnectAccount() {
  await request('POST', '/api/auth/logout', log);
  lastData = null;
  poll();
}

ipcMain.handle('twitch:connect', async (e, clientId) => {
  if (!fromSettingsWindow(e)) return { ok: false, error: 'Not allowed' };
  try { saveSettings({ twitchClientId: String(clientId || '').trim().slice(0, 60) }); return { ok: true, ...(await twitch.connect(clientId)) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('twitch:disconnect', e => { if (fromSettingsWindow(e)) twitch.disconnect(); return { ok: true }; });
ipcMain.handle('twitch:cancel', e => { if (fromSettingsWindow(e)) twitch.cancelSignIn(); return { ok: true }; });

ipcMain.handle('auth:logout', async e => {
  if (!fromSettingsWindow(e)) return { ok: false };
  await disconnectAccount();
  return { ok: true };
});

ipcMain.handle('auth:open-automation', e => {
  if (!fromSettingsWindow(e)) return { ok: false };
  openAutomationSettings();
  return { ok: true };
});

ipcMain.handle('auth:login', (e, switchAccount) => {
  if (!fromSettingsWindow(e)) return { ok: false };
  return request('GET', '/api/auth/login' + (switchAccount ? '?switch=1' : ''), log);
});

// ---- restart ---------------------------------------------------------------
// Stop the companion first and wait for it to release port 3333, otherwise the
// relaunched app would see the dying server, skip starting its own, and be left
// with none.
async function restartApp() {
  if (companion) {
    const proc = companion;
    await new Promise(resolve => {
      proc.once('exit', resolve);
      proc.kill();
      setTimeout(resolve, 3000);
    });
  }
  app.relaunch();
  app.exit(0);
}

// ---- tray -----------------------------------------------------------------
const STATUS_LABEL = {
  connecting: 'Connecting...',
  ok:         'Connected to Spotify',
  permission: 'Needs permission to control Spotify',
  auth:       'Not logged in to Spotify',
  offline:    'Companion server not running',
  error:      'Companion server error',
};

// 'local' = no account connected: the overlay is controlling the Spotify app on this computer
const localMode = () => status === 'ok' && lastData?.mode === 'local';
const statusLabel = () => (localMode() ? 'Using the Spotify app (no login needed)' : STATUS_LABEL[status]);

// Logged in and nothing more to approve: the only reason to log in again is to change accounts
const connectedAndComplete = () => status === 'ok' && lastData?.mode !== 'local' && !lastData?.needsReauth;

function refreshTray() {
  if (!tray) return;
  tray.setTitle(status === 'ok' ? '' : ' !');          // icon alone when healthy; ! flags a problem
  tray.setToolTip('Rogue Radio Overlay: ' + statusLabel());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel(), enabled: false },
    ...(lastData?.needsReauth ? [{ label: 'Log in again to enable Like and Playlists', enabled: false }] : []),
    { type: 'separator' },
    { label: 'Show overlay', type: 'checkbox', checked: visible, click: i => setVisible(i.checked) },
    { label: 'Mini mode', type: 'checkbox', checked: mini, click: i => setMini(i.checked) },
    { label: 'Move overlay', type: 'checkbox', checked: moveMode, click: i => setMoveMode(i.checked) },
    { label: 'Settings...', click: openSettings },
    { label: 'Keyboard shortcuts', submenu: hotkeyList.length
        ? hotkeyList.map(h => ({ label: `${h.label}: ${hotkeys.display(h.accelerator)}`, enabled: false }))
        : [{ label: 'None registered', enabled: false }] },
    ...(status === 'permission' ? [{ label: 'Open Automation settings...', click: openAutomationSettings }] : []),
    connectedAndComplete()
      ? { label: 'Switch Spotify account...', click: () => request('GET', '/api/auth/login?switch=1', log) }
      : { label: localMode() ? 'Connect Spotify account (likes, playlists, search)...' : status === 'ok' ? 'Grant Spotify permissions...' : 'Log in to Spotify', click: () => request('GET', '/api/auth/login', log) },
    ...(status === 'ok' && lastData?.mode === 'api' ? [{ label: 'Disconnect Spotify account', click: disconnectAccount }] : []),
    { type: 'separator' },
    { label: 'Restart', click: restartApp },
    { label: 'Quit', click: () => app.quit() },
  ]));
  buildAppMenus();
}

// ---- Dock icon and the app menu (top-left of the screen) ---------------------------
// Electron hides the Dock icon when a window is made visible over fullscreen apps, so the
// preference is (re)applied after the window is set up. If the overlay ever stops showing
// over a fullscreen app, turning "Show in Dock" off restores the old behaviour.
function applyDockPreference() {
  if (process.platform !== 'darwin' || !app.dock) return;
  if (getSettings().showInDock) {
    const icon = nativeImage.createFromPath(path.join(ASSETS, 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);       // don't rely on macOS's cached icon for this app
    app.dock.show();
  } else {
    app.dock.hide();
  }
}

function buildAppMenus() {
  const showOrHide = { label: 'Show overlay', type: 'checkbox', checked: visible, click: i => setVisible(i.checked) };
  const miniItem = { label: 'Mini mode', type: 'checkbox', checked: mini, accelerator: 'Shift+CommandOrControl+M', click: i => setMini(i.checked) };
  const panel = (label, mode) => ({ label, type: 'checkbox', checked: drawer === mode, click: () => toggleDrawer(mode) });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: APP_NAME, submenu: [
      { role: 'about', label: `About ${APP_NAME}` },
      { type: 'separator' },
      { label: 'Settings...', accelerator: 'CommandOrControl+,', click: openSettings },
      { type: 'separator' },
      { role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: `Quit ${APP_NAME}` },
    ] },
    { label: 'View', submenu: [
      showOrHide, miniItem, { type: 'separator' },
      panel('Lyrics', 'lyrics'), panel('Add to Playlist', 'playlists'), panel('Queue', 'queue'), panel('Devices', 'devices'),
    ] },
    { role: 'editMenu' },                                  // without it, Cmd+C / Cmd+V do nothing in text boxes
    { label: 'Window', role: 'windowMenu' },
  ]));

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([showOrHide, miniItem, { label: 'Settings...', click: openSettings }]));
  }
}

// ---- lifecycle --------------------------------------------------------------
// One copy only (a second launch just exits; Restart relaunches after this one quits)
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion(), copyright: 'Lyrics powered by LRCLIB. Not affiliated with Spotify.' });
  await ensureCompanion();

  createWindow();
  // 'Template' in the file name makes macOS tint it for light/dark menu bars (@2x is picked up automatically)
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png')));
  registerAllHotkeys();
  applyDockPreference();                           // after the window exists; see note above

  poll();
  setInterval(poll, POLL_MS);
  twitch.apply();
});

app.on('window-all-closed', e => e.preventDefault());   // stay alive: the overlay is the app
// Clicking the Dock icon: bring the overlay back if it was hidden, otherwise open Settings
app.on('activate', () => {
  if (!win) return;
  if (!visible) setVisible(true); else openSettings();
});
app.on('will-quit', () => { twitch.stop(); require('electron').globalShortcut.unregisterAll(); });
// ---- quitting: optionally close Spotify too ---------------------------------------------
// before-quit must be cancelled synchronously, so we cancel it, decide asynchronously, then call
// quit() again with `quitApproved` set. Restart uses app.exit(), which skips this on purpose.
let quitApproved = false;
let quitPromptOpen = false;
let shuttingDown = false;
app.whenReady().then(() => powerMonitor.on('shutdown', () => { shuttingDown = true; }));   // never block a logout/shutdown with a dialog

async function confirmQuit() {
  const running = await quitHelper.spotifyRunning();
  let action = quitHelper.decide(getSettings().onQuit, running);
  log(`quit requested: spotifyRunning=${running} setting=${getSettings().onQuit} -> ${action}`);

  if (action === 'ask') {
    app.focus({ steal: true });                                    // there is no Dock window to bring forward
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: 'question',
      icon: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 64 }),
      title: `Quit ${APP_NAME}`,
      message: 'Also close Spotify?',
      detail: 'Spotify is still running. You can leave it playing or close it along with the overlay.',
      buttons: ['Close Spotify', 'Keep Spotify Open', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: 'Remember my choice',
    });
    if (response === 2) return false;                              // Cancel: stay open
    action = response === 0 ? 'close' : 'quit';
    log(`quit dialog answer: ${action}`);
    if (checkboxChecked) saveSettings({ onQuit: action === 'close' ? 'close' : 'keep' });
  }

  if (action === 'close') {
    let result = await quitHelper.closeSpotify();
    log(`close Spotify: ${JSON.stringify(result)}`);

    if (!result.ok && result.reason === 'permission') {
      const { response } = await dialog.showMessageBox({
        type: 'question', title: APP_NAME, message: "macOS didn't allow closing Spotify politely",
        detail: `${APP_NAME} isn't allowed to control Spotify (System Settings → Privacy & Security → Automation). I can still close it directly instead.`,
        buttons: ['Close Spotify anyway', 'Leave it open'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) {
        result = await quitHelper.forceCloseSpotify();
        log(`force close Spotify: ${JSON.stringify(result)}`);
      } else {
        result = { ok: true, skipped: true };
      }
    }

    if (!result.ok) {
      await dialog.showMessageBox({
        type: 'warning', title: APP_NAME, message: "Spotify didn't close",
        detail: 'It is still running. You can close it yourself from the Spotify menu.',
      });
    }
  }
  return true;
}

app.on('before-quit', e => {
  if (!quitApproved && !shuttingDown) {
    e.preventDefault();
    if (quitPromptOpen) return;                                    // Cmd+Q pressed again while the dialog is up
    quitPromptOpen = true;
    confirmQuit()
      .then(go => { if (go) { quitApproved = true; app.quit(); } })
      .catch(err => { log('quit prompt failed: ' + err.message); quitApproved = true; app.quit(); })
      .finally(() => { quitPromptOpen = false; });
    return;
  }
  if (companion) companion.kill();
});
