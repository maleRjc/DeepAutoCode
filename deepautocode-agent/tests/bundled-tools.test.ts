import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  augmentEnvWithBundledTools,
  findDeepAutoCodeRepoRoot,
  resolveBundledPandocExe,
} from '../src/core/BundledTools.js';

describe('BundledTools', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const t of temps) {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  it('finds DeepAutoCode repo root from workspace subtree', () => {
    const root = findDeepAutoCodeRepoRoot(path.resolve(process.cwd(), '..'));
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root!, 'deepautocode', 'package.json'))).toBe(true);
  });

  it('prepends bundled pandoc dir to PATH when binary exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-repo-'));
    temps.push(repo);
    fs.mkdirSync(path.join(repo, 'deepautocode'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'deepautocode-agent'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'deepautocode', 'package.json'), '{}');
    fs.writeFileSync(path.join(repo, 'deepautocode-agent', 'package.json'), '{}');

    const pandocDir =
      process.platform === 'win32'
        ? path.join(repo, '.tools', 'pandoc', 'win')
        : path.join(repo, '.tools', 'pandoc', 'linux', 'bin');
    fs.mkdirSync(pandocDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc';
    const binPath = path.join(pandocDir, binName);
    fs.writeFileSync(binPath, '');
    if (process.platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }

    expect(resolveBundledPandocExe(repo)).toBe(binPath);
    const env = augmentEnvWithBundledTools(repo, { PATH: '/usr/bin' });
    const pathVal = env.PATH ?? env.Path ?? '';
    expect(pathVal.startsWith(pandocDir)).toBe(true);
    expect(env.DEEPAUTOCODE_BUNDLED_TOOLS).toContain(pandocDir);
  });
});
