'use strict';

const { app, BrowserWindow, Menu, ipcMain, screen, clipboard, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createStore } = require('./storage.cjs');

app.setName('ScrollMind');
const testing = process.env.SCROLLMIND_TEST === '1' || process.argv.includes('--smoke-test');
if (testing && process.platform === 'darwin') app.setActivationPolicy('accessory');
const dataDirectory = process.env.SCROLLMIND_DATA_DIR || path.join(app.getPath('documents'), 'ScrollMind');
app.setPath('userData', path.join(dataDirectory, 'App'));
app.setAppLogsPath(path.join(dataDirectory, 'Logs'));

let window;
let store;
let closing = false;
let allowClose = false;
let testClipboard = '';
let rendererReady = false;
let pendingClose = false;

function send(command) {
  if (window && !window.isDestroyed()) window.webContents.send('app:command', command);
}

function isFullscreen() {
  return window && (window.isFullScreen() || (process.platform === 'darwin' && window.isSimpleFullScreen()));
}

function setFullscreen(value) {
  if (!window || window.isDestroyed()) return;
  if (process.platform === 'darwin') window.setSimpleFullScreen(value);
  else window.setFullScreen(value);
}

function requestClose() {
  if (!window || window.isDestroyed()) return app.quit();
  if (!rendererReady) { pendingClose = true; return; }
  if (closing || allowClose) return;
  closing = true;
  window.webContents.send('app:before-close');
}

function preferredDisplay() {
  const displays = screen.getAllDisplays();
  return displays.find((display) => /wacom|cintiq|dtk|dth/i.test(display.label || ''))
    || displays.find((display) => !display.internal)
    || screen.getPrimaryDisplay();
}

function createMenu() {
  const action = (label, command, options = {}) => ({ label, click: () => send(command), ...options });
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'ScrollMind', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { label: 'Quit ScrollMind', accelerator: 'Cmd+Q', click: requestClose },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Open Writing Folder', click: async () => { await fs.mkdir(dataDirectory, { recursive: true }); await shell.openPath(dataDirectory); } },
      { type: 'separator' },
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: requestClose },
      ...(process.platform !== 'darwin' ? [{ label: 'Quit', accelerator: 'Alt+F4', click: requestClose }] : []),
    ] },
    { label: 'Edit', submenu: [
      action('Undo', 'undo'), action('Redo', 'redo'), { type: 'separator' },
      action('Cut', 'cut'), action('Copy', 'copy'), action('Paste', 'paste'),
      action('Select All', 'select-all'), action('Delete Selection', 'delete'),
    ] },
    { label: 'View', submenu: [
      action('Pen', 'tool-pen'), action('Eraser', 'tool-eraser'),
      action('Rectangle Selection', 'tool-select'), action('Hand', 'tool-hand'),
      { type: 'separator' },
      action('Show / Hide Toolbar', 'toggle-toolbar'), action('Go to Start', 'home'),
      action('Show / Hide Sections', 'toggle-sidebar'),
      action('Add Section', 'add-section'), action('Add Marker', 'add-marker'), action('Add Page Break', 'add-page-break'),
      { label: 'Toggle Full Screen', click: () => setFullscreen(!isFullscreen()) },
    ] },
    { label: 'Help', submenu: [action('Controls & Wacom Buttons', 'help')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installHandlers() {
  function handle(channel, callback) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
        throw new Error('This action is unavailable.');
      }
      return callback(...args);
    });
  }
  handle('notebook:load', () => store.load());
  handle('notebook:save', (document) => store.save(document));
  handle('clipboard:read', () => testing ? testClipboard : clipboard.readText());
  handle('clipboard:write', (text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('The selection is too large to copy.');
    if (testing) testClipboard = text;
    else clipboard.writeText(text);
  });
  handle('window:toggle-fullscreen', () => setFullscreen(!isFullscreen()));
  handle('window:leave-fullscreen', () => setFullscreen(false));
  handle('app:quit', requestClose);
  handle('window:ready-to-close', async (result) => {
    if (!closing) return;
    if (result?.error) {
      closing = false;
      if (!testing) await dialog.showMessageBox(window, { type: 'error', title: 'Writing has not been saved', message: 'ScrollMind is staying open to protect your writing.', detail: String(result.error), buttons: ['Keep Writing'] });
      return false;
    }
    await store.flush();
    allowClose = true;
    window.close();
    return true;
  });
  handle('notebook:open-folder', async () => {
    await fs.mkdir(dataDirectory, { recursive: true });
    const error = await shell.openPath(dataDirectory);
    if (error) throw new Error(error);
  });
  handle('app:info', () => ({ version: app.getVersion(), dataPath: store.filePath, testMode: testing }));
  handle('display:list', () => {
    const current = screen.getDisplayMatching(window.getBounds());
    return screen.getAllDisplays().map((display) => ({ id: display.id, label: display.label || `Display ${display.id}`, selected: display.id === current.id }));
  });
  handle('display:move', async (id) => {
    const display = screen.getAllDisplays().find((candidate) => candidate.id === Number(id));
    if (!display) throw new Error('That display is no longer connected.');
    setFullscreen(false);
    window.setBounds(display.bounds);
    if (!testing) setFullscreen(true);
  });
}

async function createWindow() {
  const { validateSnapshot } = await import('../core/model.mjs');
  store = createStore(dataDirectory, { validate: validateSnapshot });
  const display = preferredDisplay();
  window = new BrowserWindow({
    ...(testing ? { width: 1280, height: 800 } : display.bounds),
    title: 'ScrollMind',
    show: false,
    focusable: !testing,
    frame: false,
    roundedCorners: false,
    fullscreen: false,
    backgroundColor: '#f9f8f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (pendingClose) { pendingClose = false; setImmediate(requestClose); }
  });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (allowClose || !window || window.isDestroyed()) return;
    closing = false;
    rendererReady = false;
    pendingClose = false;
    if (testing) { allowClose = true; window.close(); return; }
    const { response } = await dialog.showMessageBox(window, {
      type: 'error',
      title: 'Reopen your writing',
      message: 'The drawing window stopped responding.',
      detail: `Your saved writing is safe. Reopen it to continue. (${details.reason})`,
      buttons: ['Reopen Saved Writing', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (!window || window.isDestroyed()) return;
    if (response === 0) window.webContents.reload();
    else { allowClose = true; window.close(); }
  });
  window.on('close', (event) => {
    if (!allowClose) { event.preventDefault(); requestClose(); }
  });
  window.on('closed', () => { window = null; app.quit(); });
  window.once('ready-to-show', () => {
    if (!testing) { window.show(); setFullscreen(true); }
  });
  installHandlers();
  createMenu();
  await window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

const ownsInstance = testing || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', (event) => { if (window && !allowClose) { event.preventDefault(); requestClose(); } });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:') && !details.url.startsWith('data:') }));
    await createWindow();
  }).catch((error) => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
