# Distribution

This page covers the notarized macOS build, the Windows installer, the update feeds, and publishing a release.

## macOS

The macOS archive is Developer ID signed with Hardened Runtime and notarized by Apple, with the ticket stapled into the app. It is Apple silicon only: the script refuses a non-arm64 node and checks the app and the pen helper with `lipo`. Releases up to 2.0.0 were signed but not notarized.

## Build a release

A release build requires an Apple silicon Mac, Xcode command-line tools, installed npm dependencies, a Developer ID Application certificate with its private key in the signing keychain, and a notarytool keychain profile. Configure `build.mac.identity` in `package.json` with the certificate's identity qualifier, without the `Developer ID Application:` prefix; the script checks that the full `Developer ID Application: Sean Cheren (2LGYTL3FSJ)` identity exists and never picks an identity by itself. Keep credentials and private keys outside the repository.

`npm run release:mac` first compiles the Wacom side-button helper (`tools/pen/scroll-pen.swift`, needs the Xcode command-line tools) into `build/bin/scroll-pen`, which ships in `Contents/Resources` and is signed with the app; it runs the preflight checks, builds the arm64 macOS app, verifies app and nested signatures, checks the packaged version, entitlements and update feed, submits the archive to Apple, waits for acceptance, staples the app, checks it with `stapler validate` and `spctl` (which must say Notarized Developer ID), and creates:

```text
dist/ScrollMind-<version>-arm64.zip           the notarized, stapled app
dist/ScrollMind-<version>-arm64.zip.sha256    its checksum, in sha256sum format
dist/latest-mac.yml                           the update feed for that ZIP
dist/ScrollMind-<version>-arm64-notarization.json   the local record the publish guard reads
```

The archive is CRC checked and replaced atomically. Publishing a GitHub release is a separate step (below).

| Command | Purpose |
| --- | --- |
| `node tools/release-mac.mjs --check` | Verify the signing identity and notarization credentials without building |
| `npm run release:mac` | Preflight, build, sign, notarize, staple, verify, archive |
| `node tools/release-mac.mjs --resume` | Continue notarization from the matching saved archive and submission |
| `node tools/release-mac.mjs --verify` | Verify an existing stapled application |
| `node tools/release-mac.mjs --sign-only` | Scratch build: signed archive, no Apple submission (`dist/ScrollMind-<version>-arm64-signed.zip`; never publish it) |
| `npm run build:mac` | Build the signed application bundle without the release archive checks |

