import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Workspace verification gate config (P0-4).
 * Loaded from `.deepautocode/verify.json` (preferred) or inferred from project files.
 */
export interface VerifyConfig {
  buildCommand: string;
  testCommand: string;
  /** Optional single command that builds + tests */
  combinedCommand?: string;
  /** Globs/extensions that trigger post-edit verification */
  sourceGlobs: string[];
  /** Auto mode creates evolve/* branch before first mutation when true */
  enableEvolveSandbox: boolean;
  source: 'workspace-file' | 'inferred' | 'default';
}

export const DEFAULT_VERIFY_CONFIG: VerifyConfig = {
  buildCommand: 'npm run build',
  testCommand: 'npm test',
  combinedCommand: 'npm run build && npm test',
  sourceGlobs: ['**/*.{ts,tsx,js,jsx,py,go,rs,c,cc,cpp,cu,h,hpp}'],
  enableEvolveSandbox: true,
  source: 'default',
};

export interface VerifyConfigFileShape {
  buildCommand?: string;
  testCommand?: string;
  combinedCommand?: string;
  sourceGlobs?: string[];
  enableEvolveSandbox?: boolean;
}

export function isVerifiableSourcePath(
  filePath: string,
  config: VerifyConfig = DEFAULT_VERIFY_CONFIG
): boolean {
  const base = path.basename(filePath).toLowerCase();
  // Prefer explicit extensions derived from sourceGlobs; fall back to common compiled/app sources
  const fromGlobs = config.sourceGlobs
    .flatMap((g) => {
      const m = g.match(/\{([^}]+)\}/);
      if (m) return m[1].split(',').map((s) => s.trim().toLowerCase());
      const ext = g.match(/\.([a-z0-9]+)$/i);
      return ext ? [ext[1].toLowerCase()] : [];
    })
    .filter(Boolean);
  const exts =
    fromGlobs.length > 0
      ? fromGlobs
      : ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'c', 'cc', 'cpp', 'cu', 'h', 'hpp'];
  const fileExt = base.includes('.') ? base.split('.').pop()! : '';
  return exts.includes(fileExt);
}

export function formatVerifyCommandsForPrompt(config: VerifyConfig): string {
  const combined =
    config.combinedCommand?.trim() ||
    `${config.buildCommand.trim()} && ${config.testCommand.trim()}`;
  return [
    `Build: \`${config.buildCommand}\``,
    `Test: \`${config.testCommand}\``,
    `Preferred combined verify: \`${combined}\``,
  ].join('\n');
}

export async function loadVerifyConfig(workspaceRoot: string): Promise<VerifyConfig> {
  const root = path.resolve(workspaceRoot);
  const candidates = [
    path.join(root, '.deepautocode', 'verify.json'),
    path.join(root, 'verify.deepautocode.json'),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as VerifyConfigFileShape;
      const buildCommand = String(parsed.buildCommand || '').trim();
      const testCommand = String(parsed.testCommand || '').trim();
      if (!buildCommand && !testCommand && !parsed.combinedCommand) {
        continue;
      }
      return {
        buildCommand: buildCommand || DEFAULT_VERIFY_CONFIG.buildCommand,
        testCommand: testCommand || DEFAULT_VERIFY_CONFIG.testCommand,
        combinedCommand:
          String(parsed.combinedCommand || '').trim() ||
          `${buildCommand || DEFAULT_VERIFY_CONFIG.buildCommand} && ${testCommand || DEFAULT_VERIFY_CONFIG.testCommand}`,
        sourceGlobs:
          Array.isArray(parsed.sourceGlobs) && parsed.sourceGlobs.length > 0
            ? parsed.sourceGlobs.map(String)
            : DEFAULT_VERIFY_CONFIG.sourceGlobs,
        enableEvolveSandbox: parsed.enableEvolveSandbox !== false,
        source: 'workspace-file',
      };
    } catch {
      // try next
    }
  }

  return inferVerifyConfigFromWorkspace(root);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function inferVerifyConfigFromWorkspace(workspaceRoot: string): Promise<VerifyConfig> {
  const root = path.resolve(workspaceRoot);
  const has = async (rel: string) => fileExists(path.join(root, rel));

  if (await has('package.json')) {
    let hasBuildScript = false;
    let hasTestScript = false;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'));
      hasBuildScript = Boolean(pkg?.scripts?.build);
      hasTestScript = Boolean(pkg?.scripts?.test);
    } catch {
      // ignore
    }
    const buildCommand = hasBuildScript ? 'npm run build' : 'npm run typecheck';
    const testCommand = hasTestScript ? 'npm test' : 'npm run typecheck';
    return {
      buildCommand,
      testCommand,
      combinedCommand: `${buildCommand} && ${testCommand}`,
      sourceGlobs: ['**/*.{ts,tsx,js,jsx}'],
      enableEvolveSandbox: true,
      source: 'inferred',
    };
  }

  if (await has('pyproject.toml') || (await has('pytest.ini')) || (await has('requirements.txt'))) {
    return {
      buildCommand: 'python -m compileall .',
      testCommand: 'pytest -q',
      combinedCommand: 'python -m compileall . && pytest -q',
      sourceGlobs: ['**/*.py'],
      enableEvolveSandbox: true,
      source: 'inferred',
    };
  }

  if (await has('Cargo.toml')) {
    return {
      buildCommand: 'cargo build',
      testCommand: 'cargo test',
      combinedCommand: 'cargo test',
      sourceGlobs: ['**/*.rs'],
      enableEvolveSandbox: true,
      source: 'inferred',
    };
  }

  if (await has('go.mod')) {
    return {
      buildCommand: 'go build ./...',
      testCommand: 'go test ./...',
      combinedCommand: 'go test ./...',
      sourceGlobs: ['**/*.go'],
      enableEvolveSandbox: true,
      source: 'inferred',
    };
  }

  if (await has('CMakeLists.txt') || (await has('Makefile')) || (await has('build'))) {
    const hasNccl = await has('nccl-test');
    const buildCommand = 'if [ -d build ]; then cmake --build build -j; elif [ -f Makefile ]; then make -j; fi';
    const testCommand = hasNccl
      ? 'export LD_LIBRARY_PATH=$PWD/build/lib:$LD_LIBRARY_PATH; ./nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2'
      : 'if [ -d build ]; then cd build && ctest --output-on-failure; fi';
    return {
      buildCommand,
      testCommand,
      combinedCommand: `${buildCommand} && ${testCommand}`,
      sourceGlobs: ['**/*.{c,cc,cpp,cu,h,hpp}'],
      enableEvolveSandbox: true,
      source: 'inferred',
    };
  }

  return { ...DEFAULT_VERIFY_CONFIG };
}
