import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { validateSnapshot } from '../src/core/model.mjs';

const require = createRequire(import.meta.url);
const { createWorkspace } = require('../src/main/workspace.cjs');
const { createStore } = require('../src/main/storage.cjs');
const stroke = (id) => ({ id, color: '#234567', width: 2.5, points: [{ x: 10.25, y: -3500.125, p: 0.173456789 }, { x: 20.125, y: -3490.25, p: 0.95 }] });
const document = (id) => validateSnapshot({ version: 1, strokes: [stroke(id)], markers: [{ id: `marker-${id}`, kind: 'section', label: id, y: -3600 }], view: { offsetY: -3900 }, settings: { color: '#234567', width: 2.5, paper: 'grid', paperTone: 'white' } });

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-workspace-'));
  const workspaces = [];
  const fresh = () => { const workspace = createWorkspace(directory, { validate: validateSnapshot }); workspaces.push(workspace); return workspace; };
  t.after(async () => {
    for (const workspace of workspaces) await workspace.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, workspace: fresh(), fresh };
}

function readIds(file) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try { return db.prepare('SELECT id FROM strokes ORDER BY order_index').all().map((row) => row.id); }
  finally { db.close(); }
}

async function missing(file) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }

test('multiple managed scrolls isolate ink, markers, camera, paper settings, and active file paths', async (t) => {
  const { workspace, directory } = await temporary(t);
  const initial = await workspace.load();
  assert.equal(initial.document, null);
  assert.equal(initial.workspace.activeId, 'main');
  await workspace.save(document('main-ink'));
  const second = await workspace.newScroll({ name: 'Ideas', settings: { color: '#654321', width: 4, paper: 'ruled', paperTone: 'parchment' } });
  const secondId = second.workspace.activeId;
  assert.equal(second.document.strokes.length, 0);
  assert.equal(second.document.markers.length, 0);
  assert.equal(second.document.view.offsetY, 0);
  assert.equal(second.document.settings.paperTone, 'parchment');
  assert.equal(workspace.filePath, path.join(directory, 'Scrolls', secondId, 'scroll.sm'));
  await workspace.save(document('second-ink'));
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main-ink'));
  assert.equal(workspace.filePath, path.join(directory, 'scroll.sm'));
  assert.deepEqual((await workspace.selectScroll(secondId)).document, document('second-ink'));
  assert.equal(JSON.stringify(workspace.workspaceState()).includes(directory), false);
});

test('restart restores open scrolls, names, active selection, and closed scrolls remain reopenable', async (t) => {
  const { workspace, fresh } = await temporary(t);
  await workspace.load();
  await workspace.save(document('main'));
  const a = (await workspace.newScroll({ name: 'A', document: document('a') })).workspace.activeId;
  const b = (await workspace.newScroll({ name: 'B', document: document('b') })).workspace.activeId;
  await workspace.closeScroll(a);
  await workspace.renameScroll(a, 'Archived Ideas');
  const expectedState = workspace.workspaceState();
  await workspace.close();
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.workspace.activeId, b);
  assert.deepEqual(loaded.workspace, expectedState);
  assert.deepEqual(loaded.document, document('b'));
  const reopened = await restored.selectScroll(a);
  assert.deepEqual(reopened.document, document('a'));
  assert.equal(reopened.workspace.scrolls.find((scroll) => scroll.id === a).open, true);
  assert.equal(reopened.workspace.scrolls.find((scroll) => scroll.id === a).name, 'Archived Ideas');
});

test('clearing current scroll preserves other scrolls; closing the final tab creates a blank without deleting ink', async (t) => {
  const { workspace, directory } = await temporary(t);
  await workspace.load();
  await workspace.save(document('main'));
  const second = (await workspace.newScroll({ document: document('second') })).workspace.activeId;
  const cleared = validateSnapshot({ version: 1, strokes: [], markers: [], settings: document('second').settings, view: { offsetY: 0 } });
  await workspace.save(cleared);
  assert.deepEqual(await workspace.getSnapshot(), cleared);
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main'));
  await workspace.closeScroll(second);
  const finalClosed = await workspace.closeScroll('main');
  assert.notEqual(finalClosed.workspace.activeId, 'main');
  assert.equal(finalClosed.document.strokes.length, 0);
  assert.equal(finalClosed.document.markers.length, 0);
  assert.equal(finalClosed.workspace.scrolls.find((scroll) => scroll.id === 'main').open, false);
  assert.deepEqual(readIds(path.join(directory, 'scroll.sm')), ['main']);
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main'));
});

