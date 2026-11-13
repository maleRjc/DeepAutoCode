import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer } from '../workbench-server/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

process.on('uncaughtException', (err) => {
  console.error('[DeepAutoCode Desktop Host] Uncaught Exception (guarded):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[DeepAutoCode Desktop Host] Unhandled Rejection (guarded):', reason);
});

async function launchElectronDesktopIde() {
  const preferredPort = Number(process.env.PORT ?? 3840);
  let targetUrl = `http://127.0.0.1:${preferredPort}`;

  // 1. Check if Workbench Backend is already running; if not, start it
  let serverStartedHere = false;
  try {
    const check = await fetch(`${targetUrl}/api/extensions`, {
      signal: AbortSignal.timeout(700),
    });
    if (!check.ok) throw new Error('Not ready');
    console.log(`[DeepAutoCode] Reusing active Extension Host & Workbench Backend at ${targetUrl}`);
  } catch {
    const srv = await createWorkbenchServer({ port: preferredPort });
    targetUrl = srv.url;
    serverStartedHere = true;
    console.log(`[DeepAutoCode] Started Extension Host & Workbench Backend at ${targetUrl}`);
  }

  // 2. Launch native Electron Desktop IDE window (`node_modules/electron/dist/electron.exe`)
  const electronExe = path.join(
    REPO_ROOT,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  );
  const electronMain = path.join(REPO_ROOT, 'electron', 'main.cjs');

  if (fs.existsSync(electronExe)) {
    console.log(`[DeepAutoCode] Launching Native Electron Desktop IDE Window...`);
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: new URL(targetUrl).port };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(electronExe, [electronMain], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  } else {
    console.error('Electron binary not found at:', electronExe);
    process.exit(1);
  }
}

launchElectronDesktopIde().catch((err) => {
  console.error('Failed to launch DeepAutoCode Desktop IDE:', err);
  process.exit(1);
});
