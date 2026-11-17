# ScrollMind

Full-screen handwriting for Wacom pen displays, with an infinite vertical page. Write with a pressure-sensitive pen, then arrange your strokes with a mouse and keyboard. ScrollMind saves your writing locally.

## Download and install

The current download requires **macOS 13 or later on Apple silicon (M1 or newer)**.

Download the arm64 ZIP from the [latest release](https://github.com/chere005/ScrollMind/releases/latest), unzip it, and move **ScrollMind.app** to **Applications**.

The app is Developer ID signed and **not notarized**. If macOS blocks the first launch, see [Apple's instructions for opening downloaded apps](https://support.apple.com/en-us/102445).

## Write and arrange

- **Ink:** Pen, Pencil, Fountain, and Marker; four widths from Fine to Broad; eight color swatches and a color wheel with brightness and hex controls.
- **Selection:** rectangular selection, moving, resizing, copy, cut, paste, duplicate, and undo/redo.
- **Shapes:** lines, arrows, rectangles, ellipses, and triangles, stored as editable strokes.
- **Scrolls:** keep several open, switch between them, and organize each with sections, markers, and page breaks.
- **Paper:** plain, dotted, ruled, or square grid in ivory, parchment, white, or midnight blue. Dotted paper uses a clean, regular grid.

Hover over the small circle at the top to reveal the pen controls. The sidebar holds scrolls, paper settings, and file controls. Both stay out of the writing area when closed.

ScrollMind opens on a connected Wacom display when available. Its screen selector can move the writing window to another display.

## Save and share

Scrolls save automatically in `~/Documents/ScrollMind`, with recovery snapshots. Open scrolls and the active view return after restarting. No account or cloud service is required.

Export an editable **.sm** file, vector **SVG**, or paginated **PDF**. Opening an .sm file creates a working copy in a new scroll and preserves the original file.

See the [controls guide](docs/CONTROLS.md) for pen buttons, keyboard shortcuts, and scroll management, or the [native format reference](docs/SCROLL-FORMAT.md) for storage and recovery details.

## Development

Use a Node.js version with `node:sqlite` support. Install dependencies with `npm ci`, run locally with `npm start`, and check changes with `npm run preflight`. UI tests run in hidden windows with temporary data.

The drawing model is separate from the desktop shell. See [macOS distribution](docs/SIGNING.md) for signed builds and release archives.
