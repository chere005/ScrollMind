import { boundsOf, validateSnapshot } from './model.mjs';

const PADDING = 32;
const MAX_PAGES = 500;
const MAX_EXPORT_CHARACTERS = 64 * 1024 * 1024;
const MAX_EXPORT_SEGMENTS = 1_000_000;
const LETTER = Object.freeze({ width: 816, height: 1056, margin: 48, innerWidth: 720, innerHeight: 960 });
const TONES = Object.freeze({
  ivory: { background: '#faf8f2', line: '#c5c6bc', marker: '#71879a' },
  parchment: { background: '#eee0bf', line: '#b5a47d', marker: '#8a7759' },
  white: { background: '#ffffff', line: '#c4cdd5', marker: '#71879a' },
  night: { background: '#172c40', line: '#47637b', marker: '#89a9c5' },
});

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
  const ink = boundsOf(document.strokes);
  let top = ink?.y ?? Infinity;
  let bottom = ink ? ink.y + ink.height : -Infinity;
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
    : { x: ink ? ink.x - PADDING : 0, y: top - PADDING, width: ink ? ink.width + PADDING * 2 : viewport.width, height: bottom - top + PADDING * 2 };
  if (document.markers.length) rect.width = Math.max(240, rect.width);
  return { document, entries, rect, empty };
}

function displayColor(color, paperTone) {
  if (paperTone !== 'night') return color;
  return ({ '#243746': '#e5eaf1', '#242a35': '#e5eaf1', '#215b9c': '#7db3ee', '#b94d49': '#ed9690', '#397762': '#8bc7a9' })[color] || color;
}

const diameter = (width, pressure) => Math.max(0.35, width * (0.3 + pressure * 1.25));
let texture;
function parchmentPaths() {
  if (texture) return texture;
  let seed = 73;
  const dark = [], light = [];
  for (let index = 0; index < 1800; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = seed % 128;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    (index % 2 ? dark : light).push(`M${x} ${seed % 128}h1v1h-1Z`);
  }
  texture = `<path fill="#775627" fill-opacity="${n(9 / 255)}" d="${dark.join('')}"/><path fill="#fff8e3" fill-opacity="${n(39 / 255)}" d="${light.join('')}"/>`;
  return texture;
}

function definitions(settings, prefix, clipping) {
  const tone = TONES[settings.paperTone];
  let content = '';
  if (settings.paper === 'dots') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="4" y="-12" width="24" height="24"><circle cx="12" cy="12" r="0.8" fill="${tone.line}" opacity="0.8"/></pattern>`;
  } else if (settings.paper === 'ruled') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="0" y="-16" width="1" height="32"><path d="M0 16H1" fill="none" stroke="${tone.line}" stroke-width="0.65" opacity="0.5"/></pattern>`;
  } else if (settings.paper === 'grid') {
    content += `<pattern id="${prefix}-ruling" patternUnits="userSpaceOnUse" x="4" y="-12" width="24" height="24"><path d="M0 12H24M12 0V24" fill="none" stroke="${tone.line}" stroke-width="0.65" opacity="0.5"/></pattern>`;
  }
  if (settings.paperTone === 'parchment') content += `<pattern id="${prefix}-texture" patternUnits="userSpaceOnUse" width="128" height="128">${parchmentPaths()}</pattern>`;
  if (clipping) content += `<clipPath id="${prefix}-clip"><rect x="${n(clipping.x)}" y="${n(clipping.y)}" width="${n(clipping.width)}" height="${n(clipping.height)}"/></clipPath>`;
  return `<defs>${content}</defs>`;
}

function paper(settings, rect, prefix) {
  const attributes = `x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"`;
  let content = `<rect ${attributes} fill="${TONES[settings.paperTone].background}"/>`;
  if (settings.paperTone === 'parchment') content += `<rect ${attributes} fill="url(#${prefix}-texture)"/>`;
  if (settings.paper !== 'plain') content += `<rect ${attributes} fill="url(#${prefix}-ruling)"/>`;
  return content;
}

