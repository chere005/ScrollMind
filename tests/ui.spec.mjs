import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { createServer } from 'node:http';
import { gridPage, gridStartView } from '../src/core/grid.mjs';
import { feedYaml } from '../tools/update-feed.mjs';
import { inkOnPaper } from '../src/core/paper.mjs';

const root = resolve(import.meta.dirname, '..');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let app;
let page;
let dataDir;
let penPlatform = 'darwin';
let extraArgs = [];

async function launch() {
  const env = {
    ...process.env,
    SCROLLMIND_TEST: '1',
    SCROLLMIND_DATA_DIR: dataDir,
    SCROLLMIND_EXPORT_DIR: resolve(dataDir, 'Exports'),
    SCROLLMIND_OPEN_PATH: '__cancel__',
    SCROLLMIND_TEST_PEN_PLATFORM: penPlatform,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root, '--smoke-test', ...extraArgs], cwd: root, env });
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

async function workspace() {
  return page.evaluate(() => window.scrollmindDebug.getWorkspace());
}

async function showSidebar(show = true) {
  if (await page.locator('#sidebar').isHidden() === show) await page.locator('#sidebar-toggle').click();
}

async function selectScroll(id) {
  await showSidebar();
  await page.locator(`.scroll-row[data-scroll-id="${id}"] .scroll-go`).click();
  await expect.poll(async () => (await workspace()).activeId).toBe(id);
}

async function openPenControls() {
  if (await page.locator('#toolbar').isHidden()) await page.locator('#pen-controls-toggle').hover();
  await expect(page.locator('#toolbar')).toBeVisible();
}

async function clickPenControl(selector) {
  await openPenControls();
  await page.locator(selector).click();
}

function readNativeScroll(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    expect(database.prepare('PRAGMA quick_check').get().quick_check).toBe('ok');
    // A .sm file is a Scroll or a Grid by its SQLite application ID, not its name.
    const applicationId = database.prepare('PRAGMA application_id').get().application_id;
    expect([0x534d4e44, 0x534d4752]).toContain(applicationId);
    const grid = applicationId === 0x534d4752;
    const schema = database.prepare('PRAGMA user_version').get().user_version;
    expect(grid ? [1, 2] : [1, 2, 3, 4, 5]).toContain(schema);
    const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]));
    return {
      version: 1,
      strokes: database.prepare(`SELECT id, color, width, points, ${grid || schema >= 2 ? 'pen_type' : 'NULL AS pen_type'} FROM strokes ORDER BY order_index`).all().map(row => {
        const { pen_type, ...stroke } = row;
        return { ...stroke, points: JSON.parse(stroke.points), ...(pen_type == null ? {} : { penType: pen_type }) };
      }),
      markers: database.prepare('SELECT id, y, label, kind FROM markers ORDER BY y, rowid').all().map(row => ({ ...row })),
      view: metadata.view,
      settings: metadata.settings,
      ...(metadata.diagram?.nodes.length ? { diagram: metadata.diagram } : {}),
    };
  } finally {
    database.close();
  }
}

async function exportedPath(extension) {
  const directory = resolve(dataDir, 'Exports');
  await expect.poll(async () => (await readdir(directory).catch(() => [])).filter(name => name.endsWith(`.${extension}`)).length).toBe(1);
  const [name] = (await readdir(directory)).filter(name => name.endsWith(`.${extension}`));
  return resolve(directory, name);
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
  await clickPenControl('[data-tool="pen"]');
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
  penPlatform = 'darwin';
  extraArgs = [];
  dataDir = await mkdtemp(resolve(tmpdir(), 'scrollmind-ui-'));
  await launch();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page && !page.isClosed()) {
    await testInfo.attach('hidden-app', { body: await page.screenshot(), contentType: 'image/png' }).catch(() => {});
  }
  await closeGracefully().catch(async () => { if (app) await app.close().catch(() => {}); });
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('rectangle crossing selects a whole stroke; mouse moves, clipboard edits and undo preserve ink', async () => {
  await draw({ x: 180, y: 260 }, { x: 500, y: 260 });
  const original = (await snapshot()).strokes[0];
  expect(original.points.length).toBeGreaterThan(2);

  await clickPenControl('[data-tool="select"]');
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
  await clickPenControl('[data-tool="pen"]');
  await pointer('pointerdown', 200, 300, { pressure: 0.2 });
  await pointer('pointermove', 260, 320, { pressure: 0.8 });
  await pointer('pointerup', 300, 340, { pressure: 0, buttons: 0, button: 0 });
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
  const stroke = (await snapshot()).strokes[0];
  expect(stroke.points.some(point => point.p < 0.4)).toBe(true);
  expect(stroke.points.some(point => point.p > 0.7)).toBe(true);

  await pointer('pointerdown', 250, 315, { pressure: 0, buttons: 2, button: 2 });
  await pointer('pointermove', 260, 320, { pressure: 0.5, buttons: 2, button: 2 });
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
  await pointer('pointermove', 250, 315, { pressure: 0.6, buttons: 3, button: 0 });
  await pointer('pointermove', 260, 320, { pressure: 0.6, buttons: 3, button: -1 });
  await pointer('pointermove', 260, 320, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointerup', 260, 320, { pressure: 0, buttons: 0, button: 2 });
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await page.keyboard.press(`${modifier}+z`);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(1);
});

test('barrel erasing requires fresh contact, sweeps crossed strokes, and each drag undoes together', async () => {
  await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
  await draw({ x: 200, y: 400 }, { x: 400, y: 400 });
  await draw({ x: 200, y: 550 }, { x: 400, y: 550 });
  const original = (await snapshot()).strokes;
  const [first, second, third] = original;

  // Drivers can report nonzero pressure when only the barrel button is held.
  await pointer('pointerdown', 300, 250, { pressure: 0.5, buttons: 2, button: 2 });
  await pointer('pointermove', 305, 250, { pressure: 0.5, buttons: 2, button: -1 });
  expect((await snapshot()).strokes).toEqual(original);

  // Tip contact is a buttons 2 -> 3 edge while the barrel remains held.
  await pointer('pointermove', 300, 250, { pressure: 0.6, buttons: 3, button: 0 });
  await expect.poll(async () => (await snapshot()).strokes.map(stroke => stroke.id)).toEqual([second.id, third.id]);
  await pointer('pointermove', 300, 400, { pressure: 0.7, buttons: 3, button: -1 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([third.id]);

  // Lifting the tip, without releasing the barrel, permits a second erase gesture.
  await pointer('pointermove', 300, 400, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 3, button: 0 });
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await pointer('pointermove', 300, 550, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([third.id]);
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);

  // Returning after focus loss with the tip already down is not a new tap.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 3, button: -1 });
  expect((await snapshot()).strokes).toEqual(original);
  await pointer('pointermove', 300, 550, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 3, button: 0 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([first.id, second.id]);
  await pointer('pointermove', 300, 550, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);

  // Pressing the barrel after the tip was already writing must not delete nearby ink.
  await pointer('pointerdown', 600, 250, { pressure: 0.4, buttons: 1, button: 0 });
  await pointer('pointermove', 650, 300, { pressure: 0.6, buttons: 1, button: -1 });
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 3, button: 2 });
  await pointer('pointermove', 310, 550, { pressure: 0.6, buttons: 3, button: -1 });
  await pointer('pointermove', 310, 550, { pressure: 0, buttons: 2, button: 0 });
  await pointer('pointerup', 310, 550, { pressure: 0, buttons: 0, button: 2 });
  const afterChord = (await snapshot()).strokes;
  expect(afterChord.filter(stroke => [first.id, second.id, third.id].includes(stroke.id))).toEqual(original);
  expect(afterChord).toHaveLength(4);
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);

  // Adding the scrolling button ends an erase drag before it crosses more ink.
  await pointer('pointerdown', 300, 250, { pressure: 0.5, buttons: 2, button: 2 });
  await pointer('pointermove', 300, 250, { pressure: 0.6, buttons: 3, button: 0 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([second.id, third.id]);
  await pointer('pointermove', 300, 400, { pressure: 0.6, buttons: 7, button: 1 });
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 7, button: -1 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([second.id, third.id]);
  await pointer('pointermove', 300, 550, { pressure: 0, buttons: 6, button: 0 });
  await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);
});

test('selection corner resizes preserve pressure, Shift keeps shape, and nudges undo cleanly', async () => {
  await draw({ x: 220, y: 250 }, { x: 430, y: 330 });
  const original = (await snapshot()).strokes[0];
  await clickPenControl('[data-tool="select"]');
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
  await page.locator('#paper-pattern').selectOption('dots');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dotPaper = await page.evaluate(() => {
    const canvas = document.querySelector('#canvas'), paint = canvas.getContext('2d');
    const ratio = canvas.width / innerWidth, left = Math.round(330 * ratio), top = Math.round(180 * ratio);
    const side = Math.round(144 * ratio), data = paint.getImageData(left, top, side, side).data;
    const paper = [241, 233, 216];
    let offGridPixels = 0, dotPixels = 0, strongestContrast = 0;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const index = (y * side + x) * 4;
      const contrast = Math.max(...paper.map((channel, c) => Math.abs(channel - data[index + c])));
      if (contrast <= 2) continue;
      const worldX = (left + x + 0.5) / ratio, worldY = (top + y + 0.5) / ratio;
      const gridX = 16 + Math.round((worldX - 16) / 24) * 24, gridY = Math.round(worldY / 24) * 24;
      if (Math.hypot(worldX - gridX, worldY - gridY) > 2) offGridPixels++;
      else { dotPixels++; strongestContrast = Math.max(strongestContrast, contrast); }
    }
    return { offGridPixels, dotPixels, strongestContrast };
  });
  expect(dotPaper.offGridPixels).toBe(0);
  expect(dotPaper.dotPixels).toBeGreaterThan(0);
  expect(dotPaper.strongestContrast).toBeGreaterThanOrEqual(40);
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
  await clickPenControl('#undo');
  await expect.poll(async () => (await snapshot()).markers.length).toBe(3);
  expect((await snapshot()).markers.find(marker => marker.kind === 'section').label).toBe('Meeting notes');
  const sidebarButton = await page.locator('#sidebar-toggle').boundingBox();
  const penToolbar = await page.locator('#toolbar').boundingBox();
  const center = { x: sidebarButton.x + sidebarButton.width / 2, y: sidebarButton.y + sidebarButton.height / 2 };
  expect(center.x >= penToolbar.x && center.x <= penToolbar.x + penToolbar.width
    && center.y >= penToolbar.y && center.y <= penToolbar.y + penToolbar.height).toBe(false);
  await page.locator('#sidebar-toggle').click();
  await page.keyboard.press(`${modifier}+0`);
  await draw();
  const expected = await snapshot();

  await closeGracefully();
  const saved = readNativeScroll(resolve(dataDir, 'scroll.sm'));
  expect(saved.strokes).toHaveLength(1);
  expect(saved.markers).toEqual(expected.markers);
  expect(saved.settings.paperTone).toBe('parchment');
  expect(saved.settings.paper).toBe('dots');

  await launch();
  const reopened = await snapshot();
  expect(reopened.strokes).toEqual(expected.strokes);
  expect(reopened.markers).toEqual(expected.markers);
  expect(reopened.settings.paperTone).toBe('parchment');
  expect(reopened.settings.paper).toBe('dots');
  await expect(page.locator('#sidebar')).toBeHidden();
});

test('opening a damaged primary recovers visible writing and preserves the damaged file', async () => {
  await draw();
  const expected = await snapshot();
  await closeGracefully();
  await copyFile(resolve(dataDir, 'scroll.sm'), resolve(dataDir, 'scroll.backup.sm'));
  await writeFile(resolve(dataDir, 'scroll.sm'), 'damaged scroll');
  await launch();
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  await expect(page.locator('#status')).toContainText('Recovered');
  expect((await readdir(dataDir)).some(name => name.startsWith('scroll.sm.corrupt-'))).toBe(true);

  await draw({ x: 520, y: 400 }, { x: 700, y: 450 });
  await closeGracefully();
  const saved = readNativeScroll(resolve(dataDir, 'scroll.sm'));
  expect(saved.strokes).toHaveLength(2);
  expect(saved.strokes[0]).toEqual(expected.strokes[0]);
});

