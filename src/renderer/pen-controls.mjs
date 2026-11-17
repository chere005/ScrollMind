const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));

function rgbToHSV(hex) {
  const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const [r, g, b] = values, max = Math.max(...values), min = Math.min(...values), delta = max - min;
  let h = 0;
  if (delta) h = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max };
}
function hsvToRGB({ h, s, v }) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const channels = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return channels.map(value => Math.round((value + m) * 255));
}
const hexFromHSV = value => `#${hsvToRGB(value).map(channel => channel.toString(16).padStart(2, '0')).join('')}`;

/** The pen UI stays out of the way until a deliberate hover or keyboard focus. */
export function createPenControls({ onColor, focusCanvas }) {
  const root = document.querySelector('#pen-controls');
  const toggle = document.querySelector('#pen-controls-toggle');
  const toolbar = document.querySelector('#toolbar');
  const picker = document.querySelector('#color-picker');
  const pickerToggle = document.querySelector('#color-wheel-toggle');
  const wheel = document.querySelector('#color-wheel');
  const valueInput = document.querySelector('#color-value');
  const hexInput = document.querySelector('#color-hex');
  let hoverTimer, closeTimer, pointerPosition = null, interacting = false;
  let hsv = rgbToHSV('#243746'), selectedColor = '#243746', wheelPointer = null;
  const size = Math.round(220 * Math.min(3, devicePixelRatio || 1));
  wheel.width = wheel.height = size;
  const radius = size / 2 - 5, center = size / 2;
  const base = document.createElement('canvas'); base.width = base.height = size;
  const basePaint = base.getContext('2d'), pixels = basePaint.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x - center, dy = y - center, s = Math.hypot(dx, dy) / radius;
    if (s > 1) continue;
    const color = hsvToRGB({ h: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, s, v: 1 });
    const index = (y * size + x) * 4;
    pixels.data[index] = color[0]; pixels.data[index + 1] = color[1]; pixels.data[index + 2] = color[2]; pixels.data[index + 3] = 255;
  }
  basePaint.putImageData(pixels, 0, 0);

  function formFocused() {
    return root.contains(document.activeElement) && document.activeElement.matches('input, select, #color-wheel, :focus-visible');
  }
  function cancelHover() { clearTimeout(hoverTimer); hoverTimer = null; }
  function cancelClose() { clearTimeout(closeTimer); closeTimer = null; }
  function rememberPointer(event) {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) pointerPosition = { x: event.clientX, y: event.clientY };
  }
  function withinGrace() {
    if (root.hidden || !pointerPosition) return false;
    return [toggle, toolbar, picker].some(element => {
      if (element.hidden || !element.getClientRects().length) return false;
      const box = element.getBoundingClientRect();
      return pointerPosition.x >= box.left - 28 && pointerPosition.x <= box.right + 28
        && pointerPosition.y >= box.top - 28 && pointerPosition.y <= box.bottom + 28;
    });
  }
  function open() {
    if (root.hidden) return;
    cancelHover(); cancelClose();
    toolbar.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    root.dataset.expanded = 'true';
  }
  function close(focus = false) {
    cancelHover(); cancelClose();
    interacting = false;
    endWheelDrag();
    picker.hidden = true; pickerToggle.setAttribute('aria-expanded', 'false');
    toolbar.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    root.dataset.expanded = 'false';
    if (root.contains(document.activeElement)) document.activeElement.blur();
    if (focus) focusCanvas();
  }
  function scheduleClose() {
    if (toolbar.hidden || withinGrace() || interacting || formFocused()) { cancelClose(); return; }
    // Start once on leaving the margin, so continued movement cannot postpone closing.
    if (closeTimer !== null && closeTimer !== undefined) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!withinGrace() && !interacting && !formFocused()) close();
    }, 500);
  }
  root.addEventListener('pointerenter', event => {
    rememberPointer(event); cancelClose();
    if (toolbar.hidden && !hoverTimer) hoverTimer = setTimeout(open, 200);
  });
  root.addEventListener('pointerleave', event => { rememberPointer(event); cancelHover(); scheduleClose(); });
  document.addEventListener('pointermove', event => { rememberPointer(event); scheduleClose(); }, { capture: true, passive: true });
  document.addEventListener('pointerout', event => {
    if (event.relatedTarget !== null) return;
    pointerPosition = null; cancelHover(); scheduleClose();
  }, { passive: true });
  root.addEventListener('focusin', () => { if (!interacting) open(); });
  root.addEventListener('focusout', () => { setTimeout(scheduleClose, 0); });
  root.addEventListener('pointerdown', event => { rememberPointer(event); interacting = true; cancelClose(); }, true);
  document.addEventListener('pointerup', event => { rememberPointer(event); interacting = false; scheduleClose(); }, true);
  document.addEventListener('pointercancel', () => { interacting = false; pointerPosition = null; scheduleClose(); }, true);
  toggle.addEventListener('click', () => { if (toolbar.hidden) open(); else close(true); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  window.addEventListener('blur', () => { interacting = false; pointerPosition = null; close(); });
  pickerToggle.addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    pickerToggle.setAttribute('aria-expanded', String(!picker.hidden));
    drawWheel();
  });

  function drawWheel() {
    const paint = wheel.getContext('2d');
    paint.clearRect(0, 0, size, size); paint.drawImage(base, 0, 0);
    const angle = hsv.h * Math.PI / 180;
    const x = center + Math.cos(angle) * hsv.s * radius, y = center + Math.sin(angle) * hsv.s * radius;
    const marker = size / 55;
    paint.beginPath(); paint.arc(x, y, marker, 0, Math.PI * 2);
    paint.fillStyle = selectedColor; paint.fill(); paint.strokeStyle = '#fff'; paint.lineWidth = size / 110; paint.stroke();
    paint.beginPath(); paint.arc(x, y, marker + size / 220, 0, Math.PI * 2); paint.strokeStyle = '#173c5966'; paint.lineWidth = size / 220; paint.stroke();
    wheel.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
    wheel.setAttribute('aria-valuetext', `Hue ${Math.round(hsv.h)}, saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
  }
  function refreshColor(color) {
    // Old scrolls may contain short hexadecimal notation; normalize it for the picker.
    if (/^#[\da-f]{3}$/i.test(color)) color = `#${[...color.slice(1)].map(c => c + c).join('')}`;
    if (!/^#[\da-f]{6}$/i.test(color)) return;
    selectedColor = color.toLowerCase();
    const next = rgbToHSV(selectedColor); if (!next.s) next.h = hsv.h;
    hsv = next;
    root.style.setProperty('--selected-ink', selectedColor);
    document.querySelector('#chosen-color').style.background = selectedColor;
    valueInput.value = String(Math.round(hsv.v * 100));
    if (document.activeElement !== hexInput) hexInput.value = selectedColor;
    drawWheel();
  }
  function emitColor() { const color = hexFromHSV(hsv); selectedColor = color; onColor(color); refreshColor(color); }
  function chooseWheel(event) {
    const box = wheel.getBoundingClientRect();
    const dx = (event.clientX - box.left) * size / box.width - center, dy = (event.clientY - box.top) * size / box.height - center;
    hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    hsv.s = clamp(Math.hypot(dx, dy) / radius);
    emitColor();
  }
  wheel.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); wheelPointer = event.pointerId;
    try { wheel.setPointerCapture(event.pointerId); } catch {}
    chooseWheel(event);
  });
  wheel.addEventListener('pointermove', event => { if (wheelPointer === event.pointerId) { event.preventDefault(); chooseWheel(event); } });
  function endWheelDrag() {
    const pointer = wheelPointer; wheelPointer = null;
    if (pointer !== null) try { wheel.releasePointerCapture(pointer); } catch {}
  }
  const finishWheel = event => {
    if (wheelPointer !== event.pointerId) return;
    endWheelDrag(); interacting = false; scheduleClose();
  };
  wheel.addEventListener('pointerup', finishWheel); wheel.addEventListener('pointercancel', finishWheel);
  wheel.addEventListener('lostpointercapture', finishWheel);
  wheel.addEventListener('keydown', event => {
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowLeft') hsv.h = (hsv.h - step + 360) % 360;
    if (event.key === 'ArrowRight') hsv.h = (hsv.h + step) % 360;
    if (event.key === 'ArrowUp') hsv.s = clamp(hsv.s + step / 100);
    if (event.key === 'ArrowDown') hsv.s = clamp(hsv.s - step / 100);
    emitColor();
  });
  valueInput.addEventListener('input', () => { hsv.v = clamp(Number(valueInput.value) / 100); emitColor(); });
  function commitHex() {
    const value = hexInput.value.trim();
    const color = value.startsWith('#') ? value : `#${value}`;
    if (!/^#[\da-f]{6}$/i.test(color)) { hexInput.setAttribute('aria-invalid', 'true'); return; }
    hexInput.removeAttribute('aria-invalid'); onColor(color.toLowerCase()); refreshColor(color);
  }
  hexInput.addEventListener('change', commitHex);
  hexInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitHex(); hexInput.blur(); focusCanvas(); }
  });
  hexInput.addEventListener('blur', () => { hexInput.value = selectedColor; hexInput.removeAttribute('aria-invalid'); });

  refreshColor(selectedColor);
  return { open, close, refreshColor, toggleVisibility() { close(); root.hidden = !root.hidden; } };
}
