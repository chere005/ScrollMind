'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('scrollmind', Object.freeze({
  platform: process.platform,
  testPenPlatform: process.env.SCROLLMIND_TEST === '1' ? process.env.SCROLLMIND_TEST_PEN_PLATFORM : undefined,
  load: () => ipcRenderer.invoke('notebook:load'),
  save: (document) => ipcRenderer.invoke('notebook:save', document),
  saveChanges: (changes) => ipcRenderer.invoke('scroll:save-changes', changes),
  exportDocument: (format, options) => ipcRenderer.invoke('scroll:export', format, options),
  openDocument: () => ipcRenderer.invoke('scroll:open'),
  workspaceState: () => ipcRenderer.invoke('workspace:state'),
  switchWorkspace: kind => ipcRenderer.invoke('workspace:switch', kind),
  newScroll: (options) => ipcRenderer.invoke('workspace:new', options),
  selectScroll: (id) => ipcRenderer.invoke('workspace:select', id),
  closeScroll: (id) => ipcRenderer.invoke('workspace:close', id),
  deleteScroll: (id) => ipcRenderer.invoke('workspace:delete', id),
  renameScroll: (id, name) => ipcRenderer.invoke('workspace:rename', id, name),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  leaveFullscreen: () => ipcRenderer.invoke('window:leave-fullscreen'),
  quit: () => ipcRenderer.invoke('app:quit'),
  readyToClose: (result) => ipcRenderer.invoke('window:ready-to-close', result),
  openDataFolder: () => ipcRenderer.invoke('notebook:open-folder'),
  getDisplays: () => ipcRenderer.invoke('display:list'),
  moveToDisplay: (id) => ipcRenderer.invoke('display:move', id),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  onCommand: (callback) => subscribe('app:command', callback),
  onNativePen: (callback) => subscribe('pen:native', callback),
  penLog: (text) => ipcRenderer.send('pen:log', String(text).slice(0, 240)),
  onBeforeClose: (callback) => subscribe('app:before-close', callback),
}));