test('exports independent editable SM, vector SVG and paginated PDF, then reopens the SM for editing', async () => {
  await clickPenControl('[data-tool="pen"]');
  await page.locator('#pen-type').selectOption('marker');
  await clickPenControl('[data-width="12"]');
  await pointer('pointerdown', 380, 250, { pressure: 0.2 });
  await pointer('pointermove', 430, 270, { pressure: 0.8 });
  await pointer('pointerup', 430, 270, { pressure: 0, buttons: 0 });
  await page.locator('#sidebar-toggle').click();
  await page.locator('#add-section').click();
  await page.locator('#add-marker').click();
  await page.locator('#add-page-break').click();
  await page.locator('#sidebar-toggle').click();
  await draw({ x: 520, y: 620 }, { x: 700, y: 650 });
  const expected = await snapshot();
  expect(expected.strokes.every(stroke => stroke.penType === 'marker' && stroke.width === 12)).toBe(true);
  await page.locator('#sidebar-toggle').click();

  await page.locator('#export-sm').click();
  const nativeFile = await exportedPath('sm');
  expect((await readFile(nativeFile)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  // Open read-only while ScrollMind is running: the copy must not depend on a live WAL.
  const exported = readNativeScroll(nativeFile);
  expect(exported.strokes).toEqual(expected.strokes);
  expect(exported.markers).toEqual(expected.markers);
  expect(exported.settings).toEqual(expected.settings);
  expect((await readdir(resolve(dataDir, 'Exports'))).some(name => name.endsWith('-wal'))).toBe(false);

  await page.locator('#export-svg').click();
  const svg = await readFile(await exportedPath('svg'), 'utf8');
  expect(svg).toMatch(/<svg\b/);
  expect(svg).toMatch(/<path\b/);
  expect(svg).toContain('data-pen-type="marker"');
  expect(svg).not.toMatch(/<image\b|<foreignObject\b|<script\b|id=["']toolbar["']/i);
  const vectorContent = await page.evaluate(source => {
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    return { errors: document.querySelectorAll('parsererror').length, paths: document.querySelectorAll('path').length };
  }, svg);
  expect(vectorContent.errors).toBe(0);
  expect(vectorContent.paths).toBeGreaterThan(1);

  await page.locator('#export-pdf').click();
  const pdf = await readFile(await exportedPath('pdf'));
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)]).toHaveLength(2);

  await page.locator('#sidebar-toggle').click();
  await draw({ x: 800, y: 500 }, { x: 900, y: 540 });
  expect((await snapshot()).strokes).toHaveLength(3);
  const originalScrollId = (await workspace()).activeId;
  const originalBeforeOpen = await snapshot();
  await app.evaluate((_electron, path) => { process.env.SCROLLMIND_OPEN_PATH = path; }, nativeFile);
  await page.locator('#sidebar-toggle').click();
  await page.locator('#open-sm').click();
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(2);
  const importedScrollId = (await workspace()).activeId;
  expect(importedScrollId).not.toBe(originalScrollId);
  expect((await workspace()).scrolls.filter(scroll => scroll.open)).toHaveLength(2);
  expect((await readdir(dataDir)).includes('Saved Scrolls')).toBe(false);
  await selectScroll(originalScrollId);
  expect((await snapshot()).strokes).toEqual(originalBeforeOpen.strokes);
  await selectScroll(importedScrollId);
  expect(readNativeScroll(nativeFile).strokes).toEqual(expected.strokes);
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  expect((await snapshot()).markers).toEqual(expected.markers);
  expect(await selection()).toEqual([]);
  await expect(page.locator('#undo')).toBeDisabled();

  await app.evaluate(() => { process.env.SCROLLMIND_OPEN_PATH = '__cancel__'; delete process.env.SCROLLMIND_EXPORT_DIR; });
  const canceledOpen = await page.evaluate(() => window.scrollmind.openDocument());
  const canceledExport = await page.evaluate(() => window.scrollmind.exportDocument('sm', { width: innerWidth, height: innerHeight }));
  expect(canceledOpen.canceled).toBe(true);
  expect(canceledExport.canceled).toBe(true);
  expect((await snapshot()).strokes).toEqual(expected.strokes);

  await showSidebar(false);
  await draw({ x: 750, y: 520 }, { x: 850, y: 560 });
  expect((await snapshot()).strokes).toHaveLength(3);
  const activeFile = await page.evaluate(async () => (await window.scrollmind.getAppInfo()).dataPath);
  await closeGracefully();
  expect(readNativeScroll(activeFile).strokes).toHaveLength(3);
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(originalBeforeOpen.strokes);
});

test('legacy JSON migrates losslessly to SQLite while the original file is preserved', async () => {
  await closeGracefully();
  await rm(resolve(dataDir, 'scroll.sm'), { force: true });
  await rm(resolve(dataDir, 'scroll.backup.sm'), { force: true });
  const legacy = {
    version: 1,
    strokes: [{
      id: 'legacy-stroke', color: '#215b9c', width: 3,
      points: [{ x: 120, y: -350, p: 0.15 }, { x: 220, y: -300, p: 0.85 }],
    }],
    markers: [
      { id: 'legacy-section', y: -400, label: 'Previous thoughts', kind: 'section' },
      { id: 'legacy-break', y: 450, label: 'Next page', kind: 'page-break' },
    ],
    view: { offsetY: -450 },
    settings: { color: '#215b9c', width: 3, paper: 'ruled', paperTone: 'parchment' },
  };
  const legacyText = `${JSON.stringify(legacy)}\n`;
  const legacyFile = resolve(dataDir, 'notebook.scrollmind.json');
  await writeFile(legacyFile, legacyText);
  await launch();
  expect(await snapshot()).toEqual(legacy);
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm'))).toEqual(legacy);
  expect(await readFile(legacyFile, 'utf8')).toBe(legacyText);
  await closeGracefully();
  await launch();
  expect(await snapshot()).toEqual(legacy);
});

test('open scrolls preserve pending ink, independent undo, names, close/reopen and restart', async () => {
  const firstId = (await workspace()).activeId;
  await draw({ x: 380, y: 250 }, { x: 470, y: 280 });
  const firstInk = (await snapshot()).strokes;
  await showSidebar();
  await page.locator('#new-scroll').click();
  await expect.poll(async () => (await workspace()).activeId).not.toBe(firstId);
  const secondId = (await workspace()).activeId;
  const secondRow = page.locator(`.scroll-row[data-scroll-id="${secondId}"]`);
  await secondRow.locator('.scroll-rename').click();
  await secondRow.locator('.scroll-name').fill('Plans');
  await secondRow.locator('.scroll-name').press('Enter');
  await expect.poll(async () => (await workspace()).scrolls.find(scroll => scroll.id === secondId).name).toBe('Plans');
  await showSidebar(false);
  await draw({ x: 520, y: 300 }, { x: 640, y: 350 });
  const secondInk = (await snapshot()).strokes;

  await selectScroll(firstId);
  // Leave a pen gesture unfinished; switching scrolls must commit its ink first.
  await pointer('pointerdown', 520, 400, { pressure: 0.3 });
  await pointer('pointermove', 620, 430, { pressure: 0.8 });
  await selectScroll(secondId);
  expect((await snapshot()).strokes).toEqual(secondInk);
  await selectScroll(firstId);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(2);
  const firstWithPending = (await snapshot()).strokes;
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(firstInk);
  await page.keyboard.press(`${modifier}+Shift+z`);
  expect((await snapshot()).strokes).toEqual(firstWithPending);
  await selectScroll(secondId);
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toHaveLength(0);
  await page.keyboard.press(`${modifier}+Shift+z`);
  expect((await snapshot()).strokes).toEqual(secondInk);

  await page.locator(`.scroll-row[data-scroll-id="${secondId}"] .scroll-close`).click();
  await expect.poll(async () => (await workspace()).activeId).toBe(firstId);
  expect((await workspace()).scrolls.find(scroll => scroll.id === secondId).open).toBe(false);
  await page.locator('#closed-scrolls > summary').click();
  await page.locator(`.scroll-reopen[data-scroll-id="${secondId}"]`).click();
  await expect.poll(async () => (await workspace()).activeId).toBe(secondId);
  expect((await snapshot()).strokes).toEqual(secondInk);
  await expect(page.locator(`.scroll-row[data-scroll-id="${secondId}"] .scroll-go`)).toHaveAttribute('aria-current', 'page');

  await closeGracefully();
  await launch();
  expect((await workspace()).activeId).toBe(secondId);
  expect((await workspace()).scrolls.filter(scroll => scroll.open)).toHaveLength(2);
  expect((await workspace()).scrolls.find(scroll => scroll.id === secondId).name).toBe('Plans');
  expect((await snapshot()).strokes).toEqual(secondInk);
  await selectScroll(firstId);
  expect((await snapshot()).strokes).toEqual(firstWithPending);
});

test('clear removes all current content in one undo action and leaves other scrolls and paper intact', async () => {
  const firstId = (await workspace()).activeId;
  await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
  const firstInk = (await snapshot()).strokes;
  await showSidebar();
  await page.locator('#new-scroll').click();
  await expect.poll(async () => (await workspace()).activeId).not.toBe(firstId);
  const secondId = (await workspace()).activeId;
  await page.locator('#paper-tone').selectOption('parchment');
  await page.locator('#paper-pattern').selectOption('grid');
  await page.locator('#add-section').click();
  await page.locator('#add-marker').click();
  await page.locator('#add-page-break').click();
  await showSidebar(false);
  await draw({ x: 540, y: 320 }, { x: 650, y: 380 });
  const beforeClear = await snapshot();
  await showSidebar();
  await page.locator('#clear-scroll').click();
  await page.waitForFunction(() => !document.body.inert);
  expect((await snapshot()).strokes).toEqual([]);
  expect((await snapshot()).markers).toEqual([]);
  expect((await snapshot()).settings).toEqual(beforeClear.settings);
  await clickPenControl('#undo');
  expect((await snapshot()).strokes).toEqual(beforeClear.strokes);
  expect((await snapshot()).markers).toEqual(beforeClear.markers);
  await clickPenControl('#redo');
  expect((await snapshot()).strokes).toEqual([]);
  expect((await snapshot()).markers).toEqual([]);
  await selectScroll(firstId);
  expect((await snapshot()).strokes).toEqual(firstInk);
  await selectScroll(secondId);
  await closeGracefully();
  await launch();
  expect((await workspace()).activeId).toBe(secondId);
  expect((await snapshot()).strokes).toEqual([]);
  expect((await snapshot()).markers).toEqual([]);
  expect((await snapshot()).settings.paperTone).toBe('parchment');
  expect((await snapshot()).settings.paper).toBe('grid');
  await selectScroll(firstId);
  expect((await snapshot()).strokes).toEqual(firstInk);
});

test('hover double-clicks on pen buttons undo and redo, while an actual pan does not redo', async () => {
  await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
  const written = (await snapshot()).strokes;
  const clickButton = async (buttons, button, x = 750, y = 400) => {
    await pointer('pointerdown', x, y, { pressure: 0, buttons, button });
    await pointer('pointerup', x, y, { pressure: 0, buttons: 0, button });
  };
  await clickButton(2, 2);
  expect((await snapshot()).strokes).toEqual(written);
  await clickButton(2, 2);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await clickButton(4, 1);
  expect((await snapshot()).strokes).toEqual([]);
  await clickButton(4, 1);
  await expect.poll(async () => (await snapshot()).strokes).toEqual(written);

  await page.keyboard.press(`${modifier}+z`);
  await pointer('pointerdown', 750, 500, { pressure: 0, buttons: 4, button: 1 });
  await pointer('pointermove', 750, 420, { pressure: 0, buttons: 4, button: -1 });
  await pointer('pointerup', 750, 420, { pressure: 0, buttons: 0, button: 1 });
  await clickButton(4, 1, 750, 420);
  expect((await snapshot()).strokes).toEqual([]);
  expect(await page.evaluate(() => window.scrollmindDebug.getOffsetY())).toBe(80);
  await page.keyboard.press(`${modifier}+Shift+z`);
  expect((await snapshot()).strokes).toEqual(written);
});

test('opening several SM files together keeps each as a separate sidebar scroll', async () => {
  const originalId = (await workspace()).activeId;
  await draw({ x: 380, y: 250 }, { x: 490, y: 290 });
  const written = (await snapshot()).strokes;
  await showSidebar();
  await page.locator('#export-sm').click();
  const exported = await exportedPath('sm');
  const first = resolve(dataDir, 'One.sm'), second = resolve(dataDir, 'Two.sm');
  await copyFile(exported, first); await copyFile(exported, second);
  await app.evaluate(({ app }, files) => {
    for (const file of files) app.emit('open-file', { preventDefault() {} }, file);
  }, [first, second]);
  await expect.poll(async () => (await workspace()).scrolls.filter(scroll => scroll.open).length).toBe(3);
  const state = await workspace();
  expect(state.scrolls.map(scroll => scroll.name)).toEqual(['Scroll 1', 'One', 'Two']);
  expect(state.scrolls.find(scroll => scroll.active).name).toBe('Two');
  expect((await snapshot()).strokes).toEqual(written);
  await selectScroll(originalId);
  expect((await snapshot()).strokes).toEqual(written);
});

test('delete removes inactive and last scrolls without losing other history or the imported source', async () => {
  const firstId = (await workspace()).activeId;
  await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
  await showSidebar();
  await page.locator('#add-section').click();
  const firstContent = await snapshot();
  await page.locator('#export-sm').click();
  const sourceFile = await exportedPath('sm');
  const sourceBytes = await readFile(sourceFile);
  await app.evaluate((_electron, path) => { process.env.SCROLLMIND_OPEN_PATH = path; }, sourceFile);
  await page.locator('#open-sm').click();
  await expect.poll(async () => (await workspace()).activeId).not.toBe(firstId);
  const secondId = (await workspace()).activeId;
  await showSidebar();
  await page.locator('#add-marker').click();
  const beforeSecondInk = await snapshot();
  await showSidebar(false);
  await draw({ x: 540, y: 470 }, { x: 650, y: 510 });
  const secondContent = await snapshot();
  await showSidebar();

  await page.locator(`.scroll-row[data-scroll-id="${firstId}"] .scroll-delete`).click();
  await expect.poll(async () => (await workspace()).scrolls.some(scroll => scroll.id === firstId)).toBe(false);
  await page.waitForFunction(() => !document.body.inert);
  expect((await workspace()).activeId).toBe(secondId);
  expect((await snapshot()).strokes).toEqual(secondContent.strokes);
  expect((await snapshot()).markers).toEqual(secondContent.markers);
  await clickPenControl('#undo');
  expect((await snapshot()).strokes).toEqual(beforeSecondInk.strokes);
  expect((await snapshot()).markers).toEqual(beforeSecondInk.markers);
  await clickPenControl('#redo');
  expect((await snapshot()).strokes).toEqual(secondContent.strokes);
  await expect(page.locator(`.scroll-reopen[data-scroll-id="${firstId}"]`)).toHaveCount(0);

  await page.locator(`.scroll-row[data-scroll-id="${secondId}"] .scroll-delete`).click();
  await expect.poll(async () => (await workspace()).scrolls.some(scroll => scroll.id === secondId)).toBe(false);
  await page.waitForFunction(() => !document.body.inert);
  const replacementId = (await workspace()).activeId;
  expect([firstId, secondId]).not.toContain(replacementId);
  expect((await workspace()).scrolls).toHaveLength(1);
  expect((await snapshot()).strokes).toEqual([]);
  expect((await snapshot()).markers).toEqual([]);
  expect(await readFile(sourceFile)).toEqual(sourceBytes);
  const recoveryDirectory = resolve(dataDir, 'Deleted Scrolls');
  const recoveryFolders = (await readdir(recoveryDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  expect(recoveryFolders).toHaveLength(2);
  const recoveredContents = recoveryFolders.map(folder => readNativeScroll(resolve(recoveryDirectory, folder.name, 'scroll.sm')));
  const recoveredFirst = recoveredContents.find(content => content.strokes.length === firstContent.strokes.length);
  const recoveredSecond = recoveredContents.find(content => content.strokes.length === secondContent.strokes.length);
  expect(recoveredFirst.strokes).toEqual(firstContent.strokes);
  expect(recoveredFirst.markers).toEqual(firstContent.markers);
  expect(recoveredSecond.strokes).toEqual(secondContent.strokes);
  expect(recoveredSecond.markers).toEqual(secondContent.markers);

  await closeGracefully();
  await launch();
  const restored = await workspace();
  expect(restored.activeId).toBe(replacementId);
  expect(restored.scrolls).toHaveLength(1);
  expect(restored.scrolls.some(scroll => [firstId, secondId].includes(scroll.id))).toBe(false);
  expect((await snapshot()).strokes).toEqual([]);
  expect((await snapshot()).markers).toEqual([]);
  await showSidebar();
  await expect(page.locator(`.scroll-reopen[data-scroll-id="${firstId}"]`)).toHaveCount(0);
  await expect(page.locator(`.scroll-reopen[data-scroll-id="${secondId}"]`)).toHaveCount(0);
});

test('pen controls open after deliberate hover, stay usable inside, and collapse after leaving', async ({}, testInfo) => {
  const toolbar = page.locator('#toolbar');
  const toggle = page.locator('#pen-controls-toggle');
  await page.mouse.move(1000, 650);
  await expect(toolbar).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const circle = await toggle.boundingBox();
  await toggle.hover();
  await page.waitForTimeout(80);
  await expect(toolbar).toBeHidden();
  await page.mouse.move(1000, 650);
  await page.waitForTimeout(250);
  await expect(toolbar).toBeHidden();

  await toggle.hover();
  await expect(toolbar).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const expanded = await toolbar.boundingBox();
  expect(expanded.x).toBeLessThan(circle.x + circle.width / 2);
  expect(expanded.x + expanded.width).toBeGreaterThan(circle.x + circle.width / 2);
  expect(expanded.y).toBeLessThan(circle.y + circle.height / 2);
  expect(expanded.y + expanded.height).toBeGreaterThan(circle.y + circle.height / 2);
  await page.locator('[data-tool="select"]').hover();
  await page.waitForTimeout(300);
  await expect(toolbar).toBeVisible();
  await page.mouse.move(expanded.x + expanded.width / 2, expanded.y + expanded.height + 15);
  await page.waitForTimeout(650);
  await expect(toolbar).toBeVisible();
  await page.mouse.move(1000, 650);
  await page.waitForTimeout(250);
  await expect(toolbar).toBeVisible();
  await page.locator('[data-tool="select"]').hover();
  await page.waitForTimeout(650);
  await expect(toolbar).toBeVisible();
  await page.mouse.move(1000, 650);
  await expect(toolbar).toBeHidden();
  await openPenControls();
  await page.locator('[data-tool="select"]').click();
  await expect(page.locator('[data-tool="select"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#color-wheel-toggle').click();
  await expect(page.locator('#color-picker')).toBeVisible();
  const picker = await page.locator('#color-picker').boundingBox();
  await page.mouse.move(picker.x + picker.width + 15, picker.y + picker.height / 2);
  await page.waitForTimeout(650);
  await expect(page.locator('#color-picker')).toBeVisible();
  await expect(toolbar).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('expanded-palette.png') });
  await page.locator('#color-value').focus();
  await page.mouse.move(1000, 650);
  await page.waitForTimeout(650);
  await expect(toolbar).toBeVisible();
  await page.locator('#overlay').focus();
  await expect(toolbar).toBeHidden();
  await toggle.focus();
  await expect(toolbar).toBeVisible();
});

test('basic shapes support negative drags, ordinary selection and undo, and editable SQLite persistence', async () => {
  let previousCount = 0, beforeLastShape, presetColor;
  for (const [index, shape] of ['line', 'arrow', 'rectangle', 'ellipse', 'triangle'].entries()) {
    await openPenControls();
    await page.locator('#shape-select').selectOption(shape);
    if (shape === 'rectangle') {
      const addedSwatch = page.getByRole('button', { name: 'Purple ink', exact: true });
      presetColor = await addedSwatch.getAttribute('data-color');
      await addedSwatch.click();
    }
    beforeLastShape = (await snapshot()).strokes;
    await drag({ x: 520, y: 250 + index * 65 }, { x: 350, y: 200 + index * 65 });
    await expect.poll(async () => (await snapshot()).strokes.length).toBeGreaterThan(previousCount);
    if (shape === 'rectangle') {
      const rectangle = (await snapshot()).strokes.at(-1);
      expect(rectangle.color).toBe(presetColor);
      expect(rectangle.points.map(({ x, y }) => [x, y])).toEqual([[350, 330], [520, 330], [520, 380], [350, 380], [350, 330]]);
    }
    previousCount = (await snapshot()).strokes.length;
  }
  const allShapes = (await snapshot()).strokes;
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(beforeLastShape);
  await page.keyboard.press(`${modifier}+Shift+z`);
  expect((await snapshot()).strokes).toEqual(allShapes);
  await page.keyboard.press('v');
  await page.keyboard.press(`${modifier}+a`);
  expect((await selection()).length).toBe(allShapes.length);
  await drag({ x: 435, y: 355 }, { x: 485, y: 390 });
  const moved = (await snapshot()).strokes;
  for (let strokeIndex = 0; strokeIndex < allShapes.length; strokeIndex++) {
    expect(moved[strokeIndex].id).toBe(allShapes[strokeIndex].id);
    for (let pointIndex = 0; pointIndex < allShapes[strokeIndex].points.length; pointIndex++) {
      expect(moved[strokeIndex].points[pointIndex].x).toBeCloseTo(allShapes[strokeIndex].points[pointIndex].x + 50, 5);
      expect(moved[strokeIndex].points[pointIndex].y).toBeCloseTo(allShapes[strokeIndex].points[pointIndex].y + 35, 5);
    }
  }
  await closeGracefully();
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(moved);
  await launch();
  expect((await snapshot()).strokes).toEqual(moved);
});

test('the color wheel, brightness and custom hex affect actual ink and persist on restart', async () => {
  await openPenControls();
  await expect(page.locator('[data-color]')).toHaveCount(8);
  const swatches = await page.locator('[data-color]').evaluateAll(buttons => buttons.map(button => ({
    color: button.dataset.color, preview: getComputedStyle(button, '::after').backgroundColor,
  })));
  for (const swatch of swatches) {
    const channels = swatch.color.slice(1).match(/../g).map(channel => parseInt(channel, 16));
    expect(swatch.preview).toBe(`rgb(${channels.join(', ')})`);
  }
  for (const button of await page.locator('[data-color]').all()) {
    await button.click();
    const centers = await button.evaluate(button => {
      const measure = () => {
        const bounds = button.getBoundingClientRect();
        const center = pseudo => {
          const style = getComputedStyle(button, pseudo), transform = new DOMMatrix(style.transform);
          return { x: parseFloat(style.left) + transform.m41 + parseFloat(style.width) / 2,
            y: parseFloat(style.top) + transform.m42 + parseFloat(style.height) / 2 };
        };
        return { disk: center('::after'), ring: center('::before'), button: { x: bounds.width / 2, y: bounds.height / 2 } };
      };
      const normal = measure(), oldPadding = button.style.padding;
      button.style.padding = '7px 2px';
      const padded = measure();
      button.style.padding = oldPadding;
      return [normal, padded];
    });
    for (const center of centers) {
      expect(center.disk.x).toBeCloseTo(center.button.x, 2);
      expect(center.disk.y).toBeCloseTo(center.button.y, 2);
      expect(center.ring.x).toBeCloseTo(center.disk.x, 2);
      expect(center.ring.y).toBeCloseTo(center.disk.y, 2);
    }
  }
  const addedSwatch = page.getByRole('button', { name: 'Orange ink', exact: true });
  const presetColor = await addedSwatch.getAttribute('data-color');
  await addedSwatch.click();
  await draw({ x: 850, y: 240 }, { x: 960, y: 280 });
  expect((await snapshot()).strokes.at(-1).color).toBe(presetColor);
  await openPenControls();
  await page.locator('#color-wheel-toggle').click();
  await expect(page.locator('#color-picker')).toBeVisible();
  const wheel = await page.locator('#color-wheel').boundingBox();
  await page.mouse.click(wheel.x + wheel.width * 0.85, wheel.y + wheel.height / 2);
  const wheelColor = (await snapshot()).settings.color;
  expect(wheelColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(wheelColor).not.toBe(presetColor);
  await page.locator('#color-value').evaluate(input => {
    input.value = '35';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const shadedColor = (await snapshot()).settings.color;
  expect(shadedColor).not.toBe(wheelColor);
  await page.locator('#overlay').focus();
  await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
  expect((await snapshot()).strokes.at(-1).color).toBe(shadedColor);

  await openPenControls();
  if (await page.locator('#color-picker').isHidden()) await page.locator('#color-wheel-toggle').click();
  const wheelEvent = (type, x, y, buttons = 0) => page.evaluate(({ type, x, y, buttons }) => {
    const wheel = document.querySelector('#color-wheel'), bounds = wheel.getBoundingClientRect();
    wheel.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 91, pointerType: 'pen', isPrimary: true,
      clientX: bounds.left + bounds.width * x, clientY: bounds.top + bounds.height * y,
      buttons, button: 0, pressure: buttons ? 0.5 : 0,
    }));
  }, { type, x, y, buttons });
  await wheelEvent('pointerdown', 0.3, 0.3, 1);
  const beforeLostCapture = (await snapshot()).settings.color;
  await wheelEvent('lostpointercapture', 0.3, 0.3);
  await wheelEvent('pointermove', 0.8, 0.7);
  expect((await snapshot()).settings.color).toBe(beforeLostCapture);
  await wheelEvent('pointerup', 0.8, 0.7);
  await wheelEvent('pointerdown', 0.3, 0.7, 1);
  const beforeBlur = (await snapshot()).settings.color;
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#color-picker')).toBeHidden();
  await wheelEvent('pointermove', 0.8, 0.3);
  expect((await snapshot()).settings.color).toBe(beforeBlur);
  await openPenControls();
  await page.locator('#color-wheel-toggle').click();
  await wheelEvent('pointerdown', 0.8, 0.5, 1);
  await wheelEvent('pointerup', 0.8, 0.5);
  expect((await snapshot()).settings.color).not.toBe(beforeBlur);
  const hex = page.getByLabel('Hex color', { exact: true });
  await hex.fill('#8a42cc');
  await hex.press('Enter');
  await page.locator('#overlay').focus();
  await expect.poll(async () => (await snapshot()).settings.color).toBe('#8a42cc');
  await draw({ x: 850, y: 500 }, { x: 960, y: 540 });
  const expected = (await snapshot()).strokes;
  expect(expected).toHaveLength(3);
  expect(expected.at(-1).color).toBe('#8a42cc');
  await closeGracefully();
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(expected);
  await launch();
  expect((await snapshot()).settings.color).toBe('#8a42cc');
  expect((await snapshot()).strokes).toEqual(expected);
});

test('pen types and extra broad width preserve style and give pressure a pronounced visible range', async ({}, testInfo) => {
  for (const [index, penType] of ['pen', 'pencil', 'fountain', 'marker', 'highlighter'].entries()) {
    await openPenControls();
    await page.getByLabel('Pen type', { exact: true }).selectOption(penType);
    await clickPenControl('[data-width="12"]');
    const y = 200 + index * 100;
    await pointer('pointerdown', 300, y, { pressure: 0.1 });
    await pointer('pointermove', 380, y, { pressure: 0.1 });
    await pointer('pointermove', 460, y, { pressure: 0.9 });
    await pointer('pointermove', 540, y, { pressure: 0.9 });
    await pointer('pointerup', 540, y, { pressure: 0, buttons: 0 });
    const stroke = (await snapshot()).strokes.at(-1);
    expect(stroke.penType).toBe(penType);
    expect(stroke.width).toBe(12);
    expect(Math.min(...stroke.points.map(point => point.p))).toBeCloseTo(0.1, 5);
    expect(Math.max(...stroke.points.map(point => point.p))).toBeCloseTo(0.9, 5);
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const thickness = await page.evaluate(() => {
    const canvas = document.querySelector('#canvas'), paint = canvas.getContext('2d');
    const ratio = canvas.width / innerWidth;
    const measure = x => {
      const column = paint.getImageData(Math.round(x * ratio), Math.round(360 * ratio), 1, Math.round(80 * ratio)).data;
      let dark = 0;
      for (let index = 0; index < column.length; index += 4) if (column[index] + column[index + 1] + column[index + 2] < 730) dark++;
      return dark / ratio;
    };
    return { low: measure(320), high: measure(510) };
  });
  expect(thickness.low).toBeGreaterThan(0);
  expect(thickness.high).toBeGreaterThanOrEqual(thickness.low * 3);
  await testInfo.attach('pressure-thickness', { body: JSON.stringify(thickness), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('pen-types-pressure.png') });
  const expected = await snapshot();
  expect(expected.strokes.map(stroke => stroke.penType)).toEqual(['pen', 'pencil', 'fountain', 'marker', 'highlighter']);
  expect(expected.settings.penType).toBe('highlighter');
  expect(expected.settings.width).toBe(12);
  await closeGracefully();
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(expected.strokes);
  await launch();
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  expect((await snapshot()).settings.penType).toBe('highlighter');
  expect((await snapshot()).settings.width).toBe(12);
});

async function relaunchWithPenPlatform(value) {
  await closeGracefully();
  penPlatform = value;
  await launch();
}

test('Windows Ink: barrel plus tip (button 2 with pressure) erases, one undo group, no fake contact', async () => {
  await relaunchWithPenPlatform('win32');
  await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
  await draw({ x: 200, y: 400 }, { x: 400, y: 400 });
  await draw({ x: 200, y: 550 }, { x: 400, y: 550 });
  const original = (await snapshot()).strokes;
  const [first, second, third] = original;

  await pointer('pointerdown', 300, 250, { pressure: 0.5, buttons: 2, button: 2 });
  await expect.poll(async () => (await snapshot()).strokes.map(stroke => stroke.id)).toEqual([second.id, third.id]);
  await pointer('pointermove', 300, 400, { pressure: 0.6, buttons: 2, button: -1 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([third.id]);
  await pointer('pointerup', 300, 400, { pressure: 0, buttons: 0, button: 2 });
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);

  // Pressure appearing after a zero-pressure barrel pointerdown is hover, not contact.
  await pointer('pointerdown', 300, 550, { pressure: 0, buttons: 2, button: 2 });
  await pointer('pointermove', 300, 550, { pressure: 0.5, buttons: 2, button: -1 });
  await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
  expect((await snapshot()).strokes).toEqual(original);

  // Lifting the tip ends the gesture; later pressured moves do not restart it.
  await pointer('pointerdown', 300, 250, { pressure: 0.5, buttons: 2, button: 2 });
  await pointer('pointermove', 300, 250, { pressure: 0, buttons: 2, button: -1 });
  await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 2, button: -1 });
  expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([second.id, third.id]);
  await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
  await page.keyboard.press(`${modifier}+z`);
  expect((await snapshot()).strokes).toEqual(original);

  // Two quick barrel taps are deletions, not an Undo double-click.
  await draw({ x: 600, y: 250 }, { x: 700, y: 250 });
  const withExtra = (await snapshot()).strokes;
  for (let index = 0; index < 2; index++) {
    await pointer('pointerdown', 300, 700, { pressure: 0.5, buttons: 2, button: 2 });
    await pointer('pointerup', 300, 700, { pressure: 0, buttons: 0, button: 2 });
  }
  expect((await snapshot()).strokes).toEqual(withExtra);

  // Barrel pressed mid-stroke does not delete until fresh contact.
  await pointer('pointerdown', 300, 250, { pressure: 0.4, buttons: 1, button: 0 });
  await pointer('pointermove', 300, 260, { pressure: 0.6, buttons: 3, button: 2 });
  await pointer('pointermove', 300, 400, { pressure: 0.6, buttons: 2, button: -1 });
  await pointer('pointerup', 300, 400, { pressure: 0, buttons: 0, button: 2 });
  expect((await snapshot()).strokes.filter(stroke => [first.id, second.id, third.id].includes(stroke.id))).toEqual(original);
  await expect(page.locator('#context-menu')).toBeHidden();
});

test('Windows: hover barrel clicks arriving as mouse input double-click to undo; single click opens no menu', async () => {
  await relaunchWithPenPlatform('win32');
  await draw();
  expect((await snapshot()).strokes).toHaveLength(1);
  const hoverClicks = count => page.evaluate(async count => {
    const overlay = document.querySelector('#overlay');
    const fire = (type, init) => overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 600, clientY: 400, ...init }));
    fire('pointermove', { pointerId: 44, pointerType: 'pen', buttons: 0, pressure: 0 });
    for (let index = 0; index < count; index++) {
      fire('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2 });
      fire('pointerup', { pointerId: 1, pointerType: 'mouse', button: 2, buttons: 0 });
      overlay.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }, count);
  await hoverClicks(1);
  expect((await snapshot()).strokes).toHaveLength(1);
  await expect(page.locator('#context-menu')).toBeHidden();
  await page.waitForTimeout(500);
  await hoverClicks(2);
  await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
  await expect(page.locator('#context-menu')).toBeHidden();
});

test('Windows shutdown, restart or log-off holds the session until the final save completes', async () => {
  test.skip(process.platform !== 'win32', 'query-session-end is a Windows-only event');
  await draw({ x: 220, y: 250 }, { x: 430, y: 300 });
  const expected = (await snapshot()).strokes;
  expect(expected).toHaveLength(1);
  const exited = new Promise(resolveExit => app.process().once('exit', resolveExit));
  const prevented = await app.evaluate(({ BrowserWindow }) => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    BrowserWindow.getAllWindows()[0].emit('query-session-end', event, ['logoff']);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('App did not save and quit')), 10_000))]);
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(expected);
  expect((await readdir(dataDir)).some(name => /backup/i.test(name))).toBe(true);
});

