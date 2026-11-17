# ScrollMind

A quiet, infinite sheet for a pen display. The macOS app opens full screen on a connected Wacom display, with pressure-sensitive ink, a small toolbar, and an endless page above and below where you started.

Select **Rectangle** or press **V** to select handwriting. Drag the selected writing to move it. Standard copy, cut, paste, duplicate, undo, redo, and arrow-key nudging work with the mouse and keyboard.

An optional sidebar holds paper settings and navigation. Choose plain, dotted, ruled, or square-grid paper in white, ivory, parchment, or dark tones. Add named sections, page breaks, and markers to organize the continuous sheet and jump between places. The sidebar starts hidden so the page stays clear.

ScrollMind keeps your notebook in `~/Documents/ScrollMind/notebook.scrollmind.json`, saving automatically and before closing. A previous saved version is kept beside it as a backup. Writing stays on this computer.

See [controls](docs/CONTROLS.md) for keyboard and Wacom mappings. The drawing model is independent of Electron and macOS so a future Windows version can share the same ink, selection, and notebook format.

For development, install Node.js dependencies with `npm install`, launch with `npm start`, and run `npm run preflight` before merging or pushing. UI tests use hidden windows and temporary notebooks. `node tools/make-icon.mjs` generates the application icon; `npm run build:mac` creates the local macOS application bundle.
