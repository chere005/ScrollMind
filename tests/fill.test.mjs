import test from 'node:test';
import assert from 'node:assert/strict';
import { dilate, floodFill, traceRegion, simplifyLoop, fillRegion, contoursToPoints, pointsToContours, pointInContours, contoursPath, isFill } from '../src/core/fill.mjs';

const W = 60, H = 40;
function bitmap(draw) {
	const mask = new Uint8Array(W * H);
	draw((x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) mask[y * W + x] = 1; });
	return mask;
}
const line = (set, x0, y0, x1, y1) => { const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= steps; i++) set(Math.round(x0 + (x1 - x0) * i / steps), Math.round(y0 + (y1 - y0) * i / steps)); };
const box = (set, x0, y0, x1, y1, thickness = 2) => { for (let t = 0; t < thickness; t++) { line(set, x0 + t, y0 + t, x1 - t, y0 + t); line(set, x1 - t, y0 + t, x1 - t, y1 - t); line(set, x1 - t, y1 - t, x0 + t, y1 - t); line(set, x0 + t, y1 - t, x0 + t, y0 + t); } };
const bounds = (contours) => {
	const all = contours.flat();
	return { left: Math.min(...all.map(p => p.x)), right: Math.max(...all.map(p => p.x)), top: Math.min(...all.map(p => p.y)), bottom: Math.max(...all.map(p => p.y)) };
};

test('dilation grows a pixel by the radius in every direction and leaves the input alone', () => {
	const mask = bitmap(set => set(10, 10));
	const grown = dilate(mask, W, H, 2);
	assert.equal(grown.reduce((sum, value) => sum + value, 0), 25);
	assert.equal(grown[8 * W + 8], 1);
	assert.equal(grown[7 * W + 10], 0);
	assert.equal(mask.reduce((sum, value) => sum + value, 0), 1);
	assert.deepEqual(dilate(mask, W, H, 0), mask);
});

test('flood fill stops at ink and reports an area that runs off the page', () => {
	const closed = bitmap(set => box(set, 10, 8, 40, 30));
	const inside = floodFill(closed, W, H, 20, 20);
	assert.equal(inside.touchesEdge, false);
	assert.equal(inside.count, (40 - 10 - 3) * (30 - 8 - 3));
	assert.equal(floodFill(closed, W, H, 2, 2).touchesEdge, true);
	assert.equal(floodFill(closed, W, H, 10, 8).seedBlocked, true);
	assert.equal(floodFill(closed, W, H, -1, 5).seedBlocked, true);
});

test('an enclosed outline fills out under its line as one simple outline', () => {
	const barrier = bitmap(set => box(set, 10, 8, 40, 30));
	const result = fillRegion({ barrier, width: W, height: H, seedX: 20, seedY: 20 });
	assert.equal(result.status, 'filled');
	assert.equal(result.contours.length, 1);
	assert.equal(result.contours[0].length, 4);
	assert.deepEqual(bounds(result.contours), { left: 11, right: 40, top: 9, bottom: 30 });
});

test('an island inside the area stays unfilled by the even-odd rule', () => {
	const barrier = bitmap(set => { box(set, 6, 4, 54, 36); box(set, 22, 14, 38, 26); });
	const result = fillRegion({ barrier, width: W, height: H, seedX: 12, seedY: 10 });
	assert.equal(result.status, 'filled');
	assert.equal(result.contours.length, 2);
	assert.equal(pointInContours(result.contours, 12, 10), true);
	assert.equal(pointInContours(result.contours, 30, 20), false);
	assert.equal(pointInContours(result.contours, 3, 3), false);
	const inner = fillRegion({ barrier, width: W, height: H, seedX: 30, seedY: 20 });
	assert.equal(inner.contours.length, 1);
	assert.equal(pointInContours(inner.contours, 30, 20), true);
	assert.equal(pointInContours(inner.contours, 12, 10), false);
});

test('a small gap in a hand-drawn outline is closed and a wide one is reported open', () => {
	const gapped = (gap) => bitmap(set => { line(set, 10, 8, 40, 8); line(set, 40, 8, 40, 30); line(set, 40, 30, 10, 30); line(set, 10, 30, 10, 8 + gap + 0); line(set, 10, 8, 10, 8); for (let y = 8; y <= 30 - gap; y++) if (y < 8 || y > 8 + gap) set(10, y); });
	const small = fillRegion({ barrier: gapped(3), width: W, height: H, seedX: 20, seedY: 20 });
	assert.equal(small.status, 'filled');
	const wide = fillRegion({ barrier: gapped(9), width: W, height: H, seedX: 20, seedY: 20 });
	assert.equal(wide.status, 'open');
});

test('the seed on a line, or in a sliver too small to see, fills nothing', () => {
	const barrier = bitmap(set => { box(set, 10, 8, 40, 30); box(set, 44, 8, 52, 16, 1); });
	assert.equal(fillRegion({ barrier, width: W, height: H, seedX: 10, seedY: 15 }).status, 'blocked');
	assert.equal(fillRegion({ barrier, width: W, height: H, seedX: 48, seedY: 12 }).status, 'tiny');
});

