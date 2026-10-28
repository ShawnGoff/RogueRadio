'use strict';
// System-wide keyboard shortcuts (work while a game or any other app has focus).
// Users can switch sets or change each one in Settings (stored under "hotkeys" in ~/.rogue-radio-overlay/overlay.json).
const { globalShortcut } = require('electron');

// Default set: Ctrl + number pad. One modifier plus one key, all on one hand, and no Alt/Option
// (which is awkward on a Windows keyboard). Number-pad keys are also rarely used by other apps.
const NUMPAD = {
  playPause:    'Control+num0',
  prev:         'Control+num4',
  next:         'Control+num6',
  volumeUp:     'Control+num8',
  volumeDown:   'Control+num2',
  like:         'Control+num5',
  lyrics:       'Control+num7',
  playlists:    'Control+num9',
  queue:        'Control+num1',
  devices:      'Control+num3',
  shuffle:      'Control+numdiv',
  repeat:       'Control+nummult',
  mini:         'Control+numsub',
  toggleVisible:'Control+numadd',
  library:      'Control+numdec',
};

// For keyboards without a number pad
const ALT_SHIFT = {
  playPause:    'Alt+Shift+Space',
  next:         'Alt+Shift+Right',
  prev:         'Alt+Shift+Left',
  volumeUp:     'Alt+Shift+Up',
  volumeDown:   'Alt+Shift+Down',
  shuffle:      'Alt+Shift+S',
  repeat:       'Alt+Shift+R',
  like:         'Alt+Shift+K',
  lyrics:       'Alt+Shift+L',
  playlists:    'Alt+Shift+P',
  queue:        'Alt+Shift+Q',
  devices:      'Alt+Shift+D',
  toggleVisible:'Alt+Shift+H',
  mini:         'Alt+Shift+M',
  library:      'Alt+Shift+F',
};

const PRESETS = { numpad: NUMPAD, altShift: ALT_SHIFT };
const DEFAULTS = NUMPAD;

const LABELS = {
  playPause: 'Play / Pause', next: 'Next track', prev: 'Previous track',
  volumeUp: 'Volume up', volumeDown: 'Volume down', shuffle: 'Shuffle', repeat: 'Repeat',
  like: 'Like / unlike song', lyrics: 'Lyrics panel', playlists: 'Add to playlist panel',
  queue: 'Queue panel', devices: 'Devices panel', toggleVisible: 'Show / hide overlay', mini: 'Mini mode', library: 'Search & play window',
};

const MODIFIERS = new Set(['Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Command', 'Cmd', 'CommandOrControl', 'CmdOrCtrl', 'Super']);
const NEEDS_REAL_MODIFIER = new Set(['Control', 'Ctrl', 'Alt', 'Option', 'Command', 'Cmd', 'CommandOrControl', 'CmdOrCtrl', 'Super']);
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Up|Down|Left|Right|num[0-9]|numadd|numsub|nummult|numdiv|numdec)$/;

const NUMPAD_NAMES = { numadd: '+', numsub: '-', nummult: '*', numdiv: '/', numdec: '.' };
const MOD_NAMES = { Control: 'Ctrl', Ctrl: 'Ctrl', Command: 'Cmd', Cmd: 'Cmd', Option: 'Alt', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl' };

// Human-readable form of an accelerator: 'Control+num4' -> 'Ctrl+Num 4'
function display(acc) {
  return String(acc || '').split('+').map(p => {
    if (MOD_NAMES[p]) return MOD_NAMES[p];
    if (/^num[0-9]$/.test(p)) return 'Num ' + p.slice(3);
    if (NUMPAD_NAMES[p]) return 'Num ' + NUMPAD_NAMES[p];
    return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[p] || p;
  }).join('+');
}

// { ok: true } or { ok: false, reason }
function validateAccelerator(acc) {
  const parts = String(acc || '').split('+');
  const key = parts.pop();
  if (!KEY.test(key || '')) return { ok: false, reason: 'Use a letter, number, F-key, Space, an arrow key or a number-pad key' };
  if (!parts.length || !parts.every(p => MODIFIERS.has(p))) return { ok: false, reason: 'Include a modifier key (Option, Control, Command...)' };
  if (!parts.some(p => NEEDS_REAL_MODIFIER.has(p))) return { ok: false, reason: 'Shift alone is not enough; add Option, Control or Command' };
  if (new Set(parts).size !== parts.length) return { ok: false, reason: 'Duplicate modifier' };
  return { ok: true };
}

// actions: { [name]: () => void }. Registers everything (clearing earlier registrations)
// and returns the ones that actually registered: [{ action, label, accelerator }].
function registerHotkeys({ overrides = {}, actions, log = console.log }) {
  globalShortcut.unregisterAll();
  const keys = { ...DEFAULTS, ...overrides };
  const registered = [];
  for (const [name, accelerator] of Object.entries(keys)) {
    if (!actions[name] || !accelerator) continue;       // unknown action or intentionally unbound
    let ok = false;
    try { ok = globalShortcut.register(accelerator, actions[name]); } catch { /* bad accelerator */ }
    if (ok) registered.push({ action: name, label: LABELS[name], accelerator });
    else log(`could not register ${accelerator} (${LABELS[name]}); taken by another app or invalid`);
  }
  return registered;
}

module.exports = { registerHotkeys, validateAccelerator, display, DEFAULTS, PRESETS, LABELS };
