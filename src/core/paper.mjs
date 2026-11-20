import { DEFAULT_GRID } from './grid.mjs';

export const TONES = Object.freeze({
	ivory: { background: '#faf8f2', line: '#c5c6bc', dot: '#a1a49a', marker: '#71879a' },
	parchment: { background: '#f1e9d8', line: '#b9ae98', dot: '#9f947d', marker: '#8a7e69' },
	white: { background: '#ffffff', line: '#c4cdd5', dot: '#9da9b2', marker: '#71879a' },
	night: { background: '#172c40', line: '#47637b', dot: '#6787a3', marker: '#a5c4df' },
});

const NIGHT_INK = {
	'#171717': '#e5eaf1', '#243746': '#e5eaf1', '#242a35': '#e5eaf1',
	'#215b9c': '#7db3ee', '#b94d49': '#ed9690', '#397762': '#8bc7a9', '#8055a5': '#be9bdf',
};

export function paperTone(settings) {
	return settings.mode === 'grid' ? settings.grid?.paperTone ?? DEFAULT_GRID.paperTone : settings.paperTone;
}

export function inkOnPaper(color, tone) {
	return tone === 'night' ? NIGHT_INK[color.toLowerCase()] || color : color;
}
