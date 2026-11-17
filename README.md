# ScrollMind

A quiet, infinite sheet for a pen display. The macOS app opens full screen on a connected Wacom display, with pressure-sensitive ink, a small toolbar, and an endless page above and below where you started.

Select **Rectangle** or press **V** to select handwriting. Drag the selected writing to move it. Standard copy, cut, paste, duplicate, undo, redo, and arrow-key nudging work with the mouse and keyboard.

An optional sidebar holds paper settings, navigation, and file controls. Choose plain, dotted, ruled, or square-grid paper in white, ivory, parchment, or dark tones. Add named sections, page breaks, and markers to organize the continuous scroll and jump between places. The sidebar starts hidden so the page stays clear.

ScrollMind saves your current scroll automatically in `~/Documents/ScrollMind/scroll.sm`, with a recovery snapshot beside it as `scroll.backup.sm`, refreshed at startup, first writing, every five minutes, and clean close. The `.sm` format is a self-contained SQLite file that preserves editable handwriting, pressure, colors, paper, sections, and markers. Writing stays on this computer. Earlier JSON saves migrate automatically, and the original files are preserved.

Use **Export Scroll** in the sidebar or File menu to save an editable `.sm` copy, a vector `.svg`, or a paginated `.pdf`. PDF exports honor page breaks. **Open Scroll** imports a working copy of a saved `.sm`, preserving the chosen file and first archiving any current writing in `Documents/ScrollMind/Saved Scrolls`.

See [controls](docs/CONTROLS.md) for keyboard and Wacom mappings. The drawing model is independent of Electron and macOS so a future Windows version can share the same ink, selection, and scroll format.

For development, install Node.js dependencies with `npm install`, launch with `npm start`, and run `npm run preflight` before merging or pushing. UI tests use hidden windows and temporary scrolls. `node tools/make-icon.mjs` generates the application icon; `npm run build:mac` creates the local macOS application bundle.
