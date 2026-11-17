import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSVG, exportPDFHTML } from '../src/core/export.mjs';

const stroke = (id, points, width = 3, color = '#243746') => ({ id, color, width, points: points.map(([x, y, p = 0.5]) => ({ x, y, p })) });
const snapshot = (strokes = [], markers = [], settings = {}) => ({ version: 1, strokes, markers, settings: { paperTone: 'ivory', paper: 'plain', ...settings }, view: { offsetY: 999999 } });
const pageRanges = html => [...html.matchAll(/data-world-start="([^"]+)" data-world-end="([^"]+)"/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));

test('SVG includes negative and offscreen ink in painter order without viewport-sized blank extremes', () => {
  const svg = exportSVG(snapshot([stroke('first', [[-200, -500], [-150, -480]]), stroke('second', [[900, 8000], [950, 8020]])]));
  assert.match(svg, /^<\?xml[^]*<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /viewBox="-233\.3875 -533\.3875 1216\.775 8586\.775"/);
  assert.match(svg, /M-200 -500L-150 -480/);
  assert.match(svg, /M900 8000L950 8020/);
  assert.ok(svg.indexOf('data-stroke-id="first"') < svg.indexOf('data-stroke-id="second"'));
  assert.doesNotMatch(svg, /999999|<image|<script|toolbar/);
});

