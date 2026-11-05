'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  close: () => ipcRenderer.send('settings:close'),
  get: () => ipcRenderer.invoke('settings:get'),
  set: patch => ipcRenderer.invoke('settings:set', patch),
  setHotkey: (action, accelerator) => ipcRenderer.invoke('settings:hotkey', action, accelerator),
  capture: on => ipcRenderer.invoke('settings:capture', !!on),
  setPreset: name => ipcRenderer.invoke('settings:preset', name),
  resetHotkeys: () => ipcRenderer.invoke('settings:reset-hotkeys'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  openAutomation: () => ipcRenderer.invoke('auth:open-automation'),
  login: switchAccount => ipcRenderer.invoke('auth:login', !!switchAccount),
  twitchConnect: clientId => ipcRenderer.invoke('twitch:connect', clientId),
  twitchDisconnect: () => ipcRenderer.invoke('twitch:disconnect'),
  twitchCancel: () => ipcRenderer.invoke('twitch:cancel'),
  onChange: cb => ipcRenderer.on('settings:changed', () => cb()),
});
