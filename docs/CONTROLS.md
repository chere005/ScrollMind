# Controls

| Action | Control |
| --- | --- |
| Write | Pen tip; pressure changes ink width |
| Pen | B |
| Eraser | E |
| Rectangular selection | V |
| Hand | H |
| Move selected writing | Drag the selection |
| Resize selected writing | Drag a corner; hold Shift to keep its shape |
| Select multiple strokes | Drag a rectangle across the writing |
| Copy, cut, paste | ⌘C, ⌘X, ⌘V |
| Duplicate selection | ⌘D |
| Select all | ⌘A |
| Delete selection | Delete or Backspace |
| Nudge selection | Arrow keys; Shift moves farther |
| Undo, redo | ⌘Z, ⌘⇧Z |
| Pen undo, redo | Double-click the lower pen button or scrolling button while hovering |
| Scroll vertically | Mouse wheel or trackpad |
| Pan vertically | Space + drag, or middle-button drag |
| Return to starting point | ⌘0 |
| Hide or show toolbar | Tab |
| Full screen | ⌘⇧F or F11 |
| Clear selection, then leave full screen | Escape |
| Close current scroll | ⌘W |
| Quit | ⌘Q |

The selection tool uses a rectangle by default. A rectangle that crosses a stroke selects the whole stroke. Moving and copying preserve pressure and stroke shape. Each complete pen stroke, erase gesture, or selection move can be undone.

## Pen controls, shapes and colors

The small circle at the top of the page expands in place after a 200 ms hover. Choose a tool, color, or pen size from the controls that cover it. Small slips outside the controls keep them open; moving farther away closes them after half a second. Clicking or focusing the circle opens them immediately. A focused brightness slider keeps the color picker available while you adjust it.

The shape dropdown offers **Line**, **Arrow**, **Rectangle**, **Ellipse**, and **Triangle**. Choose a shape, then drag in either direction on the page to draw it. Hold Shift for straight angles, squares, circles, or an equilateral triangle. Shapes are ordinary editable strokes: select, move, copy, resize, or undo them with the same controls as handwriting.

The **Pen type** dropdown offers **Pen**, **Pencil**, **Fountain**, and **Marker**. Four widths run from fine through extra broad. Pen pressure produces a pronounced range from light, fine marks to heavy strokes; the selected type and width save with the scroll. Existing writing keeps its original appearance when you change tools.

Choose from eight quick color swatches in one row, or open the color wheel to choose hue and saturation, adjust brightness with the slider, or enter a six-digit hex color. Your chosen color saves with the scroll and applies to new ink and shapes.

## Paper and navigation

The sidebar starts hidden. Its toggle opens paper settings and a list of places on the sheet. Paper can be plain, dotted, ruled, or a square grid, with white, ivory, parchment, and dark backgrounds.

Use **Section**, **Marker**, or **Page break** to add a navigation point at the middle of your view. Sections give larger parts of the scroll a name; markers bookmark a place; page breaks mark boundaries without limiting the continuous canvas. Edit an item's name directly in the sidebar and press Enter to finish. Its symbol jumps to the location; its × removes it. Undo also restores removed navigation points. Paper settings and navigation points save with the scroll.

## Wacom buttons

The app responds to standard mouse-button actions from the pen driver. A useful app-specific Wacom profile assigns the lower pen button to **Right Click**: hold the button, then touch or drag the pen tip across strokes to delete them. A single button click does nothing. Each continuous erase drag is one undo action; lifting the tip ends it. Pressing the button during an existing pen stroke does not begin erasing until you lift and touch down again. Double-click the lower button while hovering to undo. Assign the upper pen button to **Middle Click** for vertical panning; double-click it while hovering to redo. Erasing and dragging to scroll do not count as double-click commands. The toolbar eraser and a pen's rear eraser also erase continuously while in contact with the page.

For tablets with ExpressKeys, useful assignments are **⌘Z**, **⌘⇧Z**, **B**, **E**, **V**, **H**, and **Tab**. A touch strip or ring assigned to vertical scrolling moves along the sheet. ScrollMind handles these events; it does not modify the Wacom driver's button assignments.

## Screens and scrolls

ScrollMind prefers a display with Wacom or Cintiq in its name. Other screens can be selected from its display control. When macOS mirrors screens, they show the same app; independent positioning requires an extended desktop.

The sidebar lists your open scrolls. **New Scroll** creates another; select a scroll to switch, rename it with its pencil button, or close it with ×. Closed scrolls remain saved and can be reopened from **Other scrolls**. Each open scroll keeps its own undo history during the session. The app restores the workspace and active scroll after restarting. New scrolls use the first available name: Scroll, Scroll 1, Scroll 2, and so on. Deleting a scroll frees its name; closing it keeps the name reserved.

The trash button deletes a scroll from the workspace and **Other scrolls**, keeping a recoverable copy in `Documents/ScrollMind/Deleted Scrolls`; other scrolls and any original imported `.sm` file remain unchanged.

**Clear Scroll** removes every stroke, section, marker, and page break from the current scroll in one action. Undo restores all of them together. Paper settings and other open scrolls stay as they were.

The original scroll is `~/Documents/ScrollMind/scroll.sm`; additional scrolls live in `Scrolls/<id>/scroll.sm` under that folder. Each has a recovery snapshot named `scroll.backup.sm`, refreshed at startup, first writing, every five minutes, and clean close. These are self-contained SQLite files. The app saves changes automatically and waits for the final save before quitting. A recovery error appears if neither saved file can be read; damaged files are preserved. Earlier JSON saves migrate automatically, preserving the original JSON files.

## Open and export

Open the sidebar or File menu to save a copy or open another scroll.

| Format | Contents |
| --- | --- |
| `.sm` | Editable scroll, including stroke points, pressure, pen types, colors, paper settings, sections, and markers |
| `.svg` | Vector artwork for the continuous scroll, without app controls |
| `.pdf` | Paginated document for sharing or printing, with manual page breaks respected |

**Export Scroll** writes a copy in the selected format. **Open Scroll** adds an editable working copy of a `.sm` file to the open scrolls, preserving the chosen file and every existing scroll. Canceling either file dialog keeps the workspace unchanged.