test.describe('Windows .sm launch arguments', () => {
  test.skip(process.platform !== 'win32', 'argv .sm opening is wired only on Windows');
  let sourceDir;
  test.afterEach(async () => { if (sourceDir) await rm(sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); sourceDir = null; });

  // Writes a two-stroke scroll, exports it to a temp .sm outside the data dir, then returns its path and strokes.
  async function makeSource() {
    await draw({ x: 220, y: 250 }, { x: 430, y: 300 });
    await draw({ x: 220, y: 400 }, { x: 430, y: 450 });
    const strokes = (await snapshot()).strokes;
    expect(strokes).toHaveLength(2);
    await showSidebar();
    await page.locator('#export-sm').click();
    sourceDir = await mkdtemp(resolve(tmpdir(), 'scrollmind-src-'));
    const file = resolve(sourceDir, 'Opened From Explorer.SM');
    await copyFile(await exportedPath('sm'), file);
    return { file, strokes, bytes: await readFile(file) };
  }

  test('cold start with a .sm path in argv opens it as a new working-copy scroll and leaves the source untouched', async () => {
    const source = await makeSource();
    await closeGracefully();
    // A fresh data directory starts with one empty scroll, so two strokes can only come from the argv file.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    dataDir = await mkdtemp(resolve(tmpdir(), 'scrollmind-ui-'));
    extraArgs = [source.file];
    await launch();
    await expect.poll(async () => (await snapshot()).strokes.length).toBe(2);
    const state = await workspace();
    expect(state.scrolls.filter(scroll => scroll.open)).toHaveLength(2);
    expect(state.scrolls.find(scroll => scroll.active).name).not.toBe('Scroll 1');
    expect((await snapshot()).strokes).toEqual(source.strokes);
    await draw({ x: 600, y: 300 }, { x: 700, y: 340 });
    expect((await snapshot()).strokes).toHaveLength(3);
    await closeGracefully();
    expect(await readFile(source.file)).toEqual(source.bytes);
  });

  // A true second Electron instance cannot be launched here (tests skip the single-instance lock), so the
  // same handler is driven by emitting the app 'second-instance' event with an argv and working directory.
  test('second-instance with a .sm argv opens it as a new scroll, resolves relative paths and ignores argv without one', async () => {
    const source = await makeSource();
    const originalId = (await workspace()).activeId;
    await showSidebar(false);
    await app.evaluate(({ app }) => { app.emit('second-instance', {}, ['ScrollMind.exe', '--flag'], process.cwd()); });
    await page.waitForTimeout(500);
    expect((await workspace()).activeId).toBe(originalId);

    await app.evaluate(({ app }, [file, directory]) => { app.emit('second-instance', {}, ['ScrollMind.exe', file], directory); }, [basename(source.file), sourceDir]);
    await expect.poll(async () => (await workspace()).activeId).not.toBe(originalId);
    expect((await snapshot()).strokes).toEqual(source.strokes);
    expect((await workspace()).scrolls.filter(scroll => scroll.open)).toHaveLength(2);
    expect(await readFile(source.file)).toEqual(source.bytes);
  });

  test('help dialog shows Windows wording and no Mac symbols', async () => {
    await page.keyboard.press('F1');
    const help = page.locator('#help');
    await expect(help).toBeVisible();
    const text = await help.innerText();
    expect(text).not.toMatch(/[⌘⇧⌥]/);
    expect(text).toContain('Windows Ink');
    expect(text).toContain('Click & Tap');
    expect(text).toContain('Right Click');
    expect(text).toContain('Hover Click');
    expect(text).toContain('Ctrl+Y');
    expect(text).toContain('Ctrl+Shift+F or F11');
    expect(text).toContain('Alt+F4');
    expect(text).toContain('Ctrl+Z');
    expect(await page.locator('#version').innerText()).toMatch(/^ScrollMind \d+\.\d+\.\d+$/);
  });
});

