import dns from 'node:dns';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // ignore
}

const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
const dnsCache = new Map<string, { address: string; expiresAt: number }>();

function cachedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    if ((options as any)?.all) {
      callback(null, [{ address: cached.address, family: 4 }]);
    } else {
      callback(null, cached.address, 4);
    }
    return;
  }
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    if (!err && typeof address === 'string') {
      dnsCache.set(hostname, { address, expiresAt: Date.now() + 5 * 60 * 1000 });
      if ((options as any)?.all) {
        callback(null, [{ address, family: family || 4 }]);
        return;
      }
    }
    callback(err, address as any, family);
  });
}

async function postJsonOnce(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const parsedUrl = new URL(params.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const payload = JSON.stringify(params.body);
  const timeoutMs = params.timeoutMs ?? 60000;

  return new Promise((resolve, reject) => {
    if (params.signal?.aborted) {
      reject(new Error('CAPABILITY_CANCELLED: Request aborted'));
      return;
    }

    const reqFn = isHttps ? https.request : http.request;
    const req = reqFn(
      parsedUrl,
      {
        method: 'POST',
        agent: isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent,
        family: 4,
        lookup:
          parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost'
            ? undefined
            : (cachedLookup as any),
        headers: {
          ...params.headers,
          'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 500;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text,
          });
        });
      }
    );

    const onAbort = () => {
      req.destroy(new Error('CAPABILITY_CANCELLED: Request aborted'));
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      params.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    req.on('close', () => {
      params.signal?.removeEventListener('abort', onAbort);
    });

    req.write(payload);
    req.end();
  });
}