test('opening a source creates a managed copy and reopening it selects the same retained scroll', async (t) => {
  const { workspace, directory } = await temporary(t);
  await workspace.load();
  await workspace.save(document('existing'));
  const source = createStore(path.join(directory, 'External Source'), { validate: validateSnapshot });
  await source.load(); await source.save(document('external')); await source.close();
  const original = await fs.readFile(source.filePath);
  const opened = await workspace.openScroll(source.filePath);
  const openedId = opened.workspace.activeId;
  assert.deepEqual(opened.document, document('external'));
  await workspace.saveChanges({ upserts: [stroke('new-managed-ink')] });
  assert.deepEqual(await fs.readFile(source.filePath), original);
  assert.deepEqual((await workspace.selectScroll('main')).document, document('existing'));
  await workspace.closeScroll(openedId);
  const reopened = await workspace.openScroll(source.filePath);
  assert.equal(reopened.workspace.activeId, openedId);
  assert.equal(reopened.workspace.scrolls.length, 2);
  assert.equal(reopened.document.strokes.length, 2);
  assert.deepEqual(await fs.readFile(source.filePath), original);
});

test('main scroll keeps its original root location and legacy JSON migration', async (t) => {
  const { workspace, directory } = await temporary(t);
  const legacy = path.join(directory, 'notebook.scrollmind.json');
  const content = `${JSON.stringify(document('legacy'))}\n`;
  await fs.writeFile(legacy, content);
  const loaded = await workspace.load();
  assert.deepEqual(loaded.document, document('legacy'));
  assert.equal(loaded.migrated, true);
  assert.equal(workspace.filePath, path.join(directory, 'scroll.sm'));
  assert.equal(await fs.readFile(legacy, 'utf8'), content);
});

test('corrupt manifest recovers its backup and preserves the damaged manifest and all scroll files', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load();
  await workspace.save(document('main'));
  const other = (await workspace.newScroll({ name: 'Other', document: document('other') })).workspace.activeId;
  await workspace.renameScroll(other, 'Renamed');
  await workspace.close();
  const manifestFile = path.join(directory, 'workspace.json');
  await fs.writeFile(manifestFile, '{damaged workspace');
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.workspace.activeId, other);
  assert.deepEqual(loaded.document, document('other'));
  const preserved = (await fs.readdir(directory)).find((name) => name.startsWith('workspace.json.corrupt-'));
  assert.ok(preserved);
  assert.equal(await fs.readFile(path.join(directory, preserved), 'utf8'), '{damaged workspace');
  assert.deepEqual((await restored.selectScroll('main')).document, document('main'));
});

test('future workspace version is preserved without opening or overwriting any scroll DB', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main')); await workspace.close();
  const manifestFile = path.join(directory, 'workspace.json');
  const future = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  future.version = 99;
  await fs.writeFile(manifestFile, JSON.stringify(future));
  const manifestBytes = await fs.readFile(manifestFile);
  const scrollBytes = await fs.readFile(workspace.filePath);
  const restored = fresh();
  assert.match((await restored.load()).error, /unsupported version/);
  await assert.rejects(restored.newScroll(), /protected/);
  await assert.rejects(restored.saveChanges({ upserts: [stroke('bad-replacement')] }), /protected/);
  assert.deepEqual(await fs.readFile(manifestFile), manifestBytes);
  assert.deepEqual(await fs.readFile(workspace.filePath), scrollBytes);
});

