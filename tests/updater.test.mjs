import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedYaml, verifyAppFeed, writeFeed } from '../tools/update-feed.mjs';

const require = createRequire(import.meta.url);
const { updateEligibility, loopbackFeed, createUpdater, FIRST_CHECK_MS, CHECK_EVERY_MS } = require('../src/main/updater.cjs');

const base = { platform: 'darwin', packaged: true, testing: false, feedOverride: false, hasFeedFile: true, bundle: '/Applications/ScrollMind.app', developerId: true };

test('only a signed, replaceable, packaged install updates itself', () => {
  assert.equal(updateEligibility(base).ok, true);
  assert.equal(updateEligibility({ ...base, platform: 'win32', bundle: undefined, developerId: false }).ok, true);
  for (const change of [
    { packaged: false }, { hasFeedFile: false }, { platform: 'linux' }, { developerId: false },
    { bundle: '/Volumes/ScrollMind/ScrollMind.app' }, { bundle: '/private/var/folders/x/AppTranslocation/y/d/ScrollMind.app' }, { bundle: '/Applications/ScrollMind' },
  ]) {
    const result = updateEligibility({ ...base, ...change });
    assert.equal(result.ok, false, JSON.stringify(change));
    assert.match(result.why, /\S/);
  }
});

test('tests update only through an explicit loopback feed', () => {
  assert.equal(updateEligibility({ ...base, testing: true }).ok, false);
  assert.equal(updateEligibility({ ...base, testing: true, packaged: false, feedOverride: true }).ok, true);
  assert.equal(loopbackFeed('http://127.0.0.1:8123/feed'), 'http://127.0.0.1:8123/feed');
  assert.equal(loopbackFeed('http://localhost:9/'), 'http://localhost:9/');
  for (const value of ['https://example.com/feed', 'http://example.com/', 'http://127.0.0.1.evil.test/', 'file:///tmp/feed', 'nonsense', undefined]) assert.equal(loopbackFeed(value), null, String(value));
});

function harness({ result, download = 'ok', answers = [] } = {}) {
  const updater = new EventEmitter();
  const calls = { checks: 0, downloads: 0, installs: 0, quits: 0, dialogs: [], logs: [] };
  updater.checkForUpdates = async () => { calls.checks++; if (result instanceof Error) throw result; return result; };
  updater.downloadUpdate = async () => {
    calls.downloads++;
    if (download === 'fail') throw new Error('net::ERR_INTERNET_DISCONNECTED');
    updater.emit('update-downloaded', { version: result.updateInfo.version });
  };
  updater.quitAndInstall = (...args) => { calls.quits++; calls.quitArgs = args; };
  const dialog = { showMessageBox: async (...args) => { const options = args.at(-1); calls.dialogs.push(options); return { response: answers.shift() ?? 0 }; } };
  const timers = [];
  const controller = createUpdater({
    autoUpdater: updater, dialog, getWindow: () => null, version: '1.3.0', install: () => { calls.installs++; },
    log: (level, text) => calls.logs.push([level, text]),
    setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    setRepeat: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clear: (timer) => { timer.cleared = true; },
  });
  return { updater, calls, controller, timers };
}

const newer = (version = '1.4.0') => ({ isUpdateAvailable: true, updateInfo: { version } });

test('updates are never downloaded or installed without asking, and downgrades are refused', () => {
  const { updater } = harness({ result: newer() });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
});

test('checks shortly after launch and every twelve hours, and stops cleanly', () => {
  const { controller, timers } = harness({ result: newer() });
  controller.start();
  assert.deepEqual(timers.map((timer) => timer.ms), [FIRST_CHECK_MS, CHECK_EVERY_MS]);
  assert.equal(CHECK_EVERY_MS, 12 * 60 * 60 * 1000);
  controller.dispose();
  assert.deepEqual(timers.map((timer) => timer.cleared), [true, true]);
});

test('a newer version asks first, downloads on Download, then restarts only on Restart to Update', async () => {
  const { calls, controller } = harness({ result: newer(), answers: [0, 0] });
  await controller.check();
  assert.equal(calls.downloads, 1);
  assert.match(calls.dialogs[0].message, /1\.4\.0 is available/);
  assert.deepEqual(calls.dialogs[0].buttons, ['Download', 'Later']);
  assert.match(calls.dialogs[1].message, /1\.4\.0 is ready/);
  assert.deepEqual(calls.dialogs[1].buttons, ['Restart to Update', 'Later']);
  assert.equal(calls.installs, 1);
  controller.quitAndInstall();
  assert.deepEqual(calls.quitArgs, [false, true]);
});

