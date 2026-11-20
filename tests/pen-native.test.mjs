import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PenInput } from '../src/core/pen-input.mjs';
import { PenButtonShortcuts } from '../src/core/pen-shortcuts.mjs';

const require = createRequire(import.meta.url);
const { parseLine, parsePlace, pagePoint, parseAccess, helperPath, createNativePen, RELEASED } = require('../src/main/native-pen.cjs');
const { penAccessPrompt } = require('../src/main/pen-access.cjs');

test('helper lines become switch states and nothing else does', () => {
	assert.deepEqual(parseLine('{"k":"buttons","tip":false,"lower":true,"upper":false,"range":true}'), { tip: false, lower: true, upper: false, range: true });
	assert.deepEqual(parseLine('{"k":"buttons","tip":true,"lower":false,"upper":true,"range":true}'), { tip: true, lower: false, upper: true, range: true });
	for (const line of ['', 'not json', '{"k":"opened","pid":974}', '{"k":"raw","hex":"1e"}', '[]', 'null', '{"k":"buttons","lower":"yes"}']) {
		const state = parseLine(line);
		assert.ok(state === null || (state.lower === false && state.upper === false), line);
	}
	assert.equal(parseLine('{"k":"opened","pid":974}'), null);
});

test('the helper is looked for beside the packaged app or in build/bin, and only on a Mac', () => {
	const present = () => true, absent = () => false;
	assert.equal(helperPath({ packaged: true, resourcesPath: '/App/Contents/Resources', root: '/src', platform: 'darwin', exists: present }), '/App/Contents/Resources/scroll-pen');
	assert.equal(helperPath({ packaged: false, resourcesPath: '/x', root: '/src', platform: 'darwin', exists: present }), '/src/build/bin/scroll-pen');
	assert.equal(helperPath({ packaged: true, resourcesPath: '/x', root: '/src', platform: 'darwin', exists: absent }), null);
	assert.equal(helperPath({ packaged: true, resourcesPath: '/x', root: '/src', platform: 'win32', exists: present }), null);
	assert.equal(helperPath({ packaged: true, resourcesPath: '/x', root: '/src', platform: 'linux', exists: present }), null);
});

function fakeProcess() {
	const process = new EventEmitter();
	process.stdout = new EventEmitter();
	process.stdin = { ended: false, end() { this.ended = true; } };
	process.killed = false;
	process.kill = () => { process.killed = true; };
	return process;
}

test('lines split across chunks reach the window in order, a gone helper releases every button and is started again', () => {
	const states = [], timers = [], processes = [], logs = [];
	const pen = createNativePen({
		file: '/helper', onState: state => states.push(state), log: text => logs.push(text),
		start: () => { const process = fakeProcess(); processes.push(process); return process; },
		setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {},
	});
	pen.start();
	pen.start();
	assert.equal(processes.length, 1, 'one helper at a time');
	processes[0].stdout.emit('data', '{"k":"opened","pid":974}\n{"k":"buttons","tip":false,"low');
	processes[0].stdout.emit('data', 'er":false,"upper":true,"range":true}\n{"k":"buttons","tip":false,"lower":false,"upper":false,"range":true}\n');
	assert.deepEqual(states.map(state => state.upper), [true, false]);
	assert.deepEqual(logs, ['helper: {"k":"opened","pid":974}', 'buttons lower=false upper=true', 'buttons lower=false upper=false']);
	processes[0].emit('exit', 3);
	assert.equal(logs.at(-1), 'helper exited (3)');
	assert.deepEqual(states.at(-1), RELEASED);
	assert.equal(timers.at(-1).ms, 3000);
	timers.at(-1).fn();
	assert.equal(processes.length, 2, 'a helper that exited is started again');
	pen.stop();
	assert.equal(processes[1].killed, true);
	assert.equal(processes[1].stdin.ended, true);
	processes[1].emit('exit', 0);
	assert.equal(processes.length, 2, 'a stopped reader stays stopped');
});

