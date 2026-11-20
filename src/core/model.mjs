import { normalizePalette } from './palette.mjs';
// The scroll contains only portable data. Drawing and filesystem APIs live elsewhere.
import { brushWidth, maxBrushWidth, brushCap } from './brushes.mjs';
import { strokeGeometry, geometryHitsPoint, geometryIntersectsRect } from './stroke-geometry.mjs';
import { DEFAULT_GRID, GRID_LIMIT, DIAGRAM_SHAPES } from './grid.mjs';

const VERSION = 1;
const BUCKET_HEIGHT = 1024;
const MAX_BUCKETS_PER_STROKE = 256;
const MAX_QUERY_BUCKETS = 4096;
const MAX_STROKES = 100_000;
const MAX_POINTS_PER_STROKE = 200_000;
const MAX_TOTAL_POINTS = 5_000_000;
const MAX_COORDINATE = 1_000_000_000;
const MAX_HISTORY = 500;
const MAX_MARKERS = 10_000;
const DIAGRAM_LIMIT = 2000;
const EMPTY_DIAGRAM = Object.freeze({ nodes: Object.freeze([]), connections: Object.freeze([]) });
export const MIN_ZOOM = .25;
export const MAX_ZOOM = 4;
const DEFAULT_SETTINGS = Object.freeze({ color: '#171717', width: 3, paper: 'plain', paperTone: 'ivory' });
const PAPERS = new Set(['plain', 'dots', 'ruled', 'grid']);
const PAPER_TONES = new Set(['ivory', 'parchment', 'white', 'night']);
const MARKER_KINDS = new Set(['section', 'page-break', 'marker']);
const cachedBounds = new WeakMap();

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function finite(value, name, min = -MAX_COORDINATE, max = MAX_COORDINATE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function color(value) {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
    throw new TypeError('Ink color must be a hexadecimal color.');
  }
  return value;
}

function normalizeSettings(value = {}) {
  if (!record(value)) throw new TypeError('Scroll settings must be an object.');
  const paper = value.paper ?? DEFAULT_SETTINGS.paper;
  if (!PAPERS.has(paper)) throw new TypeError('Unknown paper style.');
  const paperTone = value.paperTone ?? DEFAULT_SETTINGS.paperTone;
  if (!PAPER_TONES.has(paperTone)) throw new TypeError('Unknown paper tone.');
  if (value.penType !== undefined) brushCap(value.penType);
  if (value.mode !== undefined && !['scroll', 'grid'].includes(value.mode)) throw new TypeError('Unknown canvas mode.');
  let grid;
  if (value.grid !== undefined || value.mode === 'grid') {
    if (value.grid !== undefined && !record(value.grid)) throw new TypeError('Grid settings must be an object.');
    grid = { ...DEFAULT_GRID };
    for (const name of ['cellRows', 'cellColumns', 'blockRows', 'blockColumns']) {
      grid[name] = value.grid?.[name] ?? grid[name];
      if (!Number.isInteger(grid[name]) || grid[name] < 1 || grid[name] > GRID_LIMIT) throw new TypeError(`Grid sizes must be whole numbers from 1 to ${GRID_LIMIT}.`);
    }
    grid.paperTone = value.grid?.paperTone ?? grid.paperTone;
    if (!PAPER_TONES.has(grid.paperTone)) throw new TypeError('Unknown grid paper tone.');
    if (value.grid?.shape !== undefined) {
      if (typeof value.grid.shape !== 'string' || !Object.hasOwn(DIAGRAM_SHAPES, value.grid.shape)) throw new TypeError('Unknown diagram shape.');
      grid.shape = value.grid.shape;
    }
  }
  return {
    color: color(value.color ?? DEFAULT_SETTINGS.color),
    width: finite(value.width ?? DEFAULT_SETTINGS.width, 'Pen width', 0.01, 1000),
    paper,
    paperTone,
    ...(value.penType !== undefined ? { penType: value.penType } : {}),
    ...(value.mode === 'grid' ? { mode: 'grid' } : {}),
    ...(grid ? { grid } : {}),
    ...(value.palette !== undefined ? { palette: normalizePalette(value.palette) } : {}),
  };
}