test('macOS help dialog keeps its Mac wording', async () => {
  test.skip(process.platform !== 'darwin', 'macOS only');
  await page.keyboard.press('F1');
  const text = await page.locator('#help').innerText();
  expect(text).toContain('⌘ Z');
  expect(text).toContain('Right click → hold + touch or drag to delete');
  expect(text).not.toContain('Windows Ink');
});

test('Highlighter is uniform within a stroke, stacks separate passes, preserves writing and exports its style', async ({}, testInfo) => {
  await showSidebar();
  await page.locator('#paper-tone').selectOption('white');
  await page.locator('#paper-pattern').selectOption('plain');
  await showSidebar(false);
  await clickPenControl('[data-color="#171717"]');
  await clickPenControl('[data-width="3"]');
  await draw({ x: 320, y: 400 }, { x: 650, y: 400 });
  const writing = (await snapshot()).strokes[0];

  await openPenControls();
  await page.getByLabel('Pen type', { exact: true }).selectOption('highlighter');
  expect((await snapshot()).settings.color).toBe('#e2b52b');
  expect((await snapshot()).settings.width).toBe(12);
  await pointer('pointerdown', 300, 300, { pressure: 0.6 });
  await pointer('pointermove', 500, 300, { pressure: 0.6 });
  await pointer('pointermove', 400, 220, { pressure: 0.6 });
  await pointer('pointermove', 400, 460, { pressure: 0.6 });
  await pointer('pointerup', 400, 460, { pressure: 0, buttons: 0 });
  const sampleColors = points => page.evaluate(async points => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = document.querySelector('#canvas'), paint = canvas.getContext('2d'), ratio = canvas.width / innerWidth;
    return points.map(({ x, y }) => [...paint.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data].slice(0, 3));
  }, points);
  const [single, selfCrossing, overWriting] = await sampleColors([{ x: 350, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 400 }]);
  for (let channel = 0; channel < 3; channel++) expect(Math.abs(single[channel] - selfCrossing[channel])).toBeLessThanOrEqual(2);
  expect(single[2]).toBeGreaterThan(100);
  expect(single.reduce((sum, channel) => sum + channel, 0)).toBeLessThan(755);
  expect(overWriting.reduce((sum, channel) => sum + channel, 0)).toBeLessThan(single.reduce((sum, channel) => sum + channel, 0) * 0.6);

  await pointer('pointerdown', 340, 340, { pressure: 0.6 });
  await pointer('pointermove', 480, 340, { pressure: 0.6 });
  await pointer('pointerup', 480, 340, { pressure: 0, buttons: 0 });
  const [doublePass, onePass] = await sampleColors([{ x: 400, y: 340 }, { x: 400, y: 365 }]);
  expect(doublePass.reduce((sum, channel) => sum + channel, 0)).toBeLessThan(onePass.reduce((sum, channel) => sum + channel, 0) - 10);
  expect((await snapshot()).strokes[0]).toEqual(writing);
  expect((await snapshot()).strokes.slice(1).every(stroke => stroke.penType === 'highlighter')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('highlighter-opacity.png') });

  await openPenControls();
  await page.getByLabel('Pen type', { exact: true }).selectOption('pen');
  expect((await snapshot()).settings.color).toBe('#171717');
  expect((await snapshot()).settings.width).toBe(3);
  const expected = await snapshot();
  await showSidebar();
  await page.locator('#export-sm').click();
  expect(readNativeScroll(await exportedPath('sm')).strokes).toEqual(expected.strokes);
  await page.locator('#export-svg').click();
  const svg = await readFile(await exportedPath('svg'), 'utf8');
  expect(svg).toContain('data-pen-type="highlighter"');
  await page.locator('#export-pdf').click();
  expect((await readFile(await exportedPath('pdf'))).subarray(0, 5).toString()).toBe('%PDF-');
  await closeGracefully();
  await launch();
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  expect((await snapshot()).settings.penType).toBe('pen');
  expect((await snapshot()).settings.color).toBe('#171717');
  expect((await snapshot()).settings.width).toBe(3);
});

