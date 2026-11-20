import { Notebook as Scroll, MIN_ZOOM, MAX_ZOOM, boundsOf, makeStroke, strokeHitsPoint, strokeIntersectsRect, validateStrokes } from '../core/model.mjs';
import { PEN_CLICK_MOVEMENT, PenButtonShortcuts } from '../core/pen-shortcuts.mjs';
import { PenInput } from '../core/pen-input.mjs';
import { makeShape } from '../core/shapes.mjs';
import { brushWidth, brushCap, brushOpacity } from '../core/brushes.mjs';
import { strokeGeometry } from '../core/stroke-geometry.mjs';
import { createPenControls } from './pen-controls.mjs';
import { localizeShortcut } from '../core/shortcut-labels.mjs';
import { DEFAULT_GRID, GRID_LIMIT, DIAGRAM_SHAPES, diagramBounds, diagramRoutes, gridBounds, gridStartView, routeConnection, shapePaths, shapePorts, connectorPath } from '../core/grid.mjs';
import { FILL_TYPE, isFill, fillRegion, contoursToPoints, pointsToContours, contoursPath } from '../core/fill.mjs';
import { TONES as tones, paperTone, inkOnPaper } from '../core/paper.mjs';
import { paintGrid, paintDiagram, paintShapeHandles, diagramHit, drawShapeBox, resizeShapeBox } from './grid-canvas.mjs';