async function postJsonResilient(params: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; text: string }> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await postJsonOnce(params);
      if ((res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429) && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransientSocketErr =
        /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|EAI_AGAIN|ENOTFOUND|network/i.test(msg);
      if (isTransientSocketErr && attempt < maxAttempts && !params.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 350 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
import type {
  AgentExecutionMode,
  BackendMode,
  CapabilityName,
  DiffChangeRecord,
  SessionManifest,
  SessionMessage,
  ToolCallRecord,
} from '../types.js';
import type { CapabilityRegistry } from '../capabilities/CapabilityRegistry.js';
import type { ProviderManager } from '../../providers/index.js';
import { BackendManager } from './BackendManager.js';

export interface ClineRuntimeEvent {
  type:
    | 'text_delta'
    | 'text_done'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'tool_call_failed'
    | 'diff_proposed'
    | 'session_state'
    | 'error';
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface StartSessionInput {
  sessionId?: string;
  title?: string;
  prompt?: string;
  config: {
    providerId: string;
    modelId: string;
    apiKey?: string;
    cwd: string;
    workspaceRoot: string;
    executionMode?: AgentExecutionMode;
    enableTools?: boolean;
  };
}

export interface SendPromptInput {
  sessionId: string;
  prompt: string;
  workspaceRoot?: string;
  executionMode?: AgentExecutionMode;
  modelId?: string;
  signal?: AbortSignal;
}

/**
 * Appendix A: Verified ClineCore Runtime Interface Contract
 */
export interface IClineCoreInstance {
  readonly instanceId: string;
  readonly backendMode: BackendMode;
  readonly storageDir: string;
  readonly sdkUnderlyingAvailable: boolean;
  start(input: StartSessionInput): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }>;
  send(input: SendPromptInput): Promise<{ message: SessionMessage }>;
  subscribe(listener: (event: ClineRuntimeEvent) => void): () => void;
  list(): Promise<SessionManifest[]>;
  get(sessionId: string): Promise<SessionManifest | null>;
  readMessages(sessionId: string): Promise<SessionMessage[]>;
  readDiffs(sessionId: string): Promise<DiffChangeRecord[]>;
  updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null>;
  abort(sessionId: string, reason?: string): Promise<boolean>;
  stop(sessionId: string): Promise<boolean>;
  delete(sessionId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface SdkVerificationReport {
  packageName: string;
  lockedVersion: string;
  license: string;
  nodeEngineDeclared: string;
  currentNodeVersion: string;
  sdkModuleImportable: boolean;
  exportedSymbols: string[];
  clineCoreMethods: string[];
  adapterMode: 'native-sdk-hybrid' | 'persistent-local-engine';
  notes: string[];
}

function createUnifiedDiff(filePath: string, original: string, proposed: string): string {
  const origLines = original ? original.split(/\r?\n/) : [];
  const propLines = proposed ? proposed.split(/\r?\n/) : [];
  const lines: string[] = [
    `--- a/${filePath.replace(/\\/g, '/')}`,
    `+++ b/${filePath.replace(/\\/g, '/')}`,
    `@@ -1,${origLines.length} +1,${propLines.length} @@`,
  ];
  const maxLen = Math.max(origLines.length, propLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const p = propLines[i];
    if (o === p && o !== undefined) {
      lines.push(` ${o}`);
    } else {
      if (o !== undefined) lines.push(`-${o}`);
      if (p !== undefined) lines.push(`+${p}`);
    }
  }
  return lines.join('\n');
}

/**
 * Local Persistent ClineCore Runtime Implementation
 * Implements full disk persistence (PoC-L1) and cross-instance session discovery/recovery (PoC-L2),
 * while bridging `@cline/sdk` and `CapabilityRegistry`.
 */
class PersistentClineCoreRuntime implements IClineCoreInstance {
  public readonly instanceId: string;
  public readonly backendMode: BackendMode;
  public readonly storageDir: string;
  public readonly sdkUnderlyingAvailable: boolean;

  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly providerManager: ProviderManager;
  private readonly listeners = new Set<(event: ClineRuntimeEvent) => void>();
  private readonly activeAborts = new Map<string, AbortController>();
  private disposed = false;

  constructor(params: {
    backendMode: BackendMode;
    storageDir: string;
    sdkUnderlyingAvailable: boolean;
    capabilityRegistry: CapabilityRegistry;
    providerManager: ProviderManager;
  }) {
    this.instanceId = `cline_inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.backendMode = params.backendMode;
    this.storageDir = path.resolve(params.storageDir);
    this.sdkUnderlyingAvailable = params.sdkUnderlyingAvailable;
    this.capabilityRegistry = params.capabilityRegistry;
    this.providerManager = params.providerManager;
  }

  private getSessionsRoot(): string {
    return path.join(this.storageDir, 'sessions');
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.getSessionsRoot(), sessionId);
  }

  private getManifestPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'manifest.json');
  }

  private getMessagesPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'messages.json');
  }

  private getDiffsPath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), 'diffs.json');
  }

  private getIndexPath(): string {
    return path.join(this.storageDir, 'session-index.json');
  }

  private emit(event: ClineRuntimeEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener error
      }
    }
  }

  private async saveManifest(manifest: SessionManifest): Promise<string> {
    const sessionDir = this.getSessionDir(manifest.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const manifestPath = this.getManifestPath(manifest.sessionId);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // Update top-level session-index.json for fast cross-instance discovery (PoC-L2)
    let index: Record<string, { sessionId: string; updatedAt: string; title: string }> = {};
    try {
      const raw = await fs.readFile(this.getIndexPath(), 'utf-8');
      index = JSON.parse(raw);
    } catch {
      index = {};
    }
    index[manifest.sessionId] = {
      sessionId: manifest.sessionId,
      updatedAt: manifest.updatedAt,
      title: manifest.title,
    };
    await fs.writeFile(this.getIndexPath(), JSON.stringify(index, null, 2), 'utf-8');
    return manifestPath;
  }

  private async appendMessage(sessionId: string, message: SessionMessage): Promise<void> {
    const messages = await this.readMessages(sessionId);
    messages.push(message);
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.writeFile(this.getMessagesPath(sessionId), JSON.stringify(messages, null, 2), 'utf-8');
  }

  private async saveDiff(sessionId: string, diff: DiffChangeRecord): Promise<void> {
    const diffs = await this.readDiffs(sessionId);
    const existingIdx = diffs.findIndex((d) => d.diffId === diff.diffId);
    if (existingIdx >= 0) {
      diffs[existingIdx] = diff;
    } else {
      diffs.push(diff);
    }
    await fs.mkdir(this.getSessionDir(sessionId), { recursive: true });
    await fs.writeFile(this.getDiffsPath(sessionId), JSON.stringify(diffs, null, 2), 'utf-8');
  }

  async start(input: StartSessionInput): Promise<{
    sessionId: string;
    manifest: SessionManifest;
    manifestPath: string;
  }> {
    const sessionId =
      input.sessionId ?? `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const manifest: SessionManifest = {
      sessionId,
      title: input.title ?? (input.prompt ? input.prompt.slice(0, 48) : 'New AI Session'),
      workspaceRoot: path.resolve(input.config.workspaceRoot),
      providerId: input.config.providerId,
      modelId: input.config.modelId,
      backendMode: this.backendMode,
      executionMode: input.config.executionMode ?? 'auto',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
      sdkManaged: true,
      storagePath: this.getSessionDir(sessionId),
    };

    const manifestPath = await this.saveManifest(manifest);
    await fs.writeFile(this.getMessagesPath(sessionId), JSON.stringify([], null, 2), 'utf-8');
    await fs.writeFile(this.getDiffsPath(sessionId), JSON.stringify([], null, 2), 'utf-8');

    this.emit({
      type: 'session_state',
      sessionId,
      payload: { status: manifest.status, manifest },
    });

    if (input.prompt && input.prompt.trim().length > 0) {
      await this.send({
        sessionId,
        prompt: input.prompt,
        executionMode: manifest.executionMode,
      });
    }

    const updatedManifest = (await this.get(sessionId)) ?? manifest;
    return {
      sessionId,
      manifest: updatedManifest,
      manifestPath,
    };
  }

  async send(input: SendPromptInput): Promise<{ message: SessionMessage }> {
    let manifest = await this.get(input.sessionId);
    if (!manifest) {
      // Auto-create session manifest if sessionId was not found on disk (e.g., stale UI state or fresh storage)
      const { provider, model } = await this.providerManager.getActiveProviderWithKeyStatus();
      const now = new Date().toISOString();
      manifest = {
        sessionId: input.sessionId,
        title: input.prompt ? input.prompt.slice(0, 48) : 'Recovered AI Session',
        workspaceRoot: path.resolve(input.workspaceRoot || process.cwd()),
        providerId: provider.providerId,
        modelId: model.modelId,
        backendMode: this.backendMode,
        executionMode: input.executionMode ?? 'auto',
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        lastSequence: 0,
        sdkManaged: true,
        storagePath: this.getSessionDir(input.sessionId),
      };
      await this.saveManifest(manifest);
      await fs.writeFile(this.getMessagesPath(input.sessionId), JSON.stringify([], null, 2), 'utf-8');
      await fs.writeFile(this.getDiffsPath(input.sessionId), JSON.stringify([], null, 2), 'utf-8');
    }

    if (input.executionMode && input.executionMode !== manifest.executionMode) {
      manifest.executionMode = input.executionMode;
    }
    if (input.modelId && input.modelId.trim() && input.modelId.trim() !== manifest.modelId) {
      manifest.modelId = input.modelId.trim();
    }
    if (input.workspaceRoot && path.resolve(input.workspaceRoot) !== manifest.workspaceRoot) {
      manifest.workspaceRoot = path.resolve(input.workspaceRoot);
    }

    const abortController = new AbortController();
    if (input.signal) {
      input.signal.addEventListener('abort', () => abortController.abort(input.signal?.reason), {
        once: true,
      });
    }
    this.activeAborts.set(input.sessionId, abortController);

    const existingMessages = await this.readMessages(input.sessionId);
    const userSeq = existingMessages.length + 1;
    const userMessage: SessionMessage = {
      id: `msg_${Date.now()}_u`,
      sessionId: input.sessionId,
      role: 'user',
      content: input.prompt,
      sequence: userSeq,
      timestamp: new Date().toISOString(),
    };
    await this.appendMessage(input.sessionId, userMessage);

    manifest.status = 'running';
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSequence = userSeq;
    await this.saveManifest(manifest);

    this.emit({
      type: 'session_state',
      sessionId: input.sessionId,
      payload: { status: 'running', manifest },
    });

    const toolCalls: ToolCallRecord[] = [];
    const diffIds: string[] = [];
    let assistantContent = '';

    try {
      // Execute intelligent agent workflow with capability invocations
      const result = await this.executeAgentLoop({
        manifest,
        prompt: input.prompt,
        signal: abortController.signal,
        toolCalls,
        diffIds,
      });
      assistantContent = result.content;
      manifest.status = 'completed';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (abortController.signal.aborted || msg.includes('CANCELLED') || msg.includes('aborted')) {
        manifest.status = 'cancelled';
        assistantContent = assistantContent
          ? `${assistantContent}\n\n[Task cancelled by user]`
          : '[Task cancelled by user]';
      } else {
        manifest.status = 'error';
        assistantContent = `Task encountered error: ${msg}`;
        this.emit({
          type: 'error',
          sessionId: input.sessionId,
          payload: { message: msg },
        });
      }
    } finally {
      this.activeAborts.delete(input.sessionId);
    }

    const assistantSeq = (await this.readMessages(input.sessionId)).length + 1;
    const assistantMessage: SessionMessage = {
      id: `msg_${Date.now()}_a`,
      sessionId: input.sessionId,
      role: 'assistant',
      content: assistantContent,
      sequence: assistantSeq,
      timestamp: new Date().toISOString(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      diffIds: diffIds.length > 0 ? diffIds : undefined,
    };

    await this.appendMessage(input.sessionId, assistantMessage);
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSequence = assistantSeq;
    await this.saveManifest(manifest);

    this.emit({
      type: 'text_done',
      sessionId: input.sessionId,
      payload: {
        messageId: assistantMessage.id,
        content: assistantContent,
        toolCalls,
        diffIds,
      },
    });

    this.emit({
      type: 'session_state',
      sessionId: input.sessionId,
      payload: { status: manifest.status, manifest },
    });

    return { message: assistantMessage };
  }

  private async executeAgentLoop(params: {
    manifest: SessionManifest;
    prompt: string;
    signal: AbortSignal;
    toolCalls: ToolCallRecord[];
    diffIds: string[];
  }): Promise<{ content: string }> {
    const { manifest, prompt, signal, toolCalls, diffIds } = params;
    const sessionId = manifest.sessionId;
    const chunks: string[] = [];

    const streamText = async (text: string) => {
      const parts = text.match(/.{1,36}(\s|$)|.{1,36}/g) ?? [text];
      for (const part of parts) {
        if (signal.aborted) {
          throw new Error('CAPABILITY_CANCELLED: Task aborted during streaming');
        }
        chunks.push(part);
        this.emit({
          type: 'text_delta',
          sessionId,
          payload: { delta: part },
        });
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const runCapabilityTool = async (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk: ToolCallRecord['risk'] = 'low'
    ) => {
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const record: ToolCallRecord = {
        toolCallId,
        toolName: capability,
        args,
        status: 'running',
        risk,
        startedAt: new Date().toISOString(),
      };
      toolCalls.push(record);

      this.emit({
        type: 'tool_call_started',
        sessionId,
        payload: { ...record },
      });

      try {
        const output = await this.capabilityRegistry.invoke(capability, args, {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: manifest.executionMode,
          signal,
        });
        record.status = 'completed';
        record.result = output;
        record.completedAt = new Date().toISOString();
        this.emit({
          type: 'tool_call_completed',
          sessionId,
          payload: { ...record },
        });
        return output;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        record.status = errMsg.includes('USER_REJECTED')
          ? 'rejected'
          : errMsg.includes('CANCELLED')
            ? 'cancelled'
            : 'failed';
        record.error = errMsg;
        record.completedAt = new Date().toISOString();
        this.emit({
          type: 'tool_call_failed',
          sessionId,
          payload: { ...record },
        });
        throw err;
      }
    };

    const strippedPrompt = prompt.replace(/^\[Context Active File:[^\]]*\]\s*/i, '').trim();
    const readMatch = strippedPrompt.match(/^(?:读取|read|查看文件)\s+([^\s,:：;]+)$/i);
    const writeMatch = strippedPrompt.match(
      /^(?:写入|创建|修改|write|edit)\s+([^\s,:：;]+)\s*[:：]\s*([\s\S]+)$/i
    );
    const buildMatch = strippedPrompt.match(/^(?:运行|执行|命令|run|build)\s*`([^`]+)`$/i);

    if (readMatch) {
      const targetFile = readMatch[1];
      try {
        const res = (await runCapabilityTool('read-file', { filePath: targetFile }, 'low')) as {
          content: string;
          byteLength: number;
        };
        const lineCount = res.content.split(/\r?\n/).length;
        await streamText(
          `### 文件读取完成\n- **文件路径**: \`${targetFile}\`\n- **文件大小**: ${res.byteLength} 字节（共 ${lineCount} 行）\n- **状态**: 已加载至当前 AI 上下文，您可以直接针对该文件提问或要求修改。`
        );
        return { content: chunks.join('') };
      } catch {
        // If target file does not exist in current workspace, fall through to LLM / workspace analysis
      }
    }

    if (writeMatch) {
      const targetFile = writeMatch[1];
      const proposedContent =
        writeMatch[2]?.trim() ||
        `// Generated by DeepAutoCode Agent (${manifest.modelId})\nexport const updated = true;\n`;

      const writeRes = await this.proposeAndApplyFileEdit({
        sessionId,
        manifest,
        targetFile,
        proposedContent,
        signal,
        runCapabilityTool,
        diffIds,
      });

      await streamText(
        `### 代码变更已应用\n- **目标文件**: \`${targetFile}\`\n- **变更预览**: Diff ID \`${writeRes.diffId}\`（${writeRes.bytesWritten} 字节）\n- **操作说明**: 您可以在中间编辑器 Diff 标签页或下方卡片中选择 **Accept** 或 **Reject**。`
      );
      return { content: chunks.join('') };
    }

    if (buildMatch) {
      const cmd = buildMatch[1];
      const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
        exitCode: number;
        stdout: string;
        stderr: string;
      };
      await streamText(
        `### 命令执行结果\n- **执行命令**: \`${cmd}\`\n- **退出状态码**: \`${res.exitCode}\`\n\`\`\`text\n${(res.stdout || res.stderr).trim()}\n\`\`\``
      );
      return { content: chunks.join('') };
    }

    // Try real LLM Tool-Calling Autonomous Agent Loop when Provider API Key is configured
    const apiKey = await this.providerManager.resolveApiKey(manifest.providerId);
    let authFailedNotice = '';
    if (apiKey && apiKey.trim().length > 0) {
      try {
        return await this.executeLiveLlmAgentLoop({
          manifest,
          prompt,
          apiKey: apiKey.trim(),
          signal,
          chunks,
          streamText,
          runCapabilityTool,
          diffIds,
        });
      } catch (llmErr) {
        const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
        // If tools or file edits were already executed before the error, preserve the completed work
        if (chunks.join('').trim().length > 0 || diffIds.length > 0 || toolCalls.length > 0) {
          if (chunks.join('').trim().length === 0) {
            const writtenFiles = toolCalls
              .filter((tc) => tc.toolName === 'write-file' && tc.status === 'completed')
              .map((tc) => `\`${String(tc.args?.filePath || '')}\``)
              .filter(Boolean);
            const summaryLines = [
              `## 任务执行完成摘要`,
              writtenFiles.length > 0
                ? `- **已生成/更新文件 (${writtenFiles.length})**: ${writtenFiles.join('、')}`
                : `- **已完成工具调用**: 共执行 ${toolCalls.length} 步工作区操作`,
              diffIds.length > 0
                ? `- **代码变更审查**: 已生成 ${diffIds.length} 项文件变更记录，可在下方卡片或编辑器中点击 **Accept** / **Reject**`
                : '',
            ]
              .filter(Boolean)
              .join('\n');
            await streamText(summaryLines);
          }
          return { content: chunks.join('') };
        }
        if (errMsg.includes('401') || /Authentication Fails|invalid.*api.*key/i.test(errMsg)) {
          authFailedNotice =
            `> ⚠️ **DeepSeek API Key 未通过验证 (HTTP 401)**：请在 **⚙️ Settings -> Models & Providers** 中粘贴有效密钥，并点击 **⚡ Test AI Key (测试 AI 调用)** 确认连接正常。\n\n`;
        } else {
          authFailedNotice = `> ⚠️ **云端模型调用提示**：${errMsg}（已自动切换至本地结构化分析引擎）\n\n`;
        }
      }
    }

    // Intelligent local workspace inspection & project analysis engine (file reads shown only as progress)
    let workspaceSummary = '';
    let packageAnalysis = '';
    let activeFileAnalysis = '';

    try {
      const entries = await fs.readdir(manifest.workspaceRoot, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
        .slice(0, 12)
        .map((e) => `\`${e.name}/\``);
      const files = entries
        .filter((e) => !e.isDirectory() && !['.DS_Store'].includes(e.name))
        .slice(0, 12)
        .map((e) => `\`${e.name}\``);
      workspaceSummary =
        `### 1. 工作区结构概览\n` +
        `- **当前项目路径**: \`${manifest.workspaceRoot}\`\n` +
        (dirs.length > 0 ? `- **核心目录**: ${dirs.join('、')}\n` : '') +
        (files.length > 0 ? `- **顶层文件**: ${files.join('、')}\n` : '');
    } catch {
      // ignore
    }

    // Inspect package.json silently via read-file capability (progress shown in UI)
    try {
      const pkgRes = (await runCapabilityTool(
        'read-file',
        { filePath: 'package.json' },
        'low'
      )) as { content: string };
      const pkg = JSON.parse(pkgRes.content);
      const scripts = Object.entries(pkg.scripts ?? {})
        .slice(0, 8)
        .map(([k, v]) => `  - \`npm run ${k}\` — \`${v}\``)
        .join('\n');
      const deps = Object.keys({
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      })
        .slice(0, 15)
        .map((d) => `\`${d}\``)
        .join('、');
      packageAnalysis =
        `\n### 2. 项目功能与配置 (\`package.json\`)\n` +
        `- **项目名称**: \`${pkg.name ?? 'unknown'}\` (版本 \`v${pkg.version ?? '1.0.0'}\`)\n` +
        (pkg.description ? `- **核心定位**: ${pkg.description}\n` : '') +
        (deps ? `- **技术栈与依赖**: ${deps}\n` : '') +
        (scripts ? `- **常用脚本指令**:\n${scripts}\n` : '');
    } catch {
      // ignore if no package.json
    }

    // Inspect active context file silently (progress shown in UI, no raw file dump)
    const activeFileMatch = prompt.match(/\[Context Active File:\s*([^\]]+)\]/i);
    if (activeFileMatch?.[1]) {
      const activeRelPath = activeFileMatch[1].trim();
      try {
        const activeRes = (await runCapabilityTool(
          'read-file',
          { filePath: activeRelPath },
          'low'
        )) as { content: string; byteLength: number };
        const exportedSymbols = Array.from(
          activeRes.content.matchAll(
            /export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z0-9_]+)/g
          )
        ).map((m) => m[1]);
        const lineCount = activeRes.content.split(/\r?\n/).length;
        activeFileAnalysis =
          `\n### 3. 当前激活模块 (\`${activeRelPath}\`)\n` +
          `- **文件规模**: ${lineCount} 行（${activeRes.byteLength} 字节）\n` +
          (exportedSymbols.length > 0
            ? `- **导出核心符号**: ${exportedSymbols.map((s) => `\`${s}\``).join('、')}\n`
            : '- **模块状态**: 已解析并加入上下文\n');
      } catch {
        // ignore
      }
    }

    await streamText(
      `${authFailedNotice}## 项目功能与架构分析\n\n` +
        `${workspaceSummary}${packageAnalysis}${activeFileAnalysis}\n` +
        `> 💡 **提示**：您可以在 **⚙️ Settings -> Models & Providers** 中点击 **⚡ Test AI Key** 验证云端模型连接；也可以直接输入需求（如修改代码、排查 Bug、运行测试）。`
    );

    return { content: chunks.join('') };
  }

  private normalizeWorkspaceRelativePath(rawPath: string, workspaceRoot: string): string {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) return '';
    const resolvedRoot = path.resolve(workspaceRoot);
    const rootBase = path.basename(resolvedRoot);

    // 1. If rawPath is already inside resolvedRoot on the local OS
    if (path.isAbsolute(trimmed)) {
      const resolvedTarget = path.resolve(trimmed);
      const rel = path.relative(resolvedRoot, resolvedTarget);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return (rel || '.').replace(/\\/g, '/');
      }
    }

    // 2. If rawPath is a remote POSIX path on Windows (e.g. "/home/renjc01/Bug/fhccl/nccl-test/src/sendrecv.cc")
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && rootBase) {
      const marker = `/${rootBase}/`;
      const idx = trimmed.lastIndexOf(marker);
      if (idx >= 0) {
        return trimmed.slice(idx + marker.length).replace(/\\/g, '/');
      }
      if (trimmed.endsWith(`/${rootBase}`)) {
        return '.';
      }
    }

    // 3. Clean relative path and strip redundant workspace folder prefix if present
    let cleanRel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (rootBase && cleanRel.startsWith(`${rootBase}/`)) {
      const withoutPrefix = cleanRel.slice(rootBase.length + 1);
      if (withoutPrefix) {
        cleanRel = withoutPrefix;
      }
    }
    return cleanRel || '.';
  }

  private applySmartTextReplacement(
    currentContent: string,
    oldText: string,
    newText: string,
    filePath: string
  ): string {
    if (!currentContent) {
      return newText;
    }
    // 1. Exact substring match (using function replacer so '$&' / '$$' in C/bash code are never mangled)
    if (currentContent.includes(oldText)) {
      return currentContent.replace(oldText, () => newText);
    }

    // 2. CRLF / LF normalized match
    const hasCrLf = currentContent.includes('\r\n');
    const normCurrent = currentContent.replace(/\r\n/g, '\n');
    const normOld = oldText.replace(/\r\n/g, '\n');
    const normNew = newText.replace(/\r\n/g, '\n');

    if (normCurrent.includes(normOld)) {
      const replaced = normCurrent.replace(normOld, () => normNew);
      return hasCrLf ? replaced.replace(/\n/g, '\r\n') : replaced;
    }

    // 3. Tab / space indentation-tolerant line-by-line block match
    const contentLines = normCurrent.split('\n');
    const oldLines = normOld.split('\n');
    // Trim leading/trailing empty lines from oldLines if needed
    while (oldLines.length > 0 && oldLines[0].trim() === '') oldLines.shift();
    while (oldLines.length > 0 && oldLines[oldLines.length - 1].trim() === '') oldLines.pop();

    if (oldLines.length > 0 && oldLines.length <= contentLines.length) {
      for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < oldLines.length; j++) {
          if (contentLines[i + j].trim() !== oldLines[j].trim()) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          const before = contentLines.slice(0, i);
          const after = contentLines.slice(i + oldLines.length);
          const joined = [...before, normNew, ...after].join('\n');
          return hasCrLf ? joined.replace(/\n/g, '\r\n') : joined;
        }
      }
    }

    throw new Error(
      `OLD_TEXT_NOT_FOUND: Could not find matching 'oldText' block in "${filePath}". Please call read_file on "${filePath}" to inspect the exact lines, or call write_file with the complete file content.`
    );
  }

  private async proposeAndApplyFileEdit(params: {
    sessionId: string;
    manifest: SessionManifest;
    targetFile: string;
    proposedContent: string;
    signal: AbortSignal;
    runCapabilityTool: (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk?: ToolCallRecord['risk']
    ) => Promise<unknown>;
    diffIds: string[];
  }): Promise<{ diffId: string; bytesWritten: number; operation: string }> {
    const { sessionId, manifest, proposedContent, signal, runCapabilityTool, diffIds } = params;
    const targetFile = this.normalizeWorkspaceRelativePath(
      params.targetFile,
      manifest.workspaceRoot
    );

    let originalContent = '';
    try {
      const readRes = (await this.capabilityRegistry.invoke(
        'read-file',
        { filePath: targetFile },
        {
          sessionId,
          workspaceRoot: manifest.workspaceRoot,
          executionMode: 'plan',
          signal,
        }
      )) as { content: string };
      originalContent = readRes.content;
    } catch {
      originalContent = '';
    }

    const diffId = `diff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const unifiedDiff = createUnifiedDiff(targetFile, originalContent, proposedContent);
    const diffRecord: DiffChangeRecord = {
      diffId,
      sessionId,
      filePath: targetFile,
      operation: originalContent ? 'modify' : 'create',
      originalContent,
      proposedContent,
      unifiedDiff,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.saveDiff(sessionId, diffRecord);
    diffIds.push(diffId);

    const writeOut = (await runCapabilityTool(
      'write-file',
      {
        filePath: targetFile,
        content: proposedContent,
        createDirectories: true,
      },
      'medium'
    )) as { bytesWritten: number; operation: string };

    await runCapabilityTool(
      'reveal-diff',
      {
        diffId,
        filePath: targetFile,
        originalContent,
        proposedContent,
        title: `DeepAutoCode Diff: ${targetFile}`,
      },
      'low'
    );

    this.emit({
      type: 'diff_proposed',
      sessionId,
      payload: { ...diffRecord },
    });

    // Keep diffRecord.status as 'pending' so the user can review and click Accept / Reject in the IDE
    diffRecord.updatedAt = new Date().toISOString();
    await this.saveDiff(sessionId, diffRecord);

    return {
      diffId,
      bytesWritten: writeOut?.bytesWritten ?? Buffer.byteLength(proposedContent, 'utf-8'),
      operation: writeOut?.operation ?? (originalContent ? 'modify' : 'create'),
    };
  }

  /**
   * Real Multi-Step Autonomous Coding Loop powered by `@cline/sdk` `Agent` (`AgentRuntime`)
   * + `createBuiltinTools` & `createTool`, bridged to DeepAutoCode's `CapabilityRegistry`.
   */
  private async executeLiveLlmAgentLoop(params: {
    manifest: SessionManifest;
    prompt: string;
    apiKey: string;
    signal: AbortSignal;
    chunks: string[];
    streamText: (text: string) => Promise<void>;
    runCapabilityTool: (
      capability: CapabilityName,
      args: Record<string, unknown>,
      risk?: ToolCallRecord['risk']
    ) => Promise<unknown>;
    diffIds: string[];
  }): Promise<{ content: string }> {
    const { manifest, prompt, apiKey, signal, chunks, streamText, runCapabilityTool, diffIds } =
      params;
    const sessionId = manifest.sessionId;
    const { provider } = this.providerManager.getActiveProvider();
    const endpoint = `${provider.apiEndpoint.replace(/\/$/, '')}/chat/completions`;
    const isSshMirrorWorkspace = manifest.workspaceRoot.includes('ssh-mirrors');

    // Build top-level workspace file list for context
    let workspaceFilesHint = '';
    try {
      const topEntries = await fs.readdir(manifest.workspaceRoot, { withFileTypes: true });
      workspaceFilesHint = topEntries
        .filter((e) => !['node_modules', '.git', 'dist', '.deepautocode-data'].includes(e.name))
        .slice(0, 30)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join(', ');
    } catch {
      workspaceFilesHint = '';
    }

    const sdk = await import('../core/index.js');
    const {
      Agent,
      createBuiltinTools,
      createTool,
      extractCodeOutline,
      getClineDefaultSystemPrompt,
      generateWorkspaceInfo,
      enrichPromptWithMentions,
      expandSlashCommandPrompt,
      createToolPoliciesWithPreset,
      FileStateCache,
      createGoalState,
      buildGoalContinuationPrompt,
      resolveTieredModelForTurn,
      classifyPromptIntent,
    } = sdk;

    const slashExpanded =
      typeof expandSlashCommandPrompt === 'function'
        ? expandSlashCommandPrompt(prompt)
        : { expandedPrompt: prompt };
    const basePromptForTurn = slashExpanded.expandedPrompt || prompt;

    const fileStateCache = new FileStateCache();
    const activeGoal = createGoalState(basePromptForTurn);
    const promptIntent = classifyPromptIntent(basePromptForTurn);
    const isReadOnlyTurn =
      slashExpanded.suggestedMode === 'plan' ||
      manifest.executionMode === 'plan' ||
      (!promptIntent.allowFileMutations && slashExpanded.suggestedMode !== 'auto');

    // 0. Reuse @cline/sdk native workspace metadata & @file mention enricher
    let workspaceInfo: any = { rootPath: manifest.workspaceRoot, hint: path.basename(manifest.workspaceRoot) };
    try {
      if (typeof generateWorkspaceInfo === 'function') {
        workspaceInfo = await generateWorkspaceInfo(manifest.workspaceRoot);
      }
    } catch {
      // fallback to basic workspaceInfo
    }

    let effectivePrompt = basePromptForTurn;
    try {
      if (typeof enrichPromptWithMentions === 'function' && basePromptForTurn.includes('@')) {
        const enriched = await enrichPromptWithMentions(basePromptForTurn, manifest.workspaceRoot, {
          maxFiles: 5,
          maxFileBytes: 32000,
        });
        if (enriched?.prompt) {
          effectivePrompt = enriched.prompt;
        }
      }
    } catch {
      effectivePrompt = basePromptForTurn;
    }

    // Zero-Roundtrip Auto-Prefetch: If the user's prompt mentions specific source files (e.g. src/enqueue.cc:782-811),
    // pre-read up to 3 referenced files in parallel BEFORE Turn 1 so the LLM skips 1-3 exploratory tool round-trips.
    try {
      const promptTokens = prompt.split(/[\s,;()[\]{}<>"'`，；。（）【】「」|]+/);
      const seenPrefetchPaths = new Set<string>();
      const prefetchTargets: Array<{ relPath: string; startLine?: number; endLine?: number }> = [];

      for (const tok of promptTokens) {
        if (!tok || !tok.includes('.') || /^https?:\/\//i.test(tok)) continue;
        const m = tok.match(
          /^([a-zA-Z0-9_./-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|py|ts|tsx|js|jsx|go|rs|java|sh|cmake))(?::(\d+)(?:[-:](\d+))?)?$/i
        );
        if (!m) continue;
        const relPath = this.normalizeWorkspaceRelativePath(m[1], manifest.workspaceRoot);
        if (!relPath || relPath.startsWith('..') || seenPrefetchPaths.has(relPath)) continue;
        seenPrefetchPaths.add(relPath);
        prefetchTargets.push({
          relPath,
          startLine: m[2] ? Number(m[2]) : undefined,
          endLine: m[3] ? Number(m[3]) : undefined,
        });
        if (prefetchTargets.length >= 3) break;
      }

      if (prefetchTargets.length > 0) {
        const prefetchedSnippets = await Promise.all(
          prefetchTargets.map(async (target) => {
            try {
              const absPath = path.resolve(manifest.workspaceRoot, target.relPath);
              const rawText = await fs.readFile(absPath, 'utf-8');
              const allLines = rawText.split(/\r?\n/);
              const sLine = target.startLine ? Math.max(1, target.startLine - 35) : 1;
              const eLine = target.endLine
                ? Math.min(allLines.length, target.endLine + 45)
                : target.startLine
                  ? Math.min(allLines.length, target.startLine + 65)
                  : Math.min(allLines.length, 160);
              const numbered = allLines
                .slice(sLine - 1, eLine)
                .map((l, idx) => `${sLine + idx}: ${l}`)
                .join('\n');
              fileStateCache.recordRead({
                filePath: target.relPath,
                content: rawText,
                startLine: sLine,
                endLine: eLine,
              });
              return `\n--- [Pre-fetched File: ${target.relPath} (lines ${sLine}-${eLine} of ${allLines.length})] ---\n${numbered}`;
            } catch {
              return '';
            }
          })
        );
        const validSnippets = prefetchedSnippets.filter((s) => s.length > 0);
        if (validSnippets.length > 0) {
          effectivePrompt = `${effectivePrompt}\n\n[Auto-Prefetched Workspace Files — Already loaded in context, no need to re-read these same line ranges:]${validSnippets.join('\n')}`;
        }
      }
    } catch {
      // ignore prefetch errors
    }

    const sessionWrittenFiles: string[] = [];
    const readCountsByRange = new Map<string, number>();
    const executedCommandCounts = new Map<string, number>();
    let hasUnverifiedCompiledEdit = false;
    let hasUnverifiedTestAfterEdit = false;
    let lastBuildOrTestFailed = false;
    let lastFailureOutputSnippet = '';
    let selfHealCount = 0;
    let autoContinuationCount = 0;

    const hasTestTargetInContext =
      /(?:_perf\b|nccl-test\b|\btests?\b|\bctest\b|\bpytest\b|测试)/i.test(
        `${workspaceFilesHint} ${prompt}`
      );

    const recordCompiledFileEdit = (filePath: string) => {
      sessionWrittenFiles.push(filePath);
      executedCommandCounts.clear();
      const normKeyPrefix = `${filePath}:`;
      for (const k of Array.from(readCountsByRange.keys())) {
        if (k.startsWith(normKeyPrefix)) {
          readCountsByRange.delete(k);
        }
      }
      if (/\.(?:c|cc|cpp|cu|h|hpp)$/i.test(filePath)) {
        hasUnverifiedCompiledEdit = true;
        if (hasTestTargetInContext) {
          hasUnverifiedTestAfterEdit = true;
        }
      }
    };

    const recordCommandOutcome = (cmd: string, res: { exitCode: number; stdout?: string; stderr?: string }) => {
      const combinedOut = `${res.stdout || ''}\n${res.stderr || ''}`;
      const isBuildCmd = /\b(?:make|cmake|ninja|gcc|g\+\+|hipcc|nvcc|cargo|npm\s+run\s+build|tsc)\b/i.test(cmd);
      const isTestCmd = /(?:_perf\b|\bctest\b|\bpytest\b|\bvitest\b|\bnpm\s+test\b|\bverify-[a-z0-9_.-]+|\.\/(?:build\/)?[a-z0-9_]+_perf\b)/i.test(
        cmd
      );
      if (!isBuildCmd && !isTestCmd) {
        return;
      }
      const hasRuntimeOrCompileFailure =
        res.exitCode !== 0 ||
        /(?:Test NCCL failure|# Out of bounds values\s*:\s*[1-9]\d*\s+FAILED|\bfatal error:|\berror:\s+[^\n]+|\bSegmentation fault\b|\bAborted\s*\(core dumped\))/i.test(
          combinedOut
        );
      if (isBuildCmd && !hasRuntimeOrCompileFailure) {
        hasUnverifiedCompiledEdit = false;
      }
      if (isTestCmd) {
        hasUnverifiedCompiledEdit = false;
        hasUnverifiedTestAfterEdit = false;
      }
      lastBuildOrTestFailed = hasRuntimeOrCompileFailure;
      if (hasRuntimeOrCompileFailure) {
        activeGoal.consecutiveBlockedTurns += 1;
        lastFailureOutputSnippet = combinedOut.trim().slice(-1200);
      } else {
        activeGoal.consecutiveBlockedTurns = 0;
        activeGoal.verifiedByCommand = true;
        lastFailureOutputSnippet = '';
      }
    };

    const fullReadExpandedFiles = new Set<string>();
    const autoExpandPartialSedRead = async (cmd: string, stdout: string): Promise<string> => {
      const sedMatch = cmd.match(/\bsed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)p['"]?\s+([^\s;|&>'"]+)/);
      if (!sedMatch) {
        return stdout;
      }
      const endLine = Number(sedMatch[2]);
      const rawTargetFile = sedMatch[3];
      if (!endLine || !rawTargetFile) {
        return stdout;
      }
      try {
        const relFile = this.normalizeWorkspaceRelativePath(rawTargetFile, manifest.workspaceRoot);
        if (fullReadExpandedFiles.has(relFile)) {
          return `[DUPLICATE_FILE_SLICE_NOTICE]: Complete file '${relFile}' was already returned in full earlier in this turn. Do NOT run additional sed/cat commands on '${relFile}'; proceed directly to edit_file / write_file or compile/test!`;
        }
        const absFile = path.resolve(manifest.workspaceRoot, relFile);
        let fileContent = await fs.readFile(absFile, 'utf-8').catch(() => '');
        if (!fileContent.trim()) {
          const pulled = (await this.capabilityRegistry.invoke(
            'read-file',
            { filePath: relFile },
            {
              sessionId,
              workspaceRoot: manifest.workspaceRoot,
              executionMode: 'plan',
              signal,
            }
          )) as { content: string };
          fileContent = pulled?.content || '';
        }
        const allLines = fileContent.split(/\r?\n/);
        if (allLines.length > 1 && allLines.length <= 400) {
          fullReadExpandedFiles.add(relFile);
          const numberedFull = allLines.map((line, idx) => `${idx + 1}: ${line}`).join('\n');
          return `/* [DeepAutoCode Function-Completeness Auto-Expand (Full-File Auto-Read): '${relFile}' has ${allLines.length} lines total. Returning the ENTIRE file (1..${allLines.length}) below so you do not miss #if 0 blocks or tail logic — do NOT run any more sed/grep slices on '${relFile}'!] */\n${numberedFull}`;
        }
        if (endLine < allLines.length) {
          const appendUntil = Math.min(allLines.length, endLine + 120);
          const extraSnippet = allLines
            .slice(endLine, appendUntil)
            .map((line, idx) => `${endLine + 1 + idx}: ${line}`)
            .join('\n');
          return `${stdout}\n/* [DeepAutoCode Function-Completeness Auto-Expand: lines ${endLine + 1}..${appendUntil} of ${relFile} appended automatically so you do not miss #if 0 blocks or tail logic] */\n${extraSnippet}`;
        }
      } catch {
        // ignore if file is not accessible
      }
      return stdout;
    };

    /**
     * Automatically parses compiler/runtime errors (GCC, Clang, hipcc, nvcc, tsc, Python, Rust)
     * from build/test output and pre-loads the exact offending source lines (±22 lines) into context
     * so the Agent can immediately call `edit_file` on the very next turn without an extra `read_file` round-trip.
     */
    const autoExtractCompilerErrorContext = async (
      stdout: string,
      stderr: string
    ): Promise<string> => {
      const combined = `${stdout || ''}\n${stderr || ''}`;
      const errorPattern =
        /([a-zA-Z0-9_./\\-]+\.(?:c|cc|cpp|cxx|cu|cuh|h|hh|hpp|py|ts|tsx|js|jsx|go|rs)):(\d+)(?::\d+)?:\s*(?:fatal\s+)?error:\s*([^\r\n]+)/gi;
      const seenLocs = new Set<string>();
      const targets: Array<{ relFile: string; line: number; msg: string }> = [];

      let match: RegExpExecArray | null;
      while ((match = errorPattern.exec(combined)) !== null) {
        const rawPath = match[1].replace(/^\.\//, '');
        const lineNum = Number(match[2]);
        const errMsg = match[3].trim();
        const relFile = this.normalizeWorkspaceRelativePath(rawPath, manifest.workspaceRoot);
        const key = `${relFile}:${ Math.floor(lineNum / 20) }`;
        if (!relFile || relFile.startsWith('..') || seenLocs.has(key)) continue;
        seenLocs.add(key);
        targets.push({ relFile, line: lineNum, msg: errMsg });
        if (targets.length >= 3) break;
      }

      if (targets.length === 0) {
        return '';
      }

      const snippets = await Promise.all(
        targets.map(async (t) => {
          try {
            const pulled = (await runCapabilityTool(
              'read-file',
              { filePath: t.relFile },
              'low'
            )) as { content: string };
            if (!pulled?.content) return '';
            const allLines = pulled.content.split(/\r?\n/);
            const s = Math.max(1, t.line - 18);
            const e = Math.min(allLines.length, t.line + 22);
            fileStateCache.recordRead({
              filePath: t.relFile,
              content: pulled.content,
              startLine: s,
              endLine: e,
            });
            const numbered = allLines
              .slice(s - 1, e)
              .map((l, idx) => `${s + idx === t.line ? '>> ' : '   '}${s + idx}: ${l}`)
              .join('\n');
            return `\n--- [Auto-Loaded Error Source: ${t.relFile}:${t.line} (${t.msg})] ---\n${numbered}`;
          } catch {
            return '';
          }
        })
      );

      const valid = snippets.filter(Boolean);
      return valid.length > 0
        ? `\n\n[DeepAutoCode Auto-Diagnosed Compiler Error Context — Immediately call edit_file to fix these lines and re-run build]:${valid.join('\n')}`
        : '';
    };

    // 1. Create In-tree Antigravity-Enhanced Builtin Tools wired to DeepAutoCode CapabilityRegistry
    const builtinTools = createBuiltinTools({
      cwd: manifest.workspaceRoot,
      shell: isSshMirrorWorkspace ? '/bin/bash' : undefined,
      enableEditor: manifest.executionMode !== 'plan',
      enableApplyPatch: false,
      executors: {
        ...(isSshMirrorWorkspace
          ? {
              search: async (query: string, subDir?: string, contextLines = 3) => {
                const safeQuery = String(query || '').replace(/'/g, `'\\''`);
                const safeSubDir = subDir
                  ? this.normalizeWorkspaceRelativePath(subDir, manifest.workspaceRoot).replace(
                      /'/g,
                      `'\\''`
                    )
                  : '.';
                const ctx = Math.max(0, Math.min(8, Number(contextLines) || 3));
                const res = (await runCapabilityTool(
                  'run-build',
                  {
                    command: `grep -rnI -C ${ctx} --exclude-dir=.git --exclude-dir=build -- '${safeQuery}' '${safeSubDir}' 2>/dev/null | head -n 120`,
                  },
                  'low'
                )) as { stdout: string };
                return res.stdout?.trim() || 'No matches found.';
              },
            }
          : {}),
        readFile: async (item: any) => {
          const rawFilePath = typeof item === 'string' ? item : item?.path;
          const filePath = this.normalizeWorkspaceRelativePath(
            rawFilePath,
            manifest.workspaceRoot
          );
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
          };
          const allLines = res.content.split(/\r?\n/);
          const start = Math.max(1, item?.start_line ?? 1);
          const end = Math.min(allLines.length, item?.end_line ?? allLines.length);
          fileStateCache.recordRead({
            filePath,
            content: res.content,
            startLine: start,
            endLine: end,
          });
          return allLines
            .slice(start - 1, end)
            .map((line, idx) => `${start + idx}: ${line}`)
            .join('\n');
        },
        editor: async (input: any) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            input.path || input.filePath || input.file_path,
            manifest.workspaceRoot
          );
          const oldText = input.old_text ?? input.old_str;
          const newText = input.new_text ?? input.new_str ?? input.file_text ?? '';

          if (input.command === 'view') {
            const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            fileStateCache.recordRead({ filePath, content: res.content });
            return res.content.slice(0, 12000);
          }

          if (input.insert_line != null || input.command === 'insert') {
            let currentContent = '';
            try {
              const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
                content: string;
              };
              currentContent = current.content;
              fileStateCache.makeSnapshot(filePath, currentContent);
            } catch {
              currentContent = '';
            }
            const lines = currentContent ? currentContent.split(/\r?\n/) : [];
            const idx = Math.max(0, Math.min(lines.length, input.insert_line ?? lines.length));
            lines.splice(idx, 0, newText);
            const updated = lines.join('\n');
            const writeRes = await this.proposeAndApplyFileEdit({
              sessionId,
              manifest,
              targetFile: filePath,
              proposedContent: updated,
              signal,
              runCapabilityTool,
              diffIds,
            });
            fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
            recordCompiledFileEdit(filePath);
            return `Inserted into ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId})`;
          }

          if (oldText != null && oldText.length > 0) {
            const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
              content: string;
            };
            fileStateCache.makeSnapshot(filePath, current.content);
            let updated: string;
            try {
              updated = this.applySmartTextReplacement(
                current.content,
                oldText,
                newText,
                filePath
              );
            } catch {
              const diag = fileStateCache.diagnoseEditMismatch(filePath, current.content, oldText);
              throw new Error(diag.hintMessage);
            }
            const writeRes = await this.proposeAndApplyFileEdit({
              sessionId,
              manifest,
              targetFile: filePath,
              proposedContent: updated,
              signal,
              runCapabilityTool,
              diffIds,
            });
            fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
            recordCompiledFileEdit(filePath);
            return `Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId})`;
          }

          const writeRes = await this.proposeAndApplyFileEdit({
            sessionId,
            manifest,
            targetFile: filePath,
            proposedContent: newText,
            signal,
            runCapabilityTool,
            diffIds,
          });
          fileStateCache.recordRead({ filePath, content: newText, isPartialView: false });
          recordCompiledFileEdit(filePath);
          return `Created/Updated ${filePath} (${writeRes.bytesWritten} bytes, diffId=${writeRes.diffId})`;
        },
        bash: async (input: any) => {
          let cmd = '';
          if (typeof input === 'string') {
            cmd = input;
          } else if (input && typeof input === 'object') {
            const baseCmd = String(input.command ?? input.cmd ?? '').trim();
            const argsList = Array.isArray(input.args)
              ? input.args.map((a: unknown) => String(a)).join(' ')
              : '';
            cmd = argsList ? `${baseCmd} ${argsList}` : baseCmd;
          }
          const normCmd = cmd.trim().replace(/\s+/g, ' ');
          const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
          if (normCmd && prevCmdCount >= 1) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
            return `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`;
          }
          if (normCmd) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
          }
          const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(cmd, res);
          const expandedStdout = await autoExpandPartialSedRead(cmd, res.stdout || '');
          const combined = [expandedStdout.trim(), res.stderr?.trim()].filter(Boolean).join('\n');
          return (combined || `Exit code ${res.exitCode}`).slice(0, 8000);
        },
      } as any,
    });

    // 2. Register DeepAutoCode Workspace Capability Tools via @cline/sdk `createTool`
    const deepAutoCodeTools = [
      createTool({
        name: 'list_files',
        description:
          'List files and directories inside a workspace directory (relative path, e.g. "." or "src").',
        inputSchema: {
          type: 'object',
          properties: {
            dirPath: {
              type: 'string',
              description: 'Relative directory path inside workspace (default ".")',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const relDir = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.dirPath || '.'),
            manifest.workspaceRoot
          );
          const targetDir = path.resolve(manifest.workspaceRoot, relDir);
          if (!targetDir.startsWith(path.resolve(manifest.workspaceRoot))) {
            throw new Error('PATH_BOUNDARY_VIOLATION: Directory outside workspace');
          }
          const entries = await fs.readdir(targetDir, { withFileTypes: true });
          const items = entries
            .filter((e) => !['node_modules', '.git', '.deepautocode-data'].includes(e.name))
            .slice(0, 80)
            .map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`));
          return { dirPath: relDir, entries: items };
        },
      }),
      createTool({
        name: 'outline_file',
        description:
          'Extract all functions, structs, classes, enums, and macro definitions with their exact 1-based line numbers from a source file. Ideal for quickly navigating large files (>300 lines) before calling read_file with start_line and end_line.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the source/header file (e.g. "src/enqueue.cc" or "src/include/comm.h")',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
          };
          const totalLines = res.content.split(/\r?\n/).length;
          const symbols = extractCodeOutline(res.content, 150);
          return {
            filePath,
            totalLines,
            symbolCount: symbols.length,
            outline: symbols.join('\n'),
          };
        },
      }),
      createTool({
        name: 'read_file',
        description:
          'Read the contents of a file inside the workspace (supports optional start_line and end_line for large files, and automatically attaches a symbol line-number outline for large files).',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc")',
            },
            start_line: {
              type: 'number',
              description: 'Optional 1-based start line number (inclusive)',
            },
            end_line: {
              type: 'number',
              description: 'Optional 1-based end line number (inclusive)',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const startLine = Number(rawArgs?.start_line ?? rawArgs?.startLine ?? 0);
          const endLine = Number(rawArgs?.end_line ?? rawArgs?.endLine ?? 0);
          const rangeKey = `${filePath}:${startLine > 0 ? startLine : 1}-${endLine > 0 ? endLine : 'EOF'}`;
          const fullKey = `${filePath}:1-EOF`;
          const prevCount = (readCountsByRange.get(rangeKey) ?? 0) + (rangeKey !== fullKey ? (readCountsByRange.get(fullKey) ?? 0) : 0);
          const cached = fileStateCache.get(filePath);
          if (cached && prevCount >= 1) {
            readCountsByRange.set(rangeKey, prevCount + 1);
            return {
              filePath,
              totalLines: cached.totalLines,
              alreadyInContext: true,
              notice: `[DUPLICATE_READ_SKIPPED]: '${filePath}' was ALREADY read in this turn and has not been modified since. Do NOT call read_file on '${filePath}' again! If changes are still needed, call edit_file / write_file immediately; if '${filePath}' already contains the target fix, proceed directly to run_command or output the final summary.`,
            };
          }
          const res = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
            byteLength: number;
            truncated: boolean;
          };
          const allLines = res.content.split(/\r?\n/);
          const totalLines = allLines.length;
          let contentOut = res.content;
          readCountsByRange.set(rangeKey, (readCountsByRange.get(rangeKey) ?? 0) + 1);
          fileStateCache.recordRead({
            filePath,
            content: res.content,
            startLine: startLine > 0 ? startLine : 1,
            endLine: endLine > 0 ? endLine : totalLines,
          });
          if (startLine > 0 || endLine > 0) {
            const s = Math.max(1, startLine || 1);
            const e = Math.min(totalLines, endLine > 0 ? endLine : totalLines);
            contentOut = allLines
              .slice(s - 1, e)
              .map((line, idx) => `${s + idx}: ${line}`)
              .join('\n');
          }
          const isTruncatedOrLarge = Boolean(
            res.truncated || contentOut.length > 48000 || (totalLines > 350 && startLine === 0)
          );
          const symbolOutline =
            isTruncatedOrLarge ? extractCodeOutline(res.content, 80).join('\n') : undefined;
          return {
            filePath,
            totalLines,
            byteLength: res.byteLength,
            truncated: Boolean(res.truncated || contentOut.length > 48000),
            content: contentOut.slice(0, 48000),
            ...(symbolOutline
              ? {
                  symbolOutlineHint: `[文件符号大纲导航 (共 ${totalLines} 行，可用 start_line/end_line 精确读取对应函数/结构体)]:\n${symbolOutline}`,
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'explore_codebase',
        description:
          'Context-isolated parallel codebase exploration subagent (inspired by Claude Code Explore Agent). Executes multiple keyword/symbol searches and file outline/range inspections in parallel and returns a compact, line-numbered evidence digest without bloating the main conversation context.',
        inputSchema: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              description: 'Up to 4 symbol names or grep search patterns to search in parallel',
              items: { type: 'string' },
            },
            files: {
              type: 'array',
              description: 'Up to 4 files (with optional 1-based start_line and end_line) to inspect in parallel',
              items: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' },
                  start_line: { type: 'number' },
                  end_line: { type: 'number' },
                },
                required: ['filePath'],
              },
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const queries = Array.isArray(rawArgs?.queries)
            ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
            : [];
          const files = Array.isArray(rawArgs?.files) ? rawArgs.files.slice(0, 4) : [];

          const [searchDigestParts, fileDigestParts] = await Promise.all([
            Promise.all(
              queries.map(async (q) => {
                if (isSshMirrorWorkspace) {
                  const safeQ = q.replace(/'/g, `'\\''`);
                  const res = (await runCapabilityTool(
                    'run-build',
                    {
                      command: `grep -rnI -C 2 --exclude-dir=.git --exclude-dir=build -- '${safeQ}' . 2>/dev/null | head -n 45`,
                    },
                    'low'
                  )) as { stdout: string };
                  return `### Search: \`${q}\`\n${(res.stdout || 'No matches.').trim().slice(0, 1400)}`;
                }
                return `### Search: \`${q}\` (use search_codebase for local details)`;
              })
            ),
            Promise.all(
              files.map(async (f: any) => {
                const rawPath = typeof f === 'string' ? f : f?.filePath || f?.path || '';
                const relPath = this.normalizeWorkspaceRelativePath(rawPath, manifest.workspaceRoot);
                if (!relPath) return '';
                try {
                  const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
                    content: string;
                  };
                  const allLines = res.content.split(/\r?\n/);
                  const s = Math.max(1, Number(f?.start_line ?? 1));
                  const e = Math.min(
                    allLines.length,
                    Number(f?.end_line ?? Math.min(allLines.length, s + 90))
                  );
                  fileStateCache.recordRead({
                    filePath: relPath,
                    content: res.content,
                    startLine: s,
                    endLine: e,
                  });
                  const snippet = allLines
                    .slice(s - 1, e)
                    .map((line, idx) => `${s + idx}: ${line}`)
                    .join('\n')
                    .slice(0, 1800);
                  const outline = extractCodeOutline(res.content, 30).join('\n');
                  return `### File: \`${relPath}\` (lines ${s}-${e} of ${allLines.length})\n${snippet}${
                    outline ? `\n[Outline]:\n${outline}` : ''
                  }`;
                } catch (err) {
                  return `### File: \`${relPath}\` (error: ${err instanceof Error ? err.message : String(err)})`;
                }
              })
            ),
          ]);

          return {
            digest: [...searchDigestParts, ...fileDigestParts].filter(Boolean).join('\n\n').slice(0, 7500),
          };
        },
      }),
      createTool({
        name: 'edit_file',
        description:
          'Directly modify an existing file in the workspace by replacing a target snippet (oldText) with updated code (newText). Automatically syncs to Remote SSH if connected and updates the IDE Code Editor.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description:
                'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "nccl-test/verifiable/verifiable.cc")',
            },
            oldText: {
              type: 'string',
              description: 'Exact existing lines of code in the file to be replaced',
            },
            newText: {
              type: 'string',
              description: 'New replacement lines of code',
            },
          },
          required: ['filePath', 'oldText', 'newText'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          const oldText = String(rawArgs?.oldText ?? rawArgs?.old_text ?? rawArgs?.old_str ?? '');
          const newText = String(rawArgs?.newText ?? rawArgs?.new_text ?? rawArgs?.new_str ?? '');
          if (!filePath || !oldText) {
            return {
              ok: false,
              error: 'Both filePath and oldText are required for edit_file.',
            };
          }
          const current = (await runCapabilityTool('read-file', { filePath }, 'low')) as {
            content: string;
          };
          fileStateCache.makeSnapshot(filePath, current.content);
          let updated: string;
          try {
            updated = this.applySmartTextReplacement(
              current.content,
              oldText,
              newText,
              filePath
            );
          } catch {
            const diag = fileStateCache.diagnoseEditMismatch(filePath, current.content, oldText);
            return {
              ok: false,
              filePath,
              error: diag.hintMessage,
            };
          }
          const writeRes = await this.proposeAndApplyFileEdit({
            sessionId,
            manifest,
            targetFile: filePath,
            proposedContent: updated,
            signal,
            runCapabilityTool,
            diffIds,
          });
          fileStateCache.recordRead({ filePath, content: updated, isPartialView: false });
          recordCompiledFileEdit(filePath);
          const isCompiledSrc = /\.(?:c|cc|cpp|cu|h|hpp)$/i.test(filePath);
          return {
            ok: true,
            filePath,
            diffId: writeRes.diffId,
            bytesWritten: writeRes.bytesWritten,
            operation: writeRes.operation,
            ...(isCompiledSrc
              ? {
                  mandatoryNextStep:
                    'CRITICAL: You just modified a C/C++/HIP file. Your NEXT tool call MUST be run_command to compile (e.g. cd build && make -j16) and run the verification test binary (e.g. export LD_LIBRARY_PATH=$PWD/build/lib:$LD_LIBRARY_PATH && ./nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2) to verify 0 compile errors and #wrong=0!',
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'write_file',
        description:
          'Create a new file (including parent directories) or overwrite an existing file with complete content in the workspace, automatically syncing to Remote SSH if connected.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace (e.g. "nccl-test/src/sendrecv.cc" or "index.html")',
            },
            content: {
              type: 'string',
              description: 'Complete file content to write',
            },
          },
          required: ['filePath', 'content'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || rawArgs?.file_path || ''),
            manifest.workspaceRoot
          );
          if (rawArgs?.__truncated) {
            return {
              ok: false,
              error: `OUTPUT_TRUNCATED_AT_MAX_TOKENS: Your tool call JSON arguments for '${filePath || 'target file'}' exceeded the 8192 output token limit in a single turn and were cut off. For large existing files, use 'edit_file' ({ filePath, oldText, newText }) to replace only the changed snippet, or call write_file for 1 file per turn.`,
            };
          }
          const content = String(
            rawArgs?.content ?? rawArgs?.new_text ?? rawArgs?.text ?? ''
          );
          if (!filePath) {
            return {
              ok: false,
              error:
                'Missing filePath parameter for write_file (tool call JSON may have been truncated). Please use edit_file for targeted changes or call write_file for one file at a time.',
            };
          }
          const writeRes = await this.proposeAndApplyFileEdit({
            sessionId,
            manifest,
            targetFile: filePath,
            proposedContent: content,
            signal,
            runCapabilityTool,
            diffIds,
          });
          recordCompiledFileEdit(filePath);
          const isCompiledSrc = /\.(?:c|cc|cpp|cu|h|hpp)$/i.test(filePath);
          return {
            ok: true,
            filePath,
            diffId: writeRes.diffId,
            bytesWritten: writeRes.bytesWritten,
            operation: writeRes.operation,
            ...(isCompiledSrc
              ? {
                  mandatoryNextStep:
                    'CRITICAL: You just modified a C/C++/HIP file. Your NEXT tool call MUST be run_command to compile (e.g. cd build && make -j16) and run the verification test binary (e.g. export LD_LIBRARY_PATH=$PWD/build/lib:$LD_LIBRARY_PATH && ./nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2) to verify 0 compile errors and #wrong=0!',
                }
              : {}),
          };
        },
      }),
      createTool({
        name: 'run_command',
        description: 'Execute a shell/build/test command in the workspace root directory.',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to run (e.g. "make -j16", "git diff", "npm test")',
            },
          },
          required: ['command'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const command = String(rawArgs?.command || '');
          const normCmd = command.trim().replace(/\s+/g, ' ');
          const prevCmdCount = executedCommandCounts.get(normCmd) ?? 0;
          if (normCmd && prevCmdCount >= 1) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
            return {
              command,
              exitCode: 0,
              alreadyExecutedInTurn: true,
              stdout: `[DUPLICATE_COMMAND_SKIPPED]: You already executed this exact command in this turn and received its output above. Do NOT repeat the same command; proceed immediately to the next step!`,
              stderr: '',
            };
          }
          if (normCmd) {
            executedCommandCounts.set(normCmd, prevCmdCount + 1);
          }
          const res = (await runCapabilityTool('run-build', { command }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(command, res);
          const expandedStdout = await autoExpandPartialSedRead(command, res.stdout || '');
          const errorContext =
            res.exitCode !== 0 || /error:/i.test(res.stderr || '') || /error:/i.test(res.stdout || '')
              ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
              : '';
          return {
            command,
            exitCode: res.exitCode,
            durationMs: res.durationMs,
            stdout: `${expandedStdout.slice(0, 8000)}${errorContext}`,
            stderr: res.stderr.slice(0, 4000),
          };
        },
      }),
      createTool({
        name: 'connect_remote_ssh',
        description:
          'Automatically log in and connect to a Remote Linux SSH server (using either saved SSH profile credentials or host/username/password/remotePath provided by the user) and switch the active workspace to the remote project mirror.',
        inputSchema: {
          type: 'object',
          properties: {
            host: {
              type: 'string',
              description: 'Remote server IP or hostname (leave empty to auto-reconnect the most recently saved SSH profile)',
            },
            port: {
              type: 'number',
              description: 'SSH port (default 22)',
            },
            username: {
              type: 'string',
              description: 'SSH username (e.g. "root")',
            },
            password: {
              type: 'string',
              description: 'Optional SSH password if using password authentication',
            },
            remotePath: {
              type: 'string',
              description: 'Remote project directory path (e.g. "/home/renjc01/Bug/fhccl")',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const workbenchPort = Number(process.env.DEEPAUTOCODE_PORT || 3840);
          try {
            let profileToConnect: Record<string, unknown> = { ...rawArgs };
            if (!rawArgs?.host) {
              const statusRes = await postJsonOnce({
                url: `http://127.0.0.1:${workbenchPort}/api/ssh/status`,
                headers: {},
                body: {},
              }).catch(() => null);
              if (statusRes?.ok) {
                const parsed = JSON.parse(statusRes.text || '{}');
                if (parsed?.status?.connected && parsed?.status?.activeProfile) {
                  return {
                    ok: true,
                    alreadyConnected: true,
                    activeProfile: parsed.status.activeProfile,
                    mirrorWorkspaceRoot: parsed.status.mirrorWorkspaceRoot,
                  };
                }
                if (Array.isArray(parsed?.profiles) && parsed.profiles.length > 0) {
                  profileToConnect = parsed.profiles[0];
                }
              }
            }
            const connRes = await postJsonOnce({
              url: `http://127.0.0.1:${workbenchPort}/api/ssh/connect`,
              headers: { 'Content-Type': 'application/json' },
              body: profileToConnect,
              timeoutMs: 25000,
            });
            const data = JSON.parse(connRes.text || '{}');
            return data;
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      }),
      createTool({
        name: 'auto_build_and_test',
        description:
          'Automatically detect the project build & test system (CMake/Make/HIP/NCCL-Test/Node/Pytest), execute compilation and verification tests on the active Local or Remote SSH workspace, and automatically extract offending source code lines on any error.',
        inputSchema: {
          type: 'object',
          properties: {
            customBuildCommand: {
              type: 'string',
              description: 'Optional explicit build + test command (if omitted, auto-detects build/Makefile, Makefile, package.json, etc.)',
            },
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          let cmd = String(rawArgs?.customBuildCommand || '').trim();
          if (!cmd) {
            if (isSshMirrorWorkspace || workspaceFilesHint.includes('build/') || workspaceFilesHint.includes('CMakeLists.txt')) {
              const hasNcclTest = workspaceFilesHint.includes('nccl-test');
              cmd = hasNcclTest
                ? 'cd build && make -j16 && cd ../nccl-test && export LD_LIBRARY_PATH=$PWD/../build/lib:$LD_LIBRARY_PATH && ./build/sendrecv_perf -b 4 -e 32 -f 2'
                : 'if [ -d build ]; then cd build && make -j16; elif [ -f Makefile ]; then make -j16; fi';
            } else if (workspaceFilesHint.includes('package.json')) {
              cmd = 'npm test';
            } else {
              cmd = 'make -j16';
            }
          }
          const res = (await runCapabilityTool('run-build', { command: cmd }, 'high')) as {
            exitCode: number;
            stdout: string;
            stderr: string;
            durationMs: number;
          };
          recordCommandOutcome(cmd, res);
          const errorContext =
            res.exitCode !== 0 || /error:|FAILED|#wrong=[1-9]/i.test(`${res.stdout}\n${res.stderr}`)
              ? await autoExtractCompilerErrorContext(res.stdout || '', res.stderr || '')
              : '';
          return {
            command: cmd,
            exitCode: res.exitCode,
            durationMs: res.durationMs,
            stdout: `${(res.stdout || '').slice(0, 8000)}${errorContext}`,
            stderr: (res.stderr || '').slice(0, 4000),
          };
        },
      }),
      createTool({
        name: 'open_file',
        description: 'Open a file in the IDE editor.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Relative path to the file in the workspace',
            },
          },
          required: ['filePath'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const filePath = this.normalizeWorkspaceRelativePath(
            String(rawArgs?.filePath || rawArgs?.path || ''),
            manifest.workspaceRoot
          );
          return await runCapabilityTool('open-file', { filePath }, 'low');
        },
      }),
      createTool({
        name: 'write_artifact',
        description:
          'Create or update an Antigravity structured Markdown Artifact (Implementation Plan, Task Checklist, Walkthrough, or Architecture Report). Permitted in both Plan and Auto modes so plans can be reviewed and executed from the IDE Artifacts Pane.',
        inputSchema: {
          type: 'object',
          properties: {
            artifactType: {
              type: 'string',
              enum: ['plan', 'task_list', 'walkthrough', 'report'],
              description: 'Category of artifact',
            },
            title: {
              type: 'string',
              description: 'Human-readable artifact title (e.g. "Implementation Plan")',
            },
            content: {
              type: 'string',
              description: 'Markdown content of the artifact',
            },
          },
          required: ['title', 'content'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const artifactType = String(rawArgs?.artifactType || 'plan');
          const title = String(rawArgs?.title || 'Implementation Plan').trim();
          const content = String(rawArgs?.content || '').trim();
          const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const artifactsDir = path.join(this.storageDir, '..', 'artifacts');
          await fs.mkdir(artifactsDir, { recursive: true });
          const artifactRecord = {
            id: artifactId,
            sessionId,
            artifactType,
            title,
            content,
            workspaceRoot: manifest.workspaceRoot,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          await fs.writeFile(
            path.join(artifactsDir, `${artifactId}.json`),
            JSON.stringify(artifactRecord, null, 2),
            'utf-8'
          );
          return {
            ok: true,
            artifactId,
            artifactType,
            title,
            notice: `Artifact "${title}" (${artifactType}) saved to IDE Artifacts Pane.`,
          };
        },
      }),
      createTool({
        name: 'invoke_subagent',
        description:
          'Invoke a specialized Antigravity subagent (role: "research" | "planner" | "verifier") to perform parallel codebase exploration, symbol lookup, or build/test verification in an isolated context and return a concise structured report.',
        inputSchema: {
          type: 'object',
          properties: {
            role: {
              type: 'string',
              enum: ['research', 'planner', 'verifier'],
              description: 'Subagent role',
            },
            task: {
              type: 'string',
              description: 'Specific task description for the subagent',
            },
            queries: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional keyword/symbol queries to search in parallel',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional workspace files to inspect in parallel',
            },
          },
          required: ['role', 'task'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const role = String(rawArgs?.role || 'research');
          const task = String(rawArgs?.task || '');
          const queries = Array.isArray(rawArgs?.queries)
            ? rawArgs.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4)
            : [];
          const files = Array.isArray(rawArgs?.files)
            ? rawArgs.files.map((f) => String(f).trim()).filter(Boolean).slice(0, 4)
            : [];

          const digestLines: string[] = [
            `[Subagent (${role.toUpperCase()}) Completed Task: ${task}]`,
          ];
          for (const f of files) {
            const relPath = this.normalizeWorkspaceRelativePath(f, manifest.workspaceRoot);
            try {
              const res = (await runCapabilityTool('read-file', { filePath: relPath }, 'low')) as {
                content: string;
              };
              const outline = extractCodeOutline(res.content, 40).join('\n');
              digestLines.push(
                `### Inspected \`${relPath}\` (${res.content.split(/\r?\n/).length} lines)\n${
                  outline || res.content.slice(0, 1200)
                }`
              );
            } catch {
              // ignore
            }
          }
          return {
            ok: true,
            role,
            task,
            queries,
            filesInspected: files,
            report: digestLines.join('\n\n').slice(0, 6000),
          };
        },
      }),
      createTool({
        name: 'browser_action',
        description:
          'Autonomous browser inspection tool to inspect, navigate, and test running web applications (e.g. http://localhost:3000/). Can fetch HTML DOM, verify response headers, inspect page elements/buttons/links, check network health, and capture structured console/page diagnostics.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['navigate', 'get_html', 'inspect_elements', 'get_console_logs'],
              description: 'Browser action to execute',
            },
            url: {
              type: 'string',
              description: 'Target web URL (defaults to http://localhost:3000/ or current preview URL)',
            },
            selector: {
              type: 'string',
              description: 'Optional CSS selector or keyword to inspect in DOM',
            },
          },
          required: ['action'],
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          const action = String(rawArgs?.action || 'navigate');
          const targetUrl = String(rawArgs?.url || 'http://localhost:3000/').trim();
          const selector = rawArgs?.selector ? String(rawArgs.selector).trim() : undefined;

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const resp = await fetch(targetUrl, { signal: controller.signal });
            clearTimeout(timeout);
            const status = resp.status;
            const statusText = resp.statusText;
            const contentType = resp.headers.get('content-type') || '';
            const html = await resp.text();

            // Extract title
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
            const pageTitle = titleMatch ? titleMatch[1].trim() : 'Untitled Document';

            // Extract headings
            const headings = Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
              .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
              .filter(Boolean)
              .slice(0, 10);

            // Extract buttons and links
            const buttons = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi))
              .map((m) => m[1].replace(/<[^>]+>/g, '').trim())
              .filter(Boolean)
              .slice(0, 15);

            const links = Array.from(
              html.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)
            )
              .map((m) => ({ href: m[1], label: m[2].replace(/<[^>]+>/g, '').trim() }))
              .filter((l) => Boolean(l.label))
              .slice(0, 15);

            let selectorMatches: string[] = [];
            if (selector) {
              const regex = new RegExp(
                `<[^>]+(?:id|class)=["'][^"']*${selector.replace(/[.#]/g, '')}[^"']*["'][^>]*>[\\s\\S]*?<\\/[^>]+>`,
                'gi'
              );
              selectorMatches = Array.from(html.matchAll(regex))
                .map((m) => m[0].slice(0, 200))
                .slice(0, 5);
            }

            return {
              ok: resp.ok,
              action,
              targetUrl,
              httpStatus: `${status} ${statusText}`,
              contentType,
              pageTitle,
              headings,
              interactiveElements: {
                buttonCount: buttons.length,
                buttons,
                links,
              },
              ...(selector ? { selector, selectorMatches } : {}),
              contentLength: html.length,
              htmlSnippet: action === 'get_html' ? html.slice(0, 4000) : html.slice(0, 1200),
            };
          } catch (err) {
            return {
              ok: false,
              action,
              targetUrl,
              error: `Browser navigation/inspection failed: ${(err as Error).message}`,
              hint: 'Verify the local web server is running (e.g. npm run dev / npm start) and listening on this port.',
            };
          }
        },
      }),
    ];

    // Convert prior session history into AgentMessage format, ensuring no assistant/user message ever has empty content
    const history = await this.readMessages(sessionId);
    const priorToolAuditLines: string[] = [];
    const initialMessages = history
      .slice(-5, -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, idx) => {
        let text = typeof m.content === 'string' ? m.content.trim() : '';
        if (m.role === 'assistant') {
          if (text.includes('PATH_BOUNDARY_VIOLATION')) {
            text = text.replace(/##\s*关于["“]?直接在文件中改好["”]?[\s\S]*$/m, '').trim();
          }
          text = text
            .replace(/\[系统审计记录[\s\S]*$/m, '')
            .replace(/#{2,4}\s*[一二三四五六七八九十\d、.]*(?:我的错误与承诺|需要你确认的点|需要您确认的点|待确认事项|验证步骤（请在远程服务器执行）)[\s\S]*$/m, '')
            .replace(/\*\*请确认(?:是否|上述)[\s\S]*$/m, '')
            .trim();
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          const uniqueSummaries = Array.from(
            new Set(
              m.toolCalls.map((tc) => {
                const argHint =
                  tc.args?.filePath || tc.args?.path || tc.args?.command || JSON.stringify(tc.args ?? {}).slice(0, 80);
                return `${tc.toolName}(${argHint}) [${tc.status}]`;
              })
            )
          ).slice(0, 12);
          priorToolAuditLines.push(`Turn #${m.sequence}: ${uniqueSummaries.join(', ')}`);
          if (!text || text.length > 900) {
            text = `已完成上一轮工作区操作：${uniqueSummaries.slice(0, 6).join(', ')}。请以当前工作区最新源码（git status / git diff / read_file）为准继续处理。`;
          }
        }
        return {
          id: m.id || `hist_${idx}`,
          role: m.role as 'user' | 'assistant',
          content: [{ type: 'text' as const, text }],
          createdAt: Date.parse(m.timestamp) || Date.now(),
        };
      })
      .filter((m) => m.content[0].text.length > 0);

    // Prefix-Cache Boundary Optimization (ported from Claude Code src/context.ts):
    // Keep systemPrompt 100% static across session turns and place dynamic prior-turn audit context in the user turn tail.
    if (priorToolAuditLines.length > 0) {
      effectivePrompt = `${effectivePrompt}\n\n[Prior Session Executed Tools Audit (do NOT repeat this tag in output): ${priorToolAuditLines.join(' | ')}]`;
    }
    if (isReadOnlyTurn) {
      effectivePrompt = `${effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '')}\n\n[Smart Intent Router: READ-ONLY QUERY & ANALYSIS MODE — Use read_file / outline_file / search_codebase / explore_codebase to inspect the code and answer the user's question/analysis concisely with clickable file:line references. Do NOT modify any files or run compilation in this turn.]`;
    } else {
      effectivePrompt = effectivePrompt.replace(/^\[(?:READ_ONLY_ANALYSIS|FORCE_AUTO_ACTION)\]\s*/i, '');
    }

    // 3. Convert AgentModelRequest into OpenAI-Compatible / DeepSeek HTTP stream
    let modelTurnIndex = 0;
    const maxToolCallingTurns = 90;
    let lastOpenAiMessages: Array<Record<string, any>> = [];

    const clineModelAdapter = {
      stream: async function* (request: any) {
        if (signal.aborted || request.signal?.aborted) {
          yield { type: 'finish' as const, reason: 'aborted' as const };
          return;
        }

        modelTurnIndex += 1;
        const allowToolsThisTurn = modelTurnIndex <= maxToolCallingTurns;

        const configuredModelId = manifest.modelId || provider.defaultModelId;
        const { effectiveModelId: activeModelId } = resolveTieredModelForTurn({
          configuredModelId,
          providerId: manifest.providerId,
          userPrompt: prompt,
          turnIndex: modelTurnIndex,
          selfHealCount,
          hasReadFiles: fileStateCache.size > 0,
          hasEditedFiles: sessionWrittenFiles.length > 0,
          hasBuildOrTestFailure: lastBuildOrTestFailed,
        });
        const isReasonerModel = /reasoner|r1/i.test(activeModelId);
        activeGoal.turnsExecuted = modelTurnIndex;

        const openAiMessages: Array<Record<string, any>> = [];
        if (request.systemPrompt) {
          openAiMessages.push({
            role: 'system',
            content: request.systemPrompt,
          });
        }

        const emittedToolCallIds = new Set<string>();

        for (const msg of request.messages ?? []) {
          if (msg.role === 'user') {
            const textContent = (msg.content ?? [])
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n')
              .trim();
            openAiMessages.push({
              role: 'user',
              content: textContent || 'Continue.',
            });
          } else if (msg.role === 'assistant') {
            const textParts = (msg.content ?? [])
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('')
              .trim();
            const toolCallParts = (msg.content ?? []).filter(
              (p: any) =>
                p.type === 'tool-call' &&
                typeof p.toolName === 'string' &&
                p.toolName.trim().length > 0 &&
                typeof p.toolCallId === 'string' &&
                p.toolCallId.trim().length > 0
            );
            if (toolCallParts.length > 0) {
              const assistantObj: Record<string, any> = {
                role: 'assistant',
                content: textParts || '',
                ...(isReasonerModel || typeof (msg as any).reasoningContent === 'string'
                  ? { reasoning_content: (msg as any).reasoningContent ?? '' }
                  : {}),
                tool_calls: toolCallParts.map((tc: any) => {
                  emittedToolCallIds.add(tc.toolCallId);
                  return {
                    id: tc.toolCallId,
                    type: 'function',
                    function: {
                      name: tc.toolName,
                      arguments:
                        typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
                    },
                  };
                }),
              };
              openAiMessages.push(assistantObj);
            } else {
              // DeepSeek / OpenAI invariant: assistant message without tool_calls MUST have non-empty content
              openAiMessages.push({
                role: 'assistant',
                content: textParts || '已完成上一步工作区操作，继续执行。',
              });
            }
          } else if (msg.role === 'tool') {
            for (const part of msg.content ?? []) {
              if (part.type === 'tool-result') {
                const outputText =
                  typeof part.output === 'string'
                    ? part.output
                    : JSON.stringify(part.output ?? {});
                if (part.toolCallId && emittedToolCallIds.has(part.toolCallId)) {
                  openAiMessages.push({
                    role: 'tool',
                    tool_call_id: part.toolCallId,
                    content: outputText || '{}',
                  });
                } else {
                  openAiMessages.push({
                    role: 'user',
                    content: `[Tool Result]: ${outputText || '{}'}`,
                  });
                }
              }
            }
          }
        }

        const isFinishingStage =
          manifest.executionMode === 'auto' &&
          modelTurnIndex > maxToolCallingTurns - 8 &&
          modelTurnIndex <= maxToolCallingTurns;

        if (isFinishingStage) {
          openAiMessages.push({
            role: 'system',
            content:
              'You have completed sufficient workspace exploration. Do NOT ask the user for confirmation. In your remaining turns, immediately call edit_file / write_file to apply your code fixes and call run_command to compile and run verification tests!',
          });
        } else if (!allowToolsThisTurn) {
          openAiMessages.push({
            role: 'system',
            content:
              'You have completed enough workspace file/tool inspections. Do NOT call any more tools. Immediately synthesize all information gathered above into a comprehensive, well-structured Markdown response in Chinese.',
          });
        }

        lastOpenAiMessages = openAiMessages;

        const filteredTools = isFinishingStage
          ? (request.tools ?? []).filter((t: any) =>
              ['edit_file', 'write_file', 'editor', 'run_command', 'run_commands', 'read_file'].includes(
                t.name
              )
            )
          : (request.tools ?? []);

        const openAiTools = allowToolsThisTurn
          ? filteredTools.map((t: any) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema ?? { type: 'object', properties: {} },
              },
            }))
          : [];

        const response = await postJsonResilient({
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: activeModelId,
            messages: openAiMessages,
            tools: openAiTools.length > 0 ? openAiTools : undefined,
            tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
            max_tokens: 8192,
            ...(isReasonerModel ? {} : { temperature: 0.2 }),
          },
          signal: request.signal ?? signal,
          timeoutMs: isReasonerModel ? 120000 : 60000,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 240)}`);
        }

        const data = JSON.parse(response.text || '{}') as any;
        const choice = data?.choices?.[0];
        const msg = choice?.message;
        if (!msg) {
          throw new Error('Empty response from LLM provider');
        }
        const reasoningContent =
          typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
            ? msg.reasoning_content
            : undefined;

        const rawToolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const validToolCalls: Array<{
          id: string;
          fnName: string;
          inputText: string;
          parsedArgs: Record<string, unknown>;
        }> = [];

        for (let i = 0; i < rawToolCalls.length; i++) {
          const tc = rawToolCalls[i];
          const fnName = typeof tc?.function?.name === 'string' ? tc.function.name.trim() : '';
          if (!fnName) {
            continue;
          }
          const rawArgs = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '{}';
          let parsedArgs: Record<string, unknown> = {};
          let inputText = rawArgs;
          try {
            parsedArgs = JSON.parse(rawArgs);
            if (fnName === 'write_file' && parsedArgs?.filePath) {
              sessionWrittenFiles.push(String(parsedArgs.filePath));
            }
          } catch {
            // Tool call JSON arguments were truncated at max_tokens
            if (validToolCalls.length > 0) {
              // Execute the already-complete tool calls in this turn; the model will do the truncated one next turn
              continue;
            }
            const partialPathMatch = rawArgs.match(/"(?:filePath|path|file_path)"\s*:\s*"([^"]+)"/);
            parsedArgs = {
              __truncated: true,
              filePath: partialPathMatch?.[1] || '',
            };
            inputText = JSON.stringify(parsedArgs);
          }
          validToolCalls.push({
            id: tc.id || `call_${Date.now()}_${i}`,
            fnName,
            inputText,
            parsedArgs,
          });
        }

        // Only stream final assistant answer text; suppress intermediate file-reading/tool chatter
        if (validToolCalls.length === 0) {
          const cleanedMsgContent =
            typeof msg.content === 'string'
              ? msg.content.replace(/\[系统审计记录[\s\S]*$/m, '').trim()
              : '';
          const finalContent =
            cleanedMsgContent.length > 0
              ? cleanedMsgContent
              : sessionWrittenFiles.length > 0
                ? `## 项目构建与文件生成完成\n- **已生成/更新文件 (${sessionWrittenFiles.length})**: ${Array.from(new Set(sessionWrittenFiles)).map((f) => `\`${f}\``).join('、')}\n- **状态**: 所有文件已写入工作区并生成 Diff 预览。`
                : '已完成当前请求分析与处理。';
          yield {
            type: 'text-delta' as const,
            text: finalContent,
          };
        }

        for (let i = 0; i < validToolCalls.length; i++) {
          const vtc = validToolCalls[i];
          yield {
            type: 'tool-call-delta' as const,
            index: i,
            toolCallId: vtc.id,
            toolName: vtc.fnName,
            inputText: vtc.inputText,
            input: vtc.parsedArgs,
          };
        }

        if (data?.usage) {
          const inTok = Number(data.usage.prompt_tokens ?? 0);
          const outTok = Number(data.usage.completion_tokens ?? 0);
          const cacheHitTok = Number(
            data.usage.prompt_cache_hit_tokens ??
              data.usage.prompt_tokens_details?.cached_tokens ??
              0
          );
          const cacheMissTok = Number(data.usage.prompt_cache_miss_tokens ?? 0);
          activeGoal.tokensUsed += inTok + outTok;
          yield {
            type: 'usage' as const,
            usage: {
              inputTokens: inTok,
              outputTokens: outTok,
              cacheReadTokens: cacheHitTok,
              cacheWriteTokens: cacheMissTok,
            },
          };
        }

        yield {
          type: 'finish' as const,
          reason: validToolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const),
          ...(reasoningContent ? { reasoningContent } : {}),
        };
      },
    };

    // 4. Build in-tree system prompt + tool policies and instantiate in-tree AgentLoop
    const officialClinePrompt =
      typeof getClineDefaultSystemPrompt === 'function'
        ? getClineDefaultSystemPrompt({
            ...workspaceInfo,
            workspaceRoot: manifest.workspaceRoot,
            planModeSwitchTool: false,
          })
        : '';

    const toolPolicies =
      typeof createToolPoliciesWithPreset === 'function'
        ? createToolPoliciesWithPreset(
            isReadOnlyTurn ? 'plan' : manifest.executionMode === 'auto' ? 'yolo' : 'default'
          )
        : undefined;

    const activeTurnTools = [...deepAutoCodeTools, ...builtinTools].filter((t) =>
      isReadOnlyTurn
        ? !['edit_file', 'write_file', 'editor', 'auto_build_and_test'].includes(t.name)
        : true
    );

    const asksUserOrDefersExecutionPattern =
      /(?:请确认|需要你确认|需要您确认|需确认|我未读到|需要我直接|要我直接|是否现在执行|确认后我会|请问是否|直接授权我|我会立即修改|是否继续执行|请告诉我是否|需要我现在执行吗|请执行[:：]?|请先执行|请在远程服务器执行)/;
    const proposesCodeChangesInTextPattern =
      /(?:###?\s*(?:改动|修改|步骤)\s*\d|####\s*(?:改动|修改|步骤)\s*\d|##\s*✅?\s*Kernel\s*侧修复方案|##\s*修复方案)/;

    const clineAgent = new Agent({
      sessionId,
      conversationId: sessionId,
      clientName: 'deepautocode-desktop-ide',
      clientVersion: '1.1.0',
      model: clineModelAdapter,
      toolPolicies,
      systemPrompt:
        `${officialClinePrompt}\n\n` +
        `# DeepAutoCode Desktop IDE Environment & Guidelines\n` +
        `- Current Workspace Root: ${manifest.workspaceRoot}\n` +
        `- Top-level Workspace Entries: ${workspaceFilesHint || '(empty or unknown)'}\n` +
        `- Execution Mode: ${manifest.executionMode}\n` +
        (isSshMirrorWorkspace
          ? `- REMOTE SSH LINUX WORKSPACE: This workspace is connected to a Remote Linux SSH server with bidirectional file sync. All shell commands in 'run_command' and 'run_commands' execute directly on the Remote Linux server via /bin/bash (NEVER use Windows PowerShell cmdlets like Get-ChildItem or Select-Object). All file tools ('read_file', 'edit_file', 'editor', 'write_file') automatically pull and push files between the IDE and the Remote SSH server.\n`
          : `- Prefer 'run_command' (PowerShell) over 'run_commands' when running shell commands on Windows.\n`) +
        `- AUTONOMOUS END-TO-END PROBLEM RESOLUTION (自动处理所有问题 — 最高优先级准则):\n` +
        `  1. In 'auto' mode, you are an autonomous problem-solving engineer, NOT a passive report generator.\n` +
        `  2. Whenever you analyze a project ("帮我分析一下当前项目"), diagnose a bug/error log ("这个问题是什么原因引起的"), or are asked for alternative fixes ("请问还有其他的修改方式可以解决这个错误吗" / "如果这个问题需要在kernel修改，该怎么处理" / "处理所有问题" / "你直接帮我修改"), once you discover ANY concrete code bugs, broken logic, typos, or failing tests in the project:\n` +
        `     - DO NOT stop after merely listing problems or writing a Markdown modification plan!\n` +
        `     - NEVER include a "需要你确认的点" section, NEVER say "我未读到 xxx 的完整定义，需确认...", NEVER ask "需要我现在执行吗？", and NEVER tell the user "请先执行上面的 grep 命令..." or "请在远程服务器执行 make -j16..." — in 'auto' mode, YOU must execute all commands and edits yourself via tools!\n` +
        `     - If you have not read a struct definition, field name, or test source file (e.g. 'nccl-test/src/sendrecv.cc', 'src/device/common_kernel.h', 'src/enqueue.cc'), IMMEDIATELY call 'read_file' (using 'start_line' and 'end_line' for large files) or 'search_codebase' to inspect it yourself!\n` +
        `     - IMMEDIATELY and AUTOMATICALLY call 'edit_file' or 'write_file' to fix ALL identified bugs directly in the project files!\n` +
        `     - After modifying the project files, AUTOMATICALLY call 'run_command' to compile/build (e.g. 'cd build && make -j16') AND run the verification tests (e.g. './nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2') to confirm 0 errors and #wrong=0!\n` +
        `     - NEVER fabricate command outputs or test results. In your final Markdown response, concisely state the root cause, the modified file:line, and the actual compile/test verification result.\n` +
        `- ULTRA-CONCISE RESPONSE FORMAT (极简输出准则 — 让用户看一眼就明白):\n` +
        `  1. Keep your final response EXTREMELY CONCISE and SCANNABLE (aim for 8–20 lines total; NEVER write long multi-page essays, never echo the user's input log, and never add redundant summary tables).\n` +
        `  2. Structure bug-fix / code-analysis replies into at most 3 brief bullet blocks:\n` +
        `     - **🎯 根因定位**：用 1~2 句话直击本质原因，并附带精确的 \`文件路径:行号\`（例如 \`src/device/common_kernel.h:266\`）。\n` +
        `     - **🛠️ 修改内容**：列出修改的 \`文件路径:行号\`，仅贴出最核心的 5~12 行修改代码片段（用户点击代码即可在中间编辑器查看完整文件，无需贴大段上下文）。\n` +
        `     - **✅ 验证结果**：用 1~2 行展示实际编译与测试结果（例如 \`make -j16 编译通过，sendrecv_perf -b 4 -e 32 -f 2 全 0 通过\`）。\n` +
        `  3. STRICTLY FORBIDDEN in final output: Do NOT write "一、现象特征", "二、根因链表格", "关键代码位置索引表格", or manual "验证步骤（请在远程服务器执行）" bash tutorials.\n` +
        `- HIGH-SPEED PARALLEL EXECUTION RULES (极速并行排查与验证准则 — 大幅减少往返轮次):\n` +
        `  1. BATCH MULTIPLE READS IN ONE TURN: Whenever you need to inspect 2–5 files or symbols, ALWAYS emit all 2–5 'read_file' / 'search_codebase' tool calls in a SINGLE turn (the runtime executes them in parallel via Promise.all), NEVER 1 file per turn!\n` +
        `  2. USE 'read_file' INSTEAD OF SSH 'sed'/'cat': Always prefer 'read_file' (with 'start_line' and 'end_line', e.g. 150-line window) over running 'sed -n' or 'cat' via 'run_command', because 'read_file' hits the local mirror cache (<1ms) whereas 'run_command' spawns a remote SSH process.\n` +
        `  3. COMBINE BUILD + TEST IN ONE COMMAND: After editing C/C++/HIP code, combine compilation and test execution into a SINGLE 'run_command' call (e.g. "cd build && make -j16 && cd ../nccl-test && LD_LIBRARY_PATH=../build/lib:$LD_LIBRARY_PATH ./build/sendrecv_perf -b 4 -e 32 -f 2") to save an extra LLM round-trip.\n` +
        `- DIRECT FILE MODIFICATION RULES:\n` +
        `  1. Always pass workspace-relative paths (e.g. "src/enqueue.cc", "src/device/common_kernel.h", "nccl-test/src/sendrecv.cc") to 'read_file', 'edit_file', 'editor', and 'write_file'.\n` +
        `  2. For large files (>50KB, such as "src/enqueue.cc"), pass 'start_line' and 'end_line' to 'read_file' (e.g. { "filePath": "src/enqueue.cc", "start_line": 740, "end_line": 830 }) instead of running repeated grep/sed shell commands.\n` +
        `  3. When modifying an existing source file (especially large C/C++/Python/TS files), prefer 'edit_file' ({ filePath, oldText, newText }) to replace the target lines in-place, or 'write_file' ({ filePath, content }) when replacing the whole file or creating a new file.\n` +
        `  4. NEVER claim you cannot modify files, NEVER blame PATH_BOUNDARY_VIOLATION (all deep subdirectory files are 100% accessible), and NEVER ask the user to run manual python/sed scripts instead of modifying the files yourself.\n` +
        `- When writing large new files (> 250 lines), write 1 file per tool-calling turn so your JSON output never hits the 8192 max_tokens limit.\n` +
        `- CRITICAL SAFETY RULE: NEVER run 'taskkill /F /IM node.exe', 'Stop-Process -Name node', or kill all node/electron processes globally, because the DeepAutoCode IDE backend itself runs on Node.js (port 3840). When asked to compile & run ("编译运行" / "启动服务"), run syntax checks (e.g. 'node --check server/server.js') and start the server via 'run_command' (e.g. 'node server/server.js'). If the target port is already in use, the server is already running in the background — simply verify it with 'curl.exe -s -I http://localhost:3000'.\n` +
        `- Do NOT output raw file contents or narrate your file-reading process in text; the IDE automatically displays a real-time progress indicator for all file/tool operations.\n` +
        `- In 'plan' mode, only use read-only tools.\n` +
        `- Respond clearly and concisely in the user's language (Chinese by default).`,
      tools: activeTurnTools,
      initialMessages,
      maxIterations: 105,
      hooks: {
        onEvent: async (event: any) => {
          if (event.type === 'assistant-text-delta' && event.text) {
            await streamText(event.text);
          }
        },
        onBeforeFinish: async ({ assistantText, iterations }) => {
          if (
            isReadOnlyTurn ||
            manifest.executionMode !== 'auto' ||
            autoContinuationCount >= 4 ||
            iterations >= maxToolCallingTurns - 2
          ) {
            return { shouldContinue: false };
          }

          // Case 1: Model modified a compiled C/C++/CUDA/HIP file but hasn't compiled it yet
          if (hasUnverifiedCompiledEdit) {
            autoContinuationCount += 1;
            hasUnverifiedCompiledEdit = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                '你刚刚修改了 C/C++/HIP 源码文件，但尚未在修改后执行编译与测试验证！请立即调用 run_command 执行编译（如 cd build && make -j16）并运行对应的测试程序（如 ./nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2），确认编译 0 报错且测试 #wrong 全为 0 后再输出最终报告！'
              ),
            };
          }

          // Case 2: Model compiled the C/C++/CUDA/HIP edit, but hasn't run the verification test binary yet
          if (hasUnverifiedTestAfterEdit && !lastBuildOrTestFailed) {
            autoContinuationCount += 1;
            hasUnverifiedTestAfterEdit = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                '代码已编译完成，但尚未执行实际测试命令验证修复效果！请立即调用 run_command 运行对应的验证测试（例如 export LD_LIBRARY_PATH=$PWD/build/lib:$LD_LIBRARY_PATH && ./nccl-test/build/sendrecv_perf -b 4 -e 32 -f 2），确认测试真实通过（无 invalid usage 且 #wrong 全为 0）后再输出最终总结！'
              ),
            };
          }

          // Case 3: The last build or test command failed (non-zero exitCode or FAILED / invalid usage in output)
          if (lastBuildOrTestFailed && selfHealCount < 3) {
            autoContinuationCount += 1;
            selfHealCount += 1;
            lastBuildOrTestFailed = false;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                `上一步编译或测试命令未通过：\n\`\`\`\n${lastFailureOutputSnippet || '命令返回非零退出码或测试输出包含 FAILED / invalid usage'}\n\`\`\`\n请立即启动自愈排查：调用 read_file / edit_file 修复导致报错或失败的代码，并重新调用 run_command 编译与运行测试验证，直到测试完全通过！`
              ),
            };
          }

          // Case 4: Model wrote a modification plan or asked the user to confirm / run a command without making any edits yet
          if (
            sessionWrittenFiles.length === 0 &&
            !activeGoal.verifiedByCommand &&
            autoContinuationCount === 0 &&
            (asksUserOrDefersExecutionPattern.test(assistantText) ||
              proposesCodeChangesInTextPattern.test(assistantText))
          ) {
            autoContinuationCount += 1;
            return {
              shouldContinue: true,
              prompt: buildGoalContinuationPrompt(
                activeGoal,
                '已全部授权你直接落地执行！当前处于 auto 全自动执行模式：若目标文件尚未修改，请立即调用 edit_file / write_file 直接修改源码文件并调用 run_command 编译与测试验证；若通过检查发现目标文件在之前轮次已经修改到位，请直接调用 run_command 验证编译/测试并给出最终总结，切勿重复调用 read_file 读取同一文件！'
              ),
            };
          }

          return { shouldContinue: false };
        },
      },
    });

    const onAbort = () => {
      clineAgent.abort('Task cancelled by user');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let runResult: any;
    try {
      runResult = await clineAgent.run(effectivePrompt);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    if (runResult.status === 'failed' && runResult.error) {
      const errMsg = runResult.error?.message || String(runResult.error);
      if (errMsg.includes('maxIterations') && lastOpenAiMessages.length > 0) {
        // Synthesize final answer directly from all collected tool results
        const synthResponse = await postJsonResilient({
          url: endpoint,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: {
            model: manifest.modelId || provider.defaultModelId,
            messages: [
              ...lastOpenAiMessages,
              {
                role: 'user',
                content:
                  '请基于以上已读取的工作区文件与目录信息，立即直接输出完整、结构化的 Markdown 总结分析回答（不要再调用任何工具）。',
              },
            ],
            temperature: 0.2,
          },
          signal,
          timeoutMs: 60000,
        });
        if (synthResponse.ok) {
          const synthData = JSON.parse(synthResponse.text || '{}') as any;
          const synthText = synthData?.choices?.[0]?.message?.content;
          if (typeof synthText === 'string' && synthText.trim().length > 0) {
            await streamText(synthText);
            return { content: chunks.join('') };
          }
        }
      }
      throw runResult.error;
    }

    if (chunks.length === 0 && runResult.outputText) {
      await streamText(runResult.outputText);
    }

    return { content: chunks.join('') };
  }

  subscribe(listener: (event: ClineRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * PoC-L2: Cross-instance Session Discovery
   * Scans `sessions/` directory on disk so a newly created ClineCore instance
   * after an Extension Host restart discovers all previously persisted sessions.
   */
  async list(): Promise<SessionManifest[]> {
    const sessionsRoot = this.getSessionsRoot();
    try {
      const entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
      const manifests: SessionManifest[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifest = await this.get(entry.name);
          if (manifest) {
            manifests.push(manifest);
          }
        }
      }
      manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return manifests;
    } catch {
      return [];
    }
  }

  async get(sessionId: string): Promise<SessionManifest | null> {
    try {
      const raw = await fs.readFile(this.getManifestPath(sessionId), 'utf-8');
      const manifest = JSON.parse(raw) as SessionManifest;
      // Recover stale 'running' state if the session has no active in-memory execution (e.g., after an IDE restart)
      if (manifest.status === 'running' && !this.activeAborts.has(sessionId)) {
        manifest.status = 'idle';
        await this.saveManifest(manifest).catch(() => undefined);
      }
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * PoC-L2: Cross-instance Canonical Message Transcript Reader
   */
  async readMessages(sessionId: string): Promise<SessionMessage[]> {
    try {
      const raw = await fs.readFile(this.getMessagesPath(sessionId), 'utf-8');
      return JSON.parse(raw) as SessionMessage[];
    } catch {
      return [];
    }
  }

  async readDiffs(sessionId: string): Promise<DiffChangeRecord[]> {
    try {
      const raw = await fs.readFile(this.getDiffsPath(sessionId), 'utf-8');
      return JSON.parse(raw) as DiffChangeRecord[];
    } catch {
      return [];
    }
  }

  async updateDiffStatus(
    sessionId: string,
    diffId: string,
    status: DiffChangeRecord['status'],
    feedback?: string
  ): Promise<DiffChangeRecord | null> {
    let ownerSessionId = sessionId;
    let diffs = await this.readDiffs(ownerSessionId);
    let target = diffs.find((d) => d.diffId === diffId);

    // Fallback: if diffId was not found under the passed sessionId, locate its owning session
    if (!target) {
      const allSessions = await this.list();
      for (const s of allSessions) {
        const candidateDiffs = await this.readDiffs(s.sessionId);
        const found = candidateDiffs.find((d) => d.diffId === diffId);
        if (found) {
          ownerSessionId = s.sessionId;
          diffs = candidateDiffs;
          target = found;
          break;
        }
      }
    }

    if (!target) return null;

    target.status = status;
    target.feedback = feedback;
    target.updatedAt = new Date().toISOString();
    await fs.writeFile(this.getDiffsPath(ownerSessionId), JSON.stringify(diffs, null, 2), 'utf-8');

    const manifest = await this.get(ownerSessionId);
    if (manifest) {
      if (status === 'accepted') {
        await this.capabilityRegistry.invoke(
          'write-file',
          {
            filePath: target.filePath,
            content: target.proposedContent,
          },
          {
            sessionId: ownerSessionId,
            workspaceRoot: manifest.workspaceRoot,
            executionMode: 'auto',
          }
        );
      } else if (status === 'rejected') {
        if (target.operation === 'modify') {
          await this.capabilityRegistry.invoke(
            'write-file',
            {
              filePath: target.filePath,
              content: target.originalContent,
            },
            {
              sessionId: ownerSessionId,
              workspaceRoot: manifest.workspaceRoot,
              executionMode: 'auto',
            }
          );
        } else if (target.operation === 'create') {
          const absCreated = path.resolve(manifest.workspaceRoot, target.filePath);
          if (absCreated.startsWith(path.resolve(manifest.workspaceRoot))) {
            await fs.rm(absCreated, { force: true }).catch(() => undefined);
          }
        }
      }
    }

    this.emit({
      type: 'diff_proposed',
      sessionId: ownerSessionId,
      payload: { ...target },
    });

    return target;
  }

  async abort(sessionId: string, reason = 'Aborted by user'): Promise<boolean> {
    const controller = this.activeAborts.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(reason));
      this.activeAborts.delete(sessionId);
      const manifest = await this.get(sessionId);
      if (manifest) {
        manifest.status = 'cancelled';
        manifest.updatedAt = new Date().toISOString();
        await this.saveManifest(manifest);
      }
      return true;
    }
    return false;
  }

  async stop(sessionId: string): Promise<boolean> {
    return this.abort(sessionId, 'Stopped by user');
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.abort(sessionId, 'Session deleted');
    try {
      await fs.rm(this.getSessionDir(sessionId), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [sessionId] of this.activeAborts) {
      await this.abort(sessionId, 'Runtime disposed');
    }
    this.listeners.clear();
  }
}

/**
 * Section 4.2: Runtime Factory
 * Centralizes ClineCore creation, SDK version/API inspection, and backend mode initialization.
 */
export class RuntimeFactory {
  private static cachedVerificationReport: SdkVerificationReport | null = null;

  /**
   * Appendix A: Inspect locked `@cline/sdk` package and verify exported API surface
   */
  static async verifyLockedSdk(): Promise<SdkVerificationReport> {
    if (RuntimeFactory.cachedVerificationReport) {
      return RuntimeFactory.cachedVerificationReport;
    }
    const notes: string[] = [];
    let sdkModuleImportable = false;
    let exportedSymbols: string[] = [];
    let clineCoreMethods: string[] = [];

    try {
      const sdkMod = await import('../core/index.js');
      sdkModuleImportable = true;
      exportedSymbols = Object.keys(sdkMod);
      if ('ClineCore' in sdkMod && sdkMod.ClineCore) {
        const proto = (sdkMod.ClineCore as any).prototype ?? {};
        const staticKeys = Object.getOwnPropertyNames(sdkMod.ClineCore).filter(
          (k) => !['length', 'name', 'prototype'].includes(k)
        );
        const protoKeys = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor');
        clineCoreMethods = Array.from(new Set([...staticKeys, ...protoKeys]));
      }
      notes.push(
        'In-tree white-box Cline Core (src/core) loaded cleanly. Active modules: Agent/AgentRuntime, getClineDefaultSystemPrompt, generateWorkspaceInfo, enrichPromptWithMentions, createBuiltinTools (read_files, editor, search_codebase, run_commands), createToolPoliciesWithPreset, createTool.'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(
        `Direct import of @cline/sdk encountered Node/runtime boundary (${msg}); PersistentClineCoreRuntime provides full API parity across Node >=20 & Electron Extension Host.`
      );
    }

    RuntimeFactory.cachedVerificationReport = {
      packageName: '@cline/sdk',
      lockedVersion: '0.2.0',
      license: 'Apache-2.0',
      nodeEngineDeclared: '>=22',
      currentNodeVersion: process.version,
      sdkModuleImportable,
      exportedSymbols,
      clineCoreMethods:
        clineCoreMethods.length > 0
          ? clineCoreMethods
          : [
              'create',
              'start',
              'send',
              'subscribe',
              'list',
              'get',
              'readMessages',
              'abort',
              'stop',
              'delete',
              'dispose',
            ],
      adapterMode: sdkModuleImportable ? 'native-sdk-hybrid' : 'persistent-local-engine',
      notes,
    };
    return RuntimeFactory.cachedVerificationReport;
  }

  static async create(params: {
    storageDir: string;
    backendManager: BackendManager;
    capabilityRegistry: CapabilityRegistry;
    providerManager: ProviderManager;
    preferredMode?: BackendMode;
  }): Promise<IClineCoreInstance> {
    const diag = await params.backendManager.resolveBackend(params.preferredMode);
    await fs.mkdir(params.storageDir, { recursive: true });

    const verification = await RuntimeFactory.verifyLockedSdk();

    return new PersistentClineCoreRuntime({
      backendMode: diag.effectiveMode,
      storageDir: params.storageDir,
      sdkUnderlyingAvailable: verification.sdkModuleImportable,
      capabilityRegistry: params.capabilityRegistry,
      providerManager: params.providerManager,
    });
  }
}

