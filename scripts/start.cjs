#!/usr/bin/env node
/**
 * Start the DeepAutoCode × DeepSeek Harness workbench.
 *
 * The Workbench host itself runs on any modern Node, but the `dsh` kernel it
 * spawns requires Node >= 24. This launcher re-executes the host with a
 * suitable Node so `npm start` works on machines whose default `node` is older
 * (for example Node 20 shipped next to an Electron app).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIN_MAJOR = 24;

function majorOf(bin) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(bin, ['-v'], { encoding: 'utf8', timeout: 8000 }).trim();
    const match = /^v(\d+)\./.exec(out);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function candidates() {
  const list = [];
  if (process.env.DSH_KERNEL_NODE) list.push(process.env.DSH_KERNEL_NODE);
  const localAppData = process.env.LOCALAPPDATA || '';
  if (localAppData) {
    list.push(
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
  list.push(process.execPath);
  return list.filter((bin) => {
    try {
      return Boolean(bin) && fs.existsSync(bin);
    } catch {
      return false;
    }
  });
}

function resolveNode() {
  for (const bin of candidates()) {
    if (majorOf(bin) >= MIN_MAJOR) return bin;
  }
  return null;
}

const nodeBin = resolveNode();
if (!nodeBin) {
  console.error(
    [
      `This launcher needs Node.js >= ${MIN_MAJOR} to supervise the DeepSeek Harness kernel.`,
      'Install Node 24+, or point DSH_KERNEL_NODE at a Node >= 24 executable, for example:',
      '  set DSH_KERNEL_NODE=C:\\Program Files\\nodejs\\node.exe',
    ].join('\n')
  );
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'dist', 'src', 'main.js');
if (!fs.existsSync(entry)) {
  console.error(`Build output not found: ${entry}\nRun "npm run build" first.`);
  process.exit(1);
}

console.log(`[launcher] using Node ${process.version} -> kernel Node ${nodeBin}`);

const child = spawn(nodeBin, [entry, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[launcher] failed to start the workbench host:', err.message);
  process.exit(1);
});
