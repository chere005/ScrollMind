<!-- AgentSuite:reference:begin -->
Read and follow the shared baseline at `~/GIT/AgentSuite/AGENTS.md` before working here.
If the checkout is elsewhere, locate `AgentSuite/AGENTS.md` beside this repository's main checkout.
The shared `dtp` and `tdtp` definitions, authorization, and installed result apply in every project and worktree; local lane details do not redefine them.
@~/GIT/AgentSuite/AGENTS.md
<!-- AgentSuite:reference:end -->

- Support macOS 13+ on Apple silicon and Windows 10+ x64; keep portable drawing behavior in src/core and OS integration in src/main.
- Work on a branch, stage explicit paths, and run npm run preflight before merging or pushing; finish checked releases on main.
- Desktop checks must use hidden windows and disposable data; serialize heavy builds and preserve the running app's final save before replacing it.
- Keep scrolls in ~/Documents/ScrollMind (Documents\ScrollMind on Windows) with incremental SQLite saves, recovery snapshots, and a flush before closing or switching.
- Preserve legacy ink appearance and carry pen type, pressure, ordering, and navigation through editing, clipboard, undo, native files, SVG, and PDF.
- Save scrolls separately and restore open tabs; clearing a scroll is undoable, while deleting it retains a recoverable copy and leaves other scrolls untouched.
- Reuse the first free default name (Scroll, Scroll 1, …); closed scrolls reserve names and deleted scrolls do not.
- Keep the writing canvas free of branding; secondary controls collapse into the launcher and hidden sidebar, and dotted paper uses one clear grid without speckled textures.
- Preserve Wacom mappings: lower button plus fresh tip contact erases on tap or drag, hover double-click undoes, and the middle button pans or hover double-clicks to redo.
- This repository is public: keep credentials, private keys, personal scrolls, local machine configuration, build artifacts, and scratch notes out of Git.
- Build releases with npm run release:mac -- --sign-only, verify the Developer ID signature and installed app, then tag and push checked main and publish the signed ZIP with its SHA-256 checksum.
- Build Windows releases with npm run release:win; the NSIS installer is unsigned, so never claim Windows signing, and publish the .exe with its SHA-256 only on explicit request.
- Release versions bump the minor component unless a version is explicitly requested; never claim notarization without Apple's acceptance and a validated stapled ticket.
- Keep README.md, docs/CONTROLS.md, docs/SCROLL-FORMAT.md, and docs/SIGNING.md current; consolidate guidance there instead of accumulating dated notes.
