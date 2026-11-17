# ScrollMind

A quiet, infinite sheet for a pen display. The macOS app opens full screen on a connected Wacom display, with pressure-sensitive ink, a small control circle, and an endless page above and below where you started. Hover over the circle for a moment to expand the pen controls; they fold away when you return to the page.

Select **Rectangle** or press **V** to select handwriting. Drag the selected writing to move it. Standard copy, cut, paste, duplicate, undo, redo, and arrow-key nudging work with the mouse and keyboard.

The shape dropdown adds lines, arrows, rectangles, ellipses, and triangles as editable strokes. The color wheel provides custom ink colors with brightness and hex controls, alongside the quick color swatches.

An optional sidebar holds open scrolls, paper settings, navigation, and file controls. Create, name, switch, and close scrolls there; recently closed scrolls can be reopened. The trash button removes a scroll from the workspace and keeps a recoverable copy in `Documents/ScrollMind/Deleted Scrolls`. Each scroll keeps its own writing and undo history while open. Choose plain, dotted, ruled, or square-grid paper in white, ivory, parchment, or dark tones. Add named sections, page breaks, and markers to organize the continuous scroll and jump between places. The sidebar starts hidden so the page stays clear.

ScrollMind saves automatically in `~/Documents/ScrollMind`: the original scroll is `scroll.sm`, and additional scrolls live in `Scrolls/<id>/scroll.sm`. Each has a recovery snapshot named `scroll.backup.sm`, refreshed at startup, first writing, every five minutes, and clean close. The workspace restores your open scrolls and active place after restart. The `.sm` format is a self-contained SQLite file that preserves editable handwriting, pressure, colors, paper, sections, and markers. Writing stays on this computer. Earlier JSON saves migrate automatically, and the original files are preserved.

Use **Export Scroll** in the sidebar or File menu to save an editable `.sm` copy, a vector `.svg`, or a paginated `.pdf`. PDF exports honor page breaks. **Open Scroll** adds a working copy of a saved `.sm` to your open scrolls, preserving the chosen file and your other scrolls. **Clear Scroll** removes the current scroll's writing and navigation points in one undoable action, keeping its paper settings.

Hold the lower pen button and touch or drag across strokes to delete them. Each continuous erase drag undoes in one action. Double-click that button while hovering to undo; double-click the scrolling button to redo.

See [controls](docs/CONTROLS.md) for keyboard and Wacom mappings. The drawing model is independent of Electron and macOS so a future Windows version can share the same ink, selection, and scroll format.

For development, install Node.js dependencies with `npm install`, launch with `npm start`, and run `npm run preflight` before merging or pushing. UI tests use hidden windows and temporary scrolls. `node tools/make-icon.mjs` generates the application icon; `npm run build:mac` creates a Developer ID signed macOS application bundle. See [signing](docs/SIGNING.md) for verified release archives and optional notarization.