test('Later on the restart prompt keeps the download for the next quit and offers it again from the menu', async () => {
  const { calls, controller } = harness({ result: newer(), answers: [0, 1, 0] });
  await controller.check();
  assert.equal(calls.installs, 0);
  await controller.check();
  await controller.check({ manual: true });
  assert.equal(calls.checks, 1, 'a downloaded update is not looked up again');
  assert.equal(calls.downloads, 1);
  assert.equal(calls.installs, 1);
});

test('declining a version silences it for the launch checks but not for Check for Updates', async () => {
  const { calls, controller } = harness({ result: newer(), answers: [1, 1] });
  await controller.check();
  await controller.check();
  assert.equal(calls.dialogs.length, 1);
  await controller.check({ manual: true });
  assert.equal(calls.dialogs.length, 2);
  assert.equal(calls.downloads, 0);
});

test('nothing newer is silent at launch and answered from the menu', async () => {
  const { calls, controller } = harness({ result: { isUpdateAvailable: false, updateInfo: { version: '1.3.0' } } });
  await controller.check();
  assert.equal(calls.dialogs.length, 0);
  await controller.check({ manual: true });
  assert.match(calls.dialogs[0].message, /up to date/);
  assert.match(calls.dialogs[0].detail, /1\.3\.0/);
});

test('an offline or failing check is logged at launch and shown from the menu', async () => {
  const { calls, controller } = harness({ result: new Error('net::ERR_INTERNET_DISCONNECTED\nstack') });
  await controller.check();
  assert.equal(calls.dialogs.length, 0);
  assert.ok(calls.logs.some(([level, text]) => level === 'error' && text.includes('ERR_INTERNET_DISCONNECTED')));
  await controller.check({ manual: true });
  assert.match(calls.dialogs[0].message, /could not check/);
  assert.equal(calls.dialogs[0].detail, 'net::ERR_INTERNET_DISCONNECTED');
});

test('a failed download says so and can be tried again', async () => {
  const { calls, controller } = harness({ result: newer(), download: 'fail', answers: [0, 0] });
  await controller.check();
  assert.match(calls.dialogs[1].message, /could not download/);
  assert.equal(calls.installs, 0);
  await controller.check({ manual: true });
  assert.equal(calls.checks, 2);
});

test('the feed names one file with its real SHA-512 and size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrollmind-feed-'));
  try {
    const file = join(directory, 'ScrollMind-1.3.0-arm64-signed.zip');
    await writeFile(file, 'archive bytes');
    const text = await writeFeed(join(directory, 'latest-mac.yml'), { version: '1.3.0', file });
    assert.equal(await readFile(join(directory, 'latest-mac.yml'), 'utf8'), text);
    const sha512 = createHash('sha512').update('archive bytes').digest('base64');
    assert.match(text, /^version: 1\.3\.0$/m);
    assert.match(text, /^path: ScrollMind-1\.3\.0-arm64-signed\.zip$/m);
    assert.equal(text.match(new RegExp(`sha512: ${sha512.replace(/[+/]/g, '\\$&')}`, 'g')).length, 2);
    assert.match(text, /^ {4}size: 13$/m);
    assert.match(text, /^releaseDate: '\d{4}-\d\d-\d\dT[\d:.]+Z'$/m);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the feed refuses names, versions and hashes electron-updater could misread', () => {
  const good = { version: '1.3.0', file: 'a.zip', sha512: 'A'.repeat(86) + '==', size: 1, releaseDate: '2026-11-19T00:00:00.000Z' };
  assert.doesNotThrow(() => feedYaml(good));
  for (const change of [{ version: '1.3' }, { file: 'a b.zip' }, { file: 'a\nfoo: bar.zip' }, { sha512: 'short' }, { size: 0 }]) assert.throws(() => feedYaml({ ...good, ...change }), undefined, JSON.stringify(change));
});

test('a packaged app without the GitHub feed is refused', () => {
  const feed = { owner: 'chere005', repo: 'ScrollMind' };
  assert.doesNotThrow(() => verifyAppFeed('provider: github\nowner: chere005\nrepo: ScrollMind\nupdaterCacheDirName: scrollmind-updater\n', feed));
  for (const text of ['', 'provider: generic\nurl: http://x\n', 'provider: github\nowner: other\nrepo: ScrollMind\n']) assert.throws(() => verifyAppFeed(text, feed));
});
