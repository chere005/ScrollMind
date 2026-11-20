const TIP = 1;
const LOWER = 2;
const UPPER = 4;
const REAR = 32;
const PEN_POINTER_ID = -2;
const MOUSE_NEAR_PEN_MS = 1250;
const MOUSE_NEAR_PEN_PX = 20;
const buttonBit = button => [TIP, UPPER, LOWER][button] ?? 0;

/**
 * Combine Wacom button events delivered as mouse input with the tablet's tip stream, and the side switches the display
 * itself reports (native()). The driver can turn a switch into a click, into Pan/Scroll or into nothing the page sees;
 * the display's own report always says which switch moved, so its state is merged into every event's buttons.
 */
export class PenInput {
	#sample = null;
	#hid = { lower: false, upper: false };
	#nativePointerId = null;
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
		this.#hid = { lower: false, upper: false };
	}

	#hidButtons() { return (this.#hid.lower ? LOWER : 0) | (this.#hid.upper ? UPPER : 0); }

	/** The upper switch is down, by whichever route the page can learn it. */
	get upperHeld() { return Boolean((this.#nativeButtons | this.#mouseButtons | this.#hidButtons()) & UPPER); }

	/** The display's side switches as last reported. */
	get hid() { return { ...this.#hid }; }

	/**
	 * The display's side switches changed. Returns the pen events for each switch that moved (a down or an up, as a click would
	 * be), carrying the merged buttons at the pen's last position, for the button recognizers to see; none when nothing changed.
	 * Contact stays with the page's own pen events.
	 */
	native(state, now = performance.now()) {
		const events = [];
		for (const [key, button] of [['lower', 2], ['upper', 1]]) {
			const held = state?.[key] === true;
			if (held === this.#hid[key]) continue;
			this.#hid[key] = held;
			const at = this.#sample ?? { x: 0, y: 0 };
			events.push({
				type: held ? 'pointerdown' : 'pointerup', button, buttons: this.#merged(), pointerId: PEN_POINTER_ID,
				nativePointerId: this.#nativePointerId ?? PEN_POINTER_ID, pointerType: 'pen', clientX: at.x, clientY: at.y, shiftKey: false,
				pressure: this.#tipDown ? .5 : 0, tipDown: this.#tipDown, tipStarted: false,
				preventDefault: () => {}, getCoalescedEvents: undefined, now,
				// Marks a change of the display's switches: for the button recognizers and the tool, never the start of a drag.
				native: true,
			});
		}
		return events;
	}

	#merged() { return ((this.#nativeButtons | this.#mouseButtons | this.#hidButtons()) & ~TIP) | (this.#tipDown ? TIP : 0); }

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
			this.#nativePointerId = event.pointerId;
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
		const buttons = this.#merged();
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
