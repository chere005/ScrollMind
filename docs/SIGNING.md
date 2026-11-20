# Distribution

This page covers macOS signed builds and the Windows installer.

## macOS

The public macOS archive is Developer ID signed with Hardened Runtime. **The current public release is not notarized.**

## Build a signed release

A release build requires an Apple silicon Mac, Xcode command-line tools, installed npm dependencies, and a Developer ID Application certificate with its private key in the signing keychain. Configure `build.mac.identity` in `package.json` with the certificate's identity qualifier, without the `Developer ID Application:` prefix. Keep credentials and private keys outside the repository.

`npm run release:mac` runs the preflight checks, builds the arm64 macOS app, verifies app and nested signatures, checks the packaged version and entitlements, and creates:

```text
dist/ScrollMind-<version>-<arch>-signed.zip
```

The archive is CRC checked and replaced atomically. A local report records its SHA-256 hash and signing status. The tool creates local artifacts; publishing a GitHub release is a separate step.

| Command | Purpose |
| --- | --- |
| `node tools/release-mac.mjs --check` | Validate signing configuration without building |
| `node tools/release-mac.mjs --sign-only` | Build and verify a signed archive after preflight |
| `npm run build:mac` | Build the signed application bundle without the release archive checks |

Both app and helper entitlements allow V8 JIT. The release verifier rejects unsigned-executable-memory and disabled-library-validation entitlements.

## Updates

The app updates itself from this repository's GitHub releases with `electron-updater`. `build.publish` names the feed, and electron-builder writes it into `Contents/Resources/app-update.yml`; the release script refuses an app without it. The release script also writes `dist/latest-mac.yml` from the ZIP's real SHA-512 and size.

To publish a macOS release, upload the ZIP first and `latest-mac.yml` last, under that exact name. Never overwrite the assets of a published release; to withdraw a bad one, return it to draft so the previous release is Latest again, then ship the next minor. Squirrel.Mac only accepts an update signed by the same Developer ID as the running app, and only the Developer ID signed build in a writable location updates itself. Windows updates need `latest.yml` (written by `npm run release:win`) uploaded after the installer, and are untested without a Windows machine.

Notarization is not required for updates, because the app downloads them itself. The first release that carries the updater must be installed by hand; later releases arrive through it.

## Optional notarization

Notarization is an explicit release choice. The default release command does not submit anything to Apple.

Use an existing Keychain profile through `APPLE_KEYCHAIN_PROFILE`, optionally selecting its keychain with `APPLE_KEYCHAIN`. Alternatively, set `APPLE_API_KEY` to a private-key file path, with `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. Individual API keys use `SCROLLMIND_NOTARY_INDIVIDUAL_KEY=1` instead of an issuer.

| Command | Purpose |
| --- | --- |
| `node tools/release-mac.mjs --check --notarize` | Verify notarization authentication without submitting |
| `node tools/release-mac.mjs --notarize` | Build, submit, await acceptance, staple, and verify Gatekeeper acceptance |
| `node tools/release-mac.mjs --resume` | Continue notarization from the matching saved archive and submission |
| `node tools/release-mac.mjs --verify` | Verify an existing stapled application |

A successful notarized build creates `dist/ScrollMind-<version>-<arch>.zip`. Submission records and rejection logs remain under `dist`; they are local release records, not public release notes. Saved archive hashes prevent resuming against a different build.

References: [Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [electron-builder macOS configuration](https://www.electron.build/v26/docs/api/app-builder-lib.interface.macconfiguration/).

## Windows

The Windows installer is an unsigned, per-user NSIS package (`dist/ScrollMind-Setup-<version>.exe`) that needs no administrator rights. No Windows code-signing certificate is used, so SmartScreen may warn on first run. It registers the `.sm` file type. `build.win.forceCodeSigning` is `false`; the top-level `forceCodeSigning: true` still applies to macOS.

`npm run release:win` runs the preflight checks, builds the installer, checks that the packaged app reports the package name and version, and writes the installer's SHA-256 file and a local release report marked unsigned in `dist/`. It starts no GitHub release or Actions run.

| Command | Purpose |
| --- | --- |
| `node tools/release-win.mjs --check` | Validate the Windows build configuration without building |
| `npm run build:win` | Build the installer without the release checks |
| `npm run build:win:dir` | Build only the unpacked app in `dist/win-unpacked` |

Publishing the .exe with its checksum alongside the macOS ZIP is a manual `gh` step, done only on explicit request. Never describe the installer as signed.
