'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Everything the frontend needs from the backend goes through here — the page
// itself gets no Node access.
contextBridge.exposeInMainWorld('lib', {
  // --- config ---
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),

  // --- favorites / recently opened ---
  toggleFavorite: (id) => ipcRenderer.invoke('toggle-favorite', id),
  noteOpened: (id) => ipcRenderer.invoke('note-opened', id),

  // --- metadata tags ---
  setTags: (id, tags) => ipcRenderer.invoke('set-tags', id, tags),

  // --- library ---
  // The cached index arrives first via onLibraryCached (instant), then only
  // the games that actually changed on disk arrive via onGameScanned.
  // Pass force=true to ignore the cache and re-walk everything.
  scanLibrary: (root, force) => ipcRenderer.invoke('scan-library', root, force),
  chooseRoot: () => ipcRenderer.invoke('choose-root'),

  // --- covers ---
  fileUrl: (absPath) => ipcRenderer.invoke('file-url', absPath),
  saveCover: (id, dataUrl) => ipcRenderer.invoke('save-cover', id, dataUrl),
  clearCover: (id) => ipcRenderer.invoke('clear-cover', id),
  setCoverOverride: (id, absPath, page) => ipcRenderer.invoke('set-cover-override', id, absPath, page),
  pickCoverFile: (defaultPath) => ipcRenderer.invoke('pick-cover-file', defaultPath),

  // --- launching ---
  openPath: (absPath) => ipcRenderer.invoke('open-path', absPath),
  showInFolder: (absPath) => ipcRenderer.invoke('show-in-folder', absPath),

  // --- events pushed from the backend ---
  onLibraryCached: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('library-cached', handler);
    return () => ipcRenderer.removeListener('library-cached', handler);
  },
  onGameScanned: (cb) => {
    const handler = (_e, game) => cb(game);
    ipcRenderer.on('game-scanned', handler);
    return () => ipcRenderer.removeListener('game-scanned', handler);
  },
  onScanDone: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('scan-done', handler);
    return () => ipcRenderer.removeListener('scan-done', handler);
  },
});
