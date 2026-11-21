// Electron shell: starts the hub and shows its UI in a desktop window.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const { Hub, HUB_ID } = require('./hub');

let hub;
let win;
let tray;

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: 'Driftshare',
    backgroundColor: '#0f1720',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  win.loadURL(hub.localUrl());
  // Links (e.g. in chat messages) open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(`http://127.0.0.1:${hub.port}/`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${hub.port}/`)) e.preventDefault();
  });
  // Closing the window keeps Driftshare running in the tray so phones can still send.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'ui', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Driftshare');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Driftshare', click: showWindow },
      { label: 'Open received files', click: () => shell.openPath(hub.downloadDir) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showWindow);
}

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});

// A received folder opens in Explorer; a group of files shows the first one there.
ipcMain.handle('open-bundle', async (_e, msgId, firstFileId) => {
  const b = hub.state.bundles[msgId];
  if (b && b.root) return shell.openPath(b.root);
  const p = knownPath(firstFileId);
  if (p) shell.showItemInFolder(p);
  else shell.openPath(hub.downloadDir);
});

function knownPath(fileId) {
  const meta = hub.state.files[fileId];
  return meta && meta.path;
}

ipcMain.handle('open-file', async (_e, fileId) => {
  const p = knownPath(fileId);
  return p ? shell.openPath(p) : 'File not found';
});

ipcMain.handle('show-in-folder', async (_e, fileId) => {
  const p = knownPath(fileId);
  if (p) shell.showItemInFolder(p);
  else shell.openPath(hub.downloadDir);
});

ipcMain.handle('open-downloads', () => shell.openPath(hub.downloadDir));

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('app.driftshare.desktop');
  hub = new Hub({
    dataDir: path.join(app.getPath('userData'), 'hub'),
    downloadDir: path.join(app.getPath('downloads'), 'Driftshare')
  });
  await hub.load();
  try {
    await hub.start();
  } catch (err) {
    dialog.showErrorBox(
      'Driftshare could not start',
      `Port ${hub.port} is already in use. Is Driftshare already running?\n\n${err.message}`
    );
    app.exit(1);
    return;
  }

  // Desktop notification when a phone sends something and the window isn't focused.
  const origAdd = hub.addMessage.bind(hub);
  hub.addMessage = (m) => {
    const msg = origAdd(m);
    if (msg.from !== HUB_ID && Notification.isSupported() && !(win && win.isFocused())) {
      const who = hub.state.devices[msg.from]?.name || 'Phone';
      const n = new Notification({
        title: who,
        body: msg.type === 'text' ? msg.text.slice(0, 120) : `Sent you ${msg.name}`
      });
      n.on('click', showWindow);
      n.show();
    }
    return msg;
  };

  createWindow();
  createTray();
});

app.on('before-quit', async (e) => {
  app.isQuitting = true;
  if (hub && hub.server && !hub.stopped) {
    e.preventDefault();
    hub.stopped = true;
    await hub.stop().catch(() => {});
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // Stay alive in the tray.
});