function normalizeView(value = {}) {
  if (!record(value)) throw new TypeError('Scroll view must be an object.');
  const view = { offsetY: finite(value.offsetY ?? 0, 'Vertical position') };
  for (const name of ['scrollX', 'gridX', 'gridY']) {
    const offset = finite(value[name] ?? 0, 'Canvas position');
    if (offset) view[name] = offset;
  }
  for (const name of ['scrollZoom', 'gridZoom']) {
    const zoom = finite(value[name] ?? 1, 'Canvas scale', MIN_ZOOM, MAX_ZOOM);
    if (zoom !== 1) view[name] = zoom;
  }
  return view;
}

function diagramId(id) {
  if (typeof id !== 'string' || !id.length || id.length > 128) throw new TypeError('Invalid diagram ID.');
  return id;
}

function validateNode(node) {
  if (!record(node) || typeof node.kind !== 'string' || !Object.hasOwn(DIAGRAM_SHAPES, node.kind)) throw new TypeError('Unknown diagram shape.');
  const { id, kind, x, y, width, height } = node;
  finite(x, 'Shape x'); finite(y, 'Shape y');
  finite(width, 'Shape width', 8, MAX_COORDINATE); finite(height, 'Shape height', 8, MAX_COORDINATE);
  finite(x + width, 'Shape right edge'); finite(y + height, 'Shape bottom edge');
  return Object.freeze({ id: diagramId(id), kind, x, y, width, height, color: color(node.color) });
}

function validateConnection(connection, nodes) {
  if (!record(connection)) throw new TypeError('A connection must be an object.');
  const { id, from, to, port } = connection;
  if (from === to || !nodes.has(from) || !nodes.has(to)) throw new TypeError('A connection needs two different shapes.');
  if (!Number.isInteger(port) || port < 0 || port > 3) throw new TypeError('Invalid connection handle.');
  return Object.freeze({ id: diagramId(id), from, to, port });
}

function validateDiagram(value = EMPTY_DIAGRAM) {
  if (!record(value) || ![value.nodes, value.connections].every(items => Array.isArray(items) && items.length <= DIAGRAM_LIMIT)) {
    throw new TypeError(`A diagram supports up to ${DIAGRAM_LIMIT} shapes and ${DIAGRAM_LIMIT} connections.`);
  }
  if (!value.nodes.length && !value.connections.length) return EMPTY_DIAGRAM;
  const nodes = value.nodes.map(validateNode);
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new TypeError('Duplicate shape IDs are not allowed.');
  const connections = value.connections.map(connection => validateConnection(connection, ids));
  for (const connection of connections) {
    if (ids.has(connection.id)) throw new TypeError('Duplicate diagram IDs are not allowed.');
    ids.add(connection.id);
  }
  return Object.freeze({ nodes: Object.freeze(nodes), connections: Object.freeze(connections) });
}

function validateStroke(value) {
  if (!record(value)) throw new TypeError('Each stroke must be an object.');
  if (typeof value.id !== 'string' || !value.id.length || value.id.length > 128) {
    throw new TypeError('Each stroke needs an ID of 1–128 characters.');
  }
  if (!Array.isArray(value.points) || !value.points.length || value.points.length > MAX_POINTS_PER_STROKE) {
    throw new TypeError(`A stroke must contain 1–${MAX_POINTS_PER_STROKE} points.`);
  }
  const points = value.points.map((point) => {
    if (!record(point)) throw new TypeError('Each pen point must be an object.');
    return {
      x: finite(point.x, 'Point x'),
      y: finite(point.y, 'Point y'),
      p: finite(point.p, 'Point pressure', 0, 1),
    };
  });
  if (value.penType !== undefined) brushCap(value.penType);
  return { id: value.id, color: color(value.color), width: finite(value.width, 'Stroke width', 0.01, 1000), points,
    ...(value.penType !== undefined ? { penType: value.penType } : {}) };
}

