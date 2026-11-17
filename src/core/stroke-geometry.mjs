import { brushWidth } from './brushes.mjs';

const cache = new WeakMap();
const MAX_POINTS = 200_000;
const MAX_PATH_CHARACTERS = 48 * 1024 * 1024;
const round = value => Number(value.toFixed(4));
const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });

function rawPoints(stroke) {
  if (!Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > MAX_POINTS) throw new TypeError('Invalid stroke geometry points.');
  const result = [];
  for (const point of stroke.points) {
    if (![point.x, point.y, point.p].every(value => typeof value === 'number' && Number.isFinite(value))
      || Math.abs(point.x) > 1e9 || Math.abs(point.y) > 1e9 || point.p < 0 || point.p > 1) throw new TypeError('Invalid stroke geometry point.');
    const previous = result.at(-1);
    if (previous && point.x === previous.x && point.y === previous.y) previous.p = Math.max(previous.p, point.p);
    else result.push({ x: point.x, y: point.y, p: point.p });
  }
  return result;
}

function fountainCenterline(points, width) {
  if (points.length < 2) return points;
  // Dense imported strokes retain one derived sample per original point.
  if (points.length > 12_000) return points.map((point, index) => index === 0 || index === points.length - 1 ? point : {
    x: (points[index - 1].x + point.x * 2 + points[index + 1].x) / 4,
    y: (points[index - 1].y + point.y * 2 + points[index + 1].y) / 4,
    p: (points[index - 1].p + point.p * 2 + points[index + 1].p) / 4,
  });
  const result = [points[0]];
  const maxSteps = Math.max(1, Math.min(128, Math.floor(24_000 / (points.length * 3))));
  const line = to => {
    const from = result.at(-1);
    const steps = Math.min(maxSteps, Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 3)));
    for (let i = 1; i <= steps; i++) result.push(mix(from, to, i / steps));
  };
  for (let index = 1; index < points.length - 1; index++) {
    const a = points[index - 1], b = points[index], c = points[index + 1];
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(6, Math.max(.75, width * .75), before * .35, after * .35);
    const entry = mix(b, a, before ? radius / before : 0);
    const exit = mix(b, c, after ? radius / after : 0);
    line(entry);
    const steps = Math.min(maxSteps, Math.max(2, Math.ceil(radius * 2 / 3)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      result.push(mix(mix(entry, b, t), mix(b, exit, t), t));
    }
  }
  line(points.at(-1));
  return result;
}

