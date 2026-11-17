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
| Scroll vertically | Mouse wheel or trackpad |
| Pan vertically | Space + drag, or middle-button drag |
| Return to starting point | ⌘0 |
| Hide or show toolbar | Tab |
| Full screen | ⌘⇧F or F11 |
| Clear selection, then leave full screen | Escape |
| Quit | ⌘Q |

The selection tool uses a rectangle by default. A rectangle that crosses a stroke selects the whole stroke. Moving and copying preserve pressure and stroke shape. Each complete pen stroke, erase gesture, or selection move can be undone.

## Paper and navigation

The sidebar starts hidden. Its toggle opens paper settings and a list of places on the sheet. Paper can be plain, dotted, ruled, or a square grid, with white, ivory, parchment, and dark backgrounds.

Use **Section**, **Marker**, or **Page break** to add a navigation point at the middle of your view. Sections give larger parts of the scroll a name; markers bookmark a place; page breaks mark boundaries without limiting the continuous canvas. Edit an item's name directly in the sidebar and press Enter to finish. Its symbol jumps to the location; its × removes it. Undo also restores removed navigation points. Paper settings and navigation points save with the scroll.

## Wacom buttons

The app responds to standard mouse-button actions from the pen driver. A useful app-specific Wacom profile assigns the lower pen button to **Right Click** for temporary erasing and the upper pen button to **Middle Click** for vertical panning. A pen with a rear eraser can also erase by flipping it over. Erasing requires pen contact so a hovering barrel button does not remove writing.

For tablets with ExpressKeys, useful assignments are **⌘Z**, **⌘⇧Z**, **B**, **E**, **V**, **H**, and **Tab**. A touch strip or ring assigned to vertical scrolling moves along the sheet. ScrollMind handles these events; it does not modify the Wacom driver's button assignments.

## Screens and scrolls

ScrollMind prefers a display with Wacom or Cintiq in its name. Other screens can be selected from its display control. When macOS mirrors screens, they show the same app; independent positioning requires an extended desktop.

The current scroll is `~/Documents/ScrollMind/scroll.sm`; its recovery snapshot is `scroll.backup.sm` in the same folder, refreshed at startup, first writing, every five minutes, and clean close. These are self-contained SQLite files. The app saves changes automatically and waits for the final save before quitting. A recovery error appears if neither saved file can be read; damaged files are preserved. Earlier JSON saves migrate automatically, preserving the original JSON files.

## Open and export

Open the sidebar or File menu to save a copy or open another scroll.

| Format | Contents |
| --- | --- |
| `.sm` | Editable scroll, including stroke points and pressure, colors, paper settings, sections, and markers |
| `.svg` | Vector artwork for the continuous scroll, without app controls |
| `.pdf` | Paginated document for sharing or printing, with manual page breaks respected |

**Export Scroll** writes a copy in the selected format. **Open Scroll** imports an editable working copy of a `.sm` file, preserving the chosen file and first archiving any current writing in `Documents/ScrollMind/Saved Scrolls`. Canceling either file dialog keeps the current scroll unchanged.
