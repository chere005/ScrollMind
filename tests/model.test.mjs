import test from 'node:test';
import assert from 'node:assert/strict';
import { Notebook, boundsOf, makeStroke, strokeHitsPoint, strokeIntersectsRect, validateSnapshot, validateStrokes } from '../src/core/model.mjs';

const stroke = (id, coordinates, width = 2) => ({ id, color: '#263245', width, points: coordinates.map(([x, y, p = 0.5]) => ({ x, y, p })) });

test('signed-world culling crosses bucket boundaries and updates after movement/undo', () => {
  const notebook = new Notebook();
  notebook.add([stroke('above', [[0, -2048], [20, -1024]]), stroke('below', [[5, 5000], [10, 5010]])]);
  assert.deepEqual(notebook.query({ x: -5, y: -1030, width: 30, height: 20 }).map((item) => item.id), ['above']);
  assert.deepEqual(notebook.query({ x: -5, y: 0, width: 30, height: 100 }), []);
  notebook.move(['above'], 0, 2048);
  assert.deepEqual(notebook.query({ x: -5, y: 0, width: 30, height: 100 }).map((item) => item.id), ['above']);
  notebook.undo();
  assert.deepEqual(notebook.query({ x: -5, y: 0, width: 30, height: 100 }), []);
});

test('very tall strokes remain queryable without a huge per-stroke bucket index', () => {
  const notebook = new Notebook();
  notebook.add([stroke('long', [[0, -999_000_000], [10, 999_000_000]])]);
  assert.equal(notebook.query({ x: -10, y: -500_000_000, width: 100, height: 100 })[0].id, 'long');
  assert.equal(notebook.query({ x: -10, y: -999_000_000, width: 100, height: 1_998_000_000 }).length, 1);
  notebook.remove(['long']);
  assert.equal(notebook.query({ x: -10, y: 0, width: 100, height: 100 }).length, 0);
});

test('selection recognizes crossing segments and ink thickness rather than only sampled points', () => {
  const crossing = stroke('line', [[-100, 10], [100, 10]], 4);
  assert.equal(strokeIntersectsRect(crossing, { x: -5, y: 8, width: 10, height: 4 }), true);
  assert.equal(strokeIntersectsRect(crossing, { x: -5, y: 11, width: 10, height: 1 }), true);
  assert.equal(strokeIntersectsRect(crossing, { x: -5, y: 20, width: 10, height: 1 }), false);
  assert.equal(strokeIntersectsRect(crossing, { x: 5, y: 12, width: -10, height: -4 }), true);
  assert.equal(strokeHitsPoint(crossing, { x: 0, y: 14.8 }, 3), true);
  assert.equal(strokeHitsPoint(crossing, { x: 0, y: 15 }, 3), false);
  const dot = stroke('dot', [[2, 3]], 6);
  assert.equal(strokeHitsPoint(dot, { x: 4.7, y: 3 }), true);
  const diameter = 6 * (0.3 + 0.5 * 1.25);
  assert.deepEqual(boundsOf([dot]), { x: 2 - diameter / 2, y: 3 - diameter / 2, width: diameter, height: diameter });
  assert.equal(strokeIntersectsRect(stroke('corner', [[-0.9, -0.9]], 2), { x: 0, y: 0, width: 10, height: 10 }), false);
  assert.equal(boundsOf([]), null);
});

test('high-pressure ink edges remain visible to culling, selection, and erasing', () => {
  const notebook = new Notebook();
  notebook.add([stroke('thick', [[10, -1030, 1], [100, -1030, 1]], 10)]);
  const thick = notebook.get('thick');
  const bounds = boundsOf([thick]);
  assert.equal(bounds.y, -1037.75);
  assert.equal(bounds.height, 15.5);
  // The visible edge is 7.75 px from the centerline, beyond nominal width / 2.
  const edge = { x: 45, y: -1023, width: 3, height: 0.5 };
  assert.deepEqual(notebook.query(edge).map((item) => item.id), ['thick']);
  assert.equal(strokeIntersectsRect(thick, edge), true);
  assert.equal(strokeHitsPoint(thick, { x: 50, y: -1022.5 }), true);
  assert.equal(strokeHitsPoint(thick, { x: 50, y: -1022 }), false);
  const hairline = stroke('hairline', [[0, 0, 0]], 0.01);
  assert.equal(boundsOf([hairline]).width, 0.35);
});

