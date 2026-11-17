# Native scroll format

An **.sm** file is a SQLite database containing editable ink, paper settings, the saved view, and navigation points. Use **Export Scroll** to create a standalone file for sharing or backup. Working files can have SQLite WAL companions; exported .sm files include their committed contents without depending on those companions.

## Files on disk

ScrollMind keeps its data in `~/Documents/ScrollMind` (`Documents\ScrollMind` on Windows):

| Path | Contents |
| --- | --- |
| `scroll.sm` | Original working scroll |
| `Scrolls/<id>/scroll.sm` | Additional working scrolls |
| `scroll.backup.sm` beside each working file | Recovery snapshot |
| `workspace.json` | Scroll names, open/closed state, and active scroll |
| `Deleted Scrolls/<archive-id>/` | Recoverable deleted scroll and deletion record |

Recovery snapshots refresh at startup, first writing, every five minutes, and clean close. Corrupt files are preserved during recovery. Saves are flushed to disk (fsync through writable handles on Windows) and files are replaced by renames, which NTFS journals. Opening an external .sm creates a managed working copy and leaves the source unchanged. Earlier JSON saves migrate automatically, preserving their originals.

## Schema

The SQLite application ID is `0x534d4e44` (`SMND`), and `PRAGMA user_version` is **3**. The portable document version remains **1**.

| Table | Columns |
| --- | --- |
| `strokes` | `id`, `order_index`, `color`, `width`, `points`, `bounds`, `pen_type` |
| `markers` | `id`, `y`, `label`, `kind` |
| `metadata` | `key`, `value` |

Stroke points are JSON arrays of `{x,y,p}` objects. Coordinates are signed world coordinates; `p` preserves pressure precision. `order_index` defines drawing order. `bounds` stores a derived JSON geometry cache; readers should recompute it from the point data and current brush geometry.

`pen_type` is `pen`, `pencil`, `fountain`, `marker`, or `highlighter`. An explicit `pen` uses the current brush. SQL `NULL` maps to an absent document `penType` field and preserves legacy ink appearance. Settings can separately store the selected `penType`. Highlighter transparency is a brush property; native files retain the original stroke color and point data.

Marker kinds are `section`, `page-break`, and `marker`. Metadata stores `view` and `settings` as JSON, including paper, color, width, and selected pen style when present.

## Compatibility

Schema 1 and 2 files remain valid read-only import sources. Managed files upgrade transactionally, adding nullable `pen_type` with default `NULL` for schema 1 while preserving existing point JSON and legacy styles. Schema 3 adds Highlighter support without changing the schema 2 columns. New exports and refreshed backups use schema 3 so older readers reject unsupported pen styles without treating the file as damaged.

Unsupported future versions are rejected and preserved. Native exports use SQLite's backup API and a rollback journal to produce an independent .sm file.
