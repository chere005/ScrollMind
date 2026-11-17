# Native scroll format

`.sm` files are SQLite databases with application ID `0x534d4e44` (`SMND`). Current SQL schema version is 2 (`PRAGMA user_version`); the portable in-memory document version remains 1.

`strokes` stores `id`, `order_index`, `color`, `width`, point JSON, bounds JSON, and nullable `pen_type`. Point objects retain their original `{x,y,p}` values, including signed coordinates and pressure precision. `pen_type` is one of `pen`, `pencil`, `fountain`, or `marker`; explicit `pen` identifies the current pen brush. SQL `NULL` means legacy ink and maps to an absent stroke `penType` field, preserving its original appearance. Settings can independently retain the selected `penType`.

Schema 1 files remain valid read-only imports and are not modified when opened as sources. Managed working files upgrade from schema 1 by transactionally adding nullable `pen_type` with default `NULL`; existing point JSON and legacy stroke metadata remain unchanged. New files, exports, and refreshed backups use schema 2. Unsupported future versions are preserved and rejected rather than overwritten.

`markers` stores sections, page breaks, and named markers; `metadata` stores the view and settings as JSON. Native exports use SQLite's backup API and a standalone rollback journal, so their committed contents can be opened independently of the working scroll's WAL files.
