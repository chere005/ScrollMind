// Reading a ScrollMind file (.sm) without SQLite: a small read-only reader of the SQLite file format, enough for the
// three tables a Scroll or Grid keeps (src/main/storage.cjs). It lets a browser open a .sm — the MindSuite ScrollMind
// tab opens the copies the app keeps in iCloud Drive — and gives the same snapshot the desktop's readNative() gives.
// It reads a file written with journal_mode=DELETE (every export and every iCloud copy); it never writes.

import { validateSnapshot } from './model.mjs';

const MAGIC = 'SQLite format 3\0';
const FORMATS = { 0x534d4e44: { kind: 'scroll', version: 5, penTypeFrom: 2 }, 0x534d4752: { kind: 'grid', version: 2, penTypeFrom: 1 } };
const COLUMNS = { strokes: ['id', 'order_index', 'color', 'width', 'points', 'bounds', 'pen_type'], markers: ['id', 'y', 'label', 'kind'], metadata: ['key', 'value'] };
const MAX_BYTES = 1024 * 1024 * 1024, MAX_STROKES = 100_000, MAX_MARKERS = 10_000;

const fail = (message) => { throw new Error(message); };

/** The tables of a SQLite file, read-only: rows(table) yields each row's values in column order. */
export function openSQLite(bytes) {
	if (!(bytes instanceof Uint8Array)) fail('This is not a ScrollMind file.');
	if (bytes.length < 100 || new TextDecoder('latin1').decode(bytes.subarray(0, 16)) !== MAGIC) fail('This is not a ScrollMind file.');
	if (bytes.length > MAX_BYTES) fail('The scroll is too large to open safely.');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const rawSize = view.getUint16(16), pageSize = rawSize === 1 ? 65536 : rawSize;
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) fail('The scroll file is damaged.');
	if (view.getUint8(18) === 2 || view.getUint8(19) === 2) fail('Export the scroll again: this copy still depends on its write-ahead log.');
	if (view.getUint32(56) !== 1) fail('The scroll file uses a text encoding ScrollMind does not write.');
	const usable = pageSize - view.getUint8(20), pageCount = Math.floor(bytes.length / pageSize);
	const text = new TextDecoder('utf-8');

	const page = (number) => {
		if (!Number.isInteger(number) || number < 1 || number > pageCount) fail('The scroll file is damaged.');
		return (number - 1) * pageSize;
	};
	function varint(at) {
		let value = 0;
		for (let i = 0; i < 8; i++) {
			const byte = bytes[at + i];
			value = value * 128 + (byte & 0x7f);
			if (!(byte & 0x80)) return [value, at + i + 1];
		}
		return [value * 256 + bytes[at + 8], at + 9];
	}
	/** A cell's whole payload: the local part, then the overflow pages. */
	function payload(at, size) {
		const maxLocal = usable - 35;
		if (size <= maxLocal) return bytes.subarray(at, at + size);
		const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
		let local = minLocal + ((size - minLocal) % (usable - 4));
		if (local > maxLocal) local = minLocal;
		const out = new Uint8Array(size);
		out.set(bytes.subarray(at, at + local), 0);
		let filled = local, next = view.getUint32(at + local), hops = 0;
		while (filled < size) {
			if (!next || ++hops > pageCount) fail('The scroll file is damaged.');
			const start = page(next), take = Math.min(usable - 4, size - filled);
			out.set(bytes.subarray(start + 4, start + 4 + take), filled);
			filled += take;
			next = view.getUint32(start);
		}
		return out;
	}
	function record(data) {
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let [headerSize, at] = varintIn(data, 0);
		const types = [];
		while (at < headerSize) { const [type, next] = varintIn(data, at); types.push(type); at = next; }
		let body = headerSize;
		return types.map((type) => {
			if (type === 0) return null;
			if (type === 8) return 0;
			if (type === 9) return 1;
			if (type >= 1 && type <= 6) {
				const width = [0, 1, 2, 3, 4, 6, 8][type];
				let value = 0;
				for (let i = 0; i < width; i++) value = value * 256 + data[body + i];
				if (data[body] & 0x80) value -= 2 ** (8 * width);
				body += width;
				return value;
			}
			if (type === 7) { const value = dv.getFloat64(body); body += 8; return value; }
			if (type >= 12) {
				const length = (type - (type % 2 ? 13 : 12)) / 2, slice = data.subarray(body, body + length);
				body += length;
				return type % 2 ? text.decode(slice) : slice;
			}
			fail('The scroll file is damaged.');
		});
	}
	function varintIn(data, at) {
		let value = 0;
		for (let i = 0; i < 8; i++) {
			const byte = data[at + i];
			value = value * 128 + (byte & 0x7f);
			if (!(byte & 0x80)) return [value, at + i + 1];
		}
		return [value * 256 + data[at + 8], at + 9];
	}
	/** Every row of the table b-tree rooted at this page, as [rowid, values]. */
	function* walk(root) {
		const stack = [root], seen = new Set();
		while (stack.length) {
			const number = stack.pop();
			if (seen.has(number)) fail('The scroll file is damaged.');
			seen.add(number);
			const start = page(number), header = start + (number === 1 ? 100 : 0), type = bytes[header];
			const cells = view.getUint16(header + 3), pointers = header + (type === 0x05 ? 12 : 8);
			if (type === 0x05) {
				const children = [];
				for (let i = 0; i < cells; i++) children.push(view.getUint32(start + view.getUint16(pointers + i * 2)));
				children.push(view.getUint32(header + 8));
				for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
			} else if (type === 0x0d) {
				for (let i = 0; i < cells; i++) {
					let at = start + view.getUint16(pointers + i * 2), size, rowid;
					[size, at] = varint(at);
					[rowid, at] = varint(at);
					yield [rowid, record(payload(at, size))];
				}
			} else fail('The scroll file is damaged.');
		}
	}
	const schema = new Map();
	for (const [, [type, name, , rootpage, sql]] of walk(1)) if (type === 'table') schema.set(name, { rootpage, sql });
	return {
		applicationId: view.getUint32(68),
		userVersion: view.getUint32(60),
		has: (table) => schema.has(table),
		sql: (table) => (typeof schema.get(table)?.sql === 'string' ? schema.get(table).sql : null),
		*rows(table) {
			const found = schema.get(table);
			if (!found) fail('The scroll database has an invalid table layout.');
			for (const [rowid, values] of walk(found.rootpage)) yield { rowid, values };
		},
	};
}

