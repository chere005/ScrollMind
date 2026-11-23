import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedYaml } from '../tools/update-feed.mjs';
import { ghBackend, parseArguments, publishRelease } from '../tools/publish-release.mjs';
import { missingAssets, parseFeed, parseSha256Line, releaseNotes, requiredAssets, sha256Line, verifyFeed, verifyNotarizationRecord } from '../tools/release-assets.mjs';

const VERSION = '2.1.0';
const TAG = `v${VERSION}`;
const hash = (algorithm, data, encoding) => createHash(algorithm).update(data).digest(encoding);

async function fixture({ notarized = true, windows = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scrollmind-publish-'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: VERSION, build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } }));
  const zipName = `ScrollMind-${VERSION}-arm64.zip`;
  const zip = Buffer.from('notarized zip bytes');
  await writeFile(join(root, 'dist', zipName), zip);
  await writeFile(join(root, 'dist', `${zipName}.sha256`), sha256Line(hash('sha256', zip, 'hex'), zipName));
  const feed = (version, file, bytes) => feedYaml({ version, file, sha512: hash('sha512', bytes, 'base64'), size: bytes.length, releaseDate: '2026-11-23T00:00:00.000Z' });
  await writeFile(join(root, 'dist', 'latest-mac.yml'), feed(VERSION, zipName, zip));
  await writeFile(join(root, 'dist', `ScrollMind-${VERSION}-arm64-notarization.json`), JSON.stringify({
    version: VERSION, status: notarized ? 'Accepted' : 'Signed; not notarized', stapled: notarized, gatekeeperAccepted: notarized,
    archive: join(root, 'dist', zipName), sha256: hash('sha256', zip, 'hex'),
  }));
  const exe = Buffer.from('windows installer bytes');
  const winFeed = feed(VERSION, `ScrollMind-Setup-${VERSION}.exe`, exe);
  return { root, zip, exe, winFeed, macFeed: feed(VERSION, zipName, zip), zipName, windows };
}

/** An in-memory GitHub release: the same calls publish-release.mjs makes through gh. */
function fakeGithub({ release = null, remoteText = {} } = {}) {
  const state = { release, uploads: [], published: false, created: 0, texts: remoteText };
  return {
    state,
    async findRelease() { return state.release && { draft: state.release.draft, assets: [...state.release.assets] }; },
    async createDraft() { state.created += 1; state.release = { draft: true, assets: [] }; },
    async upload(tag, file) {
      const name = file.split('/').pop();
      const bytes = await readFile(file);
      state.uploads.push(name);
      state.release.assets.push({ name, size: bytes.length, state: 'uploaded' });
      state.texts[name] = bytes.toString('utf8');
    },
    async readAsset(tag, name) { return state.texts[name]; },
    async publish() { state.published = true; state.release.draft = false; },
  };
}

const gitFor = (tagged = 'abc', head = 'abc') => async (args) => (args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? head : tagged) : '');
const addWindows = (github, f, { badFeed = false } = {}) => {
  github.state.release.assets.push({ name: `ScrollMind-Setup-${VERSION}.exe`, size: f.exe.length }, { name: `ScrollMind-Setup-${VERSION}.exe.sha256`, size: 90 }, { name: 'latest.yml', size: f.winFeed.length });
  github.state.texts['latest.yml'] = badFeed ? f.winFeed.replace(`size: ${f.exe.length}`, 'size: 1') : f.winFeed;
};

test('the required files are the zip, its checksum and the feed, then the Windows installer, checksum and feed', () => {
  assert.deepEqual(requiredAssets('2.1.0'), {
    mac: ['ScrollMind-2.1.0-arm64.zip', 'ScrollMind-2.1.0-arm64.zip.sha256', 'latest-mac.yml'],
    win: ['ScrollMind-Setup-2.1.0.exe', 'ScrollMind-Setup-2.1.0.exe.sha256', 'latest.yml'],
  });
  assert.deepEqual(requiredAssets('2.1.0', { windows: false }).win, []);
  assert.throws(() => requiredAssets('2.1'), /x\.y\.z/);
});

