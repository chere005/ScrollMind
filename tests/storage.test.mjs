import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { validateSnapshot } from '../src/core/model.mjs';

const { createStore, APPLICATION_ID } = createRequire(import.meta.url)('../src/main/storage.cjs');
const stroke = (id, x = 1) => ({ id, color: '#243743', width: 3, points: [{ x, y: -1250.125, p: 0.1734567890123456 }, { x: x + 10.01, y: -1200.7654321, p: 0.9 }] });
const document = (id = 'one') => validateSnapshot({ version: 1, strokes: [stroke(id)], markers: [{ id: 'section-1', y: -1300, label: 'Above the start', kind: 'section' }], view: { offsetY: -1500.25 }, settings: { color: '#243743', width: 3, paper: 'dots', paperTone: 'parchment' } });

async function temporary(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-storage-'));
  const stores = [];
  const fresh = () => { const store = createStore(directory, options); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store: fresh(), fresh };
}

function inspect(file, callback) {
  const db = new DatabaseSync(file, { allowExtension: false });
  try { return callback(db); } finally { db.close(); }
}

test('migrates legacy JSON losslessly into identified SQLite and preserves original bytes', async (t) => {
  const { directory, store } = await temporary(t);
  const original = `${JSON.stringify(document())}\n`;
  const legacy = path.join(directory, 'notebook.scrollmind.json');
  await fs.writeFile(legacy, original);
  assert.deepEqual(await store.load(), { document: document(), recovered: false, migrated: true });
  assert.equal(await fs.readFile(legacy, 'utf8'), original);
  assert.equal((await fs.readFile(store.filePath)).subarray(0, 16).toString(), 'SQLite format 3\0');
  inspect(store.filePath, (db) => {
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, APPLICATION_ID);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM strokes').get().n, 1);
  });
});

test('recovers valid legacy backup while preserving a malformed original', async (t) => {
  const { directory, store } = await temporary(t);
  const legacy = path.join(directory, 'notebook.scrollmind.json');
  await fs.writeFile(legacy, '{broken');
  await fs.writeFile(path.join(directory, 'notebook.backup.json'), JSON.stringify(document()));
  const loaded = await store.load();
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.migrated, true);
  assert.deepEqual(loaded.document, document());
  assert.equal(await fs.readFile(legacy, 'utf8'), '{broken');
});

test('incremental saves touch only changed stroke rows and never revisit old points for camera changes', async (t) => {
  let visitedPoints = 0;
  const validate = (snapshot) => {
    visitedPoints += snapshot.strokes.reduce((sum, item) => sum + item.points.length, 0);
    return validateSnapshot(snapshot);
  };
  const { store } = await temporary(t, { validate });
  await store.load();
  const initial = document();
  initial.strokes.push(stroke('two', 20));
  await store.save(initial);
  inspect(store.filePath, (db) => db.exec(`
    CREATE TABLE writes (kind TEXT, id TEXT);
    CREATE TRIGGER stroke_insert AFTER INSERT ON strokes BEGIN INSERT INTO writes VALUES ('insert', NEW.id); END;
    CREATE TRIGGER stroke_update AFTER UPDATE ON strokes BEGIN INSERT INTO writes VALUES ('update', NEW.id); END;
    CREATE TRIGGER stroke_delete AFTER DELETE ON strokes BEGIN INSERT INTO writes VALUES ('delete', OLD.id); END;
  `));
  visitedPoints = 0;
  await store.saveChanges({ view: { offsetY: -5000 }, settings: initial.settings });
  assert.equal(visitedPoints, 0);
  assert.deepEqual(inspect(store.filePath, (db) => db.prepare('SELECT * FROM writes').all()), []);
  await store.save(initial);
  assert.deepEqual(inspect(store.filePath, (db) => db.prepare('SELECT * FROM writes').all()), []);
  visitedPoints = 0;
  await store.saveChanges({ upserts: [stroke('one', 100)] });
  assert.equal(visitedPoints, 2);
  assert.deepEqual(inspect(store.filePath, (db) => db.prepare('SELECT * FROM writes').all().map((row) => ({ ...row }))), [{ kind: 'update', id: 'one' }]);
  const snapshot = await store.getSnapshot();
  assert.equal(snapshot.strokes[0].points[0].x, 100);
  assert.deepEqual(snapshot.strokes[1], stroke('two', 20));
});

