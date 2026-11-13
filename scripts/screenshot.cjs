const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.DAC_URL || 'http://127.0.0.1:3841';
const out = path.resolve(__dirname, '..', 'docs', process.env.DAC_SHOT_NAME || 'workbench-screenshot.png');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, Number(process.env.DAC_SHOT_DELAY ?? 6000)));
  if (process.env.DAC_SHOT_JS) {
    try {
      await win.webContents.executeJavaScript(process.env.DAC_SHOT_JS, true);
    } catch (err) {
      console.error('SHOT_JS_FAIL', err?.message || err);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log('SHOT ' + out + ' ' + fs.statSync(out).size);
  app.quit();
}).catch((err) => {
  console.error('SHOT_FAIL', err?.message || err);
  app.exit(1);
});
