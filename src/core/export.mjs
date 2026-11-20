import { boundsOf, validateSnapshot } from './model.mjs';
import { brushWidth, brushCap, brushOpacity } from './brushes.mjs';
import { strokeGeometry } from './stroke-geometry.mjs';
import { GRID_CELL, gridPage, gridBounds, diagramBounds, diagramRoutes, connectorPath, shapePaths } from './grid.mjs';
import { TONES, paperTone, inkOnPaper } from './paper.mjs';

const PADDING = 32;
const MAX_PAGES = 500;
const MAX_EXPORT_CHARACTERS = 64 * 1024 * 1024;
const MAX_EXPORT_SEGMENTS = 1_000_000;
const LETTER = Object.freeze({ width: 816, height: 1056, margin: 48, innerWidth: 720, innerHeight: 960 });

const n = value => String(Number(value.toFixed(4)));
function xml(value) {
  return Array.from(String(value), character => {
    const code = character.codePointAt(0);
    return code < 32 && ![9, 10, 13].includes(code) || code >= 0xd800 && code <= 0xdfff || code === 0xfffe || code === 0xffff ? '\ufffd' : character;
  }).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function dimensions({ width = 1280, height = 800 } = {}) {
  if (![width, height].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100_000)) {
    throw new TypeError('Export width and height must be finite numbers between 1 and 100000.');
  }
  return { width, height };
}

function budget() {
  let characters = 0;
  let segments = 0;
  return {
    add(text, count = 0) {
      characters += text.length;
      segments += count;
      if (characters > MAX_EXPORT_CHARACTERS || segments > MAX_EXPORT_SEGMENTS) {
        throw new RangeError('This scroll is too large to export in one file. Export a smaller scroll.');
      }
      return text;
    },
  };
}

function prepared(snapshot, viewport, includeOuterBreaks = false) {
  const document = validateSnapshot(snapshot);
  const entries = document.strokes.map((stroke, order) => ({ stroke, order, bounds: boundsOf([stroke]) }));
  const nodes = document.diagram?.nodes ?? [];
  const routes = document.diagram ? diagramRoutes(document.diagram) : [];
  const flowchart = diagramBounds(nodes, routes);
  const ink = boundsOf(document.strokes);
  if (document.settings.mode === 'grid') return { document, entries, rect: gridBounds(document.settings.grid, ink, flowchart), nodes, routes };
  const left = Math.min(ink?.x ?? Infinity, flowchart?.x ?? Infinity);
  const right = Math.max(ink ? ink.x + ink.width : -Infinity, flowchart ? flowchart.x + flowchart.width : -Infinity);
  let top = Math.min(ink?.y ?? Infinity, flowchart?.y ?? Infinity);
  let bottom = Math.max(ink ? ink.y + ink.height : -Infinity, flowchart ? flowchart.y + flowchart.height : -Infinity);
  const contentMarkers = document.markers.filter(marker => marker.kind !== 'page-break');
  // A break outside the writing does not manufacture an enormous run of blank paper.
  const visibleMarkers = includeOuterBreaks || !ink && !contentMarkers.length ? document.markers : contentMarkers;
  for (const marker of visibleMarkers) {
    top = Math.min(top, marker.y - 16);
    bottom = Math.max(bottom, marker.y + 16);
  }
  const empty = !Number.isFinite(top);
  const rect = empty
    ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
    : { x: Number.isFinite(left) ? left - PADDING : 0, y: top - PADDING, width: Number.isFinite(right) ? right - left + PADDING * 2 : viewport.width, height: bottom - top + PADDING * 2 };
  if (document.markers.length) rect.width = Math.max(240, rect.width);
  return { document, entries, rect, empty, nodes, routes };
}

function gridPatterns(grid, tone, prefix) {
  const page = gridPage(grid);
  return [
    ['cells', GRID_CELL, GRID_CELL, .55, .55],
    ['blocks', grid.cellColumns * GRID_CELL, grid.cellRows * GRID_CELL, .8, 1],
    ['pages', page.width, page.height, 1, 2],
  ].map(([name, width, height, opacity, weight]) => {
    return `<pattern id="${prefix}-${name}" patternUnits="userSpaceOnUse" x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}"><path d="M0 ${height / 2}H${width}M${width / 2} 0V${height}" fill="none" stroke="${tone.line}" stroke-width="${weight}" opacity="${opacity}"/></pattern>`;
  }).join('');
}

