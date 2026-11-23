#!/usr/bin/env node
// Publish a ScrollMind release without ever leaving a half-attached one visible.
//
//   node tools/publish-release.mjs vX.Y.Z            upload the macOS files to the tag's DRAFT release, wait for the
//                                                    Windows installer the windows-installer workflow attaches, check
//                                                    every file, then publish it as Latest
//   node tools/publish-release.mjs vX.Y.Z --check    change nothing: report what is attached and what is missing
//   --wait MINUTES   keep looking for the Windows files this long (default 0: stop at once)
//   --mac-only       publish without the Windows installer (the owner wants it on every release: say why in the reply)
//
// The guard: the release stays a draft, and the command exits 1, unless the zip, its .sha256 and latest-mac.yml (and,
// unless --mac-only, the installer, its .sha256 and latest.yml) are all attached with their real sizes and the feeds
// describe exactly those files. The zip must also be the one Apple accepted and the stapled ticket verified.
// The macOS files go up zip first and latest-mac.yml last; a published release's assets are never overwritten.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { missingAssets, parseSha256Line, releaseNotes, requiredAssets, verifyFeed, verifyNotarizationRecord } from './release-assets.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function run(executable, args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${executable} ${args[0] ?? ''} failed (${code}): ${stderr.trim().split('\n')[0]}`))));
    child.stdin.end(input ?? '');
  });
}

