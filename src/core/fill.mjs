// Fill: turn one enclosed area of the visible page into a vector shape.
// A fill is stored as an ordinary stroke whose penType is 'fill'. Its points are the outline of the area, closed;
// a point with pressure 0 starts the next outline (an island inside the area, which stays unfilled). The shape is
// filled with the even-odd rule, and always drawn beneath ink.

export const FILL_TYPE = 'fill';
export const isFill = (stroke) => stroke?.penType === FILL_TYPE;

/** Grow every set pixel by `radius` pixels in each direction (a square dilation, done as two passes). */
export function dilate(mask, width, height, radius) {
  if (radius <= 0) return Uint8Array.from(mask);
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let nearest = -Infinity;
    for (let x = 0; x < width; x++) { if (mask[row + x]) nearest = x; if (x - nearest <= radius) result[row + x] = 1; }
    nearest = Infinity;
    for (let x = width - 1; x >= 0; x--) { if (mask[row + x]) nearest = x; if (nearest - x <= radius) result[row + x] = 1; }
  }
  const grown = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    let nearest = -Infinity;
    for (let y = 0; y < height; y++) { if (result[y * width + x]) nearest = y; if (y - nearest <= radius) grown[y * width + x] = 1; }
    nearest = Infinity;
    for (let y = height - 1; y >= 0; y--) { if (result[y * width + x]) nearest = y; if (nearest - y <= radius) grown[y * width + x] = 1; }
  }
  return grown;
}

/** Four-connected scanline fill of the open pixels around the seed. `touchesEdge` means the area is not enclosed. */
export function floodFill(blocked, width, height, seedX, seedY) {
  const region = new Uint8Array(blocked.length);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height || blocked[seedY * width + seedX]) return { region, count: 0, touchesEdge: false, seedBlocked: true };
  const stack = [seedX, seedY];
  let count = 0;
  let touchesEdge = false;
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let left = x0;
    while (left > 0 && !blocked[y * width + left - 1] && !region[y * width + left - 1]) left--;
    if (region[y * width + left]) continue;
    let right = left;
    while (right < width - 1 && !blocked[y * width + right + 1] && !region[y * width + right + 1]) right++;
    for (let x = left; x <= right; x++) region[y * width + x] = 1;
    count += right - left + 1;
    if (left === 0 || right === width - 1 || y === 0 || y === height - 1) touchesEdge = true;
    for (const next of [y - 1, y + 1]) {
      if (next < 0 || next >= height) continue;
      let open = false;
      for (let x = left; x <= right; x++) {
        const free = !blocked[next * width + x] && !region[next * width + x];
        if (free && !open) { stack.push(x, next); open = true; } else if (!free) open = false;
      }
    }
  }
  return { region, count, touchesEdge, seedBlocked: false };
}

/** The outlines of a pixel mask as closed loops of pixel-corner points: outer boundaries and the boundaries of holes. */
export function traceRegion(mask, width, height) {
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const stride = width + 1;
  const edges = new Map();
  const add = (x0, y0, x1, y1) => {
    const key = y0 * stride + x0;
    const edge = { x0, y0, x1, y1, used: false };
    const list = edges.get(key);
    if (list) list.push(edge); else edges.set(key, [edge]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      // The region stays on the right of every edge (screen coordinates, y down).
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const list of edges.values()) {
    for (const first of list) {
      if (first.used) continue;
      const loop = [];
      let edge = first;
      while (edge && !edge.used) {
        edge.used = true;
        loop.push({ x: edge.x0, y: edge.y0 });
        const next = edges.get(edge.y1 * stride + edge.x1);
        edge = next?.find((candidate) => !candidate.used);
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function simplifyOpen(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let farthest = -1, worst = tolerance;
    for (let index = from + 1; index < to; index++) {
      const distance = distanceToSegment(points[index], points[from], points[to]);
      if (distance > worst) { worst = distance; farthest = index; }
    }
    if (farthest >= 0) { keep[farthest] = 1; stack.push([from, farthest], [farthest, to]); }
  }
  return points.filter((_, index) => keep[index]);
}

/** Douglas-Peucker for a closed loop: split it at its two farthest-apart anchors so neither end is special. */
export function simplifyLoop(loop, tolerance) {
  if (loop.length <= 4) return loop;
  let far = 0, best = -1;
  for (let index = 1; index < loop.length; index++) {
    const distance = Math.hypot(loop[index].x - loop[0].x, loop[index].y - loop[0].y);
    if (distance > best) { best = distance; far = index; }
  }
  const first = simplifyOpen(loop.slice(0, far + 1), tolerance);
  const second = simplifyOpen([...loop.slice(far), loop[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

export function signedArea(loop) {
  let sum = 0;
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index], b = loop[(index + 1) % loop.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Fill the area around a seed pixel. `barrier` marks the ink and shape outlines (1) on a width x height grid.
 * Small gaps in a hand-drawn outline are closed by `gap` pixels. Returns { status, contours } where status is
 * 'filled', 'open' (the area runs off the page), 'blocked' (the seed is on a line) or 'tiny'.
 */
export function fillRegion({ barrier, width, height, seedX, seedY, gap = 2, tuck = 1, tolerance = 0.75, minArea = 24 }) {
  const blocked = dilate(barrier, width, height, gap);
  const flood = floodFill(blocked, width, height, seedX, seedY);
  if (flood.seedBlocked) return { status: 'blocked', contours: [] };
  if (flood.touchesEdge) return { status: 'open', contours: [] };
  if (flood.count < minArea) return { status: 'tiny', contours: [] };
  // The flood stopped `gap` pixels short of the ink; grow back, and `tuck` more so the colour runs under the line.
  const region = dilate(flood.region, width, height, gap + tuck);
  const contours = traceRegion(region, width, height)
    .map((loop) => simplifyLoop(loop, tolerance))
    .filter((loop) => loop.length >= 3 && Math.abs(signedArea(loop)) >= 2);
  return contours.length ? { status: 'filled', contours } : { status: 'tiny', contours: [] };
}

/** Flatten outlines into stroke points. A pressure of 0 marks the first point of every outline after the first. */
export function contoursToPoints(contours, toWorld = (point) => point) {
  const points = [];
  contours.forEach((contour, index) => {
    contour.forEach((corner, at) => {
      const { x, y } = toWorld(corner);
      points.push({ x, y, p: index > 0 && at === 0 ? 0 : 0.5 });
    });
  });
  return points;
}

const decoded = new WeakMap();

/** The outlines stored in a fill stroke's points. */
export function pointsToContours(points) {
  if (decoded.has(points)) return decoded.get(points);
  const contours = [];
  for (const point of points) {
    if (point.p === 0 || !contours.length) contours.push([]);
    contours.at(-1).push(point);
  }
  if (Object.isFrozen(points)) decoded.set(points, contours);
  return contours;
}

/** Even-odd containment: a point inside an island is outside the fill. */
export function pointInContours(contours, x, y) {
  let inside = false;
  for (const contour of contours) {
    for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index++) {
      const a = contour[index], b = contour[previous];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** SVG path data for a fill, one closed subpath per outline. */
export function contoursPath(contours, format = (value) => value) {
  return contours.map((contour) => `M${contour.map((point) => `${format(point.x)} ${format(point.y)}`).join('L')}Z`).join('');
}