function definitions(settings, prefix, clipping) {
  const tone = TONES[paperTone(settings)];
  let content = '';
  if (settings.mode === 'grid') {
    content += gridPatterns(settings.grid, tone, prefix);
  } else if (settings.paper === 'dots') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="4" y="-12" width="24" height="24"><circle cx="12" cy="12" r="1" fill="${tone.dot}" opacity="0.9"/></pattern>`;
  } else if (settings.paper === 'ruled') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="0" y="-16" width="1" height="32"><path d="M0 16H1" fill="none" stroke="${tone.line}" stroke-width="0.65" opacity="0.5"/></pattern>`;
  } else if (settings.paper === 'grid') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="4" y="-12" width="24" height="24"><path d="M0 12H24M12 0V24" fill="none" stroke="${tone.line}" stroke-width="0.65" opacity="0.5"/></pattern>`;
  }
  if (clipping) content += `<clipPath id="${prefix}-clip"><rect x="${n(clipping.x)}" y="${n(clipping.y)}" width="${n(clipping.width)}" height="${n(clipping.height)}"/></clipPath>`;
  return `<defs>${content}</defs>`;
}

function paper(settings, rect, prefix) {
  const attributes = `x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"`;
  const tone = paperTone(settings), grid = settings.mode === 'grid';
  let content = `<rect ${attributes} fill="${grid && tone === 'night' ? '#1b3349' : TONES[tone].background}"/>`;
  for (const layer of grid ? ['cells', 'blocks', 'pages'] : settings.paper !== 'plain' ? ['ruling'] : []) {
    content += `<rect ${attributes} fill="url(#${prefix}-${layer})"/>`;
  }
  return content;
}

function markers(document, rect, bottom = rect.y + rect.height, { pdf = false, final = false } = {}) {
  if (document.settings.mode === 'grid') return '';
  const tone = TONES[paperTone(document.settings)];
  const left = rect.x;
  const right = rect.x + rect.width;
  return document.markers.filter(marker => pdf
    ? marker.kind !== 'page-break' && marker.y >= rect.y && (marker.y < bottom || final && marker.y <= bottom)
    : marker.y >= rect.y - 16 && marker.y <= bottom + 16).map(marker => {
    const y = marker.y;
    if (marker.kind === 'marker') {
      return `<g data-marker-id="${xml(marker.id)}"><title>${xml(marker.label)}</title><path d="M${n(right - 18)} ${n(y - 9)}h10v17l-5 -5 -5 5Z" fill="${tone.marker}" opacity="0.65"/></g>`;
    }
    const baseline = y - rect.y < 12 ? y + 14 : y + 4;
    const fontSize = marker.kind === 'section' ? 13 : 10;
    const labelWidth = Math.min(Math.max(0, rect.width - 88), Array.from(marker.label).length * fontSize * 0.62 + 18);
    const dash = marker.kind === 'page-break' ? ' stroke-dasharray="5 7"' : '';
    return `<g data-marker-id="${xml(marker.id)}"><path d="M${n(left + 30)} ${n(y)}H${n(right - 30)}" stroke="${tone.marker}" stroke-width="1" opacity="0.48"${dash}/><rect x="${n(left + 44)}" y="${n(baseline - 14)}" width="${n(labelWidth)}" height="20" fill="${tone.background}"/><text x="${n(left + 53)}" y="${n(baseline)}" fill="${tone.marker}" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="${fontSize}" font-weight="${marker.kind === 'section' ? 500 : 400}">${xml(marker.label)}</text></g>`;
  }).join('');
}

function overlaps(box, rect, padding = 0) {
  return box.x + box.width + padding >= rect.x && box.x - padding <= rect.x + rect.width
    && box.y + box.height + padding >= rect.y && box.y - padding <= rect.y + rect.height;
}

