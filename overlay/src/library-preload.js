'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('libraryApi', {
  search: (q, types, offset) => ipcRenderer.invoke('lib:search', String(q), types, offset),
  playlists: () => ipcRenderer.invoke('lib:playlists'),
  playTrack: uri => ipcRenderer.invoke('lib:play-track', String(uri)),
  playPlaylist: (uri, kind) => ipcRenderer.invoke('lib:play-playlist', String(uri), kind),   // playlist, album, artist, podcast or audiobook
  close: () => ipcRenderer.send('lib:close'),
  onShow: cb => ipcRenderer.on('lib:show', () => cb()),     // each time the window is opened
});