/** Validate imported/clipboard strokes without retaining references to caller data. */
export function validateStrokes(value) {
  if (!Array.isArray(value) || value.length > MAX_STROKES) {
    throw new TypeError(`Strokes must be an array with no more than ${MAX_STROKES} entries.`);
  }
  const ids = new Set();
  let pointCount = 0;
  return value.map((item) => {
    if (Array.isArray(item?.points)) pointCount += item.points.length;
    if (pointCount > MAX_TOTAL_POINTS) throw new TypeError('The scroll contains too many pen points.');
    const stroke = validateStroke(item);
    if (ids.has(stroke.id)) throw new TypeError('Duplicate stroke IDs are not allowed.');
    ids.add(stroke.id);
    return stroke;
  });
}

function validateMarker(value) {
  if (!record(value)) throw new TypeError('Each marker must be an object.');
  if (typeof value.id !== 'string' || !value.id.length || value.id.length > 128) {
    throw new TypeError('Each marker needs an ID of 1–128 characters.');
  }
  if (typeof value.label !== 'string' || value.label.length > 200) throw new TypeError('Marker labels must contain at most 200 characters.');
  if (!MARKER_KINDS.has(value.kind)) throw new TypeError('Unknown marker kind.');
  return { id: value.id, y: finite(value.y, 'Marker position'), label: value.label, kind: value.kind };
}

function validateMarkers(value = []) {
  if (!Array.isArray(value) || value.length > MAX_MARKERS) throw new TypeError(`A scroll supports up to ${MAX_MARKERS} markers.`);
  const ids = new Set();
  return value.map((item) => {
    const marker = validateMarker(item);
    if (ids.has(marker.id)) throw new TypeError('Duplicate marker IDs are not allowed.');
    ids.add(marker.id);
    return marker;
  });
}

/** Unknown schemas and corrupt input throw TypeError; callers can preserve the original file. */
export function validateSnapshot(value) {
  if (!record(value)) throw new TypeError('A scroll must be an object.');
  if (value.version !== VERSION) throw new TypeError(`Unsupported scroll version: ${String(value.version)}.`);
  const diagram = validateDiagram(value.diagram);
  return {
    version: VERSION,
    strokes: validateStrokes(value.strokes),
    markers: validateMarkers(value.markers),
    view: normalizeView(value.view),
    settings: normalizeSettings(value.settings),
    ...(diagram !== EMPTY_DIAGRAM ? { diagram } : {}),
  };
}

/** Clipboard copies should call this to obtain a new stroke identity. */
export function makeStroke(points, inkColor, width, penType = 'pen') {
  return validateStroke({ id: globalThis.crypto.randomUUID(), points, color: inkColor, width, penType });
}

function immutable(stroke) {
  stroke.points.forEach(Object.freeze);
  Object.freeze(stroke.points);
  return Object.freeze(stroke);
}

function segmentRadius(stroke, a, b = a) {
  return brushWidth(stroke.width, Math.max(a.p, b.p), stroke.penType, Math.atan2(b.y - a.y, b.x - a.x)) / 2;
}

