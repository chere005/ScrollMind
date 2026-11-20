// The actions: 'undo' (lower double tap), 'redo' (upper double tap), and with navigation 'zoom-hold' (lower tapped, then upper
// pressed quickly: zoom mode, for as long as the upper button stays down) and 'zoom-end' (that upper button let go).
const DELETE_BUTTON = 2;
const SCROLL_BUTTON = 4;
const CONTACT_BUTTONS = 1 | 32;
// A tap is a press of at most half a second in which the pen stays within a few millimeters: a thumb pressing a barrel
// button takes that long and nudges the pen that much. Longer is a hold, farther is a drag.
const MAX_CLICK_DURATION = 500;
const TAP_MOVEMENT = 16;
const PEN_CLICK_WINDOW = 400;
const ZOOM_SEQUENCE_WINDOW = 700;
export const PEN_CLICK_MOVEMENT = 8;

/** Recognize intentional hovering pen-button double-clicks without treating taps or pans as shortcuts. */
export class PenButtonShortcuts {
  #pointers = new Map();
  #candidate = null;
  // The zoom chord's upper press, while it lasts: { pointerId }.
  #zoom = null;
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
    this.#zoom = null;
  }

  /** The zoom chord is on: its upper button is still down. */
  get zooming() { return this.#zoom !== null; }

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
      // The window runs from the first release to the START of the next press, so a slow second tap still counts.
      const pressing = state?.press && state.press.time - this.#candidate.time <= window;
      if (now - this.#candidate.time > window && !pressing) this.#candidate = null;
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
    // The zoom chord lasts while its upper button is down, the tip touching or not; letting it go ends the chord, and it is no tap.
    if (this.#zoom) {
      state.buttons = buttons;
      state.lastTime = now;
      if (this.#zoom.pointerId !== pointerId || (buttons & SCROLL_BUTTON)) return null;
      this.#zoom = null;
      state.press = null;
      return 'zoom-end';
    }
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
      // (where the display itself reports the pen, a press in the air does nothing else, so how far the pen drifts under the thumb
      // does not matter: only how long the press lasts)
      const drifted = !event.native && !event.placed && Math.hypot(x - press.x, y - press.y) > TAP_MOVEMENT;
      if (pressed || (buttons & ~press.button) || drifted || now - press.time > MAX_CLICK_DURATION) {
        press.valid = false;
        this.#candidate = null;
      }
      if (!(buttons & press.button)) {
        state.press = null;
        if (press.valid && buttons === 0) {
          const prior = this.#candidate?.pointerId === pointerId ? this.#candidate.button : null;
          const doubleClick = prior === press.button && press.time - this.#candidate.time <= PEN_CLICK_WINDOW;
          if (doubleClick) {
            action = press.button === DELETE_BUTTON ? 'undo' : 'redo';
            this.#candidate = null;
          } else {
            this.#candidate = { pointerId, button: press.button, time: now };
          }
        }
      }
    }
    if (cleanButton && !(previous & cleanButton) && !state.press) {
      // The lower button tapped, then the upper one pressed in time: zoom mode from this press until it is let go.
      if (this.#navigation && cleanButton === SCROLL_BUTTON && !pressed && this.#candidate?.pointerId === pointerId
        && this.#candidate.button === DELETE_BUTTON && now - this.#candidate.time <= ZOOM_SEQUENCE_WINDOW) {
        this.#candidate = null;
        this.#zoom = { pointerId };
        return 'zoom-hold';
      }
      if (this.#candidate && (this.#candidate.pointerId !== pointerId || this.#candidate.button !== cleanButton)) this.#candidate = null;
      state.press = { button: cleanButton, time: now, x, y, valid: !pressed };
    }
    return action;
  }
}
