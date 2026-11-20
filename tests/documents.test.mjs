import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { Notebook } from '../src/core/model.mjs';
import { DEFAULT_GRID } from '../src/core/grid.mjs';

const require = createRequire(import.meta.url);
const { createDocumentWorkspaces } = require('../src/main/documents.cjs');
const { createWorkspace } = require('../src/main/workspace.cjs');
const { formatFor } = require('../src/main/storage.cjs');

function inspectFormat(file, kind) {
	const database = new DatabaseSync(file, { readOnly: true });
	try {
		assert.equal(database.prepare('PRAGMA application_id').get().application_id, formatFor(kind).applicationId);
		assert.equal(database.prepare('PRAGMA user_version').get().user_version, formatFor(kind).version);
		assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
	} finally { database.close(); }
}

async function temporary(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrollmind-documents-'));
	const instances = [];
	t.after(async () => {
		await Promise.allSettled(instances.map(instance => instance.close()));
		await fs.rm(root, { recursive: true, force: true });
	});
	const open = () => { const instance = createDocumentWorkspaces(root); instances.push(instance); return instance; };
	return { root, open };
}

test('Grids have a separate workspace, SQLite format, native export and working-copy import', async t => {
	const { root, open } = await temporary(t);
	const store = open();
	assert.equal((await store.load()).workspace.kind, 'scroll');
	const notebook = new Notebook();
	notebook.addMarker({ id: 'marker', kind: 'section', y: 40, label: 'Scroll marker' });
	await store.save(notebook.snapshot());
	const grid = await store.switchWorkspace('grid');
	assert.equal(grid.workspace.kind, 'grid');
	assert.equal(grid.workspace.activeId, 'main');
	assert.deepEqual(grid.workspace.scrolls.map(item => item.name), ['Grid']);
	await assert.rejects(store.saveChanges({ documentKind: 'scroll', scrollId: 'main' }), /different workspace/);

	const drawing = new Notebook();
	drawing.addShape({ kind: 'rectangle', x: 20, y: -40, width: 100, height: 60, color: '#171717' });
	const snapshot = drawing.snapshot({ gridX: -300, gridZoom: 1.25 }, { mode: 'grid', grid: DEFAULT_GRID });
	await store.save(snapshot);
	assert.deepEqual((await store.switchWorkspace('scroll')).document.markers, notebook.markers);
	assert.equal((await store.getSnapshot()).diagram, undefined);
	const scrollFile = path.join(root, 'Writing.sm');
	await store.exportFile(scrollFile);
	inspectFormat(scrollFile, 'scroll');
	assert.deepEqual((await store.switchWorkspace('grid')).document, snapshot);
	const gridFile = path.join(root, 'Diagrams.smg');
	await store.exportFile(gridFile);
	inspectFormat(gridFile, 'grid');
	inspectFormat(path.join(root, 'Grids', 'grid.smg'), 'grid');
	await assert.rejects(store.exportFile(path.join(root, 'scroll.sm')), /different export file/);

	const misleading = path.join(root, 'Misnamed.sm');
	await fs.copyFile(gridFile, misleading);
	await assert.rejects(store.openScroll(misleading), /not a ScrollMind scroll/);
	const imported = await store.openScroll(gridFile);
	assert.equal(imported.workspace.kind, 'grid');
	assert.equal(imported.workspace.scrolls.find(item => item.active).name, 'Diagrams');
	assert.deepEqual(imported.document, snapshot);
	await store.close();
	const restarted = await open().load();
	assert.deepEqual(restarted.document, snapshot);
	assert.equal(restarted.workspace.kind, 'grid');
});

test('a preview-era hybrid saves a separate Grid before clearing Grid fields from the Scroll', async t => {
	const { root, open } = await temporary(t);
	const legacy = createWorkspace(root);
	await legacy.load();
	const source = new Notebook();
	source.addShape({ kind: 'ellipse', x: 200, y: 100, width: 90, height: 40, color: '#171717' });
	source.addMarker({ kind: 'section', y: 90, label: 'Only in the Scroll' });
	const document = source.snapshot({ offsetY: -80, gridX: -100, gridY: 40 }, { mode: 'grid', paperTone: 'parchment', grid: DEFAULT_GRID });
	await legacy.save(document);
	await legacy.close();

	const store = open();
	const migrated = await store.load();
	assert.equal(migrated.workspace.kind, 'grid');
	assert.deepEqual(migrated.document.diagram, document.diagram);
	assert.deepEqual(migrated.document.markers, []);
	assert.deepEqual(migrated.document.view, { offsetY: 0, gridX: -100, gridY: 40 });
	const scroll = await store.switchWorkspace('scroll');
	assert.equal(scroll.document.diagram, undefined);
	assert.equal(scroll.document.settings.grid, undefined);
	assert.equal(scroll.document.settings.paperTone, 'parchment');
	assert.equal(scroll.document.view.offsetY, -80);
	assert.deepEqual(scroll.document.markers, document.markers);
	await store.close();

	const restarted = open();
	assert.equal((await restarted.load()).workspace.kind, 'scroll');
	const returned = await restarted.switchWorkspace('grid');
	assert.deepEqual(returned.document, migrated.document);
	assert.equal(returned.workspace.scrolls.length, migrated.workspace.scrolls.length);
});

test('native documents persist custom palettes independently and new documents start with default swatches', async t => {
	const { root, open } = await temporary(t);
	const store = open();
	const { DEFAULT_PALETTE } = await import('../src/core/palette.mjs');
	const scrollPalette = DEFAULT_PALETTE.map((entry, i) => i === 0 ? { name: 'Draft', color: '#1A3B71' } : entry);
	const gridPalette = DEFAULT_PALETTE.map((entry, i) => i === 0 ? { name: 'Water', color: '#5CB9E6' } : entry);
	const blank = new Notebook();

	await store.load();
	await store.save(blank.snapshot({}, { palette: scrollPalette }));
	await store.switchWorkspace('grid');
	await store.save(blank.snapshot({}, { mode: 'grid', palette: gridPalette }));
	const grid = await store.getSnapshot();
	assert.deepEqual(grid.settings.palette[0], { name: 'Water', color: '#5cb9e6' });
	const file = path.join(root, 'Palette.smg');
	await store.exportFile(file);
	assert.deepEqual((await store.openScroll(file)).document.settings.palette, grid.settings.palette);
	assert.equal((await store.newScroll({ settings: grid.settings })).document.settings.palette, undefined);
	assert.deepEqual((await store.switchWorkspace('scroll')).document.settings.palette[0], { name: 'Draft', color: '#1a3b71' });
	assert.throws(() => blank.snapshot({}, { palette: [{ name: 'Water', color: '#5cb9e6' }] }), /eight swatches/);
});
