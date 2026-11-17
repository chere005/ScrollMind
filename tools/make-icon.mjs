import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const directory = await mkdtemp(resolve(tmpdir(), 'scrollmind-icon-'));
const source = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setName('ScrollMind Icon Renderer');
app.setPath('userData', path.join(__dirname, 'Profile'));
app.disableHardwareAcceleration();
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
app.whenReady().then(async () => {
  const svg = await fs.readFile(${JSON.stringify(resolve(root, 'assets/logo.svg'))}, 'utf8');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true },
  });
  const html = '<html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%;display:block}</style></head><body>' + svg + '</body></html>';
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 }, { stayHidden: true, stayAwake: true });
  const png = image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG();
  if (png.length < 1000) throw new Error('Icon capture was empty.');
  await fs.mkdir(${JSON.stringify(resolve(root, 'build'))}, { recursive: true });
  await fs.writeFile(${JSON.stringify(resolve(root, 'build/icon.png'))}, png);
  console.log('Created build/icon.png');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`;

try {
  await writeFile(resolve(directory, 'main.cjs'), source);
  await writeFile(resolve(directory, 'package.json'), JSON.stringify({ name: 'scrollmind-icon-renderer', version: '0.1.0', main: 'main.cjs' }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [directory], { cwd: root, stdio: 'inherit', env });
  let timeout;
  const code = await new Promise((resolveExit, reject) => {
    timeout = setTimeout(() => {
      console.error('Icon rendering timed out after 20 seconds.');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1_000);
      force.unref();
    }, 20_000);
    child.once('error', reject);
    child.once('exit', (status) => resolveExit(status ?? 1));
  }).finally(() => clearTimeout(timeout));
  process.exitCode = code;
} finally {
  await rm(directory, { recursive: true, force: true });
}
