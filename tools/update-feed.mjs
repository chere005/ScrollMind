import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** The electron-updater feed (latest-mac.yml / latest.yml) for one downloadable file. */
export function feedYaml({ version, file, sha512, size, releaseDate }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The update feed needs a plain x.y.z version.');
  if (!SAFE_NAME.test(file)) throw new Error('The update file name may only use letters, digits, dots, dashes and underscores.');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('The update feed needs a base64 SHA-512.');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('The update file is empty.');
  return [`version: ${version}`, 'files:', `  - url: ${file}`, `    sha512: ${sha512}`, `    size: ${size}`, `path: ${file}`, `sha512: ${sha512}`, `releaseDate: '${releaseDate}'`, ''].join('\n');
}

/** Write the feed beside the file it describes, atomically, from that file's actual bytes. */
export async function writeFeed(destination, { version, file }) {
  const data = await fs.readFile(file);
  const text = feedYaml({
    version, file: path.basename(file), size: data.length,
    sha512: createHash('sha512').update(data).digest('base64'), releaseDate: new Date().toISOString(),
  });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return text;
}

/** The installed app must carry the feed location electron-builder wrote from build.publish. */
export function verifyAppFeed(text, { owner, repo }) {
  if (!/^provider:\s*github\s*$/m.test(text) || !new RegExp(`^owner:\\s*${owner}\\s*$`, 'm').test(text) || !new RegExp(`^repo:\\s*${repo}\\s*$`, 'm').test(text)) {
    throw new Error('The packaged app has no GitHub update feed. Check build.publish in package.json.');
  }
}
