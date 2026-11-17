'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./storage.cjs');

const VERSION = 1;
const MAX_SCROLLS = 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validId(id) {
  if (typeof id !== 'string' || (id !== 'main' && !UUID.test(id))) throw new TypeError('Choose a valid scroll.');
  return id;
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new TypeError('A scroll name needs 1–80 characters without control characters.');
  }
  return name.trim();
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The scroll workspace is unreadable.');
  if (value.version !== VERSION) {
    const error = new Error('This scroll workspace uses an unsupported version. Update ScrollMind before opening it.');
    error.code = 'UNSUPPORTED_WORKSPACE';
    throw error;
  }
  if (!Array.isArray(value.scrolls) || !value.scrolls.length || value.scrolls.length > MAX_SCROLLS) throw new Error('The scroll workspace has an invalid scroll list.');
  const ids = new Set();
  const scrolls = value.scrolls.map((scroll) => {
    if (!scroll || typeof scroll !== 'object' || Array.isArray(scroll)) throw new Error('The scroll workspace has an invalid scroll.');
    const id = validId(scroll.id);
    if (ids.has(id)) throw new Error('The scroll workspace contains a duplicate scroll.');
    ids.add(id);
    if (typeof scroll.open !== 'boolean') throw new Error('The scroll workspace has an invalid open state.');
    const descriptor = { id, name: validName(scroll.name), open: scroll.open };
    if (scroll.deleted !== undefined && typeof scroll.deleted !== 'boolean') throw new Error('The scroll workspace has an invalid deletion state.');
    if (scroll.deleted) {
      if (scroll.open) throw new Error('A deleted scroll cannot be open.');
      descriptor.deleted = true;
      if (scroll.archiveId !== undefined) {
        if (!UUID.test(scroll.archiveId)) throw new Error('The scroll workspace has an invalid deletion archive.');
        descriptor.archiveId = scroll.archiveId;
      }
    } else if (scroll.sourcePath !== undefined) {
      if (typeof scroll.sourcePath !== 'string' || scroll.sourcePath.length > 4096 || !path.isAbsolute(scroll.sourcePath) || scroll.sourcePath.includes('\0')) throw new Error('The scroll workspace has an invalid source file.');
      descriptor.sourcePath = path.normalize(scroll.sourcePath);
    }
    return descriptor;
  });
  validId(value.activeId);
  if (!ids.has('main') || !scrolls.some((scroll) => scroll.id === value.activeId && scroll.open && !scroll.deleted)) throw new Error('The scroll workspace has no active scroll.');
  return { version: VERSION, activeId: value.activeId, scrolls };
}

