'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel, cb) => ipcRenderer.on(channel, (_e, ...args) => cb(...args));

contextBridge.exposeInMainWorld('radio', {
  // playback commands: name = play|pause|next|prev|seek|shuffle|repeat|volume
  command: (name, value) => invoke('command', name, value),
  like: liked => invoke('api:like', !!liked),
  playlists: () => invoke('api:playlists'),
  addToPlaylist: id => invoke('api:playlist-add', String(id)),
  devices: () => invoke('api:devices'),
  transfer: id => invoke('api:transfer', String(id)),
  queue: () => invoke('api:queue'),
  skipToQueue: count => invoke('api:queue-skip', count),

  toggleDrawer: mode => ipcRenderer.send('drawer:toggle', mode),
  openSettings: () => ipcRenderer.send('settings:open'),
  openLibrary: () => ipcRenderer.send('library:open'),
  toggleMini: () => ipcRenderer.send('mini:toggle'),

  setInteractive: on => ipcRenderer.send('interactive', !!on),
  dragStart: override => ipcRenderer.send('drag-start', !!override),
  setLocked: on => ipcRenderer.send('lock:set', !!on),
  resizeStart: () => ipcRenderer.send('resize-start'),
  resizeEnd: () => ipcRenderer.send('resize-end'),
  resetSize: () => ipcRenderer.send('scale:reset'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  onState: cb => on('state', cb),
  onInit: cb => on('init', cb),          // { drawer, mini, settings }
  onHotkeys: cb => on('hotkeys', cb),    // { action: 'Alt+Shift+K', ... } for tooltips
  onDrawer: cb => on('drawer', cb),      // mode | null
  onMini: cb => on('mini', cb),          // bool
  onSettings: cb => on('settings', cb),  // { autoHide, autoHideSeconds }
  onRequest: cb => on('request', cb),    // { type: 'added'|'rejected', user, name, artist, reason }
  onUnhover: cb => on('unhover', cb),    // main saw the cursor leave while the page still thought it was over
  onWake: cb => on('wake', cb),
  onMoveMode: cb => on('move-mode', cb),
});