function diagramSVG(nodes, routes, settings, rect, resourceBudget) {
  const tone = paperTone(settings), colors = TONES[tone];
  const lines = routes.filter(({ points }) => {
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    return overlaps({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, rect, 9);
  }).map(route => resourceBudget.add(`<path data-connection-id="${xml(route.id)}" d="${connectorPath(route.points)}" fill="none" stroke="${colors.marker}"/>`, route.points.length));
  const shapes = nodes.filter(node => overlaps(node, rect, 1)).map(node => {
    const { outline, detail } = shapePaths(node);
    const accent = detail ? `<path d="${detail}" fill="none"/>` : '';
    return resourceBudget.add(`<g data-shape-id="${xml(node.id)}" stroke="${inkOnPaper(node.color, tone)}"><path d="${outline}" fill="${colors.background}"/>${accent}</g>`, 1);
  });
  return lines.length || shapes.length ? `<g stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${lines.join('')}${shapes.join('')}</g>` : '';
}

function strokeSVG(stroke, settings, resourceBudget, minY = -Infinity, maxY = Infinity) {
  const points = stroke.points;
  const color = inkOnPaper(stroke.color, paperTone(settings));
  const geometry = strokeGeometry(stroke);
  if (geometry) {
    if (geometry.bounds.y + geometry.bounds.height < minY || geometry.bounds.y > maxY) return '';
    const path = resourceBudget.add(`<path d="${geometry.path}" fill="${color}" stroke="none" opacity="${n(brushOpacity(stroke.penType))}"/>`, geometry.contours.length);
    return `<g data-stroke-id="${xml(stroke.id)}" data-pen-type="${xml(stroke.penType)}">${path}</g>`;
  }
  const cap = brushCap(stroke.penType);
  const pieces = [];
  if (points.length === 1) {
    const point = points[0];
    const size = brushWidth(stroke.width, point.p, stroke.penType), radius = size / 2;
    if (point.y + radius >= minY && point.y - radius <= maxY) {
      const tap = cap === 'square'
        ? `<rect x="${n(point.x - radius)}" y="${n(point.y - radius)}" width="${n(size)}" height="${n(size)}" fill="${color}" stroke="none"/>`
        : `<circle cx="${n(point.x)}" cy="${n(point.y)}" r="${n(radius)}" fill="${color}" stroke="none"/>`;
      pieces.push(resourceBudget.add(tap, 1));
    }
  } else {
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      const size = brushWidth(stroke.width, (a.p + b.p) / 2, stroke.penType, Math.atan2(b.y - a.y, b.x - a.x));
      const reach = cap === 'square' ? size / Math.SQRT2 : size / 2;
      if (Math.max(a.y, b.y) + reach < minY || Math.min(a.y, b.y) - reach > maxY) continue;
      // Segment widths and nib caps match the live canvas.
      pieces.push(resourceBudget.add(`<path d="M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}" stroke-width="${n(size)}"/>`, 1));
    }
  }
  if (!pieces.length) return '';
  return `<g data-stroke-id="${xml(stroke.id)}"${stroke.penType ? ` data-pen-type="${xml(stroke.penType)}"` : ''} fill="none" stroke="${color}" stroke-linecap="${cap}" stroke-linejoin="round">${pieces.join('')}</g>`;
}

/** One portable vector image containing every stroke, independent of the current viewport. */
export function exportSVG(snapshot, options = {}) {
  const viewport = dimensions(options);
  const { document, entries, rect, nodes, routes } = prepared(snapshot, viewport, true);
  const resourceBudget = budget();
  // Cap display dimensions while preserving the complete vector viewBox.
  const displayScale = Math.min(1, 32768 / Math.max(rect.width, rect.height));
  const content = definitions(document.settings, 'scroll') + paper(document.settings, rect, 'scroll')
    + markers(document, rect) + diagramSVG(nodes, routes, document.settings, rect, resourceBudget)
    + entries.map(entry => strokeSVG(entry.stroke, document.settings, resourceBudget)).join('');
  const result = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n(rect.width * displayScale)}" height="${n(rect.height * displayScale)}" viewBox="${n(rect.x)} ${n(rect.y)} ${n(rect.width)} ${n(rect.height)}"><title>ScrollMind ${document.settings.mode === 'grid' ? 'Grid' : 'Scroll'}</title>${content}</svg>`;
  if (result.length > MAX_EXPORT_CHARACTERS) throw new RangeError('This scroll is too large to export in one file. Export a smaller scroll.');
  return result;
}

function paginate(document, rect, worldHeight) {
  const start = rect.y;
  const end = rect.y + rect.height;
  const breaks = [...new Set(document.markers.filter(marker => marker.kind === 'page-break' && marker.y > start && marker.y < end).map(marker => marker.y))].sort((a, b) => a - b);
  const pages = [];
  let position = start;
  let index = 0;
  while (position < end - 0.000001 || !pages.length) {
    if (pages.length >= MAX_PAGES) throw new RangeError(`This scroll would need more than ${MAX_PAGES} PDF pages. Move distant writing closer before exporting.`);
    while (index < breaks.length && breaks[index] <= position + 0.000001) index++;
    let next = Math.min(end, position + worldHeight);
    if (index < breaks.length && breaks[index] < next - 0.000001) next = breaks[index];
    pages.push({ y: position, end: next });
    position = next;
  }
  return pages;
}

