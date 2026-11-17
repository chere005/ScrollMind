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

  async function destination(format) {
    if (testing) {
      if (!process.env.SCROLLMIND_EXPORT_DIR) return null;
      await fs.mkdir(process.env.SCROLLMIND_EXPORT_DIR, { recursive: true });
      return path.join(process.env.SCROLLMIND_EXPORT_DIR, `Scroll.${format}`);
    }
    const names = { sm: 'ScrollMind Scroll', svg: 'SVG Drawing', pdf: 'PDF Document' };
    const exportDirectory = path.join(dataDirectory, 'Exports');
    await fs.mkdir(exportDirectory, { recursive: true });
    const result = await dialog.showSaveDialog(getWindow(), {
      title: `Export ${names[format]}`,
      defaultPath: path.join(exportDirectory, `Scroll.${format}`),
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
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, file);
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
      const file = await destination(format);
      if (!file) return { canceled: true };
      const store = getStore();
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
          title: 'Open Scroll', filters: [{ name: 'ScrollMind Scroll', extensions: ['sm'] }], properties: ['openFile'],
        });
        if (result.canceled) return { canceled: true };
        file = result.filePaths[0];
      }
      if (!file || file === '__cancel__') return { canceled: true };
      const store = getStore();
      // Validate the selected file before touching the working scroll.
      const document = await store.importFile(file);
      const current = await store.getSnapshot();
      if (current && (current.strokes.length || current.markers?.length)) {
        const saved = path.join(dataDirectory, 'Saved Scrolls');
        await fs.mkdir(saved, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await store.exportFile(path.join(saved, `Scroll ${stamp}-${crypto.randomUUID().slice(0, 8)}.sm`));
      }
      await store.save(document);
      return { canceled: false, document };
    });
  }

  return { exportDocument, openDocument };
}

module.exports = { createDocumentIO };