Notarization uses the `DisplayMind` notarytool keychain profile, the same profile every MindSuite app uses on this Mac; `release-mac.mjs --check` fails with a pointer to these overrides when the profile does not resolve in the shell that runs it. `APPLE_KEYCHAIN_PROFILE` or `SCROLLMIND_NOTARY_PROFILE` selects another profile, optionally with `APPLE_KEYCHAIN`; an App Store Connect API key works through `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (individual keys use `SCROLLMIND_NOTARY_INDIVIDUAL_KEY=1`). Submission records and rejection logs stay under `dist`; they are local release records, not public release notes. Saved archive hashes prevent resuming against a different build.

Both app and helper entitlements allow V8 JIT. The release verifier rejects unsigned-executable-memory and disabled-library-validation entitlements.

## Updates

The app updates itself from this repository's GitHub releases with `electron-updater`, on macOS and on Windows. `build.publish` and the checked-in `build/app-update.yml` (copied into `Contents/Resources/app-update.yml` by `build.extraResources`, because electron-builder writes none for a `dir` build) name the feed; the release script refuses an app without it. It reads `latest-mac.yml` (macOS) or `latest.yml` (Windows) from the repository's Latest release, so a release is only ever published once both feeds are attached. The release scripts write each feed from the real SHA-512 and size of the file it names.

Squirrel.Mac only accepts an update signed by the same Developer ID as the running app, and only the Developer ID signed build in a writable location updates itself. Notarization is not needed for self-updates, because the app downloads them itself; it is what lets a browser-downloaded first install open without a warning. The first release that carries the updater must be installed by hand; later releases arrive through it. Update files carry no separate update-signing key: integrity rests on HTTPS, the SHA-512 in the feed, and (macOS) the Developer ID signature.

## Publish a release

1. Merge to main, then `npm run release:mac` on that commit (notarized ZIP, checksum, feed in `dist`). The script refuses tracked uncommitted changes and writes the commit and source tree it built into the notarization record.
2. Tag `vX.Y.0` on that commit, push main and the tag. The tag push starts the **Windows installer** workflow (`.github/workflows/windows-installer.yml`), which creates the tag's draft release if it is missing and attaches the three Windows files.
3. `node tools/publish-release.mjs vX.Y.0 --wait 30` uploads the macOS files to the same draft, ZIP first, checksum next, `latest-mac.yml` last, waits for the Windows files, and publishes the release as Latest.
4. Install the release: quit ScrollMind, `ditto dist/mac-arm64/ScrollMind.app /Applications/ScrollMind.app`, verify the installed copy with `codesign --verify --deep --strict`, `spctl --assess --type execute` and `xcrun stapler validate`, and relaunch it. Scrolls in `~/Documents/ScrollMind` and Application Support are not touched.
5. Record the tag in MindSuite's version with `node ../MindSuite/tools/mindsuite-release.mjs record ScrollMind vX.Y.0 --app-repo .`.

The guard refuses to publish, exits 1 and leaves the release a draft unless all of these hold: the tag is the version in `package.json` and the commit checked out; the notarization record says Apple accepted the exact ZIP in `dist`, its ticket is stapled and Gatekeeper accepted, and its source tree is the tagged commit's tree (so macOS and Windows get the same code); the ZIP, its `.sha256`, `latest-mac.yml`, the installer, its `.sha256` and `latest.yml` are all attached with non-zero size; and the bytes GitHub holds are the verified ones: the ZIP hashes (SHA-256 and SHA-512) to the local notarized archive, the `.sha256` and `latest-mac.yml` equal the local files, and the installer hashes to what its `.sha256` and `latest.yml` (name, version, size, SHA-512) say. Uploads to the draft use `--clobber`, so a stale or half-uploaded copy from an earlier attempt is replaced by the verified local file. `--check` reports without changing anything; `--mac-only` publishes without the Windows files (the owner wants them on every release, so say why). A published release's assets are never overwritten; to withdraw a bad one, return it to draft so the previous release is Latest again, then ship the next minor.

If the Windows workflow ends with a file missing it dispatches itself again, up to three runs. Retry by hand with `gh workflow run windows-installer.yml --ref vX.Y.0 -f tag=vX.Y.0`, never `gh run rerun` (see AgentSuite `ci.md`, quiet CI).

References: [Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [electron-builder macOS configuration](https://www.electron.build/v26/docs/api/app-builder-lib.interface.macconfiguration/).

## Windows

The Windows installer is a per-user NSIS package (`ScrollMind-Setup-<version>.exe`) that needs no administrator rights. It is **not code signed**: the owner chose not to buy an Authenticode certificate, so SmartScreen may warn on first run, and nothing here may call it signed or gate a release on a signature. It registers the `.sm` file type. `build.win.signExecutable` and `build.win.forceCodeSigning` are `false`; the top-level `forceCodeSigning: true` applies to macOS only. Updates the app downloads itself are checked against the SHA-512 in `latest.yml` over HTTPS and do not show the SmartScreen warning.

The installer is built by the **Windows installer** GitHub Actions workflow on a `windows-latest` runner (the Mac cannot build an NSIS installer). It follows the quiet-CI rules: a person's run only hands off to `github-actions[bot]`, every job is `continue-on-error`, nothing is cancelled, and a missing file is retried by dispatching again. For a tag it checks the tag against `package.json` and `package-lock.json`, runs `npm test` (the write token is handed only to the release steps, never to `npm ci` or the tests, and the actions are pinned to commit SHAs), runs `node tools/release-win.mjs` (installer, packaged-version and update-feed checks, `.sha256`, `latest.yml`), and attaches `ScrollMind-Setup-<version>.exe`, its `.sha256` and `latest.yml` (last) to the tag's draft release.

`tools/release-win.mjs` builds only on Windows; `--check` validates the configuration anywhere.

| Command | Purpose |
| --- | --- |
| `node tools/release-win.mjs --check` | Validate the Windows build configuration without building |
| `npm run release:win` | On a Windows machine: preflight, then the installer, checksum and feed in `dist/` (the workflow does this for a release) |
| `npm run build:win` | Build the installer without the release checks |
| `npm run build:win:dir` | Build only the unpacked app in `dist/win-unpacked` |