test('manifest write failure leaves the current scroll selected and recovers an unregistered new scroll on restart', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const other = (await workspace.newScroll({ document: document('other') })).workspace.activeId;
  const before = workspace.workspaceState();
  const backup = path.join(directory, 'workspace.backup.json');
  await fs.unlink(backup); await fs.mkdir(backup);
  await assert.rejects(workspace.selectScroll('main'), /EISDIR/);
  assert.deepEqual(workspace.workspaceState(), before);
  assert.deepEqual(await workspace.getSnapshot(), document('other'));
  const foldersBefore = await fs.readdir(path.join(directory, 'Scrolls'));
  await assert.rejects(workspace.newScroll({ document: document('orphan-kept') }), /EISDIR/);
  const orphan = (await fs.readdir(path.join(directory, 'Scrolls'))).find((name) => !foldersBefore.includes(name));
  assert.ok(orphan);
  assert.deepEqual(readIds(path.join(directory, 'Scrolls', orphan, 'scroll.sm')), ['orphan-kept']);
  assert.equal(workspace.workspaceState().activeId, other);
  assert.equal(workspace.workspaceState().scrolls.length, 2);
  await fs.rmdir(backup);
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main'));
  await workspace.close();
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.workspace.activeId, 'main');
  const recovered = loaded.workspace.scrolls.find((scroll) => scroll.id === orphan);
  assert.equal(recovered.open, true);
  assert.match(recovered.name, /^Recovered scroll /);
  assert.deepEqual((await restored.selectScroll(orphan)).document, document('orphan-kept'));
});

test('invalid IDs and names cannot escape managed folders or mutate the manifest', async (t) => {
  const { workspace, directory } = await temporary(t);
  await workspace.load();
  const before = await fs.readFile(path.join(directory, 'workspace.json'));
  for (const id of ['../escape', '/tmp/no', '', 'MAIN', 'not-a-uuid']) {
    await assert.rejects(workspace.selectScroll(id), /valid scroll/);
    await assert.rejects(workspace.closeScroll(id), /valid scroll/);
    await assert.rejects(workspace.renameScroll(id, 'Name'), /valid scroll/);
  }
  for (const name of ['', '   ', 'bad\nname', 'x'.repeat(81)]) {
    await assert.rejects(workspace.newScroll({ name }), /scroll name/);
    await assert.rejects(workspace.renameScroll('main', name), /scroll name/);
  }
  assert.deepEqual(await fs.readFile(path.join(directory, 'workspace.json')), before);
  assert.equal(workspace.workspaceState().scrolls.length, 1);
});

test('native export protects inactive and closed DBs, backups, manifests, hardlinks and managed folders', async (t) => {
  const { workspace, directory } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  await workspace.newScroll({ document: document('other') });
  await workspace.closeScroll('main');
  for (const target of ['scroll.sm', 'scroll.backup.sm', 'workspace.json', 'workspace.backup.json']) {
    await assert.rejects(workspace.exportFile(path.join(directory, target)), /different export file/);
  }
  const alias = path.join(directory, 'inactive-alias.sm');
  await fs.link(path.join(directory, 'scroll.sm'), alias);
  await assert.rejects(workspace.exportFile(alias), /different export file/);
  await assert.rejects(workspace.exportFile(path.join(directory, 'Scrolls', 'unused.sm')), /outside the managed/);
  const destination = path.join(directory, 'Exports', 'shared.sm');
  await workspace.exportFile(destination);
  assert.deepEqual(readIds(destination), ['other']);
  assert.deepEqual(readIds(path.join(directory, 'scroll.sm')), ['main']);
});

test('workspace flush and close finish every lazily loaded scroll, including inactive scrolls', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const paths = [workspace.filePath];
  for (const id of ['two', 'three']) {
    await workspace.newScroll({ document: document(id) });
    await workspace.saveChanges({ upserts: [stroke(`${id}-later`)] });
    paths.push(workspace.filePath);
  }
  await workspace.flush(); await workspace.close();
  for (const file of paths) { await missing(`${file}-wal`); await missing(`${file}-shm`); }
  assert.deepEqual(readIds(paths[1]), ['two', 'two-later']);
  assert.deepEqual(readIds(paths[2]), ['three', 'three-later']);
  const restored = fresh();
  await restored.load();
  assert.equal(restored.workspaceState().scrolls.length, 3);
  assert.deepEqual((await restored.selectScroll('main')).document, document('main'));
});