test('failed SQL transaction rolls back both writing and metadata without poisoning the cache', async (t) => {
  const { store } = await temporary(t);
  await store.load();
  await store.save(document());
  inspect(store.filePath, (db) => db.exec(`CREATE TRIGGER reject_view BEFORE UPDATE ON metadata WHEN NEW.key='view' AND NEW.value='{"offsetY":777}' BEGIN SELECT RAISE(ABORT, 'simulated save failure'); END;`));
  await assert.rejects(store.saveChanges({ upserts: [stroke('one', 999)], markers: [], view: { offsetY: 777 } }), /simulated save failure/);
  assert.deepEqual(await store.getSnapshot(), document());
  assert.equal(inspect(store.filePath, (db) => JSON.parse(db.prepare("SELECT points FROM strokes WHERE id='one'").get().points)[0].x), 1);
  await store.saveChanges({ view: { offsetY: 888 } });
  assert.equal((await store.getSnapshot()).view.offsetY, 888);
});

test('coarse backup is not recopied on every camera edit and clean close checkpoints latest writing', async (t) => {
  const { store, fresh } = await temporary(t);
  await store.load();
  await store.save(document());
  const firstBackup = await fs.readFile(store.backupPath);
  await store.saveChanges({ upserts: [stroke('one', 200)], view: { offsetY: -8000 } });
  await store.saveChanges({ view: { offsetY: -9000 } });
  assert.deepEqual(await fs.readFile(store.backupPath), firstBackup);
  await store.flush();
  await store.close();
  const reopened = fresh();
  const loaded = await reopened.load();
  assert.equal(loaded.document.strokes[0].points[0].x, 200);
  assert.equal(loaded.document.view.offsetY, -9000);
  assert.deepEqual(await reopened.importFile(reopened.backupPath), loaded.document);
});

test('recovers corrupt native primary from backup and preserves the damaged file', async (t) => {
  const { store, fresh, directory } = await temporary(t);
  await store.load();
  await store.save(document());
  await store.close();
  await fs.writeFile(store.filePath, '{corrupt sqlite');
  const reopened = fresh();
  assert.deepEqual(await reopened.load(), { document: document(), recovered: true });
  const preserved = (await fs.readdir(directory)).find((name) => name.startsWith('scroll.sm.corrupt-'));
  assert.ok(preserved);
  assert.equal(await fs.readFile(path.join(directory, preserved), 'utf8'), '{corrupt sqlite');
  await reopened.saveChanges({ upserts: [stroke('after-recovery')] });
  assert.equal((await reopened.getSnapshot()).strokes.length, 2);
});

test('unrecoverable native scroll blocks saves and never silently falls back to old JSON', async (t) => {
  const { store, directory } = await temporary(t);
  await fs.writeFile(store.filePath, 'damaged native');
  await fs.writeFile(path.join(directory, 'notebook.scrollmind.json'), JSON.stringify(document('stale')));
  assert.match((await store.load()).error, /files were preserved/);
  await assert.rejects(store.saveChanges({ upserts: [stroke('replacement')] }), /preserve an unreadable scroll/);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), 'damaged native');
});

test('future native schema remains untouched even when an older valid backup exists', async (t) => {
  const { store, fresh } = await temporary(t);
  await store.load();
  await store.save(document());
  await store.close();
  inspect(store.filePath, (db) => db.exec('PRAGMA user_version=99'));
  const original = await fs.readFile(store.filePath);
  const reopened = fresh();
  assert.match((await reopened.load()).error, /unsupported format version/);
  await assert.rejects(reopened.save(document('replacement')), /preserve an unreadable scroll/);
  assert.deepEqual(await fs.readFile(store.filePath), original);
});