const $ = selector => document.querySelector(selector);
const bridge = window.scrollmind;
const canvas = $('#canvas'), overlay = $('#overlay');
const ctx = canvas.getContext('2d', { alpha: false }), ink = overlay.getContext('2d');
const status = $('#status');
const platform = bridge.platform || 'darwin';
const windows = platform === 'win32';
if (windows) document.documentElement.classList.add('win32');
const windowsPen = (bridge.testPenPlatform || platform) === 'win32';
if (platform !== 'darwin') {
  for (const element of document.querySelectorAll('[title]')) element.title = localizeShortcut(element.title, platform);
  for (const element of document.querySelectorAll('kbd')) element.textContent = localizeShortcut(element.textContent, platform);
  if (windows) {
    const full = $('#help-fullscreen'); if (full) full.textContent = 'Ctrl+Shift+F or F11';
    // The Wacom help describes macOS driver wording; on Windows it describes Windows Ink and the driver's side-switch assignments.
    $('#help-wacom-intro').textContent = 'The tip writes with pressure. In the Wacom driver, turn on Windows Ink, then set the pen side switches:';
    $('#help-wacom-buttons').innerHTML = '<dt>Side Switch Mode: Click & Tap</dt><dd>Lower switch on Right Click → hold and touch or drag to delete · no hover clicks, so put Undo/Redo (Ctrl+Z · Ctrl+Y) on ExpressKeys</dd><dt>Side Switch Mode: Hover Click</dt><dd>Right Click (lower) / Middle Click (upper) → hover double-click undoes / redoes · tap lower then upper quickly, then tap and drag the tip to zoom · erase with E or the rear eraser</dd><dt>Upper side switch</dt><dd>Middle Click → hold and drag to scroll</dd><dt>ExpressKeys, if available</dt><dd>Ctrl+Z · Ctrl+Y · V · Tab</dd>';
    $('#help-space').insertAdjacentHTML('beforeend', '<dt>Close scroll / Quit</dt><dd><kbd>Ctrl+W</kbd> / <kbd>Alt+F4</kbd></dd>');
  }
}
let zoomNextTip = false, lastPointerType = null, testMode = false;
// Zoom by dragging the pen tip: up zooms in, down zooms out, as in NoteMind; 140 px is a doubling.
const ZOOM_DRAG_RATE = Math.LN2 / 140;
let scroll = new Scroll();
let settings = { color: '#171717', width: 3, paper: 'plain', paperTone: 'ivory' };
let offsetY = 0, scrollX = 0, scrollZoom = 1, gridZoom = 1;
let gridX, gridY;
let tool = 'pen', mousePen = false, selection = new Set(), active = null;
let diagramSelection = null;
let spaceDown = false, loaded = false, loadError = null;
let width = innerWidth, height = innerHeight, ratio = devicePixelRatio || 1;
let revision = 0, savedRevision = 0, saveTimer, savePromise, frame, baseDirty = true;
let pasteCount = 0, clipboardSource = '';
let fileOperation = null;
let clipboardQueue = Promise.resolve();
let nativeFileQueue = Promise.resolve();
const penInput = new PenInput({ windowsInk: windowsPen });
const penShortcuts = new PenButtonShortcuts({ navigation: true });
const middleClicks = new PenButtonShortcuts();
let workspace = { kind: 'scroll', activeId: null, scrolls: [] };
let shapeKind = 'rectangle';
const scrollSessions = new Map();
let brushStyles = { ink: null, highlighter: null };
const paintedPaths = new WeakMap();
const penControls = createPenControls({
  onColor(color) { finishGesture(); settings.color = color; changed(); },
  onPalette(palette) {
    if (palette) settings.palette = palette;
    else delete settings.palette;
    changed();
  },
  focusCanvas() { overlay.focus({ preventScroll: true }); },
});
const gridMode = () => workspace.kind === 'grid';
const documentTitle = () => gridMode() ? 'Grid' : 'Scroll';
const sessionKey = (state = workspace, id = state.activeId) => state.kind + ':' + id;
const zoomLevel = () => gridMode() ? gridZoom : scrollZoom;
const viewWidth = () => width / zoomLevel();
const viewHeight = () => height / zoomLevel();
const gridSettings = () => settings.grid ?? DEFAULT_GRID;
const gridStart = () => gridStartView(gridSettings(), viewWidth(), viewHeight());
const viewX = () => gridMode() ? gridX ?? gridStart().x : scrollX;
const viewY = () => gridMode() ? gridY ?? gridStart().y : offsetY;
const savedView = () => ({ offsetY, scrollX, gridX, gridY, scrollZoom, gridZoom });
const diagramShape = () => gridSettings().shape ?? 'rectangle';
const gridInputs = [...document.querySelectorAll('[data-grid-size]')];
let cachedDiagram, cachedRoutes, cachedStrokes, cachedInkBounds;
function liveRoutes() {
  if (cachedDiagram !== scroll.diagram) {
    cachedDiagram = scroll.diagram;
    cachedRoutes = diagramRoutes(cachedDiagram);
  }
  return cachedRoutes;
}
function inkBounds() {
  if (cachedStrokes !== scroll.strokes) {
    cachedStrokes = scroll.strokes;
    cachedInkBounds = boundsOf(cachedStrokes);
  }
  return cachedInkBounds;
}
function snapshot() { return scroll.snapshot(savedView(), settings); }
function message(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  $('#save-alert').hidden = !error;
  $('#save-alert').textContent = error ? text : '';
}
function changed() {
  revision++; message('Saving…'); clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave().catch(() => {}), 450);
  updateControls(); requestRender();
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (loadError) throw new Error(loadError);
  if (savePromise) { await savePromise; if (savedRevision < revision) return flushSave(); return; }
  if (savedRevision === revision) return;
  savePromise = (async () => {
    while (savedRevision < revision) {
      const writingRevision = revision;
      const { token, ...changes } = scroll.pendingChanges();
      await bridge.saveChanges({ ...changes, view: savedView(), settings, scrollId: workspace.activeId, documentKind: workspace.kind });
      scroll.acknowledgeChanges(token);
      savedRevision = writingRevision;
    }
    message('Saved');
  })();
  try { await savePromise; }
  catch (error) { message('Couldn’t save · open writing folder', true); throw error; }
  finally { savePromise = null; }
}
function selectedStrokes() { return [...selection].map(id => scroll.get(id)).filter(Boolean); }
function updateControls() {
  selection = new Set([...selection].filter(id => scroll.get(id)));
  if (diagramSelection && ![...scroll.diagram.nodes, ...scroll.diagram.connections].some(item => item.id === diagramSelection)) diagramSelection = null;
  $('#undo').disabled = !scroll.canUndo; $('#redo').disabled = !scroll.canRedo;
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
  penControls.refreshPalette(settings.palette, paperTone(settings));
  const inkColor = settings.color.toLowerCase();
  const paletteColor = !settings.palette && ['#243746', '#242a35'].includes(inkColor) ? '#171717' : inkColor;
  document.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === paletteColor)));
  document.querySelectorAll('[data-width]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.width) === settings.width)));
  $('#selection-hint').textContent = selection.size ? `${selection.size} stroke${selection.size === 1 ? '' : 's'} · drag to move` : '';
  $('#paper-tone').value = paperTone(settings); $('#paper-pattern').value = settings.paper;
  $('#pen-type').value = settings.penType || 'pen';
  $('#shape-select').value = tool === 'shape' ? shapeKind : '';
  $('#shape-select').dataset.active = String(tool === 'shape');
  $('#shape-select').hidden = gridMode();
  $('#grid-shapes').hidden = !gridMode();
  $('#diagram-shape').textContent = DIAGRAM_SHAPES[diagramShape()];
  $('#diagram-shape').setAttribute('aria-pressed', String(tool === 'diagram'));
  $('#scroll-mode').setAttribute('aria-pressed', String(!gridMode()));
  $('#grid-mode').setAttribute('aria-pressed', String(gridMode()));
  const title = documentTitle();
  $('#sidebar-heading').textContent = title + 's';
  $('#open-documents-title').textContent = 'Open ' + title.toLowerCase() + 's';
  $('#closed-scrolls summary').textContent = 'Other ' + title.toLowerCase() + 's';
  $('#file-title').textContent = title + ' file';
  $('#open-sm').textContent = 'Open…';
  $('#export-label').textContent = 'Export ' + title;
  $('#export-sm').textContent = gridMode() ? 'ScrollMind Grid (.sm)' : 'ScrollMind (.sm)';
  $('#clear-scroll').textContent = 'Clear current ' + title.toLowerCase();
  $('#data-folder').textContent = 'Open writing folder ↗';
  $('#new-scroll').title = 'New ' + title;
  $('#scroll-navigation').hidden = gridMode();
  $('#grid-settings').hidden = !gridMode();
  $('#paper-ruling').hidden = gridMode();
  $('#zoom-reset').textContent = Math.round(zoomLevel() * 100) + '%';
  $('#zoom-in').disabled = zoomLevel() >= MAX_ZOOM;
  $('#zoom-out').disabled = zoomLevel() <= MIN_ZOOM;
  for (const input of gridInputs) if (input !== document.activeElement) input.value = gridSettings()[input.dataset.gridSize];
  penControls.refreshColor(settings.color);
  document.body.classList.toggle('night', paperTone(settings) === 'night'); updateCursor();
}
function setTool(value, explicit = true) {
  finishGesture(); zoomNextTip = false; tool = value; mousePen = value === 'pen' && explicit;
  if (tool !== 'select') selection.clear();
  if (tool !== 'select') diagramSelection = null;
  updateControls(); requestRender();
}
function updateCursor() {
  const pen = lastPointerType === 'pen';
  // A side switch held and the display placing the pen: the driver may have frozen the pointer where the switch went down, and the
  // pen itself is on the display, so the page shows no pointer.
  overlay.style.cursor = penInput.placing ? 'none'
    : ['pan', 'move', 'move-node'].includes(active?.kind) ? 'grabbing'
    : spaceDown || tool === 'hand' ? 'grab'
    : pen && zoomNextTip ? 'zoom-in'
    : tool === 'select' || (tool === 'pen' && !mousePen && !pen) ? 'default' : 'crosshair';
}
function setOffset(value, persist = true, x = viewX()) {
  if (!Number.isFinite(value) || !Number.isFinite(x)) return;
  const limit = coordinate => Math.max(-10_000_000, Math.min(10_000_000, coordinate));
  if (gridMode()) { gridX = limit(x); gridY = limit(value); }
  else { scrollX = limit(x); offsetY = limit(value); }
  if (persist) changed(); else requestRender();
}
function zoomAt(value, x = width / 2, y = height / 2) {
  const previous = zoomLevel(), next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  if (previous === next) return;
  const originX = viewX(), originY = viewY();
  if (gridMode()) gridZoom = next; else scrollZoom = next;
  const delta = 1 / previous - 1 / next;
  setOffset(originY + y * delta, true, originX + x * delta);
}
function resize() {
  width = innerWidth; height = innerHeight; ratio = devicePixelRatio || 1;
  for (const target of [canvas, overlay]) { target.width = Math.round(width * ratio); target.height = Math.round(height * ratio); }
  requestRender();
}
function requestRender(redrawBase = true) { baseDirty ||= redrawBase; if (!frame) frame = requestAnimationFrame(render); }
function drawPaper(pages) {
  const name = paperTone(settings), tone = tones[name];
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = tone.background; ctx.fillRect(0, 0, width, height);
  const x = viewX(), y = viewY(), visibleWidth = viewWidth(), visibleHeight = viewHeight();
  const right = x + visibleWidth, bottom = y + visibleHeight;
  if (pages) {
    if (name !== 'night') { ctx.fillStyle = '#e8e7e1'; ctx.fillRect(0, 0, width, height); }
    setWorldTransform(ctx);
    paintGrid(ctx, pages, gridSettings(), { x, y, width: visibleWidth, height: visibleHeight }, name);
    return;
  }
  setWorldTransform(ctx);
  ctx.strokeStyle = tone.line; ctx.fillStyle = tone.line; ctx.lineWidth = .65; ctx.globalAlpha = .5;
  const gap = settings.paper === 'ruled' ? 32 : 24;
  const startX = 16 + Math.ceil((x - 16) / gap) * gap, startY = Math.ceil(y / gap) * gap;
  if (settings.paper === 'dots') {
    ctx.fillStyle = tone.dot; ctx.globalAlpha = .9; ctx.beginPath();
    for (let row = startY; row < bottom; row += gap) for (let col = startX; col < right; col += gap) {
      ctx.moveTo(col + 1, row); ctx.arc(col, row, 1, 0, Math.PI * 2);
    }
    ctx.fill();
  } else if (settings.paper === 'ruled' || settings.paper === 'grid') {
    ctx.beginPath(); for (let row = startY; row < bottom; row += gap) { ctx.moveTo(x, row); ctx.lineTo(right, row); }
    if (settings.paper === 'grid') for (let col = startX; col < right; col += gap) { ctx.moveTo(col, y); ctx.lineTo(col, bottom); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const marker of scroll.markers) {
    if (marker.y < y - 30 || marker.y > bottom + 30) continue;
    ctx.save(); ctx.strokeStyle = tone.marker; ctx.fillStyle = tone.marker; ctx.lineWidth = 1;
    if (marker.kind === 'marker') {
      ctx.globalAlpha = .65; ctx.beginPath(); ctx.moveTo(right - 18, marker.y - 9); ctx.lineTo(right - 8, marker.y - 9); ctx.lineTo(right - 8, marker.y + 8); ctx.lineTo(right - 13, marker.y + 3); ctx.lineTo(right - 18, marker.y + 8); ctx.closePath(); ctx.fill();
    } else {
      ctx.globalAlpha = .48; if (marker.kind === 'page-break') ctx.setLineDash([5, 7]);
      ctx.beginPath(); ctx.moveTo(x + 30, marker.y); ctx.lineTo(right - 30, marker.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = marker.kind === 'section' ? '500 13px -apple-system, sans-serif' : '10px -apple-system, sans-serif';
      const textWidth = ctx.measureText(marker.label).width;
      ctx.globalAlpha = 1; ctx.fillStyle = tone.background; ctx.fillRect(x + 44, marker.y - 10, textWidth + 18, 20);
      ctx.fillStyle = tone.marker; ctx.fillText(marker.label, x + 53, marker.y + 4);
    }
    ctx.restore();
  }
}
function setWorldTransform(paint) {
  const scale = ratio * zoomLevel();
  paint.setTransform(scale, 0, 0, scale, -viewX() * scale, -viewY() * scale);
}
function displayColor(color) {
  return inkOnPaper(color, paperTone(settings));
}
function transformStroke(stroke, t) {
  return { ...stroke, width: Math.max(.01, Math.min(1000, stroke.width * Math.sqrt(Math.abs(t.scaleX * t.scaleY)))), points: stroke.points.map(point => ({ ...point, x: t.originX + (point.x - t.originX) * t.scaleX + t.dx, y: t.originY + (point.y - t.originY) * t.scaleY + t.dy })) };
}
function drawStroke(paint, stroke, flat) {
  const points = stroke.points; if (!points.length) return;
  if (isFill(stroke)) {
    let path = Object.isFrozen(stroke) ? paintedPaths.get(stroke) : null;
    if (!path) { path = new Path2D(contoursPath(pointsToContours(points))); if (Object.isFrozen(stroke)) paintedPaths.set(stroke, path); }
    paint.save(); paint.fillStyle = flat ?? displayColor(stroke.color); paint.fill(path, 'evenodd'); paint.restore(); return;
  }
  const geometry = strokeGeometry(stroke);
  if (geometry) {
    let path = Object.isFrozen(stroke) ? paintedPaths.get(stroke) : null;
    if (!path) { path = new Path2D(geometry.path); if (Object.isFrozen(stroke) && Object.isFrozen(stroke.points) && stroke.points.every(Object.isFrozen)) paintedPaths.set(stroke, path); }
    paint.save(); paint.fillStyle = flat ?? displayColor(stroke.color); paint.globalAlpha = flat ? 1 : brushOpacity(stroke.penType); paint.fill(path); paint.restore(); return;
  }
  paint.save();
  paint.strokeStyle = flat ?? displayColor(stroke.color); paint.fillStyle = flat ?? displayColor(stroke.color); paint.lineCap = brushCap(stroke.penType); paint.lineJoin = 'round';
  const size = (p, angle = 0) => brushWidth(stroke.width, p ?? .5, stroke.penType, angle);
  if (points.length === 1) {
    const point = points[0], diameter = size(point.p);
    if (paint.lineCap === 'square') paint.fillRect(point.x - diameter / 2, point.y - diameter / 2, diameter, diameter);
    else { paint.beginPath(); paint.arc(point.x, point.y, diameter / 2, 0, Math.PI * 2); paint.fill(); }
  }
  else {
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1], current = points[index];
      paint.lineWidth = size((previous.p + current.p) / 2, Math.atan2(current.y - previous.y, current.x - previous.x)); paint.beginPath(); paint.moveTo(previous.x, previous.y); paint.lineTo(current.x, current.y); paint.stroke();
    }
  }
  paint.restore();
}
function dragTransform() {
  if (!active || !['move', 'resize'].includes(active.kind)) return null;
  return active.kind === 'move' ? { scaleX: 1, scaleY: 1, originX: 0, originY: 0, dx: active.dx, dy: active.dy } : active.transform;
}
function render() {
  frame = null;
  const transform = dragTransform();
  const preview = transform ? selectedStrokes().map(stroke => transformStroke(stroke, transform)) : null;
  const { nodes, connections } = scroll.diagram;
  const draft = active?.kind === 'draw-node' ? active.box : null;
  const moved = ['move-node', 'resize-node'].includes(active?.kind) ? active.box : null;
  const shownNodes = moved ? nodes.map(node => node.id === moved.id ? moved : node) : nodes;
  const routes = moved ? diagramRoutes({ nodes: shownNodes, connections }) : liveRoutes();
  const tone = paperTone(settings);
  let connector;
  if (active?.kind === 'connect') {
    const { anchor, point } = shapePorts(active.node)[active.port];
    connector = active.target ? routeConnection(active.node, active.target, nodes, active.port)
      : [anchor, point, { x: active.current.x, y: point.y }, active.current];
  }
  if (baseDirty) {
    const pages = gridMode() ? gridBounds(gridSettings(), inkBounds(), diagramBounds(shownNodes, routes), draft,
      active?.kind === 'ink' ? active.bounds : null, preview ? boundsOf(preview) : null) : null;
    baseDirty = false; drawPaper(pages);
    paintDiagram(ctx, shownNodes, routes, tone, gridMode() ? diagramSelection : null);
    const visible = scroll.query({ x: viewX() - 100, y: viewY() - 100, width: viewWidth() + 200, height: viewHeight() + 200 }).filter(stroke => !(transform && selection.has(stroke.id)));
    const shown = preview ? [...visible, ...preview] : visible;
    // Fills lie beneath all ink; shape outlines are drawn again over them so a fill never covers a line.
    const fills = shown.filter(isFill);
    for (const stroke of fills) drawStroke(ctx, stroke);
    if (fills.length && (shownNodes.length || routes.length)) paintDiagram(ctx, shownNodes, routes, tone, gridMode() ? diagramSelection : null, undefined, true);
    for (const stroke of shown) if (!isFill(stroke)) drawStroke(ctx, stroke);
  }
  ink.setTransform(1, 0, 0, 1, 0, 0); ink.clearRect(0, 0, overlay.width, overlay.height);
  setWorldTransform(ink);
  if (active?.kind === 'ink') drawStroke(ink, { points: active.points, color: active.color, width: active.width, penType: active.penType });
  if (active?.kind === 'shape') for (const stroke of active.preview) drawStroke(ink, stroke);
  if (draft || connector) paintDiagram(ink, draft ? [draft] : [], [], tone, null, connector);
  const selectedNode = gridMode() && shownNodes.find(node => node.id === diagramSelection);
  if (selectedNode) paintShapeHandles(ink, selectedNode, tone);
  if (active?.kind === 'marquee') {
    const rect = rectangle(active.start, active.current); ink.fillStyle = '#427cba12'; ink.strokeStyle = '#4e83b5'; ink.lineWidth = 1; ink.setLineDash([5, 4]);
    ink.fillRect(rect.x, rect.y, rect.width, rect.height); ink.strokeRect(rect.x, rect.y, rect.width, rect.height); ink.setLineDash([]);
  } else if (selection.size) {
    const bounds = boundsOf(preview || selectedStrokes());
    if (bounds) {
      const box = bounds, pad = 7;
      ink.strokeStyle = tone === 'night' ? '#8ebce7' : '#4e83b5'; ink.lineWidth = 1; ink.setLineDash([5, 4]);
      ink.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2); ink.setLineDash([]); ink.fillStyle = tones[tone].background;
      for (const point of corners(box, pad)) { ink.beginPath(); ink.arc(point.x, point.y, 4, 0, Math.PI * 2); ink.fill(); ink.stroke(); }
    }
  }
}
function world(event) { return { x: event.clientX / zoomLevel() + viewX(), y: event.clientY / zoomLevel() + viewY() }; }
function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }; }
function corners(box, pad = 0) { return [{ x: box.x - pad, y: box.y - pad }, { x: box.x + box.width + pad, y: box.y - pad }, { x: box.x + box.width + pad, y: box.y + box.height + pad }, { x: box.x - pad, y: box.y + box.height + pad }]; }
function inside(point, box, pad = 0) { return point.x >= box.x - pad && point.x <= box.x + box.width + pad && point.y >= box.y - pad && point.y <= box.y + box.height + pad; }
function contact(event) {
  return event.pointerType !== 'pen' || (event.tipDown ?? event.pressure > 0)
    || Boolean((event.buttons & 32) && event.pressure > 0);
}
function barrelDelete(event) {
  return event.pointerType === 'pen' && Boolean(event.buttons & 2) && !(event.buttons & 32) && event.button !== 5;
}
function penShortcut(event) {
  const action = event.pointerType === 'pen' ? penShortcuts.update(event.type === 'pointerenter' ? { ...event, type: 'pointermove' } : event)
    : event.pointerType === 'mouse' ? middleClicks.update({
      type: event.type, pointerType: 'pen', pointerId: event.pointerId, buttons: event.buttons,
      clientX: event.clientX, clientY: event.clientY,
    }) : null;
  if (!action || (event.pointerType === 'mouse' && action !== 'redo')) return false;
  trace(`action ${action}`);
  finishGesture();
  if (action === 'zoom-next') {
    zoomNextTip = true;
    updateCursor();
  } else safely(action);
  return true;
}
function eventTool(event) {
  if (spaceDown || (event.buttons & 4)) return 'hand';
  if (event.pointerType === 'pen' && ((event.buttons & 34) || event.button === 5)) return 'eraser';
  if (event.pointerType === 'pen' && zoomNextTip) return 'zoom';
  if (event.pointerType === 'mouse' && tool === 'pen' && !mousePen) return 'select';
  return tool;
}
function capture(pointerId) { try { overlay.setPointerCapture(pointerId); } catch {} }
function pointOf(event) { return { ...world(event), p: event.pointerType === 'pen' ? Math.max(.01, Math.min(1, event.pressure)) : .5 }; }
function appendPoint(event, pressure) {
  const point = pointOf(event), previous = active.points.at(-1);
  if (pressure !== undefined) point.p = pressure;
  if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= .35 || Math.abs(point.p - previous.p) >= .03) {
    active.points.push(point);
    const extent = active.extent ??= { left: point.x, top: point.y, right: point.x, bottom: point.y };
    extent.left = Math.min(extent.left, point.x); extent.top = Math.min(extent.top, point.y);
    extent.right = Math.max(extent.right, point.x); extent.bottom = Math.max(extent.bottom, point.y);
    const radius = active.width / 2;
    active.bounds = { x: extent.left - radius, y: extent.top - radius, width: extent.right - extent.left + radius * 2, height: extent.bottom - extent.top + radius * 2 };
  }
}
function eraseAt(point) {
  const radius = 12;
  const touched = scroll.query({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 }).filter(stroke => strokeHitsPoint(stroke, point, radius));
  // A drag that starts on ink erases only ink, so wiping out a line inside a coloured area leaves the colour.
  // A drag that starts on a fill erases fills and whatever ink it crosses.
  const ink = touched.filter(stroke => !isFill(stroke));
  active.erases ??= touched.length ? (ink.length ? 'ink' : 'fill') : null;
  const hits = active.erases === 'ink' ? ink : touched;
  const diagram = !hits.length && gridMode() ? diagramHit(scroll.diagram.nodes, liveRoutes(), point) : null;
  const removed = diagram ? scroll.removeDiagramItem(diagram.node?.id ?? diagram.route.id) : scroll.remove(hits.map(stroke => stroke.id));
  if (removed) { active.changed = true; requestRender(); }
}
/** Ink and shape outlines on the visible page as a 1 = barrier bitmap, one pixel per CSS pixel. */
function rasterBarrier(w, h) {
  const canvas = new OffscreenCanvas(w, h), flat = canvas.getContext('2d', { willReadFrequently: true });
  const zoom = zoomLevel();
  flat.setTransform(zoom, 0, 0, zoom, -viewX() * zoom, -viewY() * zoom);
  for (const stroke of scroll.query({ x: viewX() - 50, y: viewY() - 50, width: viewWidth() + 100, height: viewHeight() + 100 })) if (!isFill(stroke)) drawStroke(flat, stroke, '#000');
  if (gridMode()) {
    flat.lineWidth = 3; flat.lineJoin = 'round'; flat.lineCap = 'round'; flat.strokeStyle = '#000';
    for (const node of scroll.diagram.nodes) { const { outline, detail } = shapePaths(node); flat.stroke(new Path2D(outline)); if (detail) flat.stroke(new Path2D(detail)); }
    for (const route of liveRoutes()) flat.stroke(new Path2D(connectorPath(route.points)));
  }
  const { data } = flat.getImageData(0, 0, w, h), barrier = new Uint8Array(w * h);
  for (let index = 0; index < barrier.length; index++) barrier[index] = data[index * 4 + 3] > 40 ? 1 : 0;
  return barrier;
}
const FILL_MESSAGES = { open: 'That area isn’t closed · close the outline or zoom out', blocked: 'Tap inside an outlined area, not on a line', tiny: 'That area is too small to fill' };
function fillAt(event) {
  const w = Math.round(width), h = Math.round(height);
  const result = fillRegion({ barrier: rasterBarrier(w, h), width: w, height: h, seedX: Math.floor(event.clientX), seedY: Math.floor(event.clientY) });
  if (result.status !== 'filled') return message(FILL_MESSAGES[result.status]);
  const zoom = zoomLevel(), left = viewX(), top = viewY();
  const fill = makeStroke(contoursToPoints(result.contours, corner => ({ x: corner.x / zoom + left, y: corner.y / zoom + top })), settings.color, 1, FILL_TYPE);
  // Filling an area that already has a fill of its own recolours it instead of stacking another.
  const point = world(event), outline = boundsOf([fill]);
  const same = scroll.query({ x: point.x - 1, y: point.y - 1, width: 2, height: 2 }).filter(stroke => {
    if (!isFill(stroke) || !strokeHitsPoint(stroke, point, 0)) return false;
    const old = boundsOf([stroke]);
    return [old.x - outline.x, old.y - outline.y, old.width - outline.width, old.height - outline.height].every(delta => Math.abs(delta) <= 4 / zoom);
  });
  scroll.beginGroup();
  if (same.length) scroll.remove(same.map(stroke => stroke.id));
  scroll.add([fill]);
  scroll.endGroup();
  changed(); message('Filled');
}
function startDiagramGesture(currentTool, event, point) {
  const pointerId = event.pointerId;
  if (currentTool === 'diagram') {
    const box = { ...drawShapeBox(point, point, false), kind: diagramShape(), color: settings.color };
    active = { kind: 'draw-node', pointerId, start: point, box };
    diagramSelection = null;
    return true;
  }
  if (currentTool !== 'select') return false;
  const hit = diagramHit(scroll.diagram.nodes, liveRoutes(), point, diagramSelection);
  diagramSelection = hit?.node?.id ?? hit?.route?.id ?? null;
  if (!hit) return false;
  selection.clear();
  if (hit.port !== undefined) active = { kind: 'connect', pointerId, node: hit.node, port: hit.port, current: point };
  else if (hit.corner !== undefined) active = { kind: 'resize-node', pointerId, ...hit, start: point, box: hit.node };
  else if (hit.node) active = { kind: 'move-node', pointerId, node: hit.node, start: point, box: hit.node };
  return true;
}
function updateDiagramGesture(event) {
  const point = world(event);
  if (active.kind === 'draw-node') Object.assign(active.box, drawShapeBox(active.start, point, event.shiftKey));
  else if (active.kind === 'connect') {
    active.current = point;
    const target = diagramHit(scroll.diagram.nodes, [], point)?.node;
    active.target = target?.id === active.node.id ? null : target;
  } else {
    const delta = { x: point.x - active.start.x, y: point.y - active.start.y };
    active.box = active.kind === 'move-node'
      ? { ...active.node, x: active.node.x + delta.x, y: active.node.y + delta.y }
      : resizeShapeBox(active.node, active.corner, active.opposite, delta, event.shiftKey);
  }
}
function pointerDown(event) {
  if (active) return;
  $('#context-menu').hidden = true;
  if (event.button === 2 && event.pointerType !== 'pen') return;
  const currentTool = eventTool(event);
  const barrelErase = currentTool === 'eraser' && barrelDelete(event);
  if (event.pointerType === 'pen') trace(`down tool=${currentTool} B=${event.buttons} tipStarted=${event.tipStarted} contact=${contact(event)}`);
  if (barrelErase ? !event.tipStarted : currentTool !== 'hand' && !contact(event)) return;
  if (currentTool === 'hand' && !spaceDown && tool !== 'hand' && placedHover(event)) return;
  if (event.tipStarted) zoomNextTip = false;
  event.preventDefault(); overlay.focus({ preventScroll: true });
  const point = world(event);
  if (gridMode() && startDiagramGesture(currentTool, event, point)) {
    captureGesture(event); updateControls(); requestRender(); return;
  }
  if (currentTool === 'hand') active = {
    kind: 'pan', pointerId: event.pointerId, x: event.clientX, y: event.clientY, initialX: viewX(), initialY: viewY(),
    temporary: tool !== 'hand', upper: Boolean(event.buttons & 4), moved: !(event.buttons & 4) || spaceDown,
  };
  else if (currentTool === 'eraser') { scroll.beginGroup(); active = { kind: barrelErase ? 'barrel-erase' : 'erase', pointerId: event.pointerId, changed: false, previous: point }; eraseAt(point); }
  else if (currentTool === 'zoom') active = { kind: 'zoom', pointerId: event.pointerId, x: event.clientX, y: event.clientY, startZoom: zoomLevel() };
  else if (currentTool === 'fill') { fillAt(event); return; }
  else if (currentTool === 'shape') active = { kind: 'shape', pointerId: event.pointerId, shape: shapeKind, start: point, current: point, color: settings.color, width: settings.width, penType: settings.penType || 'pen', constrain: event.shiftKey, preview: [] };
  else if (currentTool === 'select') {
    const box = boundsOf(selectedStrokes());
    const corner = box ? corners(box, 7).findIndex(p => Math.hypot(p.x - point.x, p.y - point.y) <= 9) : -1;
    if (corner >= 0 && box.width > 1 && box.height > 1) {
      const opposite = corners(box)[(corner + 2) % 4]; active = { kind: 'resize', pointerId: event.pointerId, box, opposite, start: point, transform: { scaleX: 1, scaleY: 1, originX: opposite.x, originY: opposite.y, dx: 0, dy: 0 } };
    } else if (box && inside(point, box, 7) && !event.shiftKey) active = { kind: 'move', pointerId: event.pointerId, start: point, dx: 0, dy: 0 };
    else {
      const touched = !event.shiftKey ? scroll.query({ x: point.x - 5, y: point.y - 5, width: 10, height: 10 }).filter(stroke => strokeHitsPoint(stroke, point, 5)) : [];
      const hit = touched.findLast(stroke => !isFill(stroke)) ?? touched.at(-1) ?? null;
      if (hit) {
        selection = new Set([hit.id]);
        active = { kind: 'move', pointerId: event.pointerId, start: point, dx: 0, dy: 0 };
      } else {
        active = { kind: 'marquee', pointerId: event.pointerId, start: point, current: point, previousSelection: event.shiftKey ? new Set(selection) : new Set() };
        if (!event.shiftKey) selection.clear();
      }
    }
  } else { selection.clear(); diagramSelection = null; active = { kind: 'ink', pointerId: event.pointerId, points: [], color: settings.color, width: settings.width, penType: settings.penType || 'pen' }; appendPoint(event); }
  captureGesture(event); updateCursor(); requestRender();
}
function captureGesture(event) {
  if (!active) return;
  active.nativePointerId = event.nativePointerId ?? event.pointerId;
  capture(active.nativePointerId);
}
// The display places the pen and the upper switch is held while the pen only hovers: that scrolls nothing (hold, then tap and drag).
const placedHover = event => event.placed && (event.buttons & 4) && !event.tipDown;
function pointerMove(event) {
  if (!active) {
    if (event.pointerType === 'pen' && (((event.buttons & 4) && !placedHover(event)) || event.tipStarted)) pointerDown(event);
    return;
  }
  if (event.pointerId !== active.pointerId) return;
  if (active.kind === 'pan' && active.upper && placedHover(event)) { finishGesture(); return; }
  event.preventDefault(); const currentTool = eventTool(event);
  if (active.kind === 'barrel-erase' && (!event.tipDown || !barrelDelete(event) || currentTool !== 'eraser')) { finishGesture(); return; }
  if (active.kind === 'pan' && active.temporary && currentTool !== 'hand') { finishGesture(); if (event.tipStarted) pointerDown(event); return; }
  if (event.pointerType === 'pen' && active.kind !== 'pan' && !contact(event)) { pointerUp(event); return; }
  if (event.pointerType === 'pen' && ['ink', 'erase', 'shape', 'draw-node'].includes(active.kind)) {
    const expected = currentTool === 'eraser' ? barrelDelete(event) ? 'barrel-erase' : 'erase'
      : currentTool === 'hand' ? 'pan' : currentTool === 'shape' ? 'shape' : currentTool === 'diagram' ? 'draw-node' : 'ink';
    if (expected !== active.kind) { finishGesture(); if (expected === 'pan' || event.tipStarted || currentTool === 'eraser' && !barrelDelete(event)) pointerDown(event); return; }
  }
  if (active.kind === 'ink') { const samples = event.getCoalescedEvents?.() || []; for (const sample of samples.length ? samples : [event]) if (contact(sample)) appendPoint(sample); }
  else if (active.kind === 'erase' || active.kind === 'barrel-erase') {
    const point = world(event), previous = active.previous, distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.min(1000, Math.max(1, Math.ceil(distance / 6)));
    for (let index = 1; index <= steps; index++) eraseAt({ x: previous.x + (point.x - previous.x) * index / steps, y: previous.y + (point.y - previous.y) * index / steps });
    active.previous = point;
  } else if (active.kind === 'shape') {
    active.current = world(event); active.constrain = event.shiftKey;
    active.preview = makeShape(active.shape, active.start, active.current, { color: active.color, width: active.width, penType: active.penType, constrain: active.constrain });
  } else if (active.kind === 'pan') updatePan(event);
  else if (active.kind === 'zoom') zoomAt(active.startZoom * Math.exp((active.y - event.clientY) * ZOOM_DRAG_RATE), active.x, active.y);
  else if (active.kind === 'move') { const point = world(event); active.dx = point.x - active.start.x; active.dy = point.y - active.start.y; }
  else if (active.kind === 'resize') {
    const point = world(event), opposite = active.opposite;
    let scaleX = Math.max(.05, (point.x - opposite.x) / (active.start.x - opposite.x)), scaleY = Math.max(.05, (point.y - opposite.y) / (active.start.y - opposite.y));
    if (event.shiftKey) scaleX = scaleY = Math.max(scaleX, scaleY);
    active.transform = { scaleX, scaleY, originX: opposite.x, originY: opposite.y, dx: 0, dy: 0 };
  } else if (active.kind === 'marquee') active.current = world(event);
  else updateDiagramGesture(event);
  requestRender(gridMode() || !['ink', 'marquee', 'shape'].includes(active.kind));
}
function updatePan(event) {
  const dx = active.x - event.clientX, dy = active.y - event.clientY;
  active.moved ||= Math.hypot(dx, dy) > PEN_CLICK_MOVEMENT;
  if (active.moved) {
    const sideways = gridMode() || zoomLevel() !== 1 || scrollX !== 0;
    setOffset(active.initialY + dy / zoomLevel(), false, sideways ? active.initialX + dx / zoomLevel() : 0);
  }
}
function finishGesture(cancel = false) {
  if (!active) return;
  const gesture = active; active = null; let modified = false;
  if (gesture.kind !== 'ink') trace(`end ${gesture.kind}${cancel ? ' cancelled' : ''}`);
  if (gesture.kind === 'ink' && gesture.points.length) modified = scroll.add([makeStroke(gesture.points, gesture.color, gesture.width, gesture.penType)]);
  else if (!cancel && gesture.kind === 'shape' && gesture.preview.length) modified = scroll.add(gesture.preview);
  else if (!cancel && gesture.kind === 'draw-node') {
    diagramSelection = scroll.addShape(gesture.box); tool = 'pen'; mousePen = false; modified = true;
  } else if (!cancel && ['move-node', 'resize-node'].includes(gesture.kind)) modified = scroll.updateShape(gesture.node.id, gesture.box);
  else if (!cancel && gesture.kind === 'connect' && gesture.target) modified = scroll.connectShapes(gesture.node.id, gesture.target.id, gesture.port);
  else if (gesture.kind === 'erase' || gesture.kind === 'barrel-erase') { scroll.endGroup(); modified = gesture.changed; }
  else if (!cancel && gesture.kind === 'move' && (Math.abs(gesture.dx) > .1 || Math.abs(gesture.dy) > .1)) modified = scroll.move([...selection], gesture.dx, gesture.dy);
  else if (!cancel && gesture.kind === 'resize') modified = scroll.transform([...selection], gesture.transform);
  else if (!cancel && gesture.kind === 'marquee') {
    const box = rectangle(gesture.start, gesture.current); selection = gesture.previousSelection;
    const hits = box.width < 3 && box.height < 3 ? scroll.query({ x: box.x - 5, y: box.y - 5, width: 10, height: 10 }).filter(stroke => strokeHitsPoint(stroke, gesture.current, 5)).sort((a, b) => isFill(b) - isFill(a)).slice(-1) : scroll.query(box).filter(stroke => strokeIntersectsRect(stroke, box));
    for (const stroke of hits) selection.add(stroke.id);
  } else if (gesture.kind === 'pan') modified = viewY() !== gesture.initialY || viewX() !== gesture.initialX;
  try { if (overlay.hasPointerCapture(gesture.nativePointerId)) overlay.releasePointerCapture(gesture.nativePointerId); } catch {}
  if (modified) changed(); updateControls(); requestRender();
}
function pointerUp(event) {
  if (active?.pointerId !== event.pointerId) return;
  if (active.kind === 'pan') {
    if (active.upper && (event.buttons & 4)) return;
    updatePan(event);
  } else if (event.pointerType === 'pen' && contact(event) && (active.kind !== 'barrel-erase' || barrelDelete(event))) return;
  else if (active.kind === 'ink') appendPoint(event, active.points.at(-1)?.p ?? .5);
  else if (active.kind === 'shape') {
    active.current = world(event); active.preview = makeShape(active.shape, active.start, active.current, { color: active.color, width: active.width, penType: active.penType, constrain: event.shiftKey });
  } else if (['draw-node', 'move-node', 'resize-node', 'connect'].includes(active.kind)) updateDiagramGesture(event);
  finishGesture();
}
// What the page receives from the pen and what the app does with it goes to pen.log, so a button that seems wrong can be read back.
const trace = text => bridge.penLog?.(text);
let lastMove = '', lastWheel = 0, wheelBurst = 0;
function traceEvent(raw) {
  const brief = `${raw.pointerType} B=${raw.buttons}`;
  if (raw.type === 'pointermove' || raw.type === 'pointerenter') { if (brief === lastMove) return; lastMove = brief; }
  trace(`dom ${raw.type} ${brief} btn=${raw.button} p=${Number(raw.pressure ?? 0).toFixed(2)} id=${raw.pointerId} @${Math.round(raw.clientX)},${Math.round(raw.clientY)}`);
}
function handlePointer(rawEvent) {
  if (!loaded || loadError || fileOperation || rawEvent.pointerType === 'touch') return;
  traceEvent(rawEvent);
  const event = penInput.update(rawEvent);
  // While the display places its pen (a side switch is held), the driver's version of the pen is kept track of and not acted on.
  if (penInput.placing && event !== rawEvent) return;
  route(event);
}
// The display's own report of its pen. The state is always kept; the buttons act only while this window has focus.
let placedTip = false;
function handleNativePen(state) {
  for (const event of penInput.native(state)) {
    const routed = (document.hasFocus() || testMode) && loaded && !loadError && !fileOperation;
    if (event.native) trace(`native ${event.type} ${event.button === 2 ? 'lower' : 'upper'} B=${event.buttons} placed=${penInput.placing} @${Math.round(event.clientX)},${Math.round(event.clientY)} focus=${document.hasFocus()} routed=${routed}`);
    else if (event.tipStarted || event.tipDown !== placedTip) trace(`placed tip=${event.tipDown} B=${event.buttons} @${Math.round(event.clientX)},${Math.round(event.clientY)} routed=${routed}`);
    if (event.placed) placedTip = event.tipDown;
    if (routed) route(event);
  }
}
bridge.onNativePen?.(handleNativePen);
function route(event) {
  if (lastPointerType !== event.pointerType) { lastPointerType = event.pointerType; updateCursor(); }
  if (penShortcut(event)) { event.preventDefault(); return; }
  if (event.native) {
    // A switch change reported by the display starts no drag: the pen's contact and movement do that.
    if (active?.kind === 'pan' && active.temporary && !(event.buttons & 4)) finishGesture();
    // Letting go of the delete button ends its erasing; a switch pressed during a stroke ends that stroke where it is.
    else if (active?.kind === 'barrel-erase' && !(event.buttons & 2)) finishGesture();
    // The display starts placing the pen: whatever the driver began for this switch (a stroke, a scroll from the pointer it froze) ends.
    else if (event.type === 'pointerdown' && penInput.placing && active) finishGesture();
    updateCursor();
    return;
  }
  if (event.pointerType === 'pen' && event.button === 2) event.preventDefault();
  if (event.type === 'pointerdown') pointerDown(event);
  else if (event.type === 'pointermove') pointerMove(event);
  else if (event.type === 'pointerup') pointerUp(event);
}
for (const type of ['pointerenter', 'pointerdown', 'pointermove', 'pointerup']) overlay.addEventListener(type, handlePointer);
function resetShortcuts() {
  penInput.reset(); penShortcuts.reset(); middleClicks.reset(); zoomNextTip = false; lastPointerType = null;
}
overlay.addEventListener('contextmenu', () => trace('dom contextmenu'));
overlay.addEventListener('pointercancel', event => {
  trace(`dom pointercancel ${event.pointerType} id=${event.pointerId}`);
  // Only the pointer being dragged can abort its drag. A pen hovering near the display or a resting palm must not snap the work back.
  if (event.pointerType === 'touch' || (active && event.pointerId !== active.nativePointerId)) return;
  resetShortcuts(); finishGesture(true); updateCursor();
});
overlay.addEventListener('lostpointercapture', event => {
  if (active?.nativePointerId === event.pointerId) finishGesture(true);
});
overlay.addEventListener('wheel', event => {
  event.preventDefault();
  {
    const at = performance.now();
    if (at - lastWheel > 500) { if (wheelBurst) trace(`dom wheel x${wheelBurst}`); wheelBurst = 0; trace(`dom wheel dy=${Math.round(event.deltaY)} dx=${Math.round(event.deltaX)} mode=${event.deltaMode} upperHeld=${penInput.upperHeld} active=${active?.kind ?? 'none'}`); }
    wheelBurst++; lastWheel = at;
  }
  // While the display places its pen, holding the upper button scrolls by the pen's own movement: the driver's scrolling
  // for that button is not a second scroll and does not spoil a tap.
  if (penInput.placing) return;
  // The driver scrolling while the upper button is down is not a tap of it.
  if (penInput.upperHeld) penShortcuts.cancel();
  if (active || fileOperation || !loaded || loadError) return;
  const multiplier = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? height : 1;
  if (event.ctrlKey || event.metaKey) { zoomAt(zoomLevel() * Math.exp(-event.deltaY * multiplier * .003), event.clientX, event.clientY); return; }
  const canPanX = gridMode() || zoomLevel() !== 1 || scrollX !== 0;
  const sideways = canPanX && event.shiftKey && !event.deltaX;
  const distance = multiplier / zoomLevel();
  setOffset(viewY() + (sideways ? 0 : event.deltaY * distance), true, viewX() + (canPanX ? (sideways ? event.deltaY : event.deltaX) * distance : 0));
}, { passive: false });
window.addEventListener('blur', () => { finishGesture(); resetShortcuts(); spaceDown = false; updateCursor(); }); window.addEventListener('resize', resize);

