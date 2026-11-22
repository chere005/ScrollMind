import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { validateSnapshot } from '../src/core/model.mjs';
import { readScrollMindFile, openSQLite } from '../src/core/sm-file.mjs';

// The browser's .sm reader (src/core/sm-file.mjs) against files written by the desktop's own storage (src/main/storage.cjs):
// it must give exactly the snapshot readNative() gives, for Scrolls and Grids, large strokes on overflow pages included.
const { createStore } = createRequire(import.meta.url)('../src/main/storage.cjs');

const points = (n, x0 = 0) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 0.731, y: -1200 + Math.sin(i) * 40.125, p: (i % 97) / 97 }));
const snapshot = (strokes, extra = {}) => validateSnapshot({
	version: 1, strokes,
	markers: [{ id: 'b', y: 40, label: 'Later', kind: 'section' }, { id: 'a', y: -1300, label: 'Above the start', kind: 'section' }],
	view: { x: 0, y: -1200, zoom: 1 }, settings: { inkColor: '#243743', width: 3 }, ...extra,
});

async function exported(t, document, kind) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-smfile-'));
	const store = createStore(directory, { validate: validateSnapshot, kind });
	t.after(async () => { await store.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
	await store.load();
	await store.save(document);
	const file = path.join(directory, 'copy.sm');
	await store.exportFile(file);
	return { file, bytes: new Uint8Array(await fs.readFile(file)), native: await store.importFile(file) };
}

test('a Scroll reads back exactly as the desktop reads it, strokes in order, fills, markers by height', async (t) => {
	const doc = snapshot([
		{ id: 'one', color: '#243743', width: 3, points: points(5) },
		{ id: 'fill', color: '#ff8800', width: 2, points: points(6, 50), penType: 'fill' },
		{ id: 'two', color: '#123456', width: 1.5, points: points(3, 90) },
	]);
	const { bytes, native } = await exported(t, doc, 'scroll');
	const read = readScrollMindFile(bytes);
	assert.equal(read.kind, 'scroll');
	assert.deepEqual(read.snapshot, native);
	assert.deepEqual(read.snapshot.strokes.map((s) => s.id), ['one', 'fill', 'two']);
	assert.deepEqual(read.snapshot.markers.map((m) => m.id), ['a', 'b'], 'markers come back by height');
});

test('long strokes that spill onto overflow pages and thousands of strokes read back whole', async (t) => {
	const strokes = [{ id: 'long', color: '#000000', width: 2, points: points(40000) }, ...Array.from({ length: 3000 }, (_, i) => ({ id: 's' + i, color: '#222222', width: 1, points: points(8, i) }))];
	const { bytes, native } = await exported(t, snapshot(strokes), 'scroll');
	const read = readScrollMindFile(bytes);
	assert.equal(read.snapshot.strokes.length, 3001);
	assert.deepEqual(read.snapshot, native);
});

test('a Grid is told apart by its application ID and reads back the same', async (t) => {
	const { bytes, native } = await exported(t, snapshot([{ id: 'g', color: '#336699', width: 4, points: points(4) }], { settings: { inkColor: '#336699', width: 4, mode: 'grid' } }), 'grid');
	const read = readScrollMindFile(bytes);
	assert.equal(read.kind, 'grid');
	assert.deepEqual(read.snapshot, native);
});

test('what is not an exported ScrollMind file is refused with a reason', async (t) => {
	await assert.rejects(async () => readScrollMindFile(new Uint8Array(200)), /not a ScrollMind file/);
	await assert.rejects(async () => readScrollMindFile(new TextEncoder().encode('just some text that is long enough to have a header, but is not sqlite at all.'.repeat(3))), /not a ScrollMind file/);
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-smfile-other-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const other = path.join(directory, 'other.sqlite');
	let db = new DatabaseSync(other);
	db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE things (a TEXT); INSERT INTO things VALUES (\'x\');');
	db.close();
	await assert.rejects(async () => readScrollMindFile(new Uint8Array(await fs.readFile(other))), /not a ScrollMind scroll or grid/);
	assert.deepEqual([...openSQLite(new Uint8Array(await fs.readFile(other))).rows('things')].map((r) => r.values), [['x']], 'any plain table reads');
	const wal = path.join(directory, 'wal.sm');
	db = new DatabaseSync(wal);
	db.exec('PRAGMA journal_mode=WAL; PRAGMA application_id=1397640772; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	db.close();
	await assert.rejects(async () => readScrollMindFile(new Uint8Array(await fs.readFile(wal))), /write-ahead log/);
	const { bytes } = await exported(t, snapshot([{ id: 'x', color: '#000000', width: 1, points: points(3) }]), 'scroll');
	const damaged = bytes.slice();
	damaged.fill(0xff, 4096, 4096 + 64);
	await assert.rejects(async () => readScrollMindFile(damaged), /damaged|not a ScrollMind|JSON|Unexpected/);
});
