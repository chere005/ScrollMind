import test from 'node:test';
import assert from 'node:assert/strict';
import { SHAPES, makeShape } from '../src/core/shapes.mjs';
import { Notebook, validateSnapshot, boundsOf, strokeHitsPoint } from '../src/core/model.mjs';
import { exportSVG } from '../src/core/export.mjs';

const xy = stroke => stroke.points.map(({ x, y }) => ({ x, y }));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);
const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

test('supported shapes are a stable frozen list and pen styles use normal model validation', () => {
  assert.deepEqual(SHAPES, ['line', 'arrow', 'rectangle', 'ellipse', 'triangle']);
  assert.equal(Object.isFrozen(SHAPES), true);
  const [line] = makeShape('line', { x: -10, y: -200 }, { x: 20, y: -150 }, { color: '#215b9c', width: 4 });
  assert.equal(line.color, '#215b9c');
  assert.equal(line.width, 4);
  assert.ok(line.points.every(point => point.p === .56));
  assert.throws(() => makeShape('unknown', { x: 0, y: 0 }, { x: 1, y: 1 }), /Unknown shape/);
  assert.throws(() => makeShape('line', { x: 0, y: 0 }, { x: 1, y: 1 }, { width: 0 }), /width/);
  assert.throws(() => makeShape('line', { x: 0, y: 0 }, { x: 1, y: 1 }, { color: 'url(unsafe)' }), /color/);
  assert.throws(() => makeShape('line', { x: 0, y: 0 }, { x: 1, y: 1 }, { constrain: 'true' }), /constraint/);
});

test('negative rectangle drags normalize into a closed shape with all four corners', () => {
  const [rectangle] = makeShape('rectangle', { x: 80, y: -20 }, { x: -40, y: -120 });
  assert.deepEqual(xy(rectangle), [
    { x: -40, y: -120 }, { x: 80, y: -120 }, { x: 80, y: -20 }, { x: -40, y: -20 }, { x: -40, y: -120 },
  ]);
  assert.deepEqual(xy(makeShape('rectangle', { x: -40, y: -120 }, { x: 80, y: -20 })[0]), xy(rectangle));
});

