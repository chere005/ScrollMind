// Shortcut hints are written with macOS symbols. On other platforms they are
// rewritten to Ctrl/Shift/Alt names (Windows order: Ctrl+Alt+Shift+Key).
const MODIFIERS = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const ORDER = ['Ctrl', 'Alt', 'Shift'];
const CHORD = /[⌘⌃⌥⇧](?:\s*[⌘⌃⌥⇧])*(?:\s*([A-Za-z0-9/]+))?/g;

export function localizeShortcut(text, platform) {
  if (platform === 'darwin' || typeof text !== 'string') return text;
  return text
    .replace(CHORD, (chord, key) => {
      const names = new Set([...chord].filter(char => MODIFIERS[char]).map(char => MODIFIERS[char]));
      return [...ORDER.filter(name => names.has(name)), ...(key ? [key] : [])].join('+');
    })
    .replaceAll('⌫', 'Del');
}