test('a helper that cannot start leaves the pen to its ordinary events', () => {
	const logs = [];
	const pen = createNativePen({ file: '/helper', onState() { assert.fail('no state'); }, start() { throw new Error('ENOENT'); }, log: text => logs.push(text) });
	pen.start();
	assert.match(logs[0], /ENOENT/);
	assert.equal(createNativePen({ file: null, onState() {} }).start(), undefined);
});

// ---- the display's switches through PenInput and the button recognizers

const hover = (x = 400, y = 300, buttons = 0) => ({ type: 'pointermove', pointerType: 'pen', pointerId: 44, clientX: x, clientY: y, pressure: 0, buttons, button: -1 });
function rig() {
	const input = new PenInput(), shortcuts = new PenButtonShortcuts({ navigation: true });
	const actions = [];
	const feed = (event, at) => { const action = shortcuts.update(event, at); if (action) actions.push(action); return event; };
	return { input, shortcuts, actions, hover: (x = 400, y = 300, at = 0, buttons = 0) => feed(input.update(hover(x, y, buttons), at), at), native: (state, at) => { const events = input.native(state, at); events.forEach(event => feed(event, at)); return events; } };
}
const press = (r, key, at) => { r.native({ [key]: true, range: true }, at); r.native({ range: true }, at + 60); };

test('an upper switch the driver never sends as a click still redoes on a double tap', () => {
	const r = rig();
	r.hover(400, 300, 0);
	press(r, 'upper', 100); assert.deepEqual(r.actions, []);
	press(r, 'upper', 300); assert.deepEqual(r.actions, ['redo']);
});

test('a lower switch reported only by the display undoes on a double tap, and one tap does nothing', () => {
	const r = rig();
	r.hover();
	press(r, 'lower', 100); assert.deepEqual(r.actions, []);
	press(r, 'lower', 300); assert.deepEqual(r.actions, ['undo']);
});

test('lower then upper, quickly, arms the zoom stroke; the other order or a long pause does not', () => {
	let r = rig();
	r.hover();
	press(r, 'lower', 100); press(r, 'upper', 300);
	assert.deepEqual(r.actions, ['zoom-next']);
	r = rig(); r.hover();
	press(r, 'upper', 100); press(r, 'lower', 300);
	assert.deepEqual(r.actions, []);
	r = rig(); r.hover();
	press(r, 'lower', 100); press(r, 'upper', 1100);
	assert.deepEqual(r.actions, []);
});

test('the driver scrolling during an upper press means that press was not a tap', () => {
	const r = rig();
	r.hover();
	r.native({ upper: true, range: true }, 100);
	assert.equal(r.input.upperHeld, true);
	r.shortcuts.cancel();
	r.native({ range: true }, 160);
	assert.equal(r.input.upperHeld, false);
	press(r, 'upper', 300);
	assert.deepEqual(r.actions, [], 'the cancelled press left no half of a double tap behind');
	press(r, 'upper', 500);
	assert.deepEqual(r.actions, ['redo']);
});

test('the merged buttons ride every page event, the page keeps contact, and the same switch from two routes counts once', () => {
	const r = rig();
	r.hover(400, 300, 50);
	const [down] = r.native({ lower: true, range: true }, 100);
	assert.equal(down.type, 'pointerdown');
	assert.equal(down.buttons, 2);
	assert.equal(down.clientX, 400);
	assert.equal(down.clientY, 300);
	assert.equal(down.pointerType, 'pen');
	assert.deepEqual(r.native({ lower: true, range: true }, 110), [], 'no change, no event');
	// The same switch arriving as the driver's right click adds nothing.
	const echoed = r.input.update({ ...hover(400, 300, 2), type: 'pointerdown', button: 2, pressure: 0 }, 120);
	assert.equal(echoed.buttons, 2);
	// A tip touch carries both the tip and the switch.
	const touch = r.input.update({ ...hover(400, 300, 1), type: 'pointermove', pressure: .6, button: 0 }, 130);
	assert.equal(touch.buttons, 3);
	assert.equal(touch.tipStarted, true);
	// The page's own pointerup does not release a switch the display still holds.
	const up = r.input.update({ ...hover(400, 300, 0), type: 'pointerup', button: 0, pressure: 0 }, 140);
	assert.equal(up.buttons, 2);
	const [released] = r.native({ range: true }, 150);
	assert.equal(released.type, 'pointerup');
	assert.equal(released.buttons, 0);
});

