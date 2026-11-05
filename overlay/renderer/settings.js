'use strict';
const $ = id => document.getElementById(id);
const api = window.settingsApi;

const STATUS_TEXT = {
  connecting: ['Connecting...', ''],
  ok: ['Connected to Spotify', 'ok'],
  auth: ['Not logged in', 'bad'],
  permission: ['Needs permission to control Spotify', 'warn'],
  offline: ['Companion server not running', 'bad'],
  error: ['Companion server error', 'bad'],
};

const CHAT_TEXT = { off: 'Off', connecting: 'Connecting to Twitch chat...', listening: 'Listening to chat', reconnecting: 'Reconnecting to Twitch chat...' };
const setVal = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };    // never overwrite what is being typed

let capturing = null;
let loginMode = null;       // 'login' | 'switch' | 'automation' | null (what the Spotify button does)       // action currently being recorded

async function load() {
  const data = await api.get();
  if (!data) return;
  const { settings: s, hotkeys, status, needsReauth } = data;

  const [text, cls] = STATUS_TEXT[status] || STATUS_TEXT.connecting;
  const isLocal = status === 'ok' && data.mode === 'local';             // no account connected
  const partial = status === 'ok' && !isLocal && needsReauth;            // logged in, but missing newer permissions
  $('statusText').textContent = isLocal ? 'Using the Spotify app on this Mac (no login needed)'
    : partial ? 'Connected - permissions needed' : text;
  $('dot').className = 'dot ' + (partial ? 'warn' : cls);
  $('reauth').style.display = partial ? 'block' : 'none';
  $('localNote').style.display = isLocal ? 'block' : 'none';

  // The buttons say what they will do; they only appear when there is something to do
  const btn = $('loginBtn');
  if (status === 'permission') { loginMode = 'automation'; btn.textContent = 'Open Automation settings'; btn.className = 'primary'; }
  else if (status === 'auth') { loginMode = 'login'; btn.textContent = 'Log in to Spotify'; btn.className = 'primary'; }
  else if (isLocal) { loginMode = 'login'; btn.textContent = 'Connect account'; btn.className = ''; }
  else if (partial) { loginMode = 'login'; btn.textContent = 'Grant permissions'; btn.className = 'primary'; }
  else if (status === 'ok') { loginMode = 'switch'; btn.textContent = 'Switch account'; btn.className = ''; }
  else { loginMode = null; }
  btn.style.display = loginMode ? '' : 'none';
  $('logoutBtn').style.display = status === 'ok' && !isLocal ? '' : 'none';

  $('opacity').value = Math.round(s.opacity * 100);
  $('opacityVal').textContent = Math.round(s.opacity * 100) + '%';
  $('scale').value = Math.round(s.scale * 100);
  $('scaleVal').textContent = Math.round(s.scale * 100) + '%';
  $('locked').checked = s.locked;
  $('mini').checked = s.mini;
  $('autoHide').checked = s.autoHide;
  $('autoHideSeconds').value = String(s.autoHideSeconds);
  $('autoHideSeconds').disabled = !s.autoHide;

  $('dockRow').style.display = $('dockNote').style.display = data.isMac ? '' : 'none';
  $('showInDock').checked = s.showInDock;
  $('onQuit').value = s.onQuit;
  $('startAtLogin').checked = data.startAtLogin;
  $('startAtLogin').disabled = !data.canStartAtLogin;
  $('loginNote').textContent = data.canStartAtLogin ? '' : 'Available in the installed app (not when running from source).';

  renderTwitch(s, data.twitch, data.mode);

  $('preset').value = data.preset;
  $('customOpt').disabled = data.preset !== 'custom';
  renderHotkeys(hotkeys);
}

function renderTwitch(s, t, mode) {
  $('twitchEnabled').checked = s.twitchEnabled;
  setVal('twitchChannel', s.twitchChannel);
  setVal('twitchClientId', s.twitchClientId);
  $('twitchWho').value = s.twitchWho;
  setVal('twitchCooldown', s.twitchCooldown);
  setVal('twitchPerUser', s.twitchPerUser);
  setVal('twitchMaxQueue', s.twitchMaxQueue);
  setVal('twitchMaxMinutes', s.twitchMaxMinutes);
  $('twitchBlockExplicit').checked = s.twitchBlockExplicit;
  setVal('twitchBlocklist', s.twitchBlocklist);

  let line = !s.twitchEnabled ? 'Requests are off.'
    : !t.channel ? 'Enter your channel name to start.'
    : (CHAT_TEXT[t.chat] || '') + (t.chat === 'listening' && t.waiting ? ` - ${t.waiting} request(s) waiting` : '');
  if (s.twitchEnabled && mode === 'local') line += ' Connect your Spotify account above: requests can only be queued with one.';
  if (s.twitchEnabled && t.channel && s.twitchWho === 'followers' && !t.followerCheck) line += ' Follower check is off, so only subscribers, VIPs and mods can request. Connect Twitch below with this channel\'s account.';
  $('twitchStatus').textContent = line;

  $('twitchDot').className = 'dot ' + (t.connected ? 'ok' : '');
  $('twitchAccount').textContent = t.connected ? `Connected as ${t.login}` : t.signIn ? 'Waiting for approval...' : 'Not connected';
  $('twitchDisconnect').style.display = t.connected ? '' : 'none';
  $('twitchConnect').style.display = t.connected ? 'none' : '';
  $('twitchConnect').textContent = t.signIn ? 'Cancel' : 'Connect Twitch';
  $('twitchCodeBox').style.display = t.signIn ? '' : 'none';
  $('twitchCode').textContent = t.signIn ? t.signIn.userCode : '';
  $('twitchErr').textContent = t.signInError || '';
}

