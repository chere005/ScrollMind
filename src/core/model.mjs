// The notebook contains only portable data. Drawing and filesystem APIs live elsewhere.
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
const DEFAULT_SETTINGS = Object.freeze({ color: '#242a35', width: 2.5, paper: 'plain', paperTone: 'ivory' });
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
  if (!record(value)) throw new TypeError('Notebook settings must be an object.');
  const paper = value.paper ?? DEFAULT_SETTINGS.paper;
  if (!PAPERS.has(paper)) throw new TypeError('Unknown paper style.');
  const paperTone = value.paperTone ?? DEFAULT_SETTINGS.paperTone;
  if (!PAPER_TONES.has(paperTone)) throw new TypeError('Unknown paper tone.');
  return {
    color: color(value.color ?? DEFAULT_SETTINGS.color),
    width: finite(value.width ?? DEFAULT_SETTINGS.width, 'Pen width', 0.01, 1000),
    paper,
    paperTone,
  };
}

function normalizeView(value = {}) {
  if (!record(value)) throw new TypeError('Notebook view must be an object.');
  return { offsetY: finite(value.offsetY ?? 0, 'Vertical position') };
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
  return { id: value.id, color: color(value.color), width: finite(value.width, 'Stroke width', 0.01, 1000), points };
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
    if (pointCount > MAX_TOTAL_POINTS) throw new TypeError('The notebook contains too many pen points.');
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
  if (!Array.isArray(value) || value.length > MAX_MARKERS) throw new TypeError(`A notebook supports up to ${MAX_MARKERS} markers.`);
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
  if (!record(value)) throw new TypeError('A notebook must be an object.');
  if (value.version !== VERSION) throw new TypeError(`Unsupported notebook version: ${String(value.version)}.`);
  return {
    version: VERSION,
    strokes: validateStrokes(value.strokes),
    markers: validateMarkers(value.markers),
    view: normalizeView(value.view),
    settings: normalizeSettings(value.settings),
  };
}

/** Clipboard copies should call this to obtain a new stroke identity. */
export function makeStroke(points, inkColor, width) {
  return validateStroke({ id: globalThis.crypto.randomUUID(), points, color: inkColor, width });
}

function immutable(stroke) {
  stroke.points.forEach(Object.freeze);
  Object.freeze(stroke.points);
  return Object.freeze(stroke);
}

function inkDiameter(width, pressure) {
  return Math.max(0.35, width * (0.3 + pressure * 1.25));
}

function segmentRadius(stroke, a, b = a) {
  return inkDiameter(stroke.width, Math.max(a.p, b.p)) / 2;
}

function strokeBounds(stroke) {
  // Only immutable model strokes are cached: callers may mutate their own previews.
  if (Object.isFrozen(stroke) && cachedBounds.has(stroke)) return cachedBounds.get(stroke);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let maxDiameter = 0;
  for (const point of stroke.points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
    maxDiameter = Math.max(maxDiameter, inkDiameter(stroke.width, point.p));
  }
  const radius = maxDiameter / 2;
  const result = { x: left - radius, y: top - radius, width: right - left + maxDiameter, height: bottom - top + maxDiameter };
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

export function strokeIntersectsRect(stroke, value) {
  const rect = normalizedRect(value);
  if (!overlaps(strokeBounds(stroke), rect)) return false;
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
  if (!overlaps(strokeBounds(stroke), { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 })) return false;
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

  constructor(snapshot = {}) {
    if (record(snapshot) && Object.keys(snapshot).length === 0) snapshot = { version: VERSION, strokes: [] };
    const validated = validateSnapshot(snapshot);
    for (const stroke of validated.strokes) {
      this.#put(stroke.id, { stroke: immutable(stroke), order: this.#nextOrder++ });
    }
    for (const marker of validated.markers) this.#markers.set(marker.id, Object.freeze(marker));
  }

  get strokes() {
    if (!this.#ordered) this.#ordered = Object.freeze([...this.#entries.values()].sort((a, b) => a.order - b.order).map((entry) => entry.stroke));
    return this.#ordered;
  }

  get(id) { return this.#entries.get(id)?.stroke; }
  get markers() {
    this.#orderedMarkers ??= Object.freeze([...this.#markers.values()].sort((a, b) => a.y - b.y));
    return this.#orderedMarkers;
  }
  get canUndo() { return this.#undo.length > 0 || (this.#group?.size ?? 0) > 0; }
  get canRedo() { return this.#redo.length > 0; }

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
    } else this.#put(patch.id, patch[direction]);
  }

  addMarker(value) {
    const marker = Object.freeze(validateMarker({ id: globalThis.crypto.randomUUID(), label: '', kind: 'marker', ...value }));
    if (this.#markers.has(marker.id)) throw new TypeError('A marker with that ID already exists.');
    if (this.#markers.size >= MAX_MARKERS) throw new TypeError('The notebook contains too many markers.');
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
    if (this.#entries.size + incoming.length > MAX_STROKES) throw new TypeError('The notebook contains too many strokes.');
    let points = this.#pointCount;
    for (const stroke of incoming) {
      if (this.#entries.has(stroke.id)) throw new TypeError('A stroke with that ID already exists.');
      points += stroke.points.length;
      if (points > MAX_TOTAL_POINTS) throw new TypeError('The notebook contains too many pen points.');
    }
    return this.#remember(incoming.map((stroke) => ({ id: stroke.id, before: undefined, after: { stroke: immutable(stroke), order: this.#nextOrder++ } })));
  }

  remove(ids) {
    return this.#remember([...new Set(ids)].filter((id) => this.#entries.has(id))
      .map((id) => ({ id, before: this.#entries.get(id), after: undefined })));
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
    return { version: VERSION, strokes: [...this.strokes], markers: [...this.markers], view: normalizeView(view), settings: normalizeSettings(settings) };
  }
}
