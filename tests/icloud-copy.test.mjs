import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { validateSnapshot } from '../src/core/model.mjs';
import { readScrollMindFile } from '../src/core/sm-file.mjs';

// Copy to iCloud Drive (src/main/icloud-copy.cjs) against a real writing folder made by the app's own workspaces, with a
// temporary folder standing in for iCloud Drive. Every copy must open in the browser's reader as the same writing.
const require = createRequire(import.meta.url);
const { createWorkspace } = require('../src/main/workspace.cjs');
const { createICloudCopy, iCloudDriveRoot } = require('../src/main/icloud-copy.cjs');

const points = (n, x0 = 0) => Array.from({ length: n }, (_, i) => ({ x: x0 + i, y: -1200 + i / 3, p: 0.5 }));
const doc = (...ids) => validateSnapshot({ version: 1, strokes: ids.map((id, i) => ({ id, color: '#243743', width: 3, points: points(4, i * 10) })), markers: [], view: { x: 0, y: -1200, zoom: 1 }, settings: { inkColor: '#243743', width: 3 } });

async function setup(t, { enabled = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-icloud-'));
  const data = path.join(root, 'ScrollMind'), cloud = path.join(root, 'iCloud Drive'), target = path.join(cloud, 'ScrollMind');
  await fs.mkdir(cloud, { recursive: true });
  const prefsFile = path.join(data, 'App', 'icloud-copy.json'), stateFile = path.join(data, 'App', 'icloud-copy-state.json');
  if (enabled) { await fs.mkdir(path.dirname(prefsFile), { recursive: true }); await fs.writeFile(prefsFile, JSON.stringify({ enabled: true })); }
  const scrolls = createWorkspace(data, { validate: validateSnapshot });
  const grids = createWorkspace(path.join(data, 'Grids'), { validate: validateSnapshot, kind: 'grid' });
  const timers = [], fake = { setTimeout: (fn) => { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimeout: (timer) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); } };
  const logs = [];
  const copy = createICloudCopy({ dataDirectory: data, target, iCloudRoot: cloud, prefsFile, stateFile, log: (line) => logs.push(line), timers: fake });
  t.after(async () => { await scrolls.close().catch(() => {}); await grids.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, data, cloud, target, prefsFile, scrolls, grids, copy, timers, logs };
}
const list = (dir) => (fsSync.existsSync(dir) ? fsSync.readdirSync(dir, { recursive: true }).filter((name) => fsSync.statSync(path.join(dir, name)).isFile()).sort() : []);
const read = (file) => readScrollMindFile(new Uint8Array(fsSync.readFileSync(file)));

test('iCloud Drive is found where macOS and Windows keep it, and nowhere else', () => {
  assert.equal(iCloudDriveRoot('/home-a', 'darwin'), path.join('/home-a', 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  assert.equal(iCloudDriveRoot('C:\\Users\\a', 'win32'), path.join('C:\\Users\\a', 'iCloudDrive'));
  assert.equal(iCloudDriveRoot('/home/a', 'linux'), null);
});

test('every Scroll and Grid is copied by name, and each copy opens in the browser reader as the same writing', async (t) => {
  const s = await setup(t);
  await s.scrolls.load(); await s.scrolls.save(doc('a1', 'a2'));
  const second = await s.scrolls.newScroll();
  await s.scrolls.save(doc('b1'));
  await s.scrolls.renameScroll(second.workspace.activeId, 'Ideas / notes');
  await s.grids.load(); await s.grids.save(doc('g1'));
  const main = s.scrolls.workspaceState().scrolls.find((scroll) => scroll.id === 'main').name;
  const grid = s.grids.workspaceState().scrolls.find((scroll) => scroll.id === 'main').name;
  assert.deepEqual(await s.copy.sync(), { copied: 3, removed: 0 });
  assert.deepEqual(list(s.target), [path.join('Grids', `${grid}.sm`), path.join('Scrolls', 'Ideas - notes.sm'), path.join('Scrolls', `${main}.sm`)].sort());
  const first = read(path.join(s.target, 'Scrolls', `${main}.sm`));
  assert.equal(first.kind, 'scroll');
  assert.deepEqual(first.snapshot.strokes.map((stroke) => stroke.id), ['a1', 'a2'], 'the copy has the writing as saved');
  assert.deepEqual(read(path.join(s.target, 'Scrolls', 'Ideas - notes.sm')).snapshot.strokes.map((stroke) => stroke.id), ['b1']);
  assert.equal(read(path.join(s.target, 'Grids', `${grid}.sm`)).kind, 'grid');
  assert.ok(list(s.data).every((name) => !name.endsWith('.tmp')), 'the writing folder is untouched');
  assert.deepEqual(list(s.target).filter((name) => /tmp|-wal|-shm|-journal/.test(name)), [], 'no temporary files are left in iCloud Drive');
  assert.deepEqual(await s.copy.sync(), { copied: 0, removed: 0 }, 'nothing changed, nothing copied');
});

test('copies follow new writing, renames and deletions, and never remove a file they did not make', async (t) => {
  const s = await setup(t);
  await s.scrolls.load(); await s.scrolls.save(doc('a1'));
  const second = await s.scrolls.newScroll(); await s.scrolls.save(doc('b1'));
  const id = second.workspace.activeId;
  await s.scrolls.renameScroll(id, 'Draft');
  await s.copy.sync();
  await fs.writeFile(path.join(s.target, 'Scrolls', 'Mine.txt'), 'not a copy');
  await s.scrolls.save(doc('b1', 'b2'));
  assert.deepEqual(await s.copy.sync(), { copied: 1, removed: 0 }, 'only the document that changed is copied again');
  assert.deepEqual(read(path.join(s.target, 'Scrolls', 'Draft.sm')).snapshot.strokes.map((stroke) => stroke.id), ['b1', 'b2']);
  await s.scrolls.renameScroll(id, 'Final');
  await s.copy.sync();
  assert.ok(!fsSync.existsSync(path.join(s.target, 'Scrolls', 'Draft.sm')) && fsSync.existsSync(path.join(s.target, 'Scrolls', 'Final.sm')), 'a rename moves the copy');
  await s.scrolls.deleteScroll(id);
  const result = await s.copy.sync();
  assert.equal(result.removed, 1);
  assert.ok(!fsSync.existsSync(path.join(s.target, 'Scrolls', 'Final.sm')), 'a deleted document loses its copy');
  assert.equal(fsSync.readFileSync(path.join(s.target, 'Scrolls', 'Mine.txt'), 'utf8'), 'not a copy');
});

test('writing is copied once it settles; off by default; turning it on catches up; nothing without iCloud Drive', async (t) => {
  const s = await setup(t, { enabled: false });
  await s.scrolls.load(); await s.scrolls.save(doc('a1'));
  assert.equal(s.copy.isEnabled(), false);
  s.copy.changed();
  assert.equal(s.timers.length, 0, 'off: nothing is scheduled');
  assert.deepEqual(await s.copy.setEnabled(true), { copied: 1, removed: 0 }, 'turning it on copies what is there');
  assert.deepEqual(JSON.parse(fsSync.readFileSync(s.prefsFile, 'utf8')), { enabled: true });
  await s.scrolls.save(doc('a1', 'a2'));
  s.copy.changed(); s.copy.changed();
  assert.equal(s.timers.length, 1, 'many saves in a row make one copy');
  await s.copy.flush();
  const main = s.scrolls.workspaceState().scrolls[0].name;
  assert.deepEqual(read(path.join(s.target, 'Scrolls', `${main}.sm`)).snapshot.strokes.map((stroke) => stroke.id), ['a1', 'a2'], 'quitting copies what was waiting');
  await fs.rm(s.cloud, { recursive: true, force: true });
  assert.equal(s.copy.isAvailable(), false);
  assert.deepEqual(await s.copy.sync(), { copied: 0, removed: 0 });
  assert.equal(fsSync.existsSync(s.target), false, 'no iCloud Drive, no folder made');
});

test('a damaged record never removes anything outside the copied folder', async (t) => {
  const s = await setup(t);
  await fs.writeFile(path.join(s.cloud, 'Keep.sm'), 'keep');
  await fs.mkdir(path.dirname(path.join(s.data, 'App', 'icloud-copy-state.json')), { recursive: true });
  await fs.writeFile(path.join(s.data, 'App', 'icloud-copy-state.json'), JSON.stringify({ copies: { 'scroll:gone': { name: path.join('..', 'Keep.sm'), fingerprint: 'x' } } }));
  await s.copy.sync();
  assert.equal(fsSync.readFileSync(path.join(s.cloud, 'Keep.sm'), 'utf8'), 'keep');
});
