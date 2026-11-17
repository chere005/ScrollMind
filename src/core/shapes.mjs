import { makeStroke } from './model.mjs';

export const SHAPES = Object.freeze(['line', 'arrow', 'rectangle', 'ellipse', 'triangle']);
const PRESSURE = 0.56;
const COORDINATE_LIMIT = 1_000_000_000;
const TRIANGLE_HEIGHT = Math.sqrt(3) / 2;
const DIRECTIONS = [
  [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2],
];

function point(value) {
  if (!value || ![value.x, value.y].every(coordinate => typeof coordinate === 'number'
    && Number.isFinite(coordinate) && Math.abs(coordinate) <= COORDINATE_LIMIT)) {
    throw new TypeError('Shape coordinates must be finite numbers between -1000000000 and 1000000000.');
  }
  return { x: value.x, y: value.y, p: PRESSURE };
}

/** Shapes are ordinary editable strokes; add the returned array as one model command. */
export function makeShape(kind, start, end, { color = '#243746', width = 3, penType = 'pen', constrain = false } = {}) {
  if (!SHAPES.includes(kind)) throw new TypeError(`Unknown shape: ${String(kind)}.`);
  if (typeof constrain !== 'boolean') throw new TypeError('Shape constraint must be true or false.');
  const from = point(start);
  let to = point(end);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const empty = () => {
    // Even an empty click must reject an invalid pen style consistently with normal ink.
    makeStroke([from], color, width, penType);
    return [];
  };
  if (dx === 0 && dy === 0) return empty();
  const build = points => makeStroke(points.map(point), color, width, penType);

  if (kind === 'line' || kind === 'arrow') {
    const length = Math.hypot(dx, dy);
    if (constrain) {
      const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      const [ux, uy] = DIRECTIONS[(step % 8 + 8) % 8];
      to = point({ x: from.x + ux * length, y: from.y + uy * length });
    }
    const shaft = build([from, to]);
    if (kind === 'line') return [shaft];
    const ux = (to.x - from.x) / length;
    const uy = (to.y - from.y) / length;
    const headLength = Math.min(length * 0.4, Math.max(12, width * 4));
    const halfHead = headLength / 2;
    const back = { x: to.x - ux * headLength, y: to.y - uy * headLength };
    return [shaft,
      build([to, { x: back.x - uy * halfHead, y: back.y + ux * halfHead }]),
      build([to, { x: back.x + uy * halfHead, y: back.y - ux * halfHead }]),
    ];
  }

  let shapeWidth = Math.abs(dx);
  let shapeHeight = Math.abs(dy);
  if (constrain) {
    if (kind === 'triangle') {
      shapeWidth = Math.max(shapeWidth, shapeHeight / TRIANGLE_HEIGHT);
      shapeHeight = shapeWidth * TRIANGLE_HEIGHT;
    } else shapeWidth = shapeHeight = Math.max(shapeWidth, shapeHeight);
    to = point({ x: from.x + (dx < 0 ? -1 : 1) * shapeWidth, y: from.y + (dy < 0 ? -1 : 1) * shapeHeight });
  }
  if (shapeWidth === 0 || shapeHeight === 0) return empty();
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);

  if (kind === 'rectangle') return [build([
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left, y: top },
  ])];
  if (kind === 'triangle') return [build([
    { x: left + shapeWidth / 2, y: top }, { x: right, y: bottom }, { x: left, y: bottom }, { x: left + shapeWidth / 2, y: top },
  ])];

  const rx = shapeWidth / 2;
  const ry = shapeHeight / 2;
  const cx = left + rx;
  const cy = top + ry;
  // Ramanujan's circumference estimate gives smooth ordinary ovals without huge point arrays.
  const circumference = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const segments = Math.max(64, Math.min(192, Math.ceil(circumference / 32) * 4));
  const points = Array.from({ length: segments }, (_, index) => {
    const angle = index * Math.PI * 2 / segments;
    return {
      x: Math.max(left, Math.min(right, cx + Math.cos(angle) * rx)),
      y: Math.max(top, Math.min(bottom, cy + Math.sin(angle) * ry)),
    };
  });
  points.push({ ...points[0] });
  return [build(points)];
}
