'use strict';

// The Wacom One 12's side buttons, read from the display itself by the scroll-pen helper (tools/pen/scroll-pen.swift),
// whatever the Wacom driver assigns them to. Main starts the helper, turns its lines into { tip, lower, upper, range }
// states, and tells the window. A display that is not there, or a helper that is not built, just means no states.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RELEASED = Object.freeze({ tip: false, lower: false, upper: false, range: false });
const RESTART_MS = 3000;

/** One helper line as a state, or null for anything that is not a buttons line. */
function parseLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value?.k !== 'buttons') return null;
  return { tip: value.tip === true, lower: value.lower === true, upper: value.upper === true, range: value.range === true };
}

/** Where the helper is: beside the app's resources when packaged, in build/bin when running from source. */
function helperPath({ packaged, resourcesPath, root, platform, exists = fs.existsSync }) {
  if (platform !== 'darwin') return null;
  const file = packaged ? path.join(resourcesPath, 'scroll-pen') : path.join(root, 'build', 'bin', 'scroll-pen');
  return exists(file) ? file : null;
}

function createNativePen({ file, onState, log = () => {}, start = spawn, setTimer = setTimeout, clear = clearTimeout }) {
  let child = null;
  let timer = null;
  let stopped = false;
  let buffer = '';
  let last = RELEASED;

  function run() {
    if (stopped || child || !file) return;
    let process;
    try { process = start(file, [], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (error) { log(`could not start the pen helper: ${error?.message ?? error}`); return; }
    child = process;
    buffer = '';
    process.stdout.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const state = parseLine(line);
        if (state) {
          // The switches are what people ask about when a button seems wrong, so every change of them is on record (pen.log).
          if (state.lower !== last.lower || state.upper !== last.upper) log(`buttons lower=${state.lower} upper=${state.upper}`);
          last = state;
          onState(state);
        } else if (line) log(`helper: ${line.slice(0, 200)}`);
      }
    });
    process.on('error', (error) => log(`the pen helper failed: ${error?.message ?? error}`));
    process.on('exit', (code) => {
      if (child === process) child = null;
      log(`helper exited (${code})`);
      last = RELEASED;
      // Whatever it said last, a helper that is gone holds no buttons.
      onState(RELEASED);
      if (!stopped) timer = setTimer(run, RESTART_MS);
    });
  }

  return {
    start() { stopped = false; run(); },
    stop() {
      stopped = true;
      clear(timer);
      if (child) { try { child.stdin.end(); child.kill(); } catch {} child = null; }
    },
  };
}

module.exports = { parseLine, helperPath, createNativePen, RELEASED };
