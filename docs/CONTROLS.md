# Controls

## Pen controls

Hover over the small circle at the top for 200 ms to expand the controls in place. Small slips outside keep them open; moving farther away closes them after half a second. Clicking or focusing the circle opens them immediately.

Choose **Pen**, **Pencil**, **Fountain**, **Marker**, or **Highlighter**, then a width: **Fine**, **Medium**, **Bold**, or **Broad**. Pressure changes the width of new strokes. Existing writing keeps its original style.

**Fill** colors one outlined area with the current ink color. Click or tap inside a closed outline of ink, or inside a Grid shape. Small gaps in a hand-drawn outline are bridged, and an island of ink inside the area stays unfilled. The color lies beneath all ink and shape outlines, so it never covers a line. Filling the same area again recolors it. An area that runs off the visible page is not closed, so zoom out or close the outline. Undo removes a fill in one step. An erase drag that starts on ink erases only ink, so a colored area survives wiping out its outline; start the erase drag inside the color to remove it. A selection box picks up a fill only when it encloses the whole area. The pen's lower and upper buttons keep their usual actions while Fill is chosen.

Highlighter starts with Yellow and Broad width. Its translucent strokes keep writing visible: a continuous pass has uniform opacity, including where it overlaps itself, while separate strokes build color. During the session, switching back restores your previous ink color and width.

Each Scroll and Grid saves its own eight swatches. Open **Color palette and wheel** from the pen bar, choose a color with the wheel or hex field, then pick a swatch and choose **Save current color**. You can name each swatch or restore the default palette.

In Scroll mode the shape dropdown offers Line, Arrow, Rectangle, Ellipse, and Triangle. Choose one and drag on the page. Hold Shift to constrain the drawing. These shapes are editable like handwriting.

In Grid mode the left half of the shape button reuses the last picked shape. The arrow on its right offers Rectangle, Oval, Triangle, Trapezoid, and Cylinder. Click the canvas for a standard size or drag to size the new shape. Drag the body to move it or a corner to resize it. Drag a round handle to another shape to attach a routed arrow. The arrow updates when you move or resize a shape. Select an arrow or shape and press Delete to remove it.

## Mouse and keyboard

Shortcuts are shown for macOS. On Windows, use Ctrl for ⌘ and Shift for ⇧; the app shows the Windows names. Windows has no menu bar, so every action is in the sidebar or on a shortcut below. macOS also has **ScrollMind ▸ Check for Updates…**.

The mouse selects and moves by default. Choose Pen or press B to draw with it. The stylus writes by default. Choose Rectangle Selection or press V to use the stylus for selection and movement.

| Action | Control |
| --- | --- |
| Pen / Eraser / Fill / Rectangle selection / Hand | B / E / F / V / H |
| Scroll vertically | Mouse wheel or trackpad |
| Pan | Space + drag or middle-button drag. Grid mode pans in both directions. |
| Zoom | Ctrl + wheel, trackpad pinch, ⌘ + / ⌘ −, or the sidebar’s zoom buttons |
| Select handwriting | Drag a rectangle across strokes |
| Move selection | Drag inside its box |
| Resize selection | Drag a corner; Shift keeps its shape |
| Nudge selection | Arrow keys; Shift moves 10 units |
| Copy / Cut / Paste | ⌘C / ⌘X / ⌘V |
| Duplicate / Select all | ⌘D / ⌘A |
| Delete selection | Delete or Backspace |
| Undo / Redo | ⌘Z / ⌘⇧Z (Windows also Ctrl+Y). Double-click the middle button to redo. |
| Sidebar / Pen controls | ⌘/ / Tab |
| Return to start | ⌘0 |
| Full screen | ⌘⇧F or F11 (Windows: Ctrl+Shift+F or F11) |
| Clear selection or dismiss controls | Escape |
| Close current scroll / Quit | ⌘W / ⌘Q (Windows: Ctrl+W / Ctrl+Q or Alt+F4) |

A selection rectangle selects complete strokes that it crosses. Each drawing, erase drag, shape, or selection move is one undo action. Escape leaves full screen once selections and open controls are dismissed.

## Wacom buttons

