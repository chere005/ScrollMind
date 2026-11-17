export const PEN_TYPES = Object.freeze(['pen', 'pencil', 'fountain', 'marker', 'highlighter']);

function type(value) {
  if (value !== undefined && !PEN_TYPES.includes(value)) throw new TypeError('Unknown pen type.');
  return value;
}

function baseWidth(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < .01 || value > 1000) {
    throw new TypeError('Brush width must be a finite number between 0.01 and 1000.');
  }
  return value;
}

/** Undefined type preserves the pressure curve of ink created before pen styles existed. */
export function brushWidth(width, pressure, penType = undefined, angle = 0) {
  baseWidth(width); type(penType);
  if (typeof pressure !== 'number' || !Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
    throw new TypeError('Brush pressure must be a finite number between 0 and 1.');
  }
  if (typeof angle !== 'number' || !Number.isFinite(angle)) throw new TypeError('Brush angle must be finite.');
  if (penType === undefined) return Math.max(.35, width * (.3 + pressure * 1.25));
  if (penType === 'pen') return Math.max(.35, width * (.10 + 1.90 * pressure ** 1.45));
  if (penType === 'pencil') return Math.max(.25, width * (.08 + 1.12 * pressure ** 1.35));
  if (penType === 'fountain') {
    const nib = .35 + .65 * Math.abs(Math.sin(angle - Math.PI / 4));
    return Math.max(.35, width * (.18 + 1.82 * pressure ** 1.10) * nib);
  }
  if (penType === 'highlighter') return Math.max(1, width * (1.7 + .1 * pressure));
  return Math.max(.5, width * (.85 + .35 * pressure));
}

/** Maximum diameter over every pressure and direction, before cap geometry. */
export function maxBrushWidth(width, penType = undefined) {
  baseWidth(width); type(penType);
  if (penType === undefined) return Math.max(.35, width * 1.55);
  if (penType === 'pencil') return Math.max(.25, width * (.08 + 1.12));
  if (penType === 'marker') return Math.max(.5, width * (.85 + .35));
  if (penType === 'highlighter') return Math.max(1, width * 1.8);
  return Math.max(.35, width * 2);
}

export function brushCap(penType = undefined) {
  type(penType);
  return penType === 'marker' || penType === 'highlighter' ? 'square' : 'round';
}

export function brushOpacity(penType = undefined) {
  type(penType);
  return penType === 'highlighter' ? .26 : 1;
}
