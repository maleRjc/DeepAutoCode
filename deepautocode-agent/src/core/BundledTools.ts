import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PANDOC_REL: Record<NodeJS.Platform, string[]> = {
  win32: ['.tools', 'pandoc', 'win', 'pandoc.exe'],
  linux: ['.tools', 'pandoc', 'linux', 'bin', 'pandoc'],
  darwin: ['.tools', 'pandoc', 'mac', 'bin', 'pandoc'],
  aix: [],
  android: [],
  freebsd: [],
  haiku: [],
  openbsd: [],
  sunos: [],
  cygwin: [],
  netbsd: [],
};

function findDeepAutoCodeRepoRootFromDir(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const hasShell =
      fs.existsSync(path.join(dir, 'deepautocode', 'package.json')) &&
      fs.existsSync(path.join(dir, 'deepautocode-agent', 'package.json'));
    if (hasShell) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Walk upward from workspace to find DeepAutoCode monorepo root. */
export function findDeepAutoCodeRepoRoot(startDir: string): string | undefined {
  return findDeepAutoCodeRepoRootFromDir(startDir);
}

/** Agent install / IDE host root (SSH mirror workspaces are not under the monorepo). */
export function findDeepAutoCodeInstallRepoRoot(): string | undefined {
  const fromEnv = process.env.DEEPAUTOCODE_REPO_ROOT?.trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'deepautocode-agent', 'package.json'))) {
    return path.resolve(fromEnv);
  }
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 10; depth += 1) {
      const hit = findDeepAutoCodeRepoRootFromDir(dir);
      if (hit) return hit;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // CJS / test environments without import.meta
  }
  return findDeepAutoCodeRepoRootFromDir(process.cwd());
}

export function resolveBundledPandocExe(repoRoot: string): string | undefined {
  const rel = PANDOC_REL[process.platform];
  if (!rel?.length) return undefined;
  const full = path.join(repoRoot, ...rel);
  try {
    fs.accessSync(full, fs.constants.X_OK);
    return full;
  } catch {
    if (process.platform === 'win32' && fs.existsSync(full)) return full;
    return undefined;
  }
}

/** Directory entries to prepend to PATH for shell tools spawned by the agent. */
export function bundledToolPathDirs(workspaceRoot: string): string[] {
  const repo = findDeepAutoCodeRepoRoot(workspaceRoot) ?? findDeepAutoCodeInstallRepoRoot();
  if (!repo) return [];
  const pandoc = resolveBundledPandocExe(repo);
  return pandoc ? [path.dirname(pandoc)] : [];
}

export function augmentEnvWithBundledTools(
  workspaceRoot: string,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const extraDirs = bundledToolPathDirs(workspaceRoot);
  if (extraDirs.length === 0) return { ...base };
  const sep = process.platform === 'win32' ? ';' : ':';
  const prefix = extraDirs.join(sep);
  const pathKey =
    process.platform === 'win32'
      ? Object.prototype.hasOwnProperty.call(base, 'Path')
        ? 'Path'
        : 'PATH'
      : 'PATH';
  const cur = String(base[pathKey] ?? base.Path ?? '');
  return {
    ...base,
    [pathKey]: cur ? `${prefix}${sep}${cur}` : prefix,
    DEEPAUTOCODE_BUNDLED_TOOLS: prefix,
  };
}
