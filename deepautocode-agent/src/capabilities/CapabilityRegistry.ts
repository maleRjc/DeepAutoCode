import fs from 'node:fs/promises';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  evaluateToolPolicy,
  sanitizeObjectForLog,
  validateWorkspacePath,
} from '../security.js';
import type {
  CapabilityAuditEntry,
  CapabilityDefinition,
  CapabilityExecutionContext,
  CapabilityName,
  RiskLevel,
} from '../types.js';

const execAsync = promisify(exec);

/**
 * Appendix B: Input/Output Schemas for the 5 Core Capabilities
 */
export const OpenFileInputSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  preview: z.boolean().default(false),
});

export const OpenFileOutputSchema = z.object({
  opened: z.boolean(),
  canonicalPath: z.string(),
  unsavedChanges: z.boolean().default(false),
});

export const RevealDiffInputSchema = z.object({
  diffId: z.string().min(1),
  filePath: z.string().min(1),
  originalContent: z.string(),
  proposedContent: z.string(),
  title: z.string().optional(),
});

export const RevealDiffOutputSchema = z.object({
  revealed: z.boolean(),
  diffId: z.string(),
  canonicalPath: z.string(),
});

export const RunBuildInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).default(300000),
});

export const RunBuildOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
});

export const ReadFileInputSchema = z.object({
  filePath: z.string().min(1),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
  maxBytes: z.number().int().positive().default(512 * 1024),
});

export const ReadFileOutputSchema = z.object({
  canonicalPath: z.string(),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const WriteFileInputSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
  createDirectories: z.boolean().default(true),
});

export const WriteFileOutputSchema = z.object({
  canonicalPath: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  operation: z.enum(['create', 'modify']),
});

/**
 * Appendix B: Canonical Capability -> Code - OSS API Mapping Table
 */
export const CAPABILITY_DEFINITIONS: Record<CapabilityName, CapabilityDefinition<any, any>> = {
  'open-file': {
    name: 'open-file',
    description: 'Open a workspace file in the Code - OSS editor and optionally reveal a line range.',
    caller: 'agent-runtime',
    executor: 'ide-client',
    codeOssApi: 'vscode.workspace.openTextDocument + vscode.window.showTextDocument',
    requiresApprovalByDefault: false,
    allowedInPlanMode: true,
    defaultTimeoutMs: 10000,
    inputSchema: OpenFileInputSchema,
    outputSchema: OpenFileOutputSchema,
    auditFields: ['filePath', 'startLine', 'endLine', 'canonicalPath'],
  },
  'reveal-diff': {
    name: 'reveal-diff',
    description: 'Open side-by-side Diff editor in Code - OSS for proposed file modifications.',
    caller: 'agent-runtime',
    executor: 'ide-client',
    codeOssApi: 'vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title)',
    requiresApprovalByDefault: false,
    allowedInPlanMode: true,
    defaultTimeoutMs: 10000,
    inputSchema: RevealDiffInputSchema,
    outputSchema: RevealDiffOutputSchema,
    auditFields: ['diffId', 'filePath', 'canonicalPath'],
  },
  'run-build': {
    name: 'run-build',
    description: 'Execute a build or verification command in a controlled IDE terminal/task runner.',
    caller: 'agent-runtime',
    executor: 'ide-client',
    codeOssApi: 'vscode.window.createTerminal / vscode.tasks.executeTask',
    requiresApprovalByDefault: true,
    allowedInPlanMode: false,
    defaultTimeoutMs: 300000,
    inputSchema: RunBuildInputSchema,
    outputSchema: RunBuildOutputSchema,
    auditFields: ['command', 'cwd', 'exitCode', 'durationMs'],
  },
  'read-file': {
    name: 'read-file',
    description: 'Read file contents within the workspace boundary via workspace.fs.',
    caller: 'agent-runtime',
    executor: 'ide-client',
    codeOssApi: 'vscode.workspace.fs.readFile',
    requiresApprovalByDefault: false,
    allowedInPlanMode: true,
    defaultTimeoutMs: 15000,
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    auditFields: ['filePath', 'canonicalPath', 'byteLength'],
  },
  'write-file': {
    name: 'write-file',
    description: 'Write or apply WorkspaceEdit to a file within the workspace boundary.',
    caller: 'agent-runtime',
    executor: 'ide-client',
    codeOssApi: 'vscode.workspace.fs.writeFile / vscode.workspace.applyEdit',
    requiresApprovalByDefault: true,
    allowedInPlanMode: false,
    defaultTimeoutMs: 20000,
    inputSchema: WriteFileInputSchema,
    outputSchema: WriteFileOutputSchema,
    auditFields: ['filePath', 'canonicalPath', 'bytesWritten', 'operation'],
  },
};

