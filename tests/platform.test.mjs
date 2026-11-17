import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { localizeShortcut } from '../src/core/shortcut-labels.mjs';

const { findScrollArgument, commandForInput } = createRequire(import.meta.url)('../src/main/launch-args.cjs');

test('shortcut labels stay unchanged on macOS', () => {
  for (const text of ['Undo (⌘ Z)', '⇧ ⌘ Z', '⌫', '⌘ ⇧ M']) assert.equal(localizeShortcut(text, 'darwin'), text);
});

test('shortcut labels become Ctrl/Shift names on Windows', () => {
  assert.equal(localizeShortcut('Undo (⌘ Z)', 'win32'), 'Undo (Ctrl+Z)');
  assert.equal(localizeShortcut('⇧ ⌘ Z', 'win32'), 'Ctrl+Shift+Z');
  assert.equal(localizeShortcut('⌘ ⇧ M', 'win32'), 'Ctrl+Shift+M');
  assert.equal(localizeShortcut('⌘ Enter', 'win32'), 'Ctrl+Enter');
  assert.equal(localizeShortcut('Sections & paper (⌘ /)', 'win32'), 'Sections & paper (Ctrl+/)');
  assert.equal(localizeShortcut('⇧', 'win32'), 'Shift');
  assert.equal(localizeShortcut('⌥ ⌘ K', 'win32'), 'Ctrl+Alt+K');
  assert.equal(localizeShortcut('⌫', 'win32'), 'Del');
  assert.equal(localizeShortcut('Pen (B)', 'win32'), 'Pen (B)');
});

test('finds a .sm file in packaged and dev argv', () => {
  const file = path.resolve('docs', 'notes.SM');
  assert.equal(findScrollArgument(['app/ScrollMind.exe', file]), file);
  assert.equal(findScrollArgument(['electron.exe', '.', '--no-sandbox', file]), file);
  assert.equal(findScrollArgument(['electron.exe', 'ScrollMind']), null);
  assert.equal(findScrollArgument(['x.exe', '--flag=a.sm']), null);
  assert.equal(findScrollArgument(['x.exe', `"${file}"`]), file);
  assert.equal(findScrollArgument(['x.sm']), null, 'the executable is never a scroll');
  assert.equal(findScrollArgument(undefined), null);
});

test('relative .sm arguments resolve against the working directory', () => {
  assert.equal(findScrollArgument(['x.exe', 'a.sm'], path.resolve('/work')), path.resolve('/work', 'a.sm'));
});

test('Windows window shortcuts without a menu bar', () => {
  const key = (k, extra = {}) => commandForInput({ type: 'keyDown', key: k, control: false, alt: false, shift: false, meta: false, ...extra });
  assert.equal(key('w', { control: true }), 'close-scroll');
  assert.equal(key('W', { control: true }), 'close-scroll');
  assert.equal(key('q', { control: true }), 'quit');
  assert.equal(key('F4', { alt: true }), 'quit');
  assert.equal(key('ц', { control: true, code: 'KeyW' }), 'close-scroll');
  assert.equal(key('й', { control: true, code: 'KeyQ' }), 'quit');
  assert.equal(key('z', { control: true, code: 'KeyW' }), null);
  assert.equal(key('a', { control: true, code: 'KeyQ' }), null);
  assert.equal(key('w', { control: true, code: 'Comma' }), 'close-scroll');
  assert.equal(key('w'), null);
  assert.equal(key('z', { control: true }), null);
  assert.equal(commandForInput({ type: 'keyUp', key: 'w', control: true }), null);
});
