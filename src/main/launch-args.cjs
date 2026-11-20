'use strict';

const path = require('node:path');

// Finds a .sm or .smg file in a process argv. argv[0] is the executable; in `electron .`
// dev runs argv[1] is the app path, and Chromium/Electron flags start with "-".
function findScrollArgument(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv)) return null;
  for (const value of argv.slice(1)) {
    if (typeof value !== 'string' || value.startsWith('-')) continue;
    const text = value.trim().replace(/^"(.*)"$/, '$1');
    if (/\.smg?$/i.test(text)) return path.isAbsolute(text) ? text : path.resolve(cwd, text);
  }
  return null;
}

// Keyboard shortcuts the Windows window handles itself, because it has no
// visible menu bar (the application menu is not installed on Windows).
// Latin layouts: trust the layout's letter. Non-Latin layouts (Cyrillic, Greek,
// Hebrew, Arabic): fall back to the physical key, like Windows virtual keys.
function shortcutLetter(input) {
  const key = String(input.key || '').toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  const match = /^Key([A-Z])$/.exec(String(input.code || ''));
  return match ? match[1].toLowerCase() : key;
}

function commandForInput(input) {
  if (!input || input.type !== 'keyDown') return null;
  const key = String(input.key || '').toLowerCase();
  if (input.alt && !input.control && !input.meta && (key === 'f4' || input.code === 'F4')) return 'quit';
  if (!(input.control || input.meta) || input.alt) return null;
  const letter = shortcutLetter(input);
  if (letter === 'w' && !input.shift) return 'close-scroll';
  if (letter === 'q' && !input.shift) return 'quit';
  return null;
}

module.exports = { findScrollArgument, commandForInput };