test('both switches moving at once report as one event each, in order, and a press with no pen seen yet still counts', () => {
	const r = rig();
	const both = r.input.native({ lower: true, upper: true, range: true }, 10);
	assert.deepEqual(both.map(event => [event.type, event.button, event.buttons]), [['pointerdown', 2, 2], ['pointerdown', 1, 6]]);
	assert.deepEqual(r.input.native({ range: true }, 70).map(event => [event.type, event.button, event.buttons]), [['pointerup', 2, 4], ['pointerup', 1, 0]]);
	// A press as the very first thing the recognizers ever see is a press, not a button that was already held.
	const fresh = rig();
	fresh.native({ upper: true, range: true }, 100); fresh.native({ range: true }, 160);
	fresh.native({ upper: true, range: true }, 300); fresh.native({ range: true }, 360);
	assert.deepEqual(fresh.actions, ['redo']);
});

test('with no pen seen yet the first switch change still reports, and reset forgets what the display held', () => {
	const input = new PenInput();
	const [first] = input.native({ upper: true, range: true }, 10);
	assert.equal(first.buttons, 4);
	assert.deepEqual([first.clientX, first.clientY], [0, 0]);
	input.reset();
	assert.equal(input.upperHeld, false);
	assert.equal(input.update(hover(5, 5), 20).buttons, 0);
});

test('a pen the display reports in range owns the mouse-class events at its position however long it has hovered still', () => {
	const input = new PenInput();
	input.update(hover(400, 300), 1000);
	const click = (x, y) => ({ type: 'pointerdown', pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y, buttons: 2, button: 2 });
	assert.equal(input.isNear(click(400, 300), 3000), false, 'a pause longer than the time limit, display silent');
	input.native({ range: true }, 1600);
	assert.equal(input.inRange, true);
	assert.equal(input.isNear(click(400, 300), 9000), true, 'in range: still the pen');
	assert.equal(input.isNear(click(400, 340), 9000), false, 'a mouse that is somewhere else is a mouse');
	assert.equal(input.update(click(402, 301), 9100).pointerType, 'pen', 'the lower button tapped after a long hover is the pen\'s');
	input.native({ range: false }, 9500);
	assert.equal(input.isNear(click(400, 300), 20000), false, 'out of range: back to the time limit');
	assert.equal(new PenInput().isNear(click(1, 1)), false);
	const fresh = new PenInput();
	fresh.native({ range: true }, 5);
	assert.equal(fresh.isNear(click(1, 1), 10), true, 'in range, the page has not seen the pen move yet');
});

test('the display\'s own tip sensor decides contact when a held barrel button leaves the page no tip bit', () => {
	const input = new PenInput();
	input.update(hover(400, 300), 10);
	input.native({ lower: true, range: true }, 20);
	// Hold alone: the pen hovers, moving across ink, and nothing is in contact.
	const hovering = input.update(hover(420, 300, 2), 30);
	assert.equal(hovering.tipDown, false);
	assert.equal(hovering.tipStarted, false);
	// Pressure the page sees while the display says the tip is up (a default hover pressure) is not contact.
	assert.equal(input.update({ ...hover(430, 300, 2), pressure: .5 }, 40).tipDown, false);
	// The tip touches: the display says so and the page sees pressure, with no tip bit and no button change.
	input.native({ lower: true, tip: true, range: true }, 50);
	const touch = input.update({ ...hover(440, 300, 2), pressure: .6 }, 60);
	assert.equal(touch.tipDown, true);
	assert.equal(touch.tipStarted, true);
	assert.equal(touch.buttons, 3);
	// Dragging with the tip down stays in contact without starting again.
	const drag = input.update({ ...hover(460, 300, 2), pressure: .7 }, 70);
	assert.equal(drag.tipDown, true);
	assert.equal(drag.tipStarted, false);
	// Lifting: the pressure falls and contact ends while the button stays held; the next touch starts again.
	input.native({ lower: true, range: true }, 80);
	assert.equal(input.update(hover(460, 300, 2), 90).tipDown, false);
	input.native({ lower: true, tip: true, range: true }, 100);
	assert.equal(input.update({ ...hover(470, 300, 2), pressure: .6 }, 110).tipStarted, true);
	// With no display reports at all, the page's own rules stand: pressure without a tip bit or a touch edge is not contact.
	const plain = new PenInput();
	plain.update(hover(1, 1), 1);
	assert.equal(plain.update({ ...hover(2, 2, 2), pressure: .6 }, 2).tipDown, false);
});

