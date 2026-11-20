'use strict';

const { BrowserWindow, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function createDocumentIO({ getStore, getWindow, dataDirectory, testing }) {
  let queue = Promise.resolve();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  async function destination(format, title, kindName) {
    if (testing) {
      if (!process.env.SCROLLMIND_EXPORT_DIR) return null;
      await fs.mkdir(process.env.SCROLLMIND_EXPORT_DIR, { recursive: true });
      return path.join(process.env.SCROLLMIND_EXPORT_DIR, `${title}.${format}`);
    }
    const names = { sm: kindName, svg: 'SVG Drawing', pdf: 'PDF Document' };
    const exportDirectory = path.join(dataDirectory, 'Exports');
    await fs.mkdir(exportDirectory, { recursive: true });
    const result = await dialog.showSaveDialog(getWindow(), {
      title: `Export ${names[format]}`,
      defaultPath: path.join(exportDirectory, `${title}.${format}`),
      filters: [{ name: names[format], extensions: [format] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath.toLowerCase().endsWith(`.${format}`) ? result.filePath : `${result.filePath}.${format}`;
  }

  async function atomicWrite(file, content) {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(content);
      await handle.sync(); // handle is opened writable ('wx'), so this works on Windows too
      await handle.close(); handle = null;
      for (let attempt = 0; ; attempt++) { // Windows: transient EPERM/EBUSY/EACCES from antivirus/indexers.
        try { await fs.rename(temp, file); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 10) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function pdfBytes(html) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-pdf-'));
    let printWindow;
    let timeout;
    try {
      const file = path.join(directory, 'scroll.html');
      await fs.writeFile(file, html, 'utf8');
      printWindow = new BrowserWindow({
        width: 816, height: 1056, show: false, focusable: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      printWindow.webContents.on('will-navigate', event => event.preventDefault());
      return await Promise.race([
        (async () => {
          await printWindow.loadFile(file);
          await printWindow.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
          return printWindow.webContents.printToPDF({
            printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
            pageSize: 'Letter', margins: { top: 0, bottom: 0, left: 0, right: 0 },
          });
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('PDF export took too long. Try exporting a smaller scroll.')), 60_000); }),
      ]);
    } finally {
      clearTimeout(timeout);
      if (printWindow && !printWindow.isDestroyed()) printWindow.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  function exportDocument(format, options = {}) {
    return serialize(async () => {
      if (!['sm', 'svg', 'pdf'].includes(format)) throw new TypeError('Choose ScrollMind, SVG, or PDF export.');
      const store = getStore();
      const grid = store.workspaceState().kind === 'grid';
      const file = await destination(format, grid ? 'Grid' : 'Scroll', grid ? 'ScrollMind Grid' : 'ScrollMind Scroll');
      if (!file) return { canceled: true };
      if (store.assertExportDestination) await store.assertExportDestination(file);
      await store.flush();
      if (format === 'sm') await store.exportFile(file);
      else {
        const { exportSVG, exportPDFHTML } = await import('../core/export.mjs');
        const document = await store.getSnapshot();
        const geometry = { width: options.width ?? 1280, height: options.height ?? 800 };
        const content = format === 'svg' ? exportSVG(document, geometry) : await pdfBytes(exportPDFHTML(document, geometry).html);
        await atomicWrite(file, content);
      }
      return { canceled: false, path: file };
    });
  }

  function openDocument(suppliedPath) {
    return serialize(async () => {
      let file = suppliedPath;
      if (!file && testing) file = process.env.SCROLLMIND_OPEN_PATH;
      if (!file && !testing) {
        const result = await dialog.showOpenDialog(getWindow(), {
          title: 'Open Scroll or Grid', filters: [{ name: 'ScrollMind documents', extensions: ['sm', 'smg'] }], properties: ['openFile'],
        });
        if (result.canceled) return { canceled: true };
        file = result.filePaths[0];
      }
      if (!file || file === '__cancel__') return { canceled: true };
      const store = getStore();
      const { document, workspace } = await store.openScroll(file);
      return { canceled: false, document, workspace };
    });
  }

  return { exportDocument, openDocument };
}

module.exports = { createDocumentIO };
