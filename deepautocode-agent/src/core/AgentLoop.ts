import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentTool, ToolPolicyMap } from './ToolSuite.js';
import {
  shouldCompactToolOutput,
  summarizeToolOutput,
} from './ToolResultSummarizer.js';
import {
  decideBudgetCompaction,
  resolveCompactionPlan,
} from './ContextCompaction.js';
import { MistakeTracker } from './MistakeTracker.js';
import { LoopDetection } from './LoopDetection.js';
import {
  resolvePhaseReasoningEffort,
  type AgentLoopPhase,
  type DeepSeekReasoningEffort,
} from './DeepSeekModels.js';
import type { VerifyConfig } from './VerifyConfig.js';

export interface AgentMessagePartText {
  type: 'text';
  text: string;
}

export interface AgentMessagePartToolCall {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown> | string;
}

export interface AgentMessagePartToolResult {
  type: 'tool-result';
  toolCallId: string;
  toolName?: string;
  output: unknown;
  isError?: boolean;
}

export type AgentMessagePart =
  | AgentMessagePartText
  | AgentMessagePartToolCall
  | AgentMessagePartToolResult;

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: AgentMessagePart[];
  reasoningContent?: string;
  createdAt: number;
}

export interface AgentModelStreamChunk {
  type: 'text-delta' | 'tool-call-delta' | 'usage' | 'finish';
  text?: string;
  reasoningContent?: string;
  index?: number;
  toolCallId?: string;
  toolName?: string;
  inputText?: string;
  input?: Record<string, unknown>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  reason?: 'stop' | 'tool-calls' | 'aborted' | 'length';
}

export interface AgentModelStreamRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool<any, any>[];
  signal?: AbortSignal;
  /** B2: Active state-machine phase ('plan' | 'exec' | 'verify') */
  phase?: AgentLoopPhase;
  /** B2: Graded DeepSeek reasoning effort ('low' | 'high' | 'max') */
  reasoningEffort?: DeepSeekReasoningEffort | null;
  /** A1: Suggested model tier ('flash' for PLAN, 'pro' for EXEC/VERIFY) */
  modelTier?: 'flash' | 'pro';
  /** B1: SHA-256 hash of the byte-stable prefix (systemPrompt + canonical tools) */
  prefixHash?: string;
}

export interface AgentModelAdapter {
  stream: (request: AgentModelStreamRequest) => AsyncGenerator<AgentModelStreamChunk, void, unknown>;
}

export interface StablePrefixBundle {
  stableSystemPrompt: string;
  orderedTools: AgentTool<any, any>[];
  prefixHash: string;
  dynamicTailPrompt: string;
  trailingDynamicContext: string;
}

/**
 * B1: Build a byte-stable Prefix Cache bundle for DeepSeek.
 * - Strips volatile timestamps or dynamic context markers out of the system prompt into `dynamicTailPrompt`.
 * - Appends static `projectRules` in a canonical block.
 * - Sorts `tools` deterministically by tool name so the prefix JSON never shifts across turns.
 */
export function buildStablePrefix(params: {
  systemPrompt: string;
  tools: AgentTool<any, any>[];
  projectRules?: string;
}): StablePrefixBundle {
  const rawPrompt = String(params.systemPrompt ?? '');
  const dynamicChunks: string[] = [];

  const stripped = rawPrompt
    .replace(/<dynamic_turn_state>[\s\S]*?<\/dynamic_turn_state>/gi, (m) => {
      dynamicChunks.push(m.trim());
      return '';
    })
    .replace(/^\[(?:Dynamic Context|Auto-Prefetched Workspace Files):[^\n]*\]$/gim, (m) => {
      dynamicChunks.push(m.trim());
      return '';
    })
    .replace(/\[Current Plan Checklist[\s\S]*?\]$/gim, (m) => {
      dynamicChunks.push(m.trim());
      return '';
    })
    .replace(/^Current (?:Local )?Time:\s*[^\n]+$/gim, (m) => {
      dynamicChunks.push(m.trim());
      return '';
    })
    .trim();

  const rulesBlock = params.projectRules?.trim()
    ? `\n\n<project_rules>\n${params.projectRules.trim()}\n</project_rules>`
    : '';
  const stableSystemPrompt = `${stripped}${rulesBlock}`;

  const orderedTools = [...(params.tools ?? [])].sort((a, b) =>
    String(a.name).localeCompare(String(b.name))
  );
  const canonicalToolDescriptors = orderedTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
  }));

  const prefixHash = crypto
    .createHash('sha256')
    .update(stableSystemPrompt)
    .update('\0')
    .update(JSON.stringify(canonicalToolDescriptors))
    .digest('hex');

  const dynamicTailPrompt = dynamicChunks.join('\n');
  return {
    stableSystemPrompt,
    orderedTools,
    prefixHash,
    dynamicTailPrompt,
    trailingDynamicContext: dynamicTailPrompt,
  };
}

/**
 * A3: Dynamic iteration budget based on planned todo count:
 * `min(75, 10 + todoCount * 5)` (while honoring explicit smaller test caps).
 */
export function computeDynamicMaxIterations(
  todoCount: number,
  configuredMax?: number
): number {
  const count = Math.max(0, Math.floor(Number(todoCount) || 0));
  const dynamic = Math.min(75, 10 + count * 5);
  if (typeof configuredMax === 'number' && configuredMax > 0) {
    return Math.min(configuredMax, dynamic);
  }
  return dynamic;
}

/**
 * C3: Cross-turn session-level read cache with file `mtimeMs` invalidation.
 */
export interface SessionReadCacheEntry {
  output: unknown;
  count: number;
  filePath?: string;
  mtimeMs?: number | null;
}

export class SessionReadCache {
  private readonly store = new Map<string, SessionReadCacheEntry>();
  private readonly workspaceRoot?: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private resolveTargetFilePath(input: Record<string, unknown>): string | undefined {
    const raw =
      (typeof input?.filePath === 'string' && input.filePath) ||
      (typeof input?.path === 'string' && input.path) ||
      undefined;
    if (!raw) return undefined;
    return this.workspaceRoot ? path.resolve(this.workspaceRoot, raw) : path.resolve(raw);
  }