test('native export is coherent during WAL editing, standalone, lossless, and independently editable', async (t) => {
  const { store, directory } = await temporary(t);
  await store.load();
  await store.save(document());
  await store.saveChanges({ upserts: [stroke('two', -230.1234567890123)], order: ['two', 'one'] });
  const expected = await store.getSnapshot();
  const destination = path.join(directory, 'Exports', 'my-scroll.sm');
  await store.exportFile(destination);
  assert.deepEqual((await fs.readdir(path.dirname(destination))).sort(), ['my-scroll.sm']);
  const isolated = path.join(directory, 'Isolated');
  await fs.mkdir(isolated);
  const isolatedFile = path.join(isolated, 'scroll.sm');
  await fs.copyFile(destination, isolatedFile);
  assert.deepEqual(await store.importFile(isolatedFile), expected);
  inspect(isolatedFile, (db) => db.prepare("DELETE FROM strokes WHERE id='one'").run());
  assert.equal((await store.importFile(isolatedFile)).strokes.length, 1);
  assert.deepEqual(await store.getSnapshot(), expected);
});

test('native export refuses active primary, backup, and hardlink aliases', async (t) => {
  const { store, directory } = await temporary(t);
  await store.load();
  await store.save(document());
  await assert.rejects(store.exportFile(store.filePath), /different file/);
  await assert.rejects(store.exportFile(store.backupPath), /different file/);
  const alias = path.join(directory, 'alias.sm');
  await fs.link(store.filePath, alias);
  await assert.rejects(store.exportFile(alias), /different file/);
  assert.deepEqual(await store.getSnapshot(), document());
});

test('readonly import rejects future format without modifying source or current writing', async (t) => {
  const { store, directory } = await temporary(t);
  await store.load();
  await store.save(document());
  const source = path.join(directory, 'future.sm');
  await store.exportFile(source);
  inspect(source, (db) => db.exec('PRAGMA user_version=2'));
  const original = await fs.readFile(source);
  await assert.rejects(store.importFile(source), /unsupported format version/);
  assert.deepEqual(await fs.readFile(source), original);
  assert.deepEqual(await store.getSnapshot(), document());
});

test('serialized concurrent incremental saves preserve order, pressure, and failed-validation atomicity', async (t) => {
  const { store } = await temporary(t);
  assert.deepEqual(await store.load(), { document: null, recovered: false });
  await Promise.all([store.saveChanges({ upserts: [stroke('one')] }), store.saveChanges({ upserts: [stroke('two')] }), store.saveChanges({ removals: ['one'], upserts: [stroke('three')] })]);
  assert.deepEqual((await store.getSnapshot()).strokes.map((item) => item.id), ['two', 'three']);
  const before = await store.getSnapshot();
  const invalid = stroke('bad');
  invalid.points[0].p = 1.01;
  await assert.rejects(store.saveChanges({ removals: ['two'], upserts: [invalid] }), /pressure/);
  assert.deepEqual(await store.getSnapshot(), before);
});

test('a failed final backup keeps the working scroll open so saving can be retried', async (t) => {
  const { store } = await temporary(t);
  await store.load();
  await store.save(document());
  await store.saveChanges({ view: { offsetY: -700 } });
  await fs.unlink(store.backupPath);
  await fs.mkdir(store.backupPath);
  await assert.rejects(store.close(), /EISDIR/);
  await store.saveChanges({ view: { offsetY: -800 } });
  assert.equal((await store.getSnapshot()).view.offsetY, -800);
  await fs.rmdir(store.backupPath);
  await store.close();
});

test('routine backup failure cannot reject a committed import or incremental save', async (t) => {
  const { store } = await temporary(t);
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  await store.load();
  await fs.mkdir(store.backupPath);
  const imported = document('imported');
  await store.save(imported);
  assert.deepEqual(await store.getSnapshot(), imported);
  assert.equal(inspect(store.filePath, (db) => db.prepare('SELECT id FROM strokes').get().id), 'imported');
  await store.saveChanges({ upserts: [stroke('later')], view: { offsetY: -900 } });
  assert.deepEqual((await store.getSnapshot()).strokes.map((item) => item.id), ['imported', 'later']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /backup maintenance will be retried/);
  await fs.rmdir(store.backupPath);
  await store.close();
});
