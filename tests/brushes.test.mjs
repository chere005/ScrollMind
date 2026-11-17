import test from 'node:test';
import assert from 'node:assert/strict';
import { PEN_TYPES, brushWidth, maxBrushWidth, brushCap } from '../src/core/brushes.mjs';
import { Notebook, makeStroke, validateSnapshot, validateStrokes, boundsOf, strokeHitsPoint, strokeIntersectsRect } from '../src/core/model.mjs';

const point = (x, y, p = 1) => ({ x, y, p });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} should equal ${b}`);

test('new pen pressure is substantially stronger while legacy ink retains its original curve', () => {
  const legacy = brushWidth(12, .9) / brushWidth(12, .1);
  const pen = brushWidth(12, .9, 'pen') / brushWidth(12, .1, 'pen');
  assert.ok(legacy < 4);
  assert.ok(pen > 10);
  near(brushWidth(3, .5), 2.775);
  near(maxBrushWidth(10), 15.5);
  near(maxBrushWidth(10, 'pen'), 20);
  assert.equal(brushCap(), 'round');
});

test('all brushes have bounded monotone pressure; fountain nib responds to direction', () => {
  assert.deepEqual(PEN_TYPES, ['pen', 'pencil', 'fountain', 'marker']);
  for (const penType of PEN_TYPES) {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
      let previous = 0;
      for (let p = 0; p <= 10; p++) {
        const actual = brushWidth(12, p / 10, penType, angle);
        assert.ok(actual >= previous && actual > 0);
        assert.ok(actual <= maxBrushWidth(12, penType) + 1e-12);
        previous = actual;
      }
    }
  }
  assert.ok(brushWidth(10, 1, 'pencil') < brushWidth(10, 1, 'pen'));
  assert.ok(brushWidth(10, 1, 'fountain', Math.PI * 3 / 4) > brushWidth(10, 1, 'fountain', Math.PI / 4) * 2.8);
  near(brushWidth(10, .6, 'fountain', .2), brushWidth(10, .6, 'fountain', .2 + Math.PI));
  assert.ok(brushWidth(10, 1, 'marker') / brushWidth(10, 0, 'marker') < 1.5);
  assert.equal(brushCap('marker'), 'square');
  assert.equal(brushCap('fountain'), 'round');
});

test('new strokes explicitly record pen type while old stroke and settings absence survives validation', () => {
  const explicit = makeStroke([point(1, -2, .3)], '#215b9c', 4);
  assert.equal(explicit.penType, 'pen');
  const legacy = { id: 'legacy', points: [point(3, -4, .7)], color: '#243746', width: 3 };
  const snapshot = validateSnapshot({ version: 1, strokes: [legacy, explicit] });
  assert.equal(Object.hasOwn(snapshot.strokes[0], 'penType'), false);
  assert.equal(snapshot.strokes[1].penType, 'pen');
  assert.equal(Object.hasOwn(snapshot.settings, 'penType'), false);
  const selected = validateSnapshot({ version: 1, strokes: [], settings: { penType: 'pen' } });
  assert.equal(selected.settings.penType, 'pen');
});

test('pen types survive editing, clipboard validation, persistence, and history without changing pressure', () => {
  const strokes = PEN_TYPES.map((penType, index) => makeStroke([point(index, -100, .1), point(index + 20, -80, .9)], '#243746', 4, penType));
  const scroll = new Notebook();
  scroll.add(strokes);
  scroll.acknowledgeChanges(scroll.pendingChanges().token);
  scroll.move(strokes.map(stroke => stroke.id), 100, -50);
  assert.deepEqual(scroll.pendingChanges().upserts.map(stroke => stroke.penType), PEN_TYPES);
  scroll.transform(strokes.map(stroke => stroke.id), { scaleX: 2, scaleY: .5 });
  const saved = validateSnapshot(JSON.parse(JSON.stringify(scroll.snapshot({ offsetY: -120 }, { penType: 'marker' }))));
  const copied = validateStrokes(saved.strokes);
  assert.deepEqual(copied.map(stroke => stroke.penType), PEN_TYPES);
  assert.ok(copied.every(stroke => stroke.points[0].p === .1 && stroke.points[1].p === .9));
  assert.equal(saved.settings.penType, 'marker');
  scroll.undo();
  assert.deepEqual(scroll.strokes.map(stroke => stroke.penType), PEN_TYPES);
  scroll.undo();
  assert.deepEqual(scroll.strokes, strokes);
});

test('strong pen edges remain in culling, selection, and erasing across spatial bucket boundaries', () => {
  const stroke = makeStroke([point(10, -1030), point(100, -1030)], '#243746', 10, 'pen');
  const scroll = new Notebook(); scroll.add([stroke]);
  const bounds = boundsOf(scroll.strokes);
  assert.equal(bounds.y, -1040);
  assert.equal(bounds.height, 20);
  const edge = { x: 45, y: -1020.5, width: 3, height: .25 };
  assert.equal(scroll.query(edge)[0].id, stroke.id);
  assert.equal(strokeIntersectsRect(stroke, edge), true);
  assert.equal(strokeHitsPoint(stroke, point(50, -1020.1)), true);
  assert.equal(strokeHitsPoint(stroke, point(50, -1019.9)), false);
});

test('fountain hit geometry follows the broad nib direction instead of nominal pen width', () => {
  const narrow = makeStroke([point(0, 0), point(100, 100)], '#243746', 10, 'fountain');
  const broad = makeStroke([point(0, 0), point(-100, 100)], '#243746', 10, 'fountain');
  const offset = 6 / Math.SQRT2;
  assert.equal(strokeHitsPoint(narrow, point(50 - offset, 50 + offset)), false);
  assert.equal(strokeHitsPoint(broad, point(-50 - offset, 50 - offset)), true);
  assert.ok(boundsOf([broad]).height > boundsOf([narrow]).height);
});

test('marker square caps and diagonal corners are selectable and erasable without circular false hits', () => {
  const horizontal = makeStroke([point(0, -1025), point(100, -1025)], '#243746', 10, 'marker');
  assert.equal(strokeHitsPoint(horizontal, point(-5.9, -1030.9)), true);
  assert.equal(strokeIntersectsRect(horizontal, { x: -5.9, y: -1030.9, width: .1, height: .1 }), true);
  assert.equal(strokeHitsPoint(horizontal, point(-6.1, -1025)), false);
  assert.equal(strokeHitsPoint(horizontal, point(-6.1, -1025), .2), true);
  assert.equal(strokeIntersectsRect(horizontal, { x: -7, y: -1026, width: .1, height: .1 }), false);
  const diagonal = makeStroke([point(0, -1024), point(100, -924)], '#243746', 10, 'marker');
  const scroll = new Notebook(); scroll.add([diagonal]);
  assert.ok(boundsOf(scroll.strokes).x < -8.4);
  assert.equal(scroll.query({ x: -8, y: -1024, width: .1, height: .1 })[0].id, diagonal.id);
  assert.equal(strokeHitsPoint(diagonal, point(-8, -1024)), true);
  const dot = makeStroke([point(0, 0)], '#243746', 10, 'marker');
  assert.equal(strokeHitsPoint(dot, point(5.9, 5.9)), true);
  assert.equal(strokeHitsPoint(dot, point(6.1, 0)), false);
  near(boundsOf([dot]).width, 12);
});

test('unknown pen types and invalid brush numbers cannot be persisted or rendered', () => {
  assert.throws(() => makeStroke([point(0, 0)], '#243746', 3, 'unknown'), /pen type/);
  assert.throws(() => validateSnapshot({ version: 1, strokes: [], settings: { penType: 'unknown' } }), /pen type/);
  assert.throws(() => brushWidth(3, NaN, 'pen'), /pressure/);
  assert.throws(() => brushWidth(3, 1.1, 'pen'), /pressure/);
  assert.throws(() => brushWidth(3, .5, 'fountain', Infinity), /angle/);
  assert.throws(() => maxBrushWidth(Infinity, 'pen'), /width/);
  assert.throws(() => brushCap(null), /pen type/);
});
