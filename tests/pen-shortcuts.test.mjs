import test from 'node:test';
import assert from 'node:assert/strict';
import { PenButtonShortcuts } from '../src/core/pen-shortcuts.mjs';

const event = (type, buttons, extra = {}) => ({ type, buttons, pointerType: 'pen', pointerId: 44, clientX: 100, clientY: 100, pressure: 0.5, ...extra });
function click(shortcuts, button, start, { duration = 40, pointerId = 44, type = 'pointerdown', releaseType = 'pointerup', x = 100, y = 100 } = {}) {
  assert.equal(shortcuts.update(event(type, button, { pointerId, clientX: x, clientY: y }), start), null);
  return shortcuts.update(event(releaseType, 0, { pointerId, clientX: x, clientY: y }), start + duration);
}

test('delete double-click fires undo only on the second completed release', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.equal(click(shortcuts, 2, 0), null);
  assert.equal(shortcuts.update(event('pointerdown', 2), 100), null);
  assert.equal(shortcuts.update(event('pointermove', 2), 120), null);
  assert.equal(shortcuts.update(event('pointerup', 0), 140), 'undo');
});

test('scroll double-click fires redo and chords reported only as moves still work', () => {
  const shortcuts = new PenButtonShortcuts();
  shortcuts.update(event('pointermove', 0), 0);
  assert.equal(click(shortcuts, 4, 10, { type: 'pointermove', releaseType: 'pointermove' }), null);
  assert.equal(click(shortcuts, 4, 100, { type: 'pointermove', releaseType: 'pointermove' }), 'redo');
});

test('each nonoverlapping pair fires once; a third click starts a new pair', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.deepEqual([0, 100, 200, 300].map(time => click(shortcuts, 2, time)), [null, 'undo', null, 'undo']);
});

test('a long hold invalidates the preceding click rather than completing undo', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 2, 0);
  assert.equal(click(shortcuts, 2, 100, { duration: 501 }), null);
  assert.equal(click(shortcuts, 2, 700), null);
  assert.equal(click(shortcuts, 2, 790), 'undo');
});

test('barrel-and-tip deletion taps and rear erasing never count as shortcut clicks', () => {
  for (const contact of [1, 32]) {
    const shortcuts = new PenButtonShortcuts();
    click(shortcuts, 2, 0);
    shortcuts.update(event('pointerdown', 2), 100);
    assert.equal(shortcuts.update(event('pointermove', 2 | contact), 110), null);
    shortcuts.update(event('pointermove', 2), 120);
    assert.equal(shortcuts.update(event('pointerup', 0), 130), null);
    assert.equal(click(shortcuts, 2, 150), null);
    assert.equal(click(shortcuts, 2, 250), 'undo');
  }
});

test('pressing a barrel button during writing does not establish a click', () => {
  const shortcuts = new PenButtonShortcuts();
  shortcuts.update(event('pointerdown', 1), 0);
  shortcuts.update(event('pointermove', 3), 10);
  shortcuts.update(event('pointermove', 2), 20);
  assert.equal(shortcuts.update(event('pointerup', 0), 30), null);
  assert.equal(click(shortcuts, 2, 100), null);
  assert.equal(click(shortcuts, 2, 200), 'undo');
});

test('button chords invalidate both the press and the prior matching click', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 2, 0);
  shortcuts.update(event('pointerdown', 2), 100);
  shortcuts.update(event('pointermove', 6), 110);
  shortcuts.update(event('pointermove', 2), 120);
  assert.equal(shortcuts.update(event('pointerup', 0), 130), null);
  assert.equal(click(shortcuts, 2, 150), null);
});

test('moving the pen past sixteen pixels and returning to the start still suppresses redo', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 4, 0);
  shortcuts.update(event('pointerdown', 4), 100);
  shortcuts.update(event('pointermove', 4, { clientY: 117 }), 110);
  shortcuts.update(event('pointermove', 4), 120);
  assert.equal(shortcuts.update(event('pointerup', 0), 130), null);
  assert.equal(click(shortcuts, 4, 150), null);
});