  private readMtimeMs(resolvedPath?: string): number | null {
    if (!resolvedPath) return null;
    try {
      return fs.statSync(resolvedPath).mtimeMs;
    } catch {
      return null;
    }
  }

  public get(key: string, input?: Record<string, unknown>): SessionReadCacheEntry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    const targetPath = entry.filePath ?? (input ? this.resolveTargetFilePath(input) : undefined);
    if (targetPath && entry.mtimeMs != null) {
      const currentMtime = this.readMtimeMs(targetPath);
      if (currentMtime === null || Math.abs(currentMtime - entry.mtimeMs) > 0.5) {
        this.store.delete(key);
        return undefined;
      }
    }
    return entry;
  }

  public set(key: string, value: { output: unknown; count: number }, input?: Record<string, unknown>): void {
    const filePath = input ? this.resolveTargetFilePath(input) : undefined;
    const mtimeMs = this.readMtimeMs(filePath);
    this.store.set(key, {
      output: value.output,
      count: value.count,
      filePath,
      mtimeMs,
    });
  }

  public has(key: string, input?: Record<string, unknown>): boolean {
    return this.get(key, input) !== undefined;
  }

  public invalidateFile(rawPath?: string): void {
    if (!rawPath) {
      this.store.clear();
      return;
    }
    const resolved = this.workspaceRoot
      ? path.resolve(this.workspaceRoot, rawPath)
      : path.resolve(rawPath);
    const norm = resolved.replace(/\\/g, '/').toLowerCase();
    for (const [k, v] of this.store.entries()) {
      if (!v.filePath) {
        this.store.delete(k);
        continue;
      }
      const entryNorm = v.filePath.replace(/\\/g, '/').toLowerCase();
      if (entryNorm === norm || entryNorm.endsWith('/' + norm) || norm.endsWith('/' + entryNorm)) {
        this.store.delete(k);
      }
    }
  }

  public clear(): void {
    this.store.clear();
  }

  public get size(): number {
    return this.store.size;
  }
}

export interface AgentOptions {
  sessionId: string;
  conversationId?: string;
  clientName?: string;
  clientVersion?: string;
  workspaceRoot?: string;
  model: AgentModelAdapter;
  /** A1: Optional dedicated lightweight model (e.g. deepseek-flash) for Phase PLAN */
  planModel?: AgentModelAdapter;
  /** A1: Enable explicit Plan phase before Exec phase */
  enablePlanPhase?: boolean;
  /** B1: Static project rules included in the byte-stable prefix */
  projectRules?: string;
  /** C3: Shared session-level read cache with mtime invalidation */
  sessionReadCache?: SessionReadCache;
  /** D2: Verification gate configuration hard-bound to Phase VERIFY */
  verifyConfig?: VerifyConfig;
  /** D2: Force running Phase VERIFY whenever files are mutated (default true when verifyConfig or verifyRunner is set) */
  enforceVerifyGate?: boolean;
  /** D2: Max verify-to-exec self-healing retries (default 2) */
  maxVerifyRetries?: number;
  /** D2: Optional custom verify runner (defaults to invoking run_command / run-build tool) */
  verifyRunner?: (command: string) => Promise<{ exitCode: number; stdout?: string; stderr?: string; error?: string }>;
  toolPolicies?: ToolPolicyMap;
  systemPrompt: string;
  tools: AgentTool<any, any>[];
  initialMessages?: AgentMessage[];
  maxIterations?: number;
  /**
   * Optional live token budget for compaction. When provided, older tool
   * outputs are summarized more aggressively as fillRatio rises.
   */
  getContextBudget?: () => { tokensUsed: number; tokenBudget: number | null };
  /** Optional shared mistake tracker (Runtime wires Trace/circuit). */
  mistakeTracker?: MistakeTracker;
  /** Optional shared loop detector. */
  loopDetection?: LoopDetection;
  /**
   * Called when tool policy is `ask` (including hard workspace rules).
   * Return false / throw to block the tool.
   */
  requestToolApproval?: (input: {
    toolName: string;
    args: Record<string, unknown>;
    summary: string;
  }) => Promise<{ approved: boolean; reason?: string }>;
  hooks?: {
    onEvent?: (event: { type: string; text?: string; [key: string]: unknown }) => Promise<void> | void;
    onBeforeFinish?: (context: {
      assistantText: string;
      iterations: number;
      messages: AgentMessage[];
      consecutiveMistakes?: number;
    }) => Promise<{ shouldContinue: boolean; prompt?: string } | void>;
  };
}

export interface AgentRunResult {
  status: 'completed' | 'failed' | 'aborted';
  messages: AgentMessage[];
  iterations: number;
  todos?: string[];
  prefixHash?: string;
  verifyRuns?: number;
  error?: Error;
}

const READ_ONLY_PARALLEL_TOOLS = new Set([
  'read_file',
  'read_files',
  'outline_file',
  'search_codebase',
  'explore_codebase',
  'invoke_subagent',
  'browser_action',
  'list_files',
  'open_file_in_ide',
  'manage_todo',
  'manage_task',
  'search_web',
]);

const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'editor']);

function isPureReadOnlyShellCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  if (
    /(?:>|>>|\bsed\s+-i\b|\bmake\b|\bcmake\b|\bninja\b|\bhipcc\b|\bnvcc\b|\bgcc\b|\bg\+\+\b|\bclang\b|\brm\b|\bmv\b|\bcp\b|\btee\b|\bpatch\b|\bgit\s+(?:checkout|reset|clean|apply|commit|stash)\b|\bpython3?\s+-c\b|_perf\b|\bpytest\b|\bnpm\b|\bnode\b)/.test(
      trimmed
    )
  ) {
    return false;
  }
  return /^\s*(?:cd\s+[^;&|]+\s*&&\s*)?(?:grep|egrep|fgrep|rg|sed\s+-n|head|tail|cat|ls|find|wc|stat|file|nm|objdump|readelf|git\s+(?:status|diff|log|show|branch))\b/.test(
    trimmed
  );
}

