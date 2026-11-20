'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createWorkspace, atomicWrite } = require('./workspace.cjs');

function createDocumentWorkspaces(directory, options) {
	const activeFile = path.join(directory, 'active-workspace');
	const workspaces = {
		scroll: createWorkspace(directory, options),
		grid: createWorkspace(path.join(directory, 'Grids'), { ...options, kind: 'grid' }),
	};
	const opened = new Set();
	let kind = 'scroll';
	let queue = Promise.resolve();
	const active = () => workspaces[kind];

	function enqueue(operation) {
		const result = queue.then(operation);
		queue = result.catch(() => {});
		return result;
	}

	function tagged(result) {
		return { ...result, workspace: { ...result.workspace, kind } };
	}

	async function ensure(kind) {
		const workspace = workspaces[kind];
		if (opened.has(kind)) return { document: await workspace.getSnapshot(), workspace: workspace.workspaceState() };
		const result = await workspace.load();
		if (result.error) throw new Error(result.error);
		opened.add(kind);
		return result;
	}

	async function setKind(next) {
		if (next === kind) return;
		await atomicWrite(activeFile, next + '\n');
		kind = next;
	}

	async function splitPreview(result) {
		const document = result.document;
		if (!document) return { scroll: result };
		const { mode, grid, ...scrollSettings } = document.settings;
		const { gridX, gridY, gridZoom, ...scrollView } = document.view;
		if (mode !== 'grid' && !grid && !document.diagram && gridX === undefined && gridY === undefined && gridZoom === undefined) return { scroll: result };
		await ensure('grid');
		const name = result.workspace.scrolls.find(entry => entry.active)?.name;
		const gridResult = await workspaces.grid.openScroll(workspaces.scroll.filePath, {
			name: /^Scroll(?: \d+)?$/.test(name) ? undefined : name,
			document: { ...document, markers: [], settings: { ...scrollSettings, mode: 'grid', grid }, view: { gridX, gridY, gridZoom } },
		});
		// The Grid and its manifest must be durable before removing legacy Grid fields from the Scroll.
		const { diagram, ...base } = document;
		const scroll = { ...base, view: scrollView, settings: scrollSettings };
		await workspaces.scroll.save(scroll);
		return { scroll: { ...result, document: scroll }, grid: gridResult };
	}

	async function finish(result) {
		return tagged(kind === 'scroll' ? (await splitPreview(result)).scroll : result);
	}

	function load() {
		return enqueue(async () => {
			let requested;
			try { requested = (await fs.readFile(activeFile, 'utf8')).trim(); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			if (requested === 'grid') {
				const result = await ensure('grid');
				kind = 'grid';
				return tagged(result);
			}
			const result = await ensure('scroll');
			kind = 'scroll';
			const previewWasGrid = requested === undefined && result.document?.settings.mode === 'grid';
			const split = await splitPreview(result);
			if (previewWasGrid && split.grid) {
				await setKind('grid');
				return tagged({ ...split.grid, recovered: result.recovered });
			}
			return tagged(split.scroll);
		}).catch(error => ({ document: null, recovered: false, error: error.message }));
	}

	function switchWorkspace(next) {
		return enqueue(async () => {
			if (!Object.hasOwn(workspaces, next)) throw new TypeError('Choose Scrolls or Grids.');
			const result = await ensure(next);
			const document = next === 'scroll' ? (await splitPreview(result)).scroll : result;
			await setKind(next);
			return tagged(document);
		});
	}

	function openScroll(file) {
		return enqueue(async () => {
			const extension = path.extname(file).toLowerCase();
			if (!['.sm', '.smg'].includes(extension)) throw new TypeError('Choose a ScrollMind Scroll (.sm) or Grid (.smg).');
			const next = extension === '.smg' ? 'grid' : 'scroll';
			await ensure(next);
			const result = await workspaces[next].openScroll(file);
			const split = next === 'scroll' ? await splitPreview(result) : null;
			const converted = result.document?.settings.mode === 'grid' && split?.grid;
			await setKind(converted ? 'grid' : next);
			return tagged(converted || split?.scroll || result);
		});
	}

	function saveChanges(changes) {
		const copy = structuredClone(changes);
		return enqueue(() => {
			if (copy?.documentKind !== undefined && copy.documentKind !== kind) throw new Error('This save belongs to a different workspace.');
			return active().saveChanges(copy);
		});
	}

	async function assertExportDestination(file) {
		await workspaces.scroll.assertExportDestination(file);
		await workspaces.grid.assertExportDestination(file);
		return file;
	}

	function exportFile(file) {
		return enqueue(async () => active().exportFile(await assertExportDestination(file)));
	}

	const activeCommand = method => (...args) => enqueue(async () => finish(await active()[method](...args)));
	return {
		load, switchWorkspace, openScroll, saveChanges, assertExportDestination, exportFile,
		save: document => enqueue(() => active().save(document)),
		getSnapshot: () => enqueue(() => active().getSnapshot()),
		workspaceState: () => tagged({ workspace: active().workspaceState() }).workspace,
		newScroll: activeCommand('newScroll'),
		selectScroll: activeCommand('selectScroll'),
		closeScroll: activeCommand('closeScroll'),
		deleteScroll: activeCommand('deleteScroll'),
		renameScroll: activeCommand('renameScroll'),
		flush: () => enqueue(() => Promise.all([...opened].map(key => workspaces[key].flush()))),
		close: () => enqueue(async () => {
			const results = await Promise.allSettled([...opened].map(key => workspaces[key].close()));
			const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
			if (errors.length) throw new AggregateError(errors, 'Some documents could not finish saving.');
			opened.clear();
		}),
	};
}

module.exports = { createDocumentWorkspaces };
