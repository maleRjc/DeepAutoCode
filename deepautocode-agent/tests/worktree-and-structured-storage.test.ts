import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeManager } from '../src/core/WorktreeManager.js';
import {
  StructuredSessionStorage,
  type StoredSessionRecord,
  type StoredMessageRecord,
} from '../src/core/StructuredSessionStorage.js';

const execFileAsync = promisify(execFile);

describe('WorktreeManager & StructuredSessionStorage', () => {
  let tmpRoot: string;
  let repoDir: string;
  let nonRepoDir: string;
  let storageDir: string;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-worktree-test-'));
    repoDir = path.join(tmpRoot, 'repo');
    nonRepoDir = path.join(tmpRoot, 'non-repo');
    storageDir = path.join(tmpRoot, 'storage');

    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(nonRepoDir, { recursive: true });
    await fs.mkdir(storageDir, { recursive: true });

    // Initialize mock git repo
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'DAC Tester'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'tester@deepautocode.com'], { cwd: repoDir });
    await fs.writeFile(path.join(repoDir, 'README.md'), '# Initial Commit\n', 'utf-8');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'chore: initial commit'], { cwd: repoDir });
  });

  afterAll(async () => {
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('WorktreeManager', () => {
    const wm = WorktreeManager.getInstance();

    it('identifies git repositories vs non-git folders', async () => {
      expect(await wm.isGitRepo(repoDir)).toBe(true);
      expect(await wm.isGitRepo(nonRepoDir)).toBe(false);
    });

    it('lists worktrees in repository', async () => {
      const list = await wm.list(repoDir);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list[0].isMain).toBe(true);
    });

    it('creates an isolated worktree and tracks diffs', async () => {
      const sessionId = 'test-session-wt';
      const res = await wm.create({
        workspaceRoot: repoDir,
        sessionId,
      });

      expect(res.ok).toBe(true);
      expect(res.worktree).toBeDefined();
      expect(res.worktree!.id).toBe('test-session-wt');
      expect(await fs.stat(res.worktree!.path)).toBeDefined();

      // Modify file in worktree
      const target = path.join(res.worktree!.path, 'patch.txt');
      await fs.writeFile(target, 'isolated change\n', 'utf-8');

      const diff = await wm.diff(repoDir, res.worktree!.id);
      expect(diff).toBeDefined();

      // Cleanup worktree
      const removed = await wm.remove({
        workspaceRoot: repoDir,
        worktreeId: res.worktree!.id,
        force: true,
        deleteBranch: true,
      });
      expect(removed.ok).toBe(true);
    });
  });

  describe('StructuredSessionStorage', () => {
    it('saves and retrieves structured session metadata', async () => {
      const storage = new StructuredSessionStorage(storageDir);
      const session: StoredSessionRecord = {
        sessionId: 'sess_101',
        title: 'Refactor Authentication',
        workspaceRoot: '/test/workspace',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        executionMode: 'auto',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await storage.saveSession(session);
      const loaded = await storage.getSession('sess_101');
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('Refactor Authentication');

      const list = await storage.listSessions();
      expect(list.some((s) => s.sessionId === 'sess_101')).toBe(true);
    });

    it('appends messages to WAL and retrieves with pagination', async () => {
      const storage = new StructuredSessionStorage(storageDir);
      const sessionId = 'sess_wal_test';

      await storage.saveSession({
        sessionId,
        title: 'WAL Session',
        workspaceRoot: '/test',
        providerId: 'openai',
        modelId: 'gpt-4o',
        executionMode: 'auto',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      for (let i = 1; i <= 5; i++) {
        const msg: StoredMessageRecord = {
          id: `msg_${i}`,
          sessionId,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Message ${i}`,
          createdAt: Date.now() + i * 100,
          turnIndex: i,
        };
        await storage.appendMessage(msg);
      }

      const paged = await storage.getMessages(sessionId, { offset: 1, limit: 3 });
      expect(paged.total).toBe(5);
      expect(paged.messages).toHaveLength(3);
      expect(paged.messages[0].content).toBe('Message 2');

      const reversed = await storage.getMessages(sessionId, { reverse: true, limit: 2 });
      expect(reversed.messages[0].content).toBe('Message 5');
    });

    it('records diffs into diffs.jsonl', async () => {
      const storage = new StructuredSessionStorage(storageDir);
      const sessionId = 'sess_diff_test';

      await storage.saveDiff({
        diffId: 'diff_1',
        sessionId,
        filePath: 'src/main.ts',
        operation: 'modify',
        unifiedDiff: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new',
        status: 'accepted',
        appliedToDisk: true,
        createdAt: new Date().toISOString(),
      });

      const diffs = await storage.getDiffs(sessionId);
      expect(diffs).toHaveLength(1);
      expect(diffs[0].filePath).toBe('src/main.ts');
      expect(diffs[0].status).toBe('accepted');
    });
  });
});
