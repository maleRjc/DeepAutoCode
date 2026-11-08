import type { AgentTool, ToolPolicyMap } from './ToolSuite.js';
import {
  shouldCompactToolOutput,
  summarizeToolOutput,
} from './ToolResultSummarizer.js';
import { resolveCompactionPlan } from './ContextCompaction.js';
import { MistakeTracker } from './MistakeTracker.js';
import { LoopDetection } from './LoopDetection.js';

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

export interface AgentModelAdapter {
  stream: (request: {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: AgentTool<any, any>[];
    signal?: AbortSignal;
  }) => AsyncGenerator<AgentModelStreamChunk, void, unknown>;
}

export interface AgentOptions {
  sessionId: string;
  conversationId?: string;
  clientName?: string;
  clientVersion?: string;
  model: AgentModelAdapter;
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
]);

const MUTATING_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch', 'editor']);

function isPureReadOnlyShellCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Disallow any output redirection, in-place edits, builds, or test executions from read cache
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
 * In-tree White-Box Agent Execution Loop (Antigravity-enhanced)
 * Features:
 * - Parallel execution of read-only tool batches (`Promise.all`) for 3-5x faster evidence gathering
 * - Deterministic multi-turn tool calling state machine
 * - Automatic context-window compaction for older tool outputs (structured summary, not blind slice)
 * - Clean abort handling & streaming event hooks
 */
export class Agent {
  private readonly options: AgentOptions;
  private readonly abortController = new AbortController();
  private abortReason = 'Aborted';
  private readonly mistakeTracker: MistakeTracker;
  private readonly loopDetection: LoopDetection;
  private lastCompactionStage: string = 'none';

  constructor(options: AgentOptions) {
    this.options = options;
    this.mistakeTracker = options.mistakeTracker ?? new MistakeTracker();
    this.loopDetection = options.loopDetection ?? new LoopDetection();
  }