test('mouse selects by default, pen needs Select to move, and middle double-click redoes', async () => {
	await drag({ x: 380, y: 240 }, { x: 480, y: 240 });
	expect((await snapshot()).strokes).toHaveLength(0);
	await pointer('pointerdown', 400, 300);
	await pointer('pointermove', 510, 300, { button: -1 });
	await pointer('pointerup', 510, 300, { pressure: 0, buttons: 0 });
	const original = (await snapshot()).strokes[0];
	await drag({ x: 456, y: 300 }, { x: 456, y: 360 });
	expect((await snapshot()).strokes[0].points[0].y).toBe(original.points[0].y + 60);

	await clickPenControl('[data-tool="select"]');
	await pointer('pointerdown', 456, 360);
	await pointer('pointermove', 456, 380, { button: -1 });
	await pointer('pointerup', 456, 380, { pressure: 0, buttons: 0 });
	const moved = (await snapshot()).strokes[0];
	expect(moved.points[0].y).toBe(original.points[0].y + 80);
	await page.keyboard.press(`${modifier}+z`);
	await page.mouse.click(800, 420, { button: 'middle' });
	expect((await snapshot()).strokes[0].points[0].y).toBe(original.points[0].y + 60);
	await page.mouse.click(800, 420, { button: 'middle' });
	expect((await snapshot()).strokes[0]).toEqual(moved);

	await page.keyboard.press(`${modifier}+z`);
	await page.mouse.move(800, 420);
	await page.mouse.down({ button: 'middle' });
	await page.mouse.move(800, 470);
	await page.mouse.move(800, 420);
	await page.mouse.up({ button: 'middle' });
	await page.mouse.click(800, 420, { button: 'middle' });
	expect((await snapshot()).strokes[0]).not.toEqual(moved);
	await page.mouse.click(800, 420, { button: 'middle' });
	expect((await snapshot()).strokes[0]).toEqual(moved);

	await draw({ x: 560, y: 490 }, { x: 660, y: 490 });
	expect((await snapshot()).strokes).toHaveLength(2);
});

test('grid controls, page growth, diagram editing and native persistence work together', async () => {
	await showSidebar();
	await page.locator('#paper-tone').selectOption('parchment');
	await page.locator('#grid-mode').click();
	await expect(page.locator('#scroll-navigation')).toBeHidden();
	await expect(page.locator('#grid-settings')).toBeVisible();
	await expect(page.locator('#paper-tone')).toHaveValue('night');
	await expect(page.locator('#sidebar h1')).toHaveCSS('color', 'rgb(237, 242, 247)');
	await expect(page.locator('#clear-scroll')).toHaveCSS('color', 'rgb(255, 174, 167)');
	for (const [selector, value] of [['#cell-rows', '12'], ['#cell-columns', '15'], ['#block-rows', '2'], ['#block-columns', '2']]) {
		await page.locator(selector).fill(value);
		await page.locator(selector).press('Tab');
	}
	expect((await snapshot()).settings.grid.cellColumns).toBe(15);
	await showSidebar(false);
	const pixel = (x, y) => page.evaluate(([x, y]) => {
		const context = document.querySelector('#canvas').getContext('2d');
		return [...context.getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1).data];
	}, [x, y]);
	const pageSize = gridPage((await snapshot()).settings.grid);
	const { x, y } = await page.evaluate(size => ({ x: (innerWidth - size.width) / 2, y: (innerHeight - size.height) / 2 }), pageSize);
	const outside = [23, 44, 64, 255], inside = [27, 51, 73, 255];
	await expect.poll(() => Promise.all([
		pixel(x - 6, y + 6), pixel(x + 6, y - 6), pixel(x + 6, y + 6),
		pixel(x + pageSize.width + 6, y + 6), pixel(x + 6, y + pageSize.height + 6),
	])).toEqual([outside, outside, inside, outside, outside]);
	await page.locator('#overlay').dispatchEvent('wheel', { deltaX: x, deltaY: y });
	expect((await snapshot()).view).toMatchObject({ gridX: 0, gridY: 0 });
	await expect.poll(() => pixel(881, 561)).toEqual(outside);
	await clickPenControl('#diagram-shape');
	await drag({ x: 320, y: 245 }, { x: 450, y: 335 });

	await openPenControls();
	await page.locator('#diagram-shape-select').selectOption('cylinder');
	await drag({ x: 815, y: 390 }, { x: 930, y: 475 });
	await expect.poll(() => pixel(881, 561)).toEqual(inside);
	await expect.poll(async () => (await snapshot()).diagram.nodes.map(node => node.kind)).toEqual(['rectangle', 'cylinder']);

	await clickPenControl('#diagram-shape');
	await page.mouse.click(630, 530);
	expect((await snapshot()).diagram.nodes.map(node => node.kind)).toEqual(['rectangle', 'cylinder', 'cylinder']);

	await page.mouse.click(390, 286);
	await drag({ x: 466, y: 290 }, { x: 870, y: 432 });
	const link = (await snapshot()).diagram.connections[0];
	expect(link).toMatchObject({ port: 1 });
	await drag({ x: 860, y: 430 }, { x: 880, y: 490 });
	const shifted = (await snapshot()).diagram.nodes[1];
	expect(shifted).toMatchObject({ x: 835, y: 450 });
	await drag({ x: 950, y: 535 }, { x: 975, y: 550 });
	expect((await snapshot()).diagram.nodes[1]).toMatchObject({ width: 140, height: 100 });
	expect((await snapshot()).diagram.connections[0]).toEqual(link);
	await page.keyboard.press('Delete');
	expect((await snapshot()).diagram.connections).toHaveLength(0);
	await page.keyboard.press(`${modifier}+z`);
	expect((await snapshot()).diagram.connections[0]).toEqual(link);

	await showSidebar();
	await page.locator('#scroll-mode').click();
	await expect(page.locator('#paper-tone')).toHaveValue('parchment');
	await expect(page.locator('#scroll-navigation')).toBeVisible();
	await page.locator('#grid-mode').click();
	await showSidebar(false);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowDown');
	const expected = await snapshot();
	expect(expected.view).toMatchObject({ gridX: 48, gridY: 48 });
	await showSidebar();
	await page.locator('#export-sm').click();
	expect(readNativeScroll(await exportedPath('sm'))).toEqual(expected);
	await closeGracefully();
	await launch();
	expect(await snapshot()).toEqual(expected);
	await page.keyboard.press('Home');
	await expect.poll(async () => (await snapshot()).view).toMatchObject({ gridX: -x, gridY: -y });
	await openPenControls();
	await expect(page.locator('#diagram-shape')).toHaveText('Cylinder');
});

test('Grid accepts pen ink, mixed Wacom barrel erasing, and mixed barrel clicks that arm zoom', async () => {
	await showSidebar();
	await page.locator('#grid-mode').click();
	await expect(page.locator('#sidebar-heading')).toHaveText('Grids');
	await expect(page.locator('#export-sm')).toHaveText('ScrollMind Grid (.sm)');
	await showSidebar(false);
	await pointer('pointermove', 500, 400, { pressure: 0, buttons: 0, button: -1 });
	await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
	await pointer('pointerdown', 500, 400);
	await pointer('pointermove', 550, 400, { button: -1 });
	await pointer('pointerup', 550, 400, { pressure: 0, buttons: 0 });
	const initial = (await snapshot()).strokes;
	expect(initial).toHaveLength(1);

	const mouse = (type, buttons, button, x, y) => page.evaluate(({ type, buttons, button, x, y }) => {
		document.querySelector('#overlay').dispatchEvent(new PointerEvent(type, {
			// Not Chromium's own mouse id (1): its synthesized pointerenter would release this held barrel button.
			bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, buttons, button,
		}));
	}, { type, buttons, button, x, y });
	await pointer('pointermove', 510, 400, { pressure: 0, buttons: 0, button: -1 });
	await mouse('pointerdown', 2, 2, 510, 400);
	expect((await snapshot()).strokes).toEqual(initial);
	await pointer('pointermove', 510, 400, { pressure: .38, buttons: 0, button: 0 });
	expect((await snapshot()).strokes).toHaveLength(0);
	await pointer('pointermove', 510, 400, { pressure: 0, buttons: 0, button: 0 });
	await mouse('pointerup', 0, 2, 510, 400);
	await page.keyboard.press(`${modifier}+z`);
	expect((await snapshot()).strokes).toEqual(initial);

	await clickPenControl('#diagram-shape');
	await pointer('pointerdown', 575, 435);
	await pointer('pointermove', 725, 555, { button: -1 });
	await pointer('pointerup', 725, 555, { pressure: 0, buttons: 0 });
	const shape = (await snapshot()).diagram.nodes[0];
	await pointer('pointermove', 640, 495, { pressure: 0, buttons: 0, button: -1 });
	await mouse('pointerdown', 2, 2, 640, 495);
	await mouse('pointerup', 0, 2, 640, 495);
	await pointer('pointerdown', 640, 495, { pressure: 0, buttons: 4, button: 1 });
	await pointer('pointerup', 640, 495, { pressure: 0, buttons: 0, button: 1 });
	// Lower then upper arms tap-and-drag zoom, not a move: the shape stays where it is.
	await expect(page.locator('#overlay')).toHaveCSS('cursor', 'zoom-in');
	await pointer('pointerdown', 640, 495);
	await pointer('pointermove', 640, 460, { button: -1 });
	await pointer('pointermove', 640, 425, { button: -1 });
	await pointer('pointerup', 640, 425, { pressure: 0, buttons: 0 });
	expect((await snapshot()).diagram.nodes[0]).toEqual(shape);
	expect((await snapshot()).view.gridZoom).toBeGreaterThan(1);
	expect((await snapshot()).strokes).toEqual(initial);

	await showSidebar();
	await page.locator('#scroll-mode').click();
	await expect(page.locator('#scroll-mode')).toHaveAttribute('aria-pressed', 'true');
	expect((await snapshot()).strokes).toHaveLength(0);
	expect((await snapshot()).diagram).toBeUndefined();
	await page.locator('#grid-mode').click();
	await expect(page.locator('#grid-mode')).toHaveAttribute('aria-pressed', 'true');
	expect((await snapshot()).strokes).toEqual(initial);

	await page.locator('#zoom-reset').click();
	await expect(page.locator('#zoom-reset')).toHaveText('100%');
	await page.locator('#zoom-in').click();
	await expect(page.locator('#zoom-reset')).toHaveText('125%');
	await page.locator('#zoom-reset').click();
	await expect(page.locator('#zoom-reset')).toHaveText('100%');
	await showSidebar(false);
	await page.locator('#overlay').dispatchEvent('wheel', { ctrlKey: true, deltaY: -80, clientX: 500, clientY: 400 });
	expect((await snapshot()).view.gridZoom).toBeGreaterThan(1);
});