function gridPDF({ document, entries, rect, nodes, routes }, resourceBudget) {
  const { width, height } = gridPage(document.settings.grid);
  const count = rect.width / width * (rect.height / height);
  if (count > MAX_PAGES) throw new RangeError(`This grid would need more than ${MAX_PAGES} PDF pages. Move distant content closer before exporting.`);
  const pages = [];
  for (let y = rect.y; y < rect.y + rect.height; y += height) {
    for (let x = rect.x; x < rect.x + rect.width; x += width) {
      const prefix = `page-${pages.length}`, tile = { x, y, width, height };
      const drawings = diagramSVG(nodes, routes, document.settings, tile, resourceBudget)
        + entries.filter(entry => overlaps(entry.bounds, tile)).map(entry => strokeSVG(entry.stroke, document.settings, resourceBudget, y, y + height)).join('');
      const content = definitions(document.settings, prefix, tile) + paper(document.settings, tile, prefix)
        + `<g clip-path="url(#${prefix}-clip)">${drawings}</g>`;
      pages.push(pdfPage(document.settings, tile, y + height, content, 'xMidYMid meet'));
    }
  }
  return pages;
}

function pdfPage(settings, rect, end, content, aspect = 'none') {
  return `<section class="page" data-world-start="${n(rect.y)}" data-world-end="${n(end)}"><svg class="sheet" xmlns="http://www.w3.org/2000/svg" width="816" height="1056" viewBox="0 0 816 1056"><rect width="816" height="1056" fill="${TONES[paperTone(settings)].background}"/><svg x="48" y="48" width="720" height="960" viewBox="${n(rect.x)} ${n(rect.y)} ${n(rect.width)} ${n(rect.height)}" preserveAspectRatio="${aspect}">${content}</svg></svg></section>`;
}

/** Letter print HTML: vector pages, manual breaks, and automatic overflow pagination. */
export function exportPDFHTML(snapshot, options = {}) {
  const viewport = dimensions(options);
  const data = prepared(snapshot, viewport);
  const resourceBudget = budget();
  const sections = data.document.settings.mode === 'grid'
    ? gridPDF(data, resourceBudget) : scrollPDF(data, viewport, resourceBudget);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ScrollMind ${data.document.settings.mode === 'grid' ? 'Grid' : 'Scroll'}</title><style>@page{size:Letter portrait;margin:0}html,body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{width:8.5in;height:11in;overflow:hidden;break-after:page;page-break-after:always}.page:last-child{break-after:auto;page-break-after:auto}.sheet{display:block;width:8.5in;height:11in}</style></head><body>${sections.join('')}</body></html>`;
  if (html.length > MAX_EXPORT_CHARACTERS) throw new RangeError('This scroll is too large to export in one file. Export a smaller scroll.');
  return { html, pageCount: sections.length };
}

function scrollPDF({ document, entries, rect, empty, nodes, routes }, viewport, resourceBudget) {
  const worldWidth = Math.max(viewport.width, rect.width);
  const worldHeight = worldWidth * LETTER.innerHeight / LETTER.innerWidth;
  const pages = empty ? [{ y: rect.y, end: rect.y + worldHeight }] : paginate(document, rect, worldHeight);
  const byTop = [...entries].sort((a, b) => a.bounds.y - b.bounds.y);
  const active = new Map();
  let entryIndex = 0;
  return pages.map((page, index) => {
    const prefix = `page-${index}`;
    const worldRect = { x: rect.x, y: page.y, width: worldWidth, height: worldHeight };
    const clip = { ...worldRect, height: page.end - page.y };
    while (entryIndex < byTop.length && byTop[entryIndex].bounds.y <= page.end) {
      const entry = byTop[entryIndex++];
      active.set(entry.order, entry);
    }
    for (const [order, entry] of active) if (entry.bounds.y + entry.bounds.height < page.y) active.delete(order);
    const strokes = [...active.values()].sort((a, b) => a.order - b.order)
      .map(entry => strokeSVG(entry.stroke, document.settings, resourceBudget, page.y, page.end)).join('');
    const content = definitions(document.settings, prefix, clip) + paper(document.settings, worldRect, prefix)
      + `<g clip-path="url(#${prefix}-clip)">${markers(document, worldRect, page.end, { pdf: true, final: index === pages.length - 1 })}${diagramSVG(nodes, routes, document.settings, clip, resourceBudget)}${strokes}</g>`;
    return pdfPage(document.settings, worldRect, page.end, content);
  });
}