test('grouped erase restores complete strokes and painter order as one undo', () => {
  const notebook = new Notebook();
  notebook.add([stroke('a', [[0, 0]]), stroke('b', [[1, 1]]), stroke('c', [[2, 2]])]);
  notebook.beginGroup();
  notebook.remove(['a']);
  notebook.remove(['c']);
  notebook.endGroup();
  assert.deepEqual(notebook.strokes.map((item) => item.id), ['b']);
  assert.equal(notebook.undo(), true);
  assert.deepEqual(notebook.strokes.map((item) => item.id), ['a', 'b', 'c']);
  assert.equal(notebook.redo(), true);
  assert.deepEqual(notebook.strokes.map((item) => item.id), ['b']);
  notebook.undo();
  notebook.move(['b'], 7, -12);
  assert.equal(notebook.canRedo, false);
  assert.deepEqual(notebook.get('b').points[0], { x: 8, y: -11, p: 0.5 });
});

test('selection transforms preserve pressure and can undo exactly without mutating old strokes', () => {
  const notebook = new Notebook();
  notebook.add([stroke('a', [[10, -20, 0.2], [30, 0, 0.8]], 2)]);
  const original = notebook.get('a');
  notebook.transform(['a'], { scaleX: 2, scaleY: 2, originX: 10, originY: -20, dx: 5, dy: 10 });
  assert.deepEqual(notebook.get('a').points, [{ x: 15, y: -10, p: 0.2 }, { x: 55, y: 30, p: 0.8 }]);
  assert.equal(notebook.get('a').width, 4);
  assert.deepEqual(original.points[1], { x: 30, y: 0, p: 0.8 });
  notebook.undo();
  assert.strictEqual(notebook.get('a'), original);
  assert.throws(() => { notebook.get('a').points[0].x = 200; }, TypeError);
  assert.throws(() => notebook.transform(['a'], { scaleX: 0 }), /zero/);
});

test('nested groups retain the first before and final after state', () => {
  const notebook = new Notebook();
  notebook.add([stroke('a', [[0, 0]])]);
  notebook.beginGroup();
  notebook.move(['a'], 5, 0);
  notebook.beginGroup();
  notebook.move(['a'], 8, 0);
  notebook.endGroup();
  notebook.move(['a'], 0, -9);
  notebook.endGroup();
  assert.deepEqual(notebook.get('a').points[0], { x: 13, y: -9, p: 0.5 });
  notebook.undo();
  assert.deepEqual(notebook.get('a').points[0], { x: 0, y: 0, p: 0.5 });
  notebook.redo();
  assert.deepEqual(notebook.get('a').points[0], { x: 13, y: -9, p: 0.5 });
});

test('snapshot roundtrip keeps signed positions, settings, pressure, and ink', () => {
  const notebook = new Notebook();
  notebook.add([stroke('a', [[1, -500, 0.1], [2, -499, 0.9]])]);
  const snapshot = validateSnapshot(JSON.parse(JSON.stringify(notebook.snapshot({ offsetY: -98765 }, { color: '#ffeeaa', width: 3, paper: 'dots' }))));
  assert.equal(snapshot.view.offsetY, -98765);
  assert.deepEqual(snapshot.settings, { color: '#ffeeaa', width: 3, paper: 'dots', paperTone: 'ivory' });
  assert.deepEqual(new Notebook(snapshot).strokes, notebook.strokes);
  assert.equal(new Notebook(snapshot).canUndo, false);
});