test('movement tolerance uses radial distance and includes release coordinates', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 4, 0);
  shortcuts.update(event('pointerdown', 4), 100);
  assert.equal(shortcuts.update(event('pointerup', 0, { clientX: 113, clientY: 113 }), 140), null);
  assert.equal(click(shortcuts, 4, 200), null);
  shortcuts.update(event('pointerdown', 4), 300);
  assert.equal(shortcuts.update(event('pointerup', 0, { clientX: 115 }), 340), 'redo');
});

test('an already-held button on the first unknown move is never mistaken for a press', () => {
  const shortcuts = new PenButtonShortcuts();
  shortcuts.update(event('pointermove', 2), 0);
  assert.equal(shortcuts.update(event('pointerup', 0), 40), null);
  assert.equal(click(shortcuts, 2, 100), null);
  assert.equal(click(shortcuts, 2, 200), 'undo');
});

test('different buttons reset the matching series instead of combining undo and redo clicks', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.equal(click(shortcuts, 2, 0), null);
  assert.equal(click(shortcuts, 4, 100), null);
  assert.equal(click(shortcuts, 2, 200), null);
  assert.equal(click(shortcuts, 2, 300), 'undo');
});

test('different pointer IDs cannot release each other or form one double-click', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.equal(click(shortcuts, 2, 0, { pointerId: 1 }), null);
  assert.equal(click(shortcuts, 2, 100, { pointerId: 2 }), null);
  assert.equal(click(shortcuts, 2, 200, { pointerId: 1 }), null);
  shortcuts.update(event('pointerdown', 2, { pointerId: 1 }), 300);
  assert.equal(shortcuts.update(event('pointerup', 0, { pointerId: 2 }), 320), null);
  assert.equal(shortcuts.update(event('pointerup', 0, { pointerId: 1 }), 340), 'undo');
});

test('mouse and touch events do not trigger or modify pen shortcut state', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 2, 0);
  for (const pointerType of ['mouse', 'touch']) {
    assert.equal(shortcuts.update(event('pointerdown', 2, { pointerType }), 60), null);
    assert.equal(shortcuts.update(event('pointerup', 0, { pointerType }), 80), null);
  }
  assert.equal(click(shortcuts, 2, 100), 'undo');
});

test('cancel, blur, and reset remove incomplete presses and matching click state', () => {
  for (const reset of [shortcuts => shortcuts.reset(), shortcuts => shortcuts.update(event('pointercancel', 2), 110), shortcuts => shortcuts.update({ type: 'blur' }, 110)]) {
    const shortcuts = new PenButtonShortcuts();
    click(shortcuts, 2, 0);
    shortcuts.update(event('pointerdown', 2), 100);
    reset(shortcuts);
    assert.equal(shortcuts.update(event('pointerup', 0), 140), null);
    assert.equal(click(shortcuts, 2, 200), null);
    assert.equal(click(shortcuts, 2, 300), 'undo');
  }
});

test('a press must begin within 400ms of the previous release, and backward timestamps cannot fire a stale shortcut', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 2, 0);
  assert.equal(click(shortcuts, 2, 441), null, 'the second press began 401 ms after the first release');
  assert.equal(click(shortcuts, 2, 500), 'undo');
  click(shortcuts, 2, 600);
  assert.equal(click(shortcuts, 2, 100), null);
  assert.equal(click(shortcuts, 2, 200), 'undo');
});

test('the exact click-duration and double-click-window boundaries remain usable', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.equal(click(shortcuts, 4, 0, { duration: 500 }), null);
  assert.equal(click(shortcuts, 4, 900, { duration: 500 }), 'redo');
});

test('pressureContact: barrel taps with pressure never count as an undo double-click, hover clicks still do', () => {
  const shortcuts = new PenButtonShortcuts({ pressureContact: true });
  const tap = start => {
    assert.equal(shortcuts.update(event('pointerdown', 2, { pressure: 0.5 }), start), null);
    return shortcuts.update(event('pointerup', 0, { pressure: 0 }), start + 40);
  };
  assert.equal(tap(0), null);
  assert.equal(tap(100), null);
  const hover = (button, start) => {
    shortcuts.update(event('pointerdown', button, { pressure: 0 }), start);
    return shortcuts.update(event('pointerup', 0, { pressure: 0 }), start + 40);
  };
  assert.equal(hover(2, 2000), null);
  assert.equal(hover(2, 2100), 'undo');
  assert.equal(hover(4, 3000), null);
  assert.equal(hover(4, 3100), 'redo');
});

