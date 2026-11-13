const { app, BrowserWindow } = require('electron');
const path = require('node:path');

if (process.env.DAC_USER_DATA) {
  try {
    app.setPath('userData', process.env.DAC_USER_DATA);
  } catch {
    // ignore
  }
}

const url = process.env.DAC_URL || 'http://127.0.0.1:3840';

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: false });
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[page:${level}] ${message}`);
  });
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 3000));

  const script = process.env.DAC_PROBE_JS || 'document.title';
  try {
    const result = await win.webContents.executeJavaScript(script, true);
    console.log('PROBE_RESULT', typeof result === 'string' ? result : JSON.stringify(result));
  } catch (err) {
    console.log('PROBE_ERROR', err?.message || String(err));
  }

  if (process.env.DAC_PROBE_WAIT) {
    await new Promise((r) => setTimeout(r, Number(process.env.DAC_PROBE_WAIT)));
    const shot = path.resolve(__dirname, '..', 'docs', process.env.DAC_PROBE_SHOT || 'probe.png');
    const image = await win.webContents.capturePage();
    require('node:fs').writeFileSync(shot, image.toPNG());
    console.log('SHOT', shot);
  }
  app.quit();
}).catch((err) => {
  console.error('PROBE_FAIL', err?.message || err);
  app.exit(1);
});