function hull(points) {
  const sorted = points.map(point => ({ x: round(point.x), y: round(point.y) }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .filter((point, index, all) => !index || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
  if (sorted.length < 3) return null;
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const lower = [], upper = [];
  for (const point of sorted) { while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
  for (const point of sorted.toReversed()) { while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
  lower.pop(); upper.pop();
  const result = lower.concat(upper);
  return result.length >= 3 ? result : null;
}

function circle(point, radius) {
  const steps = Math.max(12, Math.min(64, Math.ceil(Math.PI * Math.sqrt(radius / .3) / 4) * 4));
  return Array.from({ length: steps }, (_, index) => {
    const angle = index * Math.PI * 2 / steps;
    return { x: round(point.x + Math.cos(angle) * radius), y: round(point.y + Math.sin(angle) * radius) };
  });
}

function box(points) {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) { x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  return { x, y, width: right - x, height: bottom - y };
}

/** One nonzero-winding fill, shared verbatim by Canvas Path2D and SVG/PDF. */
export function strokeGeometry(stroke) {
  if (stroke?.penType !== 'fountain' && stroke?.penType !== 'highlighter') return null;
  if (cache.has(stroke)) return cache.get(stroke);
  const raw = rawPoints(stroke);
  const points = stroke.penType === 'fountain' ? fountainCenterline(raw, stroke.width) : raw;
  const fountain = stroke.penType === 'fountain';
  const spread = fountain ? 2 : 1;
  const profile = points.map((point, index) => {
    const before = points[Math.max(0, index - spread)], after = points[Math.min(points.length - 1, index + spread)];
    let dx = after.x - before.x, dy = after.y - before.y;
    if (dx === 0 && dy === 0) { const neighbor = points[index + 1] ?? points[index - 1]; dx = neighbor ? neighbor.x - point.x : 1; dy = neighbor ? neighbor.y - point.y : 0; }
    const length = Math.hypot(dx, dy) || 1;
    return { point, ux: dx / length, uy: dy / length, width: brushWidth(stroke.width, point.p, stroke.penType, Math.atan2(dy, dx)) };
  });
  // A symmetric width filter removes abrupt broad-nib angle/pressure steps.
  const widths = profile.map((sample, index) => {
    let total = 0, weight = 0;
    for (let offset = -spread; offset <= spread; offset++) {
      const neighbor = profile[Math.max(0, Math.min(profile.length - 1, index + offset))];
      const currentWeight = spread + 1 - Math.abs(offset);
      total += neighbor.width * currentWeight; weight += currentWeight;
    }
    return total / weight;
  });
  const rails = profile.map((sample, index) => {
    const radius = widths[index] / 2;
    return { left: { x: sample.point.x - sample.uy * radius, y: sample.point.y + sample.ux * radius },
      right: { x: sample.point.x + sample.uy * radius, y: sample.point.y - sample.ux * radius } };
  });
  const contours = [];
  if (points.length === 1) {
    const radius = widths[0] / 2, point = points[0];
    contours.push(fountain ? circle(point, radius) : hull([
      { x: point.x - radius, y: point.y - radius }, { x: point.x + radius, y: point.y - radius },
      { x: point.x + radius, y: point.y + radius }, { x: point.x - radius, y: point.y + radius },
    ]));
  } else {
    for (let index = 1; index < points.length; index++) {
      const contour = hull([rails[index - 1].left, rails[index].left, rails[index].right, rails[index - 1].right]);
      if (contour) contours.push(contour);
    }
    for (const index of [0, points.length - 1]) {
      const sample = profile[index], radius = widths[index] / 2;
      if (fountain) contours.push(circle(sample.point, radius));
      else {
        const direction = index === 0 ? -1 : 1;
        const rail = rails[index];
        const contour = hull([rail.left, rail.right,
          { x: rail.left.x + direction * sample.ux * radius, y: rail.left.y + direction * sample.uy * radius },
          { x: rail.right.x + direction * sample.ux * radius, y: rail.right.y + direction * sample.uy * radius },
        ]);
        if (contour) contours.push(contour);
      }
    }
  }
  const contourBounds = contours.map(contour => Object.freeze(box(contour)));
  let pathLength = 0;
  const fragments = contours.map(contour => {
    const path = contour.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join('') + 'Z';
    pathLength += path.length;
    if (pathLength > MAX_PATH_CHARACTERS) throw new RangeError('This stroke is too large to render safely.');
    contour.forEach(Object.freeze); Object.freeze(contour);
    return path;
  });
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const bound of contourBounds) { x = Math.min(x, bound.x); y = Math.min(y, bound.y); right = Math.max(right, bound.x + bound.width); bottom = Math.max(bottom, bound.y + bound.height); }
  const bounds = { x, y, width: right - x, height: bottom - y };
  const geometry = Object.freeze({ path: fragments.join(''), bounds: Object.freeze(bounds), contours: Object.freeze(contours), contourBounds: Object.freeze(contourBounds) });
  if (Object.isFrozen(stroke) && Object.isFrozen(stroke.points) && stroke.points.every(Object.isFrozen)) cache.set(stroke, geometry);
  return geometry;
}

function overlaps(a, b) { return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y; }
function distance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}
function inside(point, polygon) {
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) < -1e-9) return false;
  }
  return true;
}
function segmentRect(a, b, rect) {
  let start = 0, end = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy], q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y];
  for (let index = 0; index < 4; index++) {
    if (p[index] === 0) { if (q[index] < 0) return false; continue; }
    const t = q[index] / p[index];
    if (p[index] < 0) start = Math.max(start, t); else end = Math.min(end, t);
    if (start > end) return false;
  }
  return true;
}

export function geometryHitsPoint(geometry, point, radius = 0) {
  const rect = { x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 };
  if (!overlaps(geometry.bounds, rect)) return false;
  return geometry.contours.some((polygon, index) => overlaps(geometry.contourBounds[index], rect)
    && (inside(point, polygon) || polygon.some((a, edge) => distance(point, a, polygon[(edge + 1) % polygon.length]) <= radius * radius)));
}

export function geometryIntersectsRect(geometry, rect) {
  if (!overlaps(geometry.bounds, rect)) return false;
  const corners = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }];
  return geometry.contours.some((polygon, index) => overlaps(geometry.contourBounds[index], rect)
    && (corners.some(point => inside(point, polygon)) || polygon.some((a, edge) => segmentRect(a, polygon[(edge + 1) % polygon.length], rect))));
}
