import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStroke, Notebook, boundsOf, strokeHitsPoint, strokeIntersectsRect, validateSnapshot } from '../src/core/model.mjs';
import { strokeGeometry, geometryHitsPoint } from '../src/core/stroke-geometry.mjs';

const point = (x, y, p = .6) => ({ x, y, p });
const signedArea = polygon => {
  const origin = polygon[0];
  return polygon.reduce((total, a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return total + (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y);
  }, 0) / 2;
};

test('highlighter uses one union fill with only positive-winding components at self intersections', () => {
  const stroke = makeStroke([point(300, 300), point(500, 300), point(400, 220), point(400, 460)], '#ffff00', 12, 'highlighter');
  const geometry = strokeGeometry(stroke);
  assert.ok(geometry.path.startsWith('M'));
  assert.equal((geometry.path.match(/Z/g) ?? []).length, geometry.contours.length);
  assert.ok(geometry.contours.every(contour => signedArea(contour) > 0));
  assert.equal(geometryHitsPoint(geometry, point(350, 300)), true);
  assert.equal(geometryHitsPoint(geometry, point(400, 300)), true);
  assert.equal(geometryHitsPoint(geometry, point(400, 365)), true);
  assert.equal(geometryHitsPoint(geometry, point(250, 300)), false);
  assert.doesNotMatch(geometry.path, /opacity|NaN|Infinity/);
});

test('fountain centerline rounds corners and filtered widths form a continuous bounded fill', () => {
  const stroke = makeStroke([point(0, 0, .1), point(50, 80, .9), point(100, 0, .2)], '#171717', 12, 'fountain');
  const original = structuredClone(stroke.points);
  const geometry = strokeGeometry(stroke);
  assert.ok(geometry.contours.length > stroke.points.length);
  assert.ok(geometry.contours.every(contour => signedArea(contour) > 0));
  assert.equal(strokeHitsPoint(stroke, point(0, 0)), true);
  assert.equal(strokeHitsPoint(stroke, point(100, 0)), true);
  assert.ok(Number.isFinite(geometry.bounds.width) && Number.isFinite(geometry.bounds.height));
  assert.deepEqual(stroke.points, original);
  assert.ok(geometry.contours.flat().every(point => point.x >= geometry.bounds.x && point.x <= geometry.bounds.x + geometry.bounds.width + 1e-9
    && point.y >= geometry.bounds.y && point.y <= geometry.bounds.y + geometry.bounds.height + 1e-9));
});

test('fountain width filtering removes alternating per-segment nib steps', () => {
  const points = Array.from({ length: 50 }, (_, index) => point(index * 3, index % 2 ? .7 : -.7, .7));
  const geometry = strokeGeometry(makeStroke(points, '#171717', 12, 'fountain'));
  const body = geometry.contours.slice(0, -2);
  const heights = body.slice(5, -5).map(contour => Math.max(...contour.map(point => point.y)) - Math.min(...contour.map(point => point.y)));
  assert.ok(Math.max(...heights) - Math.min(...heights) < 1.5);
});

test('shared fill bounds and contours govern culling, rectangle selection, erasing, and editing', () => {
  const stroke = makeStroke([point(-100, -1030), point(100, -1030)], '#ffff00', 12, 'highlighter');
  const scroll = new Notebook(); scroll.add([stroke]);
  const geometry = strokeGeometry(scroll.get(stroke.id));
  assert.deepEqual(boundsOf(scroll.strokes), geometry.bounds);
  const edge = { x: -105, y: -1040, width: 2, height: 1 };
  assert.equal(scroll.query(edge)[0].id, stroke.id);
  assert.equal(strokeIntersectsRect(scroll.get(stroke.id), edge), true);
  assert.equal(strokeHitsPoint(scroll.get(stroke.id), point(-105, -1040)), true);
  scroll.move([stroke.id], 50, 200);
  assert.equal(strokeHitsPoint(scroll.get(stroke.id), point(-55, -840)), true);
  scroll.undo();
  assert.deepEqual(boundsOf(scroll.strokes), geometry.bounds);
  assert.equal(validateSnapshot(JSON.parse(JSON.stringify(scroll.snapshot()))).strokes[0].penType, 'highlighter');
});

test('repeated stationary pressure points form a visible dot and leave raw data unchanged', () => {
  for (const penType of ['fountain', 'highlighter']) {
    const stroke = makeStroke([point(10, -20, .1), point(10, -20, 1)], '#ffff00', 12, penType);
    const geometry = strokeGeometry(stroke);
    assert.ok(geometry.path.length > 10);
    assert.equal(geometryHitsPoint(geometry, point(10, -20)), true);
    assert.deepEqual(stroke.points.map(point => point.p), [.1, 1]);
  }
});

test('only deeply frozen model strokes are cached; previews reflect mutations', () => {
  const preview = makeStroke([point(0, 0), point(50, 0)], '#171717', 6, 'fountain');
  const first = strokeGeometry(preview);
  preview.points[1].y = 20;
  assert.notEqual(strokeGeometry(preview).path, first.path);
  const scroll = new Notebook(); scroll.add([preview]);
  const stored = scroll.get(preview.id);
  assert.strictEqual(strokeGeometry(stored), strokeGeometry(stored));
  assert.equal(Object.isFrozen(strokeGeometry(stored).contours[0]), true);
  assert.equal(strokeGeometry(makeStroke([point(0, 0)], '#171717', 3, 'pen')), null);
});

test('large coordinate gaps and dense imports have bounded sampling and finite geometry', () => {
  const jump = strokeGeometry(makeStroke([point(-1e9, -1e9), point(1e9, 1e9)], '#171717', 12, 'fountain'));
  assert.ok(jump.contours.length < 140);
  assert.ok(jump.path.length < 100_000);
  assert.doesNotMatch(jump.path, /NaN|Infinity/);
  const raw = Array.from({ length: 12_001 }, (_, index) => point(index / 2, index % 2 ? .25 : -.25));
  const dense = strokeGeometry(makeStroke(raw, '#171717', 3, 'fountain'));
  assert.ok(dense.contours.length <= raw.length + 2);
  assert.ok(dense.path.length < 4_000_000);
});
