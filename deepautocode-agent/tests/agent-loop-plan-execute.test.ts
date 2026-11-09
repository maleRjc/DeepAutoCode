import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  SessionReadCache,
  computeDynamicMaxIterations,
  isPreflightableEditTool,
  preflightEditBatch,
  type AgentModelAdapter,
  type AgentModelStreamRequest,
} from '../src/core/AgentLoop.js';
import type { AgentLoopPhase } from '../src/core/DeepSeekModels.js';
import { createTool, type AgentTool } from '../src/core/ToolSuite.js';
import { DEFAULT_VERIFY_CONFIG } from '../src/core/VerifyConfig.js';

describe('Batch A + C3 + D2: AgentLoop Plan-Execute-Verify & Preflight & SessionReadCache', () => {
  it('A3: computes dynamic maxIterations as min(75, 10 + todoCount * 5)', () => {
    expect(computeDynamicMaxIterations(0)).toBe(10);
    expect(computeDynamicMaxIterations(3)).toBe(25);
    expect(computeDynamicMaxIterations(10)).toBe(60);
    expect(computeDynamicMaxIterations(20)).toBe(75);
    expect(computeDynamicMaxIterations(5, 30)).toBe(30);
  });

  it('A2: preflights edit_file in parallel and detects missing oldText before writing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-preflight-'));
    try {
      const fileA = path.join(tmpDir, 'a.ts');
      const fileB = path.join(tmpDir, 'b.ts');
      await fs.writeFile(fileA, 'export const a = 1;\n', 'utf-8');
      await fs.writeFile(fileB, 'export const b = 2;\n', 'utf-8');

      expect(isPreflightableEditTool('edit_file')).toBe(true);
      expect(isPreflightableEditTool('run_command')).toBe(false);

      const batchResults = await preflightEditBatch(
        [
          {
            id: 'call_1',
            name: 'edit_file',
            args: { path: 'a.ts', oldText: 'export const a = 1;', newText: 'export const a = 10;' },
          },
          {
            id: 'call_2',
            name: 'edit_file',
            args: { path: 'b.ts', oldText: 'NON_EXISTENT_LINE', newText: 'export const b = 20;' },
          },
        ],
        tmpDir
      );

      expect(batchResults.get('call_1')?.ok).toBe(true);
      expect(batchResults.get('call_2')?.ok).toBe(false);
      expect(batchResults.get('call_2')?.reason).toContain('PREFLIGHT_OLD_TEXT_NOT_FOUND');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('C3: caches read-only file calls across turns and invalidates when file mtimeMs changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-readcache-'));
    try {
      const targetPath = path.join(tmpDir, 'hello.txt');
      await fs.writeFile(targetPath, 'v1', 'utf-8');

      const cache = new SessionReadCache(tmpDir);
      cache.set('read_file:{"path":"hello.txt"}', { output: { content: 'v1' }, count: 1 }, { path: 'hello.txt' });

      const hit1 = cache.get('read_file:{"path":"hello.txt"}', { path: 'hello.txt' });
      expect(hit1).toBeDefined();
      expect(hit1?.output).toEqual({ content: 'v1' });

      // Simulate disk edit updating mtimeMs
      const futureTime = new Date(Date.now() + 5000);
      await fs.writeFile(targetPath, 'v2', 'utf-8');
      await fs.utimes(targetPath, futureTime, futureTime);

      const hit2 = cache.get('read_file:{"path":"hello.txt"}', { path: 'hello.txt' });
      expect(hit2).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('A1 + B2 + D2: runs Plan -> Exec -> hard-bound Verify gate, retries with max reasoning on verify failure, and succeeds', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dac-pev-'));
    try {
      const srcFile = path.join(tmpDir, 'math.ts');
      await fs.writeFile(srcFile, 'export const val = 1;\n', 'utf-8');

      const recordedPhases: Array<{ phase?: AgentLoopPhase; reasoningEffort?: string | null }> = [];
      let verifyCount = 0;
      let execTurn = 0;

      const model: AgentModelAdapter = {
        stream: async function* (req: AgentModelStreamRequest) {
          recordedPhases.push({
            phase: req.phase,
            reasoningEffort: req.reasoningEffort,
          });

          if (req.phase === 'plan') {
            yield {
              type: 'text-delta',
              text: '1. Read math.ts\n2. Update val to 42\n3. Run verification',
            };
            yield { type: 'finish' };
            return;
          }

          execTurn += 1;
          if (execTurn === 1) {
            // First EXEC turn: mutate file using edit_file
            yield {
              type: 'tool-call-delta',
              toolCallId: 'tc_edit_1',
              toolName: 'edit_file',
              input: {
                path: 'math.ts',
                oldText: 'export const val = 1;',
                newText: 'export const val = 2;',
              },
            };
            yield { type: 'finish' };
            return;
          }

          if (execTurn === 2) {
            // Finish first exec phase -> triggers hard-bound runVerify (which will fail first time)
            yield {
              type: 'text-delta',
              text: 'Initial edit completed.',
            };
            yield { type: 'finish' };
            return;
          }

          if (execTurn === 3) {
            // Retry EXEC after verify gate failure (should have reasoningEffort = 'max')
            yield {
              type: 'tool-call-delta',
              toolCallId: 'tc_edit_2',
              toolName: 'edit_file',
              input: {
                path: 'math.ts',
                oldText: 'export const val = 2;',
                newText: 'export const val = 42;',
              },
            };
            yield { type: 'finish' };
            return;
          }

          yield {
            type: 'text-delta',
            text: 'Fixed math.ts to 42 and verified.',
          };
          yield { type: 'finish' };
        },
      };

      const tools: AgentTool<any, any>[] = [
        createTool({
          name: 'edit_file',
          description: 'Edit a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
          },
          execute: async (args: { path: string; oldText: string; newText: string }) => {
            const full = path.join(tmpDir, args.path);
            const current = await fs.readFile(full, 'utf-8');
            const updated = current.replace(args.oldText, args.newText);
            await fs.writeFile(full, updated, 'utf-8');
            return { ok: true };
          },
        }),
        createTool({
          name: 'run_command',
          description: 'Run verification command',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
          },
          execute: async () => {
            verifyCount += 1;
            const current = await fs.readFile(srcFile, 'utf-8');
            if (!current.includes('42')) {
              return {
                exitCode: 1,
                stdout: '',
                stderr: 'AssertionError: expected val to be 42, got 2',
              };
            }
            return {
              exitCode: 0,
              stdout: 'All tests passed',
              stderr: '',
            };
          },
        }),
      ];

      const agent = new Agent({
        sessionId: 'test_session_pev',
        model,
        tools,
        systemPrompt: 'You are DeepAutoCode agent.',
        workspaceRoot: tmpDir,
        enablePlanPhase: true,
        enforceVerifyGate: true,
        verifyConfig: {
          ...DEFAULT_VERIFY_CONFIG,
          buildCommand: 'npm run build',
          testCommand: 'npm test',
        },
      });

      const result = await agent.run('Please update math.ts val to 42 and verify it builds and passes tests');

      expect(result.status).toBe('completed');
      expect(verifyCount).toBeGreaterThanOrEqual(2);
      // Plan phase uses 'high' reasoning effort
      expect(recordedPhases[0]).toEqual({ phase: 'plan', reasoningEffort: 'high' });
      // Normal exec phase uses 'low' reasoning effort
      expect(recordedPhases[1]).toEqual({ phase: 'exec', reasoningEffort: 'low' });
      // Retry after verify gate failure upgrades reasoning effort to 'max'
      expect(recordedPhases.some((p) => p.phase === 'exec' && p.reasoningEffort === 'max')).toBe(true);

      const finalFileContent = await fs.readFile(srcFile, 'utf-8');
      expect(finalFileContent).toContain('export const val = 42;');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
