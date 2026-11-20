'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');

const APPLICATION_ID = 0x534d4e44; // SMND
const SCHEMA_VERSION = 5; // 5: strokes may be fills (pen_type 'fill')
const GRID_FORMAT = Object.freeze({ applicationId: 0x534d4752, version: 2, ext: 'smg', name: 'grid' }); // 2: strokes may be fills
const SCROLL_FORMAT = Object.freeze({ applicationId: APPLICATION_ID, version: SCHEMA_VERSION, ext: 'sm', name: 'scroll' });
const formatFor = kind => kind === 'grid' ? GRID_FORMAT : SCROLL_FORMAT;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const BACKUP_INTERVAL = 5 * 60 * 1000;
const MAX_STROKES = 100_000;
const MAX_POINTS = 5_000_000;
const COLUMNS = {
  strokes: ['id', 'order_index', 'color', 'width', 'points', 'bounds'],
  markers: ['id', 'y', 'label', 'kind'],
  metadata: ['key', 'value'],
};

class UnsupportedScrollError extends Error {
  constructor(message) { super(message); this.code = 'UNSUPPORTED_SCROLL'; }
}

function basicValidate(document) {
  if (!document || typeof document !== 'object' || document.version !== 1 || !Array.isArray(document.strokes)) {
    throw new Error('This is not a supported ScrollMind scroll.');
  }
  return document;
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

async function exists(file) {
  try { await fs.stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function verifySchema(db, format) {
  if (db.prepare('PRAGMA application_id').get().application_id !== format.applicationId) {
    throw new UnsupportedScrollError(`This file is not a ScrollMind ${format.name}.`);
  }
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1 || version > format.version) {
    throw new UnsupportedScrollError('This scroll uses an unsupported format version. Update ScrollMind before opening it.');
  }
  for (const [table, originalColumns] of Object.entries(COLUMNS)) {
    const columns = table === 'strokes' && hasPenType(format, version) ? [...originalColumns, 'pen_type'] : originalColumns;
    const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    if (actual.length !== columns.length || columns.some((column, index) => column !== actual[index])) {
      throw new Error('The scroll database has a damaged table layout.');
    }
    if (db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(table)?.type !== 'table') {
      throw new Error('The scroll database has an invalid table layout.');
    }
  }
  if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw new Error('The scroll database is damaged.');
  return version;
}

function hasPenType(format, version) { return format === GRID_FORMAT || version >= 2; }

function snapshotFromDatabase(db, validate, format) {
  const version = verifySchema(db, format);
  const metadata = new Map(db.prepare('SELECT key, value FROM metadata').all().map((row) => [row.key, JSON.parse(row.value)]));
  if (!metadata.has('view') || !metadata.has('settings')) throw new Error('The scroll is missing its settings.');
  const rows = db.prepare(`SELECT id, color, width, points, ${hasPenType(format, version) ? 'pen_type' : 'NULL AS pen_type'} FROM strokes ORDER BY order_index, rowid LIMIT 100001`).all();
  const markers = db.prepare('SELECT id, y, label, kind FROM markers ORDER BY y, rowid LIMIT 10001').all().map((row) => ({ ...row }));
  return validate({
    version: 1,
    strokes: rows.map((row) => ({ id: row.id, color: row.color, width: row.width, points: JSON.parse(row.points), ...(row.pen_type === null ? {} : { penType: row.pen_type }) })),
    markers, view: metadata.get('view'), settings: metadata.get('settings'), diagram: metadata.get('diagram'),
  });
}

async function readNative(file, validate, format) {
  if ((await fs.stat(file)).size > MAX_FILE_BYTES) throw new Error('The scroll is too large to open safely.');
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    return snapshotFromDatabase(db, validate, format);
  } finally { db.close(); }
}

function createStore(directory, { validate, kind } = {}) {
  const format = formatFor(kind);
  const filePath = path.join(directory, `${format.name}.${format.ext}`);
  const backupPath = path.join(directory, `${format.name}.backup.${format.ext}`);
  const legacyPath = path.join(directory, 'notebook.scrollmind.json');
  const legacyBackupPath = path.join(directory, 'notebook.backup.json');
  let queue = Promise.resolve();
  let loaded = false;
  let blocked = false;
  let closed = false;
  let db;
  let statements;
  let model;
  let boundsOf;
  let lastBackupAt = 0;
  let backupHasWriting = false;
  let dirtySinceBackup = false;
  let nextBackupAttemptAt = 0;
  let backupWarning = false;

  function enqueue(operation) {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  }

  async function ensureValidator() {
    const core = await import('../core/model.mjs');
    if (format === GRID_FORMAT && !boundsOf) {
      const validateDocument = validate || core.validateSnapshot;
      validate = document => validateDocument({ ...document, settings: { ...document.settings, mode: 'grid' } });
    }
    validate ||= core.validateSnapshot;
    boundsOf ||= core.boundsOf;
  }

  function setModel(snapshot) {
    model = {
      entries: new Map(snapshot.strokes.map((stroke) => [stroke.id, { stroke, points: JSON.stringify(stroke.points) }])),
      order: snapshot.strokes.map((stroke) => stroke.id),
      indices: new Map(snapshot.strokes.map((stroke, index) => [stroke.id, index])),
      pointCount: snapshot.strokes.reduce((total, stroke) => total + stroke.points.length, 0),
      markers: snapshot.markers, view: snapshot.view, settings: snapshot.settings, diagram: snapshot.diagram,
    };
  }

  function currentSnapshot() {
    return {
      version: 1, strokes: model.order.map((id) => model.entries.get(id).stroke),
      markers: model.markers, view: model.view, settings: model.settings,
      ...(model.diagram ? { diagram: model.diagram } : {}),
    };
  }

  function requireWritable() {
    if (!loaded) throw new Error('Open the scroll before saving.');
    if (blocked) throw new Error('Saving is paused to preserve an unreadable scroll.');
    if (closed || !db) throw new Error('The scroll has been closed.');
  }

  function openWritable(create = false) {
    db = new DatabaseSync(filePath, { allowExtension: false });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
    if (create) {
      db.exec(`BEGIN IMMEDIATE;
        PRAGMA application_id=${format.applicationId}; PRAGMA user_version=${format.version};
        CREATE TABLE strokes (id TEXT PRIMARY KEY, order_index INTEGER NOT NULL, color TEXT NOT NULL, width REAL NOT NULL, points TEXT NOT NULL, bounds TEXT NOT NULL, pen_type TEXT DEFAULT NULL);
        CREATE INDEX strokes_order ON strokes(order_index);
        CREATE TABLE markers (id TEXT PRIMARY KEY, y REAL NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL);
        CREATE INDEX markers_position ON markers(y);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        COMMIT;`);
    } else if (format === SCROLL_FORMAT && db.prepare('PRAGMA user_version').get().user_version === 1) {
      // Native v1 styles remain NULL, preserving legacy pressure appearance.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`ALTER TABLE strokes ADD COLUMN pen_type TEXT DEFAULT NULL; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    } else if (db.prepare('PRAGMA user_version').get().user_version < format.version) {
      // New metadata and brush types share the existing table layout.
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(`PRAGMA user_version=${format.version}; COMMIT;`); }
      catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
    statements = {
      remove: db.prepare('DELETE FROM strokes WHERE id = ?'),
      upsert: db.prepare('INSERT INTO strokes (id,order_index,color,width,points,bounds,pen_type) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET order_index=excluded.order_index,color=excluded.color,width=excluded.width,points=excluded.points,bounds=excluded.bounds,pen_type=excluded.pen_type'),
      reorder: db.prepare('UPDATE strokes SET order_index = ? WHERE id = ? AND order_index <> ?'),
      markerRemove: db.prepare('DELETE FROM markers WHERE id = ?'),
      markerUpsert: db.prepare('INSERT INTO markers (id,y,label,kind) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET y=excluded.y,label=excluded.label,kind=excluded.kind'),
      metadata: db.prepare('INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE metadata.value <> excluded.value'),
    };
  }

  async function assertExportDestination(destination) {
    if (typeof destination !== 'string' || !destination.length) throw new TypeError('Choose a file for the exported scroll.');
    const resolved = path.resolve(destination);
    for (const protectedFile of [filePath, backupPath, `${filePath}-wal`, `${filePath}-shm`]) {
      if (resolved.toLowerCase() === path.resolve(protectedFile).toLowerCase()) throw new Error('Choose a different file so the active scroll and its backup stay safe.');
      try {
        const [target, protectedStat] = await Promise.all([fs.stat(resolved, { bigint: true }), fs.stat(protectedFile, { bigint: true })]);
        if (target.dev === protectedStat.dev && target.ino === protectedStat.ino) throw new Error('Choose a different file so the active scroll and its backup stay safe.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return resolved;
  }

  async function writeBackup(destination) {
    const parent = path.dirname(destination);
    await fs.mkdir(parent, { recursive: true });
    const temporary = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
      await sqliteBackup(db, temporary, { rate: 256 });
      const copy = new DatabaseSync(temporary, { allowExtension: false });
      try { copy.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); } finally { copy.close(); }
      await syncFile(temporary);
      await renameWithRetry(temporary, destination);
      await syncDirectory(parent);
    } finally {
      for (const file of [temporary, `${temporary}-wal`, `${temporary}-shm`]) await fs.unlink(file).catch(() => {});
    }
  }

  async function refreshBackup() {
    await writeBackup(backupPath);
    lastBackupAt = Date.now();
    backupHasWriting = hasWriting();
    dirtySinceBackup = false;
    nextBackupAttemptAt = 0;
    backupWarning = false;
  }

  function applyChanges(changes) {
    requireWritable();
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Scroll changes must be an object.');
    const removals = changes.removals === undefined ? [] : changes.removals;
    if (!Array.isArray(removals) || removals.some((id) => typeof id !== 'string')) throw new TypeError('Removed strokes must be IDs.');
    const removed = new Set(removals);
    const partial = validate({
      version: 1,
      strokes: changes.upserts === undefined ? [] : changes.upserts,
      markers: changes.markers === undefined ? [] : changes.markers,
      view: changes.view === undefined ? model.view : changes.view,
      settings: changes.settings === undefined ? model.settings : changes.settings,
      diagram: changes.diagram,
    });
    const prepared = [];
    const newIds = [];
    let count = model.entries.size;
    let pointCount = model.pointCount;
    for (const id of removed) {
      const old = model.entries.get(id);
      if (old) { count--; pointCount -= old.stroke.points.length; }
    }
    for (const stroke of partial.strokes) {
      if (removed.has(stroke.id)) throw new TypeError('A stroke cannot be saved and removed in the same change.');
      const old = model.entries.get(stroke.id);
      if (old) pointCount -= old.stroke.points.length;
      else { count++; newIds.push(stroke.id); }
      pointCount += stroke.points.length;
      const points = JSON.stringify(stroke.points);
      if (!old || old.points !== points || old.stroke.color !== stroke.color || old.stroke.width !== stroke.width || old.stroke.penType !== stroke.penType) {
        prepared.push({ stroke, points, bounds: JSON.stringify(boundsOf([stroke])) });
      }
    }
    if (count > MAX_STROKES || pointCount > MAX_POINTS) throw new TypeError('The scroll contains too much writing.');
    let order = model.order;
    if (changes.order !== undefined) {
      if (!Array.isArray(changes.order) || changes.order.length !== count || new Set(changes.order).size !== count) throw new TypeError('Stroke order must contain every stroke exactly once.');
      const additions = new Set(newIds);
      if (changes.order.some((id) => removed.has(id) || (!model.entries.has(id) && !additions.has(id)))) throw new TypeError('Stroke order contains an unknown ID.');
      order = [...changes.order];
    } else if (removed.size || newIds.length) order = [...model.order.filter((id) => !removed.has(id)), ...newIds];
    const indices = order === model.order ? model.indices : new Map(order.map((id, index) => [id, index]));
    const nextMarkers = changes.markers === undefined ? model.markers : partial.markers;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of removed) statements.remove.run(id);
      for (const { stroke, points, bounds } of prepared) statements.upsert.run(stroke.id, indices.get(stroke.id), stroke.color, stroke.width, points, bounds, stroke.penType ?? null);
      if (order !== model.order) for (const [id, index] of indices) if (model.indices.get(id) !== index) statements.reorder.run(index, id, index);
      if (changes.markers !== undefined) {
        const oldMarkers = new Map(model.markers.map((marker) => [marker.id, marker]));
        const nextMarkerIds = new Set(nextMarkers.map((marker) => marker.id));
        for (const id of oldMarkers.keys()) if (!nextMarkerIds.has(id)) statements.markerRemove.run(id);
        for (const marker of nextMarkers) if (JSON.stringify(oldMarkers.get(marker.id)) !== JSON.stringify(marker)) statements.markerUpsert.run(marker.id, marker.y, marker.label, marker.kind);
      }
      statements.metadata.run('view', JSON.stringify(partial.view));
      statements.metadata.run('settings', JSON.stringify(partial.settings));
      if (changes.diagram !== undefined) statements.metadata.run('diagram', JSON.stringify(partial.diagram ?? { nodes: [], connections: [] }));
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    for (const id of removed) model.entries.delete(id);
    for (const entry of prepared) model.entries.set(entry.stroke.id, { stroke: entry.stroke, points: entry.points });
    model.order = order; model.indices = indices; model.pointCount = pointCount;
    model.markers = nextMarkers; model.view = partial.view; model.settings = partial.settings;
    if (changes.diagram !== undefined) model.diagram = partial.diagram;
    dirtySinceBackup = true;
  }

  function hasWriting() { return model.entries.size > 0 || model.markers.length > 0 || Boolean(model.diagram?.nodes.length); }

  async function maybeBackup() {
    if (Date.now() < nextBackupAttemptAt) return;
    if (!lastBackupAt || Date.now() - lastBackupAt >= BACKUP_INTERVAL || (!backupHasWriting && hasWriting())) {
      // The transaction is already durable. A maintenance failure must not make the
      // renderer treat a committed import as rejected and keep editing stale data.
      try { await refreshBackup(); }
      catch (error) {
        nextBackupAttemptAt = Date.now() + 60_000;
        if (!backupWarning) console.warn(`ScrollMind backup maintenance will be retried: ${error.message}`);
        backupWarning = true;
      }
    }
  }

  async function legacySnapshot() {
    let firstError;
    for (const [index, legacy] of [legacyPath, legacyBackupPath].entries()) {
      try {
        if ((await fs.stat(legacy)).size > MAX_FILE_BYTES) throw new Error('The legacy scroll is too large to open safely.');
        const source = JSON.parse(await fs.readFile(legacy, 'utf8'));
        if (source.version !== 1) throw new UnsupportedScrollError('This legacy scroll uses an unsupported format version.');
        return { document: validate(source), recovered: index === 1 };
      } catch (error) {
        if (error.code === 'UNSUPPORTED_SCROLL') throw error;
        if (index === 0) firstError = error;
        else if (firstError.code === 'ENOENT' && error.code === 'ENOENT') return null;
      }
    }
    throw new Error('The legacy scroll and its backup could not be read.');
  }

  async function preserveCorrupt(suffix = `.corrupt-${Date.now()}-${crypto.randomUUID()}`) {
    for (const extension of ['', '-wal', '-shm']) {
      const file = `${filePath}${extension}`;
      if (await exists(file)) await renameWithRetry(file, `${filePath}${suffix}${extension}`);
    }
  }

  function load() {
    return enqueue(async () => {
      await ensureValidator();
      if (db) { db.close(); db = null; }
      closed = false; loaded = true; blocked = false;
      await fs.mkdir(directory, { recursive: true });
      let recovered = false;
      let migrated = false;
      let snapshot;
      let createdThisLoad = false;
      try {
        if (await exists(filePath)) {
          try { snapshot = await readNative(filePath, validate, format); }
          catch (error) {
            if (error.code === 'UNSUPPORTED_SCROLL') throw error;
            snapshot = await readNative(backupPath, validate, format);
            await preserveCorrupt();
            recovered = true;
          }
        } else if (await exists(backupPath)) { snapshot = await readNative(backupPath, validate, format); recovered = true; }
        else if (format === SCROLL_FORMAT) {
          const legacy = await legacySnapshot();
          if (legacy) { snapshot = legacy.document; recovered = legacy.recovered; migrated = true; }
        }
        if (!(await exists(filePath))) {
          createdThisLoad = true;
          openWritable(true);
          setModel(validate({ version: 1, strokes: [] }));
          applyChanges(snapshot ? { upserts: snapshot.strokes, order: snapshot.strokes.map((stroke) => stroke.id), markers: snapshot.markers, view: snapshot.view, settings: snapshot.settings, diagram: snapshot.diagram } : {});
        } else { openWritable(); setModel(snapshot); }
        if (snapshot) await refreshBackup();
        return { document: snapshot ? structuredClone(currentSnapshot()) : null, recovered, ...(migrated ? { migrated: true } : {}) };
      } catch (error) {
        if (db) { try { db.close(); } catch {} db = null; }
        if (createdThisLoad) await preserveCorrupt(`.incomplete-${Date.now()}-${crypto.randomUUID()}`).catch(() => {});
        blocked = true;
        return { document: null, recovered: false, error: error.code === 'UNSUPPORTED_SCROLL' ? error.message : 'ScrollMind could not read your scroll or its backup. Your files were preserved. Open the writing folder to recover them before saving.' };
      }
    });
  }

  function saveChanges(changes) {
    const copy = structuredClone(changes);
    return enqueue(async () => { await ensureValidator(); applyChanges(copy); await maybeBackup(); });
  }

  function save(snapshot) {
    const copy = structuredClone(snapshot);
    return enqueue(async () => {
      await ensureValidator(); requireWritable();
      const normalized = validate(copy);
      const incoming = new Set(normalized.strokes.map((stroke) => stroke.id));
      const removals = model.order.filter((id) => !incoming.has(id));
      applyChanges({ upserts: normalized.strokes, removals, order: normalized.strokes.map((stroke) => stroke.id), markers: normalized.markers, view: normalized.view, settings: normalized.settings, diagram: normalized.diagram ?? { nodes: [], connections: [] } });
      await maybeBackup();
    });
  }

  function flush() { return enqueue(() => { if (db && !closed && !blocked) db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }); }
  function getSnapshot() { return enqueue(() => { requireWritable(); return structuredClone(currentSnapshot()); }); }
  function exportFile(destination) { return enqueue(async () => { requireWritable(); await writeBackup(await assertExportDestination(destination)); }); }
  function importFile(source) { return enqueue(async () => { await ensureValidator(); return readNative(source, validate, format); }); }
  function close() {
    return enqueue(async () => {
      if (!db || closed) return;
      // A failed final backup/checkpoint leaves the connection usable for a later retry.
      if (!blocked) { if (dirtySinceBackup) await refreshBackup(); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      db.close(); db = null; closed = true;
    });
  }

  return { load, save, saveChanges, flush, getSnapshot, exportFile, backup: exportFile, importFile, close, filePath, backupPath };
}

module.exports = { formatFor, createStore, basicValidate, APPLICATION_ID, SCHEMA_VERSION };