test('SVG uses vector pressure widths, rounded segments, and circles for pen taps', () => {
  const svg = exportSVG(snapshot([stroke('pressure', [[0, 0, 0.2], [30, 20, 0.8], [60, 20, 1]], 4), stroke('tap', [[100, 100, 1]], 4)]));
  assert.match(svg, /stroke-linecap="round"/);
  assert.match(svg, /M0 0L30 20" stroke-width="3\.7"/);
  assert.match(svg, /M30 20L60 20" stroke-width="5\.7"/);
  assert.match(svg, /<circle cx="100" cy="100" r="3\.1" fill="#243746" stroke="none"/);
});

test('paper colors, continuous world-space ruling, and safe marker text are preserved', () => {
  const document = snapshot([stroke('ink', [[0, -100], [100, 2000]])], [
    { id: 'section', y: -50, kind: 'section', label: '<script>"&\u0000' },
    { id: 'bookmark', y: 200, kind: 'marker', label: 'A & B' },
  ], { paperTone: 'night', paper: 'grid' });
  const svg = exportSVG(document);
  assert.match(svg, /fill="#172c40"/);
  assert.match(svg, /stroke="#e5eaf1"/);
  assert.match(svg, /patternUnits="userSpaceOnUse" x="4" y="-12" width="24" height="24"/);
  assert.match(svg, /&lt;script&gt;&quot;&amp;�/);
  assert.doesNotMatch(svg, /<script>|\u0000/);
  assert.match(svg, /<title>A &amp; B<\/title>/);
  const parchment = exportSVG(snapshot([], [], { paperTone: 'parchment', paper: 'dots' }));
  assert.match(parchment, /fill="#eee0bf"/);
  assert.match(parchment, /scroll-texture/);
  assert.match(parchment, /scroll-ruling/);
  const outerBreak = exportSVG(snapshot([stroke('near', [[0, 0]])], [{ id: 'outer', y: 1000, kind: 'page-break', label: 'Later page' }]));
  assert.match(outerBreak, /data-marker-id="outer"/);
});

test('PDF uses Letter margins, starts near first ink, and honors a manual page break', () => {
  const result = exportPDFHTML(snapshot([stroke('a', [[100, 250], [300, 260]]), stroke('b', [[100, 620], [300, 630]])], [
    { id: 'break', y: 400, label: 'Page break 1', kind: 'page-break' },
  ]));
  assert.equal(result.pageCount, 2);
  const ranges = pageRanges(result.html);
  assert.ok(ranges[0].start > 200 && ranges[0].start < 250);
  assert.equal(ranges[0].end, 400);
  assert.equal(ranges[1].start, 400);
  assert.match(result.html, /@page\{size:Letter portrait;margin:0\}/);
  assert.match(result.html, /<svg x="48" y="48" width="720" height="960"/);
  assert.match(result.html, /<title>ScrollMind Scroll<\/title>/);
  assert.doesNotMatch(result.html, /notebook|999999|<image/);
});

test('negative long strokes span automatic pages and remain clipped on every intersected page', () => {
  const result = exportPDFHTML(snapshot([stroke('long', [[100, -2000], [100, 1500]])]), { width: 720, height: 800 });
  assert.equal(result.pageCount, 4);
  const ranges = pageRanges(result.html);
  assert.ok(ranges[0].start < -2000 && ranges[0].start > -2040);
  assert.equal((result.html.match(/data-stroke-id="long"/g) ?? []).length, 4);
  assert.equal((result.html.match(/clip-path="url\(#page-\d+-clip\)"/g) ?? []).length, 4);
  for (let index = 1; index < ranges.length; index++) assert.ok(Math.abs(ranges[index].start - ranges[index - 1].end) < 0.0002);
});

test('PDF boundary sections and bookmarks print only on the following page without break guides', () => {
  const document = snapshot([stroke('above', [[100, 250], [200, 260]]), stroke('below', [[100, 620], [200, 630]])], [
    { id: 'section-on-break', y: 400, kind: 'section', label: 'A clean section' },
    { id: 'bookmark-on-break', y: 400, kind: 'marker', label: 'Bookmark here' },
    { id: 'manual-break', y: 400, kind: 'page-break', label: 'Page break guide' },
  ]);
  const { html, pageCount } = exportPDFHTML(document);
  assert.equal(pageCount, 2);
  const pages = html.split('<section class="page"').slice(1);
  assert.doesNotMatch(pages[0], /section-on-break|bookmark-on-break/);
  assert.match(pages[1], /data-marker-id="section-on-break"/);
  assert.match(pages[1], /data-marker-id="bookmark-on-break"/);
  assert.match(pages[1], /y="414"[^>]*>A clean section/);
  assert.equal((html.match(/data-marker-id="section-on-break"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /manual-break|Page break guide|stroke-dasharray="5 7"/);
  assert.match(exportSVG(document), /data-marker-id="manual-break"/);
});

test('same-position manual breaks and an exact automatic boundary do not create extra pages', () => {
  const strokes = [stroke('a', [[100, 0], [100, 1500]], 2)];
  const start = -0.925 - 32;
  const boundary = start + 960;
  const markers = ['one', 'two'].map(id => ({ id, y: boundary, label: id, kind: 'page-break' }));
  const result = exportPDFHTML(snapshot(strokes, markers), { width: 720, height: 800 });
  assert.equal(result.pageCount, 2);
  assert.equal(pageRanges(result.html)[0].end, Number(boundary.toFixed(4)));
  // Outlying page-break metadata alone must not introduce miles of blank pages.
  const distantBreak = exportPDFHTML(snapshot(strokes, [{ id: 'far', y: -999_000_000, label: '', kind: 'page-break' }]), { width: 720, height: 800 });
  assert.equal(distantBreak.pageCount, 2);
});

test('an empty scroll produces one blank page and a viewport-sized SVG', () => {
  const empty = snapshot();
  assert.equal(exportPDFHTML(empty).pageCount, 1);
  assert.match(exportSVG(empty, { width: 900, height: 600 }), /viewBox="0 0 900 600"/);
  assert.doesNotMatch(exportPDFHTML(empty).html, /data-stroke-id/);
  assert.equal(exportPDFHTML(empty, { width: 1, height: 100000 }).pageCount, 1);
});

test('exports reject corrupt schemas, dimensions, and excessive page extents before rendering', () => {
  assert.throws(() => exportSVG({}), /version/);
  assert.throws(() => exportPDFHTML(snapshot(), { width: 0 }), /width and height/);
  assert.throws(() => exportSVG(snapshot(), { height: Infinity }), /width and height/);
  assert.throws(() => exportPDFHTML(snapshot([stroke('far', [[0, -999_000_000], [0, 999_000_000]])])), /500 PDF pages/);
});
