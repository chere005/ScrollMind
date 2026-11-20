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

// The standard pen report, which is what arrives with the Wacom driver running: id 0x06, contact count, then the status byte
// (0x01 tip, 0x02 the barrel switch nearer the tip, 0x04 the secondary barrel switch, 0x40 in range), X at 3, Y at 6, pressure at 9.
const standard = (status, x = 0, y = 0, p = 0) => {
	const bytes = Buffer.alloc(34);
	bytes.set([0x06, 1, status]); bytes.writeUInt16LE(x, 3); bytes.writeUInt16LE(y, 6); bytes.writeUInt16LE(p, 9);
	return bytes.toString('hex').match(/../g).join(' ');
};

test('the helper reads the switches, the tip and the pen\'s place from the standard pen report', { skip: !mac }, () => {
	const decode = report => JSON.parse(execFileSync(helper, ['--decode', report]).toString());
	assert.deepEqual(decode(standard(0x40, 12816, 7209)), { k: 'buttons', tip: false, lower: false, upper: false, range: true, x: .5, y: .5, p: 0 });
	assert.deepEqual(decode(standard(0x42, 25632, 0)), { k: 'buttons', tip: false, lower: true, upper: false, range: true, x: 1, y: 0, p: 0 });
	assert.deepEqual(decode(standard(0x44, 0, 14418)), { k: 'buttons', tip: false, lower: false, upper: true, range: true, x: 0, y: 1, p: 0 });
	assert.deepEqual(decode(standard(0x43, 6408, 7209, 4095)), { k: 'buttons', tip: true, lower: true, upper: false, range: true, x: .25, y: .5, p: 1 });
	// Out of range nothing is held and the pen is nowhere.
	assert.deepEqual(decode(standard(0x07, 100, 100, 100)), { k: 'buttons', tip: false, lower: false, upper: false, range: false });
	// A place off the panel is not a place: the switches still count.
	assert.deepEqual(decode(standard(0x42, 30000, 100)), { k: 'buttons', tip: false, lower: true, upper: false, range: true });
});

test('a run of reports says each change of the switches once and follows the pen only while a side switch is held', { skip: !mac }, () => {
	const lines = execFileSync(helper, ['--replay',
		standard(0x40, 1000, 2000), standard(0x40, 1100, 2000),                          // hovering, moving: one line, no following
		standard(0x42, 12816, 7209), standard(0x42, 12816, 7209), standard(0x42, 19224, 7209), // lower held: its place when it moves
		standard(0x43, 19224, 7209, 2048), standard(0x43, 19224, 14418, 4095),           // the tip touches and drags
		standard(0x42, 19224, 14418), standard(0x40, 19224, 14418),                      // the tip lifts, the switch lets go
		standard(0x41, 100, 100, 1000), standard(0x41, 200, 200, 1000),                  // plain writing: nothing but the tip
		standard(0x00)]).toString().trim().split('\n').map(line => JSON.parse(line));
	assert.deepEqual(lines.map(line => line.k), ['buttons', 'buttons', 'at', 'buttons', 'at', 'buttons', 'buttons', 'buttons', 'buttons']);
	assert.deepEqual(lines[2], { k: 'at', x: .75, y: .5, p: 0 });
	assert.deepEqual(lines[3], { k: 'buttons', tip: true, lower: true, upper: false, range: true, x: .75, y: .5, p: .50012 });
	assert.deepEqual(lines[4], { k: 'at', x: .75, y: 1, p: 1 });
	assert.deepEqual(lines[7], { k: 'buttons', tip: true, lower: false, upper: false, range: true, x: .0039, y: .00694, p: .2442 });
	assert.deepEqual(lines[8], { k: 'buttons', tip: false, lower: false, upper: false, range: false });
});

test('anything that is not the display\'s button report is refused', { skip: !mac }, () => {
	for (const report of ['02 01 c4', '1e', '1e 01', '1e 02 c4', '06', '06 01', 'zz', '']) {
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
