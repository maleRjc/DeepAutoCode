import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureWorkspaceFiles,
  restoreWorkspaceFiles,
  saveSessionCheckpoint,
  listSessionCheckpoints,
} from '../src/core/SessionCheckpoint.js';
import { resolveTieredModelForTurn } from '../src/core/GoalSteering.js';

describe('SessionCheckpoint + model routing locks', () => {
  let root = '';
  let sessionDir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-ckpt-'));
    sessionDir = path.join(root, 'session');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const x = 1;\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('captures and restores workspace files', async () => {
    const files = await captureWorkspaceFiles(root, ['src/a.ts', 'src/missing.ts']);
    expect(files.find((f) => f.filePath === 'src/a.ts')?.existed).toBe(true);
    expect(files.find((f) => f.filePath === 'src/missing.ts')?.existed).toBe(false);

    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'changed\n');
    const result = await restoreWorkspaceFiles(root, files);
    expect(result.restored).toBe(1);
    const restored = await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf-8');
    expect(restored).toContain('const x = 1');
  });

  it('persists checkpoints under session dir', async () => {
    const ck = await saveSessionCheckpoint(sessionDir, {
      checkpointId: 'ckpt_1',
      sessionId: 's1',
      label: 'test',
      createdAt: new Date().toISOString(),
      files: [{ filePath: 'src/a.ts', content: 'x', existed: true }],
    });
    expect(ck.checkpointId).toBe('ckpt_1');
    const list = await listSessionCheckpoints(sessionDir);
    expect(list.some((c) => c.checkpointId === 'ckpt_1')).toBe(true);
  });

  it('honors force-fast and force-reasoner routing locks', () => {
    const fast = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'why is this failing with #wrong',
      turnIndex: 3,
      selfHealCount: 2,
      routingMode: 'force-fast',
    });
    expect(fast.effectiveModelId).toBe('deepseek-chat');

    const reasoner = resolveTieredModelForTurn({
      configuredModelId: 'deepseek-auto',
      providerId: 'deepseek',
      userPrompt: 'list files',
      turnIndex: 1,
      selfHealCount: 0,
      routingMode: 'force-reasoner',
    });
    expect(reasoner.effectiveModelId).toBe('deepseek-reasoner');
  });
});