function canonicalizeToolCallKey(toolName: string, input: Record<string, unknown>): string {
  const sortedEntries = Object.keys(input ?? {})
    .sort()
    .map((k) => [k, input[k]]);
  return `${toolName}:${JSON.stringify(sortedEntries)}`;
}

/**
 * A2: Check whether a tool call is an `edit_file` operation whose `oldText`/`target`
 * match can be preflight-verified in parallel (read-only) before serial disk mutation.
 */
export function isPreflightableEditTool(
  tc:
    | string
    | {
        toolName?: string;
        name?: string;
        input?: Record<string, unknown>;
        args?: Record<string, unknown>;
      }
): boolean {
  if (typeof tc === 'string') {
    return tc === 'edit_file' || tc === 'editor';
  }
  const toolName = tc.toolName ?? tc.name ?? '';
  if (toolName !== 'edit_file' && toolName !== 'editor') return false;
  const payload = tc.input ?? tc.args;
  if (!payload) return true;
  const filePath = payload.filePath ?? payload.path;
  const oldText = payload.oldText ?? payload.target;
  return typeof filePath === 'string' && filePath.length > 0 && typeof oldText === 'string' && oldText.length > 0;
}

/**
 * A2: Standalone parallel read-only preflight check for a batch of `edit_file` calls.
 */
export async function preflightEditBatch(
  calls: Array<{
    toolCallId?: string;
    id?: string;
    toolName?: string;
    name?: string;
    input?: Record<string, unknown>;
    args?: Record<string, unknown>;
  }>,
  workspaceRoot?: string
): Promise<Map<string, { ok: boolean; error?: string; reason?: string }>> {
  const results = new Map<string, { ok: boolean; error?: string; reason?: string }>();
  if (!workspaceRoot) {
    return results;
  }
  await Promise.all(
    calls.map(async (tc) => {
      if (!isPreflightableEditTool(tc)) return;
      const callId = String(tc.toolCallId ?? tc.id ?? '');
      const payload = tc.input ?? tc.args ?? {};
      const rawFile = String(payload.filePath ?? payload.path ?? '');
      const oldText = String(payload.oldText ?? payload.target ?? '');
      const resolved = path.resolve(workspaceRoot, rawFile);
      try {
        const content = await fs.promises.readFile(resolved, 'utf-8');
        const normContent = content.replace(/\r\n/g, '\n');
        const normOld = oldText.replace(/\r\n/g, '\n');
        if (!normContent.includes(normOld)) {
          const msg = `PREFLIGHT_OLD_TEXT_NOT_FOUND: Target snippet not found in ${rawFile}. Re-read the file before editing.`;
          results.set(callId, {
            ok: false,
            error: msg,
            reason: msg,
          });
        } else {
          results.set(callId, { ok: true });
        }
      } catch (err) {
        const msg = `PREFLIGHT_FILE_ERROR: Cannot read ${rawFile}: ${err instanceof Error ? err.message : String(err)}`;
        results.set(callId, {
          ok: false,
          error: msg,
          reason: msg,
        });
      }
    })
  );
  return results;
}

/**
 * In-tree White-Box Agent Execution Loop (DeepSeek Plan-Execute-Verify Architecture)
 */
export class Agent {
  private readonly options: AgentOptions;
  private readonly abortController = new AbortController();
  private abortReason = 'Aborted';
  private readonly mistakeTracker: MistakeTracker;
  private readonly loopDetection: LoopDetection;
  private readonly sessionReadCache: SessionReadCache;
  private lastCompactionStage: string = 'none';
  private plannedTodos: string[] = [];

  constructor(options: AgentOptions) {
    this.options = options;
    this.mistakeTracker = options.mistakeTracker ?? new MistakeTracker();
    this.loopDetection = options.loopDetection ?? new LoopDetection();
    this.sessionReadCache =
      options.sessionReadCache ?? new SessionReadCache(options.workspaceRoot);
  }

