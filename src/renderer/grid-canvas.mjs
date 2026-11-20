import { GRID_CELL, gridPage, connectorPath, shapePaths, shapePorts } from '../core/grid.mjs';
import { inkOnPaper, TONES } from '../core/paper.mjs';

const hitContext = document.createElement('canvas').getContext('2d');
const closeTo = (a, b, radius) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;
const HANDLE_COLOR = '#70a8dc';
const RESIZE_MIN = 8;

export function paintGrid(paint, bounds, grid, view, tone) {
	const left = Math.max(bounds.x, view.x), top = Math.max(bounds.y, view.y);
	const right = Math.min(bounds.x + bounds.width, view.x + view.width);
	const bottom = Math.min(bounds.y + bounds.height, view.y + view.height);
	if (left >= right || top >= bottom) return;
	const night = tone === 'night';
	const { width, height } = gridPage(grid);
	paint.save();
	paint.fillStyle = night ? '#1b3349' : TONES[tone].background;
	paint.fillRect(left, top, right - left, bottom - top);
	const layers = [
		[GRID_CELL, GRID_CELL, TONES[tone].line, .55, .55],
		[grid.cellColumns * GRID_CELL, grid.cellRows * GRID_CELL, TONES[tone].line, .8, 1],
		[width, height, TONES[tone].line, 1, 2],
	];
	for (const [dx, dy, color, alpha, weight] of layers) {
		paint.strokeStyle = color; paint.globalAlpha = alpha; paint.lineWidth = weight; paint.beginPath();
		for (let x = Math.ceil(left / dx) * dx; x <= right; x += dx) { paint.moveTo(x, top); paint.lineTo(x, bottom); }
		for (let y = Math.ceil(top / dy) * dy; y <= bottom; y += dy) { paint.moveTo(left, y); paint.lineTo(right, y); }
		paint.stroke();
	}
	paint.restore();
}

export function paintDiagram(paint, nodes, routes, tone, selected, draftConnection, linesOnly = false) {
	paint.save();
	paint.lineJoin = 'round'; paint.lineCap = 'round'; paint.lineWidth = 2;
	for (const route of routes) {
		paint.strokeStyle = route.id === selected ? HANDLE_COLOR : TONES[tone].marker;
		paint.stroke(new Path2D(connectorPath(route.points)));
	}
	if (draftConnection) {
		paint.strokeStyle = HANDLE_COLOR;
		paint.setLineDash([5, 4]);
		paint.stroke(new Path2D(connectorPath(draftConnection)));
		paint.setLineDash([]);
	}
	for (const node of nodes) {
		const { outline, detail } = shapePaths(node), path = new Path2D(outline);
		paint.fillStyle = TONES[tone].background; paint.strokeStyle = inkOnPaper(node.color, tone);
		if (!linesOnly) paint.fill(path);
		paint.stroke(path);
		if (detail) paint.stroke(new Path2D(detail));
	}
	paint.restore();
}

function corners(node) {
	const { x, y, width, height } = node;
	return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

export function paintShapeHandles(paint, node, tone) {
	paint.save();
	paint.strokeStyle = HANDLE_COLOR; paint.lineWidth = 1;
	paint.setLineDash([4, 3]); paint.strokeRect(node.x, node.y, node.width, node.height); paint.setLineDash([]);
	paint.fillStyle = TONES[tone].background;
	for (const { x, y } of corners(node)) {
		paint.fillRect(x - 3.5, y - 3.5, 7, 7);
		paint.strokeRect(x - 3.5, y - 3.5, 7, 7);
	}
	for (const { point: { x, y } } of shapePorts(node)) {
		paint.beginPath(); paint.arc(x, y, 4.5, 0, Math.PI * 2); paint.fill(); paint.stroke();
		paint.beginPath(); paint.moveTo(x - 2, y); paint.lineTo(x + 2, y); paint.moveTo(x, y - 2); paint.lineTo(x, y + 2); paint.stroke();
	}
	paint.restore();
}

export function diagramHit(nodes, routes, point, selected) {
	const selection = nodes.find(node => node.id === selected);
	if (selection) {
		const port = shapePorts(selection).findIndex(handle => closeTo(handle.point, point, 9));
		if (port >= 0) return { node: selection, port };
		const vertices = corners(selection);
		const corner = vertices.findIndex(vertex => closeTo(vertex, point, 8));
		if (corner >= 0) return { node: selection, corner, opposite: vertices[(corner + 2) % 4] };
	}
	const node = nodes.findLast(node => point.x >= node.x && point.x <= node.x + node.width
		&& point.y >= node.y && point.y <= node.y + node.height
		&& hitContext.isPointInPath(new Path2D(shapePaths(node).outline), point.x, point.y));
	if (node) return { node };
	const route = routes.findLast(route => route.points.some((end, index) => {
		if (!index) return false;
		const start = route.points[index - 1];
		const x = Math.max(Math.min(start.x, end.x), Math.min(point.x, Math.max(start.x, end.x)));
		const y = Math.max(Math.min(start.y, end.y), Math.min(point.y, Math.max(start.y, end.y)));
		return closeTo(point, { x, y }, 6);
	}));
	return route ? { route } : null;
}

export function drawShapeBox(start, point, shift) {
	let dx = point.x - start.x, dy = point.y - start.y;
	if (Math.hypot(dx, dy) < 5) return { x: start.x - 60, y: start.y - 36, width: 120, height: 72 };
	if (shift) {
		const size = Math.max(Math.abs(dx), Math.abs(dy));
		dx = Math.sign(dx || 1) * size; dy = Math.sign(dy || 1) * size;
	}
	return {
		x: start.x + Math.min(0, dx), y: start.y + Math.min(0, dy),
		width: Math.max(RESIZE_MIN, Math.abs(dx)), height: Math.max(RESIZE_MIN, Math.abs(dy)),
	};
}

export function resizeShapeBox(node, corner, opposite, delta, shift) {
	const sx = corner === 0 || corner === 3 ? -1 : 1, sy = corner < 2 ? -1 : 1;
	let width = Math.max(RESIZE_MIN, node.width + sx * delta.x);
	let height = Math.max(RESIZE_MIN, node.height + sy * delta.y);
	if (shift) {
		const scale = Math.max(width / node.width, height / node.height);
		width = node.width * scale; height = node.height * scale;
	}
	return { ...node, x: sx < 0 ? opposite.x - width : opposite.x, y: sy < 0 ? opposite.y - height : opposite.y, width, height };
}
