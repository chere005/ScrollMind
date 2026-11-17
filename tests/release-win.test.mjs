import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sha256Line, verifyConfiguration, verifyPackagedVersion } from '../tools/release-win.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(pkg);

test('the repository package.json passes the Windows release configuration check', () => {
  assert.doesNotThrow(() => verifyConfiguration(pkg));
});

test('configuration check rejects signing, wrong target, wrong artifact name and per-machine installs', () => {
  const edit = change => { const copy = clone(); change(copy); return copy; };
  assert.throws(() => verifyConfiguration(edit(p => { delete p.build.win.forceCodeSigning; })), /forceCodeSigning/);
  assert.throws(() => verifyConfiguration(edit(p => { p.build.win.forceCodeSigning = true; })), /forceCodeSigning/);
  assert.throws(() => verifyConfiguration(edit(p => { p.build.win.signExecutable = true; })), /signExecutable/);
  assert.throws(() => verifyConfiguration(edit(p => { delete p.build.win; })), /signExecutable/);
  assert.throws(() => verifyConfiguration(edit(p => { p.build.win.target = ['portable']; })), /nsis/);
  assert.doesNotThrow(() => verifyConfiguration(edit(p => { p.build.win.target = 'nsis'; })));
  assert.throws(() => verifyConfiguration(edit(p => { p.build.win.artifactName = 'x.${ext}'; })), /artifactName/);
  assert.throws(() => verifyConfiguration(edit(p => { p.build.nsis.perMachine = true; })), /perMachine/);
});

test('packaged version check compares name and version with package.json', () => {
  assert.doesNotThrow(() => verifyPackagedVersion({ name: 'scrollmind', version: '1.0.0' }, { name: 'scrollmind', version: '1.0.0' }));
  assert.throws(() => verifyPackagedVersion({ name: 'scrollmind', version: '0.9.0' }, { name: 'scrollmind', version: '1.0.0' }), /does not match/);
  assert.throws(() => verifyPackagedVersion({ name: 'other', version: '1.0.0' }, { name: 'scrollmind', version: '1.0.0' }), /does not match/);
  assert.throws(() => verifyPackagedVersion(undefined, { name: 'scrollmind', version: '1.0.0' }), /does not match/);
});

test('sha256 line is "<hex>  <name>\n" in the sha256sum format', () => {
  const hex = createHash('sha256').update('installer').digest('hex');
  const line = sha256Line(hex, 'ScrollMind-Setup-1.0.0.exe');
  assert.equal(line, `${hex}  ScrollMind-Setup-1.0.0.exe\n`);
  assert.match(line, /^[0-9a-f]{64} {2}\S+\n$/);
});