test('macOS Edit menu places working Redo immediately after Undo', async () => {
	test.skip(process.platform !== 'darwin');
	await draw({ x: 400, y: 300 }, { x: 520, y: 300 });
	const strokes = (await snapshot()).strokes;
	const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === 'Edit').submenu.items.map(item => item.label));
	expect(labels.slice(0, 2)).toEqual(['Undo', 'Redo']);
	for (const [label, expected] of [['Undo', []], ['Redo', strokes]]) {
		await app.evaluate(({ Menu }, label) => {
			Menu.getApplicationMenu().items.find(item => item.label === 'Edit').submenu.items.find(item => item.label === label).click();
		}, label);
		await expect.poll(async () => (await snapshot()).strokes).toEqual(expected);
	}
});

test('the pen bar edits and restores named palettes per document', async () => {
	await openPenControls();
	await page.locator('#color-wheel-toggle').click();
	await page.locator('#palette-slot').selectOption('2');
	const hex = page.getByLabel('Hex color', { exact: true });
	await hex.fill('#2a917b');
	await hex.press('Tab');
	await page.locator('#palette-name').fill('Shallows');
	await page.locator('#palette-save').click();
	expect((await snapshot()).settings.palette[2]).toEqual({ name: 'Shallows', color: '#2a917b' });
	await expect(page.getByRole('button', { name: 'Shallows ink', exact: true })).toHaveAttribute('data-color', '#2a917b');
	await showSidebar();
	await page.locator('#grid-mode').click();
	await expect(page.locator('#grid-mode')).toHaveAttribute('aria-pressed', 'true');
	expect((await snapshot()).settings.palette).toBeUndefined();
	await page.locator('#scroll-mode').click();
	await expect(page.locator('#scroll-mode')).toHaveAttribute('aria-pressed', 'true');
	expect((await snapshot()).settings.palette[2]).toEqual({ name: 'Shallows', color: '#2a917b' });
	await showSidebar(false);
	await openPenControls();
	if (await page.locator('#color-picker').isHidden()) await page.locator('#color-wheel-toggle').click();
	await page.locator('#palette-reset').click();
	expect((await snapshot()).settings.palette).toBeUndefined();
	await expect(page.getByRole('button', { name: 'Blue ink', exact: true })).toHaveAttribute('data-color', '#215b9c');
});

test('Check for Updates reaches the feed from the main process while pages stay offline', async () => {
	test.skip(process.platform !== 'darwin', 'The app menu with Check for Updates is macOS only');
	const requests = [];
	const feed = feedYaml({ version: '9.9.9', file: 'ScrollMind-9.9.9-arm64-signed.zip', sha512: `${'A'.repeat(86)}==`, size: 1, releaseDate: '2026-11-19T00:00:00.000Z' });
	const server = createServer((request, response) => { requests.push(request.url); response.setHeader('content-type', 'text/yaml'); response.end(feed); });
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const origin = `http://127.0.0.1:${server.address().port}`;
	process.env.SCROLLMIND_UPDATE_FEED = origin;
	try {
		await closeGracefully();
		await launch();
		await app.evaluate(({ dialog }) => {
			globalThis.shownDialogs = [];
			dialog.showMessageBox = async (...args) => { globalThis.shownDialogs.push(args.at(-1)); return { response: 1 }; };
		});
		await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Check for Updates…').click());
		await expect.poll(() => app.evaluate(() => globalThis.shownDialogs.length)).toBe(1);
		const [offer] = await app.evaluate(() => globalThis.shownDialogs);
		expect(offer.message).toBe('ScrollMind 9.9.9 is available');
		expect(offer.buttons).toEqual(['Download', 'Later']);
		expect(requests.map(url => url.split('?')[0])).toEqual(['/latest-mac.yml']);

		const pageFetch = await page.evaluate(async address => fetch(`${address}/page-request`).then(() => 'reached', () => 'blocked'), origin);
		expect(pageFetch).toBe('blocked');
		expect(requests.some(url => url.startsWith('/page-request'))).toBe(false);
	} finally {
		delete process.env.SCROLLMIND_UPDATE_FEED;
		await new Promise(resolveClose => server.close(resolveClose));
	}
});

