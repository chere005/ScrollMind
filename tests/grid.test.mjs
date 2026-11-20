import test from 'node:test';
import assert from 'node:assert/strict';
import { Notebook, validateSnapshot } from '../src/core/model.mjs';
import { gridBounds, diagramRoutes, routeConnection, shapePaths } from '../src/core/grid.mjs';
import { exportSVG, exportPDFHTML } from '../src/core/export.mjs';

const grid = { cellRows: 2, cellColumns: 2, blockRows: 2, blockColumns: 2, paperTone: 'night' };
const box = (kind, x, y, width = 40, height = 32) => ({ kind, x, y, width, height, color: '#171717' });

test('grid expands by complete pages to every edge and keeps alignment on negative coordinates', () => {
	assert.deepEqual(gridBounds(grid), { x: 0, y: 0, width: 96, height: 96 });
	assert.deepEqual(gridBounds(grid, { x: -20, y: -5, width: 140, height: 112 }), { x: -96, y: -96, width: 288, height: 288 });
});

test('attached orthogonal routes avoid an intervening shape and are derived from the live node geometry', () => {
	const from = { id: 'from', ...box('rectangle', 0, 0, 80, 50) };
	const to = { id: 'to', ...box('ellipse', 320, 0, 80, 50) };
	const blocker = { id: 'blocker', ...box('cylinder', 160, -20, 80, 90) };
	const route = routeConnection(from, to, [from, to, blocker], 1);
	assert.deepEqual(route[0], { x: 80, y: 25 });
	assert.ok(route.some(point => point.y <= -28 || point.y >= 78));
	for (const [i, a] of route.slice(0, -1).entries()) {
		const b = route[i + 1];
		assert.ok(a.x === b.x || a.y === b.y);
		if (a.x === b.x && a.x >= 160 && a.x <= 240) assert.ok(Math.max(a.y, b.y) < -20 || Math.min(a.y, b.y) > 70);
		if (a.y === b.y && a.y >= -20 && a.y <= 70) assert.ok(Math.max(a.x, b.x) < 160 || Math.min(a.x, b.x) > 240);
	}
	assert.notDeepEqual(route, routeConnection(from, { ...to, y: 140 }, [from, blocker], 1));
	assert.ok(shapePaths(blocker).detail);
});

test('diagram edits share undo and autosave with ink and deleting a node removes its links atomically', () => {
	const notebook = new Notebook();
	const from = notebook.addShape(box('triangle', 10, 10));
	const to = notebook.addShape(box('trapezoid', 120, 40));
	assert.equal(notebook.connectShapes(from, to, 1), true);
	const oldRoute = diagramRoutes(notebook.diagram)[0].points;
	const pending = notebook.pendingChanges();
	notebook.updateShape(to, box('trapezoid', 170, 110));
	assert.notDeepEqual(diagramRoutes(notebook.diagram)[0].points, oldRoute);
	notebook.acknowledgeChanges(pending.token);
	assert.equal(notebook.pendingChanges().diagram.nodes[1].x, 170);
	notebook.removeDiagramItem(from);
	assert.equal(notebook.diagram.connections.length, 0);
	notebook.undo();
	assert.equal(notebook.diagram.connections[0].from, from);
	notebook.clear();
	assert.equal(notebook.diagram.nodes.length, 0);
	notebook.undo();
	assert.equal(notebook.diagram.nodes.length, 2);
	const snapshot = notebook.snapshot({ gridX: -96, gridY: 48 }, { mode: 'grid', grid });
	assert.deepEqual(validateSnapshot(snapshot), snapshot);
	assert.throws(() => validateSnapshot({ ...snapshot, diagram: { ...snapshot.diagram, nodes: [snapshot.diagram.nodes[0]] } }), /two different shapes/);
});

test('grid exports share flowchart geometry, exclude scroll markers and map grid pages to PDF', () => {
	const notebook = new Notebook();
	const from = notebook.addShape(box('rectangle', -70, -50));
	const to = notebook.addShape(box('cylinder', 34, 37));
	notebook.connectShapes(from, to, 1);
	notebook.addMarker({ kind: 'section', y: 10, label: 'Scroll only' });
	const snapshot = notebook.snapshot({}, { mode: 'grid', grid });
	const svg = exportSVG(snapshot);
	assert.match(svg, /viewBox="-96 -96 192 192"/);
	assert.match(svg, /scroll-cells/);
	assert.match(svg, /data-connection-id=/);
	assert.match(svg, /data-shape-id=/);
	assert.match(svg, /stroke="#e5eaf1"/);
	assert.doesNotMatch(svg, /Scroll only/);
	const pdf = exportPDFHTML(snapshot);
	assert.equal(pdf.pageCount, 4);
	assert.match(pdf.html, /data-connection-id=/);
	assert.match(pdf.html, /preserveAspectRatio="xMidYMid meet"/);
});