ScrollMind responds to the standard mouse-button actions assigned in the Wacom driver: on a tablet or pen display it does not read natively, assign the lower switch to **Right Click** and the upper switch to **Middle Click**. On a **Wacom One 12** on a Mac, ScrollMind reads the two side switches from the display itself, so every row below works whatever Wacom Center assigns to them, including **Pan/Scroll** on the upper switch (the driver's own scrolling still scrolls the page). macOS delivers the display's button reports only to an app with **Input Monitoring**, so ScrollMind asks once when it finds the display; turn on ScrollMind under System Settings ▸ Privacy & Security ▸ Input Monitoring and reopen it. **ScrollMind ▸ Pen Display Buttons…** shows whether it is on and opens that setting. Reading the buttons does not stop the driver from using the pen.

**This is the pen-button contract.** It is the same in Scroll and Grid mode, and every release runs the tests that check each line (the *Pen button contract* tests in `tests/ui.spec.mjs`, plus `tests/pen-shortcuts.test.mjs` and `tests/pen-input.test.mjs`; `npm run test:pen` runs them alone, with the checks of the display's own button reports). Change this behavior only on purpose, and change this page and those tests with it.

| Pen button | Gesture | Result |
| --- | --- | --- |
| Lower | Hold, then tap or drag the tip | Erases only where the tip touches: holding alone deletes nothing, and every tap or drag deletes until the button is let go. Each erase drag is one undo. |
| Lower | Double-tap while hovering | Undo |
| Upper | Hold and drag, hovering or touching | Scrolls (Grid mode scrolls in both directions) |
| Upper | Double-tap while hovering | Redo |
| Lower, then upper, tapped quickly (within 0.7 seconds) | Then tap and drag the tip | Zooms around the tip: drag up to zoom in, down to zoom out. Lifting the tip returns the pen to normal. |

A tap of a button is a press of at most half a second in which the pen stays put, within a few millimeters; a longer press is a hold. A single button click does nothing. Pressing the erase button during an existing stroke does not erase until you lift and touch down again. Each erase drag ends when the tip lifts and undoes together. Erasing and scrolling do not count as double-click commands. The toolbar eraser and a pen's rear eraser also erase continuously on contact.

The zoom stroke must be lower first, then upper, with the tip hovering; upper then lower, or a long pause between them, does nothing. Escape cancels an armed zoom. The sidebar zoom buttons, a trackpad pinch, and Ctrl + wheel also zoom. To move ink with the pen, choose Select in the pen bar.

Useful ExpressKey assignments are ⌘Z, ⌘⇧Z, B, E, V, H, and Tab (Ctrl+Z and Ctrl+Y on Windows). A ring or strip assigned to vertical scrolling moves along the page. ScrollMind does not change the driver's assignments.

### Windows

In **Wacom Tablet Properties**, keep **Use Windows Ink** turned on so the pen reports pressure and its side buttons. Press-and-hold right-click and flick gestures are disabled on the writing canvas, so holding the tip still never opens a menu or scrolls.

The driver's **Side Switch Mode** decides which pen-button features work:

- **Click & Tap** (recommended): with the lower switch on **Right Click**, hold it and touch or drag the tip across strokes to erase. The driver sends no clicks while hovering, so hover double-click undo/redo is unavailable. Assign ExpressKeys (or the upper switch as a keystroke) to **Ctrl+Z** and **Ctrl+Y** instead.
- **Hover Click**: with the lower switch on **Right Click** and the upper switch on **Middle Click**, double-clicking while hovering undoes (lower) or redoes (upper). Tapping lower then upper arms tap-and-drag zoom for the next tip contact. Use **E** or the pen's rear eraser to erase.

In either mode, **Middle Click** on the upper switch scrolls when held and dragged.

## Paper and navigation

Switch between **Scrolls** and **Grids** at the top of the sidebar. Each workspace keeps its own open documents. Scrolls offer plain, dotted, ruled, or square-grid ruling. Parchment has an even background.

In Scroll mode, **Section**, **Marker**, and **Page break** add navigation points at the middle of the view. Edit their names and press Enter to finish. Their symbols jump to the saved place, and × removes them. Undo restores removed points. Page breaks control Scroll PDF pagination.

In Grid mode, set the number of square rows and columns in a block and the number of block rows and columns on a page. Draw or move content past a page edge to extend the grid in that direction.

The screen selector chooses the writing display. Mirrored displays show the same app; independent screen placement requires an extended desktop.

## Manage and export documents

**+ New** adds a document to the current workspace. Select a name to switch, use its pencil button to rename, or × to close. Reopen closed documents from **Other scrolls** or **Other grids**. Each document keeps its own undo history during the session, and the workspace returns after restart.

The trash button keeps a recoverable copy under **Deleted Scrolls** or **Grids / Deleted Grids** in the writing folder. **Clear current scroll** and **Clear current grid** remove the current document’s content in one undoable action.

**Open** adds an editable working copy to the matching workspace. Use the export buttons for these formats.

| Format | Contents |
| --- | --- |
| .sm | An editable Scroll (ink, settings, navigation points) or Grid (ink, shapes, connections, Grid settings) |
| SVG | Vector artwork for the selected mode |
| PDF | Scroll page breaks or one sheet per Grid page |

Scrolls save automatically before switching or quitting. See the [native format reference](SCROLL-FORMAT.md) for files, backups, and recovery.
