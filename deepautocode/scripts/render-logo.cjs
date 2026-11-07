/**
 * DeepAutoCode Logo Rasterizer
 * ------------------------------------------------------------------
 * Renders the official brand SVG (assets/logo.svg) into PNG / ICO
 * icon assets using Electron's offscreen renderer (no extra deps).
 *
 * Usage:
 *   node scripts/render-logo.cjs            # render all assets
 *   node scripts/render-logo.cjs --preview  # also write logo-preview.png
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.resolve(__dirname, '../assets');
const SVG_PATH = path.join(ASSETS, 'logo.svg');
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]);
}

const TMP_DIR = path.join(require('os').tmpdir(), 'dac-logo-render');
let sharedWin = null;

function getWindow() {
  if (sharedWin && !sharedWin.isDestroyed()) return sharedWin;
  sharedWin = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  return sharedWin;
}

async function renderSvg(svgMarkup, size) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const htmlPath = path.join(TMP_DIR, `logo-${size}.html`);
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${size}px;height:${size}px}
    </style></head><body>${svgMarkup}</body></html>`,
    'utf8',
  );

  const win = getWindow();
  await win.loadFile(htmlPath);
  await new Promise((r) => setTimeout(r, 260));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');
  const pngs = [];
  for (const size of PNG_SIZES) {
    const buf = await renderSvg(svg, size);
    pngs.push({ size, data: buf });
    fs.writeFileSync(path.join(ASSETS, `logo-${size}.png`), buf);
    console.log(`[logo] logo-${size}.png  ${buf.length} bytes`);
  }

  const iconPng = pngs.find((p) => p.size === 512).data;
  fs.writeFileSync(path.join(ASSETS, 'logo-icon.png'), iconPng);

  // NOTE: a ".jpg" file must contain real JPEG bytes, so re-encode instead of
  // copying the PNG buffer (browsers/Electron sniff the magic number and can
  // reject a PNG payload served as image/jpeg).
  const iconJpg = nativeImage.createFromBuffer(iconPng).toJPEG(95);
  // Guard: fail loudly instead of silently shipping a mislabelled asset.
  if (iconJpg.length < 4 || iconJpg.subarray(0, 3).toString('hex') !== 'ffd8ff') {
    throw new Error(
      `[logo] toJPEG() did not produce JPEG bytes (magic=${iconJpg.subarray(0, 4).toString('hex')}); ` +
        'refusing to write logo-icon.jpg',
    );
  }
  fs.writeFileSync(path.join(ASSETS, 'logo-icon.jpg'), iconJpg);
  console.log(`[logo] logo-icon.png (${iconPng.length} B) / logo-icon.jpg (${iconJpg.length} B) written`);

  const ico = buildIco(pngs.filter((p) => ICO_SIZES.includes(p.size)));
  fs.writeFileSync(path.join(ASSETS, 'logo.ico'), ico);
  console.log(`[logo] logo.ico written (${ico.length} bytes)`);

  if (process.argv.includes('--preview')) {
    const preview = await renderSvg(svg, 1024);
    fs.writeFileSync(path.join(ASSETS, 'logo-preview.png'), preview);
    console.log('[logo] logo-preview.png written');
  }

  app.quit();
});