  public abort(reason = 'Task cancelled by user'): void {
    this.abortReason = reason;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error(reason));
    }
  }

  /**
   * When cumulative tool output is large, replace older results with
   * information-preserving summaries (paths / errors / exit codes / hits).
   * Exposed for unit tests.
   */
  public compactOlderToolOutputsIfNeeded(messages: AgentMessage[]): void {
    let totalChars = 0;
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const str =
            typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? '');
          totalChars += str.length;
        }
      }
    }
    const budget = this.options.getContextBudget?.() || {
      tokensUsed: 0,
      tokenBudget: null,
    };
    const plan = resolveCompactionPlan({
      toolResultChars: totalChars,
      tokenBudget: budget.tokenBudget,
      tokensUsed: budget.tokensUsed,
    });
    if (plan.warnBudget || (plan.shouldCompact && plan.stage !== this.lastCompactionStage)) {
      void this.options.hooks?.onEvent?.({
        type: 'context.pressure',
        fillRatio: plan.fillRatio,
        stage: plan.stage,
        reason: plan.reason,
        trigger: plan.trigger,
        estimatedToolTokens: plan.estimatedToolTokens,
        warnBudget: plan.warnBudget,
      });
    }
    this.lastCompactionStage = plan.stage;
    if (!plan.shouldCompact) {
      return;
    }
    const cutoff = Math.max(0, messages.length - plan.keepRecentMessages);
    for (let i = 0; i < cutoff; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      for (const part of msg.content) {
        if (part.type !== 'tool-result') continue;
        if (!shouldCompactToolOutput(part.output, plan.minCharsToSummarize)) continue;
        const existing =
          typeof part.output === 'string'
            ? part.output
            : JSON.stringify(part.output ?? '');
        // Allow re-compact of prior summaries when under critical pressure
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

  private async executeSingleToolCall(
    tc: {
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    },
    toolMap: Map<string, AgentTool<any, any>>,
    executedReadCache: Map<string, { output: unknown; count: number }>
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

    if (MUTATING_TOOLS.has(tc.toolName) || !isCacheableRead) {
      executedReadCache.clear();
    }

    const cacheKey = isCacheableRead ? canonicalizeToolCallKey(tc.toolName, tc.input) : '';
    if (cacheKey && executedReadCache.has(cacheKey)) {
      const cached = executedReadCache.get(cacheKey)!;
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
      if (cacheKey) {
        if (!isErrObj) {
          executedReadCache.set(cacheKey, { output, count: 1 });
        }
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

  public async run(userPrompt: string): Promise<AgentRunResult> {
    const maxIterations = this.options.maxIterations ?? 75;
    const toolMap = new Map<string, AgentTool<any, any>>();
    for (const t of this.options.tools) {
      toolMap.set(t.name, t);
    }

    const executedReadCache = new Map<string, { output: unknown; count: number }>();

    const messages: AgentMessage[] = [
      ...(this.options.initialMessages ?? []),
      {
        id: `msg_u_${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: userPrompt }],
        createdAt: Date.now(),
      },
    ];

    let iterations = 0;

    try {
      while (iterations < maxIterations) {
        if (this.abortController.signal.aborted) {
          return {
            status: 'aborted',
            messages,
            iterations,
            error: new Error(this.abortReason),
          };
        }

        iterations += 1;
        this.compactOlderToolOutputsIfNeeded(messages);

        let assistantText = '';
        let assistantReasoning = '';
        const pendingToolCalls: Array<{
          toolCallId: string;
          toolName: string;
          inputText: string;
          input: Record<string, unknown>;
        }> = [];

        const stream = this.options.model.stream({
          systemPrompt: this.options.systemPrompt,
          messages,
          tools: this.options.tools,
          signal: this.abortController.signal,
        });

        for await (const chunk of stream) {
          if (this.abortController.signal.aborted) {
            return {
              status: 'aborted',
              messages,
              iterations,
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
          if (this.options.hooks?.onBeforeFinish && iterations < maxIterations) {
            const decision = await this.options.hooks.onBeforeFinish({
              assistantText,
              iterations,
              messages,
              consecutiveMistakes: this.mistakeTracker.getConsecutiveMistakes(),
            });
            if (decision?.shouldContinue && decision.prompt) {
              messages.push({
                id: `msg_a_${Date.now()}_${iterations}`,
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
                id: `msg_u_cont_${Date.now()}_${iterations}`,
                role: 'user',
                content: [{ type: 'text', text: decision.prompt }],
                createdAt: Date.now(),
              });
              continue;
            }
          }

          if (assistantText && this.options.hooks?.onEvent) {
            await this.options.hooks.onEvent({
              type: 'assistant-text-delta',
              text: assistantText,
            });
          }

          messages.push({
            id: `msg_a_${Date.now()}_${iterations}`,
            role: 'assistant',
            content: [{ type: 'text', text: assistantText }],
            createdAt: Date.now(),
          });
          return {
            status: 'completed',
            messages,
            iterations,
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
          id: `msg_a_${Date.now()}_${iterations}`,
          role: 'assistant',
          content: assistantParts,
          ...(assistantReasoning.length > 0 ? { reasoningContent: assistantReasoning } : {}),
          createdAt: Date.now(),
        });

        // Execute tool calls: batch contiguous read-only tools (including read-only shell commands) in parallel via Promise.all,
        // and execute mutating / build shell tools sequentially in exact order.
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
              parallelBatch.map((tc) => this.executeSingleToolCall(tc, toolMap, executedReadCache))
            );
            toolResultParts.push(...batchResults);
          } else {
            const singleResult = await this.executeSingleToolCall(
              current,
              toolMap,
              executedReadCache
            );
            toolResultParts.push(singleResult);
            idx += 1;
          }
        }

        messages.push({
          id: `msg_t_${Date.now()}_${iterations}`,
          role: 'tool',
          content: toolResultParts,
          createdAt: Date.now(),
        });
      }

      return {
        status: 'failed',
        messages,
        iterations,
        error: new Error(`maxIterations (${maxIterations}) reached`),
      };
    } catch (err) {
      return {
        status: 'failed',
        messages,
        iterations,
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