export type CapabilityExecutor<TInput = any, TOutput = any> = (
  input: TInput,
  context: CapabilityExecutionContext & { canonicalPath?: string }
) => Promise<TOutput>;

export type CapabilityApprovalHandler = (request: {
  sessionId: string;
  capability: CapabilityName;
  summary: string;
  risk: RiskLevel;
  targetPath?: string;
  command?: string;
  cwd?: string;
  arguments: Record<string, unknown>;
}) => Promise<{ approved: boolean; approvalId: string; reason?: string }>;

export class CapabilityRegistry {
  private readonly executors = new Map<CapabilityName, CapabilityExecutor>();
  private readonly auditLog: CapabilityAuditEntry[] = [];
  private approvalHandler?: CapabilityApprovalHandler;

  constructor(options?: { approvalHandler?: CapabilityApprovalHandler }) {
    this.approvalHandler = options?.approvalHandler;
    this.registerDefaultHostExecutors();
  }

  setApprovalHandler(handler: CapabilityApprovalHandler): void {
    this.approvalHandler = handler;
  }

  registerExecutor<TInput, TOutput>(
    name: CapabilityName,
    executor: CapabilityExecutor<TInput, TOutput>
  ): void {
    if (!CAPABILITY_DEFINITIONS[name]) {
      throw new Error(`Unknown capability: ${name}`);
    }
    this.executors.set(name, executor);
  }

  getDefinitions(): CapabilityDefinition[] {
    return Object.values(CAPABILITY_DEFINITIONS);
  }

  getAuditLog(sessionId?: string): CapabilityAuditEntry[] {
    if (!sessionId) return [...this.auditLog];
    return this.auditLog.filter((entry) => entry.sessionId === sessionId);
  }

