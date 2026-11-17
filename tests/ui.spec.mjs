import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let app;
let page;
let dataDir;

async function launch() {
  const env = { ...process.env, SCROLLMIND_TEST: '1', SCROLLMIND_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root, '--smoke-test'], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.scrollmindDebug));
}

async function closeGracefully() {
  if (!app || app.process().exitCode !== null) return;
  const process = app.process();
  const exited = new Promise(resolveExit => process.once('exit', resolveExit));
  await page.evaluate(() => { window.scrollmind.quit(); }).catch(() => {});
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('App did not complete its final save and quit')), 10_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  await app.close().catch(() => {});
  app = null;
}

async function snapshot() {
  return page.evaluate(() => window.scrollmindDebug.getSnapshot());
}

async function selection() {
  return page.evaluate(() => Array.from(window.scrollmindDebug.getSelection()));
}

async function drag(from, to, { steps = 12 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

async function draw(from = { x: 220, y: 250 }, to = { x: 430, y: 300 }) {
  await page.locator('[data-tool="pen"]').click();
  await drag(from, to);
}

async function pointer(type, x, y, { pressure = 0.6, buttons = 1, button = 0 } = {}) {
  await page.evaluate(({ type, x, y, pressure, buttons, button }) => {
    document.querySelector('#overlay').dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 44, pointerType: 'pen',
      isPrimary: true, clientX: x, clientY: y, pressure, buttons, button,
    }));
  }, { type, x, y, pressure, buttons, button });
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(resolve(tmpdir(), 'scrollmind-ui-'));
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    await testInfo.attach('hidden-app', { body: await page.screenshot(), contentType: 'image/png' }).catch(() => {});
  }
  await closeGracefully().catch(async () => { if (app) await app.close().catch(() => {}); });
  await rm(dataDir, { recursive: true, force: true });
});