// The pen-button contract (docs/CONTROLS.md, Wacom buttons). It must hold in Scroll and Grid mode; do not weaken these tests.
//   Lower button: hold and tap or drag to erase; double tap while hovering undoes.
//   Upper button: hold and drag to scroll; double tap while hovering redoes.
//   Lower tap then upper tap quickly: the next tap-and-drag zooms, then the pen is normal again.
for (const mode of ['scroll', 'grid']) {
	test.describe(`Pen button contract: ${mode}`, () => {
		test.beforeEach(async () => {
			if (mode !== 'grid') return;
			await showSidebar();
			await page.locator('#grid-mode').click();
			await expect(page.locator('#sidebar-heading')).toHaveText('Grids');
			await showSidebar(false);
		});
		const strokes = async () => (await snapshot()).strokes;
		const ids = async () => (await strokes()).map(stroke => stroke.id);
		const hoverClick = async (buttons, button, x = 750, y = 400) => {
			await pointer('pointerdown', x, y, { pressure: 0, buttons, button });
			await pointer('pointerup', x, y, { pressure: 0, buttons: 0, button });
		};
		const lowerClick = () => hoverClick(2, 2);
		const upperClick = () => hoverClick(4, 1);
		const origin = async () => {
			const { view, settings } = await snapshot();
			if (mode === 'scroll') return { x: view.scrollX ?? 0, y: view.offsetY ?? 0 };
			const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
			const centered = gridStartView(settings.grid, size.width, size.height);
			return { x: view.gridX ?? centered.x, y: view.gridY ?? centered.y };
		};
		const zoom = async () => { const { view } = await snapshot(); return (mode === 'grid' ? view.gridZoom : view.scrollZoom) ?? 1; };
		const ink = async (x, y) => {
			await pointer('pointerdown', x, y);
			await pointer('pointermove', x + 60, y + 20, { button: -1 });
			await pointer('pointerup', x + 60, y + 20, { pressure: 0, buttons: 0 });
		};
		const armZoom = async () => { await lowerClick(); await upperClick(); await expect(page.locator('#overlay')).toHaveCSS('cursor', 'zoom-in'); };
		const dragTip = async (x, y, toY) => {
			await pointer('pointerdown', x, y);
			await pointer('pointermove', x, (y + toY) / 2, { button: -1 });
			await pointer('pointermove', x, toY, { button: -1 });
			await pointer('pointerup', x, toY, { pressure: 0, buttons: 0 });
		};

		test('lower button: hold and tap erases that stroke, hold and drag erases what it crosses, each erase undoes alone', async () => {
			await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
			await draw({ x: 200, y: 400 }, { x: 400, y: 400 });
			await draw({ x: 200, y: 550 }, { x: 400, y: 550 });
			const [first, second, third] = await strokes();
			await pointer('pointerdown', 300, 250, { pressure: 0, buttons: 2, button: 2 });
			expect(await ids()).toEqual([first.id, second.id, third.id]);
			await pointer('pointermove', 300, 250, { pressure: 0.6, buttons: 3, button: 0 });
			await expect.poll(ids).toEqual([second.id, third.id]);
			await pointer('pointermove', 300, 250, { pressure: 0, buttons: 2, button: 0 });
			await pointer('pointermove', 300, 400, { pressure: 0.6, buttons: 3, button: 0 });
			await pointer('pointermove', 300, 550, { pressure: 0.6, buttons: 3, button: -1 });
			await expect.poll(ids).toEqual([]);
			await pointer('pointermove', 300, 550, { pressure: 0, buttons: 2, button: 0 });
			await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
			await page.keyboard.press(`${modifier}+z`);
			expect(await ids()).toEqual([second.id, third.id]);
			await page.keyboard.press(`${modifier}+z`);
			expect(await ids()).toEqual([first.id, second.id, third.id]);
		});

		test('lower button: a single tap does nothing and a double tap while hovering undoes', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await lowerClick();
			expect(await strokes()).toEqual(written);
			await lowerClick();
			await expect.poll(async () => (await strokes()).length).toBe(0);
		});

		test('upper button: hold and drag scrolls whether the tip hovers or touches, and a single tap does nothing', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const start = await origin();
			await upperClick();
			expect(await strokes()).toEqual(written);
			expect(await origin()).toEqual(start);

			await pointer('pointerdown', 750, 500, { pressure: 0, buttons: 4, button: 1 });
			await pointer('pointermove', 690, 420, { pressure: 0, buttons: 4, button: -1 });
			await pointer('pointerup', 690, 420, { pressure: 0, buttons: 0, button: 1 });
			const moved = await origin();
			expect(moved).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 80 });

			await pointer('pointerdown', 750, 500, { pressure: 0, buttons: 4, button: 1 });
			await pointer('pointermove', 750, 500, { pressure: 0.6, buttons: 5, button: 0 });
			await pointer('pointermove', 690, 440, { pressure: 0.6, buttons: 5, button: -1 });
			await pointer('pointermove', 690, 440, { pressure: 0, buttons: 4, button: 0 });
			await pointer('pointerup', 690, 440, { pressure: 0, buttons: 0, button: 1 });
			expect(await origin()).toEqual({ x: moved.x + (mode === 'grid' ? 60 : 0), y: moved.y + 60 });
			expect(await strokes()).toEqual(written);
		});

		test('upper button: a single tap does nothing and a double tap while hovering redoes', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await page.keyboard.press(`${modifier}+z`);
			expect(await strokes()).toEqual([]);
			await upperClick();
			expect(await strokes()).toEqual([]);
			await upperClick();
			await expect.poll(strokes).toEqual(written);
		});

		test('lower then upper tapped quickly arms tap-and-drag zoom for the next contact only', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const before = { origin: await origin(), zoom: await zoom() };
			const worldAt = (state, x, y) => ({ x: state.origin.x + x / state.zoom, y: state.origin.y + y / state.zoom });
			await armZoom();
			await dragTip(640, 540, 400);
			expect(await strokes()).toEqual(written);
			const zoomedIn = { origin: await origin(), zoom: await zoom() };
			expect(zoomedIn.zoom).toBeCloseTo(before.zoom * 2, 1);
			expect(worldAt(zoomedIn, 640, 540).x).toBeCloseTo(worldAt(before, 640, 540).x, 1);
			expect(worldAt(zoomedIn, 640, 540).y).toBeCloseTo(worldAt(before, 640, 540).y, 1);
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');

			await ink(700, 600);
			expect(await strokes()).toHaveLength(2);
			expect(await zoom()).toBeCloseTo(zoomedIn.zoom, 5);

			await armZoom();
			await dragTip(640, 400, 540);
			expect(await zoom()).toBeCloseTo(before.zoom, 1);
			expect(await strokes()).toHaveLength(2);
		});

		// The Wacom One 12 reports its side switches itself, so these work however the driver assigns them (the upper one is often
		// Pan/Scroll, which no page ever sees as a button). The display's reports go to the page the way the helper's do; they are
		// injected inside the page so a press lasts exactly as long as the test says, whatever the test runner's latency.
		const native = state => page.evaluate(value => window.scrollmindDebug.nativePen(value), state);
		const nativeClick = key => page.evaluate(async name => {
			window.scrollmindDebug.nativePen({ [name]: true, range: true });
			await new Promise(resolve => setTimeout(resolve, 60));
			window.scrollmindDebug.nativePen({ range: true });
		}, key);
		const armNativeZoom = async () => { await nativeClick('lower'); await nativeClick('upper'); await expect(page.locator('#overlay')).toHaveCSS('cursor', 'zoom-in'); };

		test('display buttons: reports from the display reach the page through the main process', async () => {
			await app.evaluate((_electron, value) => globalThis.scrollmindNativePen(value), { upper: true, range: true });
			await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getNativeButtons())).toEqual({ lower: false, upper: true });
			await app.evaluate((_electron, value) => globalThis.scrollmindNativePen(value), { lower: true, range: true });
			await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getNativeButtons())).toEqual({ lower: true, upper: false });
			await app.evaluate((_electron, value) => globalThis.scrollmindNativePen(value), { range: true });
			await expect.poll(() => page.evaluate(() => window.scrollmindDebug.getNativeButtons())).toEqual({ lower: false, upper: false });
		});

		test('display buttons: an upper switch the driver hides still redoes on a double tap and does nothing on one', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await page.keyboard.press(`${modifier}+z`);
			expect(await strokes()).toEqual([]);
			await nativeClick('upper');
			expect(await strokes()).toEqual([]);
			await nativeClick('upper');
			await expect.poll(strokes).toEqual(written);
		});

		test('display buttons: a lower switch the driver hides still undoes on a double tap and does nothing on one', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await nativeClick('lower');
			expect(await strokes()).toEqual(written);
			await nativeClick('lower');
			await expect.poll(async () => (await strokes()).length).toBe(0);
		});

		test('display buttons: the same switch reported by the display and by the driver counts once', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			await draw({ x: 380, y: 450 }, { x: 480, y: 490 });
			const echoed = () => page.evaluate(async () => {
				const overlay = document.querySelector('#overlay');
				const fire = (type, init) => overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 44, pointerType: 'pen', isPrimary: true, clientX: 750, clientY: 400, pressure: 0, ...init }));
				const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
				window.scrollmindDebug.nativePen({ lower: true, range: true });
				fire('pointerdown', { buttons: 2, button: 2 });
				await wait(50);
				fire('pointerup', { buttons: 0, button: 2 });
				window.scrollmindDebug.nativePen({ range: true });
			});
			await pointer('pointermove', 750, 400, { pressure: 0, buttons: 0, button: -1 });
			await echoed();
			await echoed();
			await expect.poll(async () => (await strokes()).length).toBe(1);
			await page.waitForTimeout(600);
			expect(await strokes()).toHaveLength(1);
		});

		test('display buttons: lower then upper, quickly, arms zoom for the next contact, and up zooms in', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const before = await zoom();
			await armNativeZoom();
			await dragTip(640, 540, 400);
			expect(await strokes()).toEqual(written);
			expect(await zoom()).toBeCloseTo(before * 2, 1);
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
			await ink(700, 600);
			expect(await strokes()).toHaveLength(2);
		});

		test('display buttons: hold delete deletes nothing until the tip touches, then every tap or drag deletes while it stays held', async () => {
			await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
			await draw({ x: 200, y: 400 }, { x: 400, y: 400 });
			await draw({ x: 200, y: 550 }, { x: 400, y: 550 });
			const [first, second, third] = await strokes();
			const touch = (x, y, p = 0.6) => pointer('pointermove', x, y, { pressure: p, buttons: 0, button: -1 });
			const hoverTo = (x, y) => pointer('pointermove', x, y, { pressure: 0, buttons: 0, button: -1 });
			await hoverTo(300, 150);
			await native({ lower: true, range: true });
			// Holding the button and moving the pen across all the ink deletes nothing.
			for (const y of [250, 330, 400, 480, 550]) await hoverTo(300, y);
			expect((await strokes()).map(stroke => stroke.id)).toEqual([first.id, second.id, third.id]);
			// The tip touches (the driver gives the page pressure but no tip bit): that tap deletes what is under it, and only that.
			await hoverTo(300, 250);
			await native({ lower: true, tip: true, range: true });
			await touch(300, 250);
			await expect.poll(async () => (await strokes()).map(stroke => stroke.id)).toEqual([second.id, third.id]);
			await native({ lower: true, range: true });
			await hoverTo(300, 250);
			// Lifted, still holding: moving over the rest deletes nothing.
			for (const y of [330, 400]) await hoverTo(300, y);
			expect((await strokes()).map(stroke => stroke.id)).toEqual([second.id, third.id]);
			// Touch again and drag across both remaining strokes: they go, as one undo.
			await native({ lower: true, tip: true, range: true });
			await touch(300, 400);
			await touch(300, 480);
			await touch(300, 550);
			await expect.poll(async () => (await strokes()).length).toBe(0);
			await native({ lower: true, range: true });
			await hoverTo(300, 550);
			await native({ range: true });
			await page.keyboard.press(`${modifier}+z`);
			expect((await strokes()).map(stroke => stroke.id)).toEqual([second.id, third.id]);
			// Released: touching deletes nothing and writes.
			await page.keyboard.press(`${modifier}+z`);
			expect((await strokes()).map(stroke => stroke.id)).toEqual([first.id, second.id, third.id]);
		});

		test('display buttons: a slow double press that nudges the pen under the thumb still counts as a double tap', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await page.keyboard.press(`${modifier}+z`);
			expect(await strokes()).toEqual([]);
			await page.evaluate(async () => {
				const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
				const overlay = document.querySelector('#overlay');
				const move = (x, y) => overlay.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 44, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0, buttons: 0, button: -1 }));
				move(500, 400);
				for (let press = 0; press < 2; press++) {
					window.scrollmindDebug.nativePen({ upper: true, range: true });
					await wait(300);
					move(509, 406);
					await wait(100);
					window.scrollmindDebug.nativePen({ range: true });
					move(500, 400);
					await wait(250);
				}
			});
			await expect.poll(strokes).toEqual(written);
		});

		test('display buttons: a lower tap after a long still hover opens no context menu, but a mouse right click away from the pen does', async () => {
			await native({ range: true });
			const rightClick = (x, y) => page.evaluate(([x, y]) => document.querySelector('#overlay').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })), [x, y]);
			await pointer('pointermove', 600, 400, { pressure: 0, buttons: 0, button: -1 });
			await page.waitForTimeout(1500);
			await rightClick(600, 400);
			await expect(page.locator('#context-menu')).toBeHidden();
			await native({});
			await page.waitForTimeout(100);
			await rightClick(600, 400);
			await expect(page.locator('#context-menu')).toBeVisible();
		});

		test('display buttons: the driver scrolling while the upper switch is down scrolls the page and is not a tap', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await page.keyboard.press(`${modifier}+z`);
			const start = await origin();
			await native({ upper: true, range: true });
			await page.locator('#overlay').dispatchEvent('wheel', { deltaX: 0, deltaY: 80 });
			await native({ range: true });
			expect((await origin()).y).toBe(start.y + 80);
			// That press did not count, so one clean tap after it is still only a single tap.
			await nativeClick('upper');
			expect(await strokes()).toEqual([]);
			await nativeClick('upper');
			await expect.poll(strokes).toEqual(written);
		});

		test('display buttons: the upper switch held with the tip touching drags the page and never inks', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const start = await origin();
			await native({ upper: true, range: true });
			await pointer('pointerdown', 750, 500);
			await pointer('pointermove', 690, 420, { button: -1 });
			await pointer('pointerup', 690, 420, { pressure: 0, buttons: 0 });
			await native({ range: true });
			expect(await strokes()).toEqual(written);
			expect(await origin()).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 80 });
			await ink(600, 600);
			expect(await strokes()).toHaveLength(2);
		});

		test('display buttons: the lower switch held with the tip touching erases, and a tap of it alone erases nothing', async () => {
			await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
			const written = await strokes();
			await nativeClick('lower');
			expect(await strokes()).toEqual(written);
			await pointer('pointermove', 300, 250, { pressure: 0, buttons: 0, button: -1 });
			await native({ lower: true, range: true });
			await pointer('pointermove', 300, 250, { pressure: 0.6, buttons: 1, button: 0 });
			await expect.poll(async () => (await strokes()).length).toBe(0);
			await pointer('pointermove', 300, 250, { pressure: 0, buttons: 0, button: 0 });
			await native({ range: true });
			await page.keyboard.press(`${modifier}+z`);
			expect(await strokes()).toEqual(written);
		});

		// The Wacom One 12 also says where its pen is. While a side switch is held the pen is then the display's own, its tip and
		// its place, and nothing is taken from what the driver makes of that switch: a right click, Pan/Scroll, or nothing at all.
		const at = (x, y, state = {}) => native({ range: true, clientX: x, clientY: y, p: state.tip ? 0.6 : 0, ...state });

		test('display pen: hold delete deletes nothing until the display says the tip touches, then only where it touches', async () => {
			await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
			await draw({ x: 200, y: 400 }, { x: 400, y: 400 });
			await draw({ x: 200, y: 550 }, { x: 400, y: 550 });
			const [first, second, third] = await strokes();
			await at(300, 150, { lower: true });
			// Held and moved across all the ink, hovering: nothing goes.
			for (const y of [250, 330, 400, 480, 550]) await at(300, y, { lower: true });
			// The driver's right click for the held button, carrying a hover click's pressure, is not a touch either.
			await pointer('pointerdown', 300, 400, { pressure: 0.5, buttons: 2, button: 2 });
			await pointer('pointermove', 300, 550, { pressure: 0.5, buttons: 2, button: -1 });
			expect(await ids()).toEqual([first.id, second.id, third.id]);
			// The display says the tip touches the first stroke: that one goes, and only that one, with no pen event from the driver.
			await at(300, 250, { lower: true, tip: true });
			await expect.poll(ids).toEqual([second.id, third.id]);
			await at(300, 250, { lower: true });
			for (const y of [330, 400]) await at(300, y, { lower: true });
			expect(await ids()).toEqual([second.id, third.id]);
			// Touch again and drag across both remaining strokes: they go, as one undo.
			await at(300, 400, { lower: true, tip: true });
			await at(300, 480, { lower: true, tip: true });
			await at(300, 550, { lower: true, tip: true });
			await expect.poll(async () => (await strokes()).length).toBe(0);
			await at(300, 550, { lower: true });
			await at(300, 550);
			await pointer('pointerup', 300, 550, { pressure: 0, buttons: 0, button: 2 });
			await page.keyboard.press(`${modifier}+z`);
			expect(await ids()).toEqual([second.id, third.id]);
			await page.keyboard.press(`${modifier}+z`);
			expect(await ids()).toEqual([first.id, second.id, third.id]);
			// Let go: the pen writes again.
			await ink(600, 650);
			expect(await strokes()).toHaveLength(4);
		});

		test('display pen: the delete button pressed during a stroke ends it and deletes nothing until the tip lifts and touches again', async () => {
			await draw({ x: 200, y: 250 }, { x: 400, y: 250 });
			const [first] = await strokes();
			await pointer('pointerdown', 250, 400);
			await at(250, 400, { tip: true });
			await pointer('pointermove', 300, 400, { button: -1 });
			// The button goes down with the tip on the paper, then the pen is dragged over the first stroke.
			await at(300, 400, { lower: true, tip: true });
			await at(300, 250, { lower: true, tip: true });
			expect((await ids())[0]).toBe(first.id);
			expect(await strokes()).toHaveLength(2);
			// Lifted and touched again, still held: now it deletes.
			await at(300, 250, { lower: true });
			await at(300, 250, { lower: true, tip: true });
			await expect.poll(async () => (await ids()).includes(first.id)).toBe(false);
			await at(300, 250, { lower: true });
			await at(300, 250);
		});

		test('display pen: hold the upper button and move scrolls, hovering or touching, and the driver\'s own scrolling adds nothing', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const start = await origin();
			await at(750, 500, { upper: true });
			await at(690, 420, { upper: true });
			expect(await origin()).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 80 });
			// Pan/Scroll on that button turns the same movement into a wheel: it is not a second scroll.
			await page.locator('#overlay').dispatchEvent('wheel', { deltaX: 0, deltaY: 300 });
			expect(await origin()).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 80 });
			// Touching while it is held keeps dragging the page and never inks.
			await at(690, 420, { upper: true, tip: true });
			await at(690, 380, { upper: true, tip: true });
			expect(await origin()).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 120 });
			await at(690, 380, { upper: true });
			await at(690, 380);
			expect(await strokes()).toEqual(written);
			// Let go: moving the pen scrolls nothing, and the pen writes.
			await at(690, 200);
			expect(await origin()).toEqual({ x: start.x + (mode === 'grid' ? 60 : 0), y: start.y + 120 });
			await ink(600, 600);
			expect(await strokes()).toHaveLength(2);
		});

		test('display pen: a double tap of the upper button redoes even while the driver scrolls for that button', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			await page.keyboard.press(`${modifier}+z`);
			expect(await strokes()).toEqual([]);
			const start = await origin();
			await page.evaluate(async () => {
				const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
				const overlay = document.querySelector('#overlay');
				const pen = (x, y, state) => window.scrollmindDebug.nativePen({ range: true, clientX: x, clientY: y, p: 0, ...state });
				for (let press = 0; press < 2; press++) {
					pen(500, 400, { upper: true });
					await wait(120);
					// The thumb nudges the pen, and the driver turns the nudge into a scroll.
					overlay.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 6, clientX: 500, clientY: 400 }));
					pen(504, 403, { upper: true });
					await wait(80);
					pen(504, 403, {});
					await wait(150);
				}
			});
			await expect.poll(strokes).toEqual(written);
			expect(await origin()).toEqual(start);
		});

		test('display pen: lower then upper, quickly, arms zoom for the next touch, which the driver draws', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			const written = await strokes();
			const before = await zoom();
			await page.evaluate(async () => {
				const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
				const pen = state => window.scrollmindDebug.nativePen({ range: true, clientX: 640, clientY: 540, p: 0, ...state });
				for (const key of ['lower', 'upper']) { pen({ [key]: true }); await wait(90); pen({}); await wait(120); }
			});
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'zoom-in');
			await dragTip(640, 540, 400);
			expect(await strokes()).toEqual(written);
			expect(await zoom()).toBeCloseTo(before * 2, 1);
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
		});

		test('Escape cancels an armed zoom and the next contact writes', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			await armZoom();
			await page.keyboard.press('Escape');
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
			await ink(600, 500);
			expect(await strokes()).toHaveLength(2);
			expect(await zoom()).toBe(1);
		});

		test('lower then upper in the wrong order, or after a pause, leaves the pen normal', async () => {
			await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
			await upperClick();
			await lowerClick();
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
			await ink(600, 500);
			expect(await strokes()).toHaveLength(2);
			expect(await zoom()).toBe(1);

			await lowerClick();
			await page.waitForTimeout(900);
			await upperClick();
			await expect(page.locator('#overlay')).toHaveCSS('cursor', 'crosshair');
			await ink(600, 600);
			expect(await strokes()).toHaveLength(3);
			expect(await zoom()).toBe(1);
		});
	});
}