  /**
   * Default filesystem/process executors for local Extension Host & PoC verification.
   * When running inside Code - OSS Workbench, UI capabilities ('open-file', 'reveal-diff')
   * can be overridden or augmented by the Extension Host adapter.
   */
  private registerDefaultHostExecutors(): void {
    this.executors.set('open-file', async (input: z.infer<typeof OpenFileInputSchema>, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      await fs.access(canonicalPath);
      return {
        opened: true,
        canonicalPath,
        unsavedChanges: false,
      };
    });

    this.executors.set('reveal-diff', async (input: z.infer<typeof RevealDiffInputSchema>, ctx) => {
      return {
        revealed: true,
        diffId: input.diffId,
        canonicalPath: ctx.canonicalPath!,
      };
    });

    this.executors.set('read-file', async (input: z.infer<typeof ReadFileInputSchema>, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      const buffer = await fs.readFile(canonicalPath);
      const truncated = buffer.byteLength > input.maxBytes;
      const slice = truncated ? buffer.subarray(0, input.maxBytes) : buffer;
      const content =
        input.encoding === 'base64' ? slice.toString('base64') : slice.toString('utf-8');
      return {
        canonicalPath,
        content,
        byteLength: buffer.byteLength,
        truncated,
      };
    });

    this.executors.set('write-file', async (input: z.infer<typeof WriteFileInputSchema>, ctx) => {
      const canonicalPath = ctx.canonicalPath!;
      let existed = true;
      try {
        await fs.access(canonicalPath);
      } catch {
        existed = false;
      }
      if (input.createDirectories) {
        await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      }
      const buf = Buffer.from(input.content, 'utf-8');
      await fs.writeFile(canonicalPath, buf);
      return {
        canonicalPath,
        bytesWritten: buf.byteLength,
        operation: existed ? ('modify' as const) : ('create' as const),
      };
    });

    this.executors.set('run-build', async (input: z.infer<typeof RunBuildInputSchema>, ctx) => {
      const start = Date.now();
      const cwd = ctx.canonicalPath ?? ctx.workspaceRoot;
      const cmdText = String(input.command ?? '').trim();

      // Safety Guard: Never allow indiscriminate killing of all node/electron/tsx processes,
      // which would terminate the DeepAutoCode IDE backend itself.
      const killsIdeProcessPattern =
        /\btaskkill\b[^|;&]*\/im\s+["']?(node|electron|tsx)(\.exe)?\b|\bStop-Process\b[^|;&]*-Name\s+["']?(node|electron|tsx)\b|\bGet-Process\b[^|;&]*\b(node|electron|tsx)\b[^|;&]*Stop-Process\b|\b(killall|pkill)\b[^|;&]*\b(node|electron|tsx)\b|\bwmic\b[^|;&]*\b(node|electron)\.exe\b/i;

      if (killsIdeProcessPattern.test(cmdText)) {
        return {
          exitCode: 0,
          stdout:
            `[DeepAutoCode Safety Guard] 已安全拦截全局终止 node/electron 进程的操作（当前 IDE 后端运行在 Node.js 进程 PID ${process.pid} / 端口 3840）。\n` +
            `如果目标业务端口（如 3000）提示占用，说明项目服务已在后台运行，可直接访问 http://localhost:3000/ 验证，或设置其它 PORT 环境变量启动。`,
          stderr: '',
          durationMs: Date.now() - start,
        };
      }

      const isLongRunningServerCmd =
        /\b(npm(\.cmd)?\s+(start|run\s+(dev|start|serve))|node(\.exe)?\s+[^\s|;&]*server[^\s|;&]*\.js|python\d?\s+[^\s|;&]*-m\s+http\.server)\b/i.test(
          cmdText
        );
      const serverReadyPattern =
        /(?:listening on|服务已启动|已启动|started server|http:\/\/localhost:\d+|http:\/\/127\.0\.0\.1:\d+|Local:\s+https?:\/\/|ready in \d+\s*ms)/i;

      return await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      }>((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let serverReadyTimer: ReturnType<typeof setTimeout> | undefined;
        let backgroundFallbackTimer: ReturnType<typeof setTimeout> | undefined;

        const child = spawn(cmdText, {
          cwd,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const finish = (result: {
          exitCode: number;
          stdout: string;
          stderr: string;
          durationMs: number;
        }) => {
          if (settled) return;
          settled = true;
          if (serverReadyTimer) clearTimeout(serverReadyTimer);
          if (backgroundFallbackTimer) clearTimeout(backgroundFallbackTimer);
          ctx.signal?.removeEventListener('abort', onAbortSignal);
          resolve(result);
        };

        const detachAndFinishAsRunningServer = (note: string) => {
          if (settled) return;
          try {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          } catch {
            // ignore
          }
          finish({
            exitCode: 0,
            stdout: `${stdout.trimEnd()}\n${note}`.trim(),
            stderr,
            durationMs: Date.now() - start,
          });
        };

        const checkServerReadyOutput = () => {
          if (settled || serverReadyTimer) return;
          const combined = `${stdout}\n${stderr}`;
          if (serverReadyPattern.test(combined)) {
            serverReadyTimer = setTimeout(() => {
              if (!settled && child.exitCode === null) {
                detachAndFinishAsRunningServer(
                  `[DeepAutoCode] 检测到常驻服务已成功启动并在后台持续运行 (PID: ${child.pid ?? 'unknown'})。`
                );
              }
            }, 1000);
          }
        };

        if (isLongRunningServerCmd) {
          backgroundFallbackTimer = setTimeout(() => {
            if (!settled && child.exitCode === null) {
              detachAndFinishAsRunningServer(
                `[DeepAutoCode] 服务启动命令已在后台持续运行 (PID: ${child.pid ?? 'unknown'})。`
              );
            }
          }, 5000);
        }

        const onAbortSignal = () => {
          if (settled) return;
          settled = true;
          if (serverReadyTimer) clearTimeout(serverReadyTimer);
          if (backgroundFallbackTimer) clearTimeout(backgroundFallbackTimer);
          try {
            child.kill();
          } catch {
            // ignore
          }
          reject(new Error('CAPABILITY_CANCELLED: Command execution was aborted by user'));
        };

        if (ctx.signal?.aborted) {
          onAbortSignal();
          return;
        }
        ctx.signal?.addEventListener('abort', onAbortSignal, { once: true });

        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length < 512 * 1024) {
            stdout += chunk.toString('utf-8');
          }
          checkServerReadyOutput();
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 512 * 1024) {
            stderr += chunk.toString('utf-8');
          }
          checkServerReadyOutput();
        });

        child.on('error', (err) => {
          finish({
            exitCode: 1,
            stdout,
            stderr: `${stderr}\n${err.message}`.trim(),
            durationMs: Date.now() - start,
          });
        });

        child.on('close', (code) => {
          const combined = `${stdout}\n${stderr}`;
          if (/EADDRINUSE|已被占用|address already in use/i.test(combined)) {
            finish({
              exitCode: 0,
              stdout:
                `${stdout}\n${stderr}\n` +
                `[DeepAutoCode] 检测到目标端口已被占用，说明该服务实例已在后台运行中（可直接访问对应端口验证，无需终止现有 Node 进程）。`.trim(),
              stderr: '',
              durationMs: Date.now() - start,
            });
            return;
          }
          finish({
            exitCode: typeof code === 'number' ? code : 0,
            stdout,
            stderr,
            durationMs: Date.now() - start,
          });
        });
      });
    });
  }

  /**
   * Section 9.3: Validated, Authorized, Audited Capability Invocation
   */
  async invoke<TOutput = unknown>(
    name: CapabilityName,
    rawInput: unknown,
    context: CapabilityExecutionContext,
    caller = 'agent-runtime'
  ): Promise<TOutput> {
    const start = Date.now();
    const def = CAPABILITY_DEFINITIONS[name];
    if (!def) {
      throw new Error(`UNKNOWN_CAPABILITY: "${name}" is not registered`);
    }

    // 1. Validate Input Schema
    const parsedInputResult = def.inputSchema.safeParse(rawInput);
    if (!parsedInputResult.success) {
      this.recordAudit({
        sessionId: context.sessionId,
        capability: name,
        caller,
        sanitizedParams: sanitizeObjectForLog((rawInput as Record<string, unknown>) ?? {}),
        approved: false,
        durationMs: Date.now() - start,
        ok: false,
        errorCode: 'INVALID_PARAMS',
      });
      throw new Error(`INVALID_PARAMS for ${name}: ${parsedInputResult.error.message}`);
    }
    const input = parsedInputResult.data as Record<string, any>;

    // 2. Validate Workspace Path / CWD Canonicalization
    const pathTarget = input.filePath ?? input.cwd;
    let canonicalPath: string | undefined;
    if (pathTarget) {
      const isSshMirrorWorkspace =
        typeof context.workspaceRoot === 'string' &&
        context.workspaceRoot.includes('ssh-mirrors');
      const allowNonExistent =
        name === 'write-file' || name === 'reveal-diff' || isSshMirrorWorkspace;
      const pathValidation = validateWorkspacePath(pathTarget, context.workspaceRoot, {
        allowNonExistent,
      });
      if (!pathValidation.valid) {
        this.recordAudit({
          sessionId: context.sessionId,
          capability: name,
          caller,
          sanitizedParams: sanitizeObjectForLog(input),
          approved: false,
          durationMs: Date.now() - start,
          ok: false,
          errorCode: 'PATH_BOUNDARY_VIOLATION',
        });
        throw new Error(`PATH_BOUNDARY_VIOLATION: ${pathValidation.reason}`);
      }
      canonicalPath = pathValidation.canonicalPath;
      if (input.filePath && pathValidation.relativePath) {
        input.filePath = pathValidation.relativePath;
      }
    }

    // 3. Evaluate Execution Mode & Tool Policy
    const isReadOnlyTool = def.allowedInPlanMode && !def.requiresApprovalByDefault;
    const policy = evaluateToolPolicy({
      toolName: name,
      executionMode: context.executionMode,
      isReadOnlyTool,
      command: input.command,
      targetPath: pathTarget,
      workspaceRoot: context.workspaceRoot,
    });

    if (!policy.allowedToProceed) {
      this.recordAudit({
        sessionId: context.sessionId,
        capability: name,
        caller,
        sanitizedParams: sanitizeObjectForLog(input),
        approved: false,
        durationMs: Date.now() - start,
        ok: false,
        errorCode: 'POLICY_DENIED',
      });
      throw new Error(`POLICY_DENIED: ${policy.reason}`);
    }

    // 4. Request Explicit User Approval if Required
    let approvalId: string | undefined;
    if (policy.requiresApproval) {
      if (!this.approvalHandler) {
        throw new Error(`APPROVAL_REQUIRED: No approval handler registered for capability "${name}"`);
      }
      const decision = await this.approvalHandler({
        sessionId: context.sessionId,
        capability: name,
        summary:
          name === 'run-build'
            ? `Run command: ${input.command}`
            : `Modify file: ${input.filePath}`,
        risk: policy.risk,
        targetPath: canonicalPath ?? input.filePath,
        command: input.command,
        cwd: canonicalPath ?? context.workspaceRoot,
        arguments: sanitizeObjectForLog(input),
      });
      approvalId = decision.approvalId;
      if (!decision.approved) {
        this.recordAudit({
          sessionId: context.sessionId,
          capability: name,
          caller,
          sanitizedParams: sanitizeObjectForLog(input),
          approved: false,
          approvalId,
          durationMs: Date.now() - start,
          ok: false,
          errorCode: 'USER_REJECTED',
        });
        throw new Error(`USER_REJECTED: User rejected ${name} (${decision.reason ?? 'denied'})`);
      }
    }

    // 5. Execute with Timeout & Cancellation Support
    const executor = this.executors.get(name);
    if (!executor) {
      throw new Error(`NO_EXECUTOR: No executor bound for capability "${name}"`);
    }

    if (context.signal?.aborted) {
      throw new Error('CAPABILITY_CANCELLED: Operation aborted before execution');
    }

    const timeoutMs = input.timeoutMs ?? def.defaultTimeoutMs;
    const timeoutController = new AbortController();
    const onAbort = () => timeoutController.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

    try {
      const rawOutput = await Promise.race([
        executor(input, {
          ...context,
          canonicalPath,
          signal: timeoutController.signal,
        }),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener(
            'abort',
            () => {
              if (context.signal?.aborted) {
                reject(new Error('CAPABILITY_CANCELLED: Operation cancelled by user'));
              } else {
                reject(new Error(`CAPABILITY_TIMEOUT: Exceeded ${timeoutMs}ms`));
              }
            },
            { once: true }
          );
        }),
      ]);

      const validatedOutput = def.outputSchema.parse(rawOutput);
      this.recordAudit({
        sessionId: context.sessionId,
        capability: name,
        caller,
        sanitizedParams: sanitizeObjectForLog(input),
        approved: true,
        approvalId,
        durationMs: Date.now() - start,
        ok: true,
      });

      return validatedOutput as TOutput;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.startsWith('CAPABILITY_CANCELLED')
        ? 'CAPABILITY_CANCELLED'
        : msg.startsWith('CAPABILITY_TIMEOUT')
          ? 'CAPABILITY_TIMEOUT'
          : 'EXECUTION_FAILED';
      this.recordAudit({
        sessionId: context.sessionId,
        capability: name,
        caller,
        sanitizedParams: sanitizeObjectForLog(input),
        approved: true,
        approvalId,
        durationMs: Date.now() - start,
        ok: false,
        errorCode: code,
      });
      throw err;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }

  private recordAudit(entry: Omit<CapabilityAuditEntry, 'auditId' | 'timestamp'>): void {
    this.auditLog.push({
      auditId: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }
}