function renderHotkeys(hotkeys) {
  const box = $('hotkeys');
  box.replaceChildren();
  for (const [action, h] of Object.entries(hotkeys)) {
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('span');
    label.textContent = h.label;

    const keys = document.createElement('span');
    keys.className = 'keys';
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (capturing === action) { chip.classList.add('recording'); chip.textContent = 'Press keys... (Esc cancels)'; }
    else if (!h.accelerator) { chip.classList.add('off'); chip.textContent = 'none'; }
    else {
      chip.textContent = h.display;
      if (!h.registered) { chip.classList.add('failed'); chip.title = 'Not active: another app may be using this shortcut'; }
    }

    const change = document.createElement('button');
    change.textContent = 'Change';
    change.addEventListener('click', () => startCapture(action));
    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.disabled = !h.accelerator;
    clear.addEventListener('click', async () => { $('hotkeyErr').textContent = ''; await api.setHotkey(action, null); load(); });

    keys.append(chip, change, clear);
    row.append(label, keys);
    box.append(row);
  }
}

// ---- shortcut recording ------------------------------------------------------
function keyName(e) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(e.code))) return m[1];
  if ((m = /^Digit([0-9])$/.exec(e.code))) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) return e.code;
  if ((m = /^Numpad([0-9])$/.exec(e.code))) return 'num' + m[1];
  return { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
           NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec' }[e.code] || null;
}

async function startCapture(action) {
  capturing = action;
  $('hotkeyErr').textContent = '';
  await api.capture(true);          // pause global shortcuts so the keypress reaches this window
  load();
}

async function stopCapture() {
  capturing = null;
  await api.capture(false);
}

document.addEventListener('keydown', async e => {
  if (!capturing) return;
  e.preventDefault();
  if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) return;       // wait for the real key
  if (e.key === 'Escape') { await stopCapture(); return load(); }

  const key = keyName(e);
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
  const action = capturing;
  await stopCapture();

  if (!key) { $('hotkeyErr').textContent = 'Use a letter, number, F-key, Space, an arrow key or a number-pad key.'; return load(); }
  const result = await api.setHotkey(action, [...mods, key].join('+'));
  $('hotkeyErr').textContent = result.ok ? '' : result.reason;
  load();
});

window.addEventListener('blur', () => { if (capturing) { stopCapture().then(load); } });

// ---- controls ------------------------------------------------------------------
$('opacity').addEventListener('input', e => { $('opacityVal').textContent = e.target.value + '%'; api.set({ opacity: Number(e.target.value) / 100 }); });
$('scale').addEventListener('input', e => { $('scaleVal').textContent = e.target.value + '%'; api.set({ scale: Number(e.target.value) / 100 }); });
$('locked').addEventListener('change', e => api.set({ locked: e.target.checked }));
$('mini').addEventListener('change', e => api.set({ mini: e.target.checked }).then(load));
$('autoHide').addEventListener('change', e => api.set({ autoHide: e.target.checked }).then(load));
$('autoHideSeconds').addEventListener('change', e => api.set({ autoHideSeconds: Number(e.target.value) }));
$('onQuit').addEventListener('change', e => api.set({ onQuit: e.target.value }));
$('showInDock').addEventListener('change', e => api.set({ showInDock: e.target.checked }));
$('startAtLogin').addEventListener('change', e => api.set({ startAtLogin: e.target.checked }));
$('loginBtn').addEventListener('click', () => (loginMode === 'automation' ? api.openAutomation() : api.login(loginMode === 'switch')));
$('logoutBtn').addEventListener('click', async () => { await api.logout(); setTimeout(load, 1500); });
for (const id of ['twitchEnabled', 'twitchBlockExplicit']) $(id).addEventListener('change', e => api.set({ [id]: e.target.checked }).then(load));
$('twitchWho').addEventListener('change', e => api.set({ twitchWho: e.target.value }).then(load));
for (const id of ['twitchChannel', 'twitchClientId', 'twitchCooldown', 'twitchPerUser', 'twitchMaxQueue', 'twitchMaxMinutes', 'twitchBlocklist']) {
  $(id).addEventListener('change', e => api.set({ [id]: e.target.value }).then(load));
}
$('twitchConnect').addEventListener('click', async () => {
  if ($('twitchConnect').textContent === 'Cancel') { await api.twitchCancel(); return load(); }
  $('twitchErr').textContent = '';
  const r = await api.twitchConnect($('twitchClientId').value);
  await load();
  if (!r.ok) $('twitchErr').textContent = r.error;
});
$('twitchDisconnect').addEventListener('click', async () => { await api.twitchDisconnect(); load(); });
$('preset').addEventListener('change', async e => { $('hotkeyErr').textContent = ''; await api.setPreset(e.target.value); load(); });
$('resetKeys').addEventListener('click', async () => { $('hotkeyErr').textContent = ''; await api.resetHotkeys(); load(); });

$('doneBtn').addEventListener('click', () => api.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !capturing) api.close(); });

api.onChange(() => { if (!capturing) load(); });
load();