test('Pen button contract: Windows Hover Click delivers lower then upper as mouse input and still arms zoom', async () => {
	await relaunchWithPenPlatform('win32');
	await draw({ x: 380, y: 250 }, { x: 480, y: 290 });
	const written = (await snapshot()).strokes;
	await page.evaluate(async () => {
		const overlay = document.querySelector('#overlay');
		const fire = (type, init) => overlay.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 600, clientY: 400, ...init }));
		fire('pointermove', { pointerId: 44, pointerType: 'pen', buttons: 0, pressure: 0 });
		for (const [button, buttons] of [[2, 2], [1, 4]]) {
			fire('pointerdown', { pointerId: 11, pointerType: 'mouse', button, buttons });
			fire('pointerup', { pointerId: 11, pointerType: 'mouse', button, buttons: 0 });
			await new Promise(resolve => setTimeout(resolve, 80));
		}
	});
	await expect(page.locator('#overlay')).toHaveCSS('cursor', 'zoom-in');
	await pointer('pointerdown', 640, 540);
	await pointer('pointermove', 640, 470, { button: -1 });
	await pointer('pointermove', 640, 400, { button: -1 });
	await pointer('pointerup', 640, 400, { pressure: 0, buttons: 0 });
	expect((await snapshot()).strokes).toEqual(written);
	expect((await snapshot()).view.scrollZoom).toBeCloseTo(2, 1);
});

test('a stray cancel from another pointer never snaps a mouse drag of selected ink back', async () => {
	await draw({ x: 400, y: 300 }, { x: 520, y: 300 });
	const original = (await snapshot()).strokes[0];
	await clickPenControl('[data-tool="select"]');
	await drag({ x: 380, y: 260 }, { x: 540, y: 340 });
	expect(await selection()).toEqual([original.id]);
	await page.mouse.move(460, 300);
	await page.mouse.down();
	await page.mouse.move(520, 340, { steps: 4 });
	await page.evaluate(() => {
		const overlay = document.querySelector('#overlay');
		overlay.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 44, pointerType: 'pen' }));
		overlay.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
	});
	await page.mouse.move(560, 360, { steps: 4 });
	await page.mouse.up();
	const moved = (await snapshot()).strokes[0];
	expect(moved.points[0].x).toBeCloseTo(original.points[0].x + 100);
	expect(moved.points[0].y).toBeCloseTo(original.points[0].y + 60);

	// The browser really cancelling the dragged pointer still abandons that drag.
	await page.mouse.move(560, 360);
	await page.mouse.down();
	await page.mouse.move(600, 400, { steps: 3 });
	await page.evaluate(() => document.querySelector('#overlay').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, pointerType: 'mouse' })));
	await page.mouse.up();
	expect((await snapshot()).strokes[0].points[0].x).toBeCloseTo(moved.points[0].x);
});

test('Fill colours an outlined area beneath the ink, recolours it, refuses open areas, and undoes in one step', async () => {
	// A closed square of ink with a smaller square inside it.
	await draw({ x: 400, y: 300 }, { x: 640, y: 300 });
	await drag({ x: 640, y: 300 }, { x: 640, y: 520 });
	await drag({ x: 640, y: 520 }, { x: 400, y: 520 });
	await drag({ x: 400, y: 520 }, { x: 400, y: 300 });
	await drag({ x: 480, y: 380 }, { x: 560, y: 380 });
	await drag({ x: 560, y: 380 }, { x: 560, y: 440 });
	await drag({ x: 560, y: 440 }, { x: 480, y: 440 });
	await drag({ x: 480, y: 440 }, { x: 480, y: 380 });
	const ink = (await snapshot()).strokes;
	expect(ink).toHaveLength(8);

	await openPenControls();
	await page.locator('[data-color="#215b9c"]').click();
	await page.locator('[data-tool="fill"]').click();
	await expect(page.locator('[data-tool="fill"]')).toHaveAttribute('aria-pressed', 'true');
	await page.mouse.click(430, 330);
	await expect.poll(async () => (await snapshot()).strokes.filter(stroke => stroke.penType === 'fill').length).toBe(1);
	let fills = (await snapshot()).strokes.filter(stroke => stroke.penType === 'fill');
	expect(fills[0].color.toLowerCase()).toBe('#215b9c');
	expect(fills[0].points.some(point => point.p === 0)).toBe(true);
	const box = fills[0].points.reduce((sum, point) => ({ left: Math.min(sum.left, point.x), right: Math.max(sum.right, point.x), top: Math.min(sum.top, point.y), bottom: Math.max(sum.bottom, point.y) }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
	expect(box.right - box.left).toBeGreaterThan(230);
	expect(box.right - box.left).toBeLessThan(250);
	expect((await snapshot()).strokes.filter(stroke => stroke.penType !== 'fill')).toEqual(ink);
	const pixel = async (x, y) => page.evaluate(([x, y]) => [...document.querySelector('#canvas').getContext('2d').getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1).data].slice(0, 3), [x, y]);
	await expect.poll(() => pixel(430, 330)).toEqual([0x21, 0x5b, 0x9c]);
	expect(await pixel(520, 410)).not.toEqual([0x21, 0x5b, 0x9c]);

	// The same area again recolours it instead of stacking a second fill.
	await openPenControls();
	await page.locator('[data-color="#b94d49"]').click();
	await page.locator('[data-tool="fill"]').click();
	await page.mouse.click(430, 330);
	await expect.poll(async () => (await snapshot()).strokes.filter(stroke => stroke.penType === 'fill').map(stroke => stroke.color.toLowerCase())).toEqual(['#b94d49']);

	// The island inside is its own area, and ink erased inside a fill leaves the colour behind.
	await page.mouse.click(520, 410);
	await expect.poll(async () => (await snapshot()).strokes.filter(stroke => stroke.penType === 'fill').length).toBe(2);
	await page.keyboard.press(`${modifier}+z`);
	expect((await snapshot()).strokes.filter(stroke => stroke.penType === 'fill')).toHaveLength(1);
	await openPenControls();
	await page.locator('[data-tool="eraser"]').click();
	await page.mouse.move(520, 300);
	await page.mouse.down();
	await page.mouse.move(522, 302, { steps: 2 });
	await page.mouse.up();
	expect((await snapshot()).strokes.filter(stroke => stroke.penType === 'fill')).toHaveLength(1);
	expect((await snapshot()).strokes.filter(stroke => stroke.penType !== 'fill').length).toBeLessThan(8);

	// Outside the outline the area runs off the page, so nothing is filled.
	await openPenControls();
	await page.locator('[data-tool="fill"]').click();
	await page.mouse.click(900, 650);
	await expect(page.locator('#status')).toContainText('isn’t closed');
	expect((await snapshot()).strokes.filter(stroke => stroke.penType === 'fill')).toHaveLength(1);
	// On a line nothing is filled either.
	await page.mouse.click(640, 400);
	await expect(page.locator('#status')).toContainText('outlined area');

	// Exports carry the fill beneath the ink.
	await showSidebar();
	await page.locator('#export-svg').click();
	const svg = await readFile(await exportedPath('svg'), 'utf8');
	expect(svg).toContain('data-pen-type="fill"');
	expect(svg.indexOf('data-pen-type="fill"')).toBeLessThan(svg.indexOf('data-stroke-id', svg.indexOf('data-pen-type="fill"') + 10));
	expect(svg).toContain('fill-rule="evenodd"');
});

test('Fill works with the pen inside a Grid shape, keeps the outline on top, survives a restart, and an erase that starts on it removes it', async () => {
	await showSidebar(); await page.locator('#grid-mode').click(); await showSidebar(false);
	await clickPenControl('#diagram-shape');
	await drag({ x: 500, y: 300 }, { x: 700, y: 420 });
	const node = (await snapshot()).diagram.nodes[0];
	await openPenControls();
	const swatch = page.locator('[data-color]').nth(2);
	const color = (await swatch.getAttribute('data-color')).toLowerCase();
	await swatch.click();
	await page.locator('[data-tool="fill"]').click();
	await pointer('pointermove', 600, 360, { pressure: 0, buttons: 0, button: -1 });
	await pointer('pointerdown', 600, 360);
	await pointer('pointerup', 600, 360, { pressure: 0, buttons: 0 });
	await expect.poll(async () => (await snapshot()).strokes.filter(stroke => stroke.penType === 'fill').length).toBe(1);
	const [fill] = (await snapshot()).strokes;
	expect(fill.color.toLowerCase()).toBe(color);
	const xs = fill.points.map(point => point.x), ys = fill.points.map(point => point.y);
	expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(node.width - 6);
	expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(node.width + 6);
	expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(node.height - 6);
	const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
	const pixel = async (x, y) => page.evaluate(([x, y]) => [...document.querySelector('#canvas').getContext('2d').getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1).data].slice(0, 3), [x, y]);
	// Grid paper is night blue, where ink is shown lightened.
	const shown = rgb(inkOnPaper(color, 'night'));
	await expect.poll(() => pixel(600, 360)).toEqual(shown);
	expect(await pixel(500, 360)).not.toEqual(shown);

	const expected = await snapshot();
	await closeGracefully();
	await launch();
	expect(await snapshot()).toEqual(expected);

	await openPenControls();
	await page.locator('[data-tool="eraser"]').click();
	await page.mouse.move(600, 360);
	await page.mouse.down();
	await page.mouse.up();
	await expect.poll(async () => (await snapshot()).strokes.length).toBe(0);
	expect((await snapshot()).diagram.nodes).toHaveLength(1);
	await page.keyboard.press(`${modifier}+z`);
	expect((await snapshot()).strokes.map(stroke => stroke.id)).toEqual([fill.id]);
});

test('Pen Display Buttons says plainly when there is no supported pen display', async () => {
	test.skip(process.platform !== 'darwin', 'The app menu is macOS only');
	await app.evaluate(({ dialog }) => {
		globalThis.shownDialogs = [];
		dialog.showMessageBox = async (...args) => { globalThis.shownDialogs.push(args.at(-1)); return { response: 0 }; };
	});
	await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Pen Display Buttons…').click());
	await expect.poll(() => app.evaluate(() => globalThis.shownDialogs.length)).toBe(1);
	const [shown] = await app.evaluate(() => globalThis.shownDialogs);
	expect(shown.message).toBe('No supported pen display found');
	expect(shown.buttons).toEqual(['OK']);
});
