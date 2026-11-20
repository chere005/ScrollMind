export const GRID_CELL = 24;
export const GRID_LIMIT = 100;
export const DEFAULT_GRID = Object.freeze({
	cellRows: 12, cellColumns: 16, blockRows: 2, blockColumns: 2, paperTone: 'night',
});
export const DIAGRAM_SHAPES = Object.freeze({
	rectangle: 'Rectangle', ellipse: 'Oval', triangle: 'Triangle', trapezoid: 'Trapezoid', cylinder: 'Cylinder',
});

export function gridPage(grid) {
	return {
		width: grid.cellColumns * grid.blockColumns * GRID_CELL,
		height: grid.cellRows * grid.blockRows * GRID_CELL,
	};
}

export function gridStartView(grid, visibleWidth, visibleHeight) {
	const page = gridPage(grid);
	return { x: (page.width - visibleWidth) / 2, y: (page.height - visibleHeight) / 2 };
}

export function gridBounds(grid, ...boxes) {
	const page = gridPage(grid);
	let left = 0, top = 0, right = page.width, bottom = page.height;
	for (const box of boxes) {
		if (!box) continue;
		left = Math.min(left, box.x);
		top = Math.min(top, box.y);
		right = Math.max(right, box.x + box.width);
		bottom = Math.max(bottom, box.y + box.height);
	}
	const x = Math.floor(left / page.width) * page.width;
	const y = Math.floor(top / page.height) * page.height;
	return {
		x, y,
		width: Math.ceil(right / page.width) * page.width - x,
		height: Math.ceil(bottom / page.height) * page.height - y,
	};
}