async function copySelection(cut = false) {
  finishGesture(); const strokes = selectedStrokes(); if (!strokes.length) return;
  const origin = scroll, ids = strokes.map(stroke => stroke.id);
  const text = JSON.stringify({ type: 'scrollmind/strokes', version: 1, strokes });
  await bridge.writeClipboard(text); clipboardSource = text; pasteCount = 0;
  if (cut && scroll === origin && scroll.remove(ids)) { for (const id of ids) selection.delete(id); changed(); }
}
async function pasteSelection() {
  finishGesture(); const text = await bridge.readClipboard(); let data;
  try { data = JSON.parse(text); if (data.type !== 'scrollmind/strokes' || data.version !== 1) return message('Copy some strokes to paste here'); data.strokes = validateStrokes(data.strokes); }
  catch { return message('Copy some strokes to paste here'); }
  if (!data.strokes.length) return;
  if (clipboardSource !== text) { clipboardSource = text; pasteCount = 0; } pasteCount++;
  const bounds = boundsOf(data.strokes); let dx = pasteCount * 24, dy = pasteCount * 24;
  if (bounds.y + dy + bounds.height < viewY() + 80 || bounds.y + dy > viewY() + viewHeight() - 50) dy = viewY() + viewHeight() / 2 - bounds.y - bounds.height / 2;
  if (bounds.x + dx > viewX() + viewWidth() - 50 || bounds.x + dx + bounds.width < viewX()) dx = viewX() + viewWidth() / 2 - bounds.x - bounds.width / 2;
  const strokes = data.strokes.map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) }));
  scroll.add(strokes); diagramSelection = null; selection = new Set(strokes.map(stroke => stroke.id)); tool = 'select'; changed();
}
function deleteSelection() {
  finishGesture();
  const removed = diagramSelection ? scroll.removeDiagramItem(diagramSelection) : scroll.remove([...selection]);
  if (removed) { selection.clear(); diagramSelection = null; changed(); }
}
function duplicateSelection() {
  finishGesture(); const copies = selectedStrokes().map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(point => ({ ...point, x: point.x + 24, y: point.y + 24 })) }));
  if (copies.length) { scroll.add(copies); selection = new Set(copies.map(stroke => stroke.id)); changed(); }
}
async function command(value, detail) {
  if (!loaded || loadError || fileOperation) return;
  if (value === 'view-scroll' || value === 'view-grid') {
    const kind = value.slice(5);
    if (kind !== workspace.kind) return scrollFileCommand('switch-workspace', kind);
    return;
  }
  if (['open-sm', 'new-scroll', 'select-scroll', 'close-scroll', 'delete-scroll', 'rename-scroll', 'clear-scroll'].includes(value) || value.startsWith('export-')) return scrollFileCommand(value, detail);
  if (value.startsWith('tool-')) return setTool(value.slice(5));
  if (['zoom-in', 'zoom-out', 'zoom-reset'].includes(value)) {
    finishGesture();
    zoomAt(value === 'zoom-reset' ? 1 : zoomLevel() * (value === 'zoom-in' ? 1.25 : .8));
    return;
  }
  if (value === 'undo' || value === 'redo') { finishGesture(); if (scroll[value]()) { changed(); renderMarkers(); } }
  else if (['copy', 'cut', 'paste'].includes(value)) {
    const task = clipboardQueue.then(() => value === 'paste' ? pasteSelection() : copySelection(value === 'cut'));
    clipboardQueue = task.catch(() => {});
    await task;
  }
  else if (value === 'duplicate') duplicateSelection(); else if (value === 'delete') deleteSelection();
  else if (value === 'select-all') { finishGesture(); tool = 'select'; diagramSelection = null; selection = new Set(scroll.strokes.map(stroke => stroke.id)); updateControls(); requestRender(); }
  else if (value === 'home') {
    finishGesture();
    const start = gridMode() ? gridStart() : { x: 0, y: 0 };
    setOffset(start.y, true, start.x);
  } else if (value === 'fullscreen') await bridge.toggleFullscreen();
  else if (value === 'help') { finishGesture(); $('#help').showModal(); }
  else if (value === 'toggle-toolbar') penControls.toggleVisibility();
  else if (value === 'toggle-sidebar') toggleSidebar(); else if (value.startsWith('add-')) addMarker(value.slice(4));
}
function cacheScrollSession() {
  if (workspace.activeId) scrollSessions.set(sessionKey(), {
    scroll, settings: { ...settings }, view: savedView(), tool, mousePen, diagramSelection,
    selection: new Set(selection), brushStyles: structuredClone(brushStyles),
  });
}
function restoreView(view = {}) {
  offsetY = view.offsetY ?? 0; scrollX = view.scrollX ?? 0;
  // Older saves omitted zero coordinates even when they had a saved pan or zoom.
  const positioned = view.gridX !== undefined || view.gridY !== undefined || (view.gridZoom ?? 1) !== 1;
  gridX = positioned ? view.gridX ?? 0 : undefined;
  gridY = positioned ? view.gridY ?? 0 : undefined;
  scrollZoom = view.scrollZoom ?? 1; gridZoom = view.gridZoom ?? 1;
}
function activateScroll(result) {
  const cached = scrollSessions.get(sessionKey(result.workspace));
  workspace = result.workspace;
  if (cached) {
    scroll = cached.scroll; settings = { ...cached.settings }; restoreView(cached.view);
    tool = cached.tool; mousePen = cached.mousePen; diagramSelection = cached.diagramSelection;
    selection = new Set(cached.selection); brushStyles = structuredClone(cached.brushStyles || { ink: null, highlighter: null });
  } else {
    const document = result.document;
    brushStyles = { ink: null, highlighter: null };
    scroll = new Scroll(document || {});
    const defaults = scroll.snapshot().settings;
    settings = { ...defaults, ...document?.settings };
    if (gridMode()) {
      settings.mode = 'grid';
      settings.grid ??= { ...DEFAULT_GRID };
    }
    restoreView(document?.view);
    selection.clear(); diagramSelection = null; tool = 'pen'; mousePen = false;
  }
  active = null; spaceDown = false; resetShortcuts();
  revision = savedRevision = 0;
  pasteCount = 0;
  updateControls(); renderScrolls(); renderMarkers(); requestRender();
}
async function scrollFileCommand(value, detail) {
  if (fileOperation) return fileOperation;
  if (value === 'select-scroll' && detail === workspace.activeId) return;
  finishGesture();
  resetShortcuts();
  document.body.inert = true;
  fileOperation = (async () => {
    await clipboardQueue;
    await flushSave();
    cacheScrollSession();
    if (value === 'switch-workspace') {
      activateScroll(await bridge.switchWorkspace(detail));
      message('Saved');
    } else if (value === 'open-sm') {
      const result = await bridge.openDocument();
      if (result.canceled) return;
      activateScroll(result);
      message(documentTitle() + ' opened · saved locally');
    } else if (value === 'clear-scroll') {
      if (scroll.clear()) {
        selection.clear(); diagramSelection = null; changed(); renderMarkers();
        await flushSave();
        message(documentTitle() + ' cleared · Undo restores it');
      }
    } else if (value === 'new-scroll') {
      activateScroll(await bridge.newScroll({ settings }));
      message('New ' + documentTitle().toLowerCase() + ' · saved locally');
    } else if (value === 'select-scroll') {
      activateScroll(await bridge.selectScroll(detail));
      message('Saved');
    } else if (value === 'close-scroll') {
      activateScroll(await bridge.closeScroll(detail || workspace.activeId));
      message(documentTitle() + ' closed · saved locally');
    } else if (value === 'delete-scroll') {
      const id = detail || workspace.activeId;
      const result = await bridge.deleteScroll(id);
      scrollSessions.delete(sessionKey(workspace, id));
      activateScroll(result);
      message(documentTitle() + ' deleted · recoverable copy saved');
    } else if (value === 'rename-scroll') {
      const result = await bridge.renameScroll(detail.id, detail.name);
      workspace = result.workspace; renderScrolls();
    } else {
      const format = value.slice(7);
      const result = await bridge.exportDocument(format, { width, height });
      if (!result.canceled) message(`${format === 'sm' ? documentTitle() : format.toUpperCase()} export saved`);
    }
  })();
  try { return await fileOperation; }
  finally { fileOperation = null; document.body.inert = false; overlay.focus({ preventScroll: true }); }
}
function safely(value, detail) { Promise.resolve(command(value, detail)).catch(error => message(error.message, true)); }
document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => {
  finishGesture(); settings.color = button.dataset.color;
  if (!['shape', 'diagram'].includes(tool)) setTool('pen', mousePen);
  changed();
}));
document.querySelectorAll('[data-width]').forEach(button => button.addEventListener('click', () => { finishGesture(); settings.width = Number(button.dataset.width); changed(); }));
for (const name of ['undo', 'redo', 'home', 'fullscreen', 'zoom-in', 'zoom-out', 'zoom-reset']) $(`#${name}`).addEventListener('click', () => safely(name));
for (const name of ['open-sm', 'new-scroll', 'clear-scroll', 'export-sm', 'export-svg', 'export-pdf']) $(`#${name}`).addEventListener('click', () => safely(name));
$('#pen-type').addEventListener('change', event => {
  finishGesture();
  const next = event.target.value, wasHighlighter = settings.penType === 'highlighter';
  if (wasHighlighter !== (next === 'highlighter')) {
    brushStyles[wasHighlighter ? 'highlighter' : 'ink'] = { color: settings.color, width: settings.width };
    Object.assign(settings, next === 'highlighter' ? brushStyles.highlighter || { color: '#e2b52b', width: 12 } : brushStyles.ink || { color: '#171717', width: 3 });
  }
  settings.penType = next; if (!['shape', 'diagram'].includes(tool)) setTool('pen', mousePen); changed(); event.target.blur(); overlay.focus({ preventScroll: true });
});
$('#shape-select').addEventListener('change', event => { if (!event.target.value) return; shapeKind = event.target.value; setTool('shape'); event.target.blur(); overlay.focus({ preventScroll: true }); });
$('#diagram-shape').addEventListener('click', () => { setTool('diagram'); overlay.focus({ preventScroll: true }); });
$('#diagram-shape-select').addEventListener('change', event => {
  const kind = event.target.value;
  if (!Object.hasOwn(DIAGRAM_SHAPES, kind)) return;
  settings.grid = { ...gridSettings(), shape: kind };
  event.target.value = ''; setTool('diagram'); changed(); overlay.focus({ preventScroll: true });
});
$('#controls-link').addEventListener('click', () => safely('help')); $('#help-close').addEventListener('click', () => $('#help').close());
$('#context-menu').addEventListener('click', event => { const button = event.target.closest('[data-command]'); if (button) { safely(button.dataset.command); $('#context-menu').hidden = true; } });
overlay.addEventListener('contextmenu', event => {
  event.preventDefault(); if (!loaded || event.pointerType === 'pen' || penInput.isNear(event)) return; finishGesture(); const menu = $('#context-menu'); menu.hidden = false;
  menu.style.left = `${Math.min(width - 206, event.clientX)}px`; menu.style.top = `${Math.min(height - 213, event.clientY)}px`;
  for (const button of menu.querySelectorAll('button')) {
    const command = button.dataset.command;
    button.disabled = command !== 'paste' && !(selection.size || command === 'delete' && diagramSelection);
  }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('#context-menu')) $('#context-menu').hidden = true; });