function strokeBounds(stroke) {
  // Only immutable model strokes are cached: callers may mutate their own previews.
  if (Object.isFrozen(stroke) && cachedBounds.has(stroke)) return cachedBounds.get(stroke);
  const geometry = strokeGeometry(stroke);
  if (geometry) return geometry.bounds;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let maxDiameter = 0;
  for (let index = 0; index < stroke.points.length; index++) {
    const point = stroke.points[index];
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
    if (index > 0) maxDiameter = Math.max(maxDiameter, segmentRadius(stroke, stroke.points[index - 1], point) * 2);
    else if (stroke.points.length === 1) maxDiameter = segmentRadius(stroke, point) * 2;
  }
  maxDiameter = Math.min(maxBrushWidth(stroke.width, stroke.penType), maxDiameter);
  // Square segment caps can project farther along an axis when the line is diagonal.
  const capReach = brushCap(stroke.penType) === 'square' && stroke.points.length > 1 ? Math.SQRT2 : 1;
  const radius = maxDiameter * capReach / 2;
  const result = { x: left - radius, y: top - radius, width: right - left + radius * 2, height: bottom - top + radius * 2 };
  if (Object.isFrozen(stroke)) cachedBounds.set(stroke, result);
  return result;
}

export function boundsOf(strokes) {
  if (!strokes.length) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

function normalizedRect(rect) {
  if (!record(rect)) throw new TypeError('A rectangle must be an object.');
  let x = finite(rect.x, 'Rectangle x');
  let y = finite(rect.y, 'Rectangle y');
  let width = finite(rect.width, 'Rectangle width', -2 * MAX_COORDINATE, 2 * MAX_COORDINATE);
  let height = finite(rect.height, 'Rectangle height', -2 * MAX_COORDINATE, 2 * MAX_COORDINATE);
  if (width < 0) { x += width; width = -width; }
  if (height < 0) { y += height; height = -height; }
  return { x, y, width, height };
}

function overlaps(a, b) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

function segmentIntersectsRect(a, b, rect) {
  // Liang–Barsky clipping includes segments whose endpoints lie outside the selection.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y];
  let start = 0;
  let end = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const fraction = q[i] / p[i];
    if (p[i] < 0) start = Math.max(start, fraction);
    else end = Math.min(end, fraction);
    if (start > end) return false;
  }
  return true;
}

function squareSegment(stroke, a, b = a) {
  const radius = segmentRadius(stroke, a, b);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = length ? (b.x - a.x) / length : 1;
  const uy = length ? (b.y - a.y) / length : 0;
  const start = { x: a.x - ux * radius, y: a.y - uy * radius };
  const end = { x: b.x + ux * radius, y: b.y + uy * radius };
  return [
    { x: start.x - uy * radius, y: start.y + ux * radius },
    { x: end.x - uy * radius, y: end.y + ux * radius },
    { x: end.x + uy * radius, y: end.y - ux * radius },
    { x: start.x + uy * radius, y: start.y - ux * radius },
  ];
}

function insideSquare(point, corners) {
  let positive = false;
  let negative = false;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

function squareIntersectsRect(corners, rect) {
  if (corners.some((a, index) => segmentIntersectsRect(a, corners[(index + 1) % 4], rect))) return true;
  return [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
  ].some(point => insideSquare(point, corners));
}

function squareHitsPoint(corners, point, radius) {
  return insideSquare(point, corners) || corners.some((a, index) => distanceSquaredToSegment(point, a, corners[(index + 1) % 4]) <= radius * radius);
}

export function strokeIntersectsRect(stroke, value) {
  const rect = normalizedRect(value);
  const geometry = strokeGeometry(stroke);
  if (geometry) return geometryIntersectsRect(geometry, rect);
  if (!overlaps(strokeBounds(stroke), rect)) return false;
  if (brushCap(stroke.penType) === 'square') {
    if (stroke.points.length === 1) return squareIntersectsRect(squareSegment(stroke, stroke.points[0]), rect);
    for (let i = 1; i < stroke.points.length; i++) {
      if (squareIntersectsRect(squareSegment(stroke, stroke.points[i - 1], stroke.points[i]), rect)) return true;
    }
    return false;
  }
  const pointDistance = (point) => (Math.max(rect.x - point.x, 0, point.x - rect.x - rect.width)) ** 2
    + (Math.max(rect.y - point.y, 0, point.y - rect.y - rect.height)) ** 2;
  if (stroke.points.length === 1) return pointDistance(stroke.points[0]) <= segmentRadius(stroke, stroke.points[0]) ** 2;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1];
    const b = stroke.points[i];
    const radiusSquared = segmentRadius(stroke, a, b) ** 2;
    if (segmentIntersectsRect(a, b, rect) || pointDistance(a) <= radiusSquared || pointDistance(b) <= radiusSquared
      || corners.some((corner) => distanceSquaredToSegment(corner, a, b) <= radiusSquared)) return true;
  }
  return false;
}

function distanceSquaredToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}

export function strokeHitsPoint(stroke, point, radius = 0) {
  finite(point?.x, 'Hit point x');
  finite(point?.y, 'Hit point y');
  finite(radius, 'Hit radius', 0, MAX_COORDINATE);
  const geometry = strokeGeometry(stroke);
  if (geometry) return geometryHitsPoint(geometry, point, radius);
  if (!overlaps(strokeBounds(stroke), { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 })) return false;
  if (brushCap(stroke.penType) === 'square') {
    if (stroke.points.length === 1) return squareHitsPoint(squareSegment(stroke, stroke.points[0]), point, radius);
    for (let i = 1; i < stroke.points.length; i++) {
      if (squareHitsPoint(squareSegment(stroke, stroke.points[i - 1], stroke.points[i]), point, radius)) return true;
    }
    return false;
  }
  if (stroke.points.length === 1) return distanceSquaredToSegment(point, stroke.points[0], stroke.points[0]) <= (radius + segmentRadius(stroke, stroke.points[0])) ** 2;
  for (let i = 1; i < stroke.points.length; i++) {
    const reach = radius + segmentRadius(stroke, stroke.points[i - 1], stroke.points[i]);
    if (distanceSquaredToSegment(point, stroke.points[i - 1], stroke.points[i]) <= reach * reach) return true;
  }
  return false;
}

export class Notebook {
  #entries = new Map();
  #markers = new Map();
  #orderedMarkers = null;
  #buckets = new Map();
  #wide = new Set();
  #nextOrder = 0;
  #pointCount = 0;
  #ordered = null;
  #undo = [];
  #redo = [];
  #group = null;
  #groupDepth = 0;
  #tracking = false;
  #changeToken = 0;
  #dirtyStrokes = new Map();
  #orderChangedAt = 0;
  #markersChangedAt = 0;
  #diagramChangedAt = 0;
  #diagram = EMPTY_DIAGRAM;
  #highestOrder = -1;

  constructor(snapshot = {}) {
    if (record(snapshot) && Object.keys(snapshot).length === 0) snapshot = { version: VERSION, strokes: [] };
    const validated = validateSnapshot(snapshot);
    for (const stroke of validated.strokes) {
      this.#put(stroke.id, { stroke: immutable(stroke), order: this.#nextOrder++ });
    }
    for (const marker of validated.markers) this.#markers.set(marker.id, Object.freeze(marker));
    this.#diagram = validated.diagram ?? EMPTY_DIAGRAM;
    this.#tracking = true;
  }

