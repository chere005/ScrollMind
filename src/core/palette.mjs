export const DEFAULT_PALETTE = Object.freeze([
	{ name: 'Black', color: '#171717' },
	{ name: 'Yellow', color: '#e2b52b' },
	{ name: 'Blue', color: '#215b9c' },
	{ name: 'Green', color: '#397762' },
	{ name: 'Red', color: '#b94d49' },
	{ name: 'Orange', color: '#d67b2a' },
	{ name: 'Purple', color: '#8055a5' },
	{ name: 'White', color: '#ffffff' },
].map(Object.freeze));

export function normalizePalette(palette) {
	if (!Array.isArray(palette) || palette.length !== DEFAULT_PALETTE.length) {
		throw new TypeError('A custom palette needs eight swatches.');
	}
	return Array.from(palette, swatch => {
		if (typeof swatch?.name !== 'string' || !swatch.name.trim() || swatch.name.length > 32) {
			throw new TypeError('Each swatch needs a name of up to 32 characters.');
		}
		if (typeof swatch.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(swatch.color)) {
			throw new TypeError('Each swatch needs a six-digit hex color.');
		}
		return { name: swatch.name.trim(), color: swatch.color.toLowerCase() };
	});
}
