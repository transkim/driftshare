// Gives the desktop window a few PC-only powers. Phones never get this bridge.
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('driftDesktop', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  openBundle: (msgId, firstFileId) => ipcRenderer.invoke('open-bundle', msgId, firstFileId),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (fileId) => ipcRenderer.invoke('open-file', fileId),
  showInFolder: (fileId) => ipcRenderer.invoke('show-in-folder', fileId),
  openDownloads: () => ipcRenderer.invoke('open-downloads')
});
