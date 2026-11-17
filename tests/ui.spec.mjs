import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let app;
let page;
let dataDir;

async function launch() {
  const env = {
    ...process.env,
    SCROLLMIND_TEST: '1',
    SCROLLMIND_DATA_DIR: dataDir,
    SCROLLMIND_EXPORT_DIR: resolve(dataDir, 'Exports'),
    SCROLLMIND_OPEN_PATH: '__cancel__',
  };
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
    expect(database.prepare('PRAGMA application_id').get().application_id).toBe(0x534d4e44);
    const schema = database.prepare('PRAGMA user_version').get().user_version;
    expect([1, 2]).toContain(schema);
    const metadata = Object.fromEntries(database.prepare('SELECT key, value FROM metadata').all().map(row => [row.key, JSON.parse(row.value)]));
    return {
      version: 1,
      strokes: database.prepare(`SELECT id, color, width, points, ${schema >= 2 ? 'pen_type' : 'NULL AS pen_type'} FROM strokes ORDER BY order_index`).all().map(row => {
        const { pen_type, ...stroke } = row;
        return { ...stroke, points: JSON.parse(stroke.points), ...(pen_type == null ? {} : { penType: pen_type }) };
      }),
      markers: database.prepare('SELECT id, y, label, kind FROM markers ORDER BY y, rowid').all().map(row => ({ ...row })),
      view: metadata.view,
      settings: metadata.settings,
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
  expect(wheelColor).not.toBe('#243746');
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
  for (const [index, penType] of ['pen', 'pencil', 'fountain', 'marker'].entries()) {
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
  expect(expected.strokes.map(stroke => stroke.penType)).toEqual(['pen', 'pencil', 'fountain', 'marker']);
  expect(expected.settings.penType).toBe('marker');
  expect(expected.settings.width).toBe(12);
  await closeGracefully();
  expect(readNativeScroll(resolve(dataDir, 'scroll.sm')).strokes).toEqual(expected.strokes);
  await launch();
  expect((await snapshot()).strokes).toEqual(expected.strokes);
  expect((await snapshot()).settings.penType).toBe('marker');
  expect((await snapshot()).settings.width).toBe(12);
});
