'use strict';

// Updates come from ScrollMind's public GitHub Releases (electron-builder writes the feed into the installed app).
// They are asked for, never pushed: a look shortly after launch and every 12 hours, one native prompt per version
// per launch, a download only after "Download", and an install only after the final save (Restart to Update) or
// the next quit (Later).

const { spawnSync } = require('node:child_process');

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;

/** Can this copy replace itself? Only a signed install in a place it can be swapped, never a dev or test run. */
function updateEligibility({ platform, packaged, testing, feedOverride, hasFeedFile, bundle, developerId }) {
  if (testing) return feedOverride ? { ok: true } : { ok: false, why: 'Updates are off while testing.' };
  if (!packaged) return { ok: false, why: 'Updates are off in development builds.' };
  if (!hasFeedFile) return { ok: false, why: 'This copy has no update feed.' };
  if (platform === 'win32') return { ok: true };
  if (platform !== 'darwin') return { ok: false, why: 'ScrollMind updates itself on macOS and Windows.' };
  if (typeof bundle !== 'string' || !bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
    return { ok: false, why: 'Move ScrollMind to the Applications folder to update it.' };
  }
  if (!developerId) return { ok: false, why: 'Only the Developer ID signed build updates itself.' };
  return { ok: true };
}

/** A loopback feed for tests only; any other address is ignored. */
function loopbackFeed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

function macDeveloperId(bundle) {
  try {
    const read = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', timeout: 5_000 });
    return /^Authority=Developer ID Application:/m.test(`${read.stderr ?? ''}${read.stdout ?? ''}`);
  } catch { return false; }
}

const oneLine = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 300);

function createUpdater({ autoUpdater, dialog, getWindow, version, install, log = () => {}, setTimer = setTimeout, setRepeat = setInterval, clear = clearTimeout }) {
  const putOff = new Set();
  let busy = false;
  let downloading = null;
  let ready = null;
  let timers = [];

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = { info: (text) => log('info', text), warn: (text) => log('warn', text), error: (text) => log('error', text), debug: () => {} };
  autoUpdater.on('error', (error) => log('error', oneLine(error)));
  autoUpdater.on('update-downloaded', (info) => { ready = info.version; downloading = null; log('info', `downloaded ${info.version}`); });

  const say = (message, detail, buttons = ['OK']) => {
    const options = { type: 'info', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true };
    const window = getWindow();
    return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };

  async function offerRestart(next) {
    const { response } = await say(`ScrollMind ${next} is ready`, 'Restart to finish updating. Your writing is saved first. Choose Later to update the next time you quit.', ['Restart to Update', 'Later']);
    if (response === 0) install();
  }

  async function download(next) {
    downloading = autoUpdater.downloadUpdate();
    try {
      await downloading;
    } catch (error) {
      downloading = null;
      log('error', `download failed: ${oneLine(error)}`);
      await say('ScrollMind could not download the update', oneLine(error));
      return;
    }
    if (ready) await offerRestart(next);
  }

  async function check({ manual = false } = {}) {
    if (ready) { if (manual) await offerRestart(ready); return; }
    if (downloading) { if (manual) await say('Downloading the update', 'ScrollMind will offer to restart when it finishes.'); return; }
    if (busy) return;
    busy = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      const next = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || !next) {
        log('info', `up to date at ${version}`);
        if (manual) await say('ScrollMind is up to date', `You have the latest version, ${version}.`);
        return;
      }
      if (!manual && putOff.has(next)) return;
      const { response } = await say(`ScrollMind ${next} is available`, `You have ${version}. Download the update now? It installs when you restart, and your writing is saved first.`, ['Download', 'Later']);
      if (response !== 0) { putOff.add(next); return; }
      busy = false;
      await download(next);
    } catch (error) {
      log('error', `check failed: ${oneLine(error)}`);
      if (manual) await say('ScrollMind could not check for updates', oneLine(error));
    } finally {
      busy = false;
    }
  }

  return {
    check,
    start() {
      timers = [setTimer(() => { void check(); }, FIRST_CHECK_MS), setRepeat(() => { void check(); }, CHECK_EVERY_MS)];
      for (const timer of timers) timer?.unref?.();
    },
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    dispose() { for (const timer of timers) clear(timer); timers = []; },
  };
}

module.exports = { updateEligibility, loopbackFeed, macDeveloperId, createUpdater, FIRST_CHECK_MS, CHECK_EVERY_MS };
