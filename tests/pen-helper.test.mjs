import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPenHelper } from '../tools/build-pen-helper.mjs';

const mac = process.platform === 'darwin';
let directory, helper;

test('the Wacom side-button helper builds', { skip: !mac }, async () => {
	directory = await mkdtemp(join(tmpdir(), 'scroll-pen-'));
	helper = buildPenHelper(join(directory, 'scroll-pen'));
	assert.ok(helper);
});

// The display's report: id 0x1E, 0x01, then the status byte (0x80 in range, 0x40 valid, 0x01 tip, 0x02 lower, 0x04 upper).
const reports = [
	['1e 01 c0 00', { tip: false, lower: false, upper: false, range: true }],
	['1e 01 c1', { tip: true, lower: false, upper: false, range: true }],
	['1e 01 c2', { tip: false, lower: true, upper: false, range: true }],
	['1e 01 c4', { tip: false, lower: false, upper: true, range: true }],
	['1e 01 c3', { tip: true, lower: true, upper: false, range: true }],
	['1e 01 c5', { tip: true, lower: false, upper: true, range: true }],
	['1e 01 80', { tip: false, lower: false, upper: false, range: false }],
	['1e 01 06', { tip: false, lower: false, upper: false, range: false }],
	['1e 00 00', { tip: false, lower: false, upper: false, range: false }],
];

test('the helper reads the display\'s switches from its reports, only while the pen is in range', { skip: !mac }, () => {
	for (const [report, expected] of reports) {
		const line = JSON.parse(execFileSync(helper, ['--decode', report]).toString());
		assert.deepEqual(line, { k: 'buttons', ...expected }, report);
	}
});

test('anything that is not the display\'s button report is refused', { skip: !mac }, () => {
	for (const report of ['02 01 c4', '1e', '1e 01', '1e 02 c4', 'zz', '']) {
		assert.deepEqual(JSON.parse(execFileSync(helper, ['--decode', report]).toString()), { k: 'not-a-button-report' }, report);
	}
});

test('the helper says whether Input Monitoring is on, without asking', { skip: !mac }, () => {
	const line = JSON.parse(execFileSync(helper, ['--access']).toString());
	assert.equal(line.k, 'access');
	assert.ok(['granted', 'denied', 'undetermined'].includes(line.v));
});

test('the helper lists the Wacom interfaces without opening anything', { skip: !mac }, () => {
	for (const line of execFileSync(helper, ['--list']).toString().split('\n').filter(Boolean)) assert.equal(JSON.parse(line).k, 'interface');
});

test('the helper test directory is removed', { skip: !mac }, async () => { await rm(directory, { recursive: true, force: true }); });
