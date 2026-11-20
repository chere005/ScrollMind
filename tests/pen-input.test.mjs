import test from 'node:test';
import assert from 'node:assert/strict';
import { PenInput } from '../src/core/pen-input.mjs';
import { PenButtonShortcuts } from '../src/core/pen-shortcuts.mjs';

function event(pointerType, type, buttons, button, pressure = 0, x = 400) {
	return { pointerType, type, buttons, button, pressure, pointerId: pointerType === 'pen' ? 9 : 1, clientX: x, clientY: 400 };
}

test('mixed mouse barrel and native pen contact form one erase stream, including a missing tip bit', () => {
	const input = new PenInput();
	const hover = input.update(event('pen', 'pointermove', 0, -1));
	const lower = input.update(event('mouse', 'pointerdown', 2, 2, .5));
	assert.equal(lower.pointerId, hover.pointerId);
	assert.equal(lower.tipDown, false);
	const contact = input.update(event('pen', 'pointermove', 0, 0, .37));
	assert.equal(contact.buttons, 3);
	assert.equal(contact.tipStarted, true);
	const move = input.update(event('pen', 'pointermove', 0, -1, .42));
	assert.equal(move.buttons, 3);
	assert.equal(move.tipStarted, false);
	assert.equal(input.update(event('pen', 'pointermove', 0, 0)).tipDown, false);
	assert.equal(input.update(event('mouse', 'pointerup', 0, 2)).buttons, 0);
});

test('lower and upper clicks from different renderer streams can arm the same next drag', () => {
	const input = new PenInput();
	const shortcuts = new PenButtonShortcuts({ navigation: true });
	const inputs = [
		event('pen', 'pointerdown', 2, 2, .5),
		event('pen', 'pointerup', 0, 2),
		event('mouse', 'pointerdown', 4, 1, .5),
		event('mouse', 'pointerup', 0, 1),
	];
	assert.deepEqual(inputs.map((sample, i) => shortcuts.update(input.update(sample, 50 * i), 50 * i)), [null, null, null, 'drag-next']);
});

test('ordinary mouse input stays mouse when it is away from the pen', () => {
	const input = new PenInput();
	input.update(event('pen', 'pointermove', 0, -1), 100);
	const click = event('mouse', 'pointerdown', 1, 0, .5, 650);
	assert.equal(input.update(click, 120), click);
	const near = input.update(event('mouse', 'pointerdown', 1, 0, .5), 130);
	assert.equal(near.pointerType, 'pen');
	assert.equal(near.tipStarted, true);
	assert.equal(input.update(event('mouse', 'pointerup', 0, 0, 0, 650), 180).tipDown, false);
});

test('a macOS lower-button click with actual pressure starts contact while default hover pressure does not', () => {
	const input = new PenInput();
	const hover = input.update(event('pen', 'pointerdown', 2, 2, .5));
	assert.equal(hover.tipStarted, false);
	input.update(event('pen', 'pointerup', 0, 2));
	const tap = input.update(event('pen', 'pointerdown', 2, 2, .39));
	assert.equal(tap.tipStarted, true);
	assert.equal(tap.buttons, 3);
});

test('a side switch releases even when the driver splits its down and up across event sources', () => {
	const input = new PenInput();
	assert.equal(input.update(event('pen', 'pointerdown', 2, 2)).buttons, 2);
	assert.equal(input.update(event('mouse', 'pointerup', 0, 2)).buttons, 0);
	assert.equal(input.update(event('mouse', 'pointerdown', 4, 1)).buttons, 4);
	assert.equal(input.update(event('pen', 'pointerup', 0, 1)).buttons, 0);
	assert.equal(input.update(event('pen', 'pointerdown', 1, 0, .6)).buttons, 1);
});
