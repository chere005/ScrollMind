const DELETE_BUTTON = 2;
const SCROLL_BUTTON = 4;
const CONTACT_BUTTONS = 1 | 32;
const MAX_CLICK_DURATION = 250;
const PEN_CLICK_WINDOW = 400;
const ZOOM_SEQUENCE_WINDOW = 700;
export const PEN_CLICK_MOVEMENT = 8;

/** Recognize intentional hovering pen-button double-clicks without treating taps or pans as shortcuts. */
export class PenButtonShortcuts {
  #pointers = new Map();
  #candidate = null;
  #pressureContact;
  #navigation;

  // pressureContact: treat any pressure above zero as tip contact (Windows Ink reports barrel plus tip as button 2 with pressure).
  constructor({ pressureContact = false, navigation = false } = {}) {
    this.#pressureContact = pressureContact;
    this.#navigation = navigation;
  }

  reset() {
    this.#pointers.clear();
    this.#candidate = null;
  }

  /** Something other than a click happened while a button was down (the driver scrolling, say): that press is not a tap. */
  cancel() {
    this.#candidate = null;
    for (const state of this.#pointers.values()) if (state.press) state.press.valid = false;
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
    if (this.#candidate) {
      const window = this.#navigation && this.#candidate.button === DELETE_BUTTON ? ZOOM_SEQUENCE_WINDOW : PEN_CLICK_WINDOW;
      if (now - this.#candidate.time > window) this.#candidate = null;
    }
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
    const pressed = this.#pressureContact && event.pressure > 0;
    if (pressed || (buttons & CONTACT_BUTTONS) || (buttons !== 0 && !cleanButton)) this.#candidate = null;
    let action = null;
    if (state.press) {
      const press = state.press;
      if (pressed || (buttons & ~press.button) || Math.hypot(x - press.x, y - press.y) > PEN_CLICK_MOVEMENT
        || now - press.time > MAX_CLICK_DURATION) {
        press.valid = false;
        this.#candidate = null;
      }
      if (!(buttons & press.button)) {
        state.press = null;
        if (press.valid && buttons === 0) {
          const prior = this.#candidate?.pointerId === pointerId ? this.#candidate.button : null;
          const doubleClick = prior === press.button && now - this.#candidate.time <= PEN_CLICK_WINDOW;
          const zoomSequence = this.#navigation && prior === DELETE_BUTTON && press.button === SCROLL_BUTTON;
          if (doubleClick || zoomSequence) {
            action = zoomSequence ? 'zoom-next' : press.button === DELETE_BUTTON ? 'undo' : 'redo';
            this.#candidate = null;
          } else {
            this.#candidate = { pointerId, button: press.button, time: now };
          }
        }
      }
    }
    if (cleanButton && !(previous & cleanButton) && !state.press) {
      if (this.#candidate && (this.#candidate.pointerId !== pointerId || this.#candidate.button !== cleanButton
        && !(this.#navigation && this.#candidate.button === DELETE_BUTTON && cleanButton === SCROLL_BUTTON))) this.#candidate = null;
      state.press = { button: cleanButton, time: now, x, y, valid: !pressed };
    }
    return action;
  }
}
