#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFeed, verifyAppFeed } from './update-feed.mjs';
import { sha256Line } from './release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const runDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const options = new Set(runDirectly ? process.argv.slice(2) : []);
if (runDirectly) {
  for (const option of options) if (option !== '--check') throw new Error(`Unknown release option: ${option}`);
  // Builds run on a Windows machine (the windows-installer workflow's runner); only --check may run anywhere.
  if (process.platform !== 'win32' && !options.has('--check')) throw new Error('Windows release builds must run on Windows (the windows-installer workflow).');
}
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const installerName = `ScrollMind-Setup-${pkg.version}.exe`;
const installer = path.join(dist, installerName);
const unpacked = path.join(dist, 'win-unpacked');
const report = path.join(dist, `ScrollMind-Setup-${pkg.version}-release.json`);
const feedFile = path.join(dist, 'latest.yml');

async function command(executable, args, { stream = false, timeout = 60_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', (data) => { stdout += data; if (stream) process.stdout.write(data); });
    child.stderr.on('data', (data) => { stderr += data; if (stream) process.stderr.write(data); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !expired) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(executable)} ${expired ? 'timed out' : `failed (${code})`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fs.rename(from, to); } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, text);
  await renameWithRetry(temporary, file);
}

export { sha256Line };

export function verifyPackagedVersion(packaged, expected) {
  if (packaged?.version !== expected?.version || packaged?.name !== expected?.name) throw new Error('The packaged app version does not match package.json.');
}

export function verifyConfiguration(pkg) {
  const win = pkg.build?.win;
  if (win?.signExecutable !== false) throw new Error('build.win.signExecutable must be false for unsigned Windows builds.');
  if (win.forceCodeSigning !== false) throw new Error('build.win.forceCodeSigning must be false; the top-level forceCodeSigning: true applies to macOS only.');
  const targets = [].concat(win.target || []).map((t) => (typeof t === 'string' ? t : t.target));
  if (!targets.includes('nsis')) throw new Error('The nsis target is required.');
  if (win.artifactName !== 'ScrollMind-Setup-${version}.${ext}') throw new Error('build.win.artifactName must be ScrollMind-Setup-${version}.${ext}.');
  if (pkg.build?.nsis?.perMachine !== false) throw new Error('build.nsis.perMachine must be false (per-user install).');
}

async function main() {
  verifyConfiguration(pkg);
  if (options.has('--check')) { console.log('Windows release configuration verified.'); return; }
  await fs.mkdir(dist, { recursive: true });
  for (const file of [installer, `${installer}.sha256`, report, `${installer}.blockmap`, feedFile]) await fs.rm(file, { force: true });
  console.log(`Building unsigned ScrollMind ${pkg.version} (win32 x64).`);
  await command(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--x64', '--publish', 'never'], { stream: true, timeout: 15 * 60_000 });
  const stat = await fs.stat(installer).catch(() => null);
  if (!stat?.isFile() || stat.size === 0) throw new Error('The installer was not produced.');
  const head = Buffer.alloc(2);
  const reader = await fs.open(installer, 'r');
  try { await reader.read(head, 0, 2, 0); } finally { await reader.close(); }
  if (head.toString('latin1') !== 'MZ') throw new Error('The installer is not a Windows executable.');
  const exe = await fs.stat(path.join(unpacked, 'ScrollMind.exe')).catch(() => null);
  if (!exe?.isFile() || exe.size === 0) throw new Error('dist/win-unpacked/ScrollMind.exe was not produced.');
  const asar = require('@electron/asar');
  const packaged = JSON.parse(asar.extractFile(path.join(unpacked, 'resources', 'app.asar'), 'package.json').toString('utf8'));
  verifyPackagedVersion(packaged, pkg);
  verifyAppFeed(await fs.readFile(path.join(unpacked, 'resources', 'app-update.yml'), 'utf8').catch(() => ''), pkg.build.publish.find((entry) => entry.provider === 'github'));
  const handle = await fs.open(installer, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  const sha256 = createHash('sha256').update(await fs.readFile(installer)).digest('hex');
  await writeAtomic(`${installer}.sha256`, sha256Line(sha256, installerName));
  await writeFeed(feedFile, { version: pkg.version, file: installer });
  await writeAtomic(report, `${JSON.stringify({
    version: pkg.version, platform: 'win32', arch: 'x64', status: 'Unsigned',
    installer: path.relative(root, installer).split(path.sep).join('/'), unpacked: 'dist/win-unpacked',
    sha256, size: stat.size, builtAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`Unsigned installer ready: ${installer}`);
  console.log(`SHA-256: ${sha256}`);
}

if (runDirectly) await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
