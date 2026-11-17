'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 256 * 1024 * 1024;

function basicValidate(document) {
  if (!document || typeof document !== 'object' || document.version !== 1 || !Array.isArray(document.strokes)) {
    throw new Error('This is not a supported ScrollMind notebook.');
  }
  return document;
}

function createStore(directory, { validate = basicValidate } = {}) {
  const filePath = path.join(directory, 'notebook.scrollmind.json');
  const backupPath = path.join(directory, 'notebook.backup.json');
  let queue = Promise.resolve();
  let blocked = false;
  let loaded = false;

  async function readDocument(file) {
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) throw new Error('The notebook is too large to open safely.');
    const text = await fs.readFile(file, 'utf8');
    return { text, document: validate(JSON.parse(text)) };
  }

  async function atomicWrite(file, text) {
    const temp = path.join(directory, `${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, file);
      // Persist the rename as well as the file contents on filesystems that support it.
      let directoryHandle;
      try {
        directoryHandle = await fs.open(directory, 'r');
        await directoryHandle.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      } finally {
        await directoryHandle?.close();
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.unlink(temp).catch(() => {});
    }
  }

  async function load() {
    await queue;
    loaded = true;
    blocked = false;
    let primaryError;
    try {
      const { document } = await readDocument(filePath);
      return { document, recovered: false };
    } catch (error) {
      primaryError = error;
    }
    try {
      const { document } = await readDocument(backupPath);
      if (primaryError.code !== 'ENOENT') {
        await fs.rename(filePath, path.join(directory, `notebook.corrupt-${Date.now()}-${crypto.randomUUID()}.json`));
      }
      return { document, recovered: true };
    } catch (backupError) {
      if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') {
        return { document: null, recovered: false };
      }
      blocked = true;
      return {
        document: null,
        recovered: false,
        error: 'ScrollMind could not read your notebook or its backup. Your files were preserved. Open the writing folder to recover them before saving.',
      };
    }
  }

  function save(document) {
    let text;
    try {
      text = `${JSON.stringify(validate(document))}\n`;
      if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('The notebook is too large to save.');
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = queue.then(async () => {
      if (!loaded) throw new Error('Open the notebook before saving.');
      if (blocked) throw new Error('Saving is paused to preserve an unreadable notebook.');
      await fs.mkdir(directory, { recursive: true });
      try {
        const previous = await readDocument(filePath);
        await atomicWrite(backupPath, previous.text);
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`The current notebook could not be backed up: ${error.message}`);
      }
      await atomicWrite(filePath, text);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { load, save, flush: () => queue, filePath, backupPath };
}

module.exports = { createStore, basicValidate };