test('corrupt or oversized imports are rejected before changing the notebook', () => {
  const notebook = new Notebook();
  notebook.add([stroke('a', [[0, 0]])]);
  assert.throws(() => validateSnapshot({ version: 2, strokes: [] }), /version/);
  assert.throws(() => validateSnapshot({}), /version/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [stroke('bad', [[NaN, 0]])] }), /finite/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [stroke('bad', [[0, 0, 1.1]])] }), /pressure/);
  assert.throws(() => validateStrokes([stroke('same', [[0, 0]]), stroke('same', [[1, 1]])]), /Duplicate/);
  assert.throws(() => validateStrokes([stroke('large', new Array(200_001).fill([0, 0]))]), /points/);
  assert.throws(() => notebook.add([stroke('b', [[1, 1]]), stroke('a', [[2, 2]])]), /already exists/);
  assert.deepEqual(notebook.strokes.map((item) => item.id), ['a']);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], settings: { color: 'url(bad)' } }), /color/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], view: { offsetY: Infinity } }), /finite/);
});

test('markers preserve signed positions, paper styling, and differential undo', () => {
  const notebook = new Notebook();
  notebook.addMarker({ id: 'later', y: 500, label: 'Second section', kind: 'section' });
  notebook.addMarker({ id: 'early', y: -250, label: 'First section', kind: 'page-break' });
  assert.deepEqual(notebook.markers.map((item) => item.id), ['early', 'later']);
  notebook.beginGroup();
  notebook.updateMarker('early', { y: -500, label: 'Start' });
  notebook.removeMarker('later');
  notebook.endGroup();
  assert.deepEqual(notebook.markers, [{ id: 'early', y: -500, label: 'Start', kind: 'page-break' }]);
  notebook.undo();
  assert.equal(notebook.markers.length, 2);
  assert.equal(notebook.markers[0].y, -250);
  notebook.redo();
  assert.equal(notebook.markers.length, 1);
  const snapshot = validateSnapshot(JSON.parse(JSON.stringify(notebook.snapshot({}, { paper: 'ruled', paperTone: 'night' }))));
  assert.equal(snapshot.settings.paperTone, 'night');
  assert.deepEqual(new Notebook(snapshot).markers, notebook.markers);
  const legacy = validateSnapshot({ version: 1, strokes: [] });
  assert.deepEqual(legacy.markers, []);
  assert.equal(legacy.settings.paperTone, 'ivory');
});

test('marker corruption is rejected and stroke/marker IDs cannot collide in undo groups', () => {
  const notebook = new Notebook();
  notebook.beginGroup();
  notebook.add([stroke('shared', [[1, 2]])]);
  notebook.addMarker({ id: 'shared', y: 50, label: 'Marker', kind: 'marker' });
  notebook.endGroup();
  notebook.undo();
  assert.equal(notebook.strokes.length, 0);
  assert.equal(notebook.markers.length, 0);
  notebook.redo();
  assert.equal(notebook.strokes.length, 1);
  assert.equal(notebook.markers.length, 1);
  assert.throws(() => notebook.updateMarker('shared', { label: 'x'.repeat(201) }), /200/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], markers: [{ id: 'bad', y: Infinity, label: '', kind: 'marker' }] }), /finite/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], markers: [{ id: 'bad', y: 0, label: '', kind: 'unknown' }] }), /kind/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], settings: { paperTone: 'unknown' } }), /tone/);
});

test('new clipboard identities are unique and import data is detached', () => {
  const source = stroke('source', [[0, -1, 0.3]]);
  const imported = validateStrokes([source]);
  source.points[0].y = 900;
  assert.equal(imported[0].points[0].y, -1);
  const a = makeStroke(imported[0].points, imported[0].color, imported[0].width);
  const b = makeStroke(imported[0].points, imported[0].color, imported[0].width);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.id, 'source');
});