test('Input Monitoring answers are read from helper lines and nothing else counts', () => {
	for (const value of ['granted', 'denied', 'undetermined']) assert.equal(parseAccess(`{"k":"access","v":"${value}"}`), value);
	for (const line of ['', 'x', '{"k":"access","v":"maybe"}', '{"k":"opened"}', '{"k":"buttons","v":"granted"}', 'null']) assert.equal(parseAccess(line), null, line);
});

test('the reader reports Input Monitoring and whether a display is open, and asks macOS through the helper', async () => {
	const statuses = [], logs = [], processes = [], asked = [];
	const pen = createNativePen({
		file: '/helper', onState() {}, onAccess: status => statuses.push(status), log: text => logs.push(text),
		start: () => { const process = fakeProcess(); processes.push(process); return process; },
		ask: (file, args, options, done) => { asked.push([file, args]); done(null, '{"k":"access","v":"granted"}\n'); },
		setTimer: () => 0, clear: () => {},
	});
	pen.start();
	assert.deepEqual(pen.status(), { access: null, opened: false });
	processes[0].stdout.emit('data', '{"k":"access","v":"denied"}\n{"k":"opened","pid":974}\n');
	assert.deepEqual(statuses.at(-1), { access: 'denied', opened: true });
	assert.deepEqual(pen.status(), { access: 'denied', opened: true });
	assert.ok(logs.includes('input monitoring: denied'));
	processes[0].stdout.emit('data', '{"k":"access","v":"granted"}\n');
	assert.equal(pen.status().access, 'granted');
	processes[0].stdout.emit('data', '{"k":"closed","why":"the display was unplugged"}\n');
	assert.equal(pen.status().opened, false);
	assert.equal(await pen.requestAccess(), 'granted');
	assert.deepEqual(asked, [['/helper', ['--request-access']]]);
	assert.equal(await createNativePen({ file: null, onState() {} }).requestAccess(), null);
});

test('a pen display with macOS holding its reports back gets one plain prompt; everything else stays quiet unless asked', () => {
	const held = penAccessPrompt({ access: 'undetermined', opened: true });
	assert.equal(held.opensSettings, true);
	assert.match(held.detail, /Input Monitoring/);
	assert.deepEqual(held.buttons, ['Open System Settings', 'Not Now']);
	assert.equal(penAccessPrompt({ access: 'denied', opened: true }).opensSettings, true);
	assert.equal(penAccessPrompt({ access: 'granted', opened: true }), null);
	assert.equal(penAccessPrompt({ access: 'denied', opened: false }), null);
	assert.equal(penAccessPrompt({ access: null, opened: false }), null);
	assert.match(penAccessPrompt({ access: 'granted', opened: true }, { manual: true }).message, /buttons are on/);
	assert.match(penAccessPrompt({ access: null, opened: false }, { manual: true }).message, /No supported pen display/);
	assert.equal(penAccessPrompt({ access: 'denied', opened: true }, { manual: true }).opensSettings, true);
});