  public abort(reason = 'Task cancelled by user'): void {
    this.abortReason = reason;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error(reason));
    }
  }

  public getSessionReadCache(): SessionReadCache {
    return this.sessionReadCache;
  }

  /**
   * C1 & C2: Budget-driven + pressure-aware compaction of older tool outputs.
   */
  public compactOlderToolOutputsIfNeeded(messages: AgentMessage[]): void {
    let totalChars = 0;
    const budgetItems = messages.map((msg) => {
      let msgChars = 0;
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const str =
            typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
          totalChars += str.length;
          msgChars += str.length;
        } else if (part.type === 'text') {
          msgChars += (part.text || '').length;
        } else if (part.type === 'tool-call') {
          msgChars += JSON.stringify(part.input ?? {}).length;
        }
      }
      return {
        id: msg.id,
        role: msg.role,
        chars: msgChars,
      };
    });

    const budget = this.options.getContextBudget?.() || {
      tokensUsed: 0,
      tokenBudget: null,
    };
    const plan = resolveCompactionPlan({
      toolResultChars: totalChars,
      tokenBudget: budget.tokenBudget,
      tokensUsed: budget.tokensUsed,
    });

    // C1: Run token-budget 3-tier decision ({ keep, summarize, drop })
    const softTokenBudget =
      typeof budget.tokenBudget === 'number' && budget.tokenBudget > 0
        ? Math.min(128_000, Math.floor(budget.tokenBudget * 0.8))
        : 128_000;
    const budgetDecision = decideBudgetCompaction(budgetItems, {
      softTokenBudget,
      keepRecentCount: plan.keepRecentMessages,
    });
    const dropIds = new Set(budgetDecision.drop);
    const summarizeIds = new Set(budgetDecision.summarize);

    if (plan.warnBudget || (plan.shouldCompact && plan.stage !== this.lastCompactionStage)) {
      void this.options.hooks?.onEvent?.({
        type: 'context.pressure',
        fillRatio: plan.fillRatio,
        stage: plan.stage,
        reason: plan.reason,
        trigger: plan.trigger,
        estimatedToolTokens: plan.estimatedToolTokens,
        warnBudget: plan.warnBudget,
        budgetDecision: {
          keepCount: budgetDecision.keep.length,
          summarizeCount: budgetDecision.summarize.length,
          dropCount: budgetDecision.drop.length,
        },
      });
    }
    this.lastCompactionStage = plan.stage;
    if (!plan.shouldCompact && dropIds.size === 0 && summarizeIds.size === 0) {
      return;
    }
    const cutoff = Math.max(0, messages.length - plan.keepRecentMessages);
    for (let i = 0; i < cutoff; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      const isDropped = dropIds.has(msg.id);
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue;
        if (isDropped) {
          part.output = `[dropped tool output of ${part.toolName || 'tool'} under token budget pressure]`;
          continue;
        }
        if (!shouldCompactToolOutput(part.output, plan.minCharsToSummarize)) continue;
        const existing =
          typeof part.output === 'string'
            ? part.output
            : JSON.stringify(part.output ?? '');
        if (
          existing.startsWith('[compacted summary of ') &&
          plan.reason !== 'critical-context-pressure'
        ) {
          continue;
        }
        if (
          existing.startsWith('[compacted summary of ') &&
          existing.length <= plan.summaryMaxChars
        ) {
          continue;
        }
        const originalChars = existing.length;
        part.output = summarizeToolOutput(part.toolName, part.output, originalChars, {
          maxChars: plan.summaryMaxChars,
        });
      }
    }
  }

  /**
   * A2: Parallel read-only preflight check for a batch of `edit_file` calls.
   * Verifies `oldText` / `target` presence on disk concurrently before serial mutation.
   */
  public async preflightEditBatch(
    calls: Array<{
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    }>
  ): Promise<Map<string, { ok: boolean; error?: string }>> {
    const results = new Map<string, { ok: boolean; error?: string }>();
    if (!this.options.workspaceRoot) {
      return results;
    }
    const root = this.options.workspaceRoot;
    await Promise.all(
      calls.map(async (tc) => {
        if (!isPreflightableEditTool(tc)) return;
        const rawFile = String(tc.input.filePath ?? tc.input.path ?? '');
        const oldText = String(tc.input.oldText ?? tc.input.target ?? '');
        const resolved = path.resolve(root, rawFile);
        try {
          const content = await fs.promises.readFile(resolved, 'utf-8');
          const normContent = content.replace(/\r\n/g, '\n');
          const normOld = oldText.replace(/\r\n/g, '\n');
          if (!normContent.includes(normOld)) {
            results.set(tc.toolCallId, {
              ok: false,
              error: `PREFLIGHT_OLD_TEXT_NOT_FOUND: Target snippet not found in ${rawFile}. Re-read the file before editing.`,
            });
          } else {
            results.set(tc.toolCallId, { ok: true });
          }
        } catch (err) {
          results.set(tc.toolCallId, {
            ok: false,
            error: `PREFLIGHT_FILE_ERROR: Cannot read ${rawFile}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })
    );
    if (results.size > 0) {
      void this.options.hooks?.onEvent?.({
        type: 'agent.preflight',
        checkedCount: results.size,
        failedCount: Array.from(results.values()).filter((r) => !r.ok).length,
      });
    }
    return results;
  }

  private async executeSingleToolCall(
    tc: {
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    },
    toolMap: Map<string, AgentTool<any, any>>,
    executedReadCache: SessionReadCache
  ): Promise<AgentMessagePartToolResult> {
    const policy = this.options.toolPolicies?.[tc.toolName];
    if (policy === 'deny') {
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: {
          error: `POLICY_DENIED: Tool '${tc.toolName}' is not permitted in the current execution mode.`,
        },
        isError: true,
      };
    }
    if (policy === 'ask') {
      if (!this.options.requestToolApproval) {
        return {
          type: 'tool-result',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: {
            error: `APPROVAL_REQUIRED: Tool '${tc.toolName}' requires approval but no approval handler is registered.`,
          },
          isError: true,
        };
      }
      try {
        const decision = await this.options.requestToolApproval({
          toolName: tc.toolName,
          args: tc.input,
          summary: `Approve tool '${tc.toolName}'`,
        });
        if (!decision.approved) {
          return {
            type: 'tool-result',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            output: {
              error: `USER_REJECTED: ${decision.reason || 'User rejected tool call'}`,
            },
            isError: true,
          };
        }
      } catch (err) {
        return {
          type: 'tool-result',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: {
            error: `USER_REJECTED: ${err instanceof Error ? err.message : String(err)}`,
          },
          isError: true,
        };
      }
    }

    const toolDef = toolMap.get(tc.toolName);
    if (!toolDef) {
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { error: `Unknown tool '${tc.toolName}'` },
        isError: true,
      };
    }

    const isCacheableRead =
      READ_ONLY_PARALLEL_TOOLS.has(tc.toolName) ||
      ((tc.toolName === 'run_command' || tc.toolName === 'run-build') &&
        isPureReadOnlyShellCommand(String(tc.input?.command || '')));

    if (MUTATING_TOOLS.has(tc.toolName)) {
      const targetPath =
        (typeof tc.input?.filePath === 'string' && tc.input.filePath) ||
        (typeof tc.input?.path === 'string' && tc.input.path) ||
        undefined;
      executedReadCache.invalidateFile(targetPath);
    } else if (!isCacheableRead) {
      executedReadCache.clear();
    }

    const cacheKey = isCacheableRead ? canonicalizeToolCallKey(tc.toolName, tc.input) : '';
    const cached = cacheKey ? executedReadCache.get(cacheKey, tc.input) : undefined;
    if (cacheKey && cached) {
      cached.count += 1;
      const baseOutput =
        typeof cached.output === 'object' && cached.output !== null
          ? { ...(cached.output as Record<string, unknown>) }
          : { result: cached.output };
      if (cached.count >= 2 && typeof (baseOutput as any).content === 'string' && (baseOutput as any).content.length > 1600) {
        (baseOutput as any).content = `${(baseOutput as any).content.slice(0, 1200)}\n...[duplicate read omitted — already in context]...`;
      }
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: {
          ...baseOutput,
          _duplicateCallBlocked: true,
          _notice:
            'DUPLICATE_TOOL_CALL_NOTICE: You already executed this exact read/search command earlier in this session and no files have been modified since. Do NOT repeat the same command again! Immediately proceed to the next step (e.g. call edit_file / write_file to apply your code fix, or call run_command to compile and run verification tests).',
        },
      };
    }

    const loopHit = this.loopDetection.observeToolCall(tc.toolName, tc.input);
    if (loopHit) {
      this.mistakeTracker.recordMistake('wrong_tool', loopHit.reason);
      void this.options.hooks?.onEvent?.({
        type: 'agent.loop',
        kind: loopHit.kind,
        reason: loopHit.reason,
        count: loopHit.count,
        toolName: tc.toolName,
        consecutiveMistakes: this.mistakeTracker.getConsecutiveMistakes(),
      });
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: {
          error: `LOOP_DETECTED: ${loopHit.reason}. Stop repeating the same tool call; change strategy (different args, different tool, or summarize failure).`,
        },
        isError: true,
      };
    }

    try {
      const output = await toolDef.execute(tc.input, {
        signal: this.abortController.signal,
      });
      const isErrObj =
        typeof output === 'object' &&
        output !== null &&
        (Boolean((output as any).error) ||
          (typeof (output as any).exitCode === 'number' && (output as any).exitCode !== 0));
      if (isErrObj) {
        const count = this.mistakeTracker.recordMistake(
          'tool_error',
          typeof (output as any).error === 'string' ? (output as any).error : tc.toolName
        );
        void this.options.hooks?.onEvent?.({
          type: 'agent.mistake',
          kind: 'tool_error',
          toolName: tc.toolName,
          consecutiveMistakes: count,
        });
      } else if (MUTATING_TOOLS.has(tc.toolName) || tc.toolName === 'run_command' || tc.toolName === 'run_commands') {
        this.mistakeTracker.recordSuccess();
      }
      if (cacheKey && !isErrObj) {
        executedReadCache.set(cacheKey, { output, count: 1 }, tc.input);
      }
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output,
        isError: isErrObj || undefined,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const count = this.mistakeTracker.recordMistake('tool_error', errMsg);
      void this.options.hooks?.onEvent?.({
        type: 'agent.mistake',
        kind: 'tool_error',
        toolName: tc.toolName,
        consecutiveMistakes: count,
      });
      return {
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { error: errMsg },
        isError: true,
      };
    }
  }

  /**
   * A1 Phase 1: `runPlan` — Lightweight planning pass (deepseek-flash, reasoningEffort: 'high')
   * Produces a structured todo list and registers it via `manage_todo` if available.
   */
  public async runPlan(
    userPrompt: string,
    messages: AgentMessage[],
    toolMap: Map<string, AgentTool<any, any>>,
    stablePrefix: StablePrefixBundle
  ): Promise<string[]> {
    const planner = this.options.planModel ?? this.options.model;
    void this.options.hooks?.onEvent?.({
      type: 'agent.phase',
      phase: 'plan',
      modelTier: 'flash',
      reasoningEffort: 'high',
    });

    const planMessages: AgentMessage[] = [
      ...messages,
      {
        id: `msg_plan_req_${Date.now()}`,
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Break down the task into a concise numbered todo list (2-6 actionable steps). Task: ${userPrompt}`,
          },
        ],
        createdAt: Date.now(),
      },
    ];

    let planText = '';
    const todoCalls: Array<Record<string, unknown>> = [];
    const stream = planner.stream({
      systemPrompt: stablePrefix.stableSystemPrompt,
      messages: planMessages,
      tools: stablePrefix.orderedTools,
      signal: this.abortController.signal,
      phase: 'plan',
      modelTier: 'flash',
      reasoningEffort: resolvePhaseReasoningEffort('plan'),
      prefixHash: stablePrefix.prefixHash,
    });

    for await (const chunk of stream) {
      if (this.abortController.signal.aborted) break;
      if (chunk.type === 'text-delta' && chunk.text) {
        planText += chunk.text;
      } else if (chunk.type === 'tool-call-delta' && chunk.toolName === 'manage_todo' && chunk.input) {
        todoCalls.push(chunk.input);
      }
    }

    const extractedTodos: string[] = [];
    for (const tcInput of todoCalls) {
      if (Array.isArray(tcInput.todos)) {
        for (const item of tcInput.todos) {
          const title = typeof item === 'string' ? item : String((item as any)?.title || (item as any)?.text || '');
          if (title.trim()) extractedTodos.push(title.trim());
        }
      }
    }

    if (extractedTodos.length === 0 && planText.trim()) {
      for (const line of planText.split('\n')) {
        const m = line.trim().match(/^(?:\d+[.)]|[-*•])\s+(.+)$/);
        if (m && m[1].trim()) {
          extractedTodos.push(m[1].trim());
        }
      }
    }

    if (extractedTodos.length > 0 && toolMap.has('manage_todo')) {
      try {
        await toolMap.get('manage_todo')!.execute(
          {
            action: 'set',
            todos: extractedTodos.map((t, i) => ({
              id: `todo_${i + 1}`,
              title: t,
              status: 'pending',
            })),
          },
          { signal: this.abortController.signal }
        );
      } catch {
        // ignore optional manage_todo errors
      }
    }

    this.plannedTodos = extractedTodos;
    return extractedTodos;
  }

  /**
   * A1 Phase 2: `runExec` — Main execution loop with parallel read batching,
   * parallel `edit_file` preflight (A2), dynamic iteration budget (A3), and graded thinking (B2).
   */
  public async runExec(
    messages: AgentMessage[],
    toolMap: Map<string, AgentTool<any, any>>,
    stablePrefix: StablePrefixBundle,
    state: {
      maxIterations: number;
      iterations: number;
      hasMutatedFiles: boolean;
      verifiedSinceLastMutation: boolean;
      isRetryAfterVerifyFailure: boolean;
      todos: string[];
      currentTodoIndex: number;
    }
  ): Promise<{
    status: 'completed' | 'failed' | 'aborted';
    assistantText: string;
    error?: Error;
  }> {
    while (state.iterations < state.maxIterations) {
      if (this.abortController.signal.aborted) {
        return {
          status: 'aborted',
          assistantText: '',
          error: new Error(this.abortReason),
        };
      }

      state.iterations += 1;
      this.compactOlderToolOutputsIfNeeded(messages);

      const reasoningEffort = resolvePhaseReasoningEffort('exec', {
        isRetryAfterFailure: state.isRetryAfterVerifyFailure,
        consecutiveMistakes: this.mistakeTracker.getConsecutiveMistakes(),
      });

      void this.options.hooks?.onEvent?.({
        type: 'agent.phase',
        phase: 'exec',
        iteration: state.iterations,
        maxIterations: state.maxIterations,
        reasoningEffort,
        currentTodo:
          state.todos.length > 0
            ? state.todos[Math.min(state.currentTodoIndex, state.todos.length - 1)]
            : undefined,
      });

      // Inject current todo item into the trailing message list (preserving byte-identical prefix!)
      const activeTodo =
        state.todos.length > 0
          ? state.todos[Math.min(state.currentTodoIndex, state.todos.length - 1)]
          : undefined;
      const streamMessages: AgentMessage[] =
        activeTodo
          ? [
              ...messages,
              {
                id: `msg_todo_ctx_${state.iterations}`,
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `[Active Plan Step ${Math.min(state.currentTodoIndex + 1, state.todos.length)}/${state.todos.length}]: ${activeTodo}`,
                  },
                ],
                createdAt: Date.now(),
              },
            ]
          : messages;

      let assistantText = '';
      let assistantReasoning = '';
      const pendingToolCalls: Array<{
        toolCallId: string;
        toolName: string;
        inputText: string;
        input: Record<string, unknown>;
      }> = [];

      const stream = this.options.model.stream({
        systemPrompt: stablePrefix.stableSystemPrompt,
        messages: streamMessages,
        tools: stablePrefix.orderedTools,
        signal: this.abortController.signal,
        phase: 'exec',
        modelTier: 'pro',
        reasoningEffort,
        prefixHash: stablePrefix.prefixHash,
      });

      for await (const chunk of stream) {
        if (this.abortController.signal.aborted) {
          return {
            status: 'aborted',
            assistantText,
            error: new Error(this.abortReason),
          };
        }

        if (typeof chunk.reasoningContent === 'string' && chunk.reasoningContent.length > 0) {
          assistantReasoning += chunk.reasoningContent;
        }
        if (chunk.type === 'text-delta' && chunk.text) {
          assistantText += chunk.text;
        } else if (chunk.type === 'tool-call-delta' && chunk.toolName) {
          pendingToolCalls.push({
            toolCallId: chunk.toolCallId || `tc_${Date.now()}_${pendingToolCalls.length}`,
            toolName: chunk.toolName,
            inputText: chunk.inputText || JSON.stringify(chunk.input ?? {}),
            input: chunk.input ?? {},
          });
        }
      }

      if (pendingToolCalls.length === 0) {
        if (!assistantText.trim()) {
          const count = this.mistakeTracker.recordMistake('empty_response');
          void this.options.hooks?.onEvent?.({
            type: 'agent.mistake',
            kind: 'empty_response',
            consecutiveMistakes: count,
          });
        } else {
          const contentLoop = this.loopDetection.observeAssistantContent(assistantText);
          if (contentLoop) {
            this.mistakeTracker.recordMistake('empty_response', contentLoop.reason);
            void this.options.hooks?.onEvent?.({
              type: 'agent.loop',
              kind: contentLoop.kind,
              reason: contentLoop.reason,
              count: contentLoop.count,
              consecutiveMistakes: this.mistakeTracker.getConsecutiveMistakes(),
            });
          }
        }
        if (this.options.hooks?.onBeforeFinish && state.iterations < state.maxIterations) {
          const decision = await this.options.hooks.onBeforeFinish({
            assistantText,
            iterations: state.iterations,
            messages,
            consecutiveMistakes: this.mistakeTracker.getConsecutiveMistakes(),
          });
          if (decision?.shouldContinue && decision.prompt) {
            messages.push({
              id: `msg_a_${Date.now()}_${state.iterations}`,
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: assistantText.trim() || '已完成当前阶段分析，继续执行修复与验证。',
                },
              ],
              createdAt: Date.now(),
            });
            messages.push({
              id: `msg_u_cont_${Date.now()}_${state.iterations}`,
              role: 'user',
              content: [{ type: 'text', text: decision.prompt }],
              createdAt: Date.now(),
            });
            continue;
          }
        }

        return {
          status: 'completed',
          assistantText,
        };
      }

      // Deduplicate identical read-only tool calls within the same turn
      const deduplicatedToolCalls: typeof pendingToolCalls = [];
      const seenInTurn = new Set<string>();
      for (const tc of pendingToolCalls) {
        const isRead =
          READ_ONLY_PARALLEL_TOOLS.has(tc.toolName) ||
          ((tc.toolName === 'run_command' || tc.toolName === 'run-build') &&
            isPureReadOnlyShellCommand(String(tc.input?.command || '')));
        if (isRead) {
          const key = canonicalizeToolCallKey(tc.toolName, tc.input);
          if (seenInTurn.has(key)) {
            continue;
          }
          seenInTurn.add(key);
        }
        deduplicatedToolCalls.push(tc);
      }

      // A3: If the model updated todos via manage_todo, update dynamic iteration budget
      for (const tc of deduplicatedToolCalls) {
        if (tc.toolName === 'manage_todo' && Array.isArray(tc.input?.todos)) {
          const newTodos = (tc.input.todos as any[])
            .map((t) => (typeof t === 'string' ? t : String(t?.title || t?.text || '')))
            .filter(Boolean);
          if (newTodos.length > 0) {
            state.todos = newTodos;
            state.maxIterations = computeDynamicMaxIterations(
              newTodos.length,
              this.options.maxIterations
            );
          }
        }
      }

      // Record assistant message with tool calls
      const assistantParts: AgentMessagePart[] = [];
      if (assistantText.trim().length > 0) {
        assistantParts.push({ type: 'text', text: assistantText });
      }
      for (const tc of deduplicatedToolCalls) {
        assistantParts.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }
      messages.push({
        id: `msg_a_${Date.now()}_${state.iterations}`,
        role: 'assistant',
        content: assistantParts,
        ...(assistantReasoning.length > 0 ? { reasoningContent: assistantReasoning } : {}),
        createdAt: Date.now(),
      });

      // A2: Parallel read-only preflight for edit_file batches
      const editCalls = deduplicatedToolCalls.filter(isPreflightableEditTool);
      const preflightMap =
        editCalls.length > 1
          ? await this.preflightEditBatch(editCalls)
          : new Map<string, { ok: boolean; error?: string }>();

      const isParallelizableReadTool = (tc: { toolName: string; input: Record<string, unknown> }) =>
        READ_ONLY_PARALLEL_TOOLS.has(tc.toolName) ||
        ((tc.toolName === 'run_command' || tc.toolName === 'run-build') &&
          isPureReadOnlyShellCommand(String(tc.input?.command || '')));

      const toolResultParts: AgentMessagePartToolResult[] = [];
      let idx = 0;
      while (idx < deduplicatedToolCalls.length) {
        if (this.abortController.signal.aborted) {
          break;
        }
        const current = deduplicatedToolCalls[idx];
        if (isParallelizableReadTool(current)) {
          const parallelBatch: typeof deduplicatedToolCalls = [];
          while (
            idx < deduplicatedToolCalls.length &&
            isParallelizableReadTool(deduplicatedToolCalls[idx])
          ) {
            parallelBatch.push(deduplicatedToolCalls[idx]);
            idx += 1;
          }
          const batchResults = await Promise.all(
            parallelBatch.map((tc) =>
              this.executeSingleToolCall(tc, toolMap, this.sessionReadCache)
            )
          );
          toolResultParts.push(...batchResults);
        } else {
          const preflight = preflightMap.get(current.toolCallId);
          if (preflight && !preflight.ok) {
            this.mistakeTracker.recordMistake('tool_error', preflight.error || 'preflight failed');
            toolResultParts.push({
              type: 'tool-result',
              toolCallId: current.toolCallId,
              toolName: current.toolName,
              output: { error: preflight.error },
              isError: true,
            });
            idx += 1;
            continue;
          }

          const singleResult = await this.executeSingleToolCall(
            current,
            toolMap,
            this.sessionReadCache
          );
          if (MUTATING_TOOLS.has(current.toolName) && !singleResult.isError) {
            state.hasMutatedFiles = true;
            state.verifiedSinceLastMutation = false;
            if (state.todos.length > 0 && state.currentTodoIndex < state.todos.length - 1) {
              state.currentTodoIndex += 1;
            }
          } else if (
            (current.toolName === 'run_command' ||
              current.toolName === 'run-build' ||
              current.toolName === 'auto_build_and_test') &&
            !isPureReadOnlyShellCommand(String(current.input?.command || '')) &&
            !singleResult.isError
          ) {
            state.verifiedSinceLastMutation = true;
          }
          toolResultParts.push(singleResult);
          idx += 1;
        }
      }

      messages.push({
        id: `msg_t_${Date.now()}_${state.iterations}`,
        role: 'tool',
        content: toolResultParts,
        createdAt: Date.now(),
      });
    }

    return {
      status: 'failed',
      assistantText: '',
      error: new Error(`maxIterations (${state.maxIterations}) reached`),
    };
  }

  /**
   * A1 Phase 3 & D2: `runVerify` — Hard-bound verification gate.
   * Executes the configured build/test command and returns `{ ok, exitCode, output, command }`.
   */
  public async runVerify(
    toolMap: Map<string, AgentTool<any, any>>
  ): Promise<{ ok: boolean; exitCode: number; output: string; command: string }> {
    const cfg = this.options.verifyConfig;
    const command =
      cfg?.combinedCommand?.trim() ||
      (cfg?.buildCommand && cfg?.testCommand
        ? `${cfg.buildCommand.trim()} && ${cfg.testCommand.trim()}`
        : cfg?.buildCommand?.trim() || cfg?.testCommand?.trim() || 'npm test');

    void this.options.hooks?.onEvent?.({
      type: 'agent.phase',
      phase: 'verify',
      command,
    });

    if (this.options.verifyRunner) {
      const res = await this.options.verifyRunner(command);
      const output = [res.stdout, res.stderr, res.error].filter(Boolean).join('\n').trim();
      return {
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        output: output || (res.exitCode === 0 ? 'Verification passed' : 'Verification failed'),
        command,
      };
    }

    const verifyTool =
      toolMap.get('run_command') ??
      toolMap.get('run-build') ??
      toolMap.get('auto_build_and_test');
    if (!verifyTool) {
      return {
        ok: true,
        exitCode: 0,
        output: 'No verification tool registered; skipping verify gate.',
        command,
      };
    }

    try {
      const rawOut = await verifyTool.execute(
        { command },
        { signal: this.abortController.signal }
      );
      const o = (rawOut && typeof rawOut === 'object' ? rawOut : {}) as Record<string, any>;
      const exitCode =
        typeof o.exitCode === 'number'
          ? o.exitCode
          : o.error
            ? 1
            : 0;
      const output = [o.stdout, o.stderr, o.error, typeof rawOut === 'string' ? rawOut : '']
        .filter(Boolean)
        .join('\n')
        .trim();
      return {
        ok: exitCode === 0,
        exitCode,
        output: output || (exitCode === 0 ? 'Verification passed' : 'Verification failed'),
        command,
      };
    } catch (err) {
      return {
        ok: false,
        exitCode: 1,
        output: err instanceof Error ? err.message : String(err),
        command,
      };
    }
  }

  /**
   * A1: Plan -> Execute -> Verify 3-State Machine Entrypoint
   */
  public async run(userPrompt: string): Promise<AgentRunResult> {
    const toolMap = new Map<string, AgentTool<any, any>>();
    for (const t of this.options.tools) {
      toolMap.set(t.name, t);
    }

    // B1: Build byte-stable prefix (systemPrompt + static rules + sorted tools)
    const stablePrefix = buildStablePrefix({
      systemPrompt: this.options.systemPrompt,
      tools: this.options.tools,
      projectRules: this.options.projectRules,
    });

    const userText = stablePrefix.dynamicTailPrompt
      ? `${userPrompt}\n\n${stablePrefix.dynamicTailPrompt}`
      : userPrompt;

    const messages: AgentMessage[] = [
      ...(this.options.initialMessages ?? []),
      {
        id: `msg_u_${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: userText }],
        createdAt: Date.now(),
      },
    ];

    const state = {
      maxIterations: this.options.maxIterations ?? 75,
      iterations: 0,
      hasMutatedFiles: false,
      verifiedSinceLastMutation: false,
      isRetryAfterVerifyFailure: false,
      todos: [] as string[],
      currentTodoIndex: 0,
    };
    let verifyRuns = 0;

    try {
      // Phase 1: PLAN (when enabled or planModel is provided)
      if (this.options.enablePlanPhase || this.options.planModel) {
        const todos = await this.runPlan(userPrompt, messages, toolMap, stablePrefix);
        state.todos = todos;
        state.maxIterations = computeDynamicMaxIterations(
          todos.length,
          this.options.maxIterations
        );
      }

      const shouldEnforceVerify =
        this.options.enforceVerifyGate ??
        Boolean(this.options.verifyConfig || this.options.verifyRunner);
      const maxVerifyRetries = this.options.maxVerifyRetries ?? 2;

      // Phase 2 & 3 Loop: EXEC <-> VERIFY
      while (true) {
        const execResult = await this.runExec(messages, toolMap, stablePrefix, state);
        if (execResult.status !== 'completed') {
          return {
            status: execResult.status,
            messages,
            iterations: state.iterations,
            todos: state.todos.length > 0 ? state.todos : undefined,
            prefixHash: stablePrefix.prefixHash,
            verifyRuns,
            error: execResult.error,
          };
        }

        // Phase 3: Hard-bound VERIFY gate if files were mutated and not yet verified
        if (
          shouldEnforceVerify &&
          state.hasMutatedFiles &&
          !state.verifiedSinceLastMutation &&
          verifyRuns <= maxVerifyRetries
        ) {
          verifyRuns += 1;
          const verifyRes = await this.runVerify(toolMap);
          if (!verifyRes.ok && verifyRuns <= maxVerifyRetries && state.iterations < state.maxIterations) {
            this.mistakeTracker.recordMistake('verify_fail', verifyRes.output.slice(0, 200));
            state.isRetryAfterVerifyFailure = true;
            messages.push({
              id: `msg_a_preverify_${Date.now()}_${state.iterations}`,
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: execResult.assistantText.trim() || 'Applied changes; running verification gate.',
                },
              ],
              createdAt: Date.now(),
            });
            messages.push({
              id: `msg_u_verify_fail_${Date.now()}_${verifyRuns}`,
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `[VERIFY_GATE_FAILED exitCode=${verifyRes.exitCode} command="${verifyRes.command}"]\n${verifyRes.output}\n\nFix the compilation/test errors above and re-verify.`,
                },
              ],
              createdAt: Date.now(),
            });
            continue;
          }
          state.verifiedSinceLastMutation = verifyRes.ok;
        }

        if (execResult.assistantText && this.options.hooks?.onEvent) {
          await this.options.hooks.onEvent({
            type: 'assistant-text-delta',
            text: execResult.assistantText,
          });
        }

        messages.push({
          id: `msg_a_${Date.now()}_${state.iterations}`,
          role: 'assistant',
          content: [{ type: 'text', text: execResult.assistantText }],
          createdAt: Date.now(),
        });

        return {
          status: 'completed',
          messages,
          iterations: state.iterations,
          todos: state.todos.length > 0 ? state.todos : undefined,
          prefixHash: stablePrefix.prefixHash,
          verifyRuns,
        };
      }
    } catch (err) {
      return {
        status: 'failed',
        messages,
        iterations: state.iterations,
        todos: state.todos.length > 0 ? state.todos : undefined,
        prefixHash: stablePrefix.prefixHash,
        verifyRuns,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

export { Agent as AgentRuntime };

/**
 * In-tree ClineCore compatibility class for Appendix A runtime surface verification
 */
export class ClineCore {
  static async create(): Promise<ClineCore> {
    return new ClineCore();
  }
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  async list(): Promise<unknown[]> {
    return [];
  }
  async get(): Promise<unknown> {
    return null;
  }
  async readMessages(): Promise<unknown[]> {
    return [];
  }
  async abort(): Promise<boolean> {
    return true;
  }
  async stop(): Promise<boolean> {
    return true;
  }
  async delete(): Promise<boolean> {
    return true;
  }
  async dispose(): Promise<void> {}
}
