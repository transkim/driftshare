const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sakinaDesktop', { platform: process.platform });