function markers(document, rect, bottom = rect.y + rect.height, { pdf = false, final = false } = {}) {
  const tone = TONES[document.settings.paperTone];
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

function strokeSVG(stroke, settings, resourceBudget, minY = -Infinity, maxY = Infinity) {
  const points = stroke.points;
  const color = displayColor(stroke.color, settings.paperTone);
  const pieces = [];
  if (points.length === 1) {
    const point = points[0];
    const radius = diameter(stroke.width, point.p) / 2;
    if (point.y + radius >= minY && point.y - radius <= maxY) pieces.push(resourceBudget.add(`<circle cx="${n(point.x)}" cy="${n(point.y)}" r="${n(radius)}" fill="${color}" stroke="none"/>`, 1));
  } else {
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      const size = diameter(stroke.width, (a.p + b.p) / 2);
      if (Math.max(a.y, b.y) + size / 2 < minY || Math.min(a.y, b.y) - size / 2 > maxY) continue;
      // Each segment is a separate round-cap path, matching the live canvas exactly.
      pieces.push(resourceBudget.add(`<path d="M${n(a.x)} ${n(a.y)}L${n(b.x)} ${n(b.y)}" stroke-width="${n(size)}"/>`, 1));
    }
  }
  if (!pieces.length) return '';
  return `<g data-stroke-id="${xml(stroke.id)}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round">${pieces.join('')}</g>`;
}

/** One portable vector image containing every stroke, independent of the current viewport. */
export function exportSVG(snapshot, options = {}) {
  const viewport = dimensions(options);
  const { document, entries, rect } = prepared(snapshot, viewport, true);
  const resourceBudget = budget();
  // Cap display dimensions while preserving the complete vector viewBox.
  const displayScale = Math.min(1, 32768 / Math.max(rect.width, rect.height));
  const content = definitions(document.settings, 'scroll') + paper(document.settings, rect, 'scroll')
    + markers(document, rect) + entries.map(entry => strokeSVG(entry.stroke, document.settings, resourceBudget)).join('');
  const result = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n(rect.width * displayScale)}" height="${n(rect.height * displayScale)}" viewBox="${n(rect.x)} ${n(rect.y)} ${n(rect.width)} ${n(rect.height)}"><title>ScrollMind Scroll</title>${content}</svg>`;
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

/** Letter print HTML: vector pages, manual breaks, and automatic overflow pagination. */
export function exportPDFHTML(snapshot, options = {}) {
  const viewport = dimensions(options);
  const { document, entries, rect, empty } = prepared(snapshot, viewport);
  const worldWidth = Math.max(viewport.width, rect.width);
  const worldHeight = worldWidth * LETTER.innerHeight / LETTER.innerWidth;
  const pages = empty ? [{ y: rect.y, end: rect.y + worldHeight }] : paginate(document, rect, worldHeight);
  const byTop = [...entries].sort((a, b) => a.bounds.y - b.bounds.y);
  const active = new Map();
  let entryIndex = 0;
  const resourceBudget = budget();
  const sections = pages.map((page, index) => {
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
      + `<g clip-path="url(#${prefix}-clip)">${markers(document, worldRect, page.end, { pdf: true, final: index === pages.length - 1 })}${strokes}</g>`;
    return `<section class="page" data-world-start="${n(page.y)}" data-world-end="${n(page.end)}"><svg class="sheet" xmlns="http://www.w3.org/2000/svg" width="816" height="1056" viewBox="0 0 816 1056"><rect width="816" height="1056" fill="${TONES[document.settings.paperTone].background}"/><svg x="48" y="48" width="720" height="960" viewBox="${n(rect.x)} ${n(page.y)} ${n(worldWidth)} ${n(worldHeight)}" preserveAspectRatio="none">${content}</svg></svg></section>`;
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ScrollMind Scroll</title><style>@page{size:Letter portrait;margin:0}html,body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{width:8.5in;height:11in;overflow:hidden;break-after:page;page-break-after:always}.page:last-child{break-after:auto;page-break-after:auto}.sheet{display:block;width:8.5in;height:11in}</style></head><body>${sections.join('')}</body></html>`;
  if (html.length > MAX_EXPORT_CHARACTERS) throw new RangeError('This scroll is too large to export in one file. Export a smaller scroll.');
  return { html, pageCount: pages.length };
}