test('ellipse sampling closes exactly, stays in signed bounds, and caps large shapes', () => {
  const [ellipse] = makeShape('ellipse', { x: 100, y: -200 }, { x: -100, y: -300 });
  assert.ok(ellipse.points.length >= 65 && ellipse.points.length <= 193);
  assert.deepEqual(ellipse.points[0], ellipse.points.at(-1));
  assert.ok(ellipse.points.every(point => point.x >= -100 && point.x <= 100 && point.y >= -300 && point.y <= -200));
  const [large] = makeShape('ellipse', { x: -999_999_999, y: -999_999_999 }, { x: 999_999_999, y: 999_999_999 });
  assert.equal(large.points.length, 193);
  assert.ok(large.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('Shift snaps signed lines and arrows to 45-degree increments while retaining length', () => {
  const start = { x: -100, y: -200 }, end = { x: -70, y: -176 };
  const [line] = makeShape('line', start, end, { constrain: true });
  near(line.points[1].x - start.x, line.points[1].y - start.y);
  near(length(line.points[0], line.points[1]), length(start, end));
  const [horizontal] = makeShape('line', { x: 5, y: 6 }, { x: -95, y: 10 }, { constrain: true });
  near(horizontal.points[1].y, 6);
  const [vertical] = makeShape('arrow', { x: 5, y: 6 }, { x: 8, y: -94 }, { constrain: true });
  near(vertical.points[1].x, 5);
  assert.ok(vertical.points[1].y < 6);
  const [boundary] = makeShape('line', { x: 1e9, y: 1e9 }, { x: 1e9, y: -1e9 }, { constrain: true });
  assert.deepEqual(xy(boundary), [{ x: 1e9, y: 1e9 }, { x: 1e9, y: -1e9 }]);
});

test('Shift squares rectangles, circles ellipses, and makes equilateral triangles', () => {
  for (const kind of ['rectangle', 'ellipse']) {
    const [shape] = makeShape(kind, { x: 20, y: 30 }, { x: -40, y: -60 }, { constrain: true });
    const bounds = boundsOf([shape]);
    near(bounds.width, bounds.height);
  }
  const [largeCircle] = makeShape('ellipse', { x: 0, y: 0 }, { x: 210, y: 190 }, { constrain: true });
  const circleBounds = boundsOf([largeCircle]);
  near(circleBounds.width, circleBounds.height);
  const [triangle] = makeShape('triangle', { x: 20, y: 30 }, { x: -40, y: -60 }, { constrain: true });
  assert.deepEqual(triangle.points[0], triangle.points.at(-1));
  near(length(triangle.points[0], triangle.points[1]), length(triangle.points[1], triangle.points[2]));
  near(length(triangle.points[1], triangle.points[2]), length(triangle.points[2], triangle.points[0]));
});

test('arrows retain drag direction and form separate editable wings at the endpoint', () => {
  const shapes = makeShape('arrow', { x: 50, y: -20 }, { x: -50, y: -20 }, { width: 3 });
  assert.equal(shapes.length, 3);
  assert.deepEqual(xy(shapes[0]), [{ x: 50, y: -20 }, { x: -50, y: -20 }]);
  for (const wing of shapes.slice(1)) {
    assert.deepEqual(wing.points[0], shapes[0].points[1]);
    assert.ok(wing.points[1].x > wing.points[0].x);
  }
  near(shapes[1].points[1].y + shapes[2].points[1].y, -40);
  assert.equal(new Set(shapes.map(shape => shape.id)).size, 3);
});

test('empty clicks and zero-area shapes create no ink, while finite tiny shapes remain valid', () => {
  for (const kind of SHAPES) assert.deepEqual(makeShape(kind, { x: 3, y: -4 }, { x: 3, y: -4 }), []);
  for (const kind of ['rectangle', 'ellipse', 'triangle']) {
    assert.deepEqual(makeShape(kind, { x: 0, y: 0 }, { x: 0, y: 100 }), []);
    assert.equal(makeShape(kind, { x: 0, y: 0 }, { x: 0, y: 100 }, { constrain: true }).length, 1);
    assert.equal(makeShape(kind, { x: 0, y: 0 }, { x: .0001, y: .0002 }).length, 1);
  }
  assert.equal(makeShape('line', { x: 0, y: 0 }, { x: 0, y: 100 }).length, 1);
  assert.throws(() => makeShape('line', { x: 0, y: 0 }, { x: 0, y: 0 }, { color: 'invalid' }), /color/);
});

test('invalid or overflowing geometry is rejected before it reaches the model', () => {
  assert.throws(() => makeShape('line', { x: NaN, y: 0 }, { x: 1, y: 2 }), /finite/);
  assert.throws(() => makeShape('ellipse', { x: 0, y: 0 }, { x: Infinity, y: 2 }), /finite/);
  assert.throws(() => makeShape('rectangle', { x: 0, y: 0 }, { x: 1e9 + 1, y: 2 }), /finite/);
  assert.throws(() => makeShape('rectangle', { x: 999999999, y: 0 }, { x: 1000000000, y: 100 }, { constrain: true }), /finite/);
});

test('shape arrays roundtrip, edit, erase, export, and undo through the existing stroke model', () => {
  const arrow = makeShape('arrow', { x: -20, y: -80 }, { x: 100, y: -80 }, { color: '#b94d49', width: 4 });
  const scroll = new Notebook();
  scroll.add(arrow);
  const original = validateSnapshot(JSON.parse(JSON.stringify(scroll.snapshot())));
  assert.equal(original.strokes.length, 3);
  scroll.undo();
  assert.equal(scroll.strokes.length, 0);
  scroll.redo();
  assert.equal(scroll.strokes.length, 3);
  const copy = new Notebook(original);
  copy.move(arrow.map(stroke => stroke.id), 10, 20);
  assert.equal(copy.get(arrow[0].id).points[0].y, -60);
  assert.equal(copy.get(arrow[0].id).points[0].p, .56);
  assert.equal(strokeHitsPoint(copy.get(arrow[0].id), { x: 20, y: -60 }), true);
  copy.remove([arrow[0].id]);
  assert.equal(copy.strokes.length, 2);
  copy.undo();
  assert.equal(copy.strokes.length, 3);
  const svg = exportSVG(copy.snapshot());
  assert.equal((svg.match(/data-stroke-id=/g) ?? []).length, 3);
  assert.match(svg, /stroke="#b94d49"/);
  assert.deepEqual(new Notebook(original).strokes, scroll.strokes);
});