/** The GitHub side, through the gh CLI. Tests replace it with an in-memory release. */
export function ghBackend(repo, { gh = (args, options) => run('gh', args, options) } = {}) {
  return {
    async findRelease(tag) {
      const rows = (await gh(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--jq', `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {draft, assets: [.assets[] | {name, size, state}]}`]))
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (rows.length > 1) throw new Error(`${rows.length} releases exist for ${tag}; delete all but one on the Releases page.`);
      return rows[0] ?? null;
    },
    createDraft: (tag, title, notes) => gh(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--title', title, '--notes-file', '-'], { input: notes }),
    upload: (tag, file) => gh(['release', 'upload', tag, '--repo', repo, file]),
    readAsset: (tag, name) => gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--output', '-']),
    publish: (tag) => gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']),
  };
}

const sha = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

export function parseArguments(argv) {
  const options = { tag: null, check: false, macOnly: false, wait: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') options.check = true;
    else if (argument === '--mac-only') options.macOnly = true;
    else if (argument === '--wait') {
      options.wait = Number(argv[++index]);
      if (!Number.isFinite(options.wait) || options.wait < 0) throw new Error('--wait takes a number of minutes.');
    } else if (/^v\d+\.\d+\.\d+$/.test(argument) && !options.tag) options.tag = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.tag) throw new Error('Name the release tag, for example: node tools/publish-release.mjs v2.1.0');
  return options;
}

/** The macOS files in dist: they must be the notarized archive, its checksum, and a feed for those bytes. */
async function readLocalMac({ root, version }) {
  const dist = path.join(root, 'dist');
  const zipName = `ScrollMind-${version}-arm64.zip`;
  const zip = await fs.readFile(path.join(dist, zipName)).catch(() => null);
  if (!zip) throw new Error(`dist/${zipName} is missing. Run npm run release:mac.`);
  const zipSha256 = sha('sha256', zip, 'hex');
  const checksum = parseSha256Line(await fs.readFile(path.join(dist, `${zipName}.sha256`), 'utf8').catch(() => ''));
  if (checksum?.name !== zipName || checksum.sha256 !== zipSha256) throw new Error(`dist/${zipName}.sha256 does not match the archive.`);
  const feed = await fs.readFile(path.join(dist, 'latest-mac.yml'), 'utf8').catch(() => '');
  verifyFeed(feed, { version, file: zipName, sha512: sha('sha512', zip, 'base64'), size: zip.length });
  const record = JSON.parse(await fs.readFile(path.join(dist, `ScrollMind-${version}-arm64-notarization.json`), 'utf8').catch(() => 'null'));
  verifyNotarizationRecord(record, { version, zipName, zipSha256 });
  return { dist, zipName, files: [zipName, `${zipName}.sha256`, 'latest-mac.yml'] };
}

/** Once everything is attached, the feeds must describe the sizes GitHub actually holds. */
async function verifyRemoteFeeds(backend, tag, version, assets, { windows }) {
  const size = (name) => assets.find((asset) => asset.name === name)?.size;
  const pairs = [['latest-mac.yml', `ScrollMind-${version}-arm64.zip`], ...(windows ? [['latest.yml', `ScrollMind-Setup-${version}.exe`]] : [])];
  for (const [feedName, fileName] of pairs) {
    const text = await backend.readAsset(tag, feedName);
    const match = /^ {4}size: (\d+)$/m.exec(text);
    const named = /^ {2}- url: (\S+)$/m.exec(text)?.[1];
    if (!match || named !== fileName || Number(match[1]) !== size(fileName)) throw new Error(`${feedName} on the release does not describe ${fileName}.`);
    if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(text)) throw new Error(`${feedName} on the release is not for ${version}.`);
  }
}

export async function publishRelease(argv, {
  root = defaultRoot, backend, git = (args) => run('git', args, { cwd: root }), log = console.log, sleep = delay, now = Date.now,
} = {}) {
  const options = parseArguments(argv);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = options.tag.slice(1);
  if (version !== pkg.version) throw new Error(`The tag is ${options.tag} but package.json says ${pkg.version}.`);
  const feed = pkg.build?.publish?.find?.((entry) => entry.provider === 'github');
  if (!backend && !feed) throw new Error('build.publish must name the GitHub release feed.');
  backend ??= ghBackend(`${feed.owner}/${feed.repo}`);
  const required = requiredAssets(version, { windows: !options.macOnly });
  const wanted = [...required.mac, ...required.win];

  let release = await backend.findRelease(options.tag);
  const describe = () => (release ? missingAssets(release.assets, wanted) : wanted);

  if (options.check) {
    const missing = describe();
    log(release ? `${options.tag} is ${release.draft ? 'a draft' : 'published'}.` : `${options.tag} has no release yet.`);
    if (missing.length) { log(`Missing: ${missing.join(', ')}`); return { ok: false, missing }; }
    log('Every file is attached.');
    return { ok: true, missing: [] };
  }
  if (release && !release.draft) {
    const missing = describe();
    if (missing.length) throw new Error(`${options.tag} is already published and lacks ${missing.join(', ')}. A published release is never overwritten; ship the next minor.`);
    log(`${options.tag} is already published with every file.`);
    return { ok: true, missing: [] };
  }

  // The tag must be the commit in this checkout: the files in dist were built here.
  const tagged = (await git(['rev-parse', `refs/tags/${options.tag}^{commit}`])).trim();
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  if (tagged !== head) throw new Error(`${options.tag} is not the commit checked out here, so dist was not built from it.`);

  const mac = await readLocalMac({ root, version });
  if (!release) {
    const annotation = await git(['for-each-ref', `refs/tags/${options.tag}`, '--format=%(contents)']);
    const commitMessage = await git(['log', '-1', '--format=%B', `${options.tag}^{commit}`]);
    try { await backend.createDraft(options.tag, `ScrollMind ${version}`, releaseNotes({ version, annotation, commitMessage })); } catch (error) {
      release = await backend.findRelease(options.tag); // the Windows workflow may have created the draft a moment ago
      if (!release) throw error;
    }
    release = await backend.findRelease(options.tag);
    if (!release?.draft) throw new Error(`The draft release for ${options.tag} could not be created.`);
  }

  // Zip first, checksum next, the feed last. A file already attached with the right size is kept, never replaced.
  for (const name of mac.files) {
    if (!missingAssets(release.assets, [name]).length) continue;
    await backend.upload(options.tag, path.join(mac.dist, name));
    log(`Uploaded ${name}`);
  }

  const deadline = now() + options.wait * 60_000;
  for (;;) {
    release = await backend.findRelease(options.tag);
    const missing = describe();
    if (!missing.length) break;
    if (now() >= deadline) {
      log(`${options.tag} stays a draft. Missing: ${missing.join(', ')}`);
      throw new Error(`Not published: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not attached.`);
    }
    log(`Waiting for ${missing.join(', ')}`);
    await sleep(30_000);
  }

  await verifyRemoteFeeds(backend, options.tag, version, release.assets, { windows: !options.macOnly });
  await backend.publish(options.tag);
  const after = await backend.findRelease(options.tag);
  const stillMissing = after ? missingAssets(after.assets, wanted) : wanted;
  if (!after || after.draft || stillMissing.length) throw new Error(`${options.tag} did not publish cleanly${stillMissing.length ? `; missing ${stillMissing.join(', ')}` : ''}.`);
  log(`${options.tag} is published with ${wanted.length} files.`);
  return { ok: true, missing: [] };
}

if (runDirectly) {
  await publishRelease(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