test('the display\'s place for its pen rides the switch states and its own lines, and only a real place counts', () => {
	assert.deepEqual(parseLine('{"k":"buttons","tip":true,"lower":true,"upper":false,"range":true,"x":0.5,"y":0.25,"p":0.6}'),
		{ tip: true, lower: true, upper: false, range: true, x: .5, y: .25, p: .6 });
	// Out of range the pen is nowhere, whatever the line carries.
	assert.deepEqual(parseLine('{"k":"buttons","tip":false,"lower":false,"upper":false,"range":false,"x":0.5,"y":0.25,"p":0}'), RELEASED);
	assert.deepEqual(parseLine('{"k":"buttons","tip":false,"lower":true,"upper":false,"range":true,"x":1.5,"y":0.25}'),
		{ tip: false, lower: true, upper: false, range: true });
	assert.deepEqual(parsePlace('{"k":"at","x":0.75,"y":1,"p":0}'), { x: .75, y: 1, p: 0 });
	for (const line of ['{"k":"at","x":-0.1,"y":0.5}', '{"k":"at","x":"0.5","y":0.5}', '{"k":"buttons","x":0.5,"y":0.5}', 'at', '']) assert.equal(parsePlace(line), null, line);
});

test('a place on the display becomes a point in the window\'s page, through where the window sits, a turned display and page zoom', () => {
	const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, rotation: 0 };
	assert.deepEqual(pagePoint({ x: .5, y: .5 }, display, { x: 0, y: 0, width: 1920, height: 1080 }), { clientX: 960, clientY: 540 });
	// A window with a title bar, away from the display's corner.
	assert.deepEqual(pagePoint({ x: .5, y: .5 }, display, { x: 100, y: 78, width: 1200, height: 800 }), { clientX: 860, clientY: 462 });
	// A second display to the right of the first.
	assert.deepEqual(pagePoint({ x: 0, y: 1 }, { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, rotation: 0 }, { x: 2000, y: 100, width: 800, height: 600 }), { clientX: -80, clientY: 980 });
	assert.deepEqual(pagePoint({ x: .25, y: .5 }, { ...display, rotation: 180 }, { x: 0, y: 0, width: 1920, height: 1080 }), { clientX: 1440, clientY: 540 });
	assert.deepEqual(pagePoint({ x: .5, y: .5 }, display, { x: 0, y: 0, width: 1920, height: 1080 }, 2), { clientX: 480, clientY: 270 });
});

test('the reader keeps the switches and adds each new place while one is held', () => {
	const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end() {} }, kill() {} });
	const states = [];
	const pen = createNativePen({ file: '/helper', onState: state => states.push(state), start: () => child, setTimer: () => 0, clear: () => {} });
	pen.start();
	child.stdout.emit('data', '{"k":"buttons","tip":false,"lower":true,"upper":false,"range":true,"x":0.5,"y":0.5,"p":0}\n{"k":"at","x":0.6,"y":0.5,"p":0}\n');
	child.stdout.emit('data', '{"k":"buttons","tip":true,"lower":true,"upper":false,"range":true,"x":0.6,"y":0.5,"p":0.4}\n{"k":"at","x":0.7,"y":0.5,"p":0.5}\n');
	assert.deepEqual(states, [
		{ tip: false, lower: true, upper: false, range: true, x: .5, y: .5, p: 0 },
		{ tip: false, lower: true, upper: false, range: true, x: .6, y: .5, p: 0 },
		{ tip: true, lower: true, upper: false, range: true, x: .6, y: .5, p: .4 },
		{ tip: true, lower: true, upper: false, range: true, x: .7, y: .5, p: .5 },
	]);
	pen.stop();
});

const placed = (x, y, state = {}) => ({ range: true, clientX: x, clientY: y, p: state.tip ? .6 : 0, ...state });