test('manifest backup recovery discovers the latest valid scroll while ignoring malformed or symlinked orphan files', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const lostId = (await workspace.newScroll({ document: document('latest') })).workspace.activeId;
  await workspace.close();
  const badId = '00000000-0000-4000-8000-000000000001';
  const linkedId = '00000000-0000-4000-8000-000000000002';
  const linkedFileId = '00000000-0000-4000-8000-000000000003';
  const badFolder = path.join(directory, 'Scrolls', badId);
  await fs.mkdir(badFolder);
  await fs.writeFile(path.join(badFolder, 'scroll.sm'), 'malformed orphan');
  // Windows without admin/Developer Mode cannot create symlinks (EPERM): use a directory junction
  // (still reported as a symbolic link) and skip only the file-symlink fixture, which has no equivalent.
  const link = async (target, linkPath, type) => {
    try { await fs.symlink(target, linkPath, type); return true; }
    catch (error) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      if (type !== 'dir') return false;
      await fs.symlink(target, linkPath, 'junction'); return true;
    }
  };
  await link(path.join(directory, 'Scrolls', lostId), path.join(directory, 'Scrolls', linkedId), 'dir');
  await fs.mkdir(path.join(directory, 'Scrolls', linkedFileId));
  await link(path.join(directory, 'Scrolls', lostId, 'scroll.sm'), path.join(directory, 'Scrolls', linkedFileId, 'scroll.sm'), 'file');
  await fs.writeFile(path.join(directory, 'workspace.json'), '{lost newest manifest');
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.recovered, true);
  assert.equal(loaded.workspace.activeId, 'main');
  assert.deepEqual(loaded.document, document('main'));
  assert.deepEqual(loaded.workspace.scrolls.map((scroll) => scroll.id), ['main', lostId]);
  assert.match(loaded.workspace.scrolls[1].name, /^Recovered scroll /);
  assert.deepEqual((await restored.selectScroll(lostId)).document, document('latest'));
  assert.equal(await fs.readFile(path.join(badFolder, 'scroll.sm'), 'utf8'), 'malformed orphan');
});

test('a queued stale save is rejected after a tab switch without changing either scroll', async (t) => {
  const { workspace } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const other = (await workspace.newScroll({ document: document('other') })).workspace.activeId;
  await workspace.selectScroll('main');
  const switching = workspace.selectScroll(other);
  const stale = workspace.saveChanges({ scrollId: 'main', upserts: [stroke('stale-main-ink')], view: { offsetY: 1234 } });
  // Attach the rejection assertion immediately so strict unhandled rejection mode is safe.
  const rejected = assert.rejects(stale, /different scroll/);
  await switching; await rejected;
  assert.deepEqual(await workspace.getSnapshot(), document('other'));
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main'));
});

test('deleting inactive main and the last active scroll removes both lists while retaining recoverable writing', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main-deleted'));
  const second = (await workspace.newScroll({ document: document('second-deleted') })).workspace.activeId;
  const inactive = await workspace.deleteScroll('main');
  assert.equal(inactive.workspace.activeId, second);
  assert.deepEqual(inactive.document, document('second-deleted'));
  assert.equal(inactive.workspace.scrolls.some((scroll) => scroll.id === 'main'), false);
  await missing(path.join(directory, 'scroll.sm'));
  const last = await workspace.deleteScroll(second);
  assert.notEqual(last.workspace.activeId, second);
  assert.equal(last.workspace.scrolls.length, 1);
  assert.equal(last.document.strokes.length, 0);
  assert.equal(last.document.markers.length, 0);
  for (const id of ['main', second]) {
    await assert.rejects(workspace.selectScroll(id), /deleted/);
    await assert.rejects(workspace.closeScroll(id), /deleted/);
  }
  const archives = await fs.readdir(path.join(directory, 'Deleted Scrolls'));
  assert.equal(archives.length, 2);
  const recovered = [];
  for (const archive of archives) recovered.push(await workspace.importFile(path.join(directory, 'Deleted Scrolls', archive, 'scroll.sm')));
  assert.deepEqual(recovered.map((scroll) => scroll.strokes[0].id).sort(), ['main-deleted', 'second-deleted']);
  assert.deepEqual(recovered.map((scroll) => scroll.markers[0].label).sort(), ['main-deleted', 'second-deleted']);
  await workspace.close();
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.workspace.scrolls.length, 1);
  assert.equal(loaded.workspace.activeId, last.workspace.activeId);
  assert.equal(loaded.document.strokes.length, 0);
});

