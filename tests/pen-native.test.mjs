import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PenInput } from '../src/core/pen-input.mjs';
import { PenButtonShortcuts } from '../src/core/pen-shortcuts.mjs';

const require = createRequire(import.meta.url);
const { parseLine, helperPath, createNativePen, RELEASED } = require('../src/main/native-pen.cjs');

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
