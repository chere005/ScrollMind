import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A Windows checkout may have CRLF line endings: read the workflow the same way either way.
const workflow = (await readFile(new URL('../.github/workflows/windows-installer.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const code = workflow.replace(/^\s*#.*$/gm, '');
const jobs = code.slice(code.indexOf('\njobs:')).split(/\n  (?=[a-z]+:\n)/).slice(1);

test('the Windows workflow follows the quiet-CI contract', () => {
  assert.equal(jobs.length, 3, 'handoff, windows, finish');
  for (const job of jobs) {
    assert.match(job, /^\s*continue-on-error: true$/m, job.split('\n')[0]);
    assert.match(job, /^\s*timeout-minutes: \d+$/m, job.split('\n')[0]);
  }
  assert.match(jobs[0], /github\.triggering_actor != 'github-actions\[bot\]'/);
  for (const job of jobs.slice(1)) assert.match(job, /github\.triggering_actor == 'github-actions\[bot\]'/);
  assert.doesNotMatch(code, /cancel-in-progress: true/);
  assert.doesNotMatch(code, /^\s{2}(schedule|pull_request)\b/m);
  assert.doesNotMatch(code, /gh run (rerun|cancel)/);
  assert.doesNotMatch(code, /(upload|download)-artifact/);
});

test('the Windows installer is built on a Windows runner and is never described or gated as signed', () => {
  assert.match(code, /runs-on: windows-latest/);
  assert.doesNotMatch(code, /signtool|Authenticode|CSC_LINK|CSC_KEY_PASSWORD|signCommand|certificateThumbprint/i);
});

test('the installer and its checksum are uploaded before latest.yml', () => {
  const upload = code.indexOf('dist/ScrollMind-Setup-${v}.exe"');
  const feed = code.indexOf('gh release upload "$TAG" dist/latest.yml');
  assert.ok(upload > 0 && feed > upload);
});

test('a missing file re-dispatches the workflow at most three times', () => {
  assert.match(code, /MAX_ATTEMPTS: "3"/);
  assert.match(code, /gh workflow run "\$wf".*-f "attempt=\$next"/);
});

test('the write token reaches only the release steps, and the actions are pinned to commits', () => {
  const windows = jobs[1];
  assert.doesNotMatch(windows.split('    steps:')[0], /GH_TOKEN/, 'no job-level token in the windows job');
  assert.match(windows, /persist-credentials: false/);
  const stepsWithToken = windows.split(/\n      - /).filter((step) => /GH_TOKEN/.test(step));
  assert.equal(stepsWithToken.length, 2);
  for (const step of stepsWithToken) assert.match(step, /^(name: The release for the tag|name: Upload into the release)/);
  for (const [, action] of code.matchAll(/^\s*- uses: (\S+)/gm)) assert.match(action, /@[0-9a-f]{40}$/, `${action} is not pinned to a commit`);
});
