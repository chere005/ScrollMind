# Native Scroll and Grid formats

A **.sm** file is a ScrollMind database: either a Scroll (editable ink, paper settings, the saved view, and navigation points) or a Grid (editable ink, shapes, connections, Grid settings, and its saved view). The SQLite application ID says which, so ScrollMind opens either from its contents whatever the file is named. Early Grid files were named **.smg**; they still open. Export either document for sharing or backup. Working databases may have SQLite WAL companions. Exports include the committed contents.

## Reading a .sm without SQLite

`src/core/sm-file.mjs` reads a **.sm** in a browser: a small read-only reader of the SQLite file format (table b-trees, overflow pages, records) that returns the same validated snapshot the desktop's `readNative()` returns, and the kind from the application ID. It reads files with `journal_mode=DELETE`, which every export and every iCloud Drive copy is; it refuses one still in write-ahead-log mode. `tests/sm-file.test.mjs` compares it with the desktop reader on files the desktop's own storage writes.

## Files on disk

ScrollMind keeps its data in `~/Documents/ScrollMind` (`Documents\ScrollMind` on Windows):

| Path | Contents |
| --- | --- |
| `scroll.sm` | Original working scroll |
| `Scrolls/<id>/scroll.sm` | Additional working scrolls |
| `scroll.backup.sm` beside each working file | Recovery snapshot |
| `workspace.json` | Scroll names, open/closed state, and active scroll |
| `Deleted Scrolls/<archive-id>/` | Recoverable deleted Scroll and deletion record |
| `Grids/grid.smg`, `Grids/Items/<id>/grid.smg` | Working Grids with adjacent `grid.backup.smg` files |
| `Grids/workspace.json` | Grid list, open/closed state, and active Grid |
| `Grids/Deleted Grids/<archive-id>/` | Recoverable deleted Grid and deletion record |
| `active-workspace` | Most recently viewed workspace |
| `App/icloud-copy.json`, `App/icloud-copy-state.json` | Whether Copy to iCloud Drive is on, and the copies it made (by document, with the name and a fingerprint of the source) |
| `Logs/icloud-copy.log` | What the iCloud Drive copy did, and any copy that failed |

Recovery snapshots refresh at startup, first writing, every five minutes, and clean close. Corrupt files are preserved during recovery. Saves are flushed to disk (fsync through writable handles on Windows) and files are replaced by renames, which NTFS journals. Opening an external .sm or .smg creates a managed working copy and leaves the source file intact. Earlier JSON saves migrate automatically, preserving their originals.

## Schema

Scrolls use SQLite application ID `0x534d4e44` (`SMND`) and schema **5**. Grids use application ID `0x534d4752` (`SMGR`) and schema **2**. Schema 5 and Grid schema 2 added fills; older versions refuse files of these versions instead of misreading them. Both use the following SQLite tables and portable document version **1**.

| Table | Columns |
| --- | --- |
| `strokes` | `id`, `order_index`, `color`, `width`, `points`, `bounds`, `pen_type` |
| `markers` | `id`, `y`, `label`, `kind` |
| `metadata` | `key`, `value` |

Stroke points are JSON arrays of `{x,y,p}` objects. Coordinates are signed world coordinates; `p` preserves pressure precision. `order_index` defines drawing order. `bounds` stores a derived JSON geometry cache; readers should recompute it from the point data and current brush geometry.

`pen_type` is `pen`, `pencil`, `fountain`, `marker`, `highlighter`, or `fill`. A fill's `points` are the outline of a colored area, closed implicitly; a point with pressure 0 starts a further outline (an island left unfilled). It is filled with the even-odd rule, drawn beneath all ink, and exported as a filled SVG path. An explicit `pen` uses the current brush. SQL `NULL` maps to an absent document `penType` field and preserves legacy ink appearance. Settings can separately store the selected `penType`. Highlighter transparency is a brush property; native files retain the original stroke color and point data.

Marker kinds are `section`, `page-break`, and `marker`. Metadata stores `view` and `settings` as JSON, including paper, color, width, and selected pen style when present. Grid settings store the cell and block counts, grid paper color, and the last picked shape. Each document records its own pan and zoom. An optional `settings.palette` stores eight named six-digit hex colors in pen bar order.

The optional `diagram` metadata stores `nodes` with shape IDs, types, bounds and colors, plus `connections` with source and target shape IDs and the source handle index. The renderer derives routes from the current shapes, so moving a shape needs to update only its bounds. Grid page extents are derived from ink and diagram bounds.

## Compatibility

Schema 1–3 files remain valid read-only import sources. Managed files upgrade transactionally, adding nullable `pen_type` with default `NULL` for schema 1 while preserving existing point JSON and legacy styles. Schema 3 added Highlighter support. Scroll schema 4 supports zoom. Earlier Grid previews stored hybrid documents in Scroll schema 4. When opening one, the app saves a separate Grid with the ink, shapes, and Grid settings, then removes the Grid fields from the managed Scroll. The Scroll keeps its ink and navigation points.

Unsupported future versions are rejected and preserved. Native exports use SQLite's backup API and a rollback journal to produce independent .sm files.
