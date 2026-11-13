const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.deepautocode.ide.v1.1');
}

// Suppress Chromium NetworkChangeNotifierWin WSA log spam on Windows (benign: WSALookupServiceBegin failed with: 8)
try {
  app.commandLine.appendSwitch('log-level', '3');
} catch {
  // ignore
}

function readSavedIdeTheme() {
  try {
    const settingsPath = path.resolve(__dirname, '../.deepautocode-data/ide-settings.json');
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const t = parsed?.editor?.theme;
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  } catch {
    // ignore
  }
  return 'dark';
}

let mainWindow = null;
let serverHandle = null;
let backendWatchdogTimer = null;

// Brand icon: prefer the multi-size .ico (Windows taskbar / Alt-Tab), fall back to PNG.
const BRAND_ICON_ICO = path.resolve(__dirname, '../assets/logo.ico');
const BRAND_ICON_PNG = path.resolve(__dirname, '../assets/logo-icon.png');
const BRAND_ICON = fs.existsSync(BRAND_ICON_ICO)
  ? BRAND_ICON_ICO
  : fs.existsSync(BRAND_ICON_PNG)
    ? BRAND_ICON_PNG
    : null;

process.on('uncaughtException', (err) => {
  console.error('[DeepAutoCode Electron Main] Uncaught Exception (guarded):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[DeepAutoCode Electron Main] Unhandled Rejection (guarded):', reason);
});

async function ensureBackendServer() {
  const preferredPort = Number(process.env.PORT || 3840);
  try {
    const check = await fetch(`http://127.0.0.1:${preferredPort}/api/extensions`, {
      signal: AbortSignal.timeout(600),
    });
    if (check.ok) {
      return `http://127.0.0.1:${preferredPort}`;
    }
  } catch {
    // start embedded server
  }

  return startKernelServer(preferredPort);
}

// The DeepSeek Harness kernel needs Node >= 24. The Electron runtime ships an
// older Node, so the Workbench host (and the dsh kernel it supervises) runs in a
// dedicated Node 24 child process. Prefer an explicitly configured binary, then
// the Node bundled with a DeepSeek Harness installation, then plain `node`.
function resolveKernelNode() {
  const candidates = [];
  if (process.env.DSH_KERNEL_NODE) candidates.push(process.env.DSH_KERNEL_NODE);
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    candidates.push(
      path.join(
        localAppData,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'runtime',
        'primary-runtime',
        'dependencies',
        'node',
        'bin',
        'node.exe'
      )
    );
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return 'node';
}

function startKernelServer(port) {
  const repoRoot = path.resolve(__dirname, '..');
  const entry = path.join(repoRoot, 'dist', 'src', 'main.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Workbench host is not built yet (${entry}). Run "npm run build" before starting the desktop app.`
    );
  }

  const nodeBin = resolveKernelNode();
  const env = { ...process.env, PORT: String(port), DAC_PRINT_URL: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(nodeBin, [entry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverHandle = child;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('Timed out waiting for the DeepAutoCode Workbench host to start.'));
      }
    }, 120000);

    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DSH_WORKBENCH_URL=(\S+)/);
      if (match) finish(match[1]);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      process.stderr.write(`[dsh-host] ${String(chunk)}`);
    });
    child.on('exit', (code) => {
      serverHandle = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Workbench host exited before becoming ready (code ${code}).`));
      }
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle('dialog:openFolder', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Project / Workspace Folder in DeepAutoCode',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:openFile', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open File in DeepAutoCode',
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('window:control', (_event, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') {
      mainWindow.close();
    }
  });

  ipcMain.handle('window:setTheme', (_event, mode) => {
    if (!mainWindow) return;
    try {
      if (typeof mainWindow.setBackgroundColor === 'function') {
        mainWindow.setBackgroundColor(mode === 'light' ? '#f8fafc' : '#0d1017');
      }
      if (typeof mainWindow.setTitleBarOverlay === 'function') {
        if (mode === 'light') {
          mainWindow.setTitleBarOverlay({
            color: '#f1f5f9',
            symbolColor: '#0f172a',
            height: 36,
          });
        } else {
          mainWindow.setTitleBarOverlay({
            color: '#0c0f16',
            symbolColor: '#e2e8f0',
            height: 36,
          });
        }
      }
    } catch {
      // ignore if unsupported on current platform
    }
  });
}

async function createIdeWindow() {
  registerIpcHandlers();
  const ideUrl = await ensureBackendServer();
  const savedTheme = readSavedIdeTheme();
  const isLight = savedTheme === 'cursor-light' || savedTheme === 'light';

  Menu.setApplicationMenu(null);

  const iconPath = BRAND_ICON;
  const nativeAppIcon = iconPath ? nativeImage.createFromPath(iconPath) : null;

  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: 'DeepAutoCode 鈥?AI Native IDE (v1.1)',
    ...(nativeAppIcon && !nativeAppIcon.isEmpty()
      ? { icon: nativeAppIcon }
      : iconPath
        ? { icon: iconPath }
        : {}),
    backgroundColor: isLight ? '#f8fafc' : '#0d1017',
    titleBarStyle: 'hidden',
    titleBarOverlay: isLight
      ? {
          color: '#f1f5f9',
          symbolColor: '#0f172a',
          height: 35,
        }
      : {
          color: '#0c0f16',
          symbolColor: '#e2e8f0',
          height: 35,
        },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  try {
    if (nativeAppIcon && !nativeAppIcon.isEmpty() && typeof mainWindow.setIcon === 'function') {
      mainWindow.setIcon(nativeAppIcon);
    }
    await mainWindow.webContents.session.clearCache();
    await mainWindow.webContents.session.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
  } catch {
    // ignore cache clear error
  }

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r'))
    ) {
      event.preventDefault();
      mainWindow.webContents.reloadIgnoringCache();
    }
  });

  await mainWindow.loadURL(ideUrl);

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[DeepAutoCode Electron] Render process gone:', details?.reason);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 800);
    }
  });

  // Watchdog: if external backend server ever stops, automatically spin up embedded backend inside Electron
  if (backendWatchdogTimer) clearInterval(backendWatchdogTimer);
  backendWatchdogTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || serverHandle) return;
    try {
      const check = await fetch(`${ideUrl}/api/extensions`, {
        signal: AbortSignal.timeout(1200),
      });
      if (!check.ok) throw new Error('Backend not ok');
    } catch {
      try {
        await ensureBackendServer();
      } catch {
        // ignore
      }
    }
  }, 4000);

  mainWindow.on('closed', () => {
    if (backendWatchdogTimer) {
      clearInterval(backendWatchdogTimer);
      backendWatchdogTimer = null;
    }
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Dock icon (macOS) + app-level icon used by taskbar grouping on Windows/Linux.
  if (BRAND_ICON && process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(BRAND_ICON);
    } catch {
      // ignore if unsupported
    }
  }
  return createIdeWindow();
});

app.on('window-all-closed', async () => {
  killKernelServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killKernelServer();
});

function killKernelServer() {
  const child = serverHandle;
  serverHandle = null;
  if (!child) return;
  try {
    child.kill();
  } catch {
    // ignore
  }
}