function isTextInput(target) { return target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable=true]')); }
document.addEventListener('keydown', event => {
  if (fileOperation) return;
  if (event.key === 'Tab' && document.activeElement.closest?.('#pen-controls')) return;
  if (isTextInput(event.target) || $('#help').open) return;
  const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase(); let action;
  if (mod) {
    if (key === 'z') action = event.shiftKey ? 'redo' : 'undo'; else if (key === 'y') action = 'redo';
    else if (key === 'c') action = 'copy'; else if (key === 'x') action = 'cut'; else if (key === 'v') action = 'paste'; else if (key === 'a') action = 'select-all'; else if (key === 'd') action = 'duplicate';
    else if (key === '0') action = 'home'; else if (key === '/') action = 'toggle-sidebar'; else if (key === 'f' && event.shiftKey) action = 'fullscreen';
    else if (key === 'm' && event.shiftKey) action = 'add-marker'; else if (key === 'enter') action = 'add-page-break';
    else if (key === 'o') action = 'open-sm';
    else if (key === 'n') action = 'new-scroll';
    else if (key === 'p') action = 'export-pdf';
    else if (key === 's' && event.shiftKey) action = 'export-sm';
    else if (key === '+' || key === '=') action = 'zoom-in';
    else if (key === '-') action = 'zoom-out';
    else if (key === 's') { event.preventDefault(); flushSave().catch(() => {}); return; }
  } else {
    if (key === 'b') action = 'tool-pen'; else if (key === 'e') action = 'tool-eraser'; else if (key === 'f') action = 'tool-fill'; else if (key === 'v') action = 'tool-select'; else if (key === 'h') action = 'tool-hand';
    else if (key === 'delete' || key === 'backspace') action = 'delete'; else if (key === 'tab') action = 'toggle-toolbar'; else if (key === '?' || key === 'f1') action = 'help'; else if (key === 'f11') action = 'fullscreen'; else if (key === 'home') action = 'home';
    else if (key === ' ') { event.preventDefault(); if (!event.repeat) { finishGesture(); spaceDown = true; updateCursor(); } return; }
    else if (key === 'escape') {
      event.preventDefault(); if (active) finishGesture(true); else if (zoomNextTip) { zoomNextTip = false; updateCursor(); } else if (!$('#context-menu').hidden) $('#context-menu').hidden = true;
      else if (selection.size || diagramSelection) { selection.clear(); diagramSelection = null; updateControls(); requestRender(); } else if (!$('#sidebar').hidden) toggleSidebar(false); else bridge.leaveFullscreen(); return;
    } else if (key.startsWith('arrow')) {
      event.preventDefault(); finishGesture(); const amount = event.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -1 : key === 'arrowright' ? 1 : 0, dy = key === 'arrowup' ? -1 : key === 'arrowdown' ? 1 : 0;
      const node = scroll.diagram.nodes.find(node => node.id === diagramSelection);
      if (node) { if (scroll.updateShape(node.id, { ...node, x: node.x + dx * amount, y: node.y + dy * amount })) changed(); }
      else if (selection.size) { if (scroll.move([...selection], dx * amount, dy * amount)) changed(); }
      else if (dy || (gridMode() || scrollZoom !== 1 || scrollX) && dx) {
        setOffset(viewY() + dy * (event.shiftKey ? viewHeight() * .8 : 48 / zoomLevel()), true,
          viewX() + dx * (event.shiftKey ? viewWidth() * .8 : 48 / zoomLevel()));
      }
      return;
    } else if (key === 'pagedown' || key === 'pageup') { event.preventDefault(); finishGesture(); setOffset(viewY() + (key === 'pageup' ? -1 : 1) * viewHeight() * .8); return; }
  }
  if (action) { event.preventDefault(); safely(action); }
});
document.addEventListener('keyup', event => { if (event.code === 'Space') { if (active?.kind === 'pan') finishGesture(); spaceDown = false; updateCursor(); } });
function toggleSidebar(show = $('#sidebar').hidden) {
  finishGesture(); $('#sidebar').hidden = !show; $('#sidebar-toggle').setAttribute('aria-expanded', String(show)); $('#sidebar-toggle').setAttribute('aria-label', show ? 'Close sidebar' : 'Open sidebar');
  document.body.classList.toggle('sidebar-open', show); if (!show) overlay.focus({ preventScroll: true });
}
$('#sidebar-toggle').addEventListener('click', () => toggleSidebar()); $('#sidebar-close').addEventListener('click', () => toggleSidebar(false)); $('#start-link').addEventListener('click', () => safely('home'));
for (const kind of ['scroll', 'grid']) $('#' + kind + '-mode').addEventListener('click', () => safely('view-' + kind));
for (const input of gridInputs) input.addEventListener('change', () => {
  const value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > GRID_LIMIT) {
    input.value = gridSettings()[input.dataset.gridSize];
    return;
  }
  settings.grid = { ...gridSettings(), [input.dataset.gridSize]: value };
  changed();
});
function markerLabel(kind) { return kind === 'section' ? 'Section' : kind === 'page-break' ? 'Page break' : 'Marker'; }
function addMarker(kind) {
  if (!loaded || loadError || fileOperation || gridMode() || !['section', 'marker', 'page-break'].includes(kind)) return; finishGesture(); const count = scroll.markers.filter(marker => marker.kind === kind).length + 1;
  scroll.addMarker({ id: crypto.randomUUID(), kind, y: offsetY + viewHeight() / 2, label: `${markerLabel(kind)} ${count}` }); changed(); renderMarkers();
}
for (const kind of ['section', 'marker', 'page-break']) $(`#add-${kind}`).addEventListener('click', () => addMarker(kind));
function renderMarkers() {
  const list = $('#markers'); list.replaceChildren(); const markers = [...scroll.markers].sort((a, b) => a.y - b.y);
  $('#markers-empty').hidden = markers.length > 0; $('#marker-count').textContent = markers.length;
  for (const marker of markers) {
    const row = document.createElement('div'); row.className = 'marker-row'; row.dataset.kind = marker.kind;
    const go = document.createElement('button'); go.className = 'marker-go'; go.textContent = marker.kind === 'section' ? '§' : marker.kind === 'page-break' ? '↵' : '◇'; go.title = `Go to ${marker.label}`; go.setAttribute('aria-label', `Go to ${marker.label}`);
    go.addEventListener('click', () => { finishGesture(); setOffset(marker.y - 130 / zoomLevel()); });
    const label = document.createElement('input'); label.value = marker.label; label.maxLength = 200; label.setAttribute('aria-label', `${markerLabel(marker.kind)} name`);
    label.addEventListener('change', () => { const value = label.value.trim() || markerLabel(marker.kind); label.value = value; if (scroll.updateMarker(marker.id, { label: value })) { changed(); renderMarkers(); } });
    label.addEventListener('keydown', event => { if (event.key === 'Enter') { label.blur(); overlay.focus(); } });
    const remove = document.createElement('button'); remove.className = 'marker-remove'; remove.textContent = '×'; remove.title = `Remove ${marker.label}`; remove.setAttribute('aria-label', `Remove ${marker.label}`);
    remove.addEventListener('click', () => { if (scroll.removeMarker(marker.id)) { changed(); renderMarkers(); } }); row.append(go, label, remove); list.append(row);
  }
}
function renderScrolls() {
  const list = $('#scroll-list'), closedList = $('#closed-scroll-list');
  list.replaceChildren(); closedList.replaceChildren();
  for (const item of workspace.scrolls) {
    if (!item.open) {
      const reopen = document.createElement('button'); reopen.className = 'scroll-reopen'; reopen.dataset.scrollId = item.id; reopen.textContent = item.name;
      reopen.addEventListener('click', () => safely('select-scroll', item.id)); closedList.append(reopen); continue;
    }
    const row = document.createElement('div'); row.className = 'scroll-row'; row.dataset.scrollId = item.id;
    const go = document.createElement('button'); go.className = 'scroll-go'; go.textContent = item.name; go.title = `Switch to ${item.name}`;
    if (item.id === workspace.activeId) go.setAttribute('aria-current', 'page');
    go.addEventListener('click', () => safely('select-scroll', item.id));
    const name = document.createElement('input'); name.className = 'scroll-name'; name.hidden = true; name.value = item.name; name.maxLength = 80; name.setAttribute('aria-label', documentTitle() + ' name');
    const rename = document.createElement('button'); rename.className = 'scroll-rename'; rename.textContent = '✎'; rename.title = `Rename ${item.name}`; rename.setAttribute('aria-label', `Rename ${item.name}`);
    const editName = () => { name.hidden = false; go.hidden = true; name.focus(); name.select(); };
    rename.addEventListener('click', editName); go.addEventListener('dblclick', editName);
    name.addEventListener('change', () => { const text = name.value.trim() || item.name; safely('rename-scroll', { id: item.id, name: text }); });
    name.addEventListener('blur', () => { name.hidden = true; go.hidden = false; });
    name.addEventListener('keydown', event => { if (event.key === 'Enter') name.blur(); else if (event.key === 'Escape') { name.value = item.name; name.blur(); } });
    const close = document.createElement('button'); close.className = 'scroll-close'; close.textContent = '×'; close.title = `Close ${item.name}`; close.setAttribute('aria-label', `Close ${item.name}`);
    close.addEventListener('click', () => safely('close-scroll', item.id));
    const remove = document.createElement('button'); remove.className = 'scroll-delete'; remove.title = `Delete ${item.name}`; remove.setAttribute('aria-label', `Delete ${item.name}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>';
    remove.addEventListener('click', () => safely('delete-scroll', item.id));
    row.append(go, name, rename, close, remove); list.append(row);
  }
  $('#closed-scrolls').hidden = !closedList.childElementCount;
}
$('#paper-tone').addEventListener('change', event => {
  finishGesture();
  if (gridMode()) settings.grid = { ...gridSettings(), paperTone: event.target.value };
  else settings.paperTone = event.target.value;
  changed();
});
$('#paper-pattern').addEventListener('change', event => { finishGesture(); settings.paper = event.target.value; changed(); });
$('#display-select').addEventListener('change', async event => { try { finishGesture(); await bridge.moveToDisplay(event.target.value); } catch (error) { message(error.message, true); } });
$('#data-folder').addEventListener('click', () => bridge.openDataFolder().catch(error => message(error.message, true)));
status.addEventListener('click', () => { if (status.classList.contains('error')) bridge.openDataFolder(); });
bridge.onCommand(value => {
  if (value === 'open-sm') {
    nativeFileQueue = nativeFileQueue.then(async () => { await initialization; await fileOperation?.catch(() => {}); return command(value); }).catch(error => message(error.message, true));
  } else initialization.then(() => safely(value));
});
$('#save-alert').addEventListener('click', () => toggleSidebar(true));
bridge.onBeforeClose(async () => { try { await initialization; await fileOperation?.catch(() => {}); await clipboardQueue; if (!loadError) { finishGesture(); await flushSave(); } await bridge.readyToClose(); } catch (error) { await bridge.readyToClose({ error: error.message }); } });
window.addEventListener('pagehide', () => { finishGesture(); flushSave().catch(() => {}); }); window.addEventListener('error', event => message(event.message || 'Something needs attention', true));
async function initialize() {
  try {
    const [result, info, displays] = await Promise.all([bridge.load(), bridge.getAppInfo(), bridge.getDisplays()]);
    if (result.error && !result.document) throw new Error(result.error);
    activateScroll(result);
    $('#version').textContent = `ScrollMind ${info.version}`;
    for (const display of displays) { const option = document.createElement('option'); option.value = display.id; option.textContent = display.label; option.selected = display.selected; $('#display-select').append(option); }
    loaded = true;
    testMode = Boolean(info.testMode);
    if (info.testMode) window.scrollmindDebug = Object.freeze({ getSnapshot: snapshot, getSelection: () => [...selection], getOffsetY: () => offsetY, getNativeButtons: () => penInput.hid, nativePen: handleNativePen, setOffsetY: value => setOffset(value), getWorkspace: () => workspace });
    message(result.recovered ? 'Recovered from backup · saved locally' : 'Saved'); if (!result.document) changed(); updateControls(); renderScrolls(); renderMarkers(); resize();
  } catch (error) { loadError = error.message; message('Couldn’t open the document · click to open folder', true); console.error(error); }
}
resize(); const initialization = initialize(); await initialization;
