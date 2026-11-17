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

test('incremental saves retain edits made while an earlier batch is in flight', () => {
  const scroll = new Notebook();
  scroll.add([stroke('a', [[1, 2, .3], [5, 8, .9]])]);
  const first = scroll.pendingChanges();
  assert.equal(first.order, undefined);
  assert.equal(first.upserts.length, 1);
  scroll.move(['a'], 100, -50);
  scroll.acknowledgeChanges(first.token);
  const second = scroll.pendingChanges();
  assert.equal(second.upserts[0].points[0].x, 101);
  assert.equal(second.upserts[0].points[0].y, -48);
  assert.equal(second.order, undefined);
  scroll.acknowledgeChanges(second.token);
  assert.deepEqual(scroll.pendingChanges().upserts, []);
  scroll.remove(['a']);
  const deletion = scroll.pendingChanges();
  assert.deepEqual(deletion.removals, ['a']);
  scroll.undo();
  scroll.acknowledgeChanges(deletion.token);
  assert.equal(scroll.pendingChanges().upserts[0].id, 'a');
  assert.deepEqual(scroll.pendingChanges().removals, []);
});

test('incremental metadata and history do not re-send unchanged stroke geometry', () => {
  const scroll = new Notebook({ version: 1, strokes: [stroke('original', [[4, -5]])] });
  assert.deepEqual(scroll.pendingChanges(), { token: 0, upserts: [], removals: [] });
  scroll.addMarker({ id: 'section', y: -30, label: 'Ideas', kind: 'section' });
  const first = scroll.pendingChanges();
  scroll.updateMarker('section', { label: 'New ideas' });
  scroll.acknowledgeChanges(first.token);
  const second = scroll.pendingChanges();
  assert.equal(second.markers[0].label, 'New ideas');
  assert.deepEqual(second.upserts, []);
  assert.equal(second.order, undefined);
  scroll.acknowledgeChanges(second.token);
  scroll.undo();
  assert.equal(scroll.pendingChanges().markers[0].label, 'Ideas');
  assert.throws(() => scroll.acknowledgeChanges(999), /token/);
});

test('ordinary appends avoid resending scroll order; undoing an erase restores painter order', () => {
  const scroll = new Notebook({ version: 1, strokes: [stroke('a', [[1, 2]]), stroke('b', [[3, 4]])] });
  scroll.add([stroke('c', [[5, 6]]), stroke('d', [[7, 8]])]);
  const added = scroll.pendingChanges();
  assert.equal(added.order, undefined);
  assert.deepEqual(added.upserts.map(stroke => stroke.id), ['c', 'd']);
  scroll.acknowledgeChanges(added.token);
  scroll.remove(['b']);
  const erased = scroll.pendingChanges();
  assert.equal(erased.order, undefined);
  scroll.acknowledgeChanges(erased.token);
  scroll.undo();
  assert.deepEqual(scroll.pendingChanges().order, ['a', 'b', 'c', 'd']);
});

test('clear removes all ink and marker kinds in one undo without changing paper or view', () => {
  const source = {
    version: 1,
    strokes: [stroke('bottom', [[10, 900, .2], [20, 920, .8]]), stroke('top', [[-50, -700, 1]])],
    markers: [
      { id: 'section', y: -700, label: 'Start', kind: 'section' },
      { id: 'break', y: 0, label: 'Next page', kind: 'page-break' },
      { id: 'bookmark', y: 800, label: 'Keep', kind: 'marker' },
    ],
    view: { offsetY: -900 },
    settings: { paper: 'ruled', paperTone: 'parchment', color: '#215b9c', width: 4 },
  };
  const scroll = new Notebook(source);
  const before = scroll.snapshot(source.view, source.settings);
  assert.equal(scroll.clear(), true);
  assert.deepEqual(scroll.strokes, []);
  assert.deepEqual(scroll.markers, []);
  const cleared = scroll.snapshot(source.view, source.settings);
  assert.deepEqual(cleared.view, before.view);
  assert.deepEqual(cleared.settings, before.settings);
  assert.equal(scroll.undo(), true);
  assert.deepEqual(scroll.snapshot(source.view, source.settings), before);
  assert.equal(scroll.canUndo, false);
  assert.equal(scroll.redo(), true);
  assert.deepEqual(scroll.strokes, []);
  assert.deepEqual(scroll.markers, []);
});

test('clear journals only removed stroke IDs and the empty marker list; undo restores exact data', () => {
  const scroll = new Notebook({
    version: 1,
    strokes: [stroke('a', [[1, -2, .3], [5, 8, .9]]), stroke('b', [[3, 4, .1]])],
    markers: [{ id: 'section', y: -20, label: 'Ideas', kind: 'section' }],
  });
  assert.equal(scroll.clear(), true);
  const cleared = scroll.pendingChanges();
  assert.deepEqual(cleared.upserts, []);
  assert.deepEqual(cleared.removals, ['a', 'b']);
  assert.deepEqual(cleared.markers, []);
  assert.equal(cleared.order, undefined);
  assert.equal(cleared.view, undefined);
  assert.equal(cleared.settings, undefined);
  scroll.undo();
  // An earlier clear batch can be acknowledged after Undo without dropping the restoration.
  scroll.acknowledgeChanges(cleared.token);
  const restored = scroll.pendingChanges();
  assert.deepEqual(restored.upserts.map(item => item.id), ['a', 'b']);
  assert.deepEqual(restored.upserts[0].points, [{ x: 1, y: -2, p: .3 }, { x: 5, y: 8, p: .9 }]);
  assert.deepEqual(restored.removals, []);
  assert.deepEqual(restored.order, ['a', 'b']);
  assert.deepEqual(restored.markers, [{ id: 'section', y: -20, label: 'Ideas', kind: 'section' }]);
  scroll.acknowledgeChanges(restored.token);
  scroll.redo();
  assert.deepEqual(scroll.pendingChanges().removals, ['a', 'b']);
  assert.deepEqual(scroll.pendingChanges().markers, []);
});

test('clear handles marker-only scrolls and an empty clear does not consume history', () => {
  const scroll = new Notebook();
  assert.equal(scroll.clear(), false);
  assert.equal(scroll.canUndo, false);
  assert.deepEqual(scroll.pendingChanges(), { token: 0, upserts: [], removals: [] });
  scroll.addMarker({ id: 'only', y: 0, label: '', kind: 'page-break' });
  scroll.acknowledgeChanges(scroll.pendingChanges().token);
  assert.equal(scroll.clear(), true);
  assert.deepEqual(scroll.pendingChanges().upserts, []);
  assert.deepEqual(scroll.pendingChanges().removals, []);
  assert.deepEqual(scroll.pendingChanges().markers, []);
  assert.equal(scroll.clear(), false);
  scroll.undo();
  assert.equal(scroll.markers[0].id, 'only');
});
