#!/usr/bin/env node
// Builds the Wacom side-button helper (tools/pen/scroll-pen.swift) into build/bin/scroll-pen on a Mac.
// The helper ships inside the macOS app; other platforms have nothing to build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tools', 'pen', 'scroll-pen.swift');
const output = path.join(root, 'build', 'bin', 'scroll-pen');

export function buildPenHelper(destination = output) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const fresh = fs.existsSync(destination) && fs.statSync(destination).mtimeMs >= fs.statSync(source).mtimeMs;
  if (!fresh) execFileSync('swiftc', ['-O', '-o', destination, source], { stdio: 'inherit' });
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') { console.log('The pen helper is built only on macOS.'); process.exit(0); }
  try { console.log(`Pen helper ready: ${buildPenHelper()}`); } catch (error) { console.error(`The pen helper did not build: ${error.message}`); process.exit(1); }
}