test('an empty or half-uploaded asset does not count as attached', () => {
  const assets = [{ name: 'a', size: 5 }, { name: 'b', size: 0 }, { name: 'c', size: 5, state: 'starter' }];
  assert.deepEqual(missingAssets(assets, ['a', 'b', 'c', 'd']), ['b', 'c', 'd']);
});

test('checksum lines round-trip and feeds are checked against the real bytes', () => {
  const line = sha256Line('a'.repeat(64), 'x.zip');
  assert.deepEqual(parseSha256Line(line), { sha256: 'a'.repeat(64), name: 'x.zip' });
  assert.equal(parseSha256Line('nonsense'), null);
  const bytes = Buffer.from('payload');
  const expected = { version: '1.0.0', file: 'x.zip', sha512: hash('sha512', bytes, 'base64'), size: bytes.length };
  const text = feedYaml({ ...expected, releaseDate: 'now' });
  assert.deepEqual(parseFeed(text), expected);
  assert.doesNotThrow(() => verifyFeed(text, expected));
  assert.throws(() => verifyFeed(text, { ...expected, version: '1.0.1' }), /1\.0\.0, not 1\.0\.1/);
  assert.throws(() => verifyFeed(text, { ...expected, file: 'y.zip' }), /points at x\.zip/);
  assert.throws(() => verifyFeed(text, { ...expected, size: 3 }), /size/);
  assert.throws(() => verifyFeed(text, { ...expected, sha512: hash('sha512', 'other', 'base64') }), /hash/);
});

test('only an Apple-accepted, stapled, Gatekeeper-checked archive counts as notarized', () => {
  const ok = { version: '1.0.0', status: 'Accepted', stapled: true, gatekeeperAccepted: true, archive: '/d/x.zip', sha256: 'b'.repeat(64) };
  const subject = { version: '1.0.0', zipName: 'x.zip', zipSha256: 'b'.repeat(64) };
  assert.doesNotThrow(() => verifyNotarizationRecord(ok, subject));
  assert.throws(() => verifyNotarizationRecord(null, subject), /no notarization record/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, status: 'Signed; not notarized' }, subject), /not notarized/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, stapled: false }, subject), /not notarized/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, gatekeeperAccepted: undefined }, subject), /not notarized/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, sha256: 'c'.repeat(64) }, subject), /different archive/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, archive: '/d/other.zip' }, subject), /different archive/);
  assert.throws(() => verifyNotarizationRecord({ ...ok, version: '0.9.0' }, subject), /no notarization record/);
});

test('release notes drop trailers, fall back to the commit message, and never claim Windows signing', () => {
  const notes = releaseNotes({ version: '2.1.0', annotation: 'ScrollMind 2.1.0: things\n\nCo-Authored-By: Someone <a@b>\n' });
  assert.match(notes, /^ScrollMind 2\.1\.0: things\n/);
  assert.doesNotMatch(notes, /Co-Authored-By/);
  assert.match(notes, /notarized by Apple/);
  assert.match(notes, /not code signed/);
  assert.match(releaseNotes({ version: '2.1.0', commitMessage: 'From the commit' }), /^From the commit/);
  assert.match(releaseNotes({ version: '2.1.0' }), /^ScrollMind 2\.1\.0\n/);
});

test('arguments: a vX.Y.Z tag is required, flags are known', () => {
  assert.deepEqual(parseArguments(['v2.1.0', '--wait', '5', '--mac-only']), { tag: 'v2.1.0', check: false, macOnly: true, wait: 5 });
  assert.throws(() => parseArguments([]), /Name the release tag/);
  assert.throws(() => parseArguments(['2.1.0']), /Unknown argument/);
  assert.throws(() => parseArguments(['v2.1.0', '--wait', 'x']), /--wait/);
  assert.throws(() => parseArguments(['v2.1.0', '--force']), /Unknown argument/);
});