test('default constructor still treats pressured button 2 as a hover press', () => {
  const shortcuts = new PenButtonShortcuts();
  const tap = start => { shortcuts.update(event('pointerdown', 2, { pressure: 0.5 }), start); return shortcuts.update(event('pointerup', 0, { pressure: 0 }), start + 40); };
  assert.equal(tap(0), null);
  assert.equal(tap(100), 'undo');
});

test('lower tapped then upper held is zoom mode until the upper button is let go; the double taps keep their history actions', () => {
	const shortcuts = new PenButtonShortcuts({ navigation: true });
	assert.equal(click(shortcuts, 2, 0), null);
	assert.equal(shortcuts.update(event('pointerdown', 4), 100), 'zoom-hold');
	assert.equal(shortcuts.zooming, true);
	// Touching, lifting and touching again, held for longer than any tap: still zoom mode, and nothing else fires.
	for (const [buttons, at] of [[5, 300], [4, 900], [5, 1200], [4, 1800]]) assert.equal(shortcuts.update(event('pointermove', buttons, { clientY: at / 10 }), at), null);
	assert.equal(shortcuts.update(event('pointerup', 0), 2000), 'zoom-end');
	assert.equal(shortcuts.zooming, false);
	// The chord's own press was no tap: one upper tap after it is only a first tap.
	assert.equal(click(shortcuts, 4, 2100), null);
	assert.equal(click(shortcuts, 4, 2250), 'redo');
	assert.equal(click(shortcuts, 2, 3000), null);
	assert.equal(click(shortcuts, 2, 3150), 'undo');
	// Upper tapped twice after a lower tap: the first upper press is the chord, so it zooms and ends; no redo from it.
	assert.equal(click(shortcuts, 2, 4000), null);
	assert.equal(shortcuts.update(event('pointerdown', 4), 4100), 'zoom-hold');
	assert.equal(shortcuts.update(event('pointerup', 0), 4150), 'zoom-end');
	assert.equal(click(shortcuts, 4, 4250), null);
});

test('the zoom chord allows a longer pause than a double tap, and the other order or a long pause is not a chord', () => {
	const shortcuts = new PenButtonShortcuts({ navigation: true });
	assert.equal(click(shortcuts, 2, 0), null);
	assert.equal(click(shortcuts, 2, 500), null);
	assert.equal(shortcuts.update(event('pointerdown', 4), 1100), 'zoom-hold');
	assert.equal(shortcuts.update(event('pointerup', 0), 1200), 'zoom-end');
	const other = new PenButtonShortcuts({ navigation: true });
	assert.equal(click(other, 4, 0), null);
	assert.equal(click(other, 2, 200), null);
	assert.equal(other.zooming, false);
	const late = new PenButtonShortcuts({ navigation: true });
	assert.equal(click(late, 2, 0), null);
	assert.equal(late.update(event('pointerdown', 4), 900), null);
	assert.equal(late.zooming, false);
});

test('a tap the display reports counts however far the pen drifts under the thumb; a driver-only tap still may not drift', () => {
	const shortcuts = new PenButtonShortcuts({ navigation: true });
	const tap = (button, at, dx, native) => {
		shortcuts.update(event('pointerdown', button, { native }), at);
		shortcuts.update(event('pointermove', button, { clientX: 100 + dx, placed: native }), at + 60);
		return shortcuts.update(event('pointerup', 0, { clientX: 100 + dx, native }), at + 120);
	};
	assert.equal(tap(2, 0, 24, true), null);
	assert.equal(tap(2, 200, 24, true), 'undo');
	assert.equal(tap(2, 1000, 24, false), null);
	assert.equal(tap(2, 1200, 24, false), null);
});
