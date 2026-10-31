const { app, BrowserWindow, Tray, Menu, shell, nativeImage } = require('electron');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', 'app');
let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.setAppUserModelId('app.sakina.desktop'); // needed for Windows notifications

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: 'Sakina',
    icon: path.join(APP_DIR, 'img', 'icon.png'),
    backgroundColor: '#f6f3ec',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // reminder timers must fire while hidden in the tray
    },
  });
  win.loadFile(path.join(APP_DIR, 'index.html'));

  // links to the web open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  // closing the window keeps Sakina in the tray so prayer reminders still fire
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(APP_DIR, 'img', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Sakina');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Sakina', click: showWindow },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.whenReady().then(() => {
  createWindow();
  if (process.argv.includes('--hidden')) win.hide();
  createTray();
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (process.platform !== 'win32') app.quit(); });
