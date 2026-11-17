import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { validateSnapshot } from '../src/core/model.mjs';

const { createStore } = createRequire(import.meta.url)('../src/main/storage.cjs');
const document = (name) => ({ version: 1, strokes: [{ id: name, color: '#243743', width: 3, points: [{ x: 1, y: 2, p: 0.5 }] }], view: { offsetY: 0 }, settings: { color: '#243743', width: 3, paper: 'dots' } });

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: createStore(directory) };
}

test('serializes concurrent saves atomically and keeps the previous good document', async (t) => {
  const { store } = await temporary(t);
  assert.deepEqual(await store.load(), { document: null, recovered: false });
  await Promise.all([store.save(document('one')), store.save(document('two')), store.save(document('three'))]);
  assert.deepEqual(JSON.parse(await fs.readFile(store.filePath, 'utf8')), document('three'));
  assert.deepEqual(JSON.parse(await fs.readFile(store.backupPath, 'utf8')), document('two'));
});

test('recovers the valid backup and preserves the corrupt primary', async (t) => {
  const { store, directory } = await temporary(t);
  await store.load();
  await store.save(document('one'));
  await store.save(document('two'));
  await fs.writeFile(store.filePath, '{broken');
  assert.deepEqual(await store.load(), { document: document('one'), recovered: true });
  assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('notebook.corrupt-')), true);
  await store.save(document('recovered'));
  assert.equal((await store.load()).document.strokes[0].id, 'recovered');
});

test('never overwrites unrecoverable files with an empty notebook', async (t) => {
  const { store } = await temporary(t);
  await fs.writeFile(store.filePath, '{broken');
  const loaded = await store.load();
  assert.equal(typeof loaded.error, 'string');
  await assert.rejects(store.save(document('new')), /preserve an unreadable notebook/);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), '{broken');
});

test('rejects unsupported schema and leaves good writing untouched', async (t) => {
  const { store } = await temporary(t);
  await store.load();
  await store.save(document('good'));
  await assert.rejects(store.save({ version: 2, strokes: [] }), /not a supported/);
  assert.deepEqual((await store.load()).document, document('good'));
});

test('strict geometry validation recovers a backup instead of replacing corrupt writing', async (t) => {
  const { directory } = await temporary(t);
  const store = createStore(directory, { validate: validateSnapshot });
  await store.load();
  await store.save(document('good'));
  await store.save(document('newer'));
  const corrupt = document('broken');
  corrupt.strokes[0].points[0].x = 'not a coordinate';
  await fs.writeFile(store.filePath, JSON.stringify(corrupt));
  const recovered = await store.load();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.document.strokes[0].id, 'good');
  assert.deepEqual(recovered.document.markers, []);
  assert.equal(recovered.document.settings.paperTone, 'ivory');
  await assert.rejects(store.save(corrupt), /Point x/);
});