test('deleting an active managed scroll selects another open scroll without changing its writing', async (t) => {
  const { workspace } = await temporary(t);
  await workspace.load(); await workspace.save(document('keep-main'));
  const other = (await workspace.newScroll({ document: document('remove-other') })).workspace.activeId;
  const deleted = await workspace.deleteScroll(other);
  assert.equal(deleted.workspace.activeId, 'main');
  assert.deepEqual(deleted.document, document('keep-main'));
  assert.deepEqual(await workspace.getSnapshot(), document('keep-main'));
});

test('deleted closed scrolls cannot return through manifest backup or orphan recovery', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const a = (await workspace.newScroll({ document: document('delete-closed') })).workspace.activeId;
  const b = (await workspace.newScroll({ document: document('keep-active') })).workspace.activeId;
  await workspace.closeScroll(a);
  const deleted = await workspace.deleteScroll(a);
  assert.equal(deleted.workspace.activeId, b);
  assert.deepEqual(deleted.document, document('keep-active'));
  await workspace.close();
  const archive = (await fs.readdir(path.join(directory, 'Deleted Scrolls')))[0];
  // Simulate a cleanup interruption leaving the old managed file behind.
  await fs.copyFile(path.join(directory, 'Deleted Scrolls', archive, 'scroll.sm'), path.join(directory, 'Scrolls', a, 'scroll.sm'));
  await fs.writeFile(path.join(directory, 'workspace.json'), '{corrupt newest manifest');
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.workspace.activeId, b);
  assert.equal(loaded.workspace.scrolls.some((scroll) => scroll.id === a), false);
  await assert.rejects(restored.selectScroll(a), /deleted/);
  assert.deepEqual(loaded.document, document('keep-active'));
});

test('deleting main preserves app profiles and legacy files without reimporting legacy ink on restart', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  const legacy = path.join(directory, 'notebook.scrollmind.json');
  const original = JSON.stringify(document('legacy-deleted'));
  await fs.writeFile(legacy, original);
  await fs.mkdir(path.join(directory, 'App'));
  await fs.writeFile(path.join(directory, 'App', 'profile.json'), '{"keep":true}');
  await workspace.load();
  const deleted = await workspace.deleteScroll('main');
  await workspace.close();
  assert.equal(await fs.readFile(legacy, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(directory, 'App', 'profile.json'), 'utf8'), '{"keep":true}');
  await missing(path.join(directory, 'scroll.sm'));
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.workspace.activeId, deleted.workspace.activeId);
  assert.equal(loaded.document.strokes.length, 0);
  await missing(path.join(directory, 'scroll.sm'));
});

test('deleting an imported managed copy leaves the external source untouched and explicit reopen uses a fresh ID', async (t) => {
  const { workspace, directory } = await temporary(t);
  const source = createStore(path.join(directory, 'External Source'), { validate: validateSnapshot });
  await source.load(); await source.save(document('external-kept')); await source.close();
  const original = await fs.readFile(source.filePath);
  await workspace.load();
  const first = (await workspace.openScroll(source.filePath)).workspace.activeId;
  await workspace.deleteScroll(first);
  assert.deepEqual(await fs.readFile(source.filePath), original);
  const reopened = await workspace.openScroll(source.filePath);
  assert.notEqual(reopened.workspace.activeId, first);
  assert.deepEqual(reopened.document, document('external-kept'));
  assert.deepEqual(await fs.readFile(source.filePath), original);
});

test('precommit deletion failure leaves the current scroll selected and usable', async (t) => {
  const { workspace, directory } = await temporary(t);
  await workspace.load(); await workspace.save(document('main-safe'));
  const active = (await workspace.newScroll({ document: document('active-safe') })).workspace.activeId;
  const before = workspace.workspaceState();
  await fs.writeFile(path.join(directory, 'Deleted Scrolls'), 'not a folder');
  await assert.rejects(workspace.deleteScroll(active), /ENOTDIR|EEXIST/);
  assert.deepEqual(workspace.workspaceState(), before);
  assert.deepEqual(await workspace.getSnapshot(), document('active-safe'));
  await workspace.saveChanges({ scrollId: active, upserts: [stroke('still-writable')] });
  assert.equal((await workspace.getSnapshot()).strokes.length, 2);
  assert.deepEqual((await workspace.selectScroll('main')).document, document('main-safe'));
});