export function diagramBounds(nodes, routes = []) {
	if (!nodes.length) return null;
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const { x, y, width, height } of nodes) {
		left = Math.min(left, x);
		top = Math.min(top, y);
		right = Math.max(right, x + width);
		bottom = Math.max(bottom, y + height);
	}
	for (const { points } of routes) {
		for (const { x, y } of points) {
			left = Math.min(left, x - 8);
			top = Math.min(top, y - 8);
			right = Math.max(right, x + 8);
			bottom = Math.max(bottom, y + 8);
		}
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function shapePaths({ kind, x, y, width: w, height: h }) {
	const right = x + w, bottom = y + h, cx = x + w / 2, cy = y + h / 2;
	switch (kind) {
		case 'ellipse':
			return { outline: `M${x} ${cy} a${w / 2} ${h / 2} 0 1 0 ${w} 0 a${w / 2} ${h / 2} 0 1 0 ${-w} 0 Z` };
		case 'triangle':
			return { outline: `M${cx} ${y} L${right} ${bottom} H${x} Z` };
		case 'trapezoid':
			return { outline: `M${x + w / 5} ${y} H${right - w / 5} L${right} ${bottom} H${x} Z` };
		case 'cylinder': {
			const cap = Math.min(h / 5, w / 4);
			return {
				outline: `M${x} ${y + cap} a${w / 2} ${cap} 0 0 1 ${w} 0 V${bottom - cap} a${w / 2} ${cap} 0 0 1 ${-w} 0 Z`,
				detail: `M${x} ${y + cap} a${w / 2} ${cap} 0 0 0 ${w} 0`,
			};
		}
		default:
			return { outline: `M${x} ${y} H${right} V${bottom} H${x} Z` };
	}
}

// Attach to the outline, including the sloped sides of triangles and trapezoids.
export function shapePorts(node, gap = 16) {
	const { x, y, width, height, kind } = node;
	const inset = kind === 'triangle' ? width / 4 : kind === 'trapezoid' ? width / 10 : 0;
	const cx = x + width / 2, cy = y + height / 2;
	return [
		{ anchor: { x: cx, y }, point: { x: cx, y: y - gap } },
		{ anchor: { x: x + width - inset, y: cy }, point: { x: x + width + gap, y: cy } },
		{ anchor: { x: cx, y: y + height }, point: { x: cx, y: y + height + gap } },
		{ anchor: { x: x + inset, y: cy }, point: { x: x - gap, y: cy } },
	];
}

const edge = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function crosses(a, b, box) {
	if (a.x === b.x) return a.x > box.left && a.x < box.right && Math.min(a.y, b.y) < box.bottom && Math.max(a.y, b.y) > box.top;
	return a.y > box.top && a.y < box.bottom && Math.min(a.x, b.x) < box.right && Math.max(a.x, b.x) > box.left;
}

function simplify(points) {
	const result = [];
	for (const point of points) {
		if (result.length && edge(result.at(-1), point) === 0) continue;
		const before = result.at(-2), last = result.at(-1);
		if (before && edge(before, last) + edge(last, point) === edge(before, point)
			&& (before.x === last.x && last.x === point.x || before.y === last.y && last.y === point.y)) result.pop();
		result.push(point);
	}
	return result;
}

export function routeConnection(from, to, nodes, portIndex) {
	const midpoint = center({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, width: (from.width + to.width) / 2, height: (from.height + to.height) / 2 });
	const nearby = nodes.filter(node => node.id !== from.id && node.id !== to.id);
	const obstacles = (nearby.length > 24
		? nearby.map(node => ({ node, distance: edge(midpoint, center(node)) })).sort((a, b) => a.distance - b.distance).slice(0, 24).map(item => item.node)
		: nearby);
	const boxes = [from, to, ...obstacles].map(node => ({
		left: node.x - 8, top: node.y - 8, right: node.x + node.width + 8, bottom: node.y + node.height + 8,
	}));
	const sources = shapePorts(from), targets = shapePorts(to);
	let best = null, bestHits = Infinity, bestLength = Infinity;
	for (const [index, start] of sources.entries()) {
		if (portIndex !== undefined && portIndex !== index) continue;
		for (const end of targets) {
			const a = start.point, b = end.point;
			const startHits = boxes.slice(1).filter(box => crosses(start.anchor, a, box)).length;
			const endHits = boxes.filter((box, i) => i !== 1 && crosses(b, end.anchor, box)).length;
			const xChannels = new Set([(a.x + b.x) / 2, ...boxes.flatMap(box => [box.left, box.right])]);
			const yChannels = new Set([(a.y + b.y) / 2, ...boxes.flatMap(box => [box.top, box.bottom])]);
			const candidates = [
				[{ x: a.x, y: b.y }], [{ x: b.x, y: a.y }],
				...[...xChannels].map(x => [{ x, y: a.y }, { x, y: b.y }]),
				...[...yChannels].map(y => [{ x: a.x, y }, { x: b.x, y }]),
			];
			for (const turns of candidates) {
				const middle = [a, ...turns, b];
				const length = middle.reduce((sum, point, i) => i ? sum + edge(middle[i - 1], point) : sum, 0)
					+ edge(start.anchor, a) + edge(b, end.anchor);
				if (!bestHits && length > bestLength) continue;
				let hits = startHits + endHits;
				for (let i = 1; i < middle.length && hits <= bestHits; i++) {
					if (edge(middle[i - 1], middle[i])) hits += boxes.filter(box => crosses(middle[i - 1], middle[i], box)).length;
				}
				if (hits > bestHits) continue;
				const path = simplify([start.anchor, ...middle, end.anchor]);
				const score = length + Math.max(0, path.length - 2) * 12;
				if (hits < bestHits || score < bestLength) {
					best = path;
					bestHits = hits;
					bestLength = score;
				}
			}
		}
	}
	return best;
}

export function diagramRoutes({ nodes, connections }) {
	const byId = new Map(nodes.map(node => [node.id, node]));
	return connections.map(connection => ({
		...connection,
		points: routeConnection(byId.get(connection.from), byId.get(connection.to), nodes, connection.port),
	}));
}

export function connectorPath(points) {
	const end = points.at(-1), before = points.at(-2);
	const angle = Math.atan2(end.y - before.y, end.x - before.x);
	const arrow = [-.48, .48].map(turn => [end.x - 9 * Math.cos(angle + turn), end.y - 9 * Math.sin(angle + turn)]);
	return `M${points.map(({ x, y }) => `${x} ${y}`).join('L')} M${arrow[0].join(' ')}L${end.x} ${end.y}L${arrow[1].join(' ')}`;
}
