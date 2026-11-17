import test from 'node:test';
import assert from 'node:assert/strict';
import { PenButtonShortcuts, penButtonFromHoverMouse } from '../src/core/pen-shortcuts.mjs';

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
  assert.equal(click(shortcuts, 2, 100, { duration: 251 }), null);
  assert.equal(click(shortcuts, 2, 380), null);
  assert.equal(click(shortcuts, 2, 470), 'undo');
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

test('panning past eight pixels and returning to the start still suppresses redo', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 4, 0);
  shortcuts.update(event('pointerdown', 4), 100);
  shortcuts.update(event('pointermove', 4, { clientY: 109 }), 110);
  shortcuts.update(event('pointermove', 4), 120);
  assert.equal(shortcuts.update(event('pointerup', 0), 130), null);
  assert.equal(click(shortcuts, 4, 150), null);
});

test('movement tolerance uses radial distance and includes release coordinates', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 4, 0);
  shortcuts.update(event('pointerdown', 4), 100);
  assert.equal(shortcuts.update(event('pointerup', 0, { clientX: 106, clientY: 106 }), 140), null);
  assert.equal(click(shortcuts, 4, 200), null);
  shortcuts.update(event('pointerdown', 4), 300);
  assert.equal(shortcuts.update(event('pointerup', 0, { clientX: 108 }), 340), 'redo');
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

test('completed clicks expire after 400ms and backward timestamps cannot fire a stale shortcut', () => {
  const shortcuts = new PenButtonShortcuts();
  click(shortcuts, 2, 0);
  assert.equal(click(shortcuts, 2, 401), null);
  assert.equal(click(shortcuts, 2, 500), 'undo');
  click(shortcuts, 2, 600);
  assert.equal(click(shortcuts, 2, 100), null);
  assert.equal(click(shortcuts, 2, 200), 'undo');
});

test('the exact click-duration and double-click-window boundaries remain usable', () => {
  const shortcuts = new PenButtonShortcuts();
  assert.equal(click(shortcuts, 4, 0, { duration: 250 }), null);
  assert.equal(click(shortcuts, 4, 400, { duration: 250 }), 'redo');
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

test('hover mouse clicks map to pen buttons only while the pen is in range', () => {
  const mouse = (type, button) => ({ type, pointerType: 'mouse', button, clientX: 5, clientY: 6 });
  assert.equal(penButtonFromHoverMouse(mouse('pointerdown', 2), false), null);
  assert.equal(penButtonFromHoverMouse(mouse('pointermove', 2), true), null);
  assert.equal(penButtonFromHoverMouse(mouse('pointerdown', 0), true), null);
  assert.equal(penButtonFromHoverMouse({ ...mouse('pointerdown', 2), pointerType: 'pen' }, true), null);
  assert.equal(penButtonFromHoverMouse(mouse('pointerdown', 2), true).buttons, 2);
  assert.equal(penButtonFromHoverMouse(mouse('pointerdown', 1), true).buttons, 4);
  assert.equal(penButtonFromHoverMouse(mouse('pointerup', 1), true).buttons, 0);
  const shortcuts = new PenButtonShortcuts();
  const press = (button, start) => {
    shortcuts.update(penButtonFromHoverMouse(mouse('pointerdown', button), true), start);
    return shortcuts.update(penButtonFromHoverMouse(mouse('pointerup', button), true), start + 40);
  };
  assert.equal(press(2, 0), null);
  assert.equal(press(2, 200), 'undo');
  assert.equal(press(1, 1000), null);
  assert.equal(press(1, 1200), 'redo');
  assert.equal(press(2, 3000), null, 'a single click does nothing');
});