test('rectangle crossing selects a whole stroke; mouse moves, clipboard edits and undo preserve ink', async () => {
  await draw({ x: 180, y: 260 }, { x: 500, y: 260 });
  const original = (await snapshot()).strokes[0];
  expect(original.points.length).toBeGreaterThan(2);

  await page.locator('[data-tool="select"]').click();
  // Both endpoints lie outside the selection: segment intersection must still select.
  await drag({ x: 310, y: 225 }, { x: 360, y: 295 });
  await expect.poll(async () => (await selection()).length).toBe(1);
  await drag({ x: 330, y: 260 }, { x: 390, y: 330 });
  let moved = (await snapshot()).strokes[0];
  expect(moved.points[0].x).toBeCloseTo(original.points[0].x + 60, 0);
  expect(moved.points[0].y).toBeCloseTo(original.points[0].y + 70, 0);

  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press(`${modifier}+v`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(2);
  const pasted = (await snapshot()).strokes.find(stroke => stroke.id !== original.id);
  expect(pasted.id).not.toBe(original.id);
  expect(pasted.points.map(point => point.p)).toEqual(original.points.map(point => point.p));

  await page.keyboard.press('Delete');
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(2);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);

  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+x`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await page.keyboard.press(`${modifier}+v`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
});

test('signed vertical scrolling and pen pressure work without hover erasing', async () => {
  await page.locator('[data-tool="pen"]').click();
  await pointer('pointerdown', 200, 300, { pressure: 0.2 });
  await pointer('pointermove', 260, 320, { pressure: 0.8 });
  await pointer('pointerup', 300, 340, { pressure: 0, buttons: 0, button: 0 });
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
  const stroke = (await snapshot()).strokes[0];
  expect(stroke.points.some(point => point.p < 0.4)).toBe(true);
  expect(stroke.points.some(point => point.p > 0.7)).toBe(true);

  await pointer('pointerdown', 250, 315, { pressure: 0, buttons: 2, button: 2 });
  await pointer('pointermove', 260, 320, { pressure: 0, buttons: 2, button: 2 });
  await pointer('pointerup', 260, 320, { pressure: 0, buttons: 0, button: 2 });
  expect((await snapshot()).strokes).toHaveLength(1);

  await page.mouse.move(600, 420);
  await page.mouse.wheel(0, -650);
  await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getOffsetY())).toBeLessThan(-100);
  await page.mouse.wheel(0, 1300);
  await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getOffsetY())).toBeGreaterThan(100);

  await page.keyboard.press(`${modifier}+0`);
  await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getOffsetY())).toBe(0);
  await pointer('pointerdown', 250, 315, { pressure: 0.5, buttons: 2, button: 2 });
  await pointer('pointermove', 260, 320, { pressure: 0.6, buttons: 2, button: 2 });
  await pointer('pointerup', 260, 320, { pressure: 0, buttons: 0, button: 2 });
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
});

test('selection corner resizes preserve pressure, Shift keeps shape, and nudges undo cleanly', async () => {
  await draw({ x: 220, y: 250 }, { x: 430, y: 330 });
  const original = (await snapshot()).strokes[0];
  await page.locator('[data-tool="select"]').click();
  await drag({ x: 190, y: 220 }, { x: 460, y: 360 });
  await expect.poll(async () => (await selection()).length).toBe(1);

  const xs = original.points.map(point => point.x), ys = original.points.map(point => point.y);
  const handle = { x: Math.max(...xs) + original.width / 2 + 7, y: Math.max(...ys) + original.width / 2 + 7 };
  await page.keyboard.down('Shift');
  await drag(handle, { x: handle.x + 110, y: handle.y + 25 });
  await page.keyboard.up('Shift');
  const resized = (await snapshot()).strokes[0];
  const span = (stroke, axis) => Math.max(...stroke.points.map(point => point[axis])) - Math.min(...stroke.points.map(point => point[axis]));
  expect(span(resized, 'x')).toBeGreaterThan(span(original, 'x') * 1.3);
  expect(span(resized, 'x') / span(original, 'x')).toBeCloseTo(span(resized, 'y') / span(original, 'y'), 3);
  expect(resized.points.map(point => point.p)).toEqual(original.points.map(point => point.p));

  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('ArrowDown');
  const nudged = (await snapshot()).strokes[0];
  expect(nudged.points[0].x).toBeCloseTo(resized.points[0].x + 10, 5);
  expect(nudged.points[0].y).toBeCloseTo(resized.points[0].y + 1, 5);
  await page.keyboard.press(`${modifier}+z`);
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes[0]).toEqual(resized);
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes[0]).toEqual(original);
});

test('optional sidebar styles paper and saves sections, page breaks and writing across quit', async () => {
  await expect(page.locator('#sidebar')).toBeHidden();
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await page.locator('#paper-tone').selectOption('parchment');
  await page.locator('#paper-pattern').selectOption('ruled');
  await page.locator('#add-section').click();
  await page.locator('#add-marker').click();
  await page.locator('#add-page-break').click();
  await expect.poll(async () => (await snapshot()).markers.length).toBe(3);
  const markerKinds = (await snapshot()).markers.map(marker => marker.kind).sort();
  expect(markerKinds).toEqual(['marker', 'page-break', 'section']);
  const sectionName = page.getByRole('textbox', { name: 'Section name', exact: true });
  await sectionName.fill('Meeting notes');
  await sectionName.press('Enter');
  await expect.poll(async () => (await snapshot()).markers.find(marker => marker.kind === 'section').label).toBe('Meeting notes');
  const sectionY = (await snapshot()).markers.find(marker => marker.kind === 'section').y;
  await page.evaluate(() => window.scrollmindDebug.setOffsetY(-1600));
  await page.getByRole('button', { name: 'Go to Meeting notes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getOffsetY())).toBe(sectionY - 130);
  await page.getByRole('button', { name: 'Remove Meeting notes', exact: true }).click();
  await expect.poll(async () => (await snapshot()).markers.length).toBe(2);
  await page.locator('#undo').click();
  await expect.poll(async () => (await snapshot()).markers.length).toBe(3);
  expect((await snapshot()).markers.find(marker => marker.kind === 'section').label).toBe('Meeting notes');
  await page.locator('#sidebar-toggle').click();
  await page.keyboard.press(`${modifier}+0`);
  await draw();
  const expected = await snapshot();

  await closeGracefully();
  const saved = JSON.parse(await readFile(resolve(dataDir, 'notebook.scrollmind.json'), 'utf8'));
  expect(saved.strokes).toHaveLength(1);
  expect(saved.markers).toEqual(expected.markers);
  expect(saved.settings.paperTone).toBe('parchment');
  expect(saved.settings.paper).toBe('ruled');

  await launch();
  const reopened = await snapshot();
  expect(reopened.strokes).toEqual(expected.strokes);
  expect(reopened.markers).toEqual(expected.markers);
  expect(reopened.settings.paperTone).toBe('parchment');
  expect(reopened.settings.paper).toBe('ruled');
  await expect(page.locator('#sidebar')).toBeHidden();
});

test('opening a damaged primary recovers visible writing and preserves the damaged file', async () => {
  await draw();
  const expected = await snapshot();
  await closeGracefully();
  await writeFile(resolve(dataDir, 'notebook.backup.json'), JSON.stringify(expected));
  await writeFile(resolve(dataDir, 'notebook.scrollmind.json'), '{damaged notebook');
  await launch();
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  await expect(page.locator('#status')).toContainText('Recovered');
  expect((await readdir(dataDir)).some(name => name.startsWith('notebook.corrupt-'))).toBe(true);

  await draw({ x: 520, y: 400 }, { x: 700, y: 450 });
  await closeGracefully();
  const saved = JSON.parse(await readFile(resolve(dataDir, 'notebook.scrollmind.json'), 'utf8'));
  expect(saved.strokes).toHaveLength(2);
  expect(saved.strokes[0]).toEqual(expected.strokes[0]);
});
