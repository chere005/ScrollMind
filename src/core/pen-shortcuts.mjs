const DELETE_BUTTON = 2;
const SCROLL_BUTTON = 4;
const CONTACT_BUTTONS = 1 | 32;
const MAX_CLICK_DURATION = 250;
const DOUBLE_CLICK_WINDOW = 400;
const MAX_MOVEMENT = 8;

/** Recognize intentional hovering pen-button double-clicks without treating taps or pans as shortcuts. */
export class PenButtonShortcuts {
  #pointers = new Map();
  #candidate = null;

  reset() {
    this.#pointers.clear();
    this.#candidate = null;
  }

  update(event, now = performance.now()) {
    if (event?.type === 'blur') {
      this.reset();
      return null;
    }
    if (event?.pointerType !== 'pen') return null;
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
      this.reset();
      return null;
    }
    if (!['pointerdown', 'pointermove', 'pointerup'].includes(event.type)) return null;
    if (!Number.isFinite(now) || !Number.isInteger(event.buttons) || event.buttons < 0) {
      this.reset();
      return null;
    }
    const pointerId = event.pointerId ?? 0;
    let state = this.#pointers.get(pointerId);
    if (state && now < state.lastTime) {
      this.reset();
      state = null;
    }
    if (this.#candidate && now - this.#candidate.time > DOUBLE_CLICK_WINDOW) this.#candidate = null;
    if (!state) {
      // A move received after entering the canvas can already have a button held.
      // Only a down event can establish the first observed press without prior state.
      state = { buttons: event.type === 'pointerdown' ? 0 : event.buttons, press: null, lastTime: now };
      if (this.#pointers.size >= 32) this.#pointers.delete(this.#pointers.keys().next().value);
      this.#pointers.set(pointerId, state);
    }
    const buttons = event.buttons;
    const previous = state.buttons;
    const x = Number.isFinite(event.clientX) ? event.clientX : 0;
    const y = Number.isFinite(event.clientY) ? event.clientY : 0;
    const cleanButton = buttons === DELETE_BUTTON || buttons === SCROLL_BUTTON ? buttons : 0;
    state.buttons = buttons;
    state.lastTime = now;

    // Tip contact, rear-eraser contact, and button chords invalidate the entire pair.
    if ((buttons & CONTACT_BUTTONS) || (buttons !== 0 && !cleanButton)) this.#candidate = null;
    let action = null;
    if (state.press) {
      const press = state.press;
      if ((buttons & ~press.button) || Math.hypot(x - press.x, y - press.y) > MAX_MOVEMENT
        || now - press.time > MAX_CLICK_DURATION) {
        press.valid = false;
        this.#candidate = null;
      }
      if (!(buttons & press.button)) {
        state.press = null;
        if (press.valid && buttons === 0) {
          if (this.#candidate?.pointerId === pointerId && this.#candidate.button === press.button
            && now - this.#candidate.time <= DOUBLE_CLICK_WINDOW) {
            action = press.button === DELETE_BUTTON ? 'undo' : 'redo';
            this.#candidate = null;
          } else this.#candidate = { pointerId, button: press.button, time: now };
        }
      }
    }
    if (cleanButton && !(previous & cleanButton) && !state.press) {
      if (this.#candidate && (this.#candidate.pointerId !== pointerId || this.#candidate.button !== cleanButton)) this.#candidate = null;
      state.press = { button: cleanButton, time: now, x, y, valid: true };
    }
    return action;
  }
}
