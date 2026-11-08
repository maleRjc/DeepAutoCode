import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  discoverWorkspaceCustomizations,
  ensureAgentSandboxBranch,
  isVerifiableSourcePath,
  loadVerifyConfig,
  rollbackSessionMutations,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

describe('P0 golden gates (verify / sandbox / circuit-breaker)', () => {
  it('loads .deepautocode/verify.json over inferred defaults', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-verify-'));
    await fs.mkdir(path.join(root, '.deepautocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.deepautocode', 'verify.json'),
      JSON.stringify({
        buildCommand: 'npm run typecheck',
        testCommand: 'npm test',
        combinedCommand: 'npm run typecheck && npm test',
      }),
      'utf-8'
    );

    const cfg = await loadVerifyConfig(root);
    expect(cfg.source).toBe('workspace-file');
    expect(cfg.buildCommand).toBe('npm run typecheck');
    expect(cfg.combinedCommand).toContain('typecheck');
    expect(cfg.enableEvolveSandbox).toBe(true);
    expect(isVerifiableSourcePath('src/foo.ts', cfg)).toBe(true);
  });

  it('honors enableEvolveSandbox=false in verify.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-nosandbox-'));
    await fs.mkdir(path.join(root, '.deepautocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.deepautocode', 'verify.json'),
      JSON.stringify({
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        enableEvolveSandbox: false,
      }),
      'utf-8'
    );
    const cfg = await loadVerifyConfig(root);
    expect(cfg.enableEvolveSandbox).toBe(false);
  });

  it('discovers IDE project-rules.md into workspace customizations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-rules-'));
    await fs.mkdir(path.join(root, '.deepautocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.deepautocode', 'project-rules.md'),
      '# DeepAutoCode Project Rules\n\nAlways run typecheck after edits.\n',
      'utf-8'
    );
    const cust = await discoverWorkspaceCustomizations(root);
    expect(cust.rules.some((r) => r.path.includes('project-rules.md'))).toBe(true);
    expect(cust.rules.some((r) => r.content.includes('typecheck'))).toBe(true);
  });

  it('infers npm verify commands from package.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-infer-'));
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { build: 'tsc', test: 'vitest run' } }),
      'utf-8'
    );
    const cfg = await loadVerifyConfig(root);
    expect(cfg.source).toBe('inferred');
    expect(cfg.buildCommand).toBe('npm run build');
    expect(cfg.testCommand).toBe('npm test');
  });

  it('creates evolve/* sandbox branch in a git workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-git-'));
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@deepautocode.local'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'DeepAutoCode Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), '# t\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });

    const before = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
    const previous = before.stdout.trim();
    const res = await ensureAgentSandboxBranch(root);
    expect(res.enabled).toBe(true);
    expect(res.branch).toMatch(/^evolve\/auto-/);
    expect(res.previousBranch).toBe(previous);

    const after = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
    expect(after.stdout.trim()).toBe(res.branch);
  }, 20000);

  it('circuit-breaker rollback restores originals and deletes created files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-rb-'));
    const modified = path.join(root, 'a.ts');
    const created = path.join(root, 'b.ts');
    await fs.writeFile(modified, 'const x = 1;\n', 'utf-8');
    await fs.writeFile(created, 'export const y = 2;\n', 'utf-8');
    await fs.writeFile(modified, 'const x = 999;\n', 'utf-8');

    const originals = new Map<string, string>([['a.ts', 'const x = 1;\n']]);
    const rb = await rollbackSessionMutations({
      workspaceRoot: root,
      originals,
      createdFiles: ['b.ts'],
    });

    expect(rb.rolledBackFiles.sort()).toEqual(['a.ts', 'b.ts'].sort());
    expect(await fs.readFile(modified, 'utf-8')).toBe('const x = 1;\n');
    await expect(fs.access(created)).rejects.toThrow();
  });
});
