const TIP = 1;
const LOWER = 2;
const UPPER = 4;
const REAR = 32;
const PEN_POINTER_ID = -2;
const MOUSE_NEAR_PEN_MS = 1250;
const MOUSE_NEAR_PEN_PX = 20;
const buttonBit = button => [TIP, UPPER, LOWER][button] ?? 0;

/** Combine Wacom button events delivered as mouse input with the tablet's tip stream. */
export class PenInput {
	#sample = null;
	#nativeButtons = 0;
	#mouseButtons = 0;
	#mousePointerId = null;
	#tipDown = false;
	#pressureTip = false;
	#known = false;
	#windowsInk;

	constructor({ windowsInk = false } = {}) { this.#windowsInk = windowsInk; }

	reset() {
		this.#sample = null;
		this.#nativeButtons = this.#mouseButtons = 0;
		this.#mousePointerId = null;
		this.#tipDown = this.#pressureTip = this.#known = false;
	}

	isNear(event, now = performance.now()) {
		return this.#sample && now - this.#sample.time <= MOUSE_NEAR_PEN_MS
			&& Math.hypot(event.clientX - this.#sample.x, event.clientY - this.#sample.y) <= MOUSE_NEAR_PEN_PX;
	}

	update(event, now = performance.now()) {
		const native = event.pointerType === 'pen';
		const mouse = event.pointerType === 'mouse';
		if (!native && !mouse) return event;
		const { type, button } = event;
		const down = type === 'pointerdown', up = type === 'pointerup';
		const tipEdge = button === 0 && !up && (down || event.pressure > 0);
		const previouslyDown = this.#tipDown;
		if (native) {
			this.#sample = { x: event.clientX, y: event.clientY, time: now };
			if (up) {
				this.#mouseButtons &= ~buttonBit(button);
				if (!this.#mouseButtons) this.#mousePointerId = null;
			}
			this.#nativeButtons = event.buttons;
			const tipBit = Boolean(event.buttons & TIP);
			// A pressured lower-button down may be the tip contact in Click & Tap mode.
			// A macOS hover click can carry Chromium's default button pressure of 0.5.
			const barrelContact = down && button === 2 && Boolean(event.buttons & LOWER) && !(event.buttons & REAR)
				&& (this.#windowsInk || event.pressure !== .5);
			this.#pressureTip = !tipBit && !up && event.pressure > 0 && (tipEdge || barrelContact || this.#pressureTip);
			this.#tipDown = (tipBit || tipEdge || this.#pressureTip || Boolean(this.#mouseButtons & TIP)) && !(up && button === 0);
		} else {
			const tracked = this.#mousePointerId === event.pointerId;
			const bit = buttonBit(button);
			const penEdge = bit && (down || up && (this.#nativeButtons & bit)) && this.isNear(event, now);
			if (!tracked && !penEdge) return event;
			this.#mouseButtons = event.buttons & (TIP | LOWER | UPPER);
			this.#mousePointerId = this.#mouseButtons ? event.pointerId : null;
			if (up) {
				this.#nativeButtons &= ~bit;
				if (bit === TIP) this.#pressureTip = false;
			}
			this.#tipDown = Boolean((this.#nativeButtons | this.#mouseButtons) & TIP) || this.#pressureTip;
		}
		const buttons = ((this.#nativeButtons | this.#mouseButtons) & ~TIP) | (this.#tipDown ? TIP : 0);
		const tipStarted = this.#tipDown && !previouslyDown && (this.#known || down);
		this.#known = true;
		return {
			type, button, buttons, pointerId: PEN_POINTER_ID, nativePointerId: event.pointerId, pointerType: 'pen',
			clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey,
			pressure: native ? event.pressure : this.#tipDown ? .5 : 0,
			tipDown: this.#tipDown, tipStarted,
			preventDefault: () => event.preventDefault(),
			getCoalescedEvents: native ? () => event.getCoalescedEvents?.() : undefined,
		};
	}
}