test('with everything attached it uploads the zip, checksum and feed in that order and publishes', async () => {
  const f = await fixture();
  const github = fakeGithub();
  // The Windows workflow attaches its files while the Mac side uploads.
  const original = github.createDraft;
  github.createDraft = async (...args) => { await original(...args); addWindows(github, f); };
  const logs = [];
  const result = await publishRelease([TAG], { root: f.root, backend: github, git: gitFor(), log: (line) => logs.push(line) });
  assert.equal(result.ok, true);
  assert.deepEqual(github.state.uploads, [f.zipName, `${f.zipName}.sha256`, 'latest-mac.yml']);
  assert.equal(github.state.published, true);
  assert.equal(github.state.created, 1);
  await rm(f.root, { recursive: true });
});

test('it refuses to publish, and leaves a draft, while the Windows installer is missing', async () => {
  const f = await fixture();
  const github = fakeGithub();
  await assert.rejects(publishRelease([TAG], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /ScrollMind-Setup-2\.1\.0\.exe, ScrollMind-Setup-2\.1\.0\.exe\.sha256, latest\.yml are not attached/);
  assert.equal(github.state.published, false);
  assert.equal(github.state.release.draft, true);
  assert.deepEqual(github.state.uploads, [f.zipName, `${f.zipName}.sha256`, 'latest-mac.yml']);
  await rm(f.root, { recursive: true });
});

test('--wait polls until the Windows files arrive, then publishes', async () => {
  const f = await fixture();
  const github = fakeGithub();
  let sleeps = 0;
  const sleep = async () => { sleeps += 1; if (sleeps === 2) addWindows(github, f); };
  let clock = 0;
  const result = await publishRelease([TAG, '--wait', '10'], { root: f.root, backend: github, git: gitFor(), log: () => {}, sleep, now: () => (clock += 1000) });
  assert.equal(result.ok, true);
  assert.equal(sleeps, 2);
  assert.equal(github.state.published, true);
  await rm(f.root, { recursive: true });
});

test('--wait gives up at the deadline and does not publish', async () => {
  const f = await fixture();
  const github = fakeGithub();
  let clock = 0;
  await assert.rejects(publishRelease([TAG, '--wait', '1'], { root: f.root, backend: github, git: gitFor(), log: () => {}, sleep: async () => {}, now: () => (clock += 40_000) }), /Not published/);
  assert.equal(github.state.published, false);
  await rm(f.root, { recursive: true });
});

test('--mac-only publishes the macOS files alone', async () => {
  const f = await fixture();
  const github = fakeGithub();
  const result = await publishRelease([TAG, '--mac-only'], { root: f.root, backend: github, git: gitFor(), log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(github.state.published, true);
  await rm(f.root, { recursive: true });
});

test('a Windows feed that describes other bytes than the attached installer is refused', async () => {
  const f = await fixture();
  const github = fakeGithub({ release: { draft: true, assets: [] } });
  addWindows(github, f, { badFeed: true });
  await assert.rejects(publishRelease([TAG], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /latest\.yml on the release does not describe/);
  assert.equal(github.state.published, false);
  await rm(f.root, { recursive: true });
});

test('an archive that is not notarized is never published', async () => {
  const f = await fixture({ notarized: false });
  const github = fakeGithub();
  await assert.rejects(publishRelease([TAG, '--mac-only'], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /not notarized/);
  assert.deepEqual(github.state.uploads, []);
  await rm(f.root, { recursive: true });
});

test('a checksum or feed that does not match the archive stops it before anything is uploaded', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'dist', `${f.zipName}.sha256`), sha256Line('0'.repeat(64), f.zipName));
  const github = fakeGithub();
  await assert.rejects(publishRelease([TAG, '--mac-only'], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /sha256 does not match/);
  await writeFile(join(f.root, 'dist', `${f.zipName}.sha256`), sha256Line(hash('sha256', f.zip, 'hex'), f.zipName));
  await writeFile(join(f.root, 'dist', 'latest-mac.yml'), f.macFeed.replace(/size: \d+/, 'size: 1'));
  await assert.rejects(publishRelease([TAG, '--mac-only'], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /size/);
  assert.deepEqual(github.state.uploads, []);
  await rm(f.root, { recursive: true });
});

test('the tag must be the version in package.json and the commit that dist was built from', async () => {
  const f = await fixture();
  const github = fakeGithub();
  await assert.rejects(publishRelease(['v2.2.0'], { root: f.root, backend: github, git: gitFor(), log: () => {} }), /package\.json says 2\.1\.0/);
  await assert.rejects(publishRelease([TAG], { root: f.root, backend: github, git: gitFor('abc', 'def'), log: () => {} }), /not the commit checked out/);
  assert.deepEqual(github.state.uploads, []);
  await rm(f.root, { recursive: true });
});

test('a published release is never uploaded to; --check changes nothing and reports what is missing', async () => {
  const f = await fixture();
  const published = fakeGithub({ release: { draft: false, assets: [{ name: f.zipName, size: 5 }] } });
  await assert.rejects(publishRelease([TAG], { root: f.root, backend: published, git: gitFor(), log: () => {} }), /already published and lacks/);
  assert.deepEqual(published.state.uploads, []);
  const logs = [];
  const draft = fakeGithub({ release: { draft: true, assets: [{ name: f.zipName, size: 5 }] } });
  const checked = await publishRelease([TAG, '--check'], { root: f.root, backend: draft, git: gitFor(), log: (line) => logs.push(line) });
  assert.equal(checked.ok, false);
  assert.ok(checked.missing.includes('latest-mac.yml') && checked.missing.includes('latest.yml'));
  assert.deepEqual(draft.state.uploads, []);
  assert.equal(draft.state.published, false);
  await rm(f.root, { recursive: true });
});

test('the gh backend creates drafts, uploads without clobbering, and publishes as Latest', async () => {
  const calls = [];
  const gh = async (args, options) => {
    calls.push({ args, input: options?.input });
    return args[0] === 'api' ? '{"draft":true,"assets":[{"name":"a","size":3,"state":"uploaded"}]}\n' : '';
  };
  const backend = ghBackend('o/r', { gh });
  assert.deepEqual(await backend.findRelease('v2.1.0'), { draft: true, assets: [{ name: 'a', size: 3, state: 'uploaded' }] });
  await backend.createDraft('v2.1.0', 'ScrollMind 2.1.0', 'notes');
  await backend.upload('v2.1.0', '/d/x.zip');
  await backend.readAsset('v2.1.0', 'latest.yml');
  await backend.publish('v2.1.0');
  const flat = calls.map((call) => call.args.join(' '));
  assert.match(flat[0], /^api repos\/o\/r\/releases\?per_page=100 --paginate/);
  assert.match(flat[1], /^release create v2\.1\.0 --repo o\/r --draft --verify-tag/);
  assert.equal(calls[1].input, 'notes');
  assert.equal(flat[2], 'release upload v2.1.0 --repo o/r /d/x.zip');
  assert.doesNotMatch(flat[2], /clobber/);
  assert.match(flat[3], /release download v2\.1\.0 --repo o\/r --pattern latest\.yml --output -/);
  assert.equal(flat[4], 'release edit v2.1.0 --repo o/r --draft=false --latest');
  const twice = ghBackend('o/r', { gh: async () => '{"draft":true,"assets":[]}\n{"draft":false,"assets":[]}\n' });
  await assert.rejects(twice.findRelease('v2.1.0'), /2 releases exist/);
});