/** A ScrollMind file's kind and snapshot, the same snapshot src/main/storage.cjs reads, validated. */
export function readScrollMindFile(bytes) {
	const db = openSQLite(bytes);
	const format = FORMATS[db.applicationId];
	if (!format) fail('This file is not a ScrollMind scroll or grid.');
	if (db.userVersion < 1 || db.userVersion > format.version) fail('This scroll uses an unsupported format version. Update ScrollMind before opening it.');
	for (const [table, columns] of Object.entries(COLUMNS)) {
		const sql = db.sql(table), wanted = table === 'strokes' && db.userVersion < format.penTypeFrom ? columns.slice(0, -1) : columns;
		const names = sql === null ? null : [...sql.slice(sql.indexOf('(') + 1).matchAll(/(?:^|,)\s*"?([A-Za-z_]+)"?\s/g)].map((m) => m[1]);
		if (!names || names.length < wanted.length || wanted.some((name, i) => names[i] !== name)) fail('The scroll database has a damaged table layout.');
	}
	const metadata = new Map();
	for (const { values: [key, value] } of db.rows('metadata')) metadata.set(key, JSON.parse(value));
	if (!metadata.has('view') || !metadata.has('settings')) fail('The scroll is missing its settings.');
	const strokes = [];
	for (const { rowid, values } of db.rows('strokes')) {
		if (strokes.length > MAX_STROKES) fail('The scroll is too large to open safely.');
		const [id, order, color, width, points, , penType = null] = values;
		strokes.push({ rowid, order, stroke: { id, color, width, points: JSON.parse(points), ...(penType === null || db.userVersion < format.penTypeFrom ? {} : { penType }) } });
	}
	strokes.sort((a, b) => a.order - b.order || a.rowid - b.rowid);
	const markers = [];
	for (const { rowid, values: [id, y, label, kind] } of db.rows('markers')) {
		if (markers.length > MAX_MARKERS) fail('The scroll is too large to open safely.');
		markers.push({ rowid, marker: { id, y, label, kind } });
	}
	markers.sort((a, b) => a.marker.y - b.marker.y || a.rowid - b.rowid);
	return {
		kind: format.kind,
		snapshot: validateSnapshot({
			version: 1, strokes: strokes.map((row) => row.stroke), markers: markers.map((row) => row.marker),
			view: metadata.get('view'), settings: metadata.get('settings'), diagram: metadata.get('diagram'),
		}),
	};
}
