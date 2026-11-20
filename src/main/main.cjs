'use strict';

const { app, BrowserWindow, Menu, ipcMain, screen, clipboard, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createDocumentWorkspaces } = require('./documents.cjs');
const { createDocumentIO } = require('./document-io.cjs');
const { findScrollArgument, commandForInput } = require('./launch-args.cjs');
const { updateEligibility, loopbackFeed, macDeveloperId, createUpdater } = require('./updater.cjs');
const { helperPath, createNativePen } = require('./native-pen.cjs');

app.setName('ScrollMind');
if (process.platform === 'win32') app.setAppUserModelId('com.seancheren.scrollmind');
const testing = process.env.SCROLLMIND_TEST === '1' || process.argv.includes('--smoke-test');
if (testing && process.platform === 'darwin') app.setActivationPolicy('accessory');
// Hidden Electron windows on Windows render ~1 frame/s, which starves synthetic mouse input in UI tests.
if (testing && process.platform === 'win32') app.commandLine.appendSwitch('disable-frame-rate-limit');
const dataDirectory = process.env.SCROLLMIND_DATA_DIR || path.join(app.getPath('documents'), 'ScrollMind');
app.setPath('userData', path.join(dataDirectory, 'App'));
app.setAppLogsPath(path.join(dataDirectory, 'Logs'));

let window;
let store;
let documents;
const pendingOpenPaths = [];
if (process.platform === 'win32') { const file = findScrollArgument(process.argv); if (file) pendingOpenPaths.push(file); }
let closing = false;
let allowClose = false;
let testClipboard = '';
let rendererReady = false;
let pendingClose = false;
let updates = null;
let updatesOffReason = 'Updates are not available.';
let installAfterClose = false;

function logTo(name) {
  return (level, text) => {
    const file = path.join(app.getPath('logs'), name);
    fs.mkdir(path.dirname(file), { recursive: true })
      .then(async () => {
        if ((await fs.stat(file).catch(() => null))?.size > 256 * 1024) await fs.rename(file, file.replace(/\.log$/, '.old.log'));
        await fs.appendFile(file, `${new Date().toISOString()} ${level} ${String(text).slice(0, 500)}\n`);
      })
      .catch(() => {});
  };
}
const logUpdate = logTo('update.log');
const logPen = logTo('pen.log');

// The Wacom One 12's side buttons, read from the display itself so the driver's button assignments cannot hide them.
let nativePen = null;
function forwardNativePen(state) {
  if (window && !window.isDestroyed()) window.webContents.send('pen:native', state);
}
function startNativePen() {
  // Tests drive the same path by hand: app.evaluate(() => globalThis.scrollmindNativePen({ lower, upper, tip, range })).
  if (testing) { globalThis.scrollmindNativePen = forwardNativePen; return; }
  const file = helperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: path.join(__dirname, '..', '..'), platform: process.platform });
  if (!file) return;
  nativePen = createNativePen({ file, onState: forwardNativePen, log: (text) => logPen('info', text) });
  nativePen.start();
}

function startUpdates() {
  const feed = testing ? loopbackFeed(process.env.SCROLLMIND_UPDATE_FEED) : null;
  const bundle = path.resolve(path.dirname(process.execPath), '..', '..');
  const eligible = updateEligibility({
    platform: process.platform, packaged: app.isPackaged, testing, feedOverride: Boolean(feed),
    hasFeedFile: app.isPackaged && require('node:fs').existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    bundle, developerId: process.platform === 'darwin' && app.isPackaged && macDeveloperId(bundle),
  });
  if (!eligible.ok) { updatesOffReason = eligible.why; return; }
  try {
    const { autoUpdater } = require('electron-updater');
    if (feed) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: 'generic', url: feed }); }
    updates = createUpdater({
      autoUpdater, dialog, getWindow: () => window, version: app.getVersion(), log: logUpdate,
      // The restart goes through the normal close so the final save and store.close() finish before the install.
      install: () => { installAfterClose = true; requestClose(); },
    });
    updates.start();
  } catch (error) {
    updatesOffReason = 'The updater could not start.';
    logUpdate('error', `the updater did not start: ${error?.message ?? error}`);
  }
}

