import { Notebook, boundsOf, makeStroke, strokeHitsPoint, strokeIntersectsRect, validateStrokes } from '../core/model.mjs';

const $ = selector => document.querySelector(selector);
const bridge = window.scrollmind;
const canvas = $('#canvas'), overlay = $('#overlay');
const ctx = canvas.getContext('2d', { alpha: false }), ink = overlay.getContext('2d');
const status = $('#status');
let notebook = new Notebook();
let settings = { color: '#243746', width: 3, paper: 'plain', paperTone: 'ivory' };
let offsetY = 0, tool = 'pen', selection = new Set(), active = null;
let spaceDown = false, loaded = false, loadError = null;
let width = innerWidth, height = innerHeight, ratio = devicePixelRatio || 1;
let revision = 0, savedRevision = 0, saveTimer, savePromise, frame, baseDirty = true;
let pasteCount = 0, clipboardSource = '';
const tones = {
  ivory: { background: '#faf8f2', line: '#c5c6bc', marker: '#71879a' },
  parchment: { background: '#eee0bf', line: '#b5a47d', marker: '#8a7759' },
  white: { background: '#ffffff', line: '#c4cdd5', marker: '#71879a' },
  night: { background: '#172c40', line: '#47637b', marker: '#89a9c5' },
};
function snapshot() { return notebook.snapshot({ offsetY }, settings); }
function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
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
    while (savedRevision < revision) { const writingRevision = revision; await bridge.save(snapshot()); savedRevision = writingRevision; }
    message('Saved');
  })();
  try { await savePromise; }
  catch (error) { message('Couldn’t save · open writing folder', true); throw error; }
  finally { savePromise = null; }
}
function selectedStrokes() { return [...selection].map(id => notebook.get(id)).filter(Boolean); }
function updateControls() {
  selection = new Set([...selection].filter(id => notebook.get(id)));
  $('#undo').disabled = !notebook.canUndo; $('#redo').disabled = !notebook.canRedo;
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
  document.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === settings.color)));
  document.querySelectorAll('[data-width]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.width) === settings.width)));
  $('#selection-hint').textContent = selection.size ? `${selection.size} stroke${selection.size === 1 ? '' : 's'} · drag to move` : '';
  $('#paper-tone').value = settings.paperTone; $('#paper-pattern').value = settings.paper;
  document.body.classList.toggle('night', settings.paperTone === 'night'); updateCursor();
}
function setTool(value) { finishGesture(); tool = value; if (tool !== 'select') selection.clear(); updateControls(); requestRender(); }
function updateCursor() { overlay.style.cursor = spaceDown || tool === 'hand' ? (active ? 'grabbing' : 'grab') : tool === 'select' ? 'default' : 'crosshair'; }
function setOffset(value, persist = true) {
  if (!Number.isFinite(value)) return;
  offsetY = Math.max(-10_000_000, Math.min(10_000_000, value));
  if (persist) changed(); else requestRender();
}
function resize() {
  width = innerWidth; height = innerHeight; ratio = devicePixelRatio || 1;
  for (const target of [canvas, overlay]) { target.width = Math.round(width * ratio); target.height = Math.round(height * ratio); }
  requestRender();
}
function requestRender(redrawBase = true) { baseDirty ||= redrawBase; if (!frame) frame = requestAnimationFrame(render); }
let parchmentTexture;
function paperTexture() {
  if (parchmentTexture) return parchmentTexture;
  const tile = document.createElement('canvas'); tile.width = tile.height = 128;
  const paint = tile.getContext('2d'); let seed = 73;
  for (let index = 0; index < 1800; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const x = seed % 128;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    paint.fillStyle = index % 2 ? '#77562709' : '#fff8e327'; paint.fillRect(x, seed % 128, 1, 1);
  }
  parchmentTexture = ctx.createPattern(tile, 'repeat'); return parchmentTexture;
}
function drawPaper() {
  const tone = tones[settings.paperTone] || tones.ivory;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.fillStyle = tone.background; ctx.fillRect(0, 0, width, height);
  if (settings.paperTone === 'parchment') { ctx.save(); ctx.translate(0, -offsetY % 128); ctx.fillStyle = paperTexture(); ctx.fillRect(0, -128, width, height + 256); ctx.restore(); }
  ctx.strokeStyle = tone.line; ctx.fillStyle = tone.line; ctx.lineWidth = .65; ctx.globalAlpha = .42;
  const gap = settings.paper === 'ruled' ? 32 : 24, first = Math.floor(offsetY / gap) * gap - offsetY;
  if (settings.paper === 'dots') {
    ctx.globalAlpha = .7; ctx.beginPath();
    for (let y = first; y < height; y += gap) for (let x = 16; x < width; x += gap) { ctx.moveTo(x + .7, y); ctx.arc(x, y, .7, 0, Math.PI * 2); }
    ctx.fill();
  } else if (settings.paper === 'ruled' || settings.paper === 'grid') {
    ctx.beginPath(); for (let y = first; y < height; y += gap) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    if (settings.paper === 'grid') for (let x = 16; x < width; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.setTransform(ratio, 0, 0, ratio, 0, -offsetY * ratio);
  for (const marker of notebook.markers) {
    if (marker.y < offsetY - 30 || marker.y > offsetY + height + 30) continue;
    ctx.save(); ctx.strokeStyle = tone.marker; ctx.fillStyle = tone.marker; ctx.lineWidth = 1;
    if (marker.kind === 'marker') {
      ctx.globalAlpha = .65; ctx.beginPath(); ctx.moveTo(width - 18, marker.y - 9); ctx.lineTo(width - 8, marker.y - 9); ctx.lineTo(width - 8, marker.y + 8); ctx.lineTo(width - 13, marker.y + 3); ctx.lineTo(width - 18, marker.y + 8); ctx.closePath(); ctx.fill();
    } else {
      ctx.globalAlpha = .48; if (marker.kind === 'page-break') ctx.setLineDash([5, 7]);
      ctx.beginPath(); ctx.moveTo(30, marker.y); ctx.lineTo(width - 30, marker.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = marker.kind === 'section' ? '500 13px -apple-system, sans-serif' : '10px -apple-system, sans-serif';
      const textWidth = ctx.measureText(marker.label).width;
      ctx.globalAlpha = 1; ctx.fillStyle = tone.background; ctx.fillRect(44, marker.y - 10, textWidth + 18, 20);
      ctx.fillStyle = tone.marker; ctx.fillText(marker.label, 53, marker.y + 4);
    }
    ctx.restore();
  }
}
function displayColor(color) {
  if (settings.paperTone !== 'night') return color;
  return ({ '#243746': '#e5eaf1', '#242a35': '#e5eaf1', '#215b9c': '#7db3ee', '#b94d49': '#ed9690', '#397762': '#8bc7a9' })[color] || color;
}
function transformStroke(stroke, t) {
  return { ...stroke, width: Math.max(.01, Math.min(1000, stroke.width * Math.sqrt(Math.abs(t.scaleX * t.scaleY)))), points: stroke.points.map(point => ({ ...point, x: t.originX + (point.x - t.originX) * t.scaleX + t.dx, y: t.originY + (point.y - t.originY) * t.scaleY + t.dy })) };
}
function drawStroke(paint, stroke) {
  const points = stroke.points; if (!points.length) return;
  paint.save();
  paint.strokeStyle = displayColor(stroke.color); paint.fillStyle = displayColor(stroke.color); paint.lineCap = 'round'; paint.lineJoin = 'round';
  const size = p => Math.max(.35, stroke.width * (.3 + (p ?? .5) * 1.25));
  if (points.length === 1) { paint.beginPath(); paint.arc(points[0].x, points[0].y, size(points[0].p) / 2, 0, Math.PI * 2); paint.fill(); }
  else {
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1], current = points[index];
      paint.lineWidth = size((previous.p + current.p) / 2); paint.beginPath(); paint.moveTo(previous.x, previous.y); paint.lineTo(current.x, current.y); paint.stroke();
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
  if (baseDirty) {
    baseDirty = false; drawPaper();
    for (const stroke of notebook.query({ x: -100, y: offsetY - 100, width: width + 200, height: height + 200 })) if (!(transform && selection.has(stroke.id))) drawStroke(ctx, stroke);
    if (preview) for (const stroke of preview) drawStroke(ctx, stroke);
  }
  ink.setTransform(1, 0, 0, 1, 0, 0); ink.clearRect(0, 0, overlay.width, overlay.height); ink.setTransform(ratio, 0, 0, ratio, 0, -offsetY * ratio);
  if (active?.kind === 'ink') drawStroke(ink, { points: active.points, color: active.color, width: active.width });
  if (active?.kind === 'marquee') {
    const rect = rectangle(active.start, active.current); ink.fillStyle = '#427cba12'; ink.strokeStyle = '#4e83b5'; ink.lineWidth = 1; ink.setLineDash([5, 4]);
    ink.fillRect(rect.x, rect.y, rect.width, rect.height); ink.strokeRect(rect.x, rect.y, rect.width, rect.height); ink.setLineDash([]);
  } else if (selection.size && tool === 'select') {
    const bounds = boundsOf(preview || selectedStrokes());
    if (bounds) {
      const box = bounds, pad = 7;
      ink.strokeStyle = settings.paperTone === 'night' ? '#8ebce7' : '#4e83b5'; ink.lineWidth = 1; ink.setLineDash([5, 4]);
      ink.strokeRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2); ink.setLineDash([]); ink.fillStyle = tones[settings.paperTone].background;
      for (const point of corners(box, pad)) { ink.beginPath(); ink.arc(point.x, point.y, 4, 0, Math.PI * 2); ink.fill(); ink.stroke(); }
    }
  }
}
function world(event) { return { x: event.clientX, y: event.clientY + offsetY }; }
function rectangle(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }; }
function corners(box, pad = 0) { return [{ x: box.x - pad, y: box.y - pad }, { x: box.x + box.width + pad, y: box.y - pad }, { x: box.x + box.width + pad, y: box.y + box.height + pad }, { x: box.x - pad, y: box.y + box.height + pad }]; }
function inside(point, box, pad = 0) { return point.x >= box.x - pad && point.x <= box.x + box.width + pad && point.y >= box.y - pad && point.y <= box.y + box.height + pad; }
function contact(event) { return event.pointerType !== 'pen' || event.pressure > 0; }
function eventTool(event) {
  if (spaceDown || (event.buttons & 4)) return 'hand';
  if (event.pointerType === 'pen' && ((event.buttons & 34) || event.button === 5)) return 'eraser';
  return tool;
}
function capture(event) { try { overlay.setPointerCapture(event.pointerId); } catch {} }
function pointOf(event) { return { ...world(event), p: event.pointerType === 'pen' ? Math.max(.01, Math.min(1, event.pressure)) : .5 }; }
function appendPoint(event, pressure) {
  const point = pointOf(event), previous = active.points.at(-1);
  if (pressure !== undefined) point.p = pressure;
  if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= .35 || Math.abs(point.p - previous.p) >= .03) active.points.push(point);
}
function eraseAt(point) {
  const radius = 12;
  const hits = notebook.query({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 }).filter(stroke => strokeHitsPoint(stroke, point, radius));
  if (hits.length && notebook.remove(hits.map(stroke => stroke.id))) { active.changed = true; requestRender(); }
}
function pointerDown(event) {
  if (!loaded || loadError || event.pointerType === 'touch' || active) return;
  $('#context-menu').hidden = true;
  if (event.button === 2 && event.pointerType !== 'pen') return;
  const currentTool = eventTool(event); if (currentTool !== 'hand' && !contact(event)) return;
  event.preventDefault(); overlay.focus({ preventScroll: true }); capture(event);
  const point = world(event);
  if (currentTool === 'hand') active = { kind: 'pan', pointerId: event.pointerId, initialY: event.clientY, initialOffset: offsetY, temporary: tool !== 'hand' };
  else if (currentTool === 'eraser') { notebook.beginGroup(); active = { kind: 'erase', pointerId: event.pointerId, changed: false, previous: point }; eraseAt(point); }
  else if (currentTool === 'select') {
    const box = boundsOf(selectedStrokes());
    const corner = box ? corners(box, 7).findIndex(p => Math.hypot(p.x - point.x, p.y - point.y) <= 9) : -1;
    if (corner >= 0 && box.width > 1 && box.height > 1) {
      const opposite = corners(box)[(corner + 2) % 4]; active = { kind: 'resize', pointerId: event.pointerId, box, opposite, start: point, transform: { scaleX: 1, scaleY: 1, originX: opposite.x, originY: opposite.y, dx: 0, dy: 0 } };
    } else if (box && inside(point, box, 7) && !event.shiftKey) active = { kind: 'move', pointerId: event.pointerId, start: point, dx: 0, dy: 0 };
    else { active = { kind: 'marquee', pointerId: event.pointerId, start: point, current: point, previousSelection: event.shiftKey ? new Set(selection) : new Set() }; if (!event.shiftKey) selection.clear(); }
  } else { selection.clear(); active = { kind: 'ink', pointerId: event.pointerId, points: [], color: settings.color, width: settings.width }; appendPoint(event); }
  updateCursor(); requestRender();
}
function pointerMove(event) {
  if (!active) { if (event.pointerType === 'pen' && event.buttons && contact(event)) pointerDown(event); return; }
  if (event.pointerId !== active.pointerId) return;
  event.preventDefault(); const currentTool = eventTool(event);
  if (active.kind === 'pan' && active.temporary && currentTool !== 'hand') { finishGesture(); if (contact(event) && event.buttons) pointerDown(event); return; }
  if (event.pointerType === 'pen' && ['ink', 'erase'].includes(active.kind)) {
    const expected = currentTool === 'eraser' ? 'erase' : currentTool === 'hand' ? 'pan' : 'ink';
    if (expected !== active.kind) { finishGesture(); if (contact(event) || expected === 'pan') pointerDown(event); return; }
    if (!contact(event)) { finishGesture(); return; }
  }
  if (active.kind === 'ink') { const samples = event.getCoalescedEvents?.() || []; for (const sample of samples.length ? samples : [event]) if (contact(sample)) appendPoint(sample); }
  else if (active.kind === 'erase') {
    const point = world(event), previous = active.previous, distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.min(1000, Math.max(1, Math.ceil(distance / 6)));
    for (let index = 1; index <= steps; index++) eraseAt({ x: previous.x + (point.x - previous.x) * index / steps, y: previous.y + (point.y - previous.y) * index / steps });
    active.previous = point;
  } else if (active.kind === 'pan') setOffset(active.initialOffset + active.initialY - event.clientY, false);
  else if (active.kind === 'move') { const point = world(event); active.dx = point.x - active.start.x; active.dy = point.y - active.start.y; }
  else if (active.kind === 'resize') {
    const point = world(event), opposite = active.opposite;
    let scaleX = Math.max(.05, (point.x - opposite.x) / (active.start.x - opposite.x)), scaleY = Math.max(.05, (point.y - opposite.y) / (active.start.y - opposite.y));
    if (event.shiftKey) scaleX = scaleY = Math.max(scaleX, scaleY);
    active.transform = { scaleX, scaleY, originX: opposite.x, originY: opposite.y, dx: 0, dy: 0 };
  } else if (active.kind === 'marquee') active.current = world(event);
  requestRender(active.kind !== 'ink' && active.kind !== 'marquee');
}
function finishGesture(cancel = false) {
  if (!active) return;
  const gesture = active; active = null; let modified = false;
  if (gesture.kind === 'ink' && gesture.points.length) modified = notebook.add([makeStroke(gesture.points, gesture.color, gesture.width)]);
  else if (gesture.kind === 'erase') { notebook.endGroup(); modified = gesture.changed; }
  else if (!cancel && gesture.kind === 'move' && (Math.abs(gesture.dx) > .1 || Math.abs(gesture.dy) > .1)) modified = notebook.move([...selection], gesture.dx, gesture.dy);
  else if (!cancel && gesture.kind === 'resize') modified = notebook.transform([...selection], gesture.transform);
  else if (!cancel && gesture.kind === 'marquee') {
    const box = rectangle(gesture.start, gesture.current); selection = gesture.previousSelection;
    const hits = box.width < 3 && box.height < 3 ? notebook.query({ x: box.x - 5, y: box.y - 5, width: 10, height: 10 }).filter(stroke => strokeHitsPoint(stroke, gesture.current, 5)).slice(-1) : notebook.query(box).filter(stroke => strokeIntersectsRect(stroke, box));
    for (const stroke of hits) selection.add(stroke.id);
  } else if (gesture.kind === 'pan') modified = offsetY !== gesture.initialOffset;
  try { if (overlay.hasPointerCapture(gesture.pointerId)) overlay.releasePointerCapture(gesture.pointerId); } catch {}
  if (modified) changed(); updateControls(); requestRender();
}
overlay.addEventListener('pointerdown', pointerDown); overlay.addEventListener('pointermove', pointerMove);
overlay.addEventListener('pointerup', event => { if (active?.pointerId === event.pointerId) { if (active.kind === 'ink') appendPoint(event, active.points.at(-1)?.p ?? .5); finishGesture(); } });
overlay.addEventListener('pointercancel', () => finishGesture(true)); overlay.addEventListener('lostpointercapture', () => finishGesture(true));
overlay.addEventListener('wheel', event => {
  event.preventDefault(); if (active || !loaded || loadError) return;
  const multiplier = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? height : 1; setOffset(offsetY + event.deltaY * multiplier);
}, { passive: false });
window.addEventListener('blur', () => { finishGesture(); spaceDown = false; updateCursor(); }); window.addEventListener('resize', resize);