async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const WINDOWS = process.platform === 'win32';
const TRANSIENT_FS = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Windows: FlushFileBuffers needs write access, so files are synced through an 'r+' handle.
async function syncFile(file) {
  const handle = await fs.open(file, WINDOWS ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Windows cannot open a directory for fsync; NTFS journals metadata, so a completed rename is durable.
// Elsewhere (macOS/Linux) the directory is really fsynced.
async function syncDirectory(directory) {
  if (WINDOWS) return;
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

// Windows: antivirus/indexers briefly lock files, making rename fail with EPERM/EBUSY/EACCES. Bounded retry.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); }
    catch (error) {
      if (!WINDOWS || !TRANSIENT_FS.has(error.code) || attempt >= 10) throw error;
      // Windows reports rename-onto-a-directory as EPERM; surface the POSIX EISDIR instead of retrying.
      const target = await fs.stat(to).catch(() => null);
      if (target?.isDirectory() && !(await fs.stat(from).catch(() => null))?.isDirectory()) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, rename '${from}' -> '${to}'`), { code: 'EISDIR', syscall: 'rename', path: from, dest: to });
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function atomicWrite(file, content) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await renameWithRetry(temporary, file);
    // Rename is the commit point. Report committed state even if directory sync
    // is unavailable, so renderer state always matches the on-disk active ID.
    try { await syncDirectory(path.dirname(file)); }
    catch (error) { console.warn(`ScrollMind workspace directory sync will be retried: ${error.message}`); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function readManifest(file) {
  if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('The scroll workspace is too large to read safely.');
  return validateManifest(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function resolvedDestination(file) {
  const absolute = path.resolve(file);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await resolvedDestination(parent), path.basename(absolute));
  }
}

function createWorkspace(directory, options = {}) {
  const manifestPath = path.join(directory, 'workspace.json');
  const manifestBackupPath = path.join(directory, 'workspace.backup.json');
  const scrollsDirectory = path.join(directory, 'Scrolls');
  const deletedDirectory = path.join(directory, 'Deleted Scrolls');
  const stores = new Map();
  let manifest;
  let loaded = false;
  let blocked = false;
  let closed = false;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  }

  function requireWorkspace() {
    if (!loaded) throw new Error('Open the scroll workspace first.');
    if (blocked) throw new Error('The workspace is protected because its scroll list could not be read.');
    if (closed) throw new Error('The scroll workspace has been closed.');
  }

  function descriptor(id) {
    validId(id);
    const found = manifest?.scrolls.find((scroll) => scroll.id === id);
    if (!found) throw new Error('That scroll is not in this workspace.');
    if (found.deleted) throw new Error('That scroll has been deleted.');
    return found;
  }

  function storeDirectory(id) { return id === 'main' ? directory : path.join(scrollsDirectory, validId(id)); }

  async function ensureStore(id) {
    if (manifest?.scrolls.some((scroll) => scroll.id === id && scroll.deleted)) throw new Error('That scroll has been deleted.');
    let entry = stores.get(id);
    if (!entry) {
      entry = { store: createStore(storeDirectory(id), options), loaded: false };
      stores.set(id, entry);
    }
    let result;
    if (!entry.loaded) {
      result = await entry.store.load();
      if (result.error) throw new Error(result.error);
      entry.loaded = true;
    }
    return { store: entry.store, result };
  }

  async function activeStore() { requireWorkspace(); return (await ensureStore(manifest.activeId)).store; }

  function workspaceState() {
    if (!manifest) return { activeId: null, scrolls: [] };
    return { activeId: manifest.activeId, scrolls: manifest.scrolls.filter((scroll) => !scroll.deleted).map((scroll) => ({ id: scroll.id, name: scroll.name, open: scroll.open, active: scroll.id === manifest.activeId })) };
  }

  async function persist(next) {
    const normalized = validateManifest(next);
    const content = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('The scroll workspace has reached its maximum size.');
    await fs.mkdir(directory, { recursive: true });
    let previous;
    try { previous = await readManifest(manifestPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) await atomicWrite(manifestBackupPath, `${JSON.stringify(previous, null, 2)}\n`);
    else await atomicWrite(manifestBackupPath, content);
    await atomicWrite(manifestPath, content);
    manifest = normalized;
  }

  async function closeLoaded() {
    const errors = [];
    for (const entry of stores.values()) {
      if (!entry.loaded) continue;
      try { await entry.store.close(); entry.loaded = false; }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Some scrolls could not finish saving. Keep ScrollMind open and try again.');
  }

  async function discoverScrolls(reader) {
    let folders;
    try {
      if (!(await fs.lstat(scrollsDirectory)).isDirectory()) return false;
      folders = await fs.readdir(scrollsDirectory, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const known = new Set(manifest.scrolls.map((scroll) => scroll.id));
    const names = new Set(manifest.scrolls.map((scroll) => scroll.name));
    const next = structuredClone(manifest);
    let number = 1;
    for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!folder.isDirectory() || !UUID.test(folder.name) || known.has(folder.name) || next.scrolls.length >= MAX_SCROLLS) continue;
      const file = path.join(scrollsDirectory, folder.name, 'scroll.sm');
      try {
        if (!(await fs.lstat(file)).isFile()) continue;
        await reader.importFile(file);
      } catch { continue; } // Preserve malformed/future files for manual recovery.
      while (names.has(`Recovered scroll ${number}`)) number++;
      const name = `Recovered scroll ${number++}`;
      next.scrolls.push({ id: folder.name, name, open: true });
      names.add(name);
    }
    if (next.scrolls.length === manifest.scrolls.length) return false;
    await persist(next);
    return true;
  }

  function validateDeletion(value, archiveId) {
    if (!value || value.version !== 1 || value.archiveId !== archiveId || !UUID.test(archiveId)) throw new Error('A deleted scroll recovery record is unreadable.');
    validId(value.id);
    const name = validName(value.name);
    if (typeof value.deletedAt !== 'string' || !Number.isFinite(Date.parse(value.deletedAt))) throw new Error('A deleted scroll recovery record has an invalid date.');
    const replacement = value.replacement;
    if (!replacement || typeof replacement !== 'object') throw new Error('A deleted scroll recovery record has no replacement scroll.');
    const scrolls = replacement.id === 'main' ? [replacement] : [{ id: 'main', name: 'Scroll 1', open: false }, replacement];
    const normalized = validateManifest({ version: VERSION, activeId: replacement.id, scrolls });
    return { version: 1, id: value.id, name, deletedAt: value.deletedAt, archiveId, replacement: normalized.scrolls.find((scroll) => scroll.id === replacement.id) };
  }

  async function deletionRecords() {
    let folders;
    try {
      if (!(await fs.lstat(deletedDirectory)).isDirectory()) throw new Error('Deleted scroll recovery records cannot be read safely.');
      folders = await fs.readdir(deletedDirectory, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const folder of folders) {
      if (!UUID.test(folder.name)) continue; // Pending archives have not committed a deletion.
      if (!folder.isDirectory()) throw new Error('A deleted scroll recovery folder cannot be read safely.');
      const file = path.join(deletedDirectory, folder.name, 'deletion.json');
      if (!(await fs.lstat(file)).isFile() || (await fs.stat(file)).size > 1024 * 1024) throw new Error('A deleted scroll recovery record is unreadable.');
      records.push(validateDeletion(JSON.parse(await fs.readFile(file, 'utf8')), folder.name));
    }
    return records.sort((a, b) => a.deletedAt.localeCompare(b.deletedAt) || a.archiveId.localeCompare(b.archiveId));
  }

  async function moveDeletedOriginals(record) {
    const archive = path.join(deletedDirectory, record.archiveId);
    const names = ['scroll.sm', 'scroll.backup.sm', 'scroll.sm-wal', 'scroll.sm-shm'];
    let prefix = 'original-';
    for (const name of names) if (await exists(path.join(archive, `${prefix}${name}`))) { prefix = `original-${crypto.randomUUID()}-`; break; }
    for (const name of names) {
      const source = path.join(storeDirectory(record.id), name);
      if (await exists(source)) await renameWithRetry(source, path.join(archive, `${prefix}${name}`));
    }
  }

  async function reconcileDeletions() {
    const records = await deletionRecords();
    if (!records.length) return false;
    const next = structuredClone(manifest);
    const deleted = new Set(records.map((record) => record.id));
    for (const record of records) {
      let target = next.scrolls.find((scroll) => scroll.id === record.id);
      if (!target) { target = { id: record.id, name: record.name, open: false }; next.scrolls.push(target); }
      target.deleted = true; target.open = false; target.archiveId = record.archiveId;
      delete target.sourcePath;
      if (!deleted.has(record.replacement.id) && !next.scrolls.some((scroll) => scroll.id === record.replacement.id)) next.scrolls.push(record.replacement);
    }
    if (!next.scrolls.some((scroll) => scroll.id === next.activeId && !scroll.deleted && scroll.open)) {
      const replacement = [...records].reverse().map((record) => next.scrolls.find((scroll) => scroll.id === record.replacement.id && !scroll.deleted)).find(Boolean)
        || next.scrolls.find((scroll) => !scroll.deleted);
      if (!replacement) throw new Error('The deleted scroll recovery record has no usable replacement.');
      replacement.open = true; next.activeId = replacement.id;
    }
    const normalized = validateManifest(next);
    const changed = JSON.stringify(normalized) !== JSON.stringify(manifest);
    if (changed) {
      // Durable deletion records are authoritative even when the older manifest
      // cannot be refreshed yet. Never reopen a deleted main/legacy/orphan file.
      manifest = normalized;
      try { await persist(normalized); }
      catch (error) { console.warn(`ScrollMind deleted scroll list will be refreshed later: ${error.message}`); }
    }
    for (const record of records) {
      try { await moveDeletedOriginals(record); }
      catch (error) { console.warn(`ScrollMind deleted scroll cleanup will be retried: ${error.message}`); }
    }
    return changed;
  }

  function load() {
    return enqueue(async () => {
      if (loaded && !closed) await closeLoaded();
      stores.clear();
      loaded = true; blocked = false; closed = false;
      let recovered = false;
      try {
        try { manifest = await readManifest(manifestPath); }
        catch (error) {
          if (error.code === 'UNSUPPORTED_WORKSPACE') throw error;
          try {
            const restored = await readManifest(manifestBackupPath);
            if (error.code !== 'ENOENT') await renameWithRetry(manifestPath, `${manifestPath}.corrupt-${Date.now()}-${crypto.randomUUID()}`);
            await atomicWrite(manifestPath, `${JSON.stringify(restored, null, 2)}\n`);
            manifest = restored; recovered = true;
          } catch (backupError) {
            if (error.code !== 'ENOENT' || backupError.code !== 'ENOENT') throw backupError;
            manifest = { version: VERSION, activeId: 'main', scrolls: [{ id: 'main', name: 'Scroll 1', open: true }] };
            await persist(manifest);
          }
        }
        recovered = await reconcileDeletions() || recovered;
        const { store, result } = await ensureStore(manifest.activeId);
        recovered = await discoverScrolls(store) || recovered;
        return { ...(result || { document: await store.getSnapshot(), recovered: false }), recovered: recovered || result?.recovered || false, workspace: workspaceState() };
      } catch (error) {
        blocked = true;
        return { document: null, recovered: false, error: error.message, workspace: workspaceState() };
      }
    });
  }

  function availableScrollName(ignoredId) {
    const used = new Set(manifest.scrolls.filter((scroll) => !scroll.deleted && scroll.id !== ignoredId).map((scroll) => scroll.name.trim().toLowerCase()));
    if (!used.has('scroll')) return 'Scroll';
    for (let number = 1; ; number++) if (!used.has(`scroll ${number}`)) return `Scroll ${number}`;
  }

  async function prepareNewScroll({ name, document, settings, sourcePath } = {}, ignoredNameId) {
    if (manifest.scrolls.length >= MAX_SCROLLS) throw new Error('This workspace already contains the maximum number of scrolls.');
    const id = crypto.randomUUID();
    const nextDescriptor = { id, name: validName(name === undefined ? availableScrollName(ignoredNameId) : name), open: true, ...(sourcePath ? { sourcePath } : {}) };
    const { store } = await ensureStore(id);
    if (document !== undefined) await store.save(document);
    else if (settings !== undefined) await store.saveChanges({ settings, view: { offsetY: 0 } });
    return { descriptor: nextDescriptor, document: await store.getSnapshot() };
  }

  async function selectInternal(id) {
    requireWorkspace();
    const selected = descriptor(id);
    const { store } = await ensureStore(id);
    const document = await store.getSnapshot();
    if (manifest.activeId !== id || !selected.open) {
      const next = structuredClone(manifest);
      next.activeId = id;
      next.scrolls.find((scroll) => scroll.id === id).open = true;
      await persist(next);
    }
    return { document, workspace: workspaceState() };
  }

  function newScroll(options = {}) {
    const copy = structuredClone(options);
    return enqueue(async () => {
      requireWorkspace();
      if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError('Choose valid new scroll options.');
      const prepared = await prepareNewScroll(copy);
      const next = structuredClone(manifest);
      next.activeId = prepared.descriptor.id;
      next.scrolls.push(prepared.descriptor);
      await persist(next);
      return { document: prepared.document, workspace: workspaceState() };
    });
  }

  function selectScroll(id) { return enqueue(() => selectInternal(id)); }

  function closeScroll(id) {
    return enqueue(async () => {
      requireWorkspace();
      const closing = descriptor(id);
      if (!closing.open) return { document: await (await activeStore()).getSnapshot(), workspace: workspaceState() };
      const next = structuredClone(manifest);
      next.scrolls.find((scroll) => scroll.id === id).open = false;
      let document;
      if (id === manifest.activeId) {
        const nextOpen = next.scrolls.filter((scroll) => scroll.open);
        if (nextOpen.length) {
          next.activeId = nextOpen.at(-1).id;
          document = await (await ensureStore(next.activeId)).store.getSnapshot();
        } else {
          const current = await (await activeStore()).getSnapshot();
          const prepared = await prepareNewScroll({ settings: current.settings });
          next.scrolls.push(prepared.descriptor);
          next.activeId = prepared.descriptor.id;
          document = prepared.document;
        }
      } else document = await (await activeStore()).getSnapshot();
      await persist(next);
      return { document, workspace: workspaceState() };
    });
  }

  function renameScroll(id, name) {
    return enqueue(async () => {
      requireWorkspace(); descriptor(id);
      const normalized = validName(name);
      const document = await (await activeStore()).getSnapshot();
      const next = structuredClone(manifest);
      next.scrolls.find((scroll) => scroll.id === id).name = normalized;
      await persist(next);
      return { document, workspace: workspaceState() };
    });
  }

  function deleteScroll(id) {
    return enqueue(async () => {
      requireWorkspace();
      const target = descriptor(id);
      // Detect a newer/invalid manifest before making a durable deletion intent.
      await readManifest(manifestPath);
      const next = structuredClone(manifest);
      let document;
      if (id === manifest.activeId) {
        const other = next.scrolls.filter((scroll) => scroll.id !== id && scroll.open && !scroll.deleted).at(-1);
        if (other) {
          next.activeId = other.id;
          document = await (await ensureStore(other.id)).store.getSnapshot();
        } else {
          const current = await (await activeStore()).getSnapshot();
          const prepared = await prepareNewScroll({ settings: current.settings }, id);
          next.scrolls.push(prepared.descriptor); next.activeId = prepared.descriptor.id;
          document = prepared.document;
        }
      } else document = await (await activeStore()).getSnapshot();
      const archiveId = crypto.randomUUID();
      const archive = path.join(deletedDirectory, archiveId);
      const pending = path.join(deletedDirectory, `Pending-${archiveId}`);
      const deleted = next.scrolls.find((scroll) => scroll.id === id);
      deleted.deleted = true; deleted.open = false; deleted.archiveId = archiveId;
      delete deleted.sourcePath;
      const normalized = validateManifest(next);
      if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 1024 * 1024) throw new Error('The scroll workspace has reached its maximum size.');
      await fs.mkdir(pending, { recursive: true });
      const { store } = await ensureStore(id);
      await store.close();
      stores.get(id).loaded = false;
      // Keep originals in place until a complete recoverable archive is durable.
      for (const name of ['scroll.sm', 'scroll.backup.sm', 'scroll.sm-wal', 'scroll.sm-shm']) {
        const source = path.join(storeDirectory(id), name);
        if (!(await exists(source))) continue;
        const copy = path.join(pending, name);
        await fs.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
        await syncFile(copy);
      }
      const record = validateDeletion({ version: 1, id, name: target.name, archiveId, deletedAt: new Date().toISOString(), replacement: normalized.scrolls.find((scroll) => scroll.id === normalized.activeId) }, archiveId);
      await atomicWrite(path.join(pending, 'deletion.json'), `${JSON.stringify(record, null, 2)}\n`);
      await renameWithRetry(pending, archive); // Logical commit: the deletion is now recoverable and durable.
      try { await syncDirectory(deletedDirectory); }
      catch (error) { console.warn(`ScrollMind deletion archive directory sync will be retried: ${error.message}`); }
      manifest = normalized;
      stores.delete(id);
      try { await persist(normalized); }
      catch (error) { console.warn(`ScrollMind deleted scroll list will be refreshed later: ${error.message}`); }
      try { await moveDeletedOriginals(record); }
      catch (error) { console.warn(`ScrollMind deleted scroll cleanup will be retried: ${error.message}`); }
      return { document, workspace: workspaceState() };
    });
  }

  async function assertExportDestination(destination) {
    requireWorkspace();
    if (typeof destination !== 'string' || !destination) throw new TypeError('Choose an export file.');
    const resolved = await resolvedDestination(destination);
    for (const folder of [scrollsDirectory, deletedDirectory]) {
      const managed = await resolvedDestination(folder);
      const relative = path.relative(managed.toLowerCase(), resolved.toLowerCase());
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Choose an export file outside the managed scroll folders.');
    }
    const protectedFiles = [manifestPath, manifestBackupPath, path.join(directory, 'notebook.scrollmind.json'), path.join(directory, 'notebook.backup.json')];
    for (const id of new Set(['main', ...manifest.scrolls.map((scroll) => scroll.id), ...stores.keys()])) {
      const base = path.join(storeDirectory(id), 'scroll.sm');
      protectedFiles.push(base, path.join(storeDirectory(id), 'scroll.backup.sm'), `${base}-wal`, `${base}-shm`);
    }
    for (const scroll of manifest.scrolls.filter((item) => item.deleted && item.archiveId)) {
      for (const name of ['scroll.sm', 'scroll.backup.sm', 'deletion.json', 'original-scroll.sm', 'original-scroll.backup.sm']) protectedFiles.push(path.join(deletedDirectory, scroll.archiveId, name));
    }
    for (const protectedFile of protectedFiles) {
      if (resolved.toLowerCase() === (await resolvedDestination(protectedFile)).toLowerCase()) throw new Error('Choose a different export file so your workspace scrolls stay safe.');
      try {
        const [target, protectedStat] = await Promise.all([fs.stat(resolved, { bigint: true }), fs.stat(protectedFile, { bigint: true })]);
        if (target.dev === protectedStat.dev && target.ino === protectedStat.ino) throw new Error('Choose a different export file so your workspace scrolls stay safe.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return destination;
  }

  function openScroll(sourcePath) {
    return enqueue(async () => {
      requireWorkspace();
      if (typeof sourcePath !== 'string' || !sourcePath) throw new TypeError('Choose a ScrollMind scroll to open.');
      const source = await fs.realpath(sourcePath);
      const known = manifest.scrolls.find((scroll) => !scroll.deleted && ((scroll.sourcePath && scroll.sourcePath.toLowerCase() === source.toLowerCase()) || path.resolve(storeDirectory(scroll.id), 'scroll.sm').toLowerCase() === source.toLowerCase()));
      if (known) return selectInternal(known.id);
      const document = await (await activeStore()).importFile(source);
      const importedName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || 'Imported scroll';
      const prepared = await prepareNewScroll({ name: importedName, document, sourcePath: source });
      const next = structuredClone(manifest);
      next.activeId = prepared.descriptor.id;
      next.scrolls.push(prepared.descriptor);
      await persist(next);
      return { document: prepared.document, workspace: workspaceState() };
    });
  }

  function save(document) { const copy = structuredClone(document); return enqueue(async () => (await activeStore()).save(copy)); }
  function saveChanges(changes) {
    const copy = structuredClone(changes);
    return enqueue(async () => {
      requireWorkspace();
      if (copy?.scrollId !== undefined && copy.scrollId !== manifest.activeId) throw new Error('This save belongs to a different scroll.');
      return (await activeStore()).saveChanges(copy);
    });
  }
  function getSnapshot() { return enqueue(async () => (await activeStore()).getSnapshot()); }
  function importFile(file) { return enqueue(async () => (await activeStore()).importFile(file)); }
  function exportFile(file) { return enqueue(async () => (await activeStore()).exportFile(await assertExportDestination(file))); }
  function flush() {
    return enqueue(async () => {
      const errors = [];
      for (const entry of stores.values()) if (entry.loaded) try { await entry.store.flush(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Some scrolls could not finish saving.');
    });
  }
  function close() { return enqueue(async () => { if (closed) return; await closeLoaded(); closed = true; }); }

  return {
    load, save, saveChanges, getSnapshot, importFile, exportFile, backup: exportFile,
    flush, close, newScroll, selectScroll, closeScroll, deleteScroll, renameScroll, openScroll, workspaceState,
    assertExportDestination: file => enqueue(() => assertExportDestination(file)),
    get filePath() { return path.join(storeDirectory(manifest?.activeId || 'main'), 'scroll.sm'); },
    get backupPath() { return path.join(storeDirectory(manifest?.activeId || 'main'), 'scroll.backup.sm'); },
  };
}

module.exports = { createWorkspace };
