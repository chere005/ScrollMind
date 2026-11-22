'use strict';

// Copy Scrolls and Grids to iCloud Drive: a one-way copy of every Scroll and Grid, made a few seconds after writing settles,
// at launch and before quitting, into iCloud Drive/ScrollMind/Scrolls and /Grids as <name>.sm. The writing folder
// (~/Documents/ScrollMind) stays exactly as it is; the copies are for reading elsewhere — another Mac, or the MindSuite
// ScrollMind tab, which opens a .sm with src/core/sm-file.mjs. A copy follows renames and is removed when its document is
// deleted. Each copy is a SQLite backup with journal_mode=DELETE, the same as File > Export > ScrollMind (.sm).
// Off until turned on (File > Copy to iCloud Drive).

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const KINDS = [
  { kind: 'scroll', folder: 'Scrolls', workspace: '', items: 'Scrolls', file: 'scroll.sm', fallback: 'Scroll' },
  { kind: 'grid', folder: 'Grids', workspace: 'Grids', items: 'Items', file: 'grid.smg', fallback: 'Grid' },
];
const SETTLE_MS = 8000;
const FLUSH_LIMIT_MS = 15000;

/** Where iCloud Drive lives on this computer, or null when it does not. */
function iCloudDriveRoot(home, platform = process.platform) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (platform === 'win32') return path.join(home, 'iCloudDrive');
  return null;
}

const inside = (file, dir) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const safeName = (name, fallback) => (typeof name === 'string' ? name : '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-').replace(/^[.\s]+|\s+$/g, '').slice(0, 80) || fallback;

function createICloudCopy({ dataDirectory, target, iCloudRoot = target ? path.dirname(target) : null, prefsFile, stateFile, log = () => {}, settleMs = SETTLE_MS, timers = { setTimeout, clearTimeout } } = {}) {
  if (!dataDirectory || !prefsFile || !stateFile) throw new Error('iCloud copy needs its folders.');
  const readJson = (file) => { try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return null; } };
  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`);
    await fs.rename(temporary, file);
  }
  /** Copies made, by document ({kind}:{id}): {name inside the target, fingerprint of the source}. Kept with the app's data. */
  const readState = () => { const state = readJson(stateFile); return state && state.copies && typeof state.copies === 'object' ? state : { copies: {} }; };

  let enabled = readJson(prefsFile)?.enabled === true;
  let timer = null;
  let running = Promise.resolve();
  let disposed = false;
  const available = () => Boolean(target && iCloudRoot && fsSync.existsSync(iCloudRoot));
  const report = (error) => log(`iCloud copy: ${error?.message ?? error}`);

  /** Every Scroll and Grid the writing folder holds, from each workspace's own list. */
  function documents() {
    const found = [];
    for (const kind of KINDS) {
      const manifest = readJson(path.join(dataDirectory, kind.workspace, 'workspace.json'));
      if (!manifest || !Array.isArray(manifest.scrolls)) continue;
      const taken = new Set();
      for (const scroll of manifest.scrolls) {
        if (!scroll || scroll.deleted || typeof scroll.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(scroll.id)) continue;
        let base = safeName(scroll.name, kind.fallback);
        if (taken.has(base.toLowerCase())) base = `${base} (${scroll.id.slice(0, 8)})`;
        taken.add(base.toLowerCase());
        found.push({
          key: `${kind.kind}:${scroll.id}`,
          source: scroll.id === 'main' ? path.join(dataDirectory, kind.workspace, kind.file) : path.join(dataDirectory, kind.workspace, kind.items, scroll.id, kind.file),
          name: path.join(kind.folder, `${base}.sm`),
        });
      }
    }
    return found;
  }

  /** What has to change for the copy to be stale: the database and its write-ahead log. */
  function fingerprint(source) {
    const part = (file) => { try { const stat = fsSync.statSync(file); return `${stat.size}:${stat.mtimeMs}`; } catch { return '-'; } };
    return `${part(source)}/${part(`${source}-wal`)}`;
  }

  async function copyDocument(document, destination) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
      const db = new DatabaseSync(document.source, { readOnly: true, allowExtension: false });
      try { await backup(db, temporary, { rate: 256 }); } finally { db.close(); }
      const copy = new DatabaseSync(temporary, { allowExtension: false });
      try { copy.exec('PRAGMA journal_mode=DELETE;'); } finally { copy.close(); }
      await fs.rename(temporary, destination);
    } finally {
      for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`]) await fs.rm(file, { force: true });
    }
  }

  async function removeCopy(name) {
    const destination = path.join(target, name);
    if (inside(destination, target)) await fs.rm(destination, { force: true });
  }

  function serial(job) { const next = running.then(job, job); running = next.catch(() => {}); return next; }

  /** Bring the copies up to date: copy what changed, follow renames, remove copies of deleted documents. */
  function sync() {
    return serial(async () => {
      if (!enabled || !available()) return { copied: 0, removed: 0 };
      const state = readState();
      const current = documents();
      const keys = new Set(current.map((document) => document.key));
      let copied = 0;
      let removed = 0;
      for (const document of current) {
        try {
          if (!fsSync.existsSync(document.source)) continue;
          const print = fingerprint(document.source);
          const known = state.copies[document.key];
          const destination = path.join(target, document.name);
          if (known && known.fingerprint === print && known.name === document.name && fsSync.existsSync(destination)) continue;
          await copyDocument(document, destination);
          if (known && known.name !== document.name) await removeCopy(known.name);
          state.copies[document.key] = { name: document.name, fingerprint: print };
          copied++;
        } catch (error) { report(error); }
      }
      for (const [key, known] of Object.entries(state.copies)) {
        if (keys.has(key)) continue;
        try { if (typeof known?.name === 'string') await removeCopy(known.name); delete state.copies[key]; removed++; } catch (error) { report(error); }
      }
      await writeJson(stateFile, state);
      if (copied || removed) log(`iCloud copy: ${copied} copied, ${removed} removed`);
      return { copied, removed };
    }).catch((error) => { report(error); return { copied: 0, removed: 0 }; });
  }

  /** Writing changed: bring the copies up to date once it settles. */
  function changed() {
    if (disposed || !enabled) return;
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = null; void sync(); }, settleMs);
    timer?.unref?.();
  }

  /** Bring the copies up to date now (before quitting), for at most FLUSH_LIMIT_MS. */
  async function flush() {
    if (timer === null || !enabled) return running;
    timers.clearTimeout(timer);
    timer = null;
    let limit;
    await Promise.race([sync(), new Promise((resolve) => { limit = setTimeout(resolve, FLUSH_LIMIT_MS); limit.unref?.(); })]);
    clearTimeout(limit);
  }

  async function setEnabled(value) {
    if (!value) await flush();
    enabled = Boolean(value);
    await writeJson(prefsFile, { enabled });
    if (enabled) return sync();
    return { copied: 0, removed: 0 };
  }

  return { changed, sync, flush, setEnabled, isEnabled: () => enabled, isAvailable: available, documents, dispose: () => { disposed = true; timers.clearTimeout(timer); } };
}

module.exports = { createICloudCopy, iCloudDriveRoot };
