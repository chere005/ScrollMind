import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The pen buttons are a fixed contract (docs/PEN-BUTTONS.md): it must never break. This keeps the page stating it, and keeps the
// tests that hold it from being removed or renamed away. Changing a row here needs Sean's explicit word, with the page and the
// behavior tests in the same change.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the pen-button page states the contract, row by row', () => {
	const page = read('docs/PEN-BUTTONS.md');
	for (const row of [
		'| **Lower held, tip taps or drags** | **Delete:** erases what the tip touches. |',
		'| **Lower double-tap** | **Undo** |',
		'| **Upper held, tip drags** | **Scroll:** the page follows the tip. |',
		'| **Upper double-tap** | **Redo** |',
		'| **Lower tapped, then upper held, tip drags** | **Zoom** around where the tip touched: drag up to zoom in, down to zoom out. |',
	]) assert.ok(page.includes(row), row);
	for (const rule of ['**Holding a button alone does nothing.**', '**A held button is a mode until it is let go.**', 'It must never break.']) {
		assert.ok(page.includes(rule), rule);
	}
});

test('the tests that hold the contract are still there, in Scroll and Grid mode', () => {
	const ui = read('tests/ui.spec.mjs');
	assert.ok(ui.includes("for (const mode of ['scroll', 'grid']) {\n\ttest.describe(`Pen button contract: ${mode}`"), 'the contract runs in both modes');
	for (const title of [
		'lower button: hold and tap erases that stroke, hold and drag erases what it crosses, each erase undoes alone',
		'lower button: a single tap does nothing and a double tap while hovering undoes',
		'upper button: a single tap does nothing and a double tap while hovering redoes',
		'lower tapped, then upper held: every tap and drag zooms until the upper button is let go',
		'display buttons: hold delete deletes nothing until the tip touches, then every tap or drag deletes while it stays held',
		'display buttons: lower tapped, then upper held, zooms on every tap and drag until the upper switch lets go',
		'display pen: hold delete deletes nothing until the display says the tip touches, then only where it touches',
		'display pen: the delete button pressed during a stroke ends it and deletes nothing until the tip lifts and touches again',
		"display pen: hold the upper button, then touch and drag scrolls; hovering scrolls nothing, and the driver\\'s own scrolling adds nothing",
		"display pen: the driver\\'s right click reaching the page before the display\\'s report of the button deletes nothing",
		'display pen: a double tap of the upper button redoes even while the driver scrolls for that button',
		'display pen: lower tapped, then upper held, is zoom mode for every touch until the upper button lets go',
		'lower then upper in the wrong order, or after a pause, leaves the pen normal',
	]) assert.ok(ui.includes(`test('${title}'`), title);
	const scripts = JSON.parse(read('package.json')).scripts;
	for (const file of ['tests/pen-shortcuts.test.mjs', 'tests/pen-input.test.mjs', 'tests/pen-native.test.mjs', 'tests/pen-helper.test.mjs', 'Pen button contract']) {
		assert.ok(scripts['test:pen'].includes(file), `npm run test:pen runs ${file}`);
	}
	assert.match(scripts.preflight, /npm test && npm run test:ui/, 'preflight runs every unit test and every UI test');
});

test('the controls guide and the agent rules point at the contract', () => {
	assert.ok(read('docs/CONTROLS.md').includes('(PEN-BUTTONS.md)'));
	assert.ok(read('AGENTS.md').includes('docs/PEN-BUTTONS.md'));
	assert.ok(read('README.md').includes('docs/PEN-BUTTONS.md'));
});
