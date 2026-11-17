# Controls

## Pen controls

Hover over the small circle at the top for 200 ms to expand the controls in place. Small slips outside keep them open; moving farther away closes them after half a second. Clicking or focusing the circle opens them immediately.

Choose **Pen**, **Pencil**, **Fountain**, or **Marker**, then a width: **Fine**, **Medium**, **Bold**, or **Broad**. Pressure changes the width of new strokes. Existing writing keeps its original style.

The eight swatches are Black, Graphite, Blue, Green, Red, Orange, Purple, and White. The color wheel adds hue, saturation, brightness, and six-digit hex input. Your pen type, width, and color save with the scroll.

The shape dropdown offers Line, Arrow, Rectangle, Ellipse, and Triangle. Choose one and drag on the page. Hold Shift for straight angles, squares, circles, or an equilateral triangle. Shapes can be selected and edited like handwriting.

## Mouse and keyboard

| Action | Control |
| --- | --- |
| Pen / Eraser / Rectangle selection / Hand | B / E / V / H |
| Scroll vertically | Mouse wheel or trackpad |
| Pan vertically | Space + drag or middle-button drag |
| Select handwriting | Drag a rectangle across strokes |
| Move selection | Drag inside its box |
| Resize selection | Drag a corner; Shift keeps its shape |
| Nudge selection | Arrow keys; Shift moves 10 units |
| Copy / Cut / Paste | ⌘C / ⌘X / ⌘V |
| Duplicate / Select all | ⌘D / ⌘A |
| Delete selection | Delete or Backspace |
| Undo / Redo | ⌘Z / ⌘⇧Z |
| Sidebar / Pen controls | ⌘/ / Tab |
| Return to start | ⌘0 |
| Full screen | ⌘⇧F or F11 |
| Clear selection or dismiss controls | Escape |
| Close current scroll / Quit | ⌘W / ⌘Q |

A selection rectangle selects complete strokes that it crosses. Each drawing, erase drag, shape, or selection move is one undo action. Escape leaves full screen once selections and open controls are dismissed.

## Wacom buttons

ScrollMind responds to the standard mouse-button actions assigned in the Wacom driver. Useful app-specific assignments are:

| Pen button | Assignment and behavior |
| --- | --- |
| Lower button | **Right Click:** hold, then touch or drag across strokes to erase; double-click while hovering to undo |
| Upper button | **Middle Click:** hold and drag to scroll; double-click while hovering to redo |

A single button click does nothing. Pressing the erase button during an existing stroke does not erase until you lift and touch down again. Each erase drag ends when the tip lifts and undoes together. Erasing and scrolling do not count as double-click commands. The toolbar eraser and a pen's rear eraser also erase continuously on contact.

Useful ExpressKey assignments are ⌘Z, ⌘⇧Z, B, E, V, H, and Tab. A ring or strip assigned to vertical scrolling moves along the page. ScrollMind does not change the driver's assignments.

## Paper and navigation

Open the sidebar for plain, dotted, ruled, or square-grid paper in ivory, parchment, white, or midnight blue. Dotted paper uses one regular grid without parchment grain.

**Section**, **Marker**, and **Page break** add navigation points at the middle of the view. Edit their names directly and press Enter to finish. Their symbols jump to the saved place; × removes them. Undo restores removed points. Page breaks also control PDF pagination.

The screen selector chooses the writing display. Mirrored macOS displays show the same app; independent screen placement requires an extended desktop.

## Manage and export scrolls

**New Scroll** adds another scroll. Select a name to switch, use its pencil button to rename, or × to close. Closed scrolls remain in **Other scrolls**. Each open scroll keeps its own undo history during the session, and the workspace returns after restart.

The trash button deletes a scroll from the workspace and keeps a recoverable copy in `~/Documents/ScrollMind/Deleted Scrolls`. **Clear Scroll** removes all writing, sections, markers, and page breaks from the current scroll in one undoable action, keeping paper settings and other scrolls.

**Open Scroll**, or opening an .sm file with ScrollMind, adds an editable working copy and preserves its source. **Export Scroll** offers:

| Format | Contents |
| --- | --- |
| .sm | Editable strokes, pressure, pen styles, paper settings, and navigation points |
| SVG | Vector artwork for the continuous scroll |
| PDF | Paginated artwork with manual page breaks |

Scrolls save automatically before switching or quitting. See the [native format reference](SCROLL-FORMAT.md) for files, backups, and recovery.
