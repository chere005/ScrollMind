# ScrollMind

Full-screen handwriting for Wacom pen displays, with an infinite vertical scroll and an expanding grid. Write with a pressure-sensitive pen, then arrange your work with a mouse and keyboard. ScrollMind runs on macOS and Windows and saves your writing locally.

## Download and install

The current download requires **macOS 13 or later on Apple silicon (M1 or newer)**.

Download the arm64 ZIP from the [latest release](https://github.com/chere005/ScrollMind/releases/latest), unzip it, and move **ScrollMind.app** to **Applications**.

The app is Developer ID signed and **not notarized**. If macOS blocks the first launch, see [Apple's instructions for opening downloaded apps](https://support.apple.com/en-us/102445).

### Updates

ScrollMind checks the GitHub releases a few seconds after it opens and every 12 hours. It asks before it downloads a newer version, then asks again before restarting; your writing is saved first, and **Later** installs the update the next time you quit. On macOS, **ScrollMind ▸ Check for Updates…** asks at any time. A copy opened from a disk image or from outside Applications does not update itself.

### Windows

The Windows version requires **Windows 10 or later (x64)**. Run **ScrollMind-Setup-<version>.exe**, the Windows installer published with a release or built locally with `npm run build:win`. It installs for the current user and needs no administrator rights. Open .sm files in Explorer with ScrollMind.

The installer is **unsigned**. If SmartScreen blocks it, choose **More info**, then **Run anyway**.

## Write and arrange

- **Ink:** Pen, Pencil, Fountain, Marker, and Highlighter; four widths from Fine to Broad; eight color swatches and a color wheel with brightness and hex controls.
- **Fill:** color a closed outline of ink or a Grid shape with the current ink color; the color lies beneath the ink and is saved, exported, and undoable.
- **Selection:** rectangular selection, moving, resizing, copy, cut, paste, duplicate, and undo/redo.
- **Highlighting:** translucent strokes keep writing visible; separate passes build color.
- **Shapes:** in Scroll mode, draw basic shapes as editable strokes. In Grid mode, move and resize flowchart shapes and attach automatically routed arrows.
- **Scrolls:** keep several open, switch between them, and organize each with sections, markers, and page breaks.
- **Paper:** plain, dotted, ruled, or square grid in ivory, parchment, white, or midnight blue. Grid mode starts in midnight blue and adds pages as you draw past their edges.

Hover over the small circle at the top to reveal the pen controls. The sidebar holds scrolls, paper settings, and file controls. Both stay out of the writing area when closed.

ScrollMind opens on a connected Wacom display when available. Its screen selector can move the writing window to another display.

## Save and share

Scrolls save automatically in `~/Documents/ScrollMind` (`Documents\ScrollMind` on Windows), with recovery snapshots. Open scrolls and the active view return after restarting. On Windows, shutting down, restarting, or logging off waits for the final save. No account or cloud service is required.

Scrolls and Grids have separate workspaces. Export an editable Scroll or Grid as a **.sm** file, which ScrollMind recognizes as either, or export either as vector **SVG** or paginated **PDF**. Opening a native file creates a working copy in its workspace.

See the [controls guide](docs/CONTROLS.md) for pen buttons, keyboard shortcuts (Ctrl on Windows), and scroll management, or the [native format reference](docs/SCROLL-FORMAT.md) for storage and recovery details.

## Development

Use a Node.js version with `node:sqlite` support. Install dependencies with `npm ci`, run locally with `npm start`, and check changes with `npm run preflight`. UI tests run in hidden windows with temporary data.

The drawing model is separate from the desktop shell. `npm run build:win` creates the unsigned Windows installer in `dist/`, `npm run build:win:dir` an unpacked app, and `npm run release:win` a verified installer with its SHA-256 checksum. See [distribution](docs/SIGNING.md) for signed macOS builds and the Windows installer.
