// What a ScrollMind GitHub release must carry, and the pure checks tools/publish-release.mjs makes before it
// publishes one. Nothing here touches the network or the disk.

const VERSION = /^\d+\.\d+\.\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** The sha256sum line for one file: "<hex>  <name>\n". */
export function sha256Line(sha256, fileName) { return `${sha256}  ${fileName}\n`; }

/** Parse one sha256sum line back into its hash and file name. */
export function parseSha256Line(text) {
  const match = /^([0-9a-f]{64}) {2}(\S+)\n?$/.exec(text);
  return match ? { sha256: match[1], name: match[2] } : null;
}

/**
 * The files a release needs, in the order they are uploaded: the download first, its checksum next, the update feed
 * last (the feed is what the in-app updater reads, so it must never point at a file that is not there yet).
 */
export function requiredAssets(version, { windows = true } = {}) {
  if (!VERSION.test(version)) throw new Error('A release needs a plain x.y.z version.');
  const mac = [`ScrollMind-${version}-arm64.zip`, `ScrollMind-${version}-arm64.zip.sha256`, 'latest-mac.yml'];
  const win = [`ScrollMind-Setup-${version}.exe`, `ScrollMind-Setup-${version}.exe.sha256`, 'latest.yml'];
  return { mac, win: windows ? win : [] };
}

/** Which of `required` are not among the release's `assets` ({ name, size, state? }); an empty or half-uploaded asset does not count. */
export function missingAssets(assets, required) {
  const present = new Set((assets ?? []).filter((asset) => asset.size > 0 && (asset.state ?? 'uploaded') === 'uploaded').map((asset) => asset.name));
  return required.filter((name) => !present.has(name));
}

/** The fields of an electron-updater feed that the checks need: version, file, sha512, size. */
export function parseFeed(text) {
  const field = (pattern) => pattern.exec(text)?.[1];
  const url = field(/^ {2}- url: (\S+)$/m);
  const sha512 = field(/^ {4}sha512: (\S+)$/m);
  const size = Number(field(/^ {4}size: (\d+)$/m));
  const version = field(/^version: (\S+)$/m);
  const path = field(/^path: (\S+)$/m);
  const top512 = field(/^sha512: (\S+)$/m);
  if (!version || !url || !sha512 || !Number.isSafeInteger(size) || size <= 0) throw new Error('The update feed is not a ScrollMind feed.');
  if (path !== url || top512 !== sha512) throw new Error('The update feed names two different files.');
  return { version, file: url, sha512, size };
}

/** A feed must describe exactly this version and this file's real bytes. */
export function verifyFeed(text, { version, file, sha512, size }) {
  const feed = parseFeed(text);
  if (feed.version !== version) throw new Error(`The update feed says ${feed.version}, not ${version}.`);
  if (feed.file !== file) throw new Error(`The update feed points at ${feed.file}, not ${file}.`);
  if (feed.size !== size) throw new Error(`The update feed size ${feed.size} is not the file's ${size}.`);
  if (feed.sha512 !== sha512) throw new Error(`The update feed hash does not match ${file}.`);
}

/**
 * The macOS archive may be published as notarized only when Apple accepted it and the ticket is stapled: that is the
 * record tools/release-mac.mjs --notarize writes after it has re-verified the stapled app with Gatekeeper.
 */
export function verifyNotarizationRecord(record, { version, zipName, zipSha256 }) {
  if (!record || record.version !== version) throw new Error('There is no notarization record for this version. Run npm run release:mac.');
  if (record.status !== 'Accepted' || record.stapled !== true || record.gatekeeperAccepted !== true) {
    throw new Error(`The macOS archive is not notarized (record says "${record.status}"). Run npm run release:mac, or --resume it.`);
  }
  if (!HEX64.test(record.sha256 ?? '') || record.sha256 !== zipSha256) throw new Error('The notarization record is for a different archive than dist holds. Rebuild and notarize again.');
  if (!String(record.archive ?? '').endsWith(`/${zipName}`)) throw new Error('The notarization record names a different archive.');
}

/** Release notes: the tag's annotation without trailer lines, else the tagged commit's message, else a one-liner. */
export function releaseNotes({ version, annotation = '', commitMessage = '' }) {
  const drop = /^(Co-Authored-By|Signed-off-by):/i;
  const clean = (text) => text.split('\n').filter((line) => !drop.test(line)).join('\n').trim();
  const body = clean(annotation) || clean(commitMessage) || `ScrollMind ${version}`;
  return `${body}

## Installing

- **macOS** (Apple silicon, macOS 13 or later): unzip \`ScrollMind-${version}-arm64.zip\` and drag ScrollMind to Applications. It is Developer ID signed and notarized by Apple.
- **Windows** (64-bit, Windows 10 or later): run \`ScrollMind-Setup-${version}.exe\`. The installer is not code signed, so SmartScreen may say "Windows protected your PC": choose More info, then Run anyway.

Each download has a \`.sha256\` file. ScrollMind updates itself from \`latest-mac.yml\` and \`latest.yml\`.
`;
}