  get strokes() {
    if (!this.#ordered) this.#ordered = Object.freeze([...this.#entries.values()].sort((a, b) => a.order - b.order).map((entry) => entry.stroke));
    return this.#ordered;
  }

  get(id) { return this.#entries.get(id)?.stroke; }
  get diagram() { return this.#diagram; }
  get markers() {
    this.#orderedMarkers ??= Object.freeze([...this.#markers.values()].sort((a, b) => a.y - b.y));
    return this.#orderedMarkers;
  }
  get canUndo() { return this.#undo.length > 0 || (this.#group?.size ?? 0) > 0; }
  get canRedo() { return this.#redo.length > 0; }

  /** Capture only unsaved edits. Acknowledging an older batch retains newer edits. */
  pendingChanges() {
    const upserts = [], removals = [];
    for (const id of this.#dirtyStrokes.keys()) {
      const stroke = this.get(id);
      if (stroke) upserts.push(stroke);
      else removals.push(id);
    }
    return {
      token: this.#changeToken,
      upserts,
      removals,
      ...(this.#orderChangedAt ? { order: this.strokes.map(stroke => stroke.id) } : {}),
      ...(this.#markersChangedAt ? { markers: [...this.markers] } : {}),
      ...(this.#diagramChangedAt ? { diagram: this.#diagram } : {}),
    };
  }

  acknowledgeChanges(token) {
    if (!Number.isSafeInteger(token) || token < 0 || token > this.#changeToken) throw new TypeError('Invalid save token.');
    for (const [id, changedAt] of this.#dirtyStrokes) if (changedAt <= token) this.#dirtyStrokes.delete(id);
    if (this.#orderChangedAt <= token) this.#orderChangedAt = 0;
    if (this.#markersChangedAt <= token) this.#markersChangedAt = 0;
    if (this.#diagramChangedAt <= token) this.#diagramChangedAt = 0;
  }

  #index(id, stroke, add) {
    const bounds = strokeBounds(stroke);
    const first = Math.floor(bounds.y / BUCKET_HEIGHT);
    const last = Math.floor((bounds.y + bounds.height) / BUCKET_HEIGHT);
    if (last - first + 1 > MAX_BUCKETS_PER_STROKE) {
      if (add) this.#wide.add(id);
      else this.#wide.delete(id);
      return;
    }
    for (let bucket = first; bucket <= last; bucket++) {
      if (add) {
        if (!this.#buckets.has(bucket)) this.#buckets.set(bucket, new Set());
        this.#buckets.get(bucket).add(id);
      } else {
        const entries = this.#buckets.get(bucket);
        entries?.delete(id);
        if (!entries?.size) this.#buckets.delete(bucket);
      }
    }
  }

  #put(id, entry) {
    const previous = this.#entries.get(id);
    if (this.#tracking) {
      const token = ++this.#changeToken;
      // Appends and removals keep relative order; only restoring older ink needs it sent.
      const needsOrder = entry && ((!previous && (entry.order < this.#highestOrder || this.#dirtyStrokes.has(id))) || (previous && previous.order !== entry.order));
      this.#dirtyStrokes.set(id, token);
      if (needsOrder) this.#orderChangedAt = token;
    }
    if (entry) this.#highestOrder = Math.max(this.#highestOrder, entry.order);
    if (previous) {
      this.#index(id, previous.stroke, false);
      this.#pointCount -= previous.stroke.points.length;
    }
    if (entry) {
      this.#entries.set(id, entry);
      this.#index(id, entry.stroke, true);
      this.#pointCount += entry.stroke.points.length;
    } else this.#entries.delete(id);
    this.#ordered = null;
  }

  query(value) {
    const rect = normalizedRect(value);
    const first = Math.floor(rect.y / BUCKET_HEIGHT);
    const last = Math.floor((rect.y + rect.height) / BUCKET_HEIGHT);
    const ids = last - first + 1 > MAX_QUERY_BUCKETS ? this.#entries.keys() : new Set(this.#wide);
    if (ids instanceof Set) {
      for (let bucket = first; bucket <= last; bucket++) {
        for (const id of this.#buckets.get(bucket) ?? []) ids.add(id);
      }
    }
    return [...ids].map((id) => this.#entries.get(id)).filter((entry) => overlaps(strokeBounds(entry.stroke), rect))
      .sort((a, b) => a.order - b.order).map((entry) => entry.stroke);
  }

  #remember(patches) {
    if (!patches.length) return false;
    for (const patch of patches) this.#apply(patch, 'after');
    this.#redo = [];
    if (this.#group) {
      for (const patch of patches) {
        const key = `${patch.kind ?? 'stroke'}:${patch.id}`;
        const previous = this.#group.get(key);
        this.#group.set(key, { ...patch, before: previous ? previous.before : patch.before });
      }
    } else {
      this.#undo.push(patches);
      if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    }
    return true;
  }

  #apply(patch, direction) {
    if (patch.kind === 'marker') {
      const marker = patch[direction];
      if (marker) this.#markers.set(patch.id, marker);
      else this.#markers.delete(patch.id);
      this.#orderedMarkers = null;
      this.#markersChangedAt = ++this.#changeToken;
    } else if (patch.kind === 'diagram') {
      this.#diagram = patch[direction];
      this.#diagramChangedAt = ++this.#changeToken;
    } else this.#put(patch.id, patch[direction]);
  }

  #replaceDiagram(nodes, connections) {
    const after = nodes.length || connections.length ? Object.freeze({ nodes: Object.freeze(nodes), connections: Object.freeze(connections) }) : EMPTY_DIAGRAM;
    return this.#remember([{ kind: 'diagram', id: '', before: this.#diagram, after }]);
  }

  addShape(shape) {
    const { nodes, connections } = this.#diagram;
    if (nodes.length >= DIAGRAM_LIMIT) throw new TypeError('The diagram contains too many shapes.');
    const node = validateNode({ ...shape, id: globalThis.crypto.randomUUID() });
    this.#replaceDiagram([...nodes, node], connections);
    return node.id;
  }

  updateShape(id, box) {
    const { nodes, connections } = this.#diagram;
    const before = nodes.find(node => node.id === id);
    if (!before) return false;
    const { x, y, width, height } = box;
    if (before.x === x && before.y === y && before.width === width && before.height === height) return false;
    const after = validateNode({ ...before, x, y, width, height });
    return this.#replaceDiagram(nodes.map(node => node === before ? after : node), connections);
  }

  connectShapes(from, to, port) {
    const { nodes, connections } = this.#diagram;
    if (connections.length >= DIAGRAM_LIMIT) throw new TypeError('The diagram contains too many connections.');
    if (connections.some(link => link.from === from && link.to === to && link.port === port)) return false;
    const connection = validateConnection({ id: globalThis.crypto.randomUUID(), from, to, port }, new Set(nodes.map(node => node.id)));
    return this.#replaceDiagram(nodes, [...connections, connection]);
  }

  removeDiagramItem(id) {
    const { nodes, connections } = this.#diagram;
    const nextNodes = nodes.filter(node => node.id !== id);
    const nextConnections = connections.filter(link => link.id !== id && link.from !== id && link.to !== id);
    if (nextNodes.length === nodes.length && nextConnections.length === connections.length) return false;
    return this.#replaceDiagram(nextNodes, nextConnections);
  }

  addMarker(value) {
    const marker = Object.freeze(validateMarker({ id: globalThis.crypto.randomUUID(), label: '', kind: 'marker', ...value }));
    if (this.#markers.has(marker.id)) throw new TypeError('A marker with that ID already exists.');
    if (this.#markers.size >= MAX_MARKERS) throw new TypeError('The scroll contains too many markers.');
    return this.#remember([{ kind: 'marker', id: marker.id, before: undefined, after: marker }]);
  }

  updateMarker(id, patch) {
    const before = this.#markers.get(id);
    if (!before) return false;
    if (!record(patch)) throw new TypeError('A marker update must be an object.');
    const after = Object.freeze(validateMarker({ ...before, ...patch, id }));
    if (before.y === after.y && before.label === after.label && before.kind === after.kind) return false;
    return this.#remember([{ kind: 'marker', id, before, after }]);
  }

  removeMarker(id) {
    const before = this.#markers.get(id);
    return before ? this.#remember([{ kind: 'marker', id, before, after: undefined }]) : false;
  }

  add(strokes) {
    const incoming = validateStrokes(strokes);
    if (this.#entries.size + incoming.length > MAX_STROKES) throw new TypeError('The scroll contains too many strokes.');
    let points = this.#pointCount;
    for (const stroke of incoming) {
      if (this.#entries.has(stroke.id)) throw new TypeError('A stroke with that ID already exists.');
      points += stroke.points.length;
      if (points > MAX_TOTAL_POINTS) throw new TypeError('The scroll contains too many pen points.');
    }
    return this.#remember(incoming.map((stroke) => ({ id: stroke.id, before: undefined, after: { stroke: immutable(stroke), order: this.#nextOrder++ } })));
  }

  remove(ids) {
    return this.#remember([...new Set(ids)].filter((id) => this.#entries.has(id))
      .map((id) => ({ id, before: this.#entries.get(id), after: undefined })));
  }

  /** Clear ink and every marker as a single reversible edit. */
  clear() {
    if (!this.#entries.size && !this.#markers.size && this.#diagram === EMPTY_DIAGRAM) return false;
    this.beginGroup();
    try {
      this.remove([...this.#entries.keys()]);
      for (const id of [...this.#markers.keys()]) this.removeMarker(id);
      if (this.#diagram !== EMPTY_DIAGRAM) this.#replaceDiagram([], []);
    } finally { this.endGroup(); }
    return true;
  }

  move(ids, dx, dy) { return this.transform(ids, { dx, dy }); }

  transform(ids, { scaleX = 1, scaleY = 1, originX = 0, originY = 0, dx = 0, dy = 0 } = {}) {
    finite(scaleX, 'Horizontal scale', -10_000, 10_000);
    finite(scaleY, 'Vertical scale', -10_000, 10_000);
    finite(originX, 'Horizontal origin');
    finite(originY, 'Vertical origin');
    finite(dx, 'Horizontal movement');
    finite(dy, 'Vertical movement');
    if (scaleX === 0 || scaleY === 0) throw new TypeError('A selection cannot be scaled to zero.');
    if (scaleX === 1 && scaleY === 1 && dx === 0 && dy === 0) return false;
    const patches = [];
    for (const id of new Set(ids)) {
      const before = this.#entries.get(id);
      if (!before) continue;
      const stroke = immutable(validateStroke({
        ...before.stroke,
        width: Math.max(0.01, Math.min(1000, before.stroke.width * Math.sqrt(Math.abs(scaleX * scaleY)))),
        points: before.stroke.points.map((point) => ({
          x: originX + (point.x - originX) * scaleX + dx,
          y: originY + (point.y - originY) * scaleY + dy,
          p: point.p,
        })),
      }));
      patches.push({ id, before, after: { stroke, order: before.order } });
    }
    return this.#remember(patches);
  }

  beginGroup() {
    this.#groupDepth++;
    this.#group ??= new Map();
  }

  endGroup() {
    if (!this.#groupDepth) return;
    this.#groupDepth--;
    if (this.#groupDepth) return;
    const patches = [...this.#group.values()].filter((patch) => patch.before !== patch.after);
    this.#group = null;
    if (patches.length) {
      this.#undo.push(patches);
      if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    }
  }

  #closeGroup() {
    if (this.#groupDepth) { this.#groupDepth = 1; this.endGroup(); }
  }

  undo() {
    this.#closeGroup();
    const patches = this.#undo.pop();
    if (!patches) return false;
    for (const patch of patches) this.#apply(patch, 'before');
    this.#redo.push(patches);
    return true;
  }

  redo() {
    this.#closeGroup();
    const patches = this.#redo.pop();
    if (!patches) return false;
    for (const patch of patches) this.#apply(patch, 'after');
    this.#undo.push(patches);
    return true;
  }

  snapshot(view = {}, settings = {}) {
    return { version: VERSION, strokes: [...this.strokes], markers: [...this.markers], view: normalizeView(view), settings: normalizeSettings(settings),
      ...(this.#diagram !== EMPTY_DIAGRAM ? { diagram: this.#diagram } : {}) };
  }
}