test('postcommit manifest maintenance failure resolves with matching active state and replays deletion on restart', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  await workspace.load(); await workspace.save(document('main-kept'));
  const deletedId = (await workspace.newScroll({ document: document('remove-me') })).workspace.activeId;
  const backup = path.join(directory, 'workspace.backup.json');
  await fs.unlink(backup); await fs.mkdir(backup);
  const deleted = await workspace.deleteScroll(deletedId);
  assert.equal(deleted.workspace.activeId, 'main');
  assert.deepEqual(deleted.document, document('main-kept'));
  assert.deepEqual(await workspace.getSnapshot(), document('main-kept'));
  assert.equal(deleted.workspace.scrolls.some((scroll) => scroll.id === deletedId), false);
  assert.ok(warnings.some(message => /deleted scroll list/.test(message)));
  await fs.rmdir(backup);
  await workspace.close();
  const restored = fresh();
  const loaded = await restored.load();
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.workspace.activeId, 'main');
  assert.equal(loaded.workspace.scrolls.some((scroll) => scroll.id === deletedId), false);
});

test('corrupt durable deletion records block loading rather than silently resurrect deleted scrolls', async (t) => {
  const { workspace, directory, fresh } = await temporary(t);
  await workspace.load(); await workspace.save(document('main'));
  const removed = (await workspace.newScroll({ document: document('removed') })).workspace.activeId;
  await workspace.deleteScroll(removed); await workspace.close();
  const archive = (await fs.readdir(path.join(directory, 'Deleted Scrolls')))[0];
  await fs.writeFile(path.join(directory, 'Deleted Scrolls', archive, 'deletion.json'), '{broken record');
  const original = await fs.readFile(path.join(directory, 'scroll.sm'));
  const restored = fresh();
  assert.equal(typeof (await restored.load()).error, 'string');
  await assert.rejects(restored.saveChanges({ upserts: [stroke('must-not-write')] }), /protected/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'scroll.sm')), original);
});

test('default names reuse the bare Scroll name and lowest available number after deletion and restart', async (t) => {
  const { workspace, fresh } = await temporary(t);
  await workspace.load();
  const two = (await workspace.newScroll({ name: 'Scroll 2' })).workspace.activeId;
  await workspace.newScroll({ name: 'Scroll 3' });
  await workspace.deleteScroll('main');
  await workspace.deleteScroll(two);
  const bare = await workspace.newScroll();
  assert.equal(bare.workspace.scrolls.find((scroll) => scroll.active).name, 'Scroll');
  await workspace.close();
  const restored = fresh();
  await restored.load();
  const reused = await restored.newScroll();
  assert.equal(reused.workspace.scrolls.find((scroll) => scroll.active).name, 'Scroll 1');
  const next = await restored.newScroll();
  assert.equal(next.workspace.scrolls.find((scroll) => scroll.active).name, 'Scroll 2');
});

test('closed names remain reserved without regard to case or whitespace and explicit names stay explicit', async (t) => {
  const { workspace } = await temporary(t);
  await workspace.load();
  await workspace.renameScroll('main', '  sCrOlL  ');
  const reserved = (await workspace.newScroll({ name: '  scroll 1  ' })).workspace.activeId;
  await workspace.closeScroll(reserved);
  const numbered = await workspace.newScroll();
  assert.equal(numbered.workspace.scrolls.find((scroll) => scroll.active).name, 'Scroll 2');
  const explicit = await workspace.newScroll({ name: 'My Ideas' });
  assert.equal(explicit.workspace.scrolls.find((scroll) => scroll.active).name, 'My Ideas');
  assert.equal(explicit.workspace.scrolls.find((scroll) => scroll.id === reserved).name, 'scroll 1');
});

test('deleting the final Scroll tab can reuse its own name for the replacement', async (t) => {
  const { workspace } = await temporary(t);
  await workspace.load();
  await workspace.renameScroll('main', 'Scroll');
  const replaced = await workspace.deleteScroll('main');
  assert.equal(replaced.workspace.scrolls.find((scroll) => scroll.active).name, 'Scroll');
});