test('a pen the display places: hold delete is a hover until the display\'s tip touches, and the driver\'s click for it is not used', () => {
	const input = new PenInput();
	input.update({ pointerType: 'pen', type: 'pointermove', buttons: 0, button: -1, pressure: 0, pointerId: 9, clientX: 100, clientY: 100 });
	const [down, hover] = input.native(placed(300, 250, { lower: true }));
	assert.equal(down.native, true);
	assert.deepEqual([down.type, down.buttons, down.clientX, down.clientY, down.tipDown], ['pointerdown', 2, 300, 250, false]);
	assert.deepEqual([hover.placed, hover.type, hover.buttons, hover.tipDown, hover.tipStarted, hover.pressure], [true, 'pointermove', 2, false, false, 0]);
	assert.equal(input.placing, true);
	// The driver's right click, with a hover click's pressure: tracked, and the page is told it is not the pen to act on.
	const click = input.update({ pointerType: 'pen', type: 'pointerdown', buttons: 2, button: 2, pressure: .5, pointerId: 9, clientX: 110, clientY: 100 });
	assert.equal(input.placing, true);
	assert.equal(click.pointerType, 'pen');
	const [touch] = input.native(placed(300, 250, { lower: true, tip: true }));
	assert.deepEqual([touch.placed, touch.buttons, touch.tipDown, touch.tipStarted, touch.clientX, touch.clientY], [true, 3, true, true, 300, 250]);
	assert.ok(touch.pressure > 0);
	const [drag] = input.native(placed(300, 400, { lower: true, tip: true }));
	assert.deepEqual([drag.buttons, drag.tipDown, drag.tipStarted, drag.clientY], [3, true, false, 400]);
	const [lift] = input.native(placed(300, 400, { lower: true }));
	assert.deepEqual([lift.buttons, lift.tipDown, lift.tipStarted, lift.pressure], [2, false, false, 0]);
	const [again] = input.native(placed(300, 420, { lower: true, tip: true }));
	assert.equal(again.tipStarted, true);
});

test('a pen the display places: a switch pressed with the tip down starts nothing, and letting it go mid-touch starts nothing either', () => {
	const input = new PenInput();
	const pen = (type, buttons, button, pressure) => input.update({ pointerType: 'pen', type, buttons, button, pressure, pointerId: 9, clientX: 300, clientY: 250 });
	assert.equal(pen('pointerdown', 1, 0, .5).tipStarted, true);
	input.native(placed(300, 250, { tip: true }));
	// The button goes down during the stroke: the display's touch is already under way, so no touch starts.
	const [down, held] = input.native(placed(300, 250, { lower: true, tip: true }));
	assert.equal(down.native, true);
	assert.deepEqual([held.placed, held.tipDown, held.tipStarted], [true, true, false]);
	assert.equal(input.native(placed(300, 300, { lower: true, tip: true }))[0].tipStarted, false);
	// It comes up with the tip still down: the page's own events take over, and that same touch does not begin a stroke.
	const [up] = input.native(placed(300, 300, { tip: true }));
	assert.deepEqual([up.native, up.type, input.placing], [true, 'pointerup', false]);
	input.update({ pointerType: 'pen', type: 'pointerup', buttons: 0, button: 0, pressure: 0, pointerId: 9, clientX: 300, clientY: 300 });
	assert.equal(pen('pointermove', 1, 0, .5).tipStarted, false);
	// After a real lift the next touch is a new stroke.
	input.native(placed(300, 300));
	pen('pointermove', 0, -1, 0);
	assert.equal(pen('pointerdown', 1, 0, .5).tipStarted, true);
});

test('a pen the display places: the upper switch carries the pen\'s moves, hovering or touching, and with no place the page keeps contact', () => {
	const input = new PenInput();
	const [down, first] = input.native(placed(750, 500, { upper: true }));
	assert.deepEqual([down.button, down.buttons, first.buttons, first.clientX, first.clientY], [1, 4, 4, 750, 500]);
	const [second] = input.native(placed(690, 420, { upper: true }));
	assert.deepEqual([second.placed, second.buttons, second.clientX, second.clientY, second.tipDown], [true, 4, 690, 420, false]);
	const [touching] = input.native(placed(690, 400, { upper: true, tip: true }));
	assert.deepEqual([touching.buttons, touching.tipDown, touching.tipStarted], [5, true, true]);
	const [up] = input.native(placed(690, 400));
	assert.deepEqual([up.native, up.type, up.buttons & 4, input.placing], [true, 'pointerup', 0, false]);
	assert.deepEqual(input.native(placed(600, 300)), []);
	// A display that reports switches and no place: nothing is placed, as before.
	const plain = new PenInput();
	assert.deepEqual(plain.native({ lower: true, range: true }).map(event => event.native), [true]);
	assert.equal(plain.placing, false);
});
