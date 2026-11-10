import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

function run() {
  try {
    if (process.platform === 'win32') {
      const ps1 = path.join(scriptDir, 'ensure-pandoc.ps1');
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-RepoRoot', repoRoot],
        { stdio: 'inherit', windowsHide: true }
      );
      if (r.status !== 0) {
        console.warn(
          '[deepautocode] Bundled pandoc install skipped or failed (run: npm run ensure:pandoc). PDF export may need manual pandoc.'
        );
      }
      return;
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const sh = path.join(scriptDir, 'ensure-pandoc.sh');
      if (!fs.existsSync(sh)) return;
      spawnSync('bash', [sh], { stdio: 'inherit', cwd: scriptDir });
      return;
    }
    console.warn('[deepautocode] Bundled pandoc installer not available on this platform.');
  } catch (err) {
    console.warn('[deepautocode] ensure:pandoc failed:', err?.message || err);
  }
}

run();