async function copySelection(cut = false) {
  finishGesture(); const strokes = selectedStrokes(); if (!strokes.length) return;
  const text = JSON.stringify({ type: 'scrollmind/strokes', version: 1, strokes });
  await bridge.writeClipboard(text); clipboardSource = text; pasteCount = 0;
  if (cut) { notebook.remove([...selection]); selection.clear(); changed(); }
}
async function pasteSelection() {
  finishGesture(); const text = await bridge.readClipboard(); let data;
  try { data = JSON.parse(text); if (data.type !== 'scrollmind/strokes' || data.version !== 1) return message('Copy some strokes to paste here'); data.strokes = validateStrokes(data.strokes); }
  catch { return message('Copy some strokes to paste here'); }
  if (!data.strokes.length) return;
  if (clipboardSource !== text) { clipboardSource = text; pasteCount = 0; } pasteCount++;
  const bounds = boundsOf(data.strokes); let dx = pasteCount * 24, dy = pasteCount * 24;
  if (bounds.y + dy + bounds.height < offsetY + 80 || bounds.y + dy > offsetY + height - 50) dy = offsetY + height / 2 - bounds.y - bounds.height / 2;
  if (bounds.x + dx > width - 50 || bounds.x + dx + bounds.width < 0) dx = width / 2 - bounds.x - bounds.width / 2;
  const strokes = data.strokes.map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(point => ({ ...point, x: point.x + dx, y: point.y + dy })) }));
  notebook.add(strokes); selection = new Set(strokes.map(stroke => stroke.id)); tool = 'select'; changed();
}
function deleteSelection() { finishGesture(); if (notebook.remove([...selection])) { selection.clear(); changed(); } }
function duplicateSelection() {
  finishGesture(); const copies = selectedStrokes().map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(point => ({ ...point, x: point.x + 24, y: point.y + 24 })) }));
  if (copies.length) { notebook.add(copies); selection = new Set(copies.map(stroke => stroke.id)); changed(); }
}
async function command(value) {
  if (!loaded || loadError) return;
  if (value.startsWith('tool-')) return setTool(value.slice(5));
  if (value === 'undo' || value === 'redo') { finishGesture(); if (notebook[value]()) { changed(); renderMarkers(); } }
  else if (value === 'copy') await copySelection(); else if (value === 'cut') await copySelection(true); else if (value === 'paste') await pasteSelection();
  else if (value === 'duplicate') duplicateSelection(); else if (value === 'delete') deleteSelection();
  else if (value === 'select-all') { finishGesture(); tool = 'select'; selection = new Set(notebook.strokes.map(stroke => stroke.id)); updateControls(); requestRender(); }
  else if (value === 'home') { finishGesture(); setOffset(0); } else if (value === 'fullscreen') await bridge.toggleFullscreen();
  else if (value === 'help') { finishGesture(); $('#help').showModal(); }
  else if (value === 'toggle-toolbar') $('#toolbar').hidden = !$('#toolbar').hidden;
  else if (value === 'toggle-sidebar') toggleSidebar(); else if (value.startsWith('add-')) addMarker(value.slice(4));
}
function safely(value) { Promise.resolve(command(value)).catch(error => message(error.message, true)); }
document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => { finishGesture(); settings.color = button.dataset.color; setTool('pen'); changed(); }));
document.querySelectorAll('[data-width]').forEach(button => button.addEventListener('click', () => { finishGesture(); settings.width = Number(button.dataset.width); changed(); }));
for (const name of ['undo', 'redo', 'home', 'fullscreen']) $(`#${name}`).addEventListener('click', () => safely(name));
$('#help-open').addEventListener('click', () => safely('help')); $('#controls-link').addEventListener('click', () => safely('help')); $('#help-close').addEventListener('click', () => $('#help').close());
$('#context-menu').addEventListener('click', event => { const button = event.target.closest('[data-command]'); if (button) { safely(button.dataset.command); $('#context-menu').hidden = true; } });
overlay.addEventListener('contextmenu', event => {
  event.preventDefault(); if (!loaded || event.pointerType === 'pen') return; finishGesture(); const menu = $('#context-menu'); menu.hidden = false;
  menu.style.left = `${Math.min(width - 206, event.clientX)}px`; menu.style.top = `${Math.min(height - 213, event.clientY)}px`;
  for (const button of menu.querySelectorAll('button')) button.disabled = button.dataset.command !== 'paste' && selection.size === 0;
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('#context-menu')) $('#context-menu').hidden = true; });
function isTextInput(target) { return target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable=true]')); }
document.addEventListener('keydown', event => {
  if (isTextInput(event.target) || $('#help').open) return;
  const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase(); let action;
  if (mod) {
    if (key === 'z') action = event.shiftKey ? 'redo' : 'undo'; else if (key === 'y') action = 'redo';
    else if (key === 'c') action = 'copy'; else if (key === 'x') action = 'cut'; else if (key === 'v') action = 'paste'; else if (key === 'a') action = 'select-all'; else if (key === 'd') action = 'duplicate';
    else if (key === '0') action = 'home'; else if (key === '/') action = 'toggle-sidebar'; else if (key === 'f' && event.shiftKey) action = 'fullscreen';
    else if (key === 'm' && event.shiftKey) action = 'add-marker'; else if (key === 'enter') action = 'add-page-break';
    else if (key === 's') { event.preventDefault(); flushSave().catch(() => {}); return; }
  } else {
    if (key === 'b') action = 'tool-pen'; else if (key === 'e') action = 'tool-eraser'; else if (key === 'v') action = 'tool-select'; else if (key === 'h') action = 'tool-hand';
    else if (key === 'delete' || key === 'backspace') action = 'delete'; else if (key === 'tab') action = 'toggle-toolbar'; else if (key === '?' || key === 'f1') action = 'help'; else if (key === 'f11') action = 'fullscreen'; else if (key === 'home') action = 'home';
    else if (key === ' ') { event.preventDefault(); if (!event.repeat) { finishGesture(); spaceDown = true; updateCursor(); } return; }
    else if (key === 'escape') {
      event.preventDefault(); if (active) finishGesture(true); else if (!$('#context-menu').hidden) $('#context-menu').hidden = true;
      else if (selection.size) { selection.clear(); updateControls(); requestRender(); } else if (!$('#sidebar').hidden) toggleSidebar(false); else bridge.leaveFullscreen(); return;
    } else if (key.startsWith('arrow')) {
      event.preventDefault(); finishGesture(); const amount = event.shiftKey ? 10 : 1;
      if (selection.size) { const dx = key === 'arrowleft' ? -amount : key === 'arrowright' ? amount : 0, dy = key === 'arrowup' ? -amount : key === 'arrowdown' ? amount : 0; if (notebook.move([...selection], dx, dy)) changed(); }
      else if (key === 'arrowup' || key === 'arrowdown') setOffset(offsetY + (key === 'arrowup' ? -1 : 1) * (event.shiftKey ? height * .8 : 48)); return;
    } else if (key === 'pagedown' || key === 'pageup') { event.preventDefault(); finishGesture(); setOffset(offsetY + (key === 'pageup' ? -1 : 1) * height * .8); return; }
  }
  if (action) { event.preventDefault(); safely(action); }
});
document.addEventListener('keyup', event => { if (event.code === 'Space') { if (active?.kind === 'pan') finishGesture(); spaceDown = false; updateCursor(); } });
function toggleSidebar(show = $('#sidebar').hidden) {
  finishGesture(); $('#sidebar').hidden = !show; $('#sidebar-toggle').setAttribute('aria-expanded', String(show)); $('#sidebar-toggle').setAttribute('aria-label', show ? 'Close sidebar' : 'Open sidebar');
  document.body.classList.toggle('sidebar-open', show); if (!show) overlay.focus({ preventScroll: true });
}
$('#sidebar-toggle').addEventListener('click', () => toggleSidebar()); $('#sidebar-close').addEventListener('click', () => toggleSidebar(false)); $('#start-link').addEventListener('click', () => setOffset(0));
function markerLabel(kind) { return kind === 'section' ? 'Section' : kind === 'page-break' ? 'Page break' : 'Marker'; }
function addMarker(kind) {
  if (!loaded || loadError || !['section', 'marker', 'page-break'].includes(kind)) return; finishGesture(); const count = notebook.markers.filter(marker => marker.kind === kind).length + 1;
  notebook.addMarker({ id: crypto.randomUUID(), kind, y: offsetY + height / 2, label: `${markerLabel(kind)} ${count}` }); changed(); renderMarkers();
}
for (const kind of ['section', 'marker', 'page-break']) $(`#add-${kind}`).addEventListener('click', () => addMarker(kind));
function renderMarkers() {
  const list = $('#markers'); list.replaceChildren(); const markers = [...notebook.markers].sort((a, b) => a.y - b.y);
  $('#markers-empty').hidden = markers.length > 0; $('#marker-count').textContent = markers.length;
  for (const marker of markers) {
    const row = document.createElement('div'); row.className = 'marker-row'; row.dataset.kind = marker.kind;
    const go = document.createElement('button'); go.className = 'marker-go'; go.textContent = marker.kind === 'section' ? '§' : marker.kind === 'page-break' ? '↵' : '◇'; go.title = `Go to ${marker.label}`; go.setAttribute('aria-label', `Go to ${marker.label}`);
    go.addEventListener('click', () => { finishGesture(); setOffset(marker.y - 130); });
    const label = document.createElement('input'); label.value = marker.label; label.maxLength = 200; label.setAttribute('aria-label', `${markerLabel(marker.kind)} name`);
    label.addEventListener('change', () => { const value = label.value.trim() || markerLabel(marker.kind); label.value = value; if (notebook.updateMarker(marker.id, { label: value })) { changed(); renderMarkers(); } });
    label.addEventListener('keydown', event => { if (event.key === 'Enter') { label.blur(); overlay.focus(); } });
    const remove = document.createElement('button'); remove.className = 'marker-remove'; remove.textContent = '×'; remove.title = `Remove ${marker.label}`; remove.setAttribute('aria-label', `Remove ${marker.label}`);
    remove.addEventListener('click', () => { if (notebook.removeMarker(marker.id)) { changed(); renderMarkers(); } }); row.append(go, label, remove); list.append(row);
  }
}
$('#paper-tone').addEventListener('change', event => { finishGesture(); settings.paperTone = event.target.value; changed(); }); $('#paper-pattern').addEventListener('change', event => { finishGesture(); settings.paper = event.target.value; changed(); });
$('#display-select').addEventListener('change', async event => { try { finishGesture(); await bridge.moveToDisplay(event.target.value); } catch (error) { message(error.message, true); } });
$('#data-folder').addEventListener('click', () => bridge.openDataFolder().catch(error => message(error.message, true)));
status.addEventListener('click', () => { if (status.classList.contains('error')) bridge.openDataFolder(); }); bridge.onCommand(safely);
bridge.onBeforeClose(async () => { try { await initialization; if (!loadError) { finishGesture(); await flushSave(); } await bridge.readyToClose(); } catch (error) { await bridge.readyToClose({ error: error.message }); } });
window.addEventListener('pagehide', () => { finishGesture(); flushSave().catch(() => {}); }); window.addEventListener('error', event => message(event.message || 'Something needs attention', true));
async function initialize() {
  try {
    const [result, info, displays] = await Promise.all([bridge.load(), bridge.getAppInfo(), bridge.getDisplays()]);
    if (result.error && !result.document) throw new Error(result.error);
    if (result.document) { notebook = new Notebook(result.document); settings = { ...settings, ...result.document.settings }; offsetY = result.document.view.offsetY; }
    $('#version').textContent = `ScrollMind ${info.version} · First draft`;
    for (const display of displays) { const option = document.createElement('option'); option.value = display.id; option.textContent = display.label; option.selected = display.selected; $('#display-select').append(option); }
    loaded = true;
    if (info.testMode) window.scrollmindDebug = Object.freeze({ getSnapshot: snapshot, getSelection: () => [...selection], getOffsetY: () => offsetY, setOffsetY: value => setOffset(value) });
    message(result.recovered ? 'Recovered from backup · saved locally' : 'Saved'); if (!result.document) changed(); updateControls(); renderMarkers(); resize();
  } catch (error) { loadError = error.message; message('Couldn’t open notebook · click to open folder', true); console.error(error); }
}
resize(); const initialization = initialize(); await initialization;