test('a diagonal and curved boundary simplifies to far fewer points than pixel corners', () => {
	const barrier = bitmap(set => { line(set, 10, 30, 30, 8, ); line(set, 30, 8, 50, 30); line(set, 50, 30, 10, 30); line(set, 10, 31, 50, 31); });
	const result = fillRegion({ barrier, width: W, height: H, seedX: 30, seedY: 24 });
	assert.equal(result.status, 'filled');
	assert.ok(result.contours[0].length <= 12, `${result.contours[0].length} points`);
	const raw = traceRegion(floodFill(dilate(barrier, W, H, 2), W, H, 30, 24).region, W, H);
	assert.ok(raw[0].length > 40);
	assert.equal(simplifyLoop(raw[0], 0.75).length, simplifyLoop(raw[0], 0.75).length);
});

test('outlines round-trip through stroke points and render as one path', () => {
	const barrier = bitmap(set => { box(set, 6, 4, 54, 36); box(set, 22, 14, 38, 26); });
	const { contours } = fillRegion({ barrier, width: W, height: H, seedX: 12, seedY: 10 });
	const points = contoursToPoints(contours, ({ x, y }) => ({ x: x * 2, y: y * 2 }));
	assert.equal(points.filter(point => point.p === 0).length, 1);
	assert.ok(points.every(point => point.p >= 0 && point.p <= 1));
	const back = pointsToContours(points);
	assert.equal(back.length, 2);
	assert.equal(pointInContours(back, 24, 20), true);
	assert.equal(pointInContours(back, 60, 40), false);
	assert.match(contoursPath(back), /^M[-\d. L]+ZM[-\d. L]+Z$/);
	assert.equal(isFill({ penType: 'fill' }), true);
	assert.equal(isFill({ penType: 'pen' }), false);
	assert.equal(isFill(undefined), false);
});

import { Notebook, makeStroke, strokeHitsPoint, strokeIntersectsRect, boundsOf, validateSnapshot } from '../src/core/model.mjs';
import { exportSVG, exportPDFHTML } from '../src/core/export.mjs';

const ring = () => {
	const barrier = bitmap(set => { box(set, 6, 4, 54, 36); box(set, 22, 14, 38, 26); });
	return fillRegion({ barrier, width: W, height: H, seedX: 12, seedY: 10 }).contours;
};
const fillStroke = (color = '#215b9c') => makeStroke(contoursToPoints(ring(), ({ x, y }) => ({ x: x * 4, y: y * 4 })), color, 1, 'fill');

test('a fill is a valid stroke that hits only where it is coloured and is selected only whole', () => {
	const fill = fillStroke();
	assert.equal(fill.penType, 'fill');
	assert.equal(strokeHitsPoint(fill, { x: 48, y: 40 }), true);
	assert.equal(strokeHitsPoint(fill, { x: 120, y: 80 }), false, 'the island is not coloured');
	assert.equal(strokeHitsPoint(fill, { x: 4, y: 4 }), false);
	const outline = boundsOf([fill]);
	assert.equal(strokeIntersectsRect(fill, { x: 100, y: 60, width: 40, height: 40 }), false, 'a box crossing the fill does not pick it up');
	assert.equal(strokeIntersectsRect(fill, { x: outline.x - 1, y: outline.y - 1, width: outline.width + 2, height: outline.height + 2 }), true);
	assert.throws(() => makeStroke([{ x: 0, y: 0, p: .5 }], '#000000', 1, 'sparkle'), /pen type/);
	const xs = fill.points.map(point => point.x);
	assert.equal(outline.width, Math.max(...xs) - Math.min(...xs), 'bounds follow the outline exactly');
});

test('fills survive a snapshot round trip, undo as one action, and move with their ink', () => {
	const notebook = new Notebook();
	const fill = fillStroke();
	assert.equal(notebook.add([fill]), true);
	const saved = notebook.snapshot();
	assert.equal(validateSnapshot(JSON.parse(JSON.stringify(saved))).strokes[0].penType, 'fill');
	assert.equal(notebook.move([fill.id], 10, 5), true);
	assert.equal(notebook.get(fill.id).points[0].x, fill.points[0].x + 10);
	assert.equal(notebook.get(fill.id).points.filter(point => point.p === 0).length, 1);
	notebook.undo(); notebook.undo();
	assert.equal(notebook.strokes.length, 0);
});

test('exports draw every fill beneath the ink, even one made after it, as an even-odd path', () => {
	const notebook = new Notebook();
	const line = makeStroke([{ x: 10, y: 10, p: .5 }, { x: 150, y: 120, p: .5 }], '#171717', 3, 'pen');
	notebook.add([line]);
	notebook.add([fillStroke()]);
	const svg = exportSVG(notebook.snapshot());
	const fillAt = svg.indexOf('data-pen-type="fill"'), lineAt = svg.indexOf(`data-stroke-id="${line.id}"`);
	assert.ok(fillAt > 0 && lineAt > fillAt, 'the fill precedes the ink');
	assert.match(svg, /<path d="M[^"]+Z" fill="#[0-9a-f]{6}" fill-rule="evenodd" stroke="none"\/>/i);
	const { html } = exportPDFHTML(notebook.snapshot());
	assert.ok(html.indexOf('data-pen-type="fill"') > 0 && html.indexOf('data-pen-type="fill"') < html.indexOf(`data-stroke-id="${line.id}"`));
});
