#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(process.argv.slice(2));
const allowed = new Set(['--check', '--sign-only', '--notarize', '--resume', '--verify']);
for (const option of options) if (!allowed.has(option)) throw new Error(`Unknown release option: ${option}`);
if (options.has('--sign-only') && (options.has('--notarize') || options.has('--resume'))) throw new Error('Choose signing only or explicitly opt into notarization.');
const signOnly = options.has('--sign-only') || (!options.has('--notarize') && !options.has('--resume'));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const architecture = process.arch;
const app = path.join(root, 'dist', architecture === 'arm64' ? 'mac-arm64' : 'mac', 'ScrollMind.app');
const artifactBase = path.join(root, 'dist', `ScrollMind-${pkg.version}-${architecture}`);
const uploadZip = `${artifactBase}-signed.zip`;
const releaseZip = `${artifactBase}.zip`;
const stateFile = `${artifactBase}-notarization.json`;

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

async function writeState(value) {
  const temporary = `${stateFile}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, stateFile);
}

async function sha256(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

function credentials() {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE || process.env.SCROLLMIND_NOTARY_PROFILE;
  if (profile) {
    const args = ['--keychain-profile', profile];
    if (process.env.APPLE_KEYCHAIN) args.push('--keychain', process.env.APPLE_KEYCHAIN);
    return args;
  }
  const key = process.env.APPLE_API_KEY || process.env.SCROLLMIND_NOTARY_KEY;
  const id = process.env.APPLE_API_KEY_ID || process.env.SCROLLMIND_NOTARY_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER || process.env.SCROLLMIND_NOTARY_ISSUER;
  const individual = process.env.SCROLLMIND_NOTARY_INDIVIDUAL_KEY === '1';
  if (key && id && (issuer || individual)) return ['--key', key, '--key-id', id, ...(issuer ? ['--issuer', issuer] : [])];
  throw new Error('Notarization credentials are unavailable: use an existing keychain profile or App Store Connect API key file, key ID, and issuer.');
}

async function verifyCredentials(args) {
  const keyIndex = args.indexOf('--key');
  if (keyIndex !== -1) {
    const stat = await fs.stat(args[keyIndex + 1]).catch(() => null);
    if (!stat?.isFile()) throw new Error('The notarization API key must be an existing private-key file. Inline secrets are not accepted.');
  }
  await command('xcrun', ['notarytool', 'history', ...args, '--output-format', 'json'], { timeout: 45_000 });
  console.log('Notarization credentials verified.');
}

async function verifySigningConfiguration() {
  if (process.platform !== 'darwin') throw new Error('macOS signing and notarization must run on macOS.');
  const mac = pkg.build?.mac;
  if (!mac?.identity || mac.identity === '-' || mac.identity.startsWith('Developer ID Application:')) throw new Error('Set a Developer ID identity qualifier without its certificate-type prefix.');
  if (!pkg.build.forceCodeSigning || mac.hardenedRuntime !== true || mac.notarize !== false) throw new Error('Release builds require forceCodeSigning, Hardened Runtime, and explicit notarization through this script.');
  for (const file of [mac.entitlements, mac.entitlementsInherit]) {
    if (!file) throw new Error('Both app and inherited entitlements must be configured.');
    await command('plutil', ['-lint', path.resolve(root, file)]);
  }
  const identities = (await command('security', ['find-identity', '-v', '-p', 'codesigning'])).stdout;
  const identity = identities.split('\n').find((line) => line.includes('Developer ID Application:') && line.includes(mac.identity));
  if (!identity) throw new Error('The configured Developer ID Application signing identity is unavailable in the keychain.');
  const team = identity.match(/\(([A-Z0-9]{10})\)"/)?.[1];
  if (!team) throw new Error('The signing certificate has no recognizable Apple team identifier.');
  console.log(`Developer ID signing identity verified (team ${team}).`);
  return team;
}

async function verifySignedApp(team) {
  await command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const result = await command('codesign', ['--display', '--verbose=4', app]);
  const details = result.stdout + result.stderr;
  if (!details.includes('Authority=Developer ID Application:') || !details.includes(`TeamIdentifier=${team}`) || !/flags=.*\(.*runtime/.test(details)) throw new Error('The packaged app does not have the expected Developer ID signature and Hardened Runtime.');
  const version = (await command('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')])).stdout.trim();
  if (version !== pkg.version) throw new Error('The packaged app version does not match package.json.');
  const entitlementResult = await command('codesign', ['--display', '--entitlements', ':-', app]);
  const entitlements = entitlementResult.stdout + entitlementResult.stderr;
  if (!entitlements.includes('com.apple.security.cs.allow-jit') || entitlements.includes('com.apple.security.cs.disable-library-validation') || entitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory')) throw new Error('The packaged app does not have the intended minimal JIT entitlements.');
  console.log('Developer ID signature, nested signatures, version, and Hardened Runtime verified.');
}

async function verifyNotarizedApp(team) {
  await command('xcrun', ['stapler', 'validate', app], { timeout: 120_000 });
  await verifySignedApp(team);
  const assessed = await command('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { timeout: 120_000 });
  if (!/accepted/.test(assessed.stdout + assessed.stderr) || !/Notarized Developer ID/.test(assessed.stdout + assessed.stderr)) throw new Error('Gatekeeper did not recognize a notarized Developer ID app.');
  console.log('Stapled notarization ticket and Gatekeeper acceptance verified.');
}

async function archive(destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await command('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporary], { timeout: 180_000 });
    await command('unzip', ['-tq', temporary], { timeout: 180_000 });
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function notarizationStatus(id, args) {
  const result = await command('xcrun', ['notarytool', 'info', id, ...args, '--output-format', 'json'], { timeout: 45_000 });
  return JSON.parse(result.stdout);
}

async function main() {
  const team = await verifySigningConfiguration();
  if (options.has('--verify')) { await verifyNotarizedApp(team); return; }
  const auth = signOnly ? null : credentials();
  if (auth) await verifyCredentials(auth);
  if (options.has('--check')) return;
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  let state;
  if (options.has('--resume')) {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (state.version !== pkg.version || state.uploadSha256 !== await sha256(uploadZip)) throw new Error('The saved signing or notarization record does not match this release archive.');
  } else {
    console.log(`Building signed ScrollMind ${pkg.version} (${architecture}).`);
    await command(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--mac', '--dir', `--${architecture}`, '--publish', 'never'], {
      stream: true, timeout: 15 * 60_000, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true' },
    });
  }
  await verifySignedApp(team);
  if (!options.has('--resume')) await archive(uploadZip);
  if (signOnly) {
    await writeState({ version: pkg.version, team, status: 'Signed; not notarized', app, archive: uploadZip, uploadSha256: await sha256(uploadZip) });
    console.log(`Signed app and archive ready: ${app}; ${uploadZip}`);
    return;
  }
  if (!state?.id) {
    const result = await command('xcrun', ['notarytool', 'submit', uploadZip, ...auth, '--output-format', 'json'], { timeout: 10 * 60_000 });
    const submitted = JSON.parse(result.stdout);
    if (!submitted.id) throw new Error('Apple did not return a notarization submission ID.');
    state = { version: pkg.version, team, id: submitted.id, status: submitted.status || 'In Progress', app, uploadArchive: uploadZip, uploadSha256: await sha256(uploadZip), submittedAt: new Date().toISOString() };
    await writeState(state);
    console.log(`Notarization submitted: ${state.id}`);
  }
  let previousStatus;
  for (;;) {
    const info = await notarizationStatus(state.id, auth);
    state.status = info.status;
    await writeState(state);
    if (state.status !== previousStatus) console.log(`Apple notarization status: ${state.status}`);
    previousStatus = state.status;
    if (state.status === 'Accepted') break;
    if (['Invalid', 'Rejected'].includes(state.status)) {
      const log = await command('xcrun', ['notarytool', 'log', state.id, ...auth], { timeout: 60_000 });
      await fs.writeFile(`${artifactBase}-notarization-log.json`, log.stdout, { mode: 0o600 });
      throw new Error(`Apple rejected this release. The notarization log is saved under dist; submission ${state.id}.`);
    }
    await delay(15_000);
  }
  await command('xcrun', ['stapler', 'staple', app], { timeout: 120_000 });
  await verifyNotarizedApp(team);
  await archive(releaseZip);
  await writeState({ ...state, status: 'Accepted', stapled: true, gatekeeperAccepted: true, archive: releaseZip, sha256: await sha256(releaseZip), verifiedAt: new Date().toISOString() });
  console.log(`Signed, notarized, stapled app and ZIP ready: ${app}; ${releaseZip}`);
}

await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