async function checkForUpdates() {
  if (updates) return updates.check({ manual: true });
  const options = { type: 'info', message: 'Updates are off for this copy', detail: updatesOffReason, buttons: ['OK'], noLink: true };
  return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

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
  // Windows has a frameless window with no menu bar; shortcuts are handled by before-input-event instead.
  if (process.platform === 'win32') return Menu.setApplicationMenu(null);
  const action = (label, command, options = {}) => ({ label, click: () => send(command), ...options });
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'ScrollMind', submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => { void checkForUpdates(); } },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { label: 'Quit ScrollMind', accelerator: 'Cmd+Q', click: requestClose },
    ] }] : []),
    { label: 'File', submenu: [
      action('New', 'new-scroll'),
      action('Open…', 'open-sm'),
      { label: 'Export', submenu: [action('ScrollMind (.sm)…', 'export-sm'), action('SVG (.svg)…', 'export-svg'), action('PDF (.pdf)…', 'export-pdf')] },
      { type: 'separator' },
      { label: 'Open Writing Folder', click: async () => { await fs.mkdir(dataDirectory, { recursive: true }); await shell.openPath(dataDirectory); } },
      { type: 'separator' },
      action('Close Document', 'close-scroll', { accelerator: 'CmdOrCtrl+W' }),
      action('Delete Document', 'delete-scroll'),
      ...(process.platform !== 'darwin' ? [{ label: 'Quit', accelerator: 'Alt+F4', click: requestClose }] : []),
    ] },
    { label: 'Edit', submenu: [
      action('Undo', 'undo'), action('Redo', 'redo'), { type: 'separator' },
      action('Cut', 'cut'), action('Copy', 'copy'), action('Paste', 'paste'),
      action('Select All', 'select-all'), action('Delete Selection', 'delete'),
      { type: 'separator' }, action('Clear Current Document', 'clear-scroll'),
    ] },
    { label: 'View', submenu: [
      action('Pen', 'tool-pen'), action('Eraser', 'tool-eraser'), action('Fill', 'tool-fill'),
      action('Rectangle Selection', 'tool-select'), action('Hand', 'tool-hand'),
      { type: 'separator' },
      action('Zoom In', 'zoom-in'), action('Zoom Out', 'zoom-out'), action('Actual Size', 'zoom-reset'),
      { type: 'separator' },
      action('Show / Hide Toolbar', 'toggle-toolbar'), action('Go to Start', 'home'),
      action('Show / Hide Sidebar', 'toggle-sidebar'),
      action('Scrolls', 'view-scroll'), action('Grids', 'view-grid'),
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
  handle('scroll:save-changes', (changes) => {
    if (changes.scrollId && changes.scrollId !== store.workspaceState().activeId) throw new Error('The active scroll changed before saving.');
    return store.saveChanges(changes);
  });
  handle('workspace:state', () => store.workspaceState());
  handle('workspace:switch', kind => store.switchWorkspace(kind));
  handle('workspace:new', (options) => store.newScroll(options));
  handle('workspace:select', (id) => store.selectScroll(id));
  handle('workspace:close', (id) => store.closeScroll(id));
  handle('workspace:delete', (id) => store.deleteScroll(id));
  handle('workspace:rename', (id, name) => store.renameScroll(id, name));
  handle('scroll:export', (format, options) => documents.exportDocument(format, options));
  handle('scroll:open', () => {
    const file = pendingOpenPaths.shift();
    return documents.openDocument(file);
  });
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
      installAfterClose = false;
      if (!testing) await dialog.showMessageBox(window, { type: 'error', title: 'Writing has not been saved', message: 'ScrollMind is staying open to protect your writing.', detail: String(result.error), buttons: ['Keep Writing'] });
      return false;
    }
    await store.flush();
    await store.close();
    allowClose = true;
    if (installAfterClose && updates) {
      setImmediate(() => {
        try { updates.quitAndInstall(); }
        catch (error) { logUpdate('error', `install failed: ${error?.message ?? error}`); window?.close(); }
      });
      return true;
    }
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

const windowIcon = (() => { const file = path.join(__dirname, '../../build/icon.png'); return require('node:fs').existsSync(file) ? file : undefined; })();

async function createWindow() {
  const { validateSnapshot } = await import('../core/model.mjs');
  store = createDocumentWorkspaces(dataDirectory, { validate: validateSnapshot });
  documents = createDocumentIO({ getStore: () => store, getWindow: () => window, dataDirectory, testing });
  const display = preferredDisplay();
  window = new BrowserWindow({
    ...(testing ? { width: 1280, height: 800 } : display.bounds),
    title: 'ScrollMind',
    ...(process.platform === 'win32' && windowIcon ? { icon: windowIcon } : {}),
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
  if (process.platform === 'win32') {
    window.webContents.on('before-input-event', (event, input) => {
      const command = commandForInput(input);
      if (!command) return;
      event.preventDefault();
      if (command === 'quit') requestClose(); else send(command);
    });
    // Windows does not emit before-quit on shutdown, restart or log-off. Hold the session end until the final save and store.close() finish.
    window.on('query-session-end', (event) => {
      if (allowClose) return;
      event.preventDefault();
      requestClose();
    });
    // Last chance if the user chooses to shut down anyway; only synchronous work counts.
    window.on('session-end', () => {
      if (allowClose) return;
      try { Promise.resolve(store?.flush()).catch(() => {}); store?.close(); } catch {}
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    if (pendingClose) { pendingClose = false; setImmediate(requestClose); }
    for (let index = 0; index < pendingOpenPaths.length; index++) setImmediate(() => send('open-sm'));
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
  startUpdates();
  startNativePen();
  await window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

const ownsInstance = testing || app.requestSingleInstanceLock();
app.on('open-file', (event, file) => {
  event.preventDefault();
  pendingOpenPaths.push(file);
  if (rendererReady) send('open-sm');
});
if (!ownsInstance) app.quit();
else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const file = findScrollArgument(argv, workingDirectory);
    if (file) { pendingOpenPaths.push(file); if (rendererReady) send('open-sm'); }
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('before-quit', (event) => { if (window && !allowClose) { event.preventDefault(); requestClose(); } });
  app.on('will-quit', () => nativePen?.stop());
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // Pages may load nothing remote. Requests with no page behind them are the main process's own: the updater's feed and download.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.webContentsId != null && !details.url.startsWith('file:') && !details.url.startsWith('devtools:') && !details.url.startsWith('data:') }));
    await createWindow();
  }).catch((error) => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
