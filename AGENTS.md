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
- **Standing rule: the pen buttons must never break.** docs/PEN-BUTTONS.md is the behavior Sean set and confirmed (1.8.0): lower held + tip = delete, lower double-tap = undo; upper held + tip drag = scroll, upper double-tap = redo; lower tapped then upper held + tip drag = zoom (up in, down out); a held button is a mode until let go, and alone does nothing. Change it only on Sean's explicit word, with that page and its tests in the same commit; never weaken, skip or remove the contract tests (tests/pen-contract-doc.test.mjs checks they exist). Run `npm run test:pen` after any change to pen input, the helper, the canvas or event routing, and ship nothing that fails it. On a Mac the Wacom One 12 is read from the display itself (tools/pen/scroll-pen.swift, needs Input Monitoring); read ~/Documents/ScrollMind/Logs/pen.log first when a button seems wrong.
- This repository is public: keep credentials, private keys, personal scrolls, local machine configuration, build artifacts, and scratch notes out of Git.
- Build releases with npm run release:mac -- --sign-only, verify the Developer ID signature and installed app, then tag and push checked main and publish the signed ZIP with its SHA-256 checksum.
- Build Windows releases with npm run release:win; the NSIS installer is unsigned, so never claim Windows signing, and publish the .exe with its SHA-256 only on explicit request.
- Publish releases with the ZIP first and its dist/latest-mac.yml last, the feed the in-app updater reads; never overwrite a published release's assets.
- ScrollMind is part of MindSuite: once a release is published, record its tag with `node ../MindSuite/tools/mindsuite-release.mjs record ScrollMind vX.Y.0 --app-repo .` (MindSuite's minor goes up, with a note naming the tag).
- Release versions bump the minor component unless a version is explicitly requested; never claim notarization without Apple's acceptance and a validated stapled ticket.
- Keep README.md, docs/CONTROLS.md, docs/SCROLL-FORMAT.md, and docs/SIGNING.md current; consolidate guidance there instead of accumulating dated notes.
