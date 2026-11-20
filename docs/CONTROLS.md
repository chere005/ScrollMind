# Controls

## Pen controls

Hover over the small circle at the top for 200 ms to expand the controls in place. Small slips outside keep them open; moving farther away closes them after half a second. Clicking or focusing the circle opens them immediately.

Choose **Pen**, **Pencil**, **Fountain**, **Marker**, or **Highlighter**, then a width: **Fine**, **Medium**, **Bold**, or **Broad**. Pressure changes the width of new strokes. Existing writing keeps its original style.

Highlighter starts with Yellow and Broad width. Its translucent strokes keep writing visible: a continuous pass has uniform opacity, including where it overlaps itself, while separate strokes build color. During the session, switching back restores your previous ink color and width.

Each Scroll and Grid saves its own eight swatches. Open **Color palette and wheel** from the pen bar, choose a color with the wheel or hex field, then pick a swatch and choose **Save current color**. You can name each swatch or restore the default palette.

In Scroll mode the shape dropdown offers Line, Arrow, Rectangle, Ellipse, and Triangle. Choose one and drag on the page. Hold Shift to constrain the drawing. These shapes are editable like handwriting.

In Grid mode the left half of the shape button reuses the last picked shape. The arrow on its right offers Rectangle, Oval, Triangle, Trapezoid, and Cylinder. Click the canvas for a standard size or drag to size the new shape. Drag the body to move it or a corner to resize it. Drag a round handle to another shape to attach a routed arrow. The arrow updates when you move or resize a shape. Select an arrow or shape and press Delete to remove it.

## Mouse and keyboard

Shortcuts are shown for macOS. On Windows, use Ctrl for ⌘ and Shift for ⇧; the app shows the Windows names. Windows has no menu bar, so every action is in the sidebar or on a shortcut below.

The mouse selects and moves by default. Choose Pen or press B to draw with it. The stylus writes by default. Choose Rectangle Selection or press V to use the stylus for selection and movement.

| Action | Control |
| --- | --- |
| Pen / Eraser / Rectangle selection / Hand | B / E / V / H |
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

ScrollMind responds to the standard mouse-button actions assigned in the Wacom driver. Useful app-specific assignments are:

| Pen button | Assignment and behavior |
| --- | --- |
| Lower button | **Right Click:** hold, then touch or drag across strokes to erase; double-click while hovering to undo |
| Upper button | **Middle Click:** hold and drag to scroll; double-click while hovering to redo |

A single button click does nothing. Pressing the erase button during an existing stroke does not erase until you lift and touch down again. Each erase drag ends when the tip lifts and undoes together. Erasing and scrolling do not count as double-click commands. The toolbar eraser and a pen's rear eraser also erase continuously on contact.

While hovering, tap lower then upper to select and drag with the next tip contact. Put the tip on ink or a Grid shape and move it. Lift the tip to return to the previous tool. Holding and dragging the upper button pans. Use the sidebar zoom buttons, a trackpad pinch, or Ctrl + wheel to zoom.

Useful ExpressKey assignments are ⌘Z, ⌘⇧Z, B, E, V, H, and Tab (Ctrl+Z and Ctrl+Y on Windows). A ring or strip assigned to vertical scrolling moves along the page. ScrollMind does not change the driver's assignments.

### Windows

In **Wacom Tablet Properties**, keep **Use Windows Ink** turned on so the pen reports pressure and its side buttons. Press-and-hold right-click and flick gestures are disabled on the writing canvas, so holding the tip still never opens a menu or scrolls.

The driver's **Side Switch Mode** decides which pen-button features work:

- **Click & Tap** (recommended): with the lower switch on **Right Click**, hold it and touch or drag the tip across strokes to erase. The driver sends no clicks while hovering, so hover double-click undo/redo is unavailable. Assign ExpressKeys (or the upper switch as a keystroke) to **Ctrl+Z** and **Ctrl+Y** instead.
- **Hover Click**: with the lower switch on **Right Click** and the upper switch on **Middle Click**, double-clicking while hovering undoes (lower) or redoes (upper). Tapping lower then upper arms a drag for the next tip contact. Use **E** or the pen's rear eraser to erase.

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
| .sm | Editable Scroll ink, settings, and navigation points |
| .smg | Editable Grid ink, shapes, connections, and Grid settings |
| SVG | Vector artwork for the selected mode |
| PDF | Scroll page breaks or one sheet per Grid page |

Scrolls save automatically before switching or quitting. See the [native format reference](SCROLL-FORMAT.md) for files, backups, and recovery.
